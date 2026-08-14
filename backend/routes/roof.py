"""
Roof geometry routes — POST /api/roof/geometry and POST /api/roof/manual (3.4-A).

Geocode an address, call Google Solar buildingInsights:findClosest, return a normalised
per-plane roof model with panel counts rescaled to our chosen catalogue panel + cumulative
candidate configs — OR accept the same model entered by hand (OI-10: manual/plans entry is
a first-class input path, the norm for the 1-in-5 regional coverage gap, not a fallback).
Geometry/layout only — no Google energy or financial figures.

SECURITY (3.4-A): both endpoints sit behind require_company — this route fronts two
billable Google APIs and writes with the service-role key, so an unauthenticated caller
could drain quota and attach roof rows to any company's job (the F72 class; address.py
states the same rule). When job_id is supplied it must belong to the caller's company:
absent and foreign jobs get the IDENTICAL 404, so existence never leaks (the
_get_company_job contract in routes/job.py, mirrored locally because that file is frozen).

ROWS ARE APPEND-ONLY. There is no upsert, no unique constraint, no delete. A later row
supersedes an earlier one and readers take the newest by created_at — that is what lets a
manual entry override an auto lookup while the provenance of BOTH survives for the ML
flywheel. 3.4-B inherits this rule; do not invent another.

THIS ROUTE NEVER WRITES TO `jobs`. The geocoded postcode/state ride on the roof_geometry
row and the response (with a site_cross_check when they disagree with the job); writing
them back onto the job is checklist 3.3c, the only job-update endpoint, deliberately.

Best-effort persistence: a Storage/DB failure still returns the model in-response with
persisted=false — never blocks the workflow. persist=false skips the write entirely
(exists so verification can exercise the real code paths without writing — F77).
"""

from __future__ import annotations

import os
from typing import Any, Literal, Optional

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import roof_geometry
from auth import Caller, require_company

router = APIRouter()

# Identical for absent and foreign jobs — existence never leaks.
_404_JOB = HTTPException(status_code=404, detail="Job not found")
# Ownership UNKNOWABLE (DB unreachable) is not "not yours" — same logic as auth.py's
# membership 503 (F94): fail closed and honestly, and never cache or guess.
_503_JOBS = HTTPException(status_code=503, detail="Job lookup temporarily unavailable")


class RoofGeometryRequest(BaseModel):
    address: str = Field(min_length=1)
    job_id: Optional[str] = None
    panel_id: Optional[str] = None
    usability_factor: Optional[float] = None
    persist: bool = True


class ManualPlane(BaseModel):
    # 422 with the field named on out-of-range values — never a silent clamp.
    azimuth: float = Field(ge=0, le=359.9)
    pitch: float = Field(ge=0, le=60)
    # Deliberately unconstrained: a null/negative area degrades to panel_count 0 with a
    # per-plane flag in the builder (section 6), it is not a validation error.
    area_m2: Optional[float] = None
    label: Optional[str] = Field(default=None, max_length=80)


class ManualRoofRequest(BaseModel):
    job_id: str = Field(min_length=1)
    basis: Literal["plans", "site_measure", "estimate"]
    planes: list[ManualPlane] = Field(min_length=1, max_length=12)
    panel_id: Optional[str] = None
    usability_factor: Optional[float] = None
    note: Optional[str] = Field(default=None, max_length=500)
    persist: bool = True


def _client() -> Any:
    """Supabase client preferring the service-role key (bypasses RLS). None if unconfigured."""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception:
        return None


