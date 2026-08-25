#!/usr/bin/env python3
"""
measure_dispatch_runtime.py — row 4.0, FIRST task: measure what a dispatch solve
actually costs on this machine, and what a COMBINED (solar + dispatch) solve
costs, so 4.0 is designed against a number instead of an assumption.

Direction: docs/2026-08-19-sizing-engine-direction.md §8 and §14 q1 — nobody has
measured one dispatch solve; everything about feasibility depends on it.

THIS IS NOT A GATE. It measures the engine read-only and builds its own
experimental problems in this file. It modifies no engine file and writes no
database row.

What it measures, in order:
  1. One dispatch solve on job a57e13f1's real inputs, split three ways
     (LpProblem build / prob.solve() wall / CBC's own reported time), 5 repeats.
  2. How the solve scales with the horizon (1 / 3 / 12 months), using the
     module's own block builder.
  3. How many solves a combined SEARCH would need (counting, not solving).
  4. Whether solves parallelise on this machine (serial vs ProcessPoolExecutor).
  5. The combined problem built HERE: solar size + dispatch in one optimisation,
     (a) solar as continuous kW (LP), (b) solar as whole panels per plane
     (mixed-integer). Hard cut-off 120 s each — a timeout IS the result.

Data contract: reads only. Asserts the PVGIS cache-miss count is zero (no
network call to PVGIS) and that the public table counts are identical at start
and end. Exits non-zero only on a genuine error — a timeout is a result.

Run:  /opt/anaconda3/bin/python3 backend/scripts/measure_dispatch_runtime.py
"""
from __future__ import annotations

import json
import math
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
from typing import Any, Optional

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# .env — names only ever read; values never printed.
_ENV_PATH = os.path.join(BACKEND_DIR, ".env")
if os.path.exists(_ENV_PATH):
    for _line in open(_ENV_PATH):
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k, _v)

import pulp  # noqa: E402

import battery_optimiser  # noqa: E402
import generation  # noqa: E402
import solar_optimiser  # noqa: E402
import nem_data  # noqa: E402

JOB_PREFIX = "a57e13f1"
CUTOFF_S = 120.0          # step-5 hard cut-off per combined solve
REPEATS = 5               # step-1 repeats (shrunk, loudly, if the budget demands)
WALL_BUDGET_S = 45 * 60   # the whole script must finish inside this
SCRIPT_T0 = time.perf_counter()

PUBLIC_TABLES = [
    "actuals", "batteries", "bills", "companies", "company_members",
    "corrections", "cost_assumptions", "financial_results", "flywheel_config",
    "installer_profiles", "interval_data", "inverters", "job_customers", "jobs",
    "load_profiles", "panels", "pvgis_cache", "questionnaire_responses",
    "registrations", "roof_geometry", "sizing_results", "solar_resources",
    "surveys", "tariffs",
]
# The prompt says "the eighteen table counts". The live schema has 24 public
# tables (enumerated above from pg_tables at run time of writing) — the
# eighteen is stale. ALL public tables are counted; the assert is a superset
# of what was asked, never a subset.

CACHE_MISSES_TOTAL = 0     # accumulated across every build_plane_profiles call
CACHE_PUT_CALLS = 0        # generation._cache_put is no-opped + counted


# ── Instrumentation (parent process only; engine files untouched) ─────────────
SOLVE_RECORDS: list[dict] = []   # one per solve_candidate call
_CUR: dict = {}

_ORIG_LP_SOLVE = pulp.LpProblem.solve
_ORIG_SOLVE_CANDIDATE = battery_optimiser.solve_candidate


def _patched_lp_solve(self, solver=None, **kwargs):
    t0 = time.perf_counter()
    _CUR["solve_enter"] = t0
    status = _ORIG_LP_SOLVE(self, solver, **kwargs)
    t1 = time.perf_counter()
    _CUR["solve_exit"] = t1
    _CUR["solve_wall"] = t1 - t0
    _CUR["pulp_solution_time"] = getattr(self, "solutionTime", None)
    return status


def _timed_solve_candidate(blocks, bat, fit, export_limit_kw):
    rec: dict = {}
    _CUR.clear()
    t_in = time.perf_counter()
    res = _ORIG_SOLVE_CANDIDATE(blocks, bat, fit, export_limit_kw)
    t_out = time.perf_counter()
    rec["total"] = t_out - t_in
    rec["build"] = (_CUR.get("solve_enter", t_out)) - t_in
    rec["solve_wall"] = _CUR.get("solve_wall")
    rec["extract"] = t_out - _CUR.get("solve_exit", t_out)
    rec["pulp_solution_time"] = _CUR.get("pulp_solution_time")
    rec["n_blocks"] = len(blocks)
    SOLVE_RECORDS.append(rec)
    return res


def install_instrumentation() -> None:
    pulp.LpProblem.solve = _patched_lp_solve
    battery_optimiser.solve_candidate = _timed_solve_candidate

    def _no_write_cache_put(*a, **k):
        global CACHE_PUT_CALLS
        CACHE_PUT_CALLS += 1
        return False

    generation._cache_put = _no_write_cache_put


