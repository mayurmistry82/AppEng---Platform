"""
Solar sizing optimiser (D1) — replaces the heuristic sizing_engine for solar.

Solar sizing is a single discrete dimension (which roof planes to fill), so there is no need
for MILP: every feasible candidate config (from roof_geometry, B2) is evaluated EXACTLY. For
each config we build the gross hourly system generation (C1), apply the non-temperature
performance ratio, net it hourly against the load under the export cap, price it bottom-up
(cost_model), and score it under the chosen objective. The winner + the full score curve are
returned for transparency.

CRITICAL: the gross C1 profile already includes PVGIS's temperature model. We apply ONLY the
non-temperature performance ratio (inverter/cable/soiling/mismatch) here — re-applying a
temperature derate would double-count ~3%. `temperature_derating_applied: false` is returned
to make this explicit.

Generation comes only from PVGIS (via generation.py). No Google Solar energy figures are used.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import cost_model
import generation
import nem_data

ENGINE_VERSION = "solar-optimiser-d1-v1"

HOURS = 8760

# Used only when the cost_assumptions financial params are unreachable.
_FIN_DEFAULTS: dict[str, Any] = {
    "performance_ratio_non_temp": 0.88,
    "discount_rate": 0.055,
    "analysis_years": 25,
    "degradation_annual_pct": 0.5,
    "tariff_escalation_pct": 0.0,
}

# Documented import-rate fallback (AUD/kWh) when neither the bill nor the request supplies one.
# nem_data has no import-rate default (it only carries FiT fallbacks); never treat a missing
# rate as 0.
DEFAULT_IMPORT_RATE = 0.40

VALID_OBJECTIVES = {"max_npv", "max_self_sufficiency", "min_payback", "custom"}


def _client() -> Any:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception:
        return None


# ── Financial params ──────────────────────────────────────────────────────────
def load_financial_params(flags: list[str]) -> dict:
    """Read PR / discount / horizon / degradation / escalation from cost_assumptions."""
    c = _client()
    if c is not None:
        try:
            res = (
                c.table("cost_assumptions")
                .select(
                    "performance_ratio_non_temp,discount_rate,analysis_years,"
                    "degradation_annual_pct,tariff_escalation_pct"
                )
                .eq("status", "active")
                .limit(1)
                .execute()
            )
            if res.data:
                r = res.data[0]
                return {
                    "performance_ratio_non_temp": float(r["performance_ratio_non_temp"]),
                    "discount_rate": float(r["discount_rate"]),
                    "analysis_years": int(r["analysis_years"]),
                    "degradation_annual_pct": float(r["degradation_annual_pct"]),
                    "tariff_escalation_pct": float(r["tariff_escalation_pct"]),
                }
        except Exception:
            pass
    flags.append("cost_assumptions financial params unavailable — used documented defaults.")
    return dict(_FIN_DEFAULTS)


# ── Load profile expansion ────────────────────────────────────────────────────
def expand_load_to_8760(annual_kwh: float, hourly_weights: Optional[list]) -> list[float]:
    """
    Expand a representative day (24 relative hourly weights + annual kWh) to 8,760 hourly
    load. Each day uses the same shape; energy is preserved (Σ = annual_kwh). A missing/bad
    weight vector falls back to a flat day.
    """
    w = []
    for x in hourly_weights or []:
        try:
            w.append(float(x))
        except (TypeError, ValueError):
            w.append(0.0)
    if len(w) != 24 or sum(w) <= 0:
        w = [1.0] * 24
    s = sum(w)
    frac = [x / s for x in w]  # fractions of one day, Σ = 1
    daily_avg = float(annual_kwh) / 365.0
    profile: list[float] = []
    for _ in range(365):
        for h in range(24):
            profile.append(daily_avg * frac[h])
    return profile


# ── Hourly netting under the export cap ───────────────────────────────────────
def net_config(system_hourly: list[float], load_hourly: list[float], export_limit_kw: float) -> dict:
    """
    Net hourly generation against load under the export cap. Per hour:
      self = min(gen, load); surplus = max(gen-load, 0);
      export = min(surplus, export_limit_kw); curtailed = surplus - export;
      import = max(load-gen, 0).
    Excess above the cap is CURTAILED (lost) — this is why oversizing past the limit has
    diminishing returns. Returns annual sums (kWh) + peak export hour.
    """
    sc = ex = im = cur = 0.0
    peak_export = 0.0
    n = min(len(system_hourly), len(load_hourly))
    for h in range(n):
        g = system_hourly[h]
        l = load_hourly[h]
        if g <= l:
            sc += g
            im += l - g
        else:
            sc += l
            surplus = g - l
            e = surplus if surplus < export_limit_kw else export_limit_kw
            ex += e
            cur += surplus - e
            if e > peak_export:
                peak_export = e
    return {
        "self_consumed": sc,
        "export": ex,
        "import": im,
        "curtailed": cur,
        "peak_export_kwh_h": peak_export,
    }


# ── Financials ────────────────────────────────────────────────────────────────
def financials(
    self_consumed: float,
    export: float,
    total_load: float,
    import_rate: float,
    fit: float,
    system_cost: float,
    fin: dict,
) -> dict:
    bill_before = total_load * import_rate
    import_kwh = total_load - self_consumed
    bill_after = import_kwh * import_rate - export * fit
    annual_savings = self_consumed * import_rate + export * fit

    payback = (system_cost / annual_savings) if annual_savings > 0 else None

    deg = fin["degradation_annual_pct"] / 100.0
    disc = fin["discount_rate"]
    esc = fin["tariff_escalation_pct"] / 100.0
    years = fin["analysis_years"]
    npv = -system_cost
    for y in range(1, years + 1):
        npv += annual_savings * ((1 - deg) ** y) * ((1 + esc) ** y) / ((1 + disc) ** y)

    return {
        "annual_bill_before": round(bill_before, 2),
        "annual_bill_after": round(bill_after, 2),
        "annual_savings": round(annual_savings, 2),
        "simple_payback_years": round(payback, 2) if payback is not None else None,
        "npv_25yr": round(npv, 2),
    }


def _synthetic_alloc(
    roof_planes: list[dict], candidate_configs: list[dict], target: int,
    panel_watts: float, flags: list[str],
) -> list[tuple]:
    """
    Best-plane-first fill to a target panel count, partial-filling the last plane (its kwp
    recomputed from the partial count). The fill order is the cumulative candidate order
    (largest config's plane_indices). Clamps to the roof max + flags. Returns a list of
    (plane_index, panel_count, kwp).
    """
    order = list(candidate_configs[-1]["plane_indices"]) if candidate_configs else []
    roof_max = sum((roof_planes[i].get("panel_count") or 0) for i in order)
    if target > roof_max:
        target = roof_max
        flags.append("constraint_clamped_to_roof_max")
    if target < 0:
        target = 0
    remaining = target
    alloc: list[tuple] = []
    for i in order:
        if remaining <= 0:
            break
        cap = roof_planes[i].get("panel_count") or 0
        take = min(remaining, cap)
        if take > 0:
            kwp = round(take * float(panel_watts) / 1000.0, 3) if panel_watts else 0.0
            alloc.append((i, take, kwp))
            remaining -= take
    return alloc


# ── Optimise ──────────────────────────────────────────────────────────────────
def optimise(
    roof_planes: list[dict],
    candidate_configs: list[dict],
    lat: float,
    lon: float,
    utc_offset_hours: Optional[float],
    panel: dict,
    load_hourly: list[float],
    import_rate: float,
    fit: float,
    export_limit_kw: float,
    objective: str,
    fin: dict,
    postcode: Optional[str] = None,
    state: Optional[str] = None,
    installer_id: Optional[str] = None,
    custom_weight: float = 0.5,
    budget: Optional[float] = None,
    constraints: Optional[dict] = None,
    flags: Optional[list[str]] = None,
) -> dict:
    """
    Evaluate every feasible config exactly and return the optimum + score curve. Pure compute
    (no persistence). `flags` is appended to in place.

    `constraints` (optional) pins the solution: fix_panel_count / fix_solar_kwp build ONE
    synthetic best-first config (partial-filling the last plane); inverter_id is passed to
    cost_model. Panel-model constraints are applied UPSTREAM by the route (it re-scales the
    roof and passes the constrained planes + panel here).

    3.7: `utc_offset_hours` is REQUIRED (no default) and passed straight to
    generation.build_plane_profiles, which rotates PVGIS's UTC series into the site's
    local standard time — the base `load_hourly` is already in. Netting the two in
    different bases was the pre-3.7 fault; a default here would let this internal call
    silently keep receiving UTC.
    """
    flags = flags if flags is not None else []
    pr = fin["performance_ratio_non_temp"]
    total_load = sum(load_hourly)
    panel_id = panel.get("id")
    panel_watts = panel.get("watts")

    # Per-plane gross profiles (PVGIS, cached), then apply the NON-TEMP performance ratio.
    built = generation.build_plane_profiles(roof_planes, lat, lon, utc_offset_hours)
    if built["failed_planes"]:
        flags.append("partial_plane_failure")
    net_planes = [
        {**p, "hourly_kwh_per_kwp": [v * pr for v in p["hourly_kwh_per_kwp"]]}
        for p in built["planes"]
    ]

    # Feasible configs as best-first panel allocations [(plane_index, panel_count, kwp), ...]:
    # the empty system + (unconstrained) each roof candidate config, OR (constrained) a single
    # synthetic config pinned to fix_panel_count / fix_solar_kwp.
    constraints = constraints or {}
    inverter_id = constraints.get("inverter_id")
    target_count = constraints.get("fix_panel_count")
    if target_count is None and constraints.get("fix_solar_kwp") is not None and panel_watts:
        target_count = round(float(constraints["fix_solar_kwp"]) * 1000.0 / float(panel_watts))

    if target_count is not None:
        synth = _synthetic_alloc(roof_planes, candidate_configs, int(target_count), panel_watts, flags)
        allocations: list[list] = [[], synth]
    else:
        allocations = [[]]
        for cc in candidate_configs or []:
            allocations.append([
                (i, roof_planes[i].get("panel_count") or 0, float(roof_planes[i].get("kwp") or 0.0))
                for i in (cc.get("plane_indices") or [])
                if 0 <= i < len(roof_planes)
            ])

    evaluated: list[dict] = []
    for alloc in allocations:
        panels_per_plane = [0] * len(roof_planes)
        solar_kw = 0.0
        cfg: list[dict] = []
        for (i, pc, kwp) in alloc:
            panels_per_plane[i] = pc
            solar_kw += float(kwp)
            cfg.append({"plane_index": i, "kwp": kwp})
        panel_count_total = sum(panels_per_plane)
        idxs = [i for (i, _, _) in alloc]

        if not alloc or solar_kw <= 0:
            gen_kwh = 0.0
            netd = {"self_consumed": 0.0, "export": 0.0, "import": total_load,
                    "curtailed": 0.0, "peak_export_kwh_h": 0.0}
            system_cost = 0.0
        else:
            sysgen = generation.system_generation_for_config(net_planes, cfg)
            gen_kwh = sysgen["annual_kwh"]
            netd = net_config(sysgen["hourly_kwh"], load_hourly, export_limit_kw)
            cost = cost_model.compute_system_cost(
                solar_kw=solar_kw,
                panel_id=panel_id,
                panel_count=panel_count_total,
                inverter_id=inverter_id,
                postcode=postcode,
                state=state,
                installer_id=installer_id,
            )
            system_cost = cost["net_cost"]

        fins = financials(
            netd["self_consumed"], netd["export"], total_load,
            import_rate, fit, system_cost, fin,
        )
        ss_pct = round(netd["self_consumed"] / total_load * 100, 2) if total_load > 0 else 0.0
        sc_pct = round(netd["self_consumed"] / gen_kwh * 100, 2) if gen_kwh > 0 else 0.0

        evaluated.append(
            {
                "plane_indices": idxs,
                "panels_per_plane": panels_per_plane,
                "panel_count": panel_count_total,
                "solar_kw": round(solar_kw, 3),
                "annual_generation_kwh": round(gen_kwh, 1),
                "annual_self_consumed_kwh": round(netd["self_consumed"], 1),
                "annual_export_kwh": round(netd["export"], 1),
                "annual_import_kwh": round(netd["import"], 1),
                "annual_curtailed_kwh": round(netd["curtailed"], 1),
                "peak_export_kwh_h": round(netd["peak_export_kwh_h"], 3),
                "self_consumption_pct": sc_pct,
                "self_sufficiency_pct": ss_pct,
                "system_cost": round(system_cost, 2),
                **fins,
            }
        )

    # ── Scoring ──
    def npv_of(e):
        return e["npv_25yr"]

    if objective == "custom":
        npvs = [e["npv_25yr"] for e in evaluated]
        sss = [e["self_sufficiency_pct"] for e in evaluated]
        lo_n, hi_n = min(npvs), max(npvs)
        lo_s, hi_s = min(sss), max(sss)
        w = custom_weight if custom_weight is not None else 0.5
        for e in evaluated:
            nn = (e["npv_25yr"] - lo_n) / (hi_n - lo_n) if hi_n > lo_n else 0.0
            ns = (e["self_sufficiency_pct"] - lo_s) / (hi_s - lo_s) if hi_s > lo_s else 0.0
            e["score"] = round(w * nn + (1 - w) * ns, 6)
    else:
        for e in evaluated:
            if objective == "max_self_sufficiency":
                e["score"] = e["self_sufficiency_pct"]
            elif objective == "min_payback":
                # Shortest payback wins; configs with no payback (no savings) score worst.
                e["score"] = -e["simple_payback_years"] if e["simple_payback_years"] is not None else -1e18
            else:  # max_npv (default)
                e["score"] = e["npv_25yr"]

    # ── Budget filter + pick optimum ──
    budget_too_low = False
    # A size pin (fix_panel_count / fix_solar_kwp) is a HARD directive: the empty/no-solar
    # config is excluded from the argmax so the pinned synthetic config always wins — even
    # when it is NPV-negative. The empty config is still evaluated (it stays in score_curve
    # and is used as the no-system reference below). Equipment-only / unconstrained runs are
    # unaffected: pinned is False, so the pool is unchanged.
    pinned = target_count is not None
    real = [e for e in evaluated if e["solar_kw"] > 0]

    def _argmax(candidates: list[dict]) -> dict:
        pickable = [e for e in candidates if e["solar_kw"] > 0] if pinned else candidates
        if not pickable:  # pin clamped to 0 (no usable roof) — empty is all there is
            pickable = candidates
        return max(pickable, key=lambda e: e["score"])

    if budget is not None:
        in_budget = [e for e in evaluated if e["system_cost"] <= budget]
        real_in_budget = [e for e in in_budget if e["solar_kw"] > 0]
        if not real_in_budget:
            # Nothing real fits — return the cheapest real config and flag it.
            budget_too_low = True
            flags.append("budget_too_low")
            optimal = min(real, key=lambda e: e["system_cost"]) if real else evaluated[0]
            pool = evaluated
        else:
            pool = in_budget
            optimal = _argmax(pool)
    else:
        pool = evaluated
        optimal = _argmax(pool)

    # Warn transparently when the pinned config is economically worse than doing nothing.
    if pinned and optimal["solar_kw"] > 0:
        empty = next(
            (e for e in evaluated if e["solar_kw"] == 0 and not e["plane_indices"]), None
        )
        if empty is not None and optimal["npv_25yr"] < empty["npv_25yr"]:
            flags.append("pinned_config_below_no_system")

    for e in evaluated:
        e["within_budget"] = (budget is None) or (e["system_cost"] <= budget)

    score_curve = [
        {
            "solar_kw": e["solar_kw"],
            "score": e["score"],
            "npv_25yr": e["npv_25yr"],
            "simple_payback_years": e["simple_payback_years"],
            "self_sufficiency_pct": e["self_sufficiency_pct"],
            "system_cost": e["system_cost"],
            "annual_savings": e["annual_savings"],
            "within_budget": e["within_budget"],
        }
        for e in sorted(evaluated, key=lambda e: e["solar_kw"])
    ]

    return {
        "objective": objective,
        "optimal": optimal,
        "score_curve": score_curve,
        "n_configs_evaluated": len(evaluated),
        "cache_hits": built["cache_hits"],
        "cache_misses": built["cache_misses"],
        "failed_planes": built["failed_planes"],
        "budget_too_low": budget_too_low,
        "flags": flags,
    }
