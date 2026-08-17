"""
backend/routes/demand.py — the Demand phase's authenticated, job-scoped write
path (checklist 3.6 prompt 1 — backend only; prompt 2 builds the screen).

Why this exists: /api/bill/parse takes no job_id and writes nothing;
/api/load/characterise is pure compute; the only writer of bills / surveys /
load_profiles was the unauthenticated legacy bulk save (retired at 3.16). So a
parsed bill could not be attached to a job, a survey vanished, and the
worksheet's "energy-data" completeness predicate — which reads the DATABASE —
could never tick on those paths.

Two endpoints live here, both `POST /api/job/{job_id}/…` so the job scope is in
the path and ownership is checked before anything is parsed or stored:

  /bill    — parse an uploaded bill (bill_parser), store the raw file in the
             private bucket, write ONE bills row (bills are deliberately MANY
             per job — no UNIQUE on bills.job_id). Does NOT touch the tier: a
             bill on its own is not a tier; the tier is recorded when the load
             profile is built at /demand.
  /demand  — characterise the load by calling routes/load.py's
             characterise_load AS A FUNCTION (one implementation of the tier
             arithmetic — the tier numbers appear nowhere in this file),
             write/replace the surveys row (UNIQUE(job_id)) and the
             load_profiles row (UNIQUE(job_id)), then mirror the tier onto the
             job via job_tier.sync_job_tier. Calling it with no interval
             profile and no survey answers after a Tier-3 upload leaves the job
             at Tier 1 — the number goes DOWN (UT-5's fall-back-a-tier path).

`require_company_job` is the ONE ownership implementation for the Demand
phase: routes/interval.py imports it from here (roof.py's private equivalent
stays private and unmodified). Absent job and foreign job return the IDENTICAL
404 — existence never leaks; a lookup that RAISES returns 503, because
unknowable is not the same fact as not-yours (F88).

Every failure downstream of a successful parse degrades to a 200 with a
*_saved flag false and a human warning — never a 500. The worst outcome here
would be a silent false success, because the section's completeness predicate
reads the database, not the response.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

import bill_parser
import capture
import job_tier
from auth import Caller, require_company
from routes import load as load_route

router = APIRouter()

_BILLS_BUCKET = "bills"
_BILL_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

_404_JOB = HTTPException(status_code=404, detail="Job not found")
# Ownership UNKNOWABLE (DB unreachable) is not "not yours" — same rule as
# auth.py's membership 503 (F88): fail closed and honestly, never guess.
_503_JOBS = HTTPException(status_code=503, detail="Job lookup temporarily unavailable")


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


def require_company_job(client: Any, job_id: str, company_id: Optional[str]) -> dict:
    """
    The job row, 404 (identical for absent and foreign) or 503 (lookup
    impossible / failed). The Demand phase's single implementation — imported
    by routes/interval.py; mirrors routes/roof.py's private helper without
    touching that file.
    """
    if client is None:
        raise _503_JOBS
    try:
        res = (
            client.table("jobs")
            .select("job_id, company_id")
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


@router.post("/api/job/{job_id}/bill")
async def upload_job_bill(
    job_id: str,
    file: UploadFile = File(...),
    caller: Caller = Depends(require_company),
):
    """Parse a bill and attach it to the caller's job. Ownership first, always."""
    client = _client()
    require_company_job(client, job_id, caller.company_id)

    suffix = Path(file.filename or "upload").suffix.lower() or ".pdf"
    data = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        parsed = bill_parser.parse_bill(tmp_path)
        if not isinstance(parsed, dict):
            raise ValueError("bill parser returned no data")
    except Exception as exc:  # noqa: BLE001 — a bad file is a normal outcome, not a 500
        sentry_sdk.capture_exception(exc)
        # Same vocabulary as the interval endpoint's fallback shape, so prompt
        # 2's DQF branch reads one language: ok:false + a suggest_* flag, HTTP 200.
        return {
            "ok": False,
            "error": (
                "Could not read this bill. Check it is a clear photo or PDF of "
                "an electricity bill, or enter the figures manually."
            ),
            "suggest_manual_correction": True,
        }
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    # Raw file to the private bucket — best-effort, same key/content-type
    # convention as routes/bill.py. A storage failure never loses the parse.
    raw_file_path: Optional[str] = None
    warning: Optional[str] = None
    try:
        if client is not None:
            object_name = f"{uuid.uuid4().hex}{suffix}"
            content_type = _BILL_CONTENT_TYPES.get(suffix, "application/octet-stream")
            client.storage.from_(_BILLS_BUCKET).upload(
                object_name, data, {"content-type": content_type}
            )
            raw_file_path = f"{_BILLS_BUCKET}/{object_name}"
        else:
            warning = "Bill parsed, but the original file could not be stored."
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        warning = "Bill parsed, but the original file could not be stored."

    # ONE bills row. The payload is the parser output as-is plus job scope and
    # provenance — capture.py's allowlist is the filter, deliberately not
    # duplicated here. parsed_json carries the complete parser payload.
    bill_id = capture.save_bill(
        {**parsed, "job_id": job_id, "raw_file_path": raw_file_path, "parsed_json": parsed}
    )
    persisted = bill_id is not None
    if not persisted:
        saved_warning = "The parsed bill could not be saved to this job — try again."
        warning = f"{warning} {saved_warning}" if warning else saved_warning

    out: dict = {
        "ok": True,
        "parsed": {**parsed, "raw_file_path": raw_file_path},
        "raw_file_path": raw_file_path,
        "bill_id": bill_id,
        "persisted": persisted,
    }
    if warning:
        out["warning"] = warning
    return out


