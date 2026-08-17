"""
Interval-data upload route — POST /api/interval/upload (multipart).

Parses an uploaded NEM12 / generic-CSV smart-meter file into a Tier-3 hourly load
profile, persists the raw file + full parsed series + an `interval_data` row (the ML
data-flywheel interval intake), lifts the job to Tier 3, and returns the profile +
metadata for display.

Best-effort persistence: if Supabase / Storage is unreachable, the parsed profile is
still returned for in-session display with `persisted: false` + a flag — the workflow is
never blocked. An unparseable file returns `ok: false` with a friendly error so the UI
can offer the Tier-2 survey fallback.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter, Depends, File, Form, UploadFile

import capture
import interval_parser
import job_tier
from auth import Caller, require_company
from routes.demand import require_company_job

router = APIRouter()

_BUCKET = "bills"  # reuse the private bills bucket pattern (authenticated read, no anon)
_CONTENT_TYPES = {".csv": "text/csv", ".dat": "text/plain", ".txt": "text/plain"}


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


def _tier3_load(parsed: dict) -> dict:
    """Shape the parser output into load.py's response contract, tagged Tier 3."""
    return {
        "annual_kwh": parsed["annual_kwh"],
        "daily_avg_kwh": parsed["daily_avg_kwh"],
        "archetype_used": "Smart-meter interval data (Tier 3 — actual usage)",
        "accuracy_tier": 3,
        "confidence_pct": 92,
        "hourly_profile_weights": parsed["hourly_profile_weights"],
        "adjustment_log": [],  # no estimates — measured data
        "tariff_type_used": "From smart-meter data",
        # E1 extras (additive — downstream that ignores them is unaffected):
        "coverage_days": parsed["coverage_days"],
        "pct_actual": parsed["pct_actual"],
        "channels_used": parsed["channels_used"],
        "annualised": parsed["annualised"],
    }


def _interval_row_exists(client: Any, job_id: str, nmi: Optional[str]) -> bool:
    """True if an interval_data row already exists for this (job_id, nmi). Best-effort."""
    try:
        q = client.table("interval_data").select("interval_id").eq("job_id", job_id)
        q = q.eq("nmi", nmi) if nmi else q.is_("nmi", "null")
        return bool(q.limit(1).execute().data)
    except Exception:  # noqa: BLE001 — treat lookup failure as "unknown / not present"
        return False


def _upsert_interval_row(
    client: Any, job_id: str, fields: dict
) -> tuple[bool, Optional[str]]:
    """
    Insert OR UPDATE the one interval_data row for (job_id, nmi) — still exactly
    one row per pair, never a duplicate. Returns (written, error). NEVER raises.

    3.6 (fault (f) fixed): this used to return early when a row existed, so a
    corrected re-upload for the same NMI left parsed_series_ref and the period
    columns pointing at the FIRST file while the screen showed the new one —
    the database and the screen disagreed. Now an existing row is UPDATED with
    the new refs and period.
    """
    try:
        if _interval_row_exists(client, job_id, fields.get("nmi")):
            q = client.table("interval_data").update(fields).eq("job_id", job_id)
            q = q.eq("nmi", fields["nmi"]) if fields.get("nmi") else q.is_("nmi", "null")
            q.execute()
            return True, None
        client.table("interval_data").insert({**fields, "job_id": job_id}).execute()
        return True, None
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        return False, f"interval_data write failed: {exc}"