# ── CBC log parsing ───────────────────────────────────────────────────────────
def parse_cbc_log(text: str) -> dict:
    out: dict = {"result_line": None, "nodes": None, "iterations": None,
                 "cpu_s": None, "wall_s": None}
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("Result -"):
            out["result_line"] = s
        m = re.match(r"Enumerated nodes:\s+(\d+)", s)
        if m:
            out["nodes"] = int(m.group(1))
        m = re.match(r"Total iterations:\s+(\d+)", s)
        if m:
            out["iterations"] = int(m.group(1))
        m = re.match(r"(?:Total time|Time) \(CPU seconds\):\s+([\d.]+)", s)
        if m:
            out["cpu_s"] = float(m.group(1))
        m = re.search(r"Wallclock seconds\)?:\s+([\d.]+)", s)
        if m:
            out["wall_s"] = float(m.group(1))
    return out


def cbc_version() -> str:
    path = pulp.PULP_CBC_CMD(msg=0).path
    try:
        p = subprocess.run([path, "-exit"], capture_output=True, text=True, timeout=30)
        m = re.search(r"Version:\s*([\d.]+)", p.stdout)
        return m.group(1) if m else "unknown"
    except Exception as exc:  # noqa: BLE001
        return f"unknown ({exc})"


# ── Table counts (direct Postgres, read-only) ─────────────────────────────────
def table_counts() -> Optional[dict]:
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        return None
    if not db_url:
        return None
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    out: dict = {}
    for t in PUBLIC_TABLES:
        cur.execute(f"select count(*) from public.{t}")
        out[t] = cur.fetchone()[0]
    conn.close()
    return out


# ── Job input loading (the platform's own read path, reads only) ──────────────
def sb_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    from supabase import create_client
    return create_client(url, key)


def load_job_inputs(client) -> dict:
    """Load job a57e13f1's real inputs exactly the way /api/sizing/battery does.
    Any missing input STOPS the script cleanly — no synthetic substitute."""
    from routes import sizing as sizing_route  # the endpoint's own resolvers

    jobs = [j for j in client.table("jobs")
            .select("job_id,site_postcode,site_state").execute().data
            if str(j["job_id"]).startswith(JOB_PREFIX)]
    if len(jobs) != 1:
        raise SystemExit(f"MISSING INPUT: job {JOB_PREFIX}* — found {len(jobs)} rows. Stopping.")
    job = jobs[0]
    job_id = job["job_id"]
    postcode, state = job.get("site_postcode"), job.get("site_state")

    roof = sizing_route._load_roof(client, job_id)
    if not roof or not roof.get("found") or roof.get("manual_entry_required"):
        raise SystemExit("MISSING INPUT: no usable roof_geometry row. Stopping.")
    planes = roof.get("planes") or []
    candidate_configs = roof.get("candidate_configs") or []
    lat, lon = roof.get("lat"), roof.get("lng")
    sp = roof.get("selected_panel") or {}
    panel = {"id": sp.get("id"), "watts": sp.get("watts")}
    if not planes or not candidate_configs or lat is None or lon is None or not panel["id"]:
        raise SystemExit("MISSING INPUT: roof row incomplete (planes/configs/latlng/panel). Stopping.")

    flags: list[str] = []
    utc_offset, _meta = sizing_route._time_base(state, flags)

    # Load — the ONE resolver's order: true interval series first, else the
    # stored representative profile. No silent synthetic data.
    load_hourly: Optional[list[float]] = None
    load_source = None
    iv = sizing_route._load_one(client, "interval_data", job_id,
                                "parsed_series_ref,coverage_days")
    if iv and iv.get("parsed_series_ref"):
        doc = sizing_route._download_series(client, iv["parsed_series_ref"])
        if doc is not None:
            import interval_parser
            built = interval_parser.series_to_8760(
                doc.get("series_by_date"), doc.get("average_day_kwh"),
                doc.get("annual_kwh"),
                annualised=bool((doc.get("coverage_days") or 0)
                                < interval_parser.ANNUALISED_THRESHOLD_DAYS))
            if len(built.get("hourly") or []) == 8760 and sum(built["hourly"]) > 0:
                load_hourly, load_source = built["hourly"], "tier3_actual"
    if load_hourly is None:
        lp = sizing_route._load_one(client, "load_profiles", job_id,
                                    "annual_kwh,daily_avg_kwh,hourly_profile_weights,accuracy_tier")
        if not lp or not (lp.get("annual_kwh") or lp.get("daily_avg_kwh")):
            raise SystemExit("MISSING INPUT: no interval series and no load profile. Stopping.")
        annual = lp.get("annual_kwh") or (lp.get("daily_avg_kwh") or 0) * 365
        load_hourly = solar_optimiser.expand_load_to_8760(
            float(annual), lp.get("hourly_profile_weights"))
        load_source = f"representative (tier {lp.get('accuracy_tier')})"

    # Tariff — stored envelope; rate_24 built by the endpoint's own builder.
    tar = sizing_route._read_tariff_row(client, job_id, flags)
    if not tar:
        raise SystemExit("MISSING INPUT: no tariffs row for the job. Stopping.")
    fit = tar.get("fit_aud_per_kwh")
    export_limit_kw = tar.get("export_limit_kw")
    if fit is None or export_limit_kw is None:
        raise SystemExit("MISSING INPUT: tariff row lacks fit / export limit. Stopping.")
    scalar = tar.get("import_rate")
    scalar = float(scalar) if scalar is not None else solar_optimiser.DEFAULT_IMPORT_RATE
    rate_24, is_tou = sizing_route._build_rate_24(
        None, tar.get("tou_windows"), None, scalar, flags)
    supply_charge = tar.get("supply_charge")
    supply_charge_annual = (float(supply_charge) * 365
                            if isinstance(supply_charge, (int, float)) else None)

    bats = (client.table("batteries").select("*").eq("status", "active")
            .eq("origin", "catalogue").execute().data or [])
    if not bats:
        raise SystemExit("MISSING INPUT: battery catalogue empty. Stopping.")
    bats.sort(key=lambda r: (str(r.get("brand")), str(r.get("model"))))

    return {
        "job_id": job_id, "postcode": postcode, "state": state,
        "planes": planes, "candidate_configs": candidate_configs,
        "lat": float(lat), "lon": float(lon), "panel": panel,
        "utc_offset": utc_offset, "load_hourly": load_hourly,
        "load_source": load_source, "rate_24": rate_24, "is_tou": is_tou,
        "fit": float(fit), "export_limit_kw": float(export_limit_kw),
        "supply_charge_annual": supply_charge_annual, "batteries": bats,
        "resolver_flags": flags,
    }


