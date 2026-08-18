"""
Job persistence routes — ML data-flywheel capture (docs/2026-06-05-ml-data-flywheel-plan.md)
plus the authenticated job CRUD API (2026-08-06).

Legacy capture endpoints (no auth — the running frontend still calls them; retrofit is a
separate pre-deployment task):
POST /api/job/save        — persist one complete, de-identified, linked job record.
POST /api/job/correction  — record an installer override as a before/after gold label.

Authenticated CRUD (identity ALWAYS from auth.Caller, never from the payload):
POST  /api/job                  — create a job for the caller's company.
GET   /api/jobs                 — list the caller's company's jobs + dashboard KPIs.
GET   /api/job/{job_id}         — one job hydrated with every child table.
PATCH /api/job/{job_id}/status  — manual status transition.

SECURITY MODEL for the CRUD endpoints: they run on the SERVICE-ROLE client, which
BYPASSES RLS — the company-scoped policies give them no protection. Every query is
therefore filtered by caller.company_id in code, and another company's job is answered
with 404 (never 403 — a 403 confirms the job exists, which leaks information).

Best-effort contract of the legacy endpoints is unchanged: they never block the installer.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

import httpx
import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import capture
import job_paths
import solar_retention
import nem_data
from auth import Caller, require_company

logger = logging.getLogger("enrgengine.job")

router = APIRouter()


# ── Request models ────────────────────────────────────────────────────────────
class CustomerPII(BaseModel):
    customer_name: Optional[str] = None
    property_address_full: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None


class SiteInfo(BaseModel):
    postcode: Optional[str] = None
    state: Optional[str] = None
    dnsp: Optional[str] = None
    lat_coarse: Optional[float] = None
    lon_coarse: Optional[float] = None


class JobSaveRequest(BaseModel):
    job_id: Optional[str] = None
    installer_id: Optional[str] = None
    # Installer attestation that the customer was given the privacy notice (notice-based
    # de-identified flywheel). Replaces the prior customer-facing training_consent
    # checkbox; training_consent is kept optional for backward-compat only.
    privacy_notice_given: bool = False
    training_consent: bool = False
    status: Optional[str] = "complete"
    customer: Optional[CustomerPII] = None
    site: Optional[SiteInfo] = None
    accuracy_tier: Optional[int] = None
    confidence_pct: Optional[float] = None
    engine_versions: Optional[dict[str, Any]] = None
    bills: list[dict[str, Any]] = []
    tariffs: list[dict[str, Any]] = []
    survey: Optional[dict[str, Any]] = None
    load_profile: Optional[dict[str, Any]] = None
    solar_resource: Optional[dict[str, Any]] = None
    sizing_result: Optional[dict[str, Any]] = None
    financial_result: Optional[dict[str, Any]] = None
    # Smart-meter interval-data back-link (E1). Present when an interval file was uploaded
    # this session; carries the Storage refs + metadata so the interval_data row can be
    # created/linked here once a job_id exists (the upload may have had no job_id yet).
    interval: Optional[dict[str, Any]] = None


class CorrectionRequest(BaseModel):
    job_id: str
    source_module: Optional[str] = None
    field_path: Optional[str] = None
    original_value: Optional[str] = None
    corrected_value: Optional[str] = None
    value_type: Optional[str] = None


# ── PII write (route-local; capture.py intentionally has no PII writer) ───────
def _save_job_customer(job_id: str, customer: CustomerPII) -> None:
    """
    Best-effort PII upsert into job_customers. NEVER raises.

    job_customers RLS grants authenticated/service_role only (PII is locked away from
    the public anon role by design). Under the backend's anon key this write is denied
    and silently skipped — PII is simply not stored. Set SUPABASE_SERVICE_ROLE_KEY to
    enable it.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return
    try:
        from supabase import create_client

        client = create_client(url, key)
        client.table("job_customers").upsert(
            {
                "job_id": job_id,
                "customer_name": customer.customer_name,
                "property_address_full": customer.property_address_full,
                "contact_email": customer.contact_email,
                "contact_phone": customer.contact_phone,
            },
            on_conflict="job_id",
        ).execute()
    except Exception as exc:  # noqa: BLE001 - best-effort, never propagate
        sentry_sdk.capture_exception(exc)


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.post("/api/job/save")
async def save_job(req: JobSaveRequest):
    """Persist a job and all linked records. Returns {job_id}. Never blocks the UI."""
    try:
        site = req.site or SiteInfo()
        # Mint a job_id when the client hasn't sent one (the first save of a fresh job).
        # capture.py always writes this column explicitly, so passing None would override
        # the DB's gen_random_uuid() default and trip the NOT NULL constraint — meaning a
        # brand-new job would never persist (and the interval back-link below would have
        # nothing to bind to). Generating it here guarantees the job persists and the
        # interval_data row can be linked. Idempotent: capture upserts on job_id.
        job_id_in = req.job_id or str(uuid.uuid4())
        # Central de-identified job record (capture.py drops any stray PII key).
        job_id = capture.save_job(
            {
                "job_id": job_id_in,
                "installer_id": req.installer_id,
                "status": req.status or "complete",
                "privacy_notice_given": req.privacy_notice_given,
                "site_postcode": site.postcode,
                "site_state": site.state,
                "site_dnsp": site.dnsp,
                "site_lat_coarse": site.lat_coarse,
                "site_lon_coarse": site.lon_coarse,
                "accuracy_tier": req.accuracy_tier,
                "confidence_pct": req.confidence_pct,
                "engine_versions": req.engine_versions,
            }
        )
        if not job_id:
            # Capture unavailable / failed — nothing to link to. Don't block the UI.
            return JSONResponse(status_code=200, content={"job_id": None})

        # Linked children — capture.py allowlists ignore unknown keys, so spreading
        # the frontend dicts is safe. job_id is authoritative.
        for bill in req.bills or []:
            capture.save_bill({**bill, "job_id": job_id})
        for tariff in req.tariffs or []:
            capture.save_tariff({**tariff, "job_id": job_id})
        if req.survey:
            capture.save_survey({**req.survey, "job_id": job_id})
        if req.load_profile:
            capture.save_load_profile({**req.load_profile, "job_id": job_id})
        if req.solar_resource:
            capture.save_solar_resource({**req.solar_resource, "job_id": job_id})
        if req.sizing_result:
            capture.save_sizing_result({**req.sizing_result, "job_id": job_id})
        if req.financial_result:
            capture.save_financial_result({**req.financial_result, "job_id": job_id})
        if req.customer:
            _save_job_customer(job_id, req.customer)
        if req.interval:
            # Guarantee the smart-meter interval_data row exists & is linked to this job,
            # even when no job_id existed at upload time (the raw file + series are already
            # in Storage — this back-links the durable row). Idempotent on (job_id, nmi):
            # a no-op if the row already exists. Best-effort; a failure here is logged and
            # retried on the next save, and never blocks the job save.
            from routes.interval import backfill_interval_row

            _written, _interval_err = backfill_interval_row(job_id, req.interval)
            if _interval_err:
                sentry_sdk.capture_message(
                    f"[job/save] interval back-fill incomplete for {job_id}: {_interval_err}"
                )

        return {"job_id": job_id}
    except Exception as exc:  # noqa: BLE001 - never block the installer
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=200, content={"job_id": None})


