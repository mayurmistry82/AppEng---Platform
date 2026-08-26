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
from typing import Any, Literal, Optional

import sentry_sdk
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator

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


# ── 3.8: the tariff envelope writer ──────────────────────────────────────────

_TIME_HHMM = r"^([01]?\d|2[0-4]):[0-5]\d$"


class TariffWindowIn(BaseModel):
    """One TOU window, in the SAME "HH:MM" shape bill_parser emits — one stored
    shape for one idea: whatever writes a window, _build_rate_24 reads it the
    same way. An unreadable time is a 422 HERE, not a skipped window later."""

    label: Literal["peak", "shoulder", "offpeak", "flat"]
    rate: float = Field(ge=0, le=5)
    start: str = Field(pattern=_TIME_HHMM)
    end: str = Field(pattern=_TIME_HHMM)
    days: Literal["weekday", "weekend", "all"] = "all"


# ── 3.18 prompt 1: field-level provenance of the saved envelope ──────────────
# The ONLY definition of the vocabulary anywhere — tariffs.field_sources
# deliberately carries no CHECK constraint (D33: a label must be able to gain a
# value without a migration each time); the endpoint refuses an unknown label
# at write time so the refusal can name the accepted values. The RESOLVER's own
# row-level vocabulary (request / installer / bill / default) answers a
# DIFFERENT question — where a value came from at SIZING time — and is
# untouched. These are two levels, not one. There is deliberately no "bill":
# tariffNetworkView has no bill branch (it reads detail.bills only for the
# mismatch notice), so a bill-derived prefill is not something the form can
# produce, and a value no path can emit is a feature that only claims to exist.
TARIFF_FIELD_SOURCES: frozenset[str] = frozenset({"typed", "accepted_default"})

# The savable columns whose DISPLAYED value can come from somewhere other than
# a person typing: fit_aud_per_kwh and export_limit_kw are prefilled by
# lib/worksheet.ts::tariffNetworkView from TariffDefaults, and tariff_type by
# the form's own `view.tariffType ?? "flat"` literal. The other three cannot be
# accepted defaults: import_rate and supply_charge have deliberately no prefill
# (F78 — a guess presented as an entered value), and tou_windows only ever
# shows stored rows or empty seeds that validation refuses to save untouched.
# verify_tariff_provenance.py asserts set equality with the frontend's list.
PREFILLED_TARIFF_FIELDS: frozenset[str] = frozenset({
    "tariff_type", "fit_aud_per_kwh", "export_limit_kw",
})


class TariffSaveRequest(BaseModel):
    tariff_type: Literal["flat", "tou"]
    import_rate: Optional[float] = Field(default=None, ge=0, le=5)
    tou_windows: Optional[list[TariffWindowIn]] = None
    supply_charge: Optional[float] = Field(default=None, ge=0, le=20)
    fit_aud_per_kwh: Optional[float] = Field(default=None, ge=0, le=5)
    export_limit_kw: Optional[float] = Field(default=None, ge=0, le=100)
    source: Literal["installer", "bill", "default"] = "installer"
    # 3.18: {column name -> TARIFF_FIELD_SOURCES label} for the values in THIS
    # save. Optional — an older client that never sends it must not be broken.
    # str values, NOT a Literal: the vocabulary lives in TARIFF_FIELD_SOURCES
    # and the endpoint refuses unknown labels itself (the CONFIRMED_SOURCES
    # pattern in routes/roof.py).
    field_sources: Optional[dict[str, str]] = None

    @field_validator("field_sources", mode="before")
    @classmethod
    def _field_sources_readable(cls, value: object) -> object:
        # An unreadable shape is a 422 BEFORE any write, in plain English —
        # never a partial store.
        if value is None:
            return value
        if not isinstance(value, dict):
            raise ValueError(
                "field_sources must be an object mapping tariff field names "
                "to source labels."
            )
        for key, item in value.items():
            if not isinstance(item, str):
                raise ValueError(
                    f"field_sources[{key!r}] must be a plain string label, "
                    f"not {type(item).__name__}."
                )
        return value