def _require_company_job(client: Any, job_id: str, company_id: Optional[str]) -> dict:
    """
    The job row, 404 (identical for absent and foreign) or 503 (lookup impossible /
    failed — unknowable is not "not yours"). Local mirror of routes/job.py's
    _get_company_job contract; not imported because that file is frozen at 3.4-A.
    """
    if client is None:
        raise _503_JOBS
    try:
        res = (
            client.table("jobs")
            .select("job_id, company_id, site_postcode, site_state")
            .eq("job_id", job_id)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
    except Exception as exc:  # noqa: BLE001 — unknowable, so 503, never 404/200
        sentry_sdk.capture_exception(exc)
        raise _503_JOBS from None
    if not rows or rows[0].get("company_id") != company_id:
        raise _404_JOB
    return rows[0]


def _latest_roof_row(client: Any, job_id: str) -> Optional[dict]:
    """Newest roof_geometry row for a job (created_at desc), or None. Never raises."""
    if client is None:
        return None
    try:
        res = (
            client.table("roof_geometry")
            .select("lat, lng, geocoded_postcode, geocoded_state, geocoded_formatted_address")
            .eq("job_id", job_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        return rows[0] if rows else None
    except Exception:  # noqa: BLE001 — inherited coordinates are a bonus, never a blocker
        return None


def _apply_site_cross_check(model: dict, job: Optional[dict]) -> None:
    """
    F22 surface: compare the job's stored state with the geocoded one. The key is
    emitted ONLY when both sides are known — an unchecked thing must not look like a
    passed thing, so there is no mismatch:false for a check that never ran. On
    disagreement the flag is appended; the JOB IS NEVER UPDATED here (3.3c owns that).
    """
    if not job:
        return
    job_state = job.get("site_state")
    geo_state = model.get("geocoded_state")
    if not isinstance(job_state, str) or not job_state:
        return
    if not isinstance(geo_state, str) or not geo_state:
        return
    mismatch = job_state.strip().upper() != geo_state.strip().upper()
    model["site_cross_check"] = {
        "job_postcode": job.get("site_postcode"),
        "job_state": job_state,
        "geocoded_postcode": model.get("geocoded_postcode"),
        "geocoded_state": geo_state,
        "mismatch": mismatch,
    }
    if mismatch:
        model.setdefault("flags", []).append("geocode_state_mismatch")


def _persist(model: dict, job_id: Optional[str]) -> tuple[bool, Optional[str]]:
    """
    APPEND one roof_geometry row (linked to job_id when present). Best-effort; NEVER
    raises. Returns (persisted, error). Append-only by design — see module docstring.
    """
    client = _client()
    if client is None:
        return False, "Supabase not configured"
    row = {
        "job_id": job_id,
        "address": model.get("address"),
        "lat": model.get("lat"),
        "lng": model.get("lng"),
        "found": model.get("found", False),
        "source": model.get("source"),
        "imagery_quality": model.get("imagery_quality"),
        "imagery_date": model.get("imagery_date"),
        "imagery_stale": model.get("imagery_stale"),
        "manual_entry_required": model.get("manual_entry_required", False),
        "low_confidence": model.get("low_confidence", False),
        "needs_manual_confirmation": model.get("needs_manual_confirmation", False),
        "reason": model.get("reason"),
        "flags": model.get("flags", []),
        "selected_panel": model.get("selected_panel"),
        "usability_factor": model.get("usability_factor"),
        "planes": model.get("planes", []),
        "candidate_configs": model.get("candidate_configs", []),
        "total_kwp": model.get("total_kwp"),
        "max_panels": model.get("max_panels"),
        "google_max_array_panels_count": model.get("google_max_array_panels_count"),
        "panels_raw": model.get("panels_raw", []),
        "segment_bounding_boxes": model.get("segment_bounding_boxes", []),
        "building_center": model.get("building_center"),
        "building_bounding_box": model.get("building_bounding_box"),
        # F22 — the authoritative geocode, captured at write time because a later
        # backfill would cost a paid Google call (Solar API terms §20.2).
        "geocoded_postcode": model.get("geocoded_postcode"),
        "geocoded_state": model.get("geocoded_state"),
        "geocoded_formatted_address": model.get("geocoded_formatted_address"),
    }
    try:
        client.table("roof_geometry").insert(row).execute()
        return True, None
    except Exception as exc:  # noqa: BLE001 — persistence must never block the response
        sentry_sdk.capture_exception(exc)
        return False, f"roof_geometry insert failed: {exc}"


def _finish(model: dict, job_id: Optional[str], persist: bool) -> dict:
    """Shared tail: honour the persist flag, annotate the outcome, return the model."""
    if not persist:
        model["persisted"] = False
        model.setdefault("flags", []).append("not_persisted_by_request")
        return model
    persisted, persist_err = _persist(model, job_id)
    model["persisted"] = persisted
    if not persisted and persist_err:
        model.setdefault("flags", []).append("not_persisted")
    return model


@router.post("/api/roof/geometry")
async def roof_geometry_endpoint(
    body: RoofGeometryRequest, caller: Caller = Depends(require_company)
):
    try:
        job: Optional[dict] = None
        if body.job_id:
            job = _require_company_job(_client(), body.job_id, caller.company_id)
        model = roof_geometry.fetch_roof_geometry(
            body.address,
            panel_id=body.panel_id,
            usability_factor=body.usability_factor,
        )
        _apply_site_cross_check(model, job)
        return _finish(model, body.job_id, body.persist)
    except HTTPException:
        raise  # 404/503 pass through untouched — never swallowed into a 200
    except Exception as exc:  # noqa: BLE001 — never surface a traceback
        sentry_sdk.capture_exception(exc)
        return {
            "found": False,
            "manual_entry_required": True,
            "reason": "Something went wrong fetching roof data — enter roof planes manually.",
            "error": "internal error",
            "persisted": False,
            "flags": ["internal_error"],
        }


@router.post("/api/roof/manual")
async def roof_manual_endpoint(
    body: ManualRoofRequest, caller: Caller = Depends(require_company)
):
    """
    Manual/plans roof entry (OI-10). Makes NO Google call — never geocodes, never calls
    buildingInsights — so it works fully with no API key: a key outage must not stop an
    installer sizing a job. Coordinates and the geocoded values are inherited from the
    job's newest existing roof_geometry row when one exists (a manual entry after a
    regional 404 keeps the location that lookup already paid for).
    """
    try:
        client = _client()
        job = _require_company_job(client, body.job_id, caller.company_id)

        panel, panel_flags = roof_geometry._get_panel(body.panel_id)
        usability = roof_geometry._usability_factor(body.usability_factor)

        previous = _latest_roof_row(client, body.job_id)
        lat = previous.get("lat") if previous else None
        lng = previous.get("lng") if previous else None
        geocoded = (
            {
                "geocoded_postcode": previous.get("geocoded_postcode"),
                "geocoded_state": previous.get("geocoded_state"),
                "geocoded_formatted_address": previous.get("geocoded_formatted_address"),
            }
            if previous
            else None
        )

        model = roof_geometry.build_manual_roof_model(
            basis=body.basis,
            planes=[p.model_dump() for p in body.planes],
            panel=panel,
            usability=usability,
            note=body.note,
            lat=lat,
            lng=lng,
            geocoded=geocoded,
        )
        if panel_flags:
            model.setdefault("flags", []).extend(panel_flags)
        _apply_site_cross_check(model, job)
        return _finish(model, body.job_id, body.persist)
    except HTTPException:
        raise  # 404/503 pass through untouched — never swallowed into a 200
    except Exception as exc:  # noqa: BLE001 — never surface a traceback
        sentry_sdk.capture_exception(exc)
        return {
            "found": False,
            "manual_entry_required": True,
            "reason": "Something went wrong saving the manual roof — try again.",
            "error": "internal error",
            "persisted": False,
            "flags": ["internal_error"],
        }