@router.post("/api/job/correction")
async def save_correction(req: CorrectionRequest):
    """Record an installer override (gold label). Returns {correction_id}. Never blocks."""
    try:
        correction_id = capture.save_correction(
            {
                "job_id": req.job_id,
                "source_module": req.source_module,
                "field_path": req.field_path,
                "original_value": req.original_value,
                "corrected_value": req.corrected_value,
                "value_type": req.value_type,
            }
        )
        return {"correction_id": correction_id}
    except Exception as exc:  # noqa: BLE001 - never block the installer
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=200, content={"correction_id": None})


# ═══════════════════════════════════════════════════════════════════════════════
# Authenticated job CRUD (2026-08-06). Identity comes from auth.Caller ONLY.
# ═══════════════════════════════════════════════════════════════════════════════

_VALID_STATUSES = ("draft", "sized", "sent", "won", "installed", "lost")
_SORTS = {
    "updated_desc": ("updated_at", True),
    "updated_asc": ("updated_at", False),
    "created_desc": ("created_at", True),
    "created_asc": ("created_at", False),
}
# Child tables hydrated by GET /api/job/{id}. job_customers is exposed as "customer".
_CHILD_TABLES: list[tuple[str, str]] = [
    ("customer", "job_customers"),
    ("bills", "bills"),
    ("tariffs", "tariffs"),
    ("surveys", "surveys"),
    ("load_profiles", "load_profiles"),
    ("solar_resources", "solar_resources"),
    ("sizing_results", "sizing_results"),
    ("financial_results", "financial_results"),
    ("corrections", "corrections"),
    ("interval_data", "interval_data"),
    ("actuals", "actuals"),
    ("roof_geometry", "roof_geometry"),
]

