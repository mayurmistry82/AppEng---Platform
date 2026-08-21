"""
Battery sizing optimiser — the LP differentiator.

Given the chosen solar config (D1) and the hourly load, form the net-load profile and, for
EACH candidate battery capacity, solve a linear program that optimally schedules
charge/discharge over the horizon — capturing TOU arbitrage, solar self-consumption, and
peak-import avoidance — subject to state-of-charge, round-trip efficiency, C-rate and
export-limit constraints. Compute annual value + incremental financials per candidate and
pick the capacity (including "no battery") that wins the objective. Real optimisation (PuLP /
CBC), not a rule of thumb. Sequential on the fixed solar size (joint co-optimisation later).

Solar generation is reused from D1's chosen config (PR already applied) — never recomputed
differently. No Google Solar energy figures are used.
"""

from __future__ import annotations

import math
import time
from typing import Any, Optional

import pulp

import cost_model

ENGINE_VERSION = "battery-optimiser-v1"

_DAYS_2019 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

# Documented defaults for missing physical specs (NEVER 0 — using 0 would forbid all
# dispatch / mis-state energy). Each application is flagged so it is never silent.
_DEFAULT_DOD = 1.0  # modern LiFePO4: usable_capacity already reflects DoD → full usable range
_DEFAULT_RTE = 0.90
_DEFAULT_C_RATE = 0.5  # max power = 0.5C when the catalogue power rating is missing
_DEFAULT_CYCLE_LIFE = 6000  # LiFePO4 ~6000 cycles when warranty_cycles is missing


