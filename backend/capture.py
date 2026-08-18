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

DE-IDENTIFICATION — two layers, because one was not enough:
  * This module writes NO customer PII. Customer name / address belong in the separate
    `job_customers` table, which is intentionally not written here.
  * COLUMNS: each writer filters its payload to an explicit column allowlist, so a stray
    PII key (e.g. customer_name accidentally placed on a jobs payload) is silently
    dropped rather than persisted to a non-PII table.
  * INSIDE JSONB: the allowlist matches TOP-LEVEL KEYS ONLY and cannot see into a jsonb
    value, so an allowed column such as bills.parsed_json could carry the customer's name
    and supply address nested inside it — which is exactly what a full bill-parser payload
    does (bill_parser extracts property_address and customer_name by design). Every
    filtered payload is therefore ALSO passed through a recursive key scrub
    (_scrub_pii / _PII_KEYS) that removes PII keys at any depth. The guard lives here,
    not in the callers, so no future writer can forget it.

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
        # 3.8 — the tariff envelope: the scalar rate, the single FiT, the export
        # cap, the provenance, and the writer-set updated_at (no triggers exist).
        "import_rate", "fit_aud_per_kwh", "export_limit_kw", "source", "updated_at",
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
    # 3.8: job_id, not tariff_id — ONE envelope per job. An upsert keyed on a
    # generated tariff_id INSERTS every time (no id is ever supplied), so each
    # re-save appended a row. Correct only together with the unique index
    # tariffs_job_id_key added in the same change. _PK below is unchanged:
    # tariff_id is still what the caller gets back.
    "tariffs": "job_id",
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


# ── Nested-PII deny-list ──────────────────────────────────────────────────────
# Keys removed at ANY depth of a payload, matched case-insensitively.
#
# AUDITABLE, not guessed:
#   customer_name / property_address        — what bill_parser.parse_bill returns today
#   customer_name / property_address_full /
#     contact_email / contact_phone         — routes/job.py's CustomerPII fields, i.e.
#                                             the real job_customers column names
#   the rest                                — the aliases the bill_parser Vision prompt's
#                                             own wording invites ("Supply address",
#                                             "Property address", "Service address",
#                                             "Site address") plus the obvious near-misses.
# A deny-list covering only today's exact spellings is one prompt-wording change away
# from being useless, which is why the aliases are here before anything emits them.
#
# DELIBERATELY NOT LISTED: `combined_usage_periods`. The frontend's lib/store.ts drops it
# too, but for SIZE, not privacy — it is the parser's own usage history and it is useful
# flywheel data. Conflating a size decision with a privacy one would leave a later reader
# concluding this list is arbitrary.
_PII_KEYS: frozenset = frozenset(
    {
        "customer_name", "property_address", "property_address_full",
        "contact_email", "contact_phone", "customer_email", "customer_phone",
        "account_name", "account_holder", "mailing_address", "postal_address",
        "supply_address", "service_address", "site_address", "full_address",
        "street_address",
    }
)

# Recursion cap. Real payloads nest a handful of levels; anything deeper is either a bug
# or a cycle. On hitting the cap the value is DROPPED, never kept — an unscrubbable blob
# must not be stored, and the cap is also what makes a self-referencing payload terminate
# instead of hanging.
_MAX_SCRUB_DEPTH = 12

# Sentinel: "this value could not be scrubbed, omit it entirely."
_DROP = object()


def _scrub_pii(value: Any, _depth: int = 0) -> Any:
    """
    Recursively remove PII KEYS from dicts and lists. Pure and total: returns new
    containers, never mutates the input, never raises, never performs I/O.

    Matches KEYS, not values — a corrections row whose `field_path` is the STRING
    "customer_name" keeps that value untouched. Non-container values pass through
    unchanged; a non-string key cannot be PII and is left alone.
    """
    if _depth > _MAX_SCRUB_DEPTH:
        return _DROP
    if isinstance(value, dict):
        out: dict = {}
        for key, item in value.items():
            if isinstance(key, str) and key.lower() in _PII_KEYS:
                continue
            scrubbed = _scrub_pii(item, _depth + 1)
            if scrubbed is _DROP:
                continue
            out[key] = scrubbed
        return out
    if isinstance(value, (list, tuple)):
        cleaned = []
        for item in value:
            scrubbed = _scrub_pii(item, _depth + 1)
            if scrubbed is _DROP:
                continue
            cleaned.append(scrubbed)
        return cleaned
    return value


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
    """
    Keep only known columns for `table`, then scrub PII keys at every depth.

    TWO PASSES, IN THIS ORDER, deliberately not merged: the allowlist decides which
    COLUMNS exist (schema safety), the scrub decides what may hide INSIDE them (privacy).
    Merging them would make a column's existence depend on its contents.
    """
    allowed = _ALLOWED.get(table, set())
    row = {k: v for k, v in dict(payload).items() if k in allowed}
    scrubbed = _scrub_pii(row)
    return scrubbed if isinstance(scrubbed, dict) else {}


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