def _persist(
    parsed: dict, raw_bytes: bytes, suffix: str, job_id: Optional[str]
) -> tuple[bool, Optional[str], dict]:
    """
    Best-effort: upload raw file + series JSON to the private bucket, insert an
    interval_data row, lift the job to Tier 3. Returns (persisted, error, refs).
    NEVER raises.
    """
    refs: dict = {"raw_file_path": None, "parsed_series_ref": None}
    client = _client()
    if client is None:
        return False, "Supabase not configured", refs

    token = uuid.uuid4().hex
    raw_key = f"interval/{token}{suffix or '.csv'}"
    series_key = f"interval/{token}.series.json"
    series_doc = {
        "resolution_minutes": parsed.get("resolution_minutes"),
        "uom": parsed.get("uom"),
        "channels_used": parsed.get("channels_used"),
        "channels_excluded": parsed.get("channels_excluded"),
        "period_start": parsed.get("period_start"),
        "period_end": parsed.get("period_end"),
        "coverage_days": parsed.get("coverage_days"),
        "annual_kwh": parsed.get("annual_kwh"),
        "pct_actual": parsed.get("pct_actual"),
        "average_day_kwh": parsed.get("average_day_kwh"),
        "series_by_date": parsed.get("series_by_date"),  # the full real hourly series
    }
    try:
        ctype = _CONTENT_TYPES.get(suffix.lower(), "text/plain")
        client.storage.from_(_BUCKET).upload(raw_key, raw_bytes, {"content-type": ctype})
        refs["raw_file_path"] = f"{_BUCKET}/{raw_key}"
        client.storage.from_(_BUCKET).upload(
            series_key,
            json.dumps(series_doc).encode("utf-8"),
            {"content-type": "application/json"},
        )
        refs["parsed_series_ref"] = f"{_BUCKET}/{series_key}"
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        # Storage failed — keep whatever uploaded; continue to the row insert.
        return False, f"raw/series storage failed: {exc}", refs

    if not job_id:
        # No job yet — interval upload routinely precedes job creation (it's an input
        # step). The raw file + parsed series are safely in Storage; the interval_data
        # row is back-filled at job-save time via backfill_interval_row() once a job_id
        # is minted. Not an error — just deferred.
        return False, "no job_id yet — interval_data row deferred to job save", refs

    fields = {
        "nmi": parsed.get("nmi"),
        "raw_file_path": refs["raw_file_path"],
        "source": parsed.get("source"),
        "resolution": (
            f"{parsed['resolution_minutes']} min"
            if parsed.get("resolution_minutes")
            else None
        ),
        "period_start": parsed.get("period_start"),
        "period_end": parsed.get("period_end"),
        "parsed_series_ref": refs["parsed_series_ref"],
        # 3.6 follow-up: the parser's own data-quality numbers, persisted so
        # the readout survives a page load. coverage_days counts dates that
        # actually carry data — the period SPAN overstates it on gappy files,
        # which is why it is stored rather than recomputed. interval_minutes is
        # the INTEGER twin of the display-text `resolution`, which stays as-is
        # for the legacy readers. Insert and update share this dict, so a
        # re-upload refreshes all four.
        "coverage_days": parsed.get("coverage_days"),
        "gap_days": parsed.get("gap_days"),
        "pct_actual": parsed.get("pct_actual"),
        "interval_minutes": parsed.get("resolution_minutes"),
    }
    written, err = _upsert_interval_row(client, job_id, fields)
    if err:
        return False, err, refs

    # The tier is NOT written here any more (3.6): jobs.accuracy_tier mirrors
    # load_profiles via job_tier.sync_job_tier, called by the endpoint after
    # the load_profiles row is written.
    return True, None, refs


def backfill_interval_row(
    job_id: Optional[str], interval_ref: Optional[dict]
) -> tuple[bool, Optional[str]]:
    """
    Guarantee an interval_data row exists once a job_id is minted.

    The interval upload commonly happens before any job_id exists, so _persist() leaves
    the raw file + parsed series in Storage but defers the durable row (interval_data.
    job_id is NOT NULL). The job-save flow calls this with the Storage refs + metadata it
    carried in session, back-linking the row to the freshly-minted job_id and mirroring
    the job's tier from load_profiles (3.6 — never written directly here).

    Idempotent on (job_id, nmi): if the row already exists (e.g. job_id was known at
    upload time, or this is a re-save), it is a no-op — never a duplicate. Does NOT
    re-upload to Storage; the refs already point at the uploaded objects. If the raw file
    ref is missing (Storage failed at upload) the row is still written with raw_file_path
    null so the training record is not lost. NEVER raises.

    Returns (written, error): written=True if a new row was created; error is a short
    string when the write failed (caller may surface persisted:false and retry next save).
    """
    if not job_id or not interval_ref:
        return False, None
    client = _client()
    if client is None:
        return False, "Supabase not configured"

    fields = {
        "nmi": interval_ref.get("nmi"),
        "raw_file_path": interval_ref.get("raw_file_path"),
        "source": interval_ref.get("source"),
        "resolution": interval_ref.get("resolution"),
        "period_start": interval_ref.get("period_start"),
        "period_end": interval_ref.get("period_end"),
        "parsed_series_ref": interval_ref.get("parsed_series_ref"),
    }
    written, err = _upsert_interval_row(client, job_id, fields)
    if written:
        # 3.6: the tier is mirrored from load_profiles, never written directly.
        job_tier.sync_job_tier(client, job_id)
    return written, err


