from __future__ import annotations

import json
import math
import os
from typing import Any, Literal, Optional
from pydantic import BaseModel
import sentry_sdk
from fastapi import APIRouter, HTTPException

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
    # Objective
    objective: str = "max_npv"
    custom_weight: Optional[float] = 0.5
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


@router.post("/api/sizing/optimise")
async def optimise_sizing(body: OptimiseRequest):
    try:
        flags: list[str] = []
        if body.objective not in solar_optimiser.VALID_OBJECTIVES:
            return {"error": f"invalid objective '{body.objective}'", "valid": sorted(solar_optimiser.VALID_OBJECTIVES)}

        client = _sb()
        planes = body.planes
        candidate_configs = body.candidate_configs
        lat, lon = body.lat, body.lon
        panel = {"id": body.panel_id, "watts": body.panel_watts} if body.panel_id else None
        postcode, state = body.postcode, body.state

        # ── Resolve the roof model ──
        if (planes is None or candidate_configs is None) and body.job_id and client is not None:
            roof = _load_one(
                client, "roof_geometry", body.job_id,
                "planes,candidate_configs,lat,lng,selected_panel,found,manual_entry_required",
            )
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

        # ── Resolve tariff (import rate + FiT) ──
        import_rate = body.import_rate
        fit = body.fit
        fit_is_fallback = False
        if (import_rate is None or fit is None) and body.job_id and client is not None:
            bill = _load_one(client, "bills", body.job_id, "parsed_json,feed_in_tariff")
            if bill:
                pj = bill.get("parsed_json") or {}
                if import_rate is None and pj.get("tariff_rate") is not None:
                    import_rate = float(pj["tariff_rate"])
                if fit is None:
                    bf = bill.get("feed_in_tariff")
                    if bf is None:
                        bf = pj.get("feed_in_tariff")
                    if bf is not None:
                        fit = float(bf)
        if import_rate is None:
            import_rate = solar_optimiser.DEFAULT_IMPORT_RATE
            flags.append(f"import_rate fallback ${import_rate:.2f}/kWh (no bill rate) — is_fallback")
        if fit is None:
            fd = nem_data.get_default_fit(state)
            fit = fd["fit_aud_per_kwh"]
            fit_is_fallback = True
            flags.append(f"fit fallback {fit}/kWh ({fd.get('scheme')}) — is_fallback")

        # ── Resolve export limit ──
        if body.export_limit_kw is not None:
            export_limit_kw = float(body.export_limit_kw)
            export_meta = {"export_limit_kw": export_limit_kw, "source": "request"}
        else:
            export_meta = nem_data.get_export_limit(state=state, postcode=postcode)
            export_limit_kw = export_meta["export_limit_kw"]
            if export_meta.get("is_default"):
                flags.append("export_limit defaulted (state/postcode not recognised)")

        # ── Financial params ──
        fin = solar_optimiser.load_financial_params(flags)

        def _run(planes_, configs_, panel_, constraints_, flags_):
            return solar_optimiser.optimise(
                roof_planes=planes_, candidate_configs=configs_, lat=float(lat), lon=float(lon),
                utc_offset_hours=utc_offset,
                panel=panel_, load_hourly=load_hourly, import_rate=float(import_rate), fit=float(fit),
                export_limit_kw=float(export_limit_kw), objective=body.objective, fin=fin,
                postcode=postcode, state=state, installer_id=body.installer_id,
                custom_weight=body.custom_weight if body.custom_weight is not None else 0.5,
                budget=body.budget, constraints=constraints_, flags=flags_,
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

        # ── Persist the CONSTRAINED (chosen) result to sizing_results (capture) ──
        persisted = False
        if body.job_id:
            try:
                sid = capture.save_sizing_result(
                    {
                        "job_id": body.job_id,
                        "solar_kw": opt["solar_kw"],
                        "battery_kwh": 0,
                        "self_consumption_ratio": round(opt["self_consumption_pct"] / 100.0, 4),
                        "system_cost": opt["system_cost"],
                        "annual_solar_generation_kwh": opt["annual_generation_kwh"],
                        "within_budget": opt.get("within_budget", True),
                        "engine_version": solar_optimiser.ENGINE_VERSION,
                        "objective_used": body.objective,
                    }
                )
                persisted = bool(sid)
            except Exception as exc:  # noqa: BLE001 — never block the response
                sentry_sdk.capture_exception(exc)
            if not persisted:
                flags.append("sizing_result_not_persisted")

        return {
            "objective": result["objective"],
            "load_source": load_source,
            "time_base": time_base_meta,
            "optimal": opt,
            "unconstrained_optimum": unconstrained_optimum,
            "constraint_deltas": constraint_deltas,
            "score_curve": score_curve,
            "assumptions": {
                "engine_version": solar_optimiser.ENGINE_VERSION,
                "import_rate": import_rate,
                "fit": fit,
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
                "custom_weight": body.custom_weight if body.objective == "custom" else None,
                "constraints_applied": constraints_applied,
            },
            "failed_planes": result["failed_planes"],
            "persisted": persisted,
            "flags": flags,
        }
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
    objective: str = "max_npv"
    custom_weight: Optional[float] = 0.5
    budget: Optional[float] = None
    resolution: str = "representative_days"
    # Optional installer constraints (additive; absent/empty ⇒ behaves exactly as today)
    constraints: Optional[dict] = None


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
        for w in windows:
            if not isinstance(w, dict):
                continue
            r = w.get("rate", w.get("rate_aud_per_kwh", w.get("import_rate")))
            if r is None:
                continue
            r = float(r)
            hours = w.get("hours")
            if hours:
                for h in hours:
                    if 0 <= int(h) < 24:
                        rate[int(h)] = r
            else:
                sh = w.get("start_hour", w.get("start"))
                eh = w.get("end_hour", w.get("end"))
                if sh is None or eh is None:
                    continue
                sh, eh = int(sh) % 24, int(eh) % 24
                hrs = range(sh, eh) if sh < eh else list(range(sh, 24)) + list(range(0, eh))
                for h in hrs:
                    rate[h] = r
        if any(r is not None for r in rate):
            filled = [r if r is not None else flat_rate for r in rate]
            if any(r is None for r in rate):
                flags.append("Some hours had no TOU window — filled with the flat rate.")
            return filled, True

    flags.append("No TOU tariff — flat import rate used (battery value = self-consumption + peak avoidance only) — is_fallback.")
    return [flat_rate] * 24, False


@router.post("/api/sizing/battery")
async def battery_sizing(body: BatteryRequest):
    try:
        flags: list[str] = []
        if body.objective not in solar_optimiser.VALID_OBJECTIVES:
            return {"error": f"invalid objective '{body.objective}'", "valid": sorted(solar_optimiser.VALID_OBJECTIVES)}

        client = _sb()
        planes = body.planes
        candidate_configs = body.candidate_configs
        lat, lon = body.lat, body.lon
        panel = {"id": body.panel_id, "watts": body.panel_watts} if body.panel_id else None
        postcode, state = body.postcode, body.state
        structured_tariff: Optional[dict] = None

        # ── Roof model (chosen solar comes from D1 on this roof) ──
        if (planes is None or candidate_configs is None) and body.job_id and client is not None:
            roof = _load_one(
                client, "roof_geometry", body.job_id,
                "planes,candidate_configs,lat,lng,selected_panel,found,manual_entry_required",
            )
            if roof is None:
                return {"needs_solar_result": True, "flags": ["no_roof_geometry"],
                        "error": "No roof geometry for this job — run /api/roof/geometry then /api/sizing/optimise (D1) first."}
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
            return {"needs_solar_result": True, "flags": ["missing_roof_or_solar"],
                    "error": "Need a roof + solar config first (pass them or a job_id with stored roof geometry; run D1)."}

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

        # ── Tariff: import (flat) + FiT, and structured TOU if available ──
        import_rate = body.import_rate
        fit = body.fit
        fit_is_fallback = False
        if (import_rate is None or fit is None or body.tou_windows is None) and body.job_id and client is not None:
            bill = _load_one(client, "bills", body.job_id, "parsed_json,feed_in_tariff")
            if bill:
                pj = bill.get("parsed_json") or {}
                structured_tariff = pj.get("tariff_structured") if isinstance(pj.get("tariff_structured"), dict) else None
                if import_rate is None and pj.get("tariff_rate") is not None:
                    import_rate = float(pj["tariff_rate"])
                if fit is None:
                    bf = bill.get("feed_in_tariff")
                    if bf is None:
                        bf = pj.get("feed_in_tariff")
                    if bf is not None:
                        fit = float(bf)
        if import_rate is None:
            import_rate = solar_optimiser.DEFAULT_IMPORT_RATE
            flags.append(f"import_rate fallback ${import_rate:.2f}/kWh — is_fallback")
        if fit is None:
            fd = nem_data.get_default_fit(state)
            fit = fd["fit_aud_per_kwh"]
            fit_is_fallback = True
            flags.append(f"fit fallback {fit}/kWh ({fd.get('scheme')}) — is_fallback")

        rate_24, is_tou = _build_rate_24(
            body.import_rates_24, body.tou_windows, structured_tariff, float(import_rate), flags
        )
        flat_rate_for_solar = sum(rate_24) / 24.0

        # ── Export limit ──
        if body.export_limit_kw is not None:
            export_limit_kw = float(body.export_limit_kw)
            export_meta = {"export_limit_kw": export_limit_kw, "source": "request"}
        else:
            export_meta = nem_data.get_export_limit(state=state, postcode=postcode)
            export_limit_kw = export_meta["export_limit_kw"]

        # ── Financial params ──
        fin = solar_optimiser.load_financial_params(flags)
        pr = fin["performance_ratio_non_temp"]

        def _solar_chosen(planes_, configs_, panel_, sconstraints_):
            """Run D1 (optionally constrained) and reconstruct the chosen config's net 8,760."""
            fl: list[str] = []
            sres = solar_optimiser.optimise(
                roof_planes=planes_, candidate_configs=configs_, lat=float(lat), lon=float(lon),
                utc_offset_hours=utc_offset,
                panel=panel_, load_hourly=load_hourly, import_rate=flat_rate_for_solar, fit=float(fit),
                export_limit_kw=export_limit_kw, objective=body.objective, fin=fin,
                postcode=postcode, state=state, installer_id=body.installer_id,
                custom_weight=body.custom_weight if body.custom_weight is not None else 0.5,
                budget=None, constraints=sconstraints_, flags=fl,
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
                solar_only_net_cost=chosen_["system_cost"], postcode=postcode, state=state,
                installer_id=body.installer_id, objective=body.objective,
                custom_weight=body.custom_weight if body.custom_weight is not None else 0.5,
                budget=body.budget, resolution=body.resolution,
                fix_battery_kwh=fix_kwh_, force_no_battery=force_nb_, flags=flags_,
            )

        # ── Full active battery catalogue (unconstrained pool) ──
        full_catalogue: list[dict] = []
        if client is not None:
            try:
                full_catalogue = client.table("batteries").select("*").eq("status", "active").execute().data or []
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
            chosen, solar_8760, _ = _solar_chosen(planes, candidate_configs, panel, None)
            result = _battery_run(solar_8760, chosen, panel, _filter_rows(body.battery_ids), None, False, flags)
            opt = result["optimal_battery"]
            unconstrained_optimum_battery = None
            constraint_deltas = None
            chosen_solar, used_panel = chosen, panel
            constraints_applied = {}
        else:
            unc_chosen, unc_solar, _ = _solar_chosen(planes, candidate_configs, panel, None)
            unc_result = _battery_run(unc_solar, unc_chosen, panel, full_catalogue, None, False, [])
            chosen, solar_8760, _ = _solar_chosen(con_planes, con_configs, con_panel, con_solar_constraints)
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

        # ── Persist chosen solar + battery to sizing_results ──
        persisted = False
        if body.job_id:
            gen_annual = round(sum(solar_8760), 1)
            export_opt = opt.get("annual_export_kwh")
            self_cons_ratio = (
                round((gen_annual - export_opt) / gen_annual, 4)
                if (gen_annual > 0 and export_opt is not None) else None
            )
            try:
                sid = capture.save_sizing_result({
                    "job_id": body.job_id,
                    "solar_kw": chosen_solar["solar_kw"],
                    "battery_kwh": opt.get("usable_kwh", 0),
                    "self_consumption_ratio": self_cons_ratio,
                    "system_cost": round(chosen_solar["system_cost"] + opt.get("battery_cost", 0), 2),
                    "annual_solar_generation_kwh": gen_annual,
                    "within_budget": (body.budget is None) or (opt.get("battery_cost", 0) <= body.budget),
                    "engine_version": battery_optimiser.ENGINE_VERSION,
                    "objective_used": body.objective,
                })
                persisted = bool(sid)
            except Exception as exc:  # noqa: BLE001
                sentry_sdk.capture_exception(exc)
            if not persisted:
                flags.append("sizing_result_not_persisted")

        return {
            "objective": result["objective"],
            "load_source": load_source,
            "time_base": time_base_meta,
            "optimal_battery": opt,
            "unconstrained_optimum_battery": unconstrained_optimum_battery,
            "constraint_deltas": constraint_deltas,
            "no_battery_baseline": result["no_battery_baseline"],
            "candidates": result["candidates"],
            "resolution": result["resolution"],
            "solve_seconds": result["solve_seconds"],
            "not_economic_reason": result["not_economic_reason"],
            "chosen_solar": {
                "solar_kw": chosen_solar["solar_kw"],
                "annual_generation_kwh": chosen_solar["annual_generation_kwh"],
                "system_cost_solar_only": chosen_solar["system_cost"],
                "plane_indices": chosen_solar["plane_indices"],
            },
            "assumptions": {
                "engine_version": battery_optimiser.ENGINE_VERSION,
                "is_tou": is_tou,
                "import_rates_24": rate_24,
                "fit": fit,
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
                "custom_weight": body.custom_weight if body.objective == "custom" else None,
                "constraints_applied": constraints_applied,
            },
            "persisted": persisted,
            "flags": flags,
        }
    except Exception as e:  # noqa: BLE001 — never crash the app
        sentry_sdk.capture_exception(e)
        return {"error": "Internal error in the battery optimiser.", "flags": ["internal_error"]}