# Derived FROM the model, not transcribed beside it, so it cannot drift: the
# value-bearing fields the form saves. `source` is the row-level label the
# resolver reads today (prompt 2 decides its future) and `field_sources` is the
# provenance record itself — neither carries a tariff value.
SAVABLE_TARIFF_FIELDS: frozenset[str] = frozenset(
    name for name in TariffSaveRequest.model_fields
    if name not in ("source", "field_sources")
)


def _tariff_value_matches(incoming: Any, stored: Any) -> bool:
    """True when the incoming value and the stored one are the same value.
    Numerics compare AS NUMBERS — PostgREST hands them back as float or string
    depending on the column — and bools never coerce (bool is an int subclass,
    so float(True) == 1.0 would call True a $1 rate). None never matches."""
    if incoming is None or stored is None:
        return False
    if isinstance(incoming, bool) or isinstance(stored, bool):
        return incoming is stored
    try:
        return float(incoming) == float(stored)
    except (TypeError, ValueError):
        return incoming == stored


# The SAME four-table rule routes/job.py's address lock uses (its
# _ADDRESS_LOCK_TABLES) — derived here, never hardcoded to true, and job.py is
# deliberately not modified to share it.
_ADDRESS_LOCKING_TABLES = ("roof_geometry", "sizing_results", "tariffs", "interval_data")


def _address_locked_now(client: Any, job_id: str) -> bool:
    for table in _ADDRESS_LOCKING_TABLES:
        try:
            res = (
                client.table(table).select("job_id").eq("job_id", job_id)
                .limit(1).execute()
            )
            if getattr(res, "data", None):
                return True
        except Exception:  # noqa: BLE001 — unknowable reads as not-provably-locked
            continue
    return False