@router.post("/api/interval/upload")
async def upload_interval(
    file: UploadFile = File(...),
    job_id: str = Form(...),
    include_controlled_load: bool = Form(False),
    caller: Caller = Depends(require_company),
):
    """
    3.6: authenticated and job-scoped. job_id is REQUIRED; identity comes from
    the validated token, never the payload (`installer_id` removed — auth.py's
    own rule). Ownership is checked BEFORE the file is read: absent and
    foreign jobs return the identical 404, an unanswerable lookup 503 (F88).
    """
    require_company_job(_client(), job_id, caller.company_id)
    try:
        data = await file.read()
        suffix = Path(file.filename or "upload.csv").suffix.lower() or ".csv"

        parsed = interval_parser.parse_interval_file(
            file.filename or "upload.csv", data, include_controlled_load
        )
        if not parsed.get("ok"):
            # Unparseable — friendly error, offer Tier-2 fallback. Not an HTTP error.
            return {
                "ok": False,
                "error": parsed.get("error")
                or "Could not read this file.",
                "suggest_tier2_fallback": True,
            }

        persisted, persist_error, refs = _persist(parsed, data, suffix, job_id)
        flags = list(parsed.get("flags", []))
        if not persisted and persist_error:
            flags.append(f"Profile shown but not fully saved: {persist_error}.")

        # 3.6: record the Tier-3 load profile (the source of truth the job tier
        # mirrors) and sync the mirror. Values are _tier3_load's own — never
        # re-invented. Both are best-effort: failure flags, never blocks.
        tier3 = _tier3_load(parsed)
        load_profile_saved = (
            capture.save_load_profile(
                {
                    "job_id": job_id,
                    "archetype_used": tier3["archetype_used"],
                    "hourly_profile_weights": tier3["hourly_profile_weights"],
                    "daily_avg_kwh": tier3["daily_avg_kwh"],
                    "annual_kwh": tier3["annual_kwh"],
                    "accuracy_tier": tier3["accuracy_tier"],
                    "confidence_pct": tier3["confidence_pct"],
                    "tariff_type_used": tier3["tariff_type_used"],
                }
            )
            is not None
        )
        if not load_profile_saved:
            flags.append(
                "Load profile could not be saved — the job's accuracy tier was not updated."
            )
        accuracy_tier_written, tier_error = job_tier.sync_job_tier(_client(), job_id)
        if tier_error:
            flags.append(f"Accuracy tier not updated: {tier_error}.")

        return {
            "ok": True,
            "load": tier3,
            "metadata": {
                "source": parsed.get("source"),
                "format": parsed.get("format"),
                "nmi": parsed.get("nmi"),
                "resolution_minutes": parsed.get("resolution_minutes"),
                "uom": parsed.get("uom"),
                "period_start": parsed.get("period_start"),
                "period_end": parsed.get("period_end"),
                "coverage_days": parsed.get("coverage_days"),
                "gap_days": parsed.get("gap_days"),
                "annualised": parsed.get("annualised"),
                "annual_kwh": parsed.get("annual_kwh"),
                "daily_avg_kwh": parsed.get("daily_avg_kwh"),
                "pct_actual": parsed.get("pct_actual"),
                "channels_available": parsed.get("channels_available"),
                "channels_used": parsed.get("channels_used"),
                "channels_excluded": parsed.get("channels_excluded"),
                "multiple_nmis": parsed.get("multiple_nmis"),
                "average_day_kwh": parsed.get("average_day_kwh"),
            },
            "persisted": persisted,
            "raw_file_path": refs.get("raw_file_path"),
            "parsed_series_ref": refs.get("parsed_series_ref"),
            "flags": flags,
            # 3.6 additive keys — downstream that ignores them is unaffected.
            "load_profile_saved": load_profile_saved,
            "accuracy_tier_written": accuracy_tier_written,
        }
    except Exception as exc:  # noqa: BLE001 — never block the workflow
        sentry_sdk.capture_exception(exc)
        return {
            "ok": False,
            "error": "Something went wrong reading the file. Please try again or use the survey estimate.",
            "suggest_tier2_fallback": True,
        }