# ── Solar step (chosen config + its net 8,760, from CACHED PVGIS only) ────────
def run_solar_step(inp: dict, fin: dict) -> dict:
    global CACHE_MISSES_TOTAL
    flags: list[str] = []
    sres = solar_optimiser.optimise(
        roof_planes=inp["planes"], candidate_configs=inp["candidate_configs"],
        lat=inp["lat"], lon=inp["lon"], utc_offset_hours=inp["utc_offset"],
        panel=inp["panel"], load_hourly=inp["load_hourly"], rate_24=inp["rate_24"],
        fit=inp["fit"], export_limit_kw=inp["export_limit_kw"],
        objective="max_npv", fin=fin, postcode=inp["postcode"], state=inp["state"],
        installer_id=None, supply_charge_annual=inp["supply_charge_annual"],
        flags=flags,
    )
    CACHE_MISSES_TOTAL += sres["cache_misses"]
    chosen = sres["optimal"]
    watts = float(inp["panel"].get("watts") or 0.0)
    built = generation.build_plane_profiles(
        inp["planes"], inp["lat"], inp["lon"], inp["utc_offset"])
    CACHE_MISSES_TOTAL += built["cache_misses"]
    pr = fin["performance_ratio_non_temp"]
    net_planes = [{**p, "hourly_kwh_per_kwp": [v * pr for v in p["hourly_kwh_per_kwp"]]}
                  for p in built["planes"]]
    cfg = [{"plane_index": i, "kwp": chosen["panels_per_plane"][i] * watts / 1000.0}
           for i in chosen["plane_indices"]]
    s8760 = (generation.system_generation_for_config(net_planes, cfg)["hourly_kwh"]
             if cfg else [0.0] * 8760)
    return {"chosen": chosen, "s8760": s8760, "net_planes": net_planes,
            "solar_flags": flags, "n_configs": sres["n_configs_evaluated"]}


# ── Step 4 worker (top level for spawn) ───────────────────────────────────────
def _dispatch_worker(payload: tuple) -> dict:
    blocks, bat, fit, export_limit_kw = payload
    t0 = time.perf_counter()
    res = battery_optimiser.solve_candidate(blocks, bat, fit, export_limit_kw)
    dt = time.perf_counter() - t0
    if res is None:
        return {"ok": False, "seconds": dt}
    return {"ok": True, "seconds": dt, "cost": round(res["cost"], 6),
            "import": round(res["import"], 6), "discharge": round(res["discharge"], 6)}


