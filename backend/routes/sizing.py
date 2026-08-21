from __future__ import annotations

import json
import math
import os
import uuid
from typing import Any, Literal, Optional
from pydantic import BaseModel
import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException

from auth import Caller, require_company

# 3.11b — THE OWNERSHIP RULE IS IMPORTED, NOT COPIED, underscore and all.
# routes/roof.py hand-copied this same contract at 3.4-A because job.py was
# frozen, and the two have since drifted: job.py answers 404 on a malformed
# uuid, roof.py answers 503 on the same input. That drift is the cost of the
# copy. One rule in one place is worth more than a naming convention — do not
# "fix" this import by copying the function here.
from routes.job import _get_company_job

import battery_optimiser
import capture
import generation
import interval_parser
import nem_data
import roof_geometry
import sizing_engine
import solar_optimiser

router = APIRouter()


class SizingRequest(BaseModel):
    bill_data: dict[str, Any]
    solar_data: dict[str, Any]
    budget: float
    wants_battery: bool
    occupancy: str


@router.post("/api/sizing/size")
async def size_system(body: SizingRequest):
    try:
        result = sizing_engine.size_system(
            bill_data=body.bill_data,
            solar_data=body.solar_data,
            budget=body.budget,
            wants_battery=body.wants_battery,
            occupancy=body.occupancy,
        )
        return result
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))


# ── D1: solar sizing optimiser (NEW; the heuristic above is retired later) ─────
class OptimiseRequest(BaseModel):
    job_id: Optional[str] = None
    # Roof (override, else loaded from roof_geometry by job_id)
    planes: Optional[list[dict]] = None
    candidate_configs: Optional[list[dict]] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    panel_id: Optional[str] = None
    panel_watts: Optional[float] = None
    # Load (explicit 8,760, else the job's TRUE Tier-3 series, else representative)
    load_hourly_8760: Optional[list[float]] = None
    # 3.7: when supplying load_hourly_8760, the CALLER states its provenance —
    # "tier3_actual" is honoured only when asserted; it is never inferred.
    load_source: Optional[Literal["tier3_actual", "representative"]] = None
    annual_kwh: Optional[float] = None
    hourly_profile_weights: Optional[list[float]] = None
    # Tariff / network
    import_rate: Optional[float] = None
    fit: Optional[float] = None
    export_limit_kw: Optional[float] = None
    postcode: Optional[str] = None
    state: Optional[str] = None
    installer_id: Optional[str] = None
    # Objective — None means "the caller did not choose", which is a DIFFERENT
    # fact from choosing max_npv. 3.9: _resolve_objective's top precedence rule
    # is "explicit request field wins", which cannot be written against a
    # non-None default. The documented defaults now live in the resolver.
    objective: Optional[str] = None
    custom_weight: Optional[float] = None
    budget: Optional[float] = None
    # Optional installer constraints (additive; absent/empty ⇒ behaves exactly as today)
    constraints: Optional[dict] = None


def _sb() -> Any:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception:
        return None