_NOT_FOUND = HTTPException(status_code=404, detail="Job not found")
_UNAVAILABLE = HTTPException(status_code=503, detail="Database unavailable")

_SVC: Any = None
_SVC_READY = False


def _svc() -> Any:
    """Service-role client (bypasses RLS — which is exactly why every query below
    filters by company_id in code). Service-role ONLY: no anon fallback, matching
    auth.py — a quiet downgrade here would skew reads instead of failing loudly."""
    global _SVC, _SVC_READY
    if _SVC_READY:
        return _SVC
    _SVC_READY = True
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("job CRUD: SUPABASE_SERVICE_ROLE_KEY missing — endpoints will 503.")
        _SVC = None
        return None
    try:
        from supabase import create_client

        _SVC = create_client(url, key)
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        _SVC = None
    return _SVC


def _require_svc() -> Any:
    client = _svc()
    if client is None:
        raise _UNAVAILABLE
    return client


def _num(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _parse_ts(v: Any) -> Optional[datetime]:
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


# Postcode / state derivation ---------------------------------------------------
# Replaces the old "last 4-digit group" extraction, which mistook a street number for a
# postcode whenever the address had no postcode: "1234 Main North Rd, Adelaide" resolved
# to 1234 -> NSW (1000-2599) on an SA property, silently corrupting export limit, FiT and
# STC zone with entirely plausible-looking output.
_STATE_ABBRS = frozenset({"SA", "NSW", "VIC", "QLD", "WA", "TAS", "NT", "ACT"})
_COUNTRY_WORDS = frozenset({"AUSTRALIA", "AUS", "AU"})
# Longest first so "New South Wales" is consumed before any shorter overlap.
_FULL_STATE_NAMES: list[tuple[str, str]] = sorted(
    [
        ("Australian Capital Territory", "ACT"),
        ("New South Wales", "NSW"),
        ("Northern Territory", "NT"),
        ("Western Australia", "WA"),
        ("South Australia", "SA"),
        ("Queensland", "QLD"),
        ("Tasmania", "TAS"),
        ("Victoria", "VIC"),
    ],
    key=lambda p: -len(p[0]),
)


def _as_postcode(token: str) -> Optional[str]:
    """A digit token as a REAL postcode, or None. 3-digit tokens are zero-padded to
    cover NT/ACT leading-zero postcodes written bare ("NT 800" -> "0800"); the padded
    value must still map to a state, so 300-799 and other junk are rejected."""
    if not token.isdigit():
        return None
    if len(token) == 4:
        candidate = token
    elif len(token) == 3:
        candidate = "0" + token
    else:
        return None
    return candidate if nem_data.postcode_to_state(candidate) else None


def _derive_site(address: Any) -> tuple[Optional[str], Optional[str], list[str]]:
    """
    (postcode, state, flags) from a free-text address. Never raises, for any input.

    A digit group only counts as a postcode when it sits in a POSTCODE POSITION —
    immediately after the state token ("... SA 5000", the standard AU format) or in the
    trailing tail of the address. A leading "1234 Main North Rd" is a street number and
    is never eligible, which is the whole point of this function.

    When a state token and the postcode-derived state disagree, THE TOKEN WINS and the
    postcode is dropped: a wrong state silently corrupts the entire financial envelope
    (export limit, FiT, STC zone), whereas a missing postcode only costs precision.
    Prefer no postcode to a wrong state.

    Never guesses. A city name is not a state token — "Adelaide" alone yields nothing.
    """
    try:
        if not isinstance(address, str):
            return None, None, []
        raw = address.strip()
        if not raw:
            return None, None, []

        # Full state names -> abbreviations so both forms take one code path.
        normalised = raw
        for full, abbr in _FULL_STATE_NAMES:
            normalised = re.sub(rf"\b{re.escape(full)}\b", abbr, normalised, flags=re.IGNORECASE)

        tokens = re.findall(r"[A-Za-z]+|\d+", normalised)
        upper = [t.upper() for t in tokens]

        # Whole-token match only, so "Waterloo" never reads as WA. Last occurrence wins,
        # so a street named "Victoria" is overridden by the real trailing state token.
        state_idx = None
        for i, tok in enumerate(upper):
            if tok in _STATE_ABBRS:
                state_idx = i
        token_state = upper[state_idx] if state_idx is not None else None

        # Trailing tail, ignoring a trailing country word.
        end = len(tokens)
        while end > 0 and upper[end - 1] in _COUNTRY_WORDS:
            end -= 1
        tail_start = max(0, end - 2)

        postcode: Optional[str] = None
        saw_unmappable = False

        # (a) Immediately after the state token — the strongest signal.
        if state_idx is not None and state_idx + 1 < len(tokens):
            tok = tokens[state_idx + 1]
            if tok.isdigit():
                found = _as_postcode(tok)
                if found:
                    postcode = found
                else:
                    saw_unmappable = True

        # (b) Otherwise the last candidate in the tail that maps to a real state.
        if postcode is None:
            for i in range(end - 1, tail_start - 1, -1):
                tok = tokens[i]
                if not tok.isdigit():
                    continue
                found = _as_postcode(tok)
                if found:
                    postcode = found
                    break
                saw_unmappable = True

        derived_state = nem_data.postcode_to_state(postcode) if postcode else None
        flags: list[str] = []

        if token_state:
            if postcode and derived_state and derived_state != token_state:
                # Trust the token; drop the postcode rather than ship a wrong state.
                flags.append("postcode_state_mismatch")
                return None, token_state, flags
            if postcode:
                return postcode, token_state, flags
            flags.append("postcode_not_found_in_address")
            if saw_unmappable:
                flags.append("state_not_derivable")
            flags.append("postcode_from_state_token")
            return None, token_state, flags

        if postcode:
            return postcode, derived_state, flags
        flags.append("postcode_not_found_in_address")
        if saw_unmappable:
            flags.append("state_not_derivable")
        return None, None, flags
    except Exception as exc:  # noqa: BLE001 — derivation must never block job creation
        logger.warning("job CRUD: site derivation failed for %r: %s", address, exc)
        return None, None, []


def _get_company_job(client: Any, job_id: str, company_id: str) -> dict:
    """Fetch one job IFF it belongs to this company. Bad uuid, no such job or someone
    else's job are the SAME 404, so existence never leaks.

    3.4b (F88): a TRANSPORT failure — the database unreachable, a timeout — is not
    "not yours", it is "could not check". That answers 503, never 404: before this
    a network blip during any job fetch read as "Job not found", the same
    unknowable-as-verdict fault the auth layer fixed on 2026-08-14. Every other
    exception (an invalid uuid rejected by Postgres, a malformed id) stays 404."""
    try:
        res = client.table("jobs").select("*").eq("job_id", job_id).limit(1).execute()
        rows = getattr(res, "data", None) or []
    except (httpx.TransportError, TimeoutError, OSError) as exc:
        logger.warning("job CRUD: job fetch TRANSPORT failure for %r: %s", job_id, exc)
        raise _UNAVAILABLE from None
    except Exception as exc:  # noqa: BLE001 — bad uuid etc. must read as not-found
        logger.info("job CRUD: job fetch failed for %r: %s", job_id, exc)
        raise _NOT_FOUND from None
    if not rows or rows[0].get("company_id") != company_id:
        raise _NOT_FOUND
    return rows[0]


class JobCreateRequest(BaseModel):
    """Body for POST /api/job. Deliberately contains NO company_id / installer_id —
    pydantic drops unknown keys, so a payload asserting either is ignored silently."""

    address: str = Field(min_length=1)
    customer_name: Optional[str] = None
    has_existing_solar: Optional[bool] = None
    existing_solar_kw: Optional[float] = None
    existing_inverter_kw: Optional[float] = None
    intent: Optional[Literal["solar", "battery", "both"]] = None


class StatusPatchRequest(BaseModel):
    status: Literal["draft", "sized", "sent", "won", "installed", "lost"]


class JobSitePatch(BaseModel):
    """Body for PATCH /api/job/{id} — the ONE job-field writer (3.4b). F83 closed.

    THE WHITELIST IS THE SECURITY BOUNDARY: pydantic drops unknown keys, so
    company_id / installer_id / path / status / address in a payload are ignored
    silently — never echoed, never an error. `path` is a GENERATED column and an
    attempted write would fail loudly; this whitelist is what stops it being tried.
    3.3c EXTENDS this model (customer_name, intent, the solar fields) — one
    whitelist that grows, never a second implementation (D2).

    ABSENT vs NULL are different facts: an explicit null CLEARS a column, a field
    absent from the payload is LEFT ALONE (model_dump(exclude_unset=True)).
    Conflating them is how a partial save wipes another visit's data — and since
    3.3c added customer_name it is how a partial save wipes a customer's NAME.

    The ORIGINAL SEVEN (storeys .. electrical_phase) are site-visit fields: all
    optional, never gating (D5), and a job with every one empty is NOT
    incomplete. THAT SENTENCE DOES NOT COVER THE SIX 3.3c FIELDS BELOW THEM:
    customer_name and address are job identity (PII, stored on job_customers,
    never on jobs); has_existing_solar / existing_solar_kw /
    existing_inverter_kw / intent are the six-path routing inputs, and changing
    intent re-derives the GENERATED `path` column and with it which worksheet
    sections exist. `address` is additionally guarded server-side: once
    anything has been derived from it (roof_geometry, sizing_results, tariffs,
    interval_data) the PATCH answers 409 and writes nothing (F82).

    THE 3.9 TRIO (objective / custom_weight / budget_aud) is a third kind of
    field again: OPTIMISATION INPUTS. They are not site-visit fields (D5 —
    nothing here gates anything) and not job identity (3.3c). They steer what
    the sizing engine optimises FOR, nothing is derived from them, and they
    take NO part in the address-lock check — changing the objective after a
    roof is measured is normal, changing the address is not.
    """

    storeys: Optional[int] = Field(default=None, ge=1, le=5)
    # No DB constraint exists on roof_material — this bound and the UI list are
    # the only guards. Stored lowercase.
    roof_material: Optional[str] = Field(default=None, max_length=40)
    dwelling_type: Optional[Literal["detached", "townhouse", "unit", "other"]] = None
    year_built: Optional[int] = Field(default=None, ge=1800, le=2100)
    bedrooms: Optional[int] = Field(default=None, ge=0, le=20)
    floor_area_m2: Optional[float] = Field(default=None, gt=0, le=2000)
    electrical_phase: Optional[Literal["single", "three"]] = None
    # ── 3.3c — job-bar edit. See the docstring: these are NOT site-visit fields.
    customer_name: Optional[str] = Field(default=None, max_length=200)
    has_existing_solar: Optional[bool] = None
    existing_solar_kw: Optional[float] = Field(default=None, ge=0, le=1000)
    existing_inverter_kw: Optional[float] = Field(default=None, ge=0, le=1000)
    intent: Optional[Literal["solar", "battery", "both"]] = None
    address: Optional[str] = Field(default=None, min_length=1, max_length=500)
    # ── 3.9 — optimisation inputs. See the docstring: a third field kind.
    # The Literal is the ONE validation site for objective (no DB CHECK); its
    # members must stay equal to solar_optimiser.VALID_OBJECTIVES —
    # verify_objective_contract.py asserts that equality in both directions.
    # "backup" is deliberately absent until 4.5 teaches the ENGINE the word.
    objective: Optional[Literal["max_npv", "max_self_sufficiency",
                                "min_payback", "custom"]] = None
    custom_weight: Optional[float] = Field(default=None, ge=0, le=1)
    # gt=0, not ge=0: a zero budget is a typo, never an instruction — NULL
    # already means "no cap". le=500000 catches a stray zero on a residential
    # job while leaving headroom for the C&I segment 10.5 un-hides.
    budget_aud: Optional[float] = Field(default=None, gt=0, le=500000)


# Where each JobSitePatch field is WRITTEN (3.3c). jobs has NO address and NO
# customer_name column — both live on job_customers — so the PATCH writes two
# tables and this mapping is the single place that decides which. A model field
# in neither set raises at request time rather than being dropped silently: a
# field added to the model and forgotten here is exactly the silent no-op the
# 3.3c correction exists to prevent.
_JOBS_PATCH_FIELDS = {
    "storeys", "roof_material", "dwelling_type", "year_built", "bedrooms",
    "floor_area_m2", "electrical_phase",
    "has_existing_solar", "existing_solar_kw", "existing_inverter_kw", "intent",
    "objective", "custom_weight", "budget_aud",
}
_CUSTOMER_PATCH_FIELDS = {
    "customer_name": "customer_name",
    "address": "property_address_full",
}

# The four tables that DERIVE from the address (F82). A bill or a survey does
# not follow from the address and deliberately does not lock it.
_ADDRESS_LOCK_TABLES = ("roof_geometry", "sizing_results", "tariffs", "interval_data")

_ADDRESS_LOCKED_DETAIL = (
    "This job's address is locked — it has already been measured. Roof geometry, "
    "irradiance, network and incentives all follow from it. Create a new job for "
    "a different address."
)


@router.post("/api/job")
async def create_job(body: JobCreateRequest, caller: Caller = Depends(require_company)):
    """Create a draft job for the caller's company. Identity from the token, only."""
    client = _require_svc()

    # Site derivation — never guess, never crash; a miss is a null plus a flag.
    # An incomplete address is still a valid job: creation succeeds regardless and the
    # accuracy meter reflects what could not be derived.
    postcode, state, flags = _derive_site(body.address)
    dnsp = (nem_data.get_dnsp(state, postcode) or None) if state else None
    if state and dnsp is None:
        flags.append("dnsp_not_derivable")

    row = {
        "job_id": str(uuid.uuid4()),
        "company_id": caller.company_id,      # from the Caller — the body has no say
        "installer_id": caller.user_id,       # from the Caller — the body has no say
        "status": "draft",
        "site_postcode": postcode,
        "site_state": state,
        "site_dnsp": dnsp,
        "has_existing_solar": body.has_existing_solar,
        "existing_solar_kw": body.existing_solar_kw,
        "existing_inverter_kw": body.existing_inverter_kw,
        "intent": body.intent,
        # `path` is NEVER written — it is a GENERATED column; the DB derives it.
    }
    try:
        client.table("jobs").insert(row).execute()
        created = (
            client.table("jobs").select("*").eq("job_id", row["job_id"]).limit(1).execute()
        ).data[0]
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=500, content={"detail": "job create failed"})

    # PII (name + full address) goes to job_customers, never onto jobs.
    try:
        client.table("job_customers").upsert(
            {
                "job_id": created["job_id"],
                "customer_name": body.customer_name,
                "property_address_full": body.address,
            },
            on_conflict="job_id",
        ).execute()
    except Exception as exc:  # noqa: BLE001 — job exists; PII miss is flagged, not fatal
        sentry_sdk.capture_exception(exc)
        flags.append("customer_not_persisted")

    path = created.get("path")  # read back from the DB — the single source of truth
    return {
        **created,
        "path_label": job_paths.PATH_LABELS.get(path) if path else None,
        "address": body.address,
        "customer_name": body.customer_name,
        "flags": flags,
    }


