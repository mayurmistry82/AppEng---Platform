"""
Job persistence routes — ML data-flywheel capture (docs/2026-06-05-ml-data-flywheel-plan.md).

POST /api/job/save        — persist one complete, de-identified, linked job record.
POST /api/job/correction  — record an installer override as a before/after gold label.

Best-effort by contract: these endpoints MUST NEVER block the installer. On any failure
they log to Sentry and return HTTP 200 with a null id, so the UI proceeds and results
still display. Non-PII tables are written via capture.py (anon-key friendly). The PII
table (job_customers) is written directly here because capture.py has no PII writer —
under the backend's anon key that write is denied by RLS and silently skipped (PII is
simply not stored); configure SUPABASE_SERVICE_ROLE_KEY to enable it.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import capture

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
