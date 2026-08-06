"""
Roof geometry route — POST /api/roof/geometry (Stage 3, B1 + B2).

Geocode an address, call Google Solar buildingInsights:findClosest, return a normalised
per-plane roof model with panel counts rescaled to our chosen catalogue panel + cumulative
candidate configs. Geometry/layout only — no Google energy or financial figures.

Best-effort persistence to roof_geometry (linked to job_id when supplied): a Storage/DB
failure still returns the model in-response with persisted=false — never blocks the workflow.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter
from pydantic import BaseModel

import roof_geometry

router = APIRouter()


class RoofGeometryRequest(BaseModel):
    address: str
    job_id: Optional[str] = None
    panel_id: Optional[str] = None
    usability_factor: Optional[float] = None


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


def _persist(model: dict, job_id: Optional[str]) -> tuple[bool, Optional[str]]:
    """
    Write one roof_geometry row (linked to job_id when present). Best-effort; NEVER raises.
    Returns (persisted, error).
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
    }
    try:
        client.table("roof_geometry").insert(row).execute()
        return True, None
    except Exception as exc:  # noqa: BLE001 — persistence must never block the response
        sentry_sdk.capture_exception(exc)
        return False, f"roof_geometry insert failed: {exc}"


@router.post("/api/roof/geometry")
async def roof_geometry_endpoint(body: RoofGeometryRequest):
    try:
        model = roof_geometry.fetch_roof_geometry(
            body.address,
            panel_id=body.panel_id,
            usability_factor=body.usability_factor,
        )
        persisted, persist_err = _persist(model, body.job_id)
        model["persisted"] = persisted
        if not persisted and persist_err:
            model.setdefault("flags", []).append("not_persisted")
        return model
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