@router.get("/api/jobs")
async def list_jobs(
    caller: Caller = Depends(require_company),
    status: Optional[list[str]] = Query(default=None),
    q: Optional[str] = None,
    sort: str = "updated_desc",
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """The caller's company's jobs — only ever theirs — plus the dashboard KPI strip."""
    client = _require_svc()
    if status:
        bad = [s for s in status if s not in _VALID_STATUSES]
        if bad:
            raise HTTPException(status_code=422, detail=f"invalid status filter: {bad}")
    if sort not in _SORTS:
        raise HTTPException(status_code=422, detail=f"invalid sort: {sort!r}")
    order_col, order_desc = _SORTS[sort]

    try:
        # Every query in this endpoint starts from .eq("company_id", caller.company_id).
        # There is intentionally no code path that omits it.
        query = (
            client.table("jobs").select("*").eq("company_id", caller.company_id)
        )
        if status:
            query = query.in_("status", status)
        jobs = (query.order(order_col, desc=order_desc).execute()).data or []

        job_ids = [j["job_id"] for j in jobs]
        customers: dict[str, dict] = {}
        sizing: dict[str, dict] = {}
        financial: dict[str, dict] = {}
        if job_ids:
            for r in (
                client.table("job_customers")
                .select("job_id, customer_name, property_address_full")
                .in_("job_id", job_ids)
                .execute()
            ).data or []:
                customers[r["job_id"]] = r
            for r in (
                client.table("sizing_results")
                .select("job_id, solar_kw, battery_kwh, created_at")
                .in_("job_id", job_ids)
                .order("created_at", desc=True)
                .execute()
            ).data or []:
                sizing.setdefault(r["job_id"], r)  # newest first — keep the latest
            for r in (
                client.table("financial_results")
                .select("job_id, payback_years, created_at")
                .in_("job_id", job_ids)
                .order("created_at", desc=True)
                .execute()
            ).data or []:
                financial.setdefault(r["job_id"], r)
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=500, content={"detail": "job list failed"})

    rows = []
    for j in jobs:
        cust = customers.get(j["job_id"]) or {}
        siz = sizing.get(j["job_id"]) or {}
        fin = financial.get(j["job_id"]) or {}
        path = j.get("path")
        rows.append(
            {
                "job_id": j["job_id"],
                "customer_name": cust.get("customer_name"),
                "address": cust.get("property_address_full"),
                "status": j.get("status"),
                "path": path,
                "path_label": job_paths.PATH_LABELS.get(path) if path else None,
                # Null headline figures when un-sized — the row itself is never omitted.
                "headline": {
                    "solar_kw": _num(siz.get("solar_kw")),
                    "battery_kwh": _num(siz.get("battery_kwh")),
                    "payback_years": _num(fin.get("payback_years")),
                },
                "accuracy_tier": j.get("accuracy_tier"),
                "assigned_to": j.get("assigned_to"),
                "notes": j.get("notes"),
                "scheduled_date": j.get("scheduled_date"),
                "event_type": j.get("event_type"),
                "updated_at": j.get("updated_at"),
            }
        )

    if q:
        needle = q.strip().lower()
        rows = [
            r
            for r in rows
            if needle in (r["address"] or "").lower()
            or needle in (r["customer_name"] or "").lower()
        ]

    total = len(rows)
    rows = rows[offset : offset + limit]

    # KPIs — over ALL of this company's jobs, ignoring the list filters above.
    try:
        all_jobs = (
            client.table("jobs")
            .select("job_id, status, quoted_value_aud, updated_at")
            .eq("company_id", caller.company_id)
            .execute()
        ).data or []
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        all_jobs = []

    now = datetime.now(timezone.utc)
    win_from = now - timedelta(days=90)
    pipeline = sum(
        _num(j.get("quoted_value_aud")) or 0.0
        for j in all_jobs
        if j.get("status") in ("sized", "sent")
    )
    won_90 = lost_90 = 0
    won_month_count = 0
    won_month_value = 0.0
    for j in all_jobs:
        ts = _parse_ts(j.get("updated_at"))
        if j.get("status") == "won":
            if ts and ts >= win_from:
                won_90 += 1
            if ts and ts.year == now.year and ts.month == now.month:
                won_month_count += 1
                won_month_value += _num(j.get("quoted_value_aud")) or 0.0
        elif j.get("status") == "lost" and ts and ts >= win_from:
            lost_90 += 1
    denom = won_90 + lost_90
    kpis = {
        "pipeline_value": round(pipeline, 2),
        "win_rate": round(won_90 / denom, 4) if denom else None,  # null, not 0, when empty
        "in_progress": sum(1 for j in all_jobs if j.get("status") in ("draft", "sized", "sent")),
        "won_this_month": {"count": won_month_count, "value": round(won_month_value, 2)},
    }

    return {"jobs": rows, "total": total, "limit": limit, "offset": offset, "kpis": kpis}