def _load_one(client: Any, table: str, job_id: str, cols: str) -> Optional[dict]:
    try:
        res = (
            client.table(table)
            .select(cols)
            .eq("job_id", job_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception:
        return None


# 3.11 (F93) — ONE roof reader, not two widened copies (2R.1). The literal
# column list exists exactly once in this file; verify_sizing_confidence.py
# asserts that as a source-text check. The five confidence-bearing names plus
# the row's own primary key are the only additions over the pre-3.11 list.
_ROOF_COLUMNS = (
    "roof_geometry_id,planes,candidate_configs,lat,lng,selected_panel,"
    "found,manual_entry_required,low_confidence,needs_manual_confirmation,flags,reason"
)


def _load_roof(client: Any, job_id: str) -> Optional[dict]:
    return _load_one(client, "roof_geometry", job_id, _ROOF_COLUMNS)


def _roof_confidence(roof: Optional[dict], flags: list[str]) -> dict:
    """The roof's confidence state, as one object used by BOTH the response and
    the persisted row — same dict by construction, so no gate has to compare
    the two (F93). Pure, no I/O, never raises.

    NULL vs FALSE IS A REAL DISTINCTION: False means "we read the roof and it
    was clean"; None means "we never read a roof row" (a stateless call with
    explicit planes). They are never collapsed — a result that never looked at
    a roof must not claim a clean one. roof_confidence_read is the one-boolean
    way to tell them apart.

    THERE IS DELIBERATELY NO CONFIRMATION FIELD HERE. D24 says 3.11 reads
    whether the installer CONFIRMED the roof — but roof_geometry has no such
    column today; checklist 3.4c builds it, and 3.4c runs AFTER this row
    (§J seq 12 vs seq 7). Inventing a roof_confirmed key now would create the
    second copy that drifts. roof_geometry_id is how the confirmation state is
    reached later: 3.15 joins the stored result back to the exact roof row it
    was sized from and reads the column 3.4c will add. One fact, one place.

    THE DOUBT TRAVELS; IT DOES NOT STOP THE WORK (D24, Mayur 2026-08-14): the
    caller appends flags from here but never gates on them.
    """
    if not isinstance(roof, dict):
        return {
            "roof_geometry_id": None,
            "roof_low_confidence": None,
            "roof_needs_manual_confirmation": None,
            "roof_flags": [],
            "roof_reason": None,
            "roof_confidence_read": False,
        }
    low = roof.get("low_confidence")
    needs = roof.get("needs_manual_confirmation")
    raw_flags = roof.get("flags")
    roof_flags: list[str] = []
    flags_unreadable = False
    if isinstance(raw_flags, list):
        for item in raw_flags:
            if isinstance(item, str):
                roof_flags.append(item)
            else:
                # Keep the readable part, drop the junk element, and say so —
                # never str() it into a fake warning.
                flags_unreadable = True
    elif raw_flags is not None:
        flags_unreadable = True
    if low is True:
        flags.append(
            "roof_flagged_before_sizing — the roof measurement was flagged for "
            "checking and was used as it stands, so this sizing is only as good "
            "as that roof"
        )
    if flags_unreadable:
        flags.append(
            "roof_flags_unreadable — the roof's own warning list could not be "
            "read, so this sizing may be missing a caution"
        )
    reason = roof.get("reason")
    return {
        "roof_geometry_id": roof.get("roof_geometry_id"),
        "roof_low_confidence": low if isinstance(low, bool) else None,
        "roof_needs_manual_confirmation": needs if isinstance(needs, bool) else None,
        "roof_flags": roof_flags,
        "roof_reason": reason if isinstance(reason, str) else None,
        "roof_confidence_read": True,
    }


def _fetch_panel(client: Any, panel_id: str) -> Optional[dict]:
    """Fetch a catalogue panel as {id, watts, area_m2} for a panel-model constraint."""
    if client is None or not panel_id:
        return None
    try:
        res = client.table("panels").select(
            "id,rated_power_w,length_mm,width_mm"
        ).eq("id", panel_id).limit(1).execute()
        if not res.data:
            return None
        r = res.data[0]
        length = float(r["length_mm"]) if r.get("length_mm") else None
        width = float(r["width_mm"]) if r.get("width_mm") else None
        watts = float(r["rated_power_w"]) if r.get("rated_power_w") else None
        if not length or not width or not watts:
            return None
        return {"id": r["id"], "watts": int(watts), "area_m2": round(length * width / 1_000_000.0, 4)}
    except Exception:
        return None


# ── 3.7 shared helpers: time base + the one load resolver ─────────────────────
def _time_base(state: Optional[str], flags: list[str]) -> tuple[Optional[float], dict]:
    """Resolve the site's UTC offset and emit the §4 time-base flags + metadata."""
    offset = nem_data.get_utc_offset_hours(state)
    if offset is None:
        shift = 0
        rounded = False
        flags.append(
            "generation_time_base_unrotated — state unknown, generation left in UTC — is_fallback"
        )
    else:
        shift = int(math.floor(float(offset) + 0.5))
        rounded = float(offset) != float(shift)
        if rounded:
            flags.append(
                f"generation_time_base_rounded_30min — {state} is UTC+9:30, rotated by {shift} h"
            )
    meta = {
        "convention": "local_standard",
        "utc_offset_hours_applied": shift,
        "state": state,
        "rounded_to_whole_hour": rounded,
    }
    return offset, meta


def _download_series(client: Any, ref: Any) -> Optional[dict]:
    """Download + parse a stored interval series document. None on ANY failure.

    `parsed_series_ref` carries the bucket name prefixed
    (bills/interval/<token>.series.json); Storage download wants the key
    WITHOUT the leading `bills/` — exactly one prefix is stripped."""
    if client is None or not isinstance(ref, str) or not ref:
        return None
    key = ref[len("bills/"):] if ref.startswith("bills/") else ref
    if not key:
        return None
    try:
        blob = client.storage.from_("bills").download(key)
        doc = json.loads(blob)
        return doc if isinstance(doc, dict) else None
    except Exception:  # noqa: BLE001 — a missing series is a downgrade, never an error
        return None


def _resolve_load(
    client: Any, body: Any, flags: list[str]
) -> tuple[Optional[list[float]], Optional[str], Optional[dict]]:
    """
    The ONE load resolver (3.7), used by both the solar and battery blocks.
    Returns (load_hourly, load_source, error_dict). Preference order:

      1. body.load_hourly_8760 — provenance is whatever the CALLER asserts via
         body.load_source ("tier3_actual" honoured, never inferred).
      2. The job's TRUE measured series: interval_data.parsed_series_ref →
         Storage download → interval_parser.series_to_8760. Success is
         "tier3_actual". ANY failure falls through — sizing is never blocked.
      3. Today's representative expansion (unchanged, incl. the existing
         missing-load error), which is still the Tier 1/2 path.
    """
    if body.load_hourly_8760:
        source = (
            "tier3_actual" if getattr(body, "load_source", None) == "tier3_actual"
            else "representative"
        )
        return body.load_hourly_8760, source, None

    if body.job_id and client is not None:
        row = _load_one(
            client, "interval_data", body.job_id, "parsed_series_ref,coverage_days"
        )
        if row and row.get("parsed_series_ref"):
            doc = _download_series(client, row.get("parsed_series_ref"))
            if doc is not None:
                built = interval_parser.series_to_8760(
                    doc.get("series_by_date"),
                    doc.get("average_day_kwh"),
                    doc.get("annual_kwh"),
                    annualised=bool(
                        (doc.get("coverage_days") or 0)
                        < interval_parser.ANNUALISED_THRESHOLD_DAYS
                    ),
                )
                hourly = built.get("hourly") or []
                if len(hourly) == solar_optimiser.HOURS and sum(hourly) > 0:
                    flags.append(
                        f"load_from_tier3_actual_series — {built['days_mapped']} "
                        "measured days mapped to the calendar year"
                    )
                    return hourly, "tier3_actual", None
            flags.append(
                "tier3_series_unreadable — fell back to the representative profile — is_fallback"
            )
        # A row with a null ref, or no row at all: representative, no error.

    annual_kwh = body.annual_kwh
    weights = body.hourly_profile_weights
    tier = None
    if (annual_kwh is None or weights is None) and body.job_id and client is not None:
        lp = _load_one(
            client, "load_profiles", body.job_id,
            "annual_kwh,daily_avg_kwh,hourly_profile_weights,accuracy_tier",
        )
        if lp:
            if annual_kwh is None:
                annual_kwh = lp.get("annual_kwh") or (
                    (lp.get("daily_avg_kwh") or 0) * 365 if lp.get("daily_avg_kwh") else None
                )
            if weights is None:
                weights = lp.get("hourly_profile_weights")
            tier = lp.get("accuracy_tier")
    if annual_kwh is None:
        return None, None, {
            "error": "No load profile available (pass load_hourly_8760 or annual_kwh+weights, or a job_id with a stored load profile).",
            "flags": ["missing_load"],
        }
    if tier == 3:
        # KEPT only here: the Tier-3 job whose true series was NOT used. Where
        # the series IS used this label would be the exact situation 3.7 ended.
        flags.append("load_from_tier3_representative_weights")
    load_hourly = solar_optimiser.expand_load_to_8760(float(annual_kwh), weights)
    flags.append("load_expanded_from_representative_profile")
    return load_hourly, "representative", None


def _read_tariff_row(client: Any, job_id: Optional[str], flags: list[str]) -> Optional[dict]:
    """The job's stored tariff envelope, or None. A read FAILURE (as opposed to
    absence) is flagged — the resolver then falls through to the bill/defaults;
    it never raises and never blocks sizing."""
    if not job_id or client is None:
        return None
    try:
        res = (
            client.table("tariffs")
            .select("tariff_type,supply_charge,tou_windows,import_rate,"
                    "fit_aud_per_kwh,export_limit_kw,source")
            .eq("job_id", job_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception:  # noqa: BLE001
        flags.append("stored tariff could not be read — fell back to bill/defaults — is_fallback")
        return None


def _resolve_tariff(
    client: Any, body: Any, state: Optional[str], postcode: Optional[str],
    flags: list[str],
) -> dict:
    """
    THE ONE tariff resolver (3.8), used by both sizing endpoints — the 3.7
    _resolve_load pattern. Resolution order, most specific first, per FIELD:

      1. explicit request fields (import_rates_24, tou_windows, import_rate,
         fit, export_limit_kw)
      2. the job's stored tariffs row (the envelope this row exists to hold)
      3. the job's newest bill (parsed_json.tariff_structured, .tariff_rate,
         bills.feed_in_tariff) — exactly the reads the endpoints did before
      4. defaults: DEFAULT_IMPORT_RATE, get_default_fit, get_export_limit —
         every one flagged is_fallback

    THE NO-REGRESSION RULE: on a job with NO tariffs row, import_rate, fit,
    fit_is_fallback, export_limit_kw and export_meta are IDENTICAL to what the
    endpoints computed before 3.8. import_rate is the bill's SCALAR
    tariff_rate, never sum(rate_24)/24 — the solar numbers must not move.

    TOU windows are LOCAL CLOCK HOURS and are never rotated, offset or
    converted — generation is the only rotated series (3.7), and that happens
    nowhere near this function.
    """
    import_rate = body.import_rate
    fit = body.fit
    explicit_windows = bool(getattr(body, "import_rates_24", None)) or bool(
        getattr(body, "tou_windows", None)
    )
    # 3.13 prompt 4b: `source` was ONE flag assigned only when the SCALAR
    # import rate resolved, and every assumptions row borrowed it — so a job
    # with stored TOU windows and no scalar read "default" against the
    # installer's own typed rates (the third occurrence of this hole; the
    # supply charge fell into it at prompt 2). Each value now carries its own
    # provenance, set AT THE POINT THAT VALUE IS ACTUALLY READ, never
    # inferred from another. `source` is RENAMED to import_rate_source in the
    # return rather than kept beside it, so no second copy can drift.
    source: Optional[str] = (
        "request" if (import_rate is not None or explicit_windows) else None
    )
    fit_source: Optional[str] = "request" if fit is not None else None

    stored = _read_tariff_row(client, body.job_id, flags)
    tariff_type = stored.get("tariff_type") if stored else None
    tariff_type_source = "installer" if tariff_type is not None else "not stated"
    supply_charge = stored.get("supply_charge") if stored else None
    # 3.13 prompt 2 (G): the supply charge's OWN provenance, tracked where the
    # charge itself is read — the fit_is_fallback pattern, never inferred from
    # `source`, which is only ever assigned when the IMPORT RATE resolves.
    # Prompt 1 borrowed `source` and the fixture job answered "default" about
    # a number the installer typed.
    supply_charge_source = "installer" if supply_charge is not None else "not stated"
    stored_windows = None
    if stored and isinstance(stored.get("tou_windows"), list) and stored["tou_windows"]:
        stored_windows = stored["tou_windows"]

    if import_rate is None and stored and stored.get("import_rate") is not None:
        try:
            import_rate = float(stored["import_rate"])
            source = source or (stored.get("source") or "installer")
        except (TypeError, ValueError):
            pass
    if fit is None and stored and stored.get("fit_aud_per_kwh") is not None:
        try:
            fit = float(stored["fit_aud_per_kwh"])
            fit_source = "installer"
        except (TypeError, ValueError):
            pass
    export_limit_kw = body.export_limit_kw
    export_given: Optional[str] = "request" if export_limit_kw is not None else None
    if export_limit_kw is None and stored and stored.get("export_limit_kw") is not None:
        try:
            export_limit_kw = float(stored["export_limit_kw"])
            export_given = "installer"
        except (TypeError, ValueError):
            pass

    structured: Optional[dict] = None
    if (
        (import_rate is None or fit is None
         or (not explicit_windows and stored_windows is None))
        and body.job_id and client is not None
    ):
        bill = _load_one(client, "bills", body.job_id, "parsed_json,feed_in_tariff")
        if bill:
            pj = bill.get("parsed_json") or {}
            structured = (
                pj.get("tariff_structured")
                if isinstance(pj.get("tariff_structured"), dict) else None
            )
            if tariff_type is None and structured:
                tariff_type = structured.get("tariff_type")
                if tariff_type is not None:
                    tariff_type_source = "bill"
            if supply_charge is None and structured:
                supply_charge = structured.get("supply_charge")
                if supply_charge is not None:
                    supply_charge_source = "bill"
            if import_rate is None and pj.get("tariff_rate") is not None:
                import_rate = float(pj["tariff_rate"])
                source = source or "bill"
            if fit is None:
                bf = bill.get("feed_in_tariff")
                if bf is None:
                    bf = pj.get("feed_in_tariff")
                if bf is not None:
                    fit = float(bf)
                    fit_source = "bill"

    # 3.12: the scalar still RESOLVES (it is reported in assumptions and is
    # the flat rate _build_rate_24 fills uncovered hours with), but the
    # fallback FLAG moved below the rate_24 build — it fires only when the
    # defaulted scalar actually priced at least one hour. A fallback flag that
    # fires when the fallback had no effect is noise that trains installers to
    # ignore flags (observed live: it fired on a job whose 24 hours were all
    # window-covered).
    scalar_defaulted = import_rate is None
    if scalar_defaulted:
        import_rate = solar_optimiser.DEFAULT_IMPORT_RATE
        source = source or "default"
    if source is None:
        source = "default"

    fit_is_fallback = False
    if fit is None:
        fd = nem_data.get_default_fit(state)
        fit = fd["fit_aud_per_kwh"]
        fit_is_fallback = True
        fit_source = "default"
        flags.append(f"fit fallback {fit}/kWh ({fd.get('scheme')}) — is_fallback")

    if export_given is not None and export_limit_kw is not None:
        export_meta: dict = {"export_limit_kw": float(export_limit_kw),
                             "source": export_given}
        export_limit_kw = float(export_limit_kw)
    else:
        export_meta = nem_data.get_export_limit(state=state, postcode=postcode)
        export_limit_kw = export_meta["export_limit_kw"]
        if export_meta.get("is_default"):
            flags.append("export_limit defaulted (state/postcode not recognised)")

    windows_for_rate = getattr(body, "tou_windows", None) or stored_windows
    # 3.13 prompt 4b: the hourly vector's OWN provenance — where the thing
    # that will price the hours was read, tracked before the build so the
    # build stays a pure converter.
    if explicit_windows:
        vector_origin: Optional[str] = "request"
    elif stored_windows is not None:
        vector_origin = "installer"
    elif structured and structured.get("tou_windows"):
        vector_origin = "bill"
    else:
        vector_origin = None
    n_flags_before = len(flags)
    rate_24, is_tou = _build_rate_24(
        getattr(body, "import_rates_24", None), windows_for_rate, structured,
        float(import_rate), flags,
    )
    # The defaulted scalar REACHED rate_24 iff the tariff came out flat, or
    # the window build filled at least one uncovered hour with it (the exact
    # gap-fill flag, matched from this call's own additions).
    if scalar_defaulted and (
        not is_tou or _FLAG_GAPS in flags[n_flags_before:]
    ):
        flags.append(
            f"import_rate fallback ${import_rate:.2f}/kWh (no bill rate) — is_fallback"
        )
    # The vector's source: windows built it -> their origin; a flat vector is
    # the scalar tiled, so it carries the SCALAR's own source — "default" only
    # when the documented fallback itself priced the hours. A windows build
    # gap-filled by the default keeps the windows' origin (the gap-fill flag
    # above already names the fallback's part).
    if is_tou and vector_origin is not None:
        rate_24_source = vector_origin
    else:
        rate_24_source = source

    return {
        "import_rate": float(import_rate),
        "rate_24": rate_24,
        "is_tou": is_tou,
        "fit": float(fit),
        "fit_is_fallback": fit_is_fallback,
        "export_limit_kw": float(export_limit_kw),
        "export_meta": export_meta,
        "tariff_type": tariff_type,
        "tariff_type_source": tariff_type_source,
        "supply_charge": supply_charge,
        "supply_charge_source": supply_charge_source,
        # 3.13 prompt 4b: `source` RENAMED — this is what it always genuinely
        # meant, the SCALAR import rate's provenance. The vector and the fit
        # carry their own.
        "import_rate_source": source,
        "rate_24_source": rate_24_source,
        "fit_source": fit_source,
        # 3.12: flat_rate_for_solar is GONE. It was sum(rate_24)/24, the
        # battery endpoint's private third meaning of "the import rate", and
        # the solar optimiser now takes rate_24 itself — the averaged copy has
        # no consumer and keeping it would be keeping the drift (2R.1).
    }


def _read_job_objective(client: Any, job_id: Optional[str], flags: list[str]) -> Optional[dict]:
    """The job's stored optimisation inputs, or None. Mirrors _read_tariff_row:
    a read FAILURE (a different fact from absence) is flagged and the resolver
    falls through to the defaults — it never raises and never blocks sizing."""
    if not job_id or client is None:
        return None
    try:
        res = (
            client.table("jobs")
            .select("objective,custom_weight,budget_aud")
            .eq("job_id", job_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception:  # noqa: BLE001
        flags.append("stored objective could not be read — sized with the defaults — is_fallback")
        return None


def _objective_num(value: Any) -> Optional[float]:
    """A finite number or None — never a bool, never NaN/inf, never a raise.
    The same coercion rule tariffNum/_num use elsewhere: a number, or a numeric
    string, or nothing."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            f = float(value)
        except ValueError:
            return None
    else:
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _resolve_objective(client: Any, body: Any, flags: list[str]) -> dict:
    """ONE resolver for the optimisation inputs, read by BOTH sizing endpoints.

    Returns {"objective": str, "custom_weight": float, "budget": Optional[float]}.
    Precedence per field, most specific first (the _resolve_tariff /
    _resolve_load pattern):
      1. the explicit request field, when not None
      2. the job's stored jobs row (objective / custom_weight / budget_aud)
      3. the documented defaults: "max_npv", 0.5, None (no cap)

    NO-REGRESSION: on a job with no stored objective, and on any request that
    supplies one explicitly, all three resolved values are IDENTICAL to what
    the endpoints used before 3.9 — the solar and battery numbers do not move.

    A STORED objective outside VALID_OBJECTIVES (reachable only by a raw DB
    edit — the PATCH Literal guards the write) falls back to max_npv with a
    loud flag, never an error: sizing is not blocked by a data quirk (D24). An
    objective supplied in the REQUEST passes through untouched — the endpoint's
    own validity check stays the loud path for caller mistakes.

    KNOWN LIMITATION, deliberate and pinned by the gate (5c): `budget` arrives
    as None both when the caller omitted it and when the caller means "no
    cap", so a None request budget resolves to the STORED cap when one exists.
    A caller wanting a genuinely uncapped run on a job that stores a cap
    cannot express that today. 3.11 is the only caller and passes through;
    changing this later must be a deliberate change, not a drive-by.
    """
    job_id = getattr(body, "job_id", None)
    stored = _read_job_objective(client, job_id, flags) or {}

    objective = getattr(body, "objective", None)
    if objective is None:
        stored_obj = stored.get("objective")
        if isinstance(stored_obj, str) and stored_obj in solar_optimiser.VALID_OBJECTIVES:
            objective = stored_obj
        else:
            if stored_obj:
                flags.append(
                    f"stored objective {stored_obj!r} is not one the engine knows — "
                    "sized for maximum NPV instead"
                )
            elif job_id:
                # A job was named and nobody has chosen — say so, so an
                # installer reading the flags learns the objective was
                # nobody's decision. A stateless call (no job_id) appends
                # nothing: a caller supplying nothing is the API working,
                # not a fallback.
                flags.append(
                    "no objective chosen for this job — sized for maximum NPV (the default)"
                )
            objective = "max_npv"

    custom_weight = getattr(body, "custom_weight", None)
    if custom_weight is None:
        raw = stored.get("custom_weight")
        num = _objective_num(raw)
        if num is not None and 0.0 <= num <= 1.0:
            custom_weight = num
        else:
            if raw is not None:
                flags.append(
                    "stored custom_weight could not be read as a 0..1 number — "
                    "used the engine default 0.5"
                )
            custom_weight = 0.5
    else:
        custom_weight = float(custom_weight)

    budget = getattr(body, "budget", None)
    if budget is None:
        raw = stored.get("budget_aud")
        num = _objective_num(raw)
        if num is not None and num > 0:
            budget = num
        elif raw is not None:
            # An unreadable cap must never become a cap of ZERO — that would
            # return the cheapest possible system and look like a considered
            # answer. Unreadable = NO cap, flagged.
            flags.append(
                "stored budget could not be read as a positive dollar amount — "
                "sized with no cap"
            )
    return {"objective": objective, "custom_weight": custom_weight, "budget": budget}


def _annual_supply_charge(
    tariff: dict, flags: list[str]
) -> tuple[Optional[float], str]:
    """3.13: ONE expression for the annual supply charge, used by BOTH sizing
    endpoints. tariffs.supply_charge is dollars PER DAY (the frontend's own
    bound message: "The supply charge must be between 0 and 20 $/day");
    365 is the same non-leap year the declared hour convention uses
    (HOURS = 8760). Returns (annual_or_None, source_string).

    A charge that is NULL, absent, negative, NaN or unparseable is None — a
    missing charge is a DIFFERENT fact from a zero charge, so it is never
    defaulted to 0; the omission is flagged rather than silent, and the run
    completes normally with energy-only bill figures.

    3.13 prompt 2 (G): the source is the resolver's supply_charge_source —
    the charge's OWN provenance — never `source`, which names where the
    IMPORT RATE came from and said "default" about an installer-typed charge."""
    daily = _objective_num(tariff.get("supply_charge"))
    if daily is not None and daily >= 0:
        return daily * 365, str(tariff.get("supply_charge_source") or "not stated")
    flags.append(
        "supply_charge_unknown — the bill figures below cover energy only, "
        "not the daily supply charge"
    )
    return None, "not stated"


def _payback_years(capex: Any, savings: Any) -> Optional[float]:
    """3.13 prompt 2: simple payback for the composed whole system. None when
    the savings are zero or negative — never a negative payback, never an
    infinity, never a division by zero. A None input yields None: a missing
    figure is a different fact from a zero figure."""
    if not isinstance(capex, (int, float)) or isinstance(capex, bool):
        return None
    if not isinstance(savings, (int, float)) or isinstance(savings, bool):
        return None
    if savings <= 0:
        return None
    return round(capex / savings, 2)


def _set_quoted_value(client: Any, job_id: str, company_id: str, value: Any) -> bool:
    """3.13 prompt 2: the job's MODELLED quote value — the same net cost the
    financial result stores as system_capex. Company-scoped exactly like the
    two update sites routes/job.py already has (the service role bypasses RLS,
    so the .eq('company_id', ...) filter IS the protection). Direct update,
    never capture.save_job: that writer UPSERTS, and an upsert with a two-key
    payload against a live customer table is not a risk this takes.

    DELIBERATELY DOES NOT SET updated_at: nothing on jobs has a trigger, so
    updated_at moves only when a writer sets it — and the won-this-month KPI
    counts a won job by its updated_at. Bumping it from a sizing run would
    move a job that was won in March into this month's won figure. Sizing is
    not winning.

    Returns True only when the update matched a row. Never raises."""
    try:
        resp = (
            client.table("jobs")
            .update({"quoted_value_aud": value})
            .eq("job_id", job_id)
            .eq("company_id", company_id)
            .execute()
        )
        return bool(getattr(resp, "data", None))
    except Exception:  # noqa: BLE001 — a stale KPI is recoverable; a 500 is not
        return False


def _persist_financial_and_quote(
    client: Any, caller: Any, job_id: str, sid: Any, payload: dict,
    flags: list[str],
) -> bool:
    """3.13 prompt 2: persist the financial result linked to the sizing row
    just written, then set the job's modelled quote value from the SAME
    system_capex. Returns financial_persisted. Never raises, never blocks.

    ORDER IS DELIBERATE, both gates on purpose:
      1. No financial row without a REAL sizing_result_id — an unlinked
         financial row is worse than no row, because the Results section's
         rule is "a financial result for the CURRENT sizing result". A falsy
         sid writes nothing and adds NO second alarm (the existing
         sizing_result_not_persisted flag already names the one cause). A
         non-UUID sid also writes nothing: sizing_result_id is a uuid FK, so
         the insert is guaranteed to fail at the database — and every gate
         that fakes the sizing writer with a recorder returns a non-UUID id,
         which is what keeps a monkey-patched gate run from ever reaching the
         live tables through this path.
      2. No quote value without its stored financial row — quoted_value_aud
         mirrors a figure whose source of record is the financial_results
         row; setting the KPI when the row failed to store would put a number
         on the dashboard that nothing stored can explain.

    roi_percent is NULL PERMANENTLY — settled by D34 (2026-08-20). Return on
    investment has three definitions — annual return on cost, discounted
    return, and total 25-year return — and on the one real fixture they are
    29%, 269% and about 600% for the IDENTICAL system. The platform shows
    none of them by default, and when an installer turns them on it shows ALL
    THREE together, never one alone: a control that picks the largest of
    three is a persuasion lever. All three are DERIVED AT RENDER from
    system_capex, annual_savings and npv_25_year, which are stored beside
    this column — storing a fourth number would be a second copy of figures
    already present, the drift this codebase deletes rather than gates. The
    column is deliberately never populated. Do not invent a definition."""
    if not sid:
        return False
    try:
        uuid.UUID(str(sid))
    except (ValueError, AttributeError, TypeError):
        flags.append("financial_result_not_persisted")
        return False
    financial_persisted = False
    try:
        fid = capture.save_financial_result({
            **payload,
            "job_id": job_id,
            "sizing_result_id": sid,
            # NULL permanently — D34 (2026-08-20): the three ROI definitions
            # are derived at render from the three columns beside this one;
            # see this helper's docstring.
            "roi_percent": None,
            "pricing_basis": "modelled",
        })
        financial_persisted = bool(fid)
    except Exception as exc:  # noqa: BLE001 — never block the response
        sentry_sdk.capture_exception(exc)
    if not financial_persisted:
        flags.append("financial_result_not_persisted")
        return False
    if not _set_quoted_value(client, job_id, caller.company_id,
                             payload.get("system_capex")):
        flags.append("quote_value_not_updated")
    return True


@router.post("/api/sizing/optimise")
async def optimise_sizing(
    body: OptimiseRequest, caller: Caller = Depends(require_company)
):
    try:
        flags: list[str] = []
        client = _sb()
        # 3.11b — OWNERSHIP BEFORE ANY READ OF THE JOB'S STORED STATE. A
        # foreign job and an absent job raise the SAME 404 here (existence
        # never leaks), a transport failure raises 503, and both propagate as
        # HTTP statuses — never translated into a 200 body, because the proxy
        # passes status through. Running before _resolve_objective means 404
        # always wins over invalid-objective. client None = local dev with no
        # Supabase: nothing to own and nothing to leak — do not "harden" this
        # skip into a 500 that breaks local development.
        if body.job_id and client is not None:
            _get_company_job(client, body.job_id, caller.company_id)
        # 3.11b — the installer identity comes from the LOGIN, never the body
        # (the routes/job.py:610 precedent). An attempted assertion is visible,
        # not silently ignored (F161).
        if (isinstance(body.installer_id, str) and body.installer_id
                and body.installer_id != caller.user_id):
            flags.append(
                "installer_identity_from_login — this sizing used the pricing "
                "of the person signed in, not the installer named in the request"
            )
        # 3.9 — the ONE resolver, called BEFORE the roof block. Ordering is
        # part of the contract: an invalid objective must keep erroring ahead
        # of the "no roof geometry" error, so the validity check operates on
        # the RESOLVED objective right here.
        resolved = _resolve_objective(client, body, flags)
        objective = resolved["objective"]
        custom_weight = resolved["custom_weight"]
        budget = resolved["budget"]
        if objective not in solar_optimiser.VALID_OBJECTIVES:
            return {"error": f"invalid objective '{objective}'", "valid": sorted(solar_optimiser.VALID_OBJECTIVES)}

        planes = body.planes
        candidate_configs = body.candidate_configs
        lat, lon = body.lat, body.lon
        panel = {"id": body.panel_id, "watts": body.panel_watts} if body.panel_id else None
        postcode, state = body.postcode, body.state

        # ── Resolve the roof model ──
        roof = None
        if (planes is None or candidate_configs is None) and body.job_id and client is not None:
            roof = _load_roof(client, body.job_id)
            if roof is None:
                return {"needs_roof_input": True, "flags": ["no_roof_geometry_for_job"],
                        "error": "No roof geometry stored for this job — run /api/roof/geometry first or pass planes."}
            if not roof.get("found") or roof.get("manual_entry_required"):
                return {"needs_roof_input": True, "flags": ["manual_entry_required"],
                        "error": "Roof not found by imagery — manual plane entry required before sizing."}
            if planes is None:
                planes = roof.get("planes") or []
            if candidate_configs is None:
                candidate_configs = roof.get("candidate_configs") or []
            if lat is None:
                lat = roof.get("lat")
            if lon is None:
                lon = roof.get("lng")
            if panel is None and roof.get("selected_panel"):
                sp = roof["selected_panel"]
                panel = {"id": sp.get("id"), "watts": sp.get("watts")}

        if not planes or candidate_configs is None:
            return {"needs_roof_input": True, "flags": ["missing_roof"],
                    "error": "No roof planes / candidate configs supplied (pass them or a job_id with stored roof geometry)."}
        if lat is None or lon is None:
            return {"error": "lat/lon required (pass directly or via a job_id with geocoded roof geometry).",
                    "flags": ["missing_latlon"]}
        if panel is None:
            return {"error": "panel_id (or job roof selected_panel) required to price + size.",
                    "flags": ["missing_panel"]}

        # ── Resolve postcode/state from the job if needed ──
        if (postcode is None or state is None) and body.job_id and client is not None:
            jobrow = _load_one(client, "jobs", body.job_id, "site_postcode,site_state")
            if jobrow:
                postcode = postcode or jobrow.get("site_postcode")
                state = state or jobrow.get("site_state")
        if state is None and postcode is not None:
            state = nem_data.postcode_to_state(postcode)

        # ── 3.7: one declared time base — resolve the offset ONCE, here, right
        # after the state, because the optimise() call below needs it. ──
        utc_offset, time_base_meta = _time_base(state, flags)

        # ── Resolve the load profile (3.7: the ONE resolver — true series first) ──
        load_hourly, load_source, load_error = _resolve_load(client, body, flags)
        if load_error is not None:
            return load_error
        if len(load_hourly) != solar_optimiser.HOURS:
            return {"error": f"load profile must be {solar_optimiser.HOURS} hourly values (got {len(load_hourly)}).",
                    "flags": ["bad_load_length"]}

        # ── Tariff + export limit: the ONE resolver (3.8). 3.12: the solar
        # optimiser now takes rate_24 — the SAME hour-by-hour vector the
        # battery LP dispatches against — so self-consumed solar is valued at
        # the rate of the hour it was consumed. The scalar import_rate remains
        # only as reporting (assumptions). ──
        tariff = _resolve_tariff(client, body, state, postcode, flags)
        import_rate = tariff["import_rate"]
        rate_24 = tariff["rate_24"]
        fit = tariff["fit"]
        fit_is_fallback = tariff["fit_is_fallback"]
        export_limit_kw = tariff["export_limit_kw"]
        export_meta = tariff["export_meta"]

        # ── 3.13: the annual supply charge, computed ONCE from the resolver's
        # own per-day value and passed into every optimise() call below. ──
        supply_charge_annual, supply_charge_source = _annual_supply_charge(tariff, flags)

        # ── Financial params ──
        fin = solar_optimiser.load_financial_params(flags)

        def _run(planes_, configs_, panel_, constraints_, flags_):
            return solar_optimiser.optimise(
                roof_planes=planes_, candidate_configs=configs_, lat=float(lat), lon=float(lon),
                utc_offset_hours=utc_offset,
                panel=panel_, load_hourly=load_hourly, rate_24=rate_24, fit=float(fit),
                export_limit_kw=float(export_limit_kw), objective=objective, fin=fin,
                postcode=postcode, state=state, installer_id=caller.user_id,
                custom_weight=custom_weight,
                budget=budget, constraints=constraints_, flags=flags_,
                supply_charge_annual=supply_charge_annual,
            )

        # ── Resolve solar constraints (panel-model re-scale is LOCAL — no Google call) ──
        constraints = body.constraints or {}
        con_planes, con_configs, con_panel = planes, candidate_configs, panel
        panel_constraint_active = False
        if constraints.get("panel_id"):
            prow = _fetch_panel(client, constraints["panel_id"])
            if prow:
                con_panel = prow
                rescaled = roof_geometry.rescale_planes_for_panel(planes, con_panel)
                con_planes, con_configs = rescaled["planes"], rescaled["candidate_configs"]
                flags.extend(rescaled.get("flags", []))
                panel_constraint_active = True
            else:
                flags.append(f"constraint panel_id {constraints['panel_id']} not found — ignored.")
        if constraints.get("inverter_id"):
            flags.append(f"inverter_id {constraints['inverter_id']} applied at cost-model level only (Phase 1).")

        solar_constraints_active = bool(
            panel_constraint_active
            or constraints.get("fix_panel_count") is not None
            or constraints.get("fix_solar_kwp") is not None
            or constraints.get("inverter_id")
        )

        if not solar_constraints_active:
            result = _run(planes, candidate_configs, panel, None, flags)
            opt = result["optimal"]
            unconstrained_optimum = None
            constraint_deltas = None
            score_curve = result["score_curve"]
            constraints_applied = {}
        else:
            con_constraints = {
                "fix_panel_count": constraints.get("fix_panel_count"),
                "fix_solar_kwp": constraints.get("fix_solar_kwp"),
                "inverter_id": constraints.get("inverter_id"),
            }
            unconstrained_run = _run(planes, candidate_configs, panel, None, [])  # throwaway flags
            result = _run(con_planes, con_configs, con_panel, con_constraints, flags)
            opt = result["optimal"]
            unconstrained_optimum = unconstrained_run["optimal"]
            u = unconstrained_optimum
            constraint_deltas = {
                "solar_kw": round(opt["solar_kw"] - u["solar_kw"], 3),
                "npv_25yr": round(opt["npv_25yr"] - u["npv_25yr"], 2),
                "simple_payback_years": (
                    round(opt["simple_payback_years"] - u["simple_payback_years"], 2)
                    if opt["simple_payback_years"] is not None and u["simple_payback_years"] is not None else None
                ),
                "self_sufficiency_pct": round(opt["self_sufficiency_pct"] - u["self_sufficiency_pct"], 2),
                "system_cost": round(opt["system_cost"] - u["system_cost"], 2),
            }
            score_curve = result["score_curve"]
            constraints_applied = {
                "panel_id": con_panel.get("id") if panel_constraint_active else None,
                "inverter_id": constraints.get("inverter_id"),
                "fix_solar_kwp": constraints.get("fix_solar_kwp"),
                "fix_panel_count": constraints.get("fix_panel_count"),
            }

        # 3.11 — the roof's confidence state, built ONCE and used by BOTH the
        # persisted row and the response (same dict by construction).
        roof_conf = _roof_confidence(roof, flags)

        # 3.13 prompt 4: the assumptions block, built ONCE — the SAME object
        # goes into the response and into the persisted run_assumptions, so
        # no gate ever has to compare two copies and they cannot drift.
        assumptions = {
            "engine_version": solar_optimiser.ENGINE_VERSION,
            "import_rate": import_rate,
            "import_rate_source": tariff["import_rate_source"],
            "rate_24_source": tariff["rate_24_source"],
            "tariff_type": tariff["tariff_type"],
            "tariff_type_source": tariff["tariff_type_source"],
            "supply_charge_annual": supply_charge_annual,
            "supply_charge_source": supply_charge_source,
            "fit": fit,
            "fit_source": tariff["fit_source"],
            "fit_is_fallback": fit_is_fallback,
            "export_limit_kw": export_limit_kw,
            "export_limit_source": export_meta,
            "performance_ratio_non_temp": fin["performance_ratio_non_temp"],
            "temperature_derating_applied": False,
            "discount_rate": fin["discount_rate"],
            "analysis_years": fin["analysis_years"],
            "degradation_annual_pct": fin["degradation_annual_pct"],
            "tariff_escalation_pct": fin["tariff_escalation_pct"],
            "panel": con_panel if solar_constraints_active else panel,
            "total_load_kwh": round(sum(load_hourly), 1),
            "n_configs_evaluated": result["n_configs_evaluated"],
            "cache_hits": result["cache_hits"],
            "cache_misses": result["cache_misses"],
            "custom_weight": custom_weight if objective == "custom" else None,
            "constraints_applied": constraints_applied,
        }

        # ── Persist the CONSTRAINED (chosen) result to sizing_results (capture) ──
        # system_cost is THE TOTAL UP-FRONT NET COST OF EVERYTHING THIS ROW
        # RECOMMENDS — a run_kind='solar' row recommends solar only, so this is
        # the solar system's cost. The battery writer satisfies the same
        # sentence for its solar+battery recommendation; run_kind says which.
        persisted = False
        financial_persisted = False
        if body.job_id:
            sid = None
            try:
                sid = capture.save_sizing_result(
                    {
                        "job_id": body.job_id,
                        "solar_kw": opt["solar_kw"],
                        # 3.11 (F134's shape): a solar-only run has NO battery
                        # sized — null, never 0. The worksheet's Battery
                        # section completes on battery_kwh != null, so 0 would
                        # tick it complete and show "0 kWh" with no battery
                        # ever sized.
                        "battery_kwh": None,
                        "self_consumption_ratio": round(opt["self_consumption_pct"] / 100.0, 4),
                        "system_cost": opt["system_cost"],
                        "annual_solar_generation_kwh": opt["annual_generation_kwh"],
                        "within_budget": opt.get("within_budget", True),
                        "engine_version": solar_optimiser.ENGINE_VERSION,
                        "objective_used": objective,
                        "roof_geometry_id": roof_conf["roof_geometry_id"],
                        "roof_low_confidence": roof_conf["roof_low_confidence"],
                        "roof_needs_manual_confirmation": roof_conf["roof_needs_manual_confirmation"],
                        "roof_flags": roof_conf["roof_flags"],
                        "roof_reason": roof_conf["roof_reason"],
                        # 3.11b — the run log. This run covered solar only,
                        # produced by the sequential engine. evaluated_options
                        # stores what the endpoint already computed, VERBATIM
                        # (never re-derived, re-sorted or re-rounded);
                        # dimension_keys names which keys of each point are
                        # CHOICES rather than outcomes (D33 part ii — a
                        # combined engine sets ["solar_kw", "battery_id"]
                        # with no migration).
                        "run_kind": "solar",
                        "engine_mode": "sequential",
                        # 3.13 prompt 4: the SAME assumptions object the
                        # response carries, verbatim.
                        "run_assumptions": assumptions,
                        "evaluated_options": {
                            "dimension_keys": ["solar_kw"],
                            "points": score_curve,
                            # 3.13: which point won, and its itemised cost —
                            # stored VERBATIM (never re-derived, re-sorted or
                            # re-rounded), so the Results screen can read a
                            # stored run without re-running the engine.
                            "chosen_index": result.get("chosen_index"),
                            "chosen_cost_breakdown": opt.get("cost_breakdown"),
                            # 3.13 prompt 3 (F191): a solar-only run performs
                            # no dispatch at all — the key is present as None
                            # so that absence is a RECORDED fact, not an
                            # omission a later reader has to guess at.
                            "dispatch_resolution": None,
                        },
                    }
                )
                persisted = bool(sid)
            except Exception as exc:  # noqa: BLE001 — never block the response
                sentry_sdk.capture_exception(exc)
            if not persisted:
                flags.append("sizing_result_not_persisted")
            # 3.13 prompt 2 (B): the matching financial result, linked by
            # sizing_result_id, plus the job's modelled quote value. Every
            # figure is READ from the optimal dict — nothing is recomputed;
            # annual_bill_reduction is the one derived value and it is a
            # subtraction of two keys in the same dict.
            financial_persisted = _persist_financial_and_quote(
                client, caller, body.job_id, sid,
                {
                    "system_capex": opt["system_cost"],
                    "annual_savings": opt["annual_savings"],
                    "current_annual_spend": opt["annual_bill_before"],
                    "projected_annual_spend": opt["annual_bill_after"],
                    "annual_bill_reduction": (
                        round(opt["annual_bill_before"] - opt["annual_bill_after"], 2)
                        if opt.get("annual_bill_before") is not None
                        and opt.get("annual_bill_after") is not None else None
                    ),
                    "payback_years": opt["simple_payback_years"],
                    "npv_25_year": opt["npv_25yr"],
                    # 3.13 prompt 4c (D34): the real savings curve, undiscounted.
                    "undiscounted_savings_25yr": opt.get("undiscounted_savings_25yr"),
                },
                flags,
            )

        return {
            "objective": result["objective"],
            "load_source": load_source,
            "time_base": time_base_meta,
            "roof_confidence": roof_conf,
            "optimal": opt,
            "unconstrained_optimum": unconstrained_optimum,
            "constraint_deltas": constraint_deltas,
            "score_curve": score_curve,
            "cost_breakdown": opt.get("cost_breakdown"),
            "chosen_index": result.get("chosen_index"),
            # 3.13 prompt 4: the same object persisted as run_assumptions.
            "assumptions": assumptions,
            "failed_planes": result["failed_planes"],
            "persisted": persisted,
            "financial_persisted": financial_persisted,
            "flags": flags,
        }
    except HTTPException:
        # 3.11b — an authorisation refusal (404 foreign/absent, 503 transport,
        # 401/403 from auth) is an HTTP STATUS, never a 200 with a message:
        # the prompt-2 proxy passes status through, and translating it here
        # would turn "not yours" into "engine error". Re-raised, not caught.
        raise
    except Exception as e:  # noqa: BLE001 — never crash the app
        sentry_sdk.capture_exception(e)
        return {"error": "Internal error in the sizing optimiser.", "flags": ["internal_error"]}


# ── Battery sizing optimiser (LP dispatch) ─────────────────────────────────────
class BatteryRequest(BaseModel):
    job_id: Optional[str] = None
    # Roof / solar (override, else loaded from roof_geometry by job_id)
    planes: Optional[list[dict]] = None
    candidate_configs: Optional[list[dict]] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    panel_id: Optional[str] = None
    panel_watts: Optional[float] = None
    # Load
    load_hourly_8760: Optional[list[float]] = None
    load_source: Optional[Literal["tier3_actual", "representative"]] = None
    annual_kwh: Optional[float] = None
    hourly_profile_weights: Optional[list[float]] = None
    # Tariff (TOU-aware): explicit 24-h rates, or TOU windows, else flat import_rate
    import_rates_24: Optional[list[float]] = None
    tou_windows: Optional[list[dict]] = None
    import_rate: Optional[float] = None
    fit: Optional[float] = None
    export_limit_kw: Optional[float] = None
    postcode: Optional[str] = None
    state: Optional[str] = None
    installer_id: Optional[str] = None
    # Candidates / objective
    battery_ids: Optional[list[str]] = None
    # None = "the caller did not choose" — see OptimiseRequest; resolved by
    # _resolve_objective (3.9).
    objective: Optional[str] = None
    custom_weight: Optional[float] = None
    budget: Optional[float] = None
    # 3.13 prompt 2b (D35): the full-year dispatch is the default. The
    # representative-day shortcut stays callable but nothing selects it
    # automatically — no timeout, no size threshold, no retry downgrade.
    resolution: str = "full_year"
    # Optional installer constraints (additive; absent/empty ⇒ behaves exactly as today)
    constraints: Optional[dict] = None


def _window_hour(value: Any) -> Optional[int]:
    """Coerce a TOU window time to an integer hour. None = unreadable; NEVER raises.

    Accepts int/float, "6"/"06"/"6.0", and the parser's canonical "HH:MM"
    ("24:00" -> 24, preserved deliberately: 24 %% 24 == 0 drives the wrap branch
    that turns the parser's flat 00:00-24:00 window into all 24 hours). Minutes
    are DISCARDED — rate_24 has one slot per hour — and the caller flags any
    non-zero minutes rather than dropping them silently."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return int(value)
        except (ValueError, OverflowError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if ":" in text:
            try:
                return int(text.split(":", 1)[0])
            except ValueError:
                return None
        try:
            return int(float(text))
        except (ValueError, OverflowError):
            return None
    return None


# One definition of the gap-fill sentence: _build_rate_24 emits it and
# _resolve_tariff's fallback-flag condition matches on it (3.12). A literal in
# both places would be two copies of one fact.
_FLAG_GAPS = "Some hours had no TOU window — filled with the flat rate."


def _build_rate_24(
    import_rates_24: Optional[list],
    tou_windows: Optional[list],
    structured: Optional[dict],
    flat_rate: float,
    flags: list[str],
) -> tuple[list[float], bool]:
    """
    Build a 24-hour import-rate vector. Priority: explicit 24-h rates > TOU windows
    (request or structured tariff) > flat. Returns (rate_24, is_tou).
    """
    if import_rates_24 and len(import_rates_24) == 24:
        try:
            return [float(x) for x in import_rates_24], True
        except (TypeError, ValueError):
            pass

    windows = tou_windows
    if not windows and structured:
        windows = structured.get("tou_windows")

    if windows:
        rate = [None] * 24
        minutes_rounded = False
        day_specific = False
        hours_partial = False
        for w in windows:
            if not isinstance(w, dict):
                continue
            if w.get("days") not in (None, "all"):
                day_specific = True
            r = w.get("rate", w.get("rate_aud_per_kwh", w.get("import_rate")))
            if r is None:
                continue
            # 3.8b: float() had no guard either. A rate the parser could not
            # reduce to a number raised straight through the endpoint's
            # catch-all. bool is a subclass of int, so True must NOT become a
            # $1.00/kWh tariff; a numeric string ("0.45") is legitimate input
            # and is still accepted.
            if isinstance(r, bool):
                r_num = None
            else:
                try:
                    r_num = float(r)
                except (TypeError, ValueError):
                    r_num = None
                else:
                    # NaN/inf parse but are not rates; the contract is 24
                    # FINITE floats. Written without math.isfinite so this
                    # function depends on no module global but _window_hour.
                    if r_num != r_num or r_num in (float("inf"), float("-inf")):
                        r_num = None
            if r_num is None:
                flags.append(
                    f"A TOU window had an unreadable rate and was ignored: {w!r}"
                )
                continue
            r = r_num
            hours = w.get("hours")
            if hours:
                # 3.8b: int(h) raised on "06:00" and on junk. _window_hour is
                # THE one coercion rule for an hour anywhere in this function —
                # two rules for one idea is how the halves drift apart.
                applied_any = False
                skipped_any = False
                # 3.12 (F142): a bare string is truthy AND iterable, so
                # {"hours": "06:00"} would iterate '0','6',':','0','0' and
                # hand hours 0 and 6 the rate. A non-list/tuple iterates
                # nothing, applied_any stays False, and the existing
                # unreadable-hours-list flag fires.
                for h in (hours if isinstance(hours, (list, tuple)) else ()):
                    hv = _window_hour(h)
                    if hv is None or not (0 <= hv < 24):
                        skipped_any = True
                        continue
                    rate[hv] = r
                    applied_any = True
                if not applied_any:
                    flags.append(
                        f"A TOU window had an unreadable hours list and was ignored: {w!r}"
                    )
                elif skipped_any:
                    hours_partial = True
            else:
                sh_raw = w.get("start_hour", w.get("start"))
                eh_raw = w.get("end_hour", w.get("end"))
                # 3.8: bill_parser's canonical window times are "HH:MM" strings
                # (its flat fallback is 00:00-24:00). int("06:00") raised
                # ValueError straight through to the endpoint's catch-all —
                # every bill-derived tariff crashed the battery optimiser.
                sh = _window_hour(sh_raw)
                eh = _window_hour(eh_raw)
                if sh is None or eh is None:
                    flags.append(
                        f"A TOU window had unreadable times and was ignored: {w!r}"
                    )
                    continue
                for raw in (sh_raw, eh_raw):
                    if (isinstance(raw, str) and ":" in raw
                            and raw.strip().split(":", 1)[1] not in ("00", "0")):
                        minutes_rounded = True
                # %% 24 after coercion is load-bearing: "24:00" -> 24 -> 0, so
                # sh == eh for the flat window and the wrap branch yields all
                # 24 hours. Asserted in verify_tariff_contract.py.
                sh, eh = sh % 24, eh % 24
                hrs = range(sh, eh) if sh < eh else list(range(sh, 24)) + list(range(0, eh))
                for h in hrs:
                    rate[h] = r
        if minutes_rounded:
            flags.append(
                "TOU window times were rounded down to the hour — rate_24 has one slot per hour."
            )
        if day_specific:
            flags.append(
                "This tariff has weekday/weekend-specific rates; the model applies one "
                "24-hour rate profile to every day of the year."
            )
        if hours_partial:
            flags.append(
                "Some hours in a TOU window were unreadable and were skipped."
            )
        if any(r is not None for r in rate):
            filled = [r if r is not None else flat_rate for r in rate]
            if any(r is None for r in rate):
                flags.append(_FLAG_GAPS)
            return filled, True

    flags.append("No TOU tariff — flat import rate used (battery value = self-consumption + peak avoidance only) — is_fallback.")
    return [flat_rate] * 24, False


@router.post("/api/sizing/battery")
async def battery_sizing(
    body: BatteryRequest, caller: Caller = Depends(require_company)
):
    try:
        flags: list[str] = []
        client = _sb()
        # 3.11b — OWNERSHIP BEFORE ANY READ OF THE JOB'S STORED STATE. A
        # foreign job and an absent job raise the SAME 404 here (existence
        # never leaks), a transport failure raises 503, and both propagate as
        # HTTP statuses — never translated into a 200 body, because the proxy
        # passes status through. Running before _resolve_objective means 404
        # always wins over invalid-objective. client None = local dev with no
        # Supabase: nothing to own and nothing to leak — do not "harden" this
        # skip into a 500 that breaks local development.
        if body.job_id and client is not None:
            _get_company_job(client, body.job_id, caller.company_id)
        # 3.11b — the installer identity comes from the LOGIN, never the body
        # (the routes/job.py:610 precedent). An attempted assertion is visible,
        # not silently ignored (F161).
        if (isinstance(body.installer_id, str) and body.installer_id
                and body.installer_id != caller.user_id):
            flags.append(
                "installer_identity_from_login — this sizing used the pricing "
                "of the person signed in, not the installer named in the request"
            )
        # 3.9 — the ONE resolver, before the roof block; see optimise_sizing.
        resolved = _resolve_objective(client, body, flags)
        objective = resolved["objective"]
        custom_weight = resolved["custom_weight"]
        budget = resolved["budget"]
        if objective not in solar_optimiser.VALID_OBJECTIVES:
            return {"error": f"invalid objective '{objective}'", "valid": sorted(solar_optimiser.VALID_OBJECTIVES)}

        planes = body.planes
        candidate_configs = body.candidate_configs
        lat, lon = body.lat, body.lon
        panel = {"id": body.panel_id, "watts": body.panel_watts} if body.panel_id else None
        postcode, state = body.postcode, body.state

        # ── Roof model (chosen solar comes from D1 on this roof) ──
        roof = None
        if (planes is None or candidate_configs is None) and body.job_id and client is not None:
            roof = _load_roof(client, body.job_id)
            if roof is None:
                # 3.12 (D33): this endpoint does NOT read a stored solar
                # result — it re-runs the solar step itself — so it can never
                # need one. What it lacks here is a ROOF, which is what the
                # solar endpoint already says in this same situation. One
                # shape, not two kept in step (2R.1).
                return {"needs_roof_input": True, "flags": ["no_roof_geometry"],
                        "error": "No roof for this job yet — find or enter the roof first, then size."}
            if not roof.get("found") or roof.get("manual_entry_required"):
                return {"needs_roof_input": True, "flags": ["manual_entry_required"],
                        "error": "Roof not found by imagery — manual entry required before sizing."}
            if planes is None:
                planes = roof.get("planes") or []
            if candidate_configs is None:
                candidate_configs = roof.get("candidate_configs") or []
            if lat is None:
                lat = roof.get("lat")
            if lon is None:
                lon = roof.get("lng")
            if panel is None and roof.get("selected_panel"):
                sp = roof["selected_panel"]
                panel = {"id": sp.get("id"), "watts": sp.get("watts")}

        if not planes or candidate_configs is None or lat is None or lon is None or panel is None:
            # Same fact, same shape (3.12): a roof this run could size on is
            # missing or incomplete. Never "size the solar first".
            return {"needs_roof_input": True, "flags": ["missing_roof_or_solar"],
                    "error": "This job needs a usable roof before it can be sized — find or enter the roof, including a panel to lay out."}

        if (postcode is None or state is None) and body.job_id and client is not None:
            jobrow = _load_one(client, "jobs", body.job_id, "site_postcode,site_state")
            if jobrow:
                postcode = postcode or jobrow.get("site_postcode")
                state = state or jobrow.get("site_state")
        if state is None and postcode is not None:
            state = nem_data.postcode_to_state(postcode)

        # ── 3.7: one declared time base, resolved once (same as the solar block) ──
        utc_offset, time_base_meta = _time_base(state, flags)

        # ── Load profile (3.7: the ONE resolver — true series first) ──
        load_hourly, load_source, load_error = _resolve_load(client, body, flags)
        if load_error is not None:
            return load_error
        if len(load_hourly) != solar_optimiser.HOURS:
            return {"error": f"load profile must be {solar_optimiser.HOURS} hourly values.", "flags": ["bad_load_length"]}

        # ── Tariff + rate_24 + export limit: the ONE resolver (3.8) ──
        tariff = _resolve_tariff(client, body, state, postcode, flags)
        import_rate = tariff["import_rate"]
        fit = tariff["fit"]
        fit_is_fallback = tariff["fit_is_fallback"]
        rate_24 = tariff["rate_24"]
        is_tou = tariff["is_tou"]
        export_limit_kw = tariff["export_limit_kw"]
        export_meta = tariff["export_meta"]

        # ── 3.13: the annual supply charge — the SAME one expression the
        # solar endpoint uses, from the same resolver key. ──
        supply_charge_annual, supply_charge_source = _annual_supply_charge(tariff, flags)

        # ── Financial params ──
        fin = solar_optimiser.load_financial_params(flags)
        pr = fin["performance_ratio_non_temp"]

        def _solar_chosen(planes_, configs_, panel_, sconstraints_):
            """Run D1 (optionally constrained) and reconstruct the chosen config's net 8,760."""
            fl: list[str] = []
            sres = solar_optimiser.optimise(
                roof_planes=planes_, candidate_configs=configs_, lat=float(lat), lon=float(lon),
                utc_offset_hours=utc_offset,
                # 3.12: the SAME rate_24 the battery LP dispatches against —
                # never a 24-hour mean, never a different scalar from the
                # other endpoint. This is what makes the two endpoints agree
                # on the chosen solar for one job (the AGREE gate checks).
                panel=panel_, load_hourly=load_hourly, rate_24=rate_24, fit=float(fit),
                export_limit_kw=export_limit_kw, objective=objective, fin=fin,
                postcode=postcode, state=state, installer_id=caller.user_id,
                custom_weight=custom_weight,
                # 3.12 (F152, D33): the cap is an INPUT to both halves of the
                # sequential run, never a filter applied after one of them.
                # Solar alone costing more than the cap is a necessary
                # condition of the whole system exceeding it, and the solar
                # optimiser already answers an impossible cap honestly
                # (budget_too_low + cheapest real config, within_budget false).
                budget=budget, constraints=sconstraints_, flags=fl,
                supply_charge_annual=supply_charge_annual,
            )
            ch = sres["optimal"]
            watts = float(panel_.get("watts") or 0.0)
            built = generation.build_plane_profiles(planes_, float(lat), float(lon), utc_offset)
            net = [{**p, "hourly_kwh_per_kwp": [v * pr for v in p["hourly_kwh_per_kwp"]]} for p in built["planes"]]
            # Per-plane kwp from the chosen panels_per_plane (handles partial-filled planes).
            cfg = [
                {"plane_index": i, "kwp": (ch["panels_per_plane"][i] * watts / 1000.0)}
                for i in ch["plane_indices"]
            ]
            s8760 = (
                generation.system_generation_for_config(net, cfg)["hourly_kwh"]
                if cfg else [0.0] * solar_optimiser.HOURS
            )
            return ch, s8760, fl

        def _battery_run(s8760, chosen_, panel_, rows_, fix_kwh_, force_nb_, flags_):
            return battery_optimiser.optimise_battery(
                solar_8760=s8760, load_8760=load_hourly, rate_24=rate_24, fit=float(fit),
                export_limit_kw=export_limit_kw, battery_rows=rows_, fin=fin,
                solar_kw=chosen_["solar_kw"], panel_id=panel_.get("id"), panel_count=chosen_.get("panel_count"),
                solar_only_net_cost=chosen_["system_cost"],
                # 3.13: the no-battery outcome's breakdown IS the solar run's —
                # passed in, never recomputed here.
                solar_only_cost_breakdown=chosen_["cost_breakdown"],
                postcode=postcode, state=state,
                installer_id=caller.user_id, objective=objective,
                custom_weight=custom_weight,
                budget=budget, resolution=body.resolution,
                fix_battery_kwh=fix_kwh_, force_no_battery=force_nb_, flags=flags_,
            )

        # ── Full active battery catalogue (unconstrained pool) ──
        full_catalogue: list[dict] = []
        if client is not None:
            try:
                # 3.10 — the engine picks FOR the installer here, on the
                # SERVICE ROLE (RLS bypassed), with no authenticated caller to
                # scope against (this endpoint carries no auth dependency —
                # 9.3b). An automatic recommendation is therefore restricted
                # to curated catalogue equipment; an installer's own custom
                # battery still reaches the LP by being named explicitly in
                # constraints.battery_ids, which is prompt 2's path.
                full_catalogue = client.table("batteries").select("*").eq("status", "active").eq("origin", "catalogue").execute().data or []
            except Exception:
                full_catalogue = []
        if not full_catalogue:
            flags.append("battery catalogue unavailable — only the no-battery baseline evaluated.")

        def _filter_rows(ids):
            return [r for r in full_catalogue if r.get("id") in ids] if ids else full_catalogue

        # ── Resolve constraints ──
        constraints = body.constraints or {}
        con_planes, con_configs, con_panel = planes, candidate_configs, panel
        panel_constraint_active = False
        if constraints.get("panel_id"):
            prow = _fetch_panel(client, constraints["panel_id"])
            if prow:
                con_panel = prow
                rescaled = roof_geometry.rescale_planes_for_panel(planes, con_panel)
                con_planes, con_configs = rescaled["planes"], rescaled["candidate_configs"]
                flags.extend(rescaled.get("flags", []))
                panel_constraint_active = True
            else:
                flags.append(f"constraint panel_id {constraints['panel_id']} not found — ignored.")
        if constraints.get("inverter_id"):
            flags.append(f"inverter_id {constraints['inverter_id']} applied at cost-model level only (Phase 1).")

        solar_con_active = bool(
            panel_constraint_active or constraints.get("fix_panel_count") is not None
            or constraints.get("fix_solar_kwp") is not None or constraints.get("inverter_id")
        )
        con_batt_ids = constraints.get("battery_ids") or body.battery_ids
        fix_kwh = constraints.get("fix_battery_kwh")
        force_nb = bool(constraints.get("force_no_battery"))
        batt_con_active = bool(constraints.get("battery_ids") or fix_kwh is not None or force_nb)
        constrained_active = solar_con_active or batt_con_active

        con_solar_constraints = {
            "fix_panel_count": constraints.get("fix_panel_count"),
            "fix_solar_kwp": constraints.get("fix_solar_kwp"),
            "inverter_id": constraints.get("inverter_id"),
        } if solar_con_active else None

        if not constrained_active:
            # 3.12 (2N.1): this run's solar flags — budget_too_low above all —
            # REACH the response; a capped, downsized array must never be
            # silent about why.
            chosen, solar_8760, solar_run_flags = _solar_chosen(planes, candidate_configs, panel, None)
            flags.extend(solar_run_flags)
            result = _battery_run(solar_8760, chosen, panel, _filter_rows(body.battery_ids), None, False, flags)
            opt = result["optimal_battery"]
            unconstrained_optimum_battery = None
            constraint_deltas = None
            chosen_solar, used_panel = chosen, panel
            constraints_applied = {}
        else:
            # 3.12 (2N.1): the SHADOW run exists only for the deltas — its
            # flags stay discarded, or every solar flag would appear twice.
            unc_chosen, unc_solar, _ = _solar_chosen(planes, candidate_configs, panel, None)
            unc_result = _battery_run(unc_solar, unc_chosen, panel, full_catalogue, None, False, [])
            # The RESULT-BEARING run: its solar flags reach the response.
            chosen, solar_8760, solar_run_flags = _solar_chosen(con_planes, con_configs, con_panel, con_solar_constraints)
            flags.extend(solar_run_flags)
            result = _battery_run(solar_8760, chosen, con_panel, _filter_rows(con_batt_ids), fix_kwh, force_nb, flags)
            opt = result["optimal_battery"]
            unconstrained_optimum_battery = unc_result["optimal_battery"]
            u = unconstrained_optimum_battery
            constraint_deltas = {
                "battery_kwh": round(opt["usable_kwh"] - u["usable_kwh"], 2),
                "incremental_npv": round(opt["incremental_npv"] - u["incremental_npv"], 2),
                "incremental_payback_years": (
                    round(opt["incremental_payback_years"] - u["incremental_payback_years"], 2)
                    if opt["incremental_payback_years"] is not None and u["incremental_payback_years"] is not None else None
                ),
                "self_sufficiency_pct": round(opt["self_sufficiency_pct"] - u["self_sufficiency_pct"], 2),
                "battery_cost": round(opt["battery_cost"] - u["battery_cost"], 2),
            }
            chosen_solar, used_panel = chosen, con_panel
            constraints_applied = {
                "panel_id": con_panel.get("id") if panel_constraint_active else None,
                "inverter_id": constraints.get("inverter_id"),
                "fix_solar_kwp": constraints.get("fix_solar_kwp"),
                "fix_panel_count": constraints.get("fix_panel_count"),
                "battery_ids": constraints.get("battery_ids"),
                "fix_battery_kwh": constraints.get("fix_battery_kwh"),
                "force_no_battery": force_nb,
            }

        # 3.11 — same object into the row and the response; see optimise_sizing.
        roof_conf = _roof_confidence(roof, flags)

        # 3.13 prompt 4: the assumptions block, built ONCE — the SAME object
        # goes into the response and into the persisted run_assumptions.
        assumptions = {
            "engine_version": battery_optimiser.ENGINE_VERSION,
            "is_tou": is_tou,
            "tariff_type": tariff["tariff_type"],
            "tariff_type_source": tariff["tariff_type_source"],
            "supply_charge_annual": supply_charge_annual,
            "supply_charge_source": supply_charge_source,
            "import_rates_24": rate_24,
            "rate_24_source": tariff["rate_24_source"],
            "import_rate_source": tariff["import_rate_source"],
            "fit": fit,
            "fit_source": tariff["fit_source"],
            "fit_is_fallback": fit_is_fallback,
            "export_limit_kw": export_limit_kw,
            "export_limit_source": export_meta,
            "performance_ratio_non_temp": pr,
            "discount_rate": fin["discount_rate"],
            "analysis_years": fin["analysis_years"],
            "degradation_annual_pct": fin["degradation_annual_pct"],
            "tariff_escalation_pct": fin["tariff_escalation_pct"],
            "resolution": result["resolution"],
            "total_load_kwh": round(sum(load_hourly), 1),
            "panel": used_panel,
            "custom_weight": custom_weight if objective == "custom" else None,
            "constraints_applied": constraints_applied,
        }

        # ── 3.13 prompt 2 (C), reworded by prompt 2b: THE DISPATCH RESOLUTION
        # METER. The no-battery baseline's grid_cost and the chosen solar's
        # energy-only annual bill are two computations of the same year's
        # ENERGY bill for the same chosen solar, by two different engines —
        # the only place the suite compares their arithmetic against each
        # other. On full_year (365 real daily blocks) the two sum the same
        # hours and must agree to the cent; on representative_days the gap IS
        # the averaging error, a measurement worth naming, not a fault
        # (observed $30.20 on $807.10 on the fixture job). annual_bill_after
        # has carried the daily supply charge since prompt 1 and grid_cost
        # never has, so the KNOWN charge is removed before comparing. Any
        # divergence still fires loudly, naming both numbers AND the mode
        # that produced them, and the run persists anyway. ──
        _baseline_grid_cost = (result.get("no_battery_baseline") or {}).get("grid_cost")
        _bill_after = chosen_solar.get("annual_bill_after")
        _energy_after = (
            round(_bill_after - (chosen_solar.get("annual_supply_charge") or 0), 2)
            if _bill_after is not None
            and chosen_solar.get("bill_includes_supply_charge") else _bill_after
        )
        if (
            isinstance(_baseline_grid_cost, (int, float))
            and isinstance(_energy_after, (int, float))
            and abs(_baseline_grid_cost - _energy_after) > 0.01
        ):
            flags.append(
                f"dispatch_resolution_gap — under {result.get('resolution')!r} "
                f"the battery engine's no-battery baseline prices the chosen "
                f"solar's year at ${_baseline_grid_cost:,.2f} while the solar "
                f"engine's energy-only bill is ${_energy_after:,.2f}"
            )

        # ── Persist chosen solar + battery to sizing_results ──
        # system_cost is THE TOTAL UP-FRONT NET COST OF EVERYTHING THIS ROW
        # RECOMMENDS — a run_kind='solar_battery' row recommends solar AND a
        # battery, so this is their combined cost. The solar writer satisfies
        # the same sentence for its solar-only recommendation; run_kind says
        # which.
        persisted = False
        financial_persisted = False
        if body.job_id:
            sid = None
            gen_annual = round(sum(solar_8760), 1)
            export_opt = opt.get("annual_export_kwh")
            self_cons_ratio = (
                round((gen_annual - export_opt) / gen_annual, 4)
                if (gen_annual > 0 and export_opt is not None) else None
            )
            # 3.13 (was 3.12/F152): there is now exactly ONE expression for the
            # whole-system cost — the engine's own system_cost key, which every
            # candidate carries and the budget filter tests. The row stores it
            # and within_budget beside it, both from the same candidate dict;
            # the local re-derivation that duplicated the engine's arithmetic
            # is DELETED, not kept in step.
            try:
                sid = capture.save_sizing_result({
                    "job_id": body.job_id,
                    "solar_kw": chosen_solar["solar_kw"],
                    "battery_kwh": opt.get("usable_kwh", 0),
                    "self_consumption_ratio": self_cons_ratio,
                    "system_cost": opt["system_cost"],
                    "annual_solar_generation_kwh": gen_annual,
                    "within_budget": opt["within_budget"],
                    "engine_version": battery_optimiser.ENGINE_VERSION,
                    "objective_used": objective,
                    "roof_geometry_id": roof_conf["roof_geometry_id"],
                    "roof_low_confidence": roof_conf["roof_low_confidence"],
                    "roof_needs_manual_confirmation": roof_conf["roof_needs_manual_confirmation"],
                    "roof_flags": roof_conf["roof_flags"],
                    "roof_reason": roof_conf["roof_reason"],
                    # 3.11b — the run log: this run covered solar AND battery,
                    # produced by the sequential engine. The candidate list is
                    # stored VERBATIM (the same list the response returns);
                    # dimension_keys names the CHOICE key of each point (D33).
                    "run_kind": "solar_battery",
                    "engine_mode": "sequential",
                    # 3.13 prompt 4: the SAME assumptions object the response
                    # carries, verbatim.
                    "run_assumptions": assumptions,
                    "evaluated_options": {
                        "dimension_keys": ["battery_id"],
                        "points": result["candidates"],
                        # 3.13: stored VERBATIM. The battery run's points are
                        # battery candidates, so the chosen solar layout is
                        # not otherwise in this payload at all — this is the
                        # only place it can travel from.
                        "chosen_cost_breakdown": opt.get("cost_breakdown"),
                        "chosen_solar": {
                            "solar_kw": chosen_solar["solar_kw"],
                            "panel_count": chosen_solar["panel_count"],
                            "plane_indices": chosen_solar["plane_indices"],
                            "panels_per_plane": chosen_solar["panels_per_plane"],
                        },
                        # 3.13 prompt 3 (F191): the dispatch mode this run
                        # actually used — the number's provenance travels
                        # with the number.
                        "dispatch_resolution": result.get("resolution"),
                        # 3.13 prompt 3 (B): the split-ROI parts, READ from
                        # the two dicts that already carry them, never
                        # recomputed. The redundancy against the stored
                        # whole-system financial row is DELIBERATE and gated:
                        # the whole is the sum of these parts by construction
                        # (prompt 2 step C), and verify_results_contract Q1
                        # asserts the sum two-sidedly to the cent.
                        "split": {
                            "solar_only": {
                                "annual_savings": chosen_solar["annual_savings"],
                                "npv_25yr": chosen_solar["npv_25yr"],
                                "simple_payback_years": chosen_solar["simple_payback_years"],
                                "system_cost": chosen_solar["system_cost"],
                            },
                            "battery_increment": {
                                "annual_savings_vs_solar_only": opt.get("annual_savings_vs_solar_only"),
                                "incremental_npv": opt.get("incremental_npv"),
                                "incremental_payback_years": opt.get("incremental_payback_years"),
                                "battery_cost": opt.get("battery_cost"),
                            },
                        },
                    },
                })
                persisted = bool(sid)
            except Exception as exc:  # noqa: BLE001
                sentry_sdk.capture_exception(exc)
            if not persisted:
                flags.append("sizing_result_not_persisted")

            # 3.13 prompt 2 (C): the whole system, COMPOSED, not reinvented.
            # The battery engine returns INCREMENTAL figures; the whole-system
            # figures compose exactly because both NPV loops use the SAME fin
            # dict (identical discount factors term by term), the two capex
            # figures sum to opt["system_cost"], and the solar run's savings
            # against no system equal the battery run's no-battery baseline
            # saving against no system. The solar half is read from
            # chosen_solar — one of the solar optimiser's own evaluated
            # entries — never re-run.
            _sol_sav = chosen_solar.get("annual_savings")
            _inc_sav = opt.get("annual_savings_vs_solar_only")
            whole_savings = (
                _sol_sav + _inc_sav
                if _sol_sav is not None and _inc_sav is not None else None
            )
            _sol_npv = chosen_solar.get("npv_25yr")
            _inc_npv = opt.get("incremental_npv")
            whole_npv = (
                _sol_npv + _inc_npv
                if _sol_npv is not None and _inc_npv is not None else None
            )
            _spend_before = chosen_solar.get("annual_bill_before")
            # 3.13 prompt 4c (D34): the whole-system undiscounted savings
            # compose exactly as the NPV does — solar plus incremental, the
            # incremental already carrying its replacement cost undiscounted.
            _sol_und = chosen_solar.get("undiscounted_savings_25yr")
            _inc_und = opt.get("undiscounted_savings_25yr")
            whole_undiscounted = (
                _sol_und + _inc_und
                if _sol_und is not None and _inc_und is not None else None
            )
            financial_persisted = _persist_financial_and_quote(
                client, caller, body.job_id, sid,
                {
                    "system_capex": opt["system_cost"],
                    "annual_savings": (
                        round(whole_savings, 2) if whole_savings is not None else None
                    ),
                    "npv_25_year": (
                        round(whole_npv, 2) if whole_npv is not None else None
                    ),
                    "payback_years": _payback_years(opt["system_cost"], whole_savings),
                    "current_annual_spend": _spend_before,
                    # May legitimately EXCEED current spend (negative savings)
                    # or go NEGATIVE (a system that out-earns the bill) —
                    # written as it falls out, never clamped or floored.
                    "projected_annual_spend": (
                        round(_spend_before - whole_savings, 2)
                        if _spend_before is not None and whole_savings is not None
                        else None
                    ),
                    "annual_bill_reduction": (
                        round(whole_savings, 2) if whole_savings is not None else None
                    ),
                    "undiscounted_savings_25yr": (
                        round(whole_undiscounted, 2)
                        if whole_undiscounted is not None else None
                    ),
                },
                flags,
            )

        return {
            "objective": result["objective"],
            "load_source": load_source,
            "time_base": time_base_meta,
            "roof_confidence": roof_conf,
            "optimal_battery": opt,
            "unconstrained_optimum_battery": unconstrained_optimum_battery,
            "constraint_deltas": constraint_deltas,
            "no_battery_baseline": result["no_battery_baseline"],
            "candidates": result["candidates"],
            "resolution": result["resolution"],
            "solve_seconds": result["solve_seconds"],
            "not_economic_reason": result["not_economic_reason"],
            "within_budget": opt["within_budget"],
            "cost_breakdown": opt.get("cost_breakdown"),
            "chosen_solar": {
                "solar_kw": chosen_solar["solar_kw"],
                "annual_generation_kwh": chosen_solar["annual_generation_kwh"],
                "system_cost_solar_only": chosen_solar["system_cost"],
                "plane_indices": chosen_solar["plane_indices"],
                "panel_count": chosen_solar["panel_count"],
                "panels_per_plane": chosen_solar["panels_per_plane"],
                "cost_breakdown": chosen_solar["cost_breakdown"],
            },
            # 3.13 prompt 4: the same object persisted as run_assumptions.
            "assumptions": assumptions,
            "persisted": persisted,
            "financial_persisted": financial_persisted,
            "flags": flags,
        }
    except HTTPException:
        raise  # 3.11b — see optimise_sizing: a status is a status, never a 200.
    except Exception as e:  # noqa: BLE001 — never crash the app
        sentry_sdk.capture_exception(e)
        return {"error": "Internal error in the battery optimiser.", "flags": ["internal_error"]}