# ── Step 5: the combined problem, built HERE ──────────────────────────────────
def _combined_worker(q, payload: dict) -> None:
    """Build + solve one combined solar-size+dispatch problem. Runs in its own
    process so the parent's watchdog can kill it — it must never hang."""
    try:
        profs = payload["plane_profiles"]      # per plane: {"limit", "prof"[8760]}
        load = payload["load_8760"]
        rate = payload["rate_24"]
        fit = payload["fit"]
        exl = payload["export_limit_kw"]
        bat = payload["bat"]
        capex = payload["capex_per_kw_year"]
        integer = payload["integer"]
        panel_kw = payload["panel_kw"]
        cutoff = payload["cutoff_s"]
        log_path = payload["log_path"]

        s = math.sqrt(bat["rte"])
        soc_min = (1.0 - bat["dod"]) * bat["usable"]
        soc_max = bat["usable"]
        maxc, maxd = bat["max_charge_kw"], bat["max_discharge_kw"]

        t_build0 = time.perf_counter()
        prob = pulp.LpProblem("combined_sizing", pulp.LpMinimize)

        size_vars = []
        for pi, p in enumerate(profs):
            if integer:
                v = pulp.LpVariable(f"n_{pi}", 0, p["panels_max"], cat="Integer")
            else:
                v = pulp.LpVariable(f"x_{pi}", 0, p["kwp_max"])
            size_vars.append(v)

        obj_terms = []
        n_days = 365
        for d in range(n_days):
            base = d * 24
            ch = [pulp.LpVariable(f"ch_{d}_{t}", 0, maxc) for t in range(24)]
            di = [pulp.LpVariable(f"di_{d}_{t}", 0, maxd) for t in range(24)]
            soc = [pulp.LpVariable(f"soc_{d}_{t}", soc_min, soc_max) for t in range(24)]
            gi = [pulp.LpVariable(f"gi_{d}_{t}", 0) for t in range(24)]
            ge = [pulp.LpVariable(f"ge_{d}_{t}", 0, exl) for t in range(24)]
            cu = [pulp.LpVariable(f"cu_{d}_{t}", 0) for t in range(24)]
            for t in range(24):
                h = base + t
                if integer:
                    sol_expr = pulp.lpSum(
                        size_vars[pi] * (panel_kw * profs[pi]["prof"][h])
                        for pi in range(len(profs)))
                else:
                    sol_expr = pulp.lpSum(
                        size_vars[pi] * profs[pi]["prof"][h] for pi in range(len(profs)))
                lod = load[h]
                prob += cu[t + 0] <= sol_expr
                prob += sol_expr - cu[t] + di[t] + gi[t] == lod + ch[t] + ge[t]
                prev = soc[t - 1] if t > 0 else soc[23]
                prob += soc[t] == prev + ch[t] * s - di[t] / s
                obj_terms.append(gi[t] * rate[t % 24] - ge[t] * fit)
        if integer:
            kw_expr = pulp.lpSum(v * panel_kw for v in size_vars)
        else:
            kw_expr = pulp.lpSum(size_vars)
        prob += pulp.lpSum(obj_terms) + capex * kw_expr
        t_build = time.perf_counter() - t_build0
        q.put(("built", {"build_s": t_build,
                         "n_vars": prob.numVariables(),
                         "n_int_vars": sum(1 for v in prob.variables()
                                           if v.cat == "Integer"),
                         "n_constraints": prob.numConstraints()}))

        t0 = time.perf_counter()
        prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=cutoff, logPath=log_path))
        wall = time.perf_counter() - t0
        status = pulp.LpStatus[prob.status]
        if integer:
            chosen = [int(round(v.value() or 0)) for v in size_vars]
            total_kw = round(sum(chosen) * panel_kw, 3)
        else:
            chosen = [round(v.value() or 0.0, 3) for v in size_vars]
            total_kw = round(sum(chosen), 3)
        q.put(("done", {"status": status, "solve_wall_s": wall,
                        "objective": (pulp.value(prob.objective)
                                      if prob.status == 1 else None),
                        "chosen_per_plane": chosen, "total_kw": total_kw}))
    except Exception as exc:  # noqa: BLE001
        q.put(("error", repr(exc)))


def run_combined(payload: dict, build_timeout_s: float = 600.0) -> dict:
    """Run one combined solve under a watchdog. A timeout is a RESULT."""
    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(target=_combined_worker, args=(q, payload))
    t_start = time.perf_counter()
    proc.start()
    result: dict = {"finished": False, "build": None, "solve": None, "error": None}
    try:
        try:
            tag, info = q.get(timeout=build_timeout_s)
        except Exception:
            result["error"] = f"build did not complete in {build_timeout_s:.0f} s — killed"
            return result
        if tag == "error":
            result["error"] = info
            return result
        result["build"] = info
        # CBC's own timeLimit should stop it; the watchdog is the backstop.
        try:
            tag, info = q.get(timeout=payload["cutoff_s"] + 120.0)
        except Exception:
            result["error"] = (f"did not finish in {payload['cutoff_s']:.0f} s "
                               "(watchdog killed the solver process)")
            return result
        if tag == "error":
            result["error"] = info
            return result
        result["solve"] = info
        result["finished"] = True
        return result
    finally:
        result["elapsed_total_s"] = time.perf_counter() - t_start
        if proc.is_alive():
            proc.terminate()
            proc.join(10)
            if proc.is_alive():
                proc.kill()
        proc.join(5)
        # Parse the CBC log if one was written.
        lp = payload.get("log_path")
        if lp and os.path.exists(lp):
            try:
                result["cbc_log"] = parse_cbc_log(open(lp).read())
            except Exception:  # noqa: BLE001
                result["cbc_log"] = None