@router.get("/api/job/{job_id}")
async def get_job(job_id: str, caller: Caller = Depends(require_company)):
    """One job + a faithful dump of every child table. 404 when absent OR not yours."""
    client = _require_svc()
    job = _get_company_job(client, job_id, caller.company_id)

    children: dict[str, list] = {}
    for key, table in _CHILD_TABLES:
        # A missing/unreadable child table yields an empty list for its key, never a 500.
        try:
            res = client.table(table).select("*").eq("job_id", job_id).execute()
            rows = getattr(res, "data", None) or []
            if key == "roof_geometry":
                # 3.5b (§20.2) defence in depth: even if the nightly sweep has not
                # run, expired Google Solar Data never leaves the server. Only this
                # child table — nothing else holds Solar Data.
                rows = [solar_retention.redact_expired_solar_data(r) for r in rows]
            children[key] = rows
        except Exception as exc:  # noqa: BLE001
            logger.warning("job CRUD: hydration of %s failed for %s: %s", table, job_id, exc)
            children[key] = []

    path = job.get("path")
    return {
        **job,
        "path_label": job_paths.PATH_LABELS.get(path) if path else None,
        **children,
    }


@router.patch("/api/job/{job_id}/status")
async def patch_job_status(
    job_id: str, body: StatusPatchRequest, caller: Caller = Depends(require_company)
):
    """Manual status transition. Automatic advancing on result-save is a later task."""
    client = _require_svc()
    _get_company_job(client, job_id, caller.company_id)  # 404 when absent or not yours

    try:
        client.table("jobs").update(
            {"status": body.status, "updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("job_id", job_id).eq("company_id", caller.company_id).execute()
        updated = (
            client.table("jobs").select("*").eq("job_id", job_id).limit(1).execute()
        ).data[0]
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=500, content={"detail": "status update failed"})

    path = updated.get("path")
    return {
        **updated,
        "path_label": job_paths.PATH_LABELS.get(path) if path else None,
    }


@router.patch("/api/job/{job_id}")
async def patch_job(
    job_id: str, body: JobSitePatch, caller: Caller = Depends(require_company)
):
    """Update a job's fields. See JobSitePatch for the whitelist rules.

    3.3c: this is a TWO-TABLE write — jobs has no address and no customer_name
    column; both live on job_customers. The address lock (F82) is enforced HERE,
    not by the UI disabling a field: it must hold against a raw curl."""
    client = _require_svc()
    _get_company_job(client, job_id, caller.company_id)  # 404 absent/foreign, 503 transport

    # exclude_unset: only fields the payload actually carried. An explicit null
    # arrives here as None and CLEARS its column; an absent field never appears.
    updates = body.model_dump(exclude_unset=True)
    if "roof_material" in updates and isinstance(updates["roof_material"], str):
        updates["roof_material"] = updates["roof_material"].strip().lower() or None

    if not updates:
        # Nothing to write — no update call at all, and no updated_at bump for a no-op.
        job = _get_company_job(client, job_id, caller.company_id)
        path = job.get("path")
        return {**job, "path_label": job_paths.PATH_LABELS.get(path) if path else None}

    # THE ADDRESS LOCK (F82), before ANY write. All-or-nothing: a 409 writes
    # NOTHING, including the other fields in the same payload — a partial write
    # would show the installer a rejection while half their edit landed anyway.
    if "address" in updates:
        for table in _ADDRESS_LOCK_TABLES:
            try:
                res = (
                    client.table(table)
                    .select("job_id")
                    .eq("job_id", job_id)
                    .limit(1)
                    .execute()
                )
                rows = getattr(res, "data", None) or []
            except Exception as exc:  # noqa: BLE001 — unknowable is not "unlocked"
                sentry_sdk.capture_exception(exc)
                return JSONResponse(
                    status_code=503,
                    content={
                        "detail": "Could not check whether the address is locked — try again in a moment."
                    },
                )
            if rows:
                return JSONResponse(
                    status_code=409, content={"detail": _ADDRESS_LOCKED_DETAIL}
                )

    # Split into the two tables' dicts. A model field in neither mapping is a
    # BUG — raise loudly rather than dropping it into the silent-no-op class.
    jobs_updates: dict = {}
    customer_updates: dict = {}
    for key, value in updates.items():
        if key in _JOBS_PATCH_FIELDS:
            jobs_updates[key] = value
        elif key in _CUSTOMER_PATCH_FIELDS:
            customer_updates[_CUSTOMER_PATCH_FIELDS[key]] = value
        else:
            raise RuntimeError(
                f"JobSitePatch field {key!r} is mapped to neither jobs nor "
                "job_customers — fix _JOBS_PATCH_FIELDS/_CUSTOMER_PATCH_FIELDS"
            )

    # No triggers exist on either table: updated_at only moves because a writer
    # sets it, so BOTH writes set it explicitly.
    now = datetime.now(timezone.utc).isoformat()

    if jobs_updates:
        jobs_updates["updated_at"] = now
        try:
            client.table("jobs").update(jobs_updates).eq("job_id", job_id).eq(
                "company_id", caller.company_id
            ).execute()
        except Exception as exc:  # noqa: BLE001
            sentry_sdk.capture_exception(exc)
            return JSONResponse(status_code=500, content={"detail": "job update failed"})

    customer_wrote = False
    if customer_updates:
        customer_updates["updated_at"] = now
        try:
            # UPSERT, not update: a job whose PII write failed at creation has no
            # job_customers row, and an update would silently affect zero rows
            # and report success.
            client.table("job_customers").upsert(
                {**customer_updates, "job_id": job_id}, on_conflict="job_id"
            ).execute()
            customer_wrote = True
        except Exception as exc:  # noqa: BLE001 — NEVER downgrade an edit miss to a flag
            sentry_sdk.capture_exception(exc)
            return JSONResponse(
                status_code=500, content={"detail": "customer update failed"}
            )

    try:
        updated = (
            client.table("jobs").select("*").eq("job_id", job_id).limit(1).execute()
        ).data[0]
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        return JSONResponse(status_code=500, content={"detail": "job update failed"})

    # Read the PII back so the response is TRUE (the frontend refreshes anyway;
    # tools and tests read this). If the customer write just succeeded, a failed
    # read-back must not report success it cannot show.
    customer_name = None
    address = None
    try:
        pii_rows = (
            client.table("job_customers")
            .select("customer_name, property_address_full")
            .eq("job_id", job_id)
            .limit(1)
            .execute()
        ).data or []
        if pii_rows:
            customer_name = pii_rows[0].get("customer_name")
            address = pii_rows[0].get("property_address_full")
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        if customer_wrote:
            return JSONResponse(
                status_code=500, content={"detail": "customer update failed"}
            )

    path = updated.get("path")
    return {
        **updated,
        "path_label": job_paths.PATH_LABELS.get(path) if path else None,
        "customer_name": customer_name,
        "address": address,
    }