@router.post("/api/job/{job_id}/tariff")
async def save_job_tariff(
    job_id: str,
    body: TariffSaveRequest,
    caller: Caller = Depends(require_company),
):
    """Store the job's ONE tariff envelope (upsert on job_id). Ownership first;
    absent and foreign jobs answer the identical 404, unknowable answers 503 —
    all from require_company_job."""
    client = _client()
    require_company_job(client, job_id, caller.company_id)

    # A single window is a flat tariff wearing a costume — bill_parser's
    # structured_detected test makes the same call, and the two must agree.
    if body.tariff_type == "tou" and len(body.tou_windows or []) < 2:
        raise HTTPException(
            status_code=422,
            detail="A time-of-use tariff needs at least two windows — with one window it is a flat tariff, so save it as flat.",
        )
    if body.tariff_type == "flat" and body.import_rate is None:
        raise HTTPException(
            status_code=422,
            detail="A flat tariff needs its import rate — that number is what this section exists to collect.",
        )

    # ── 3.18: validate the provenance claims — all refusals before any write ──
    supplied_sources = dict(body.field_sources or {})
    unknown_fields = set(supplied_sources) - SAVABLE_TARIFF_FIELDS
    if unknown_fields:
        raise HTTPException(
            status_code=422,
            detail=(
                f"field_sources names unknown field(s) {sorted(unknown_fields)} — "
                f"the savable tariff fields are: {', '.join(sorted(SAVABLE_TARIFF_FIELDS))}."
            ),
        )
    unknown_labels = set(supplied_sources.values()) - TARIFF_FIELD_SOURCES
    if unknown_labels:
        raise HTTPException(
            status_code=422,
            detail=(
                f"unknown field_sources label(s) {sorted(unknown_labels)} — "
                f"accepted values: {', '.join(sorted(TARIFF_FIELD_SOURCES))}."
            ),
        )
    false_defaults = sorted(
        f for f, label in supplied_sources.items()
        if label == "accepted_default" and f not in PREFILLED_TARIFF_FIELDS
    )
    if false_defaults:
        # No default exists on these fields to accept, so the claim is false by
        # construction — without this guard a client bug could launder a typed
        # number into a default.
        raise HTTPException(
            status_code=422,
            detail=(
                f"'accepted_default' claimed on {false_defaults}, but only "
                f"{', '.join(sorted(PREFILLED_TARIFF_FIELDS))} are ever prefilled — "
                "there is no default on that field to accept."
            ),
        )

    warnings: list[str] = []

    incoming_values: dict[str, Any] = {
        name: getattr(body, name) for name in sorted(SAVABLE_TARIFF_FIELDS)
    }
    if body.tou_windows:
        incoming_values["tou_windows"] = [w.model_dump() for w in body.tou_windows]

    # The stored row FIRST, because rule 5 needs it: a re-save of an untouched
    # field must not relabel it, and the client cannot know the history.
    stored_row: Optional[dict] = None
    stored_read_failed = False
    try:
        res = (
            client.table("tariffs").select("*").eq("job_id", job_id)
            .limit(1).execute()
        )
        rows = getattr(res, "data", None) or []
        stored_row = rows[0] if rows else None
    except Exception as exc:  # noqa: BLE001 — unreadable history is a warning, never a guess
        sentry_sdk.capture_exception(exc)
        stored_read_failed = True

    field_sources_out: dict[str, str] = {}
    include_field_sources = True
    if stored_read_failed:
        # Do NOT guess: keep only what the client asserted about non-null
        # values. With nothing asserted there is nothing to store — leave the
        # stored column untouched rather than overwrite history we cannot see.
        field_sources_out = {
            f: label for f, label in supplied_sources.items()
            if incoming_values.get(f) is not None
        }
        include_field_sources = bool(field_sources_out)
        warnings.append(
            "The stored tariff could not be read back, so the provenance of "
            "unchanged fields was not carried forward — only this save's own "
            "labels were recorded."
        )
    else:
        stored_sources_raw = stored_row.get("field_sources") if stored_row else None
        stored_sources = stored_sources_raw if isinstance(stored_sources_raw, dict) else {}
        for f in sorted(SAVABLE_TARIFF_FIELDS):
            value = incoming_values.get(f)
            if value is None:
                continue  # no value, no provenance — never a placeholder
            if f in supplied_sources:
                field_sources_out[f] = supplied_sources[f]
                continue
            # No label supplied: carry the stored label forward ONLY for an
            # unchanged value. A changed value with no label stores NO key —
            # never "typed": a label that cannot tell a default from a decision
            # is worse than no label.
            prior = stored_sources.get(f)
            stored_value = stored_row.get(f) if stored_row else None
            if isinstance(prior, str) and _tariff_value_matches(value, stored_value):
                field_sources_out[f] = prior

    now = datetime.now(timezone.utc).isoformat()
    payload: dict[str, Any] = {
        "job_id": job_id,
        **incoming_values,
        "source": body.source,
        "updated_at": now,
    }
    if include_field_sources:
        payload["field_sources"] = field_sources_out
    tariff_id = capture.save_tariff(payload)
    saved = tariff_id is not None

    tariff_row = None
    if saved:
        try:
            res = (
                client.table("tariffs").select("*").eq("job_id", job_id)
                .limit(1).execute()
            )
            tariff_row = res.data[0] if res.data else None
        except Exception as exc:  # noqa: BLE001
            sentry_sdk.capture_exception(exc)
            warnings.append("Saved, but the stored row could not be read back.")
    else:
        # capture.save_tariff returns None on ANY failure, silently, by design.
        # That silence must NOT pass through: the section's completeness reads
        # the DATABASE, so a false success here is the worst possible outcome
        # (the 3.6 lesson).
        warnings.append(
            "The tariff could not be saved — nothing was stored. Try again in a moment."
        )

    address_now_locked = saved and _address_locked_now(client, job_id)
    if address_now_locked:
        warnings.append("This job's address is now locked — the tariff follows from it.")

    return {
        "ok": True,
        "tariff_id": tariff_id,
        "saved": saved,
        "tariff": tariff_row,
        "address_now_locked": address_now_locked,
        "warnings": warnings,
    }