@router.post("/api/job/{job_id}/demand")
async def characterise_demand(
    job_id: str,
    body: load_route.LoadCharacteriseRequest,
    caller: Caller = Depends(require_company),
):
    """
    Characterise the job's demand and RECORD it — survey row, load_profiles
    row, and the job-tier mirror. THE TIER-FALLBACK PATH (UT-5): the tier
    written is whatever routes/load.py computed from what was actually
    supplied, so it can go DOWN.
    """
    client = _client()
    require_company_job(client, job_id, caller.company_id)

    # ONE implementation of the tier arithmetic: routes/load.py, called as a
    # function. Its HTTPException(422) for "no annual consumption" propagates
    # unchanged. No tier number appears anywhere in this file by design.
    result = await load_route.characterise_load(body)

    warnings: list[str] = []

    # Survey answers present -> write/replace the surveys row (UNIQUE(job_id),
    # capture upserts on job_id). Column names are capture.py's allowlist —
    # never invented here. has_ev/has_pool are only asserted when appliances
    # was actually answered; an unanswered question is absence, not "no".
    survey_answered = any(
        [
            body.household_size is not None,
            body.hot_water is not None,
            body.occupancy is not None,
            body.appliances is not None,
            body.occupancy_grid is not None,
        ]
    )
    survey_saved = False
    if survey_answered:
        survey_payload: dict = {
            "job_id": job_id,
            "household_size": body.household_size,
            "occupancy_pattern": body.occupancy,
            "hot_water_type": body.hot_water,
            "occupancy_grid": body.occupancy_grid,
        }
        if body.appliances is not None:
            survey_payload["has_ev"] = "ev" in body.appliances
            survey_payload["has_pool"] = "pool_pump" in body.appliances
        if load_route._valid_grid(body.occupancy_grid):
            grid = body.occupancy_grid or []
            # The same 40-cell definition as load.py's _blend_from_grid:
            # Mon-Fri 09:00-16:59.
            survey_payload["daytime_home_frac"] = (
                sum(grid[day][hour] for day in range(5) for hour in range(9, 17)) / 40.0
            )
        survey_saved = capture.save_survey(survey_payload) is not None
        if not survey_saved:
            warnings.append(
                "Survey answers could not be saved — they will need re-entering."
            )

    # Always write/replace the load_profiles row from the characterise result —
    # this is the source of truth the job tier mirrors.
    load_profile_saved = (
        capture.save_load_profile(
            {
                "job_id": job_id,
                "archetype_used": result.get("archetype_used"),
                "hourly_profile_weights": result.get("hourly_profile_weights"),
                "daily_avg_kwh": result.get("daily_avg_kwh"),
                "annual_kwh": result.get("annual_kwh"),
                "accuracy_tier": result.get("accuracy_tier"),
                "confidence_pct": result.get("confidence_pct"),
                "tariff_type_used": result.get("tariff_type_used"),
                "appliance_adjustments": result.get("adjustment_log"),
            }
        )
        is not None
    )
    if not load_profile_saved:
        warnings.append(
            "The load profile could not be saved — the job's accuracy tier was not updated."
        )

    accuracy_tier_written, tier_error = job_tier.sync_job_tier(client, job_id)
    if tier_error:
        warnings.append(f"The job's accuracy tier could not be updated: {tier_error}")

    return {
        **result,
        "survey_saved": survey_saved,
        "load_profile_saved": load_profile_saved,
        "accuracy_tier_written": accuracy_tier_written,
        "warnings": warnings,
    }