def median(xs: list[float]) -> float:
    ys = sorted(xs)
    n = len(ys)
    return ys[n // 2] if n % 2 else (ys[n // 2 - 1] + ys[n // 2]) / 2.0


def fmt(x: Optional[float], nd: int = 3) -> str:
    return "n/a" if x is None else f"{x:.{nd}f}"


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    global REPEATS
    install_instrumentation()
    summary: dict = {}

    print("=" * 78)
    print("MEASURE: dispatch solve runtime — row 4.0 first task (reads only)")
    print("=" * 78)

    # Machine + toolchain
    def _sysctl(k: str) -> str:
        try:
            return subprocess.run(["sysctl", "-n", k], capture_output=True,
                                  text=True, timeout=10).stdout.strip()
        except Exception:  # noqa: BLE001
            return "?"
    machine = {
        "model": _sysctl("machdep.cpu.brand_string"),
        "hw_model": _sysctl("hw.model"),
        "physical_cores": int(_sysctl("hw.physicalcpu") or 0),
        "logical_cores": int(_sysctl("hw.logicalcpu") or 0),
        "performance_cores": _sysctl("hw.perflevel0.physicalcpu"),
        "efficiency_cores": _sysctl("hw.perflevel1.physicalcpu"),
        "memory_gb": round(int(_sysctl("hw.memsize") or 0) / 2**30, 1),
        "python": platform.python_version(),
        "pulp": pulp.__version__,
        "cbc": cbc_version(),
        "os": f"macOS/Darwin {platform.release()}",
    }
    summary["machine"] = machine
    print("\nMachine:", json.dumps(machine, indent=2))

    # Start table counts
    counts_start = table_counts()
    if counts_start is None:
        raise SystemExit("GENUINE ERROR: table counts unavailable "
                         "(SUPABASE_DB_URL/psycopg2) — the no-write proof "
                         "cannot run. Stopping before any measurement.")
    print(f"\nStart table counts ({len(counts_start)} public tables — the prompt "
          "said eighteen; the live schema has 24, all counted):")
    print(json.dumps(counts_start))

    client = sb_client()
    if client is None:
        raise SystemExit("GENUINE ERROR: Supabase client unavailable. Stopping.")

    inp = load_job_inputs(client)
    print(f"\nJob {inp['job_id']} ({inp['state']} {inp['postcode']}): "
          f"{len(inp['planes'])} planes, {len(inp['candidate_configs'])} candidate configs, "
          f"load={inp['load_source']}, TOU={inp['is_tou']}, fit={inp['fit']}, "
          f"export_limit={inp['export_limit_kw']} kW, "
          f"{len(inp['batteries'])} catalogue batteries")

    fin_flags: list[str] = []
    fin = solar_optimiser.load_financial_params(fin_flags)
    for f in fin_flags:
        print("  fin flag:", f)

    solar = run_solar_step(inp, fin)
    chosen = solar["chosen"]
    print(f"Chosen solar: {chosen['solar_kw']} kW, {chosen['panel_count']} panels, "
          f"planes {chosen['plane_indices']} (evaluated {solar['n_configs']} configs)")
    print(f"PVGIS cache misses so far: {CACHE_MISSES_TOTAL} (must be 0)")
    assert CACHE_MISSES_TOTAL == 0, "PVGIS cache miss — network call would have occurred"

    one_battery_row = next(r for r in inp["batteries"]
                           if (r.get("brand"), r.get("model")) == ("Tesla", "Powerwall 3"))
    spec_flags: list[str] = []
    bat = battery_optimiser.battery_specs(one_battery_row, spec_flags)
    print(f"Step-1 battery: {bat['name']} ({bat['usable']} kWh). The LP's size "
          "does not depend on which battery — only bounds change.")

    blocks_flags: list[str] = []
    blocks_full = battery_optimiser.build_blocks(
        solar["s8760"], inp["load_hourly"], inp["rate_24"], "full_year", blocks_flags)
    print(f"Full-year blocks: {len(blocks_full)} × 24 steps. flags={blocks_flags}")

    # ── TEST 1: the timer measures the solve, not the setup ──
    print("\n[T1] timer placement: 5-day horizon vs full year")
    blocks_tiny = battery_optimiser.build_blocks(
        solar["s8760"][:120], inp["load_hourly"][:120], inp["rate_24"],
        "full_year", [])
    battery_optimiser.solve_candidate(blocks_tiny, bat, inp["fit"], inp["export_limit_kw"])
    tiny_rec = SOLVE_RECORDS[-1]
    print(f"  tiny (5 days): total={fmt(tiny_rec['total'])} s "
          f"solve={fmt(tiny_rec['solve_wall'])} s build={fmt(tiny_rec['build'])} s")

    # ── STEP 1: one dispatch solve, split, repeated ──
    print(f"\n[STEP 1] optimise_battery, ONE battery, full_year, {REPEATS} repeats")
    step1_runs: list[dict] = []
    for i in range(REPEATS):
        n_before = len(SOLVE_RECORDS)
        t0 = time.perf_counter()
        res = battery_optimiser.optimise_battery(
            solar_8760=solar["s8760"], load_8760=inp["load_hourly"],
            rate_24=inp["rate_24"], fit=inp["fit"],
            export_limit_kw=inp["export_limit_kw"],
            battery_rows=[one_battery_row], fin=fin,
            solar_kw=chosen["solar_kw"], panel_id=inp["panel"]["id"],
            panel_count=chosen.get("panel_count"),
            solar_only_net_cost=chosen["system_cost"],
            solar_only_cost_breakdown=chosen.get("cost_breakdown"),
            postcode=inp["postcode"], state=inp["state"], installer_id=None,
            objective="max_npv", resolution="full_year", flags=[])
        total = time.perf_counter() - t0
        recs = SOLVE_RECORDS[n_before:]
        assert len(recs) == 1, f"expected 1 LP solve, saw {len(recs)}"
        r = recs[0]
        run = {"optimise_total": total, "lp_build": r["build"],
               "lp_solve_wall": r["solve_wall"], "lp_extract": r["extract"],
               "outside_lp": total - r["total"],
               "engine_solve_seconds": res["solve_seconds"]}
        step1_runs.append(run)
        print(f"  run {i+1}: optimise_total={fmt(total)} s | LP build={fmt(r['build'])} "
              f"solve={fmt(r['solve_wall'])} extract={fmt(r['extract'])} "
              f"| outside-LP (blocks+baseline+costing+financials, incl. "
              f"Supabase reads)={fmt(run['outside_lp'])}")
        if i == 0 and total * REPEATS > 20 * 60:
            REPEATS = 3
            print(f"  BUDGET: first run {total:.1f} s — repeats shrunk 5 -> 3 "
                  "(the repeat count was shrunk, not the cut-offs)")
    s1 = {k: {"median": median([r[k] for r in step1_runs]),
              "min": min(r[k] for r in step1_runs),
              "max": max(r[k] for r in step1_runs)}
          for k in step1_runs[0]}
    summary["step1"] = {"runs": step1_runs, "stats": s1,
                        "battery": bat["name"], "n_repeats": len(step1_runs)}
    print("  MEDIAN/MIN/MAX:")
    for k, v in s1.items():
        print(f"    {k}: {fmt(v['median'])} / {fmt(v['min'])} / {fmt(v['max'])}")

    # T1 verdict now that the full-year number exists
    full_solve = s1["lp_solve_wall"]["median"]
    t1_ok = (tiny_rec["solve_wall"] or 0) < 0.5 * full_solve
    print(f"[T1] tiny solve {fmt(tiny_rec['solve_wall'])} s vs full-year "
          f"{fmt(full_solve)} s -> falls accordingly: {t1_ok}")
    assert t1_ok, "timer did not fall with the horizon — timer is in the wrong place"

    # CBC's own reported time — one extra instrumented run (logPath injected at
    # runtime; the engine file is untouched).
    print("\n[STEP 1b] CBC self-reported time (one instrumented run, logPath)")
    log_path = os.path.join(tempfile.gettempdir(), "cbc_dispatch_log.txt")
    _real_cmd = pulp.PULP_CBC_CMD

    def _logging_cmd(*a, **kw):
        kw["logPath"] = log_path
        return _real_cmd(*a, **kw)

    pulp.PULP_CBC_CMD = _logging_cmd
    try:
        battery_optimiser.solve_candidate(blocks_full, bat, inp["fit"],
                                          inp["export_limit_kw"])
    finally:
        pulp.PULP_CBC_CMD = _real_cmd
    inst = SOLVE_RECORDS[-1]
    cbc_self = parse_cbc_log(open(log_path).read()) if os.path.exists(log_path) else {}
    summary["step1b"] = {"instrumented": inst, "cbc": cbc_self}
    print(f"  prob.solve() wall={fmt(inst['solve_wall'])} s; CBC reports "
          f"cpu={fmt(cbc_self.get('cpu_s'))} s wall={fmt(cbc_self.get('wall_s'))} s "
          f"({cbc_self.get('result_line')})")
    if cbc_self.get("wall_s") is not None and inst["solve_wall"]:
        overhead = inst["solve_wall"] - cbc_self["wall_s"]
        print(f"  => file write + process start + solution parse ≈ {fmt(overhead)} s "
              f"({100*overhead/inst['solve_wall']:.0f}% of prob.solve())")

    # ── STEP 2: horizon scaling ──
    print("\n[STEP 2] horizon scaling (module's own block builder)")
    step2 = []
    for label, days in (("1 month", 31), ("3 months", 90), ("12 months", 365)):
        h = days * 24
        blks = battery_optimiser.build_blocks(
            solar["s8760"][:h], inp["load_hourly"][:h], inp["rate_24"],
            "full_year", [])
        battery_optimiser.solve_candidate(blks, bat, inp["fit"], inp["export_limit_kw"])
        r = SOLVE_RECORDS[-1]
        step2.append({"label": label, "days": days, "total": r["total"],
                      "build": r["build"], "solve_wall": r["solve_wall"]})
        print(f"  {label:9s} ({len(blks)} blocks): total={fmt(r['total'])} s "
              f"build={fmt(r['build'])} solve={fmt(r['solve_wall'])}")
    lg = [(math.log(x["days"]), math.log(x["total"])) for x in step2]
    slope = ((lg[-1][1] - lg[0][1]) / (lg[-1][0] - lg[0][0])) if lg[-1][0] != lg[0][0] else None
    growth = ("roughly linear" if slope is not None and slope <= 1.25
              else "worse than linear")
    summary["step2"] = {"points": step2, "loglog_slope": slope, "growth": growth}
    print(f"  log-log slope (1->12 months): {fmt(slope, 2)} => {growth}")

    # ── STEP 3: how many solves a combined SEARCH would need (counting) ──
    print("\n[STEP 3] combined-search solve counts (counting, not solving)")
    n_configs_now = len(inp["candidate_configs"])
    roof_max_panels = sum(int(p.get("panel_count") or 0) for p in inp["planes"])
    n_configs_fine = roof_max_panels  # every whole panel count 1..max
    n_bat_now = len(inp["batteries"])
    per_solve = s1["lp_solve_wall"]["median"] + s1["lp_build"]["median"] + s1["lp_extract"]["median"]
    tbl = []
    for cfg_label, n_cfg in ((f"current roof ({n_configs_now} configs)", n_configs_now),
                             (f"finer 1..{roof_max_panels} panels", n_configs_fine)):
        for nb in (n_bat_now, 50):
            n = n_cfg * nb
            tbl.append({"configs": cfg_label, "batteries": nb, "solves": n,
                        "serial_s": n * per_solve})
            print(f"  {cfg_label:32s} × {nb:2d} batteries = {n:5d} solves "
                  f"≈ {n*per_solve:8.1f} s serial ({n*per_solve/60:6.1f} min)")
    summary["step3"] = {"per_solve_candidate_s": per_solve,
                        "roof_max_panels": roof_max_panels, "table": tbl}

    # ── STEP 4: does it parallelise? ──
    print("\n[STEP 4] parallelism: 10 independent solves, serial vs process pool")
    from concurrent.futures import ProcessPoolExecutor
    n_workers = machine["physical_cores"] or 4
    tasks = []
    for i in range(10):
        row = inp["batteries"][i % len(inp["batteries"])]
        b = battery_optimiser.battery_specs(dict(row), [])
        tasks.append((blocks_full, b, inp["fit"], inp["export_limit_kw"]))
    t0 = time.perf_counter()
    serial = [_dispatch_worker(t) for t in tasks]
    serial_wall = time.perf_counter() - t0
    import multiprocessing as mp
    with ProcessPoolExecutor(max_workers=n_workers,
                             mp_context=mp.get_context("spawn")) as pool:
        t0 = time.perf_counter()
        par = list(pool.map(_dispatch_worker, tasks))
        par_wall = time.perf_counter() - t0
    same = all(a.get("cost") == b.get("cost") and a.get("import") == b.get("import")
               and a.get("discharge") == b.get("discharge")
               and a["ok"] and b["ok"] for a, b in zip(serial, par))
    speedup = serial_wall / par_wall if par_wall > 0 else None
    summary["step4"] = {"n_tasks": 10, "workers": n_workers,
                        "serial_wall_s": serial_wall, "parallel_wall_s": par_wall,
                        "speedup": speedup, "answers_identical": same}
    print(f"  serial: {serial_wall:.1f} s | parallel ({n_workers} workers): "
          f"{par_wall:.1f} s | speedup ×{fmt(speedup, 2)} | identical answers: {same}")
    assert same, "serial and parallel runs disagree — the parallel measurement is not real"

    # ── STEP 5: the combined problem ──
    print("\n[STEP 5] combined solar-size + dispatch, built in this script")
    # Linear solar capex from the job's own chosen system: $/kW × CRF.
    d, N = fin["discount_rate"], fin["analysis_years"]
    crf = d * (1 + d) ** N / ((1 + d) ** N - 1)
    cost_per_kw = (chosen["system_cost"] / chosen["solar_kw"]
                   if chosen["solar_kw"] > 0 else 1000.0)
    capex_per_kw_year = cost_per_kw * crf
    panel_kw = float(inp["panel"]["watts"]) / 1000.0
    profs = []
    for p, plane in zip(solar["net_planes"], inp["planes"]):
        profs.append({"kwp_max": float(plane.get("kwp") or 0.0),
                      "panels_max": int(plane.get("panel_count") or 0),
                      "prof": p["hourly_kwh_per_kwp"]})
    base_payload = {
        "plane_profiles": profs, "load_8760": inp["load_hourly"],
        "rate_24": inp["rate_24"], "fit": inp["fit"],
        "export_limit_kw": inp["export_limit_kw"], "bat": bat,
        "capex_per_kw_year": capex_per_kw_year, "panel_kw": panel_kw,
        "cutoff_s": CUTOFF_S,
    }
    print(f"  capex term: ${cost_per_kw:,.0f}/kW × CRF {crf:.4f} = "
          f"${capex_per_kw_year:,.2f}/kW/year; battery fixed: {bat['name']}")

    # TEST 2: prove the cut-off works — 1 s against the MIXED-INTEGER version.
    print("\n[T2] cut-off proof: 1 s limit against the integer version")
    t2_payload = dict(base_payload)
    t2_payload.update({"integer": True, "cutoff_s": 1.0,
                       "log_path": os.path.join(tempfile.gettempdir(), "cbc_t2.txt")})
    t2 = run_combined(t2_payload)
    if t2["finished"]:
        st = t2["solve"]["status"]
        if t2["solve"]["solve_wall_s"] <= 30.0 and st != "Optimal":
            print(f"  cut-off ENGAGED: status={st} after "
                  f"{fmt(t2['solve']['solve_wall_s'], 1)} s — reported as a "
                  "timeout, no hang, no crash. PASS")
        elif st == "Optimal":
            print(f"  no timeout was produced: CBC solved the integer problem "
                  f"at the root node in {fmt(t2['solve']['solve_wall_s'], 2)} s "
                  "DESPITE the 1 s limit — CBC checks its -sec limit during "
                  "branch-and-bound, and a solve that completes at the root "
                  "before the first check cannot be truncated. Nothing hung, "
                  "nothing crashed; the watchdog layer (kill at cut-off + "
                  "120 s) is exercised by construction on every run but was "
                  "not needed. The truncation itself could NOT be "
                  "demonstrated on a problem this easy — stated plainly, "
                  "not claimed.")
        else:
            print(f"  status={st} wall={fmt(t2['solve']['solve_wall_s'], 1)} s")
    else:
        print(f"  worker result: {t2['error']} — reported as a result, not a crash. PASS")
    print("  cut-off RESTORED to 120 s for the real runs (the 1 s value was a "
          "parameter to one call, nothing persistent).")

    for label, integer in (("(a) continuous kW", False), ("(b) whole panels", True)):
        pl = dict(base_payload)
        pl.update({"integer": integer,
                   "log_path": os.path.join(tempfile.gettempdir(),
                                            f"cbc_combined_{'b' if integer else 'a'}.txt")})
        print(f"\n  combined {label}: building + solving (cut-off {CUTOFF_S:.0f} s)…")
        r = run_combined(pl)
        summary.setdefault("step5", {})[label] = r
        if r["build"]:
            b = r["build"]
            print(f"    problem: {b['n_vars']} vars ({b['n_int_vars']} integer), "
                  f"{b['n_constraints']} constraints, build {fmt(b['build_s'], 1)} s")
        if r["finished"]:
            sv = r["solve"]
            log = r.get("cbc_log") or {}
            print(f"    status={sv['status']} solve={fmt(sv['solve_wall_s'], 2)} s "
                  f"total_kw={sv['total_kw']} per-plane={sv['chosen_per_plane']}")
            print(f"    CBC: {log.get('result_line')} nodes={log.get('nodes')} "
                  f"iterations={log.get('iterations')} cpu={fmt(log.get('cpu_s'))} s")
        else:
            print(f"    RESULT: {r['error']}")

    # ── End: no-write proof ──
    counts_end = table_counts()
    delta = {t: counts_end[t] - counts_start[t] for t in counts_start
             if counts_end[t] != counts_start[t]}
    print(f"\nEnd table counts: {json.dumps(counts_end)}")
    print(f"Delta: {delta if delta else 'ZERO across all 24 public tables'}")
    assert not delta, f"table counts changed: {delta}"
    print(f"PVGIS cache misses TOTAL: {CACHE_MISSES_TOTAL} (asserted zero — no "
          f"PVGIS network call was made); cache_put invocations: {CACHE_PUT_CALLS}")
    assert CACHE_MISSES_TOTAL == 0

    summary["cache_misses"] = CACHE_MISSES_TOTAL
    summary["counts_delta_zero"] = True
    summary["elapsed_total_s"] = time.perf_counter() - SCRIPT_T0
    print(f"\nTotal script wall time: {summary['elapsed_total_s']:.1f} s "
          f"(budget {WALL_BUDGET_S} s)")
    print("\nSUMMARY_JSON_BEGIN")
    print(json.dumps(summary, default=str))
    print("SUMMARY_JSON_END")


if __name__ == "__main__":
    main()
