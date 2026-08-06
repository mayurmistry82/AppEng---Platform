"""
backend/capture.py — best-effort ML data-flywheel write layer.

Persists a rich, structured, de-identified job record to Supabase so that every
EnrgEngine analysis produces training data for the (much later) ML calibration work.
See docs/2026-06-05-ml-data-flywheel-plan.md (§5 capture spec, §6 bill build).

CRITICAL CONTRACT — capture is best-effort and MUST NEVER block or crash the user flow:
  * Every Supabase call is wrapped in try/except.
  * On any failure (network, RLS/permission, bad payload) the function logs to Sentry
    (if configured) and returns None. It never raises to the caller.
  * If SUPABASE_URL / key is missing, every function no-ops and logs a warning once.

DE-IDENTIFICATION:
  * This module writes NO customer PII. Customer name / address belong in the separate
    `job_customers` table, which is intentionally not written here.
  * Each writer filters its payload to an explicit column allowlist, so a stray PII key
    (e.g. customer_name accidentally placed on a jobs payload) is silently dropped rather
    than persisted to a non-PII table.

KEY SELECTION:
  * Prefers SUPABASE_SERVICE_ROLE_KEY (correct for trusted server-side writes; bypasses
    RLS) when present, falling back to SUPABASE_ANON_KEY (the key the backend ships with
    today). Never hardcode keys — read via os.getenv with load_dotenv.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("enrgengine.capture")

# Sentry is optional — capture must work (and stay silent) even if it's absent.
try:  # pragma: no cover - trivial import guard
    import sentry_sdk
except Exception:  # pragma: no cover
    sentry_sdk = None  # type: ignore[assignment]

# Supabase client is optional at import time — a missing dependency must not crash imports.
try:  # pragma: no cover - trivial import guard
    from supabase import create_client
except Exception:  # pragma: no cover
    create_client = None  # type: ignore[assignment]


# ── Per-table insertable column allowlists ────────────────────────────────────
# Filtering to these (a) prevents an unexpected key from failing the whole write and
# (b) is a defence-in-depth de-identification guard for the non-PII tables.
_ALLOWED: dict[str, set[str]] = {
    "jobs": {
        # privacy_notice_given is the installer attestation gating the de-identified
        # flywheel (notice-based, on by default). training_consent is retained for
        # backward-compat with any old payloads but is no longer the training gate.
        "job_id", "installer_id", "company_id", "status", "privacy_notice_given", "training_consent",
        "site_postcode", "site_state", "site_dnsp", "site_lat_coarse", "site_lon_coarse",
        "accuracy_tier", "confidence_pct", "engine_versions",
        # Job-tracker fields (installer dashboard).
        "notes", "assigned_to", "scheduled_date", "event_type", "quoted_value_aud",
        # Six-path routing inputs. `path` is deliberately absent: it is a Postgres
        # GENERATED column, so writing to it raises — the database derives it from
        # has_existing_solar + intent. See backend/job_paths.py.
        "has_existing_solar", "existing_solar_kw", "existing_inverter_kw", "intent",
        # Property / building facts — capture-completeness. These cannot be reconstructed
        # after the fact. climate_zone is accepted but stays NULL until the NCC
        # postcode-to-zone mapping exists.
        "bedrooms", "floor_area_m2", "storeys", "dwelling_type", "year_built",
        "roof_material", "electrical_phase", "climate_zone",
        # Outcome labels — the supervised targets the flywheel eventually learns from.
        "job_outcome", "quoted_solar_kw", "quoted_battery_kwh",
        "installed_solar_kw", "installed_battery_kwh",
        "quoted_panel_id", "quoted_inverter_id", "quoted_battery_id",
    },
    "bills": {
        "bill_id", "job_id", "raw_file_path", "parsed_json", "parser_version",
        "parse_confidence", "billing_period_start", "billing_period_end",
        "billing_period_days", "total_kwh", "daily_avg_kwh", "daily_supply_charge",
        "retailer", "plan_name", "nmi", "has_solar", "feed_in_tariff",
    },
    "tariffs": {
        "tariff_id", "job_id", "bill_id", "tariff_type", "supply_charge", "fit_tiers",
        "tou_windows", "demand_charges", "controlled_load", "block_tiers",
    },
    "surveys": {
        "survey_id", "job_id", "household_size", "occupancy_pattern", "hot_water_type",
        "has_ev", "has_pool", "solar_export", "occupancy_grid", "daytime_home_frac",
        # Energy context — capture-completeness. ac_type / heating_type are free text
        # until the load-survey rebuild settles the option lists.
        "gas_connection", "ac_type", "num_evs", "ev_charger_kw", "heating_type",
    },
    "load_profiles": {
        "load_profile_id", "job_id", "archetype_used", "hourly_profile_weights",
        "daily_avg_kwh", "annual_kwh", "accuracy_tier", "confidence_pct",
        "appliance_adjustments", "tariff_type_used", "peak_period",
    },
    "solar_resources": {
        "solar_resource_id", "job_id", "lat", "lon", "annual_kwh_per_kwp",
        "peak_sun_hours", "monthly_profile", "source", "source_version",
    },
    "sizing_results": {
        "sizing_result_id", "job_id", "solar_kw", "battery_kwh",
        "self_consumption_ratio", "system_cost", "annual_solar_generation_kwh",
        "within_budget", "engine_version", "objective_used",
    },
    "financial_results": {
        "financial_result_id", "job_id", "system_capex", "annual_savings",
        "annual_bill_reduction", "payback_years", "npv_25_year", "roi_percent",
        "current_annual_spend", "projected_annual_spend",
    },
    "corrections": {
        "correction_id", "job_id", "source_module", "field_path", "original_value",
        "corrected_value", "value_type", "corrected_by", "corrected_at",
    },
}

# Conflict key (idempotency) and returned pk per table.
_CONFLICT: dict[str, str] = {
    "jobs": "job_id",
    "bills": "bill_id",
    "tariffs": "tariff_id",
    "surveys": "job_id",            # one survey per job (unique job_id)
    "load_profiles": "job_id",      # one profile per job
    "solar_resources": "job_id",    # one resource per job
    "sizing_results": "job_id",     # one sizing result per job
    "financial_results": "job_id",  # one financial result per job
    "corrections": "correction_id",
}
_PK: dict[str, str] = {
    "jobs": "job_id",
    "bills": "bill_id",
    "tariffs": "tariff_id",
    "surveys": "survey_id",
    "load_profiles": "load_profile_id",
    "solar_resources": "solar_resource_id",
    "sizing_results": "sizing_result_id",
    "financial_results": "financial_result_id",
    "corrections": "correction_id",
}


# ── Client (lazy, cached) ─────────────────────────────────────────────────────
_CLIENT: Any = None
_CLIENT_READY = False


def _report(exc: BaseException, message: str) -> None:
    """Log a capture failure and forward it to Sentry — never re-raise."""
    logger.warning("%s: %s", message, exc)
    if sentry_sdk is not None:
        try:
            sentry_sdk.capture_exception(exc)
        except Exception:  # pragma: no cover - Sentry must never break capture
            pass


def _get_client() -> Any:
    """
    Lazily build (and cache) the Supabase client. Returns None — and logs a warning
    once — if configuration or the dependency is missing. Never raises.
    """
    global _CLIENT, _CLIENT_READY
    if _CLIENT_READY:
        return _CLIENT
    _CLIENT_READY = True

    url = os.getenv("SUPABASE_URL")
    # Prefer the trusted server-side service-role key; fall back to the anon key.
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

    if create_client is None:
        logger.warning("capture: supabase client library unavailable; capture is a no-op.")
        _CLIENT = None
        return None
    if not url or not key:
        logger.warning(
            "capture: SUPABASE_URL / key not set; capture is a no-op (no rows written)."
        )
        _CLIENT = None
        return None

    try:
        _CLIENT = create_client(url, key)
    except Exception as exc:
        _report(exc, "capture: failed to initialise Supabase client")
        _CLIENT = None
    return _CLIENT


def reset_client_cache() -> None:
    """Test/ops hook — drop the cached client so the next call re-reads env."""
    global _CLIENT, _CLIENT_READY
    _CLIENT = None
    _CLIENT_READY = False


def _filtered(table: str, payload: dict) -> dict:
    """Keep only known columns for `table`. Defends against schema errors and stray PII."""
    allowed = _ALLOWED.get(table, set())
    return {k: v for k, v in dict(payload).items() if k in allowed}


def _write(table: str, payload: Optional[dict]) -> Optional[str]:
    """
    Upsert one row into `table` and return its primary-key value (str) or None.
    Idempotent on the table's conflict key. Best-effort: returns None on any problem.
    """
    if not isinstance(payload, dict):
        logger.warning("capture: %s skipped — payload is not a dict (%s).", table, type(payload))
        return None

    client = _get_client()
    if client is None:
        return None

    row = _filtered(table, payload)
    if not row:
        logger.warning("capture: %s skipped — no recognised columns in payload.", table)
        return None

    try:
        resp = (
            client.table(table)
            .upsert(row, on_conflict=_CONFLICT[table])
            .execute()
        )
        data = getattr(resp, "data", None)
        if not data:
            return None
        return data[0].get(_PK[table])
    except Exception as exc:
        _report(exc, f"capture: write to {table} failed")
        return None


# ── Public API — one writer per table. Each takes a plain dict, returns pk|None. ──
def save_job(payload: dict) -> Optional[str]:
    """Persist the central de-identified job record. Returns job_id or None.

    NOTE: pass de-identified fields only (postcode / coarse geo). Customer PII must
    NOT be passed here — any PII-looking keys are dropped by the allowlist anyway.
    """
    return _write("jobs", payload)


def save_bill(payload: dict) -> Optional[str]:
    """Persist one parsed bill (raw + structured + provenance). Returns bill_id or None."""
    return _write("bills", payload)


def save_tariff(payload: dict) -> Optional[str]:
    """Persist the structured tariff captured from a bill. Returns tariff_id or None."""
    return _write("tariffs", payload)


def save_survey(payload: dict) -> Optional[str]:
    """Persist load-characterisation survey inputs. Returns survey_id or None."""
    return _write("surveys", payload)


def save_load_profile(payload: dict) -> Optional[str]:
    """Persist the load.py output (archetype + hourly weights). Returns load_profile_id or None."""
    return _write("load_profiles", payload)


def save_solar_resource(payload: dict) -> Optional[str]:
    """Persist the irradiance output. Returns solar_resource_id or None."""
    return _write("solar_resources", payload)


def save_sizing_result(payload: dict) -> Optional[str]:
    """Persist the sizing_engine.py output. Returns sizing_result_id or None."""
    return _write("sizing_results", payload)


def save_financial_result(payload: dict) -> Optional[str]:
    """Persist the financial_model.py output. Returns financial_result_id or None."""
    return _write("financial_results", payload)


def save_correction(payload: dict) -> Optional[str]:
    """Persist an installer override before/after pair (gold label). Returns correction_id or None."""
    return _write("corrections", payload)


__all__ = [
    "save_job",
    "save_bill",
    "save_tariff",
    "save_survey",
    "save_load_profile",
    "save_solar_resource",
    "save_sizing_result",
    "save_financial_result",
    "save_correction",
    "reset_client_cache",
]