def _num(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ── Battery spec normalisation ────────────────────────────────────────────────
def battery_specs(row: dict, flags: list[str]) -> Optional[dict]:
    """
    Normalise one catalogue row into LP specs, filling missing PHYSICAL specs with documented
    defaults (flagged) rather than 0. Returns None (skip + flag) only when usable capacity or
    price is missing — those cannot be modelled / costed.
    """
    name = f"{row.get('brand')} {row.get('model')}"
    usable = _num(row.get("usable_capacity_kwh"))
    cost = _num(row.get("cost_aud"))
    if not usable or usable <= 0:
        flags.append(f"{name}: usable capacity missing — skipped (not treated as 0).")
        return None
    if cost is None:
        flags.append(f"{name}: price missing — skipped (a price cannot be assumed to be $0).")
        return None

    dod_pct = _num(row.get("depth_of_discharge_pct"))
    if dod_pct is None:
        dod = _DEFAULT_DOD
        flags.append(f"{name}: depth of discharge missing — assumed {int(_DEFAULT_DOD*100)}% (full usable range).")
    else:
        dod = dod_pct / 100.0

    rte_pct = _num(row.get("round_trip_efficiency_pct"))
    if rte_pct is None:
        rte = _DEFAULT_RTE
        flags.append(f"{name}: round-trip efficiency missing — assumed {int(_DEFAULT_RTE*100)}%.")
    else:
        rte = rte_pct / 100.0

    maxc = _num(row.get("max_continuous_charge_kw"))
    maxd = _num(row.get("max_continuous_discharge_kw"))
    if maxc is None or maxd is None:
        derived = round(_DEFAULT_C_RATE * usable, 2)
        if maxc is None:
            maxc = derived
        if maxd is None:
            maxd = derived
        flags.append(f"{name}: charge/discharge power missing — assumed {_DEFAULT_C_RATE}C ({derived} kW).")

    cycle_life = row.get("warranty_cycles")
    cycle_life = int(cycle_life) if cycle_life else _DEFAULT_CYCLE_LIFE
    if not row.get("warranty_cycles"):
        flags.append(f"{name}: warranty cycles missing — assumed {_DEFAULT_CYCLE_LIFE} cycles for replacement modelling.")

    return {
        "id": row.get("id"),
        "name": name,
        "brand": row.get("brand"),
        "model": row.get("model"),
        "usable": usable,
        "dod": dod,
        "rte": rte,
        "max_charge_kw": maxc,
        "max_discharge_kw": maxd,
        "cost_aud": cost,
        "cycle_life": cycle_life,
        "warranty_years": row.get("warranty_years"),
    }


# ── Horizon blocks (representative days | full year) ──────────────────────────
def _tile(rate_24: list[float], steps: int) -> list[float]:
    return [rate_24[t % 24] for t in range(steps)]


def build_blocks(
    solar_8760: list[float], load_8760: list[float], rate_24: list[float], resolution: str,
    flags: Optional[list[str]] = None,
) -> list[dict]:
    """
    Representative days: 12 monthly typical days (hour-of-day averages), weighted by days in
    month → captures seasonal solar variation, tractable LP.

    Full year (3.13 prompt 2b, D35 — the default): 365 REAL daily blocks of 24 steps each,
    calendar order, no averaging, each weight 1.0. solve_candidate makes state of charge
    cyclic WITHIN a block, so a daily block enforces the one physical rule a home battery
    lives by: it fills by day, empties by evening, and starts tomorrow where it started
    today. The single 8,760-step block this branch used to return is DELETED rather than
    kept as a third mode: it made state of charge cyclic over the YEAR, which let the
    solver charge in summer, hold for months, and discharge in winter — seasonal energy
    banking no home battery can do — and every figure it produced was optimistic with
    nothing on screen looking odd. Each block still has its own cyclic SoC; the LP itself
    is unchanged.

    A series that is not 8,760 hours long is never padded (padding invents nights) and
    never silently truncated: the honest set of WHOLE days is built and the shortfall is
    flagged via `flags` when the caller passed a list.
    """
    if resolution == "full_year":
        # The same _DAYS_2019 month lengths the representative branch walks, so both
        # paths agree on what a year is: 31+28+...+31 = 365 days, 365 × 24 = 8,760.
        assert sum(_DAYS_2019) == 365 and sum(_DAYS_2019) * 24 == 8760
        n_hours = min(len(solar_8760), len(load_8760))
        n_days = n_hours // 24
        if n_days > 365:
            n_days = 365
        if n_days < 365 and flags is not None:
            flags.append(
                f"dispatch series shorter than a year — {n_days} whole days "
                "dispatched, the rest of the year has no data — is_fallback"
            )
        blocks: list[dict] = []
        d = 0
        for month_days in _DAYS_2019:
            for _ in range(month_days):
                if d >= n_days:
                    break
                h = d * 24
                blocks.append({
                    "solar": list(solar_8760[h:h + 24]),
                    "load": list(load_8760[h:h + 24]),
                    "rate": list(rate_24),
                    "weight": 1.0,
                    "steps": 24,
                })
                d += 1
        return blocks
    blocks: list[dict] = []
    h = 0
    for days in _DAYS_2019:
        span = days * 24
        sol = [0.0] * 24
        lod = [0.0] * 24
        for i in range(span):
            if h + i < len(solar_8760):
                sol[i % 24] += solar_8760[h + i]
            if h + i < len(load_8760):
                lod[i % 24] += load_8760[h + i]
        sol = [x / days for x in sol]
        lod = [x / days for x in lod]
        blocks.append({"solar": sol, "load": lod, "rate": list(rate_24), "weight": float(days), "steps": 24})
        h += span
    return blocks


# ── No-battery baseline (direct netting, no LP) ───────────────────────────────
def baseline(blocks: list[dict], fit: float, export_limit_kw: float) -> dict:
    cost = imp = exp = self_c = load_t = 0.0
    peak_import = 0.0
    for blk in blocks:
        w = blk["weight"]
        for t in range(blk["steps"]):
            s = blk["solar"][t]
            l = blk["load"][t]
            r = blk["rate"][t]
            i = max(l - s, 0.0)
            e = min(max(s - l, 0.0), export_limit_kw)
            cost += w * (i * r - e * fit)
            imp += w * i
            exp += w * e
            self_c += w * min(s, l)
            load_t += w * l
            if i > peak_import:
                peak_import = i
    return {"cost": cost, "import": imp, "export": exp, "self_consumed": self_c,
            "load": load_t, "peak_import": peak_import}


# ── LP dispatch for one candidate battery ─────────────────────────────────────
def solve_candidate(blocks: list[dict], bat: dict, fit: float, export_limit_kw: float) -> Optional[dict]:
    """
    Solve the dispatch LP for one battery over all blocks (each block cyclic). Returns annual
    aggregates or None if the solver fails / is infeasible.
    """
    s = math.sqrt(bat["rte"])
    soc_min = (1.0 - bat["dod"]) * bat["usable"]
    soc_max = bat["usable"]
    maxc, maxd = bat["max_charge_kw"], bat["max_discharge_kw"]

    prob = pulp.LpProblem("battery_dispatch", pulp.LpMinimize)
    obj_terms = []
    handles = []  # (block, w, ch, di, soc, gi, ge)

    for bi, blk in enumerate(blocks):
        T = blk["steps"]
        w = blk["weight"]
        ch = [pulp.LpVariable(f"ch_{bi}_{t}", 0, maxc) for t in range(T)]
        di = [pulp.LpVariable(f"di_{bi}_{t}", 0, maxd) for t in range(T)]
        soc = [pulp.LpVariable(f"soc_{bi}_{t}", soc_min, soc_max) for t in range(T)]
        gi = [pulp.LpVariable(f"gi_{bi}_{t}", 0) for t in range(T)]
        ge = [pulp.LpVariable(f"ge_{bi}_{t}", 0, export_limit_kw) for t in range(T)]
        cu = [pulp.LpVariable(f"cu_{bi}_{t}", 0) for t in range(T)]
        for t in range(T):
            sol = blk["solar"][t]
            lod = blk["load"][t]
            # curtailment cannot exceed available solar
            prob += cu[t] <= max(sol, 0.0)
            # energy balance (curtailment allowed): usable solar + discharge + import = load + charge + export
            prob += sol - cu[t] + di[t] + gi[t] == lod + ch[t] + ge[t]
            # SoC recursion, cyclic within the block (split round-trip loss)
            prev = soc[t - 1] if t > 0 else soc[T - 1]
            prob += soc[t] == prev + ch[t] * s - di[t] / s
            obj_terms.append(w * (gi[t] * blk["rate"][t] - ge[t] * fit))
        handles.append((blk, w, ch, di, soc, gi, ge))

    prob += pulp.lpSum(obj_terms)
    try:
        prob.solve(pulp.PULP_CBC_CMD(msg=0))
    except Exception:
        return None
    if pulp.LpStatus[prob.status] != "Optimal":
        return None

    cost = imp = exp = dis = cha = cur_ = load_t = 0.0
    peak_import = 0.0
    for blk, w, ch, di, soc, gi, ge in handles:
        for t in range(blk["steps"]):
            giv = gi[t].value() or 0.0
            gev = ge[t].value() or 0.0
            cost += w * (giv * blk["rate"][t] - gev * fit)
            imp += w * giv
            exp += w * gev
            dis += w * (di[t].value() or 0.0)
            cha += w * (ch[t].value() or 0.0)
            load_t += w * blk["load"][t]
            if giv > peak_import:
                peak_import = giv
    return {"cost": cost, "import": imp, "export": exp, "discharge": dis,
            "charge": cha, "load": load_t, "peak_import": peak_import}


# ── Financials ────────────────────────────────────────────────────────────────
def battery_financials(
    savings: float, incr_capex: float, hardware_cost: float,
    cycles_per_year: float, cycle_life: float, fin: dict,
) -> dict:
    deg = fin["degradation_annual_pct"] / 100.0
    disc = fin["discount_rate"]
    esc = fin["tariff_escalation_pct"] / 100.0
    N = fin["analysis_years"]
    npv = -incr_capex
    # 3.13 prompt 4c (D34): the same year terms without the discount divisor —
    # see solar_optimiser.financials. The NPV term is untouched.
    undiscounted = 0.0
    for y in range(1, N + 1):
        year_term = savings * ((1 - deg) ** y) * ((1 + esc) ** y)
        undiscounted += year_term
        npv += year_term / ((1 + disc) ** y)
    repl_year = None
    if cycles_per_year > 0 and cycle_life:
        yr = cycle_life / cycles_per_year
        if yr < N:
            repl_year = int(math.ceil(yr))
            npv -= hardware_cost / ((1 + disc) ** repl_year)
            # The undiscounted figure pays for the replacement too — a "total
            # savings" that quietly ignored a cost the NPV pays for would make
            # the LARGEST of the three ROI figures the least honest.
            undiscounted -= hardware_cost
    payback = (incr_capex / savings) if savings > 0 else None
    return {
        "incremental_npv": round(npv, 2),
        "incremental_payback_years": round(payback, 2) if payback is not None else None,
        "replacement_year": repl_year,
        "undiscounted_savings_25yr": round(undiscounted, 2),
    }


# ── Orchestration ─────────────────────────────────────────────────────────────
def optimise_battery(
    solar_8760: list[float],
    load_8760: list[float],
    rate_24: list[float],
    fit: float,
    export_limit_kw: float,
    battery_rows: list[dict],
    fin: dict,
    *,
    solar_kw: float,
    panel_id: Optional[str],
    panel_count: Optional[int],
    solar_only_net_cost: float,
    solar_only_cost_breakdown: Optional[dict] = None,
    postcode: Optional[str],
    state: Optional[str],
    installer_id: Optional[str],
    objective: str,
    custom_weight: float = 0.5,
    budget: Optional[float] = None,
    # 3.13 prompt 2b (D35): hard mode IS the default — all 365 real days.
    # The representative-day shortcut stays available but is NEVER selected
    # automatically by any code path; if hard mode ever proves unusable the
    # switch back is Mayur's deliberate call, not a quiet downgrade.
    resolution: str = "full_year",
    fix_battery_kwh: Optional[float] = None,
    force_no_battery: bool = False,
    flags: Optional[list[str]] = None,
) -> dict:
    flags = flags if flags is not None else []

    # Constraints on the candidate set.
    if force_no_battery:
        flags.append("The no-battery constraint was applied — only the solar-only outcome was evaluated.")
        battery_rows = []  # only the no-battery baseline is evaluated
    elif fix_battery_kwh is not None and battery_rows:
        valid = [(r, _num(r.get("usable_capacity_kwh"))) for r in battery_rows]
        valid = [(r, u) for (r, u) in valid if u]
        if valid:
            nearest, u = min(valid, key=lambda ru: abs(ru[1] - float(fix_battery_kwh)))
            battery_rows = [nearest]
            if abs(u - float(fix_battery_kwh)) > 1e-9:
                flags.append(
                    f"Pinned battery size {fix_battery_kwh} kWh matched to the nearest "
                    f"catalogue battery: {u} kWh ({nearest.get('brand')} {nearest.get('model')})."
                )
        else:
            flags.append(f"Pinned battery size {fix_battery_kwh} kWh: no catalogue battery has a usable capacity — only the no-battery option was evaluated.")
            battery_rows = []

    blocks = build_blocks(solar_8760, load_8760, rate_24, resolution, flags)
    base = baseline(blocks, fit, export_limit_kw)
    total_load = base["load"]
    base_self_suff = round((total_load - base["import"]) / total_load * 100, 2) if total_load > 0 else 0.0

    no_battery = {
        "usable_kwh": 0.0,
        "model": "No battery",
        "annual_savings_vs_solar_only": 0.0,
        "self_sufficiency_pct": base_self_suff,
        "cycles_per_year": 0.0,
        "peak_import_reduction_kw": 0.0,
        "battery_cost": 0.0,
        "incremental_payback_years": None,
        "incremental_npv": 0.0,
        # 3.13 prompt 4c: no battery adds nothing — a true zero, not a null.
        "undiscounted_savings_25yr": 0.0,
        "grid_cost": round(base["cost"], 2),
        "annual_import_kwh": round(base["import"], 1),
        "annual_export_kwh": round(base["export"], 1),
        "replacement_year": None,
        # 3.12 (F152/D33): the total up-front net cost of the whole
        # recommendation — for the no-battery point, the solar alone. The
        # budget filter below tests THIS key, never battery_cost.
        "system_cost": round(solar_only_net_cost, 2),
        # 3.13: the no-battery outcome's cost IS the solar-only cost, and its
        # breakdown is produced by the solar run, not here — passed in, never
        # recomputed. None when the caller had none to pass.
        "cost_breakdown": solar_only_cost_breakdown,
    }
    candidates: list[dict] = [no_battery]
    solve_seconds = 0.0

    for row in battery_rows:
        bat = battery_specs(row, flags)
        if bat is None:
            continue
        t0 = time.time()
        res = solve_candidate(blocks, bat, fit, export_limit_kw)
        solve_seconds += time.time() - t0
        if res is None:
            flags.append(f"{bat['name']}: LP infeasible / solver failure — skipped.")
            continue

        savings = base["cost"] - res["cost"]
        cost_with = cost_model.compute_system_cost(
            solar_kw=solar_kw, panel_id=panel_id, panel_count=panel_count,
            battery_id=bat["id"], battery_usable_kwh=bat["usable"],
            postcode=postcode, state=state, installer_id=installer_id,
        )
        incr_capex = cost_with["net_cost"] - solar_only_net_cost
        cycles = res["discharge"] / bat["usable"] if bat["usable"] > 0 else 0.0
        fins = battery_financials(savings, incr_capex, bat["cost_aud"], cycles, bat["cycle_life"], fin)
        self_suff = round((total_load - res["import"]) / total_load * 100, 2) if total_load > 0 else 0.0

        candidates.append({
            "battery_id": bat["id"],
            "model": bat["name"],
            "usable_kwh": round(bat["usable"], 2),
            "annual_savings_vs_solar_only": round(savings, 2),
            "self_sufficiency_pct": self_suff,
            "cycles_per_year": round(cycles, 1),
            "peak_import_reduction_kw": round(base["peak_import"] - res["peak_import"], 3),
            "battery_cost": round(incr_capex, 2),
            "incremental_payback_years": fins["incremental_payback_years"],
            "incremental_npv": fins["incremental_npv"],
            "undiscounted_savings_25yr": fins["undiscounted_savings_25yr"],
            "grid_cost": round(res["cost"], 2),
            "annual_import_kwh": round(res["import"], 1),
            "annual_export_kwh": round(res["export"], 1),
            "annual_discharge_kwh": round(res["discharge"], 1),
            "replacement_year": fins["replacement_year"],
            "round_trip_efficiency": bat["rte"],
            "depth_of_discharge": bat["dod"],
            # 3.12 (F152/D33): whole-system cost — solar plus this battery's
            # incremental net cost. battery_cost keeps its incremental meaning.
            "system_cost": round(solar_only_net_cost + incr_capex, 2),
            # 3.13: the whole system's itemised breakdown, kept as it came
            # from cost_model — flags and all, never re-shaped.
            "cost_breakdown": cost_with,
        })

    # 3.13: within_budget, set from the SAME system_cost key the pool filter
    # below tests — written the same way solar_optimiser writes its own, so
    # the two engines express one rule identically. Set on every candidate,
    # the no-battery baseline included.
    for c in candidates:
        c["within_budget"] = (budget is None) or (c["system_cost"] <= budget)

    # ── Budget filter + objective selection ──
    # 3.12 (F152, D33): budget_aud caps the WHOLE SYSTEM — the filter tests
    # system_cost, the total up-front net cost of the recommendation, never
    # the incremental battery cost alone. The same sentence defines the
    # system_cost column, and /api/sizing/optimise already filters this way.
    pool = [c for c in candidates if budget is None or c["system_cost"] <= budget]
    battery_candidates = [c for c in candidates if c.get("battery_id") is not None]
    # Two DIFFERENT no-battery causes the reasons below must not conflate:
    # every battery pushed the system over the cap, vs solar alone already
    # exceeds it (in which case the baseline itself was filtered out).
    batteries_cut_by_budget = (
        budget is not None and bool(battery_candidates)
        and not any(c.get("battery_id") is not None for c in pool)
    )
    solar_alone_over_budget = budget is not None and no_battery["system_cost"] > budget
    if not pool:
        # Even solar alone exceeds the cap. The run still answers with the
        # baseline and an honest reason — doubt travels, it never blocks (D24).
        pool = [no_battery]

    not_economic_reason = None
    if force_no_battery:
        # Forced by constraint — not an economics outcome.
        return {
            "objective": objective,
            "optimal_battery": no_battery,
            "no_battery_baseline": no_battery,
            "candidates": sorted(candidates, key=lambda c: c["usable_kwh"]),
            "resolution": resolution,
            "solve_seconds": round(solve_seconds, 3),
            "not_economic_reason": "battery excluded by the no-battery constraint.",
            "n_candidates": len(candidates) - 1,
            "flags": flags,
        }
    if objective == "max_self_sufficiency":
        optimal = max(pool, key=lambda c: c["self_sufficiency_pct"])
    elif objective == "min_payback":
        viable = [c for c in pool if c["usable_kwh"] > 0 and c["incremental_npv"] > 0
                  and c["incremental_payback_years"] is not None]
        optimal = min(viable, key=lambda c: c["incremental_payback_years"]) if viable else no_battery
    elif objective == "custom":
        npvs = [c["incremental_npv"] for c in pool]
        sss = [c["self_sufficiency_pct"] for c in pool]
        lo_n, hi_n = min(npvs), max(npvs)
        lo_s, hi_s = min(sss), max(sss)
        w = custom_weight if custom_weight is not None else 0.5
        def blend(c):
            nn = (c["incremental_npv"] - lo_n) / (hi_n - lo_n) if hi_n > lo_n else 0.0
            ns = (c["self_sufficiency_pct"] - lo_s) / (hi_s - lo_s) if hi_s > lo_s else 0.0
            return w * nn + (1 - w) * ns
        optimal = max(pool, key=blend)
    else:  # max_npv (default)
        optimal = max(pool, key=lambda c: c["incremental_npv"])

    if optimal.get("usable_kwh", 0) == 0:
        # 3.12 change 4: EVERY no-battery outcome carries an honest reason —
        # a budget cause is named as a budget cause, never as economics.
        if solar_alone_over_budget:
            not_economic_reason = (
                f"even the solar-only system (${no_battery['system_cost']:,.2f}) costs "
                f"more than the ${budget:,.2f} budget — no battery could be added under this cap."
            )
        elif batteries_cut_by_budget:
            cheapest = min(c["system_cost"] for c in battery_candidates)
            not_economic_reason = (
                f"every battery took the whole-system cost over the ${budget:,.2f} budget "
                f"(the cheapest solar-plus-battery system available was ${cheapest:,.2f}) — "
                "solar-only is recommended under this cap."
            )
        elif objective == "max_self_sufficiency":
            not_economic_reason = "no battery raised self-sufficiency above solar-only — battery not economic for this job."
        elif objective == "min_payback":
            not_economic_reason = "no battery has a positive-NPV payback under this tariff and cost — battery not economic for this job."
        elif objective == "custom":
            not_economic_reason = "no battery scored higher than solar-only on the chosen blend of NPV and self-sufficiency — battery not economic for this job."
        else:  # max_npv
            not_economic_reason = "no battery beats solar-only on NPV — battery not economic for this job."
        flags.append("No battery is recommended for this job — the reason is stated with the result.")

    return {
        "objective": objective,
        "optimal_battery": optimal,
        "no_battery_baseline": no_battery,
        "candidates": sorted(candidates, key=lambda c: c["usable_kwh"]),
        "resolution": resolution,
        "solve_seconds": round(solve_seconds, 3),
        "not_economic_reason": not_economic_reason,
        "n_candidates": len(candidates) - 1,
        "flags": flags,
    }
