#!/usr/bin/env python3
"""
verify_results_contract.py — the 3.13 prompt-1 gate: the engine stops
discarding. The chosen system's itemised cost breakdown, its panel layout per
roof face, and the daily supply charge are kept, returned and stored; the
battery endpoint returns within_budget from the one number its own filter
tests.

  R1  financials() with and without a supply charge, same inputs: the three
      recommendation figures (annual_savings / simple_payback_years /
      npv_25yr) are EQUAL to the cent, and annual_bill_before differs by
      exactly the charge. WHY IT MOVES: the charge is paid with or without
      the system, so if it ever leaks into the savings the equality breaks.
  R2  the supply-charge edge inputs (None, 0.0, negative, NaN):
      bill_includes_supply_charge is False for None and NaN (and negative —
      a negative daily charge is not a charge), True for 0.0, no branch
      raises. A missing charge is a different fact from a zero charge.
  R3  optimise() on a synthetic two-plane roof from cached PVGIS profiles:
      every score_curve point carries plane_indices / panels_per_plane /
      panel_count, chosen_index is an int naming the optimum, and the kept
      breakdown's net_cost rounds to the system_cost already in use.
  R4  THE RED PROOF: the same run with a deliberately mismatched cost, in a
      SUBPROCESS against a sabotaged copy of solar_optimiser.py — R3's
      net-cost assertion is SHOWN failing, then the file is restored FROM THE
      BYTE COPY made first (never from git — the tree carries this task's
      other edits), verified by SHA-256, __pycache__ deleted before each run.
  R5  optimise_battery() on the job-free fixture that actually chooses a
      battery: every candidate carries within_budget ==
      (budget is None) or (system_cost <= budget), and the no-battery
      baseline carries the cost_breakdown that was passed in.
  R6  the same fixture under a budget that cuts SOME but not all candidates:
      within_budget is False on at least one and True on at least one, and
      cache_misses == 0 — this gate can never start calling the network.
  R7  BOTH endpoints against the LIVE fixture job with the writer
      monkey-patched to a recorder (the verify_sizing_result_storage.py
      pattern), NOTHING written: each persisted evaluated_options carries
      chosen_cost_breakdown, and the battery one carries chosen_solar with a
      non-empty plane_indices.
  R8  the two supply-charge branches on the two REAL jobs, read-only: the
      fixture job's stored tariff carries a charge and the other sized job's
      does not (asserted from the live rows, so both branches provably run on
      live data). The assumptions block reports a number for the first and
      "not stated" for the second; supply_charge_unknown appears only for the
      second.
  RC  the database delta (F77): fourteen counts read at start, asserted
      unchanged at the end — never an absolute count.

RUNS the code, never parses it (F148) — except R4, which edits and RESTORES
solar_optimiser.py by design, byte-hash verified, inside a try/finally.
WRITES NOTHING to the database.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_results_contract.py
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPTS_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import battery_optimiser  # noqa: E402
import capture  # noqa: E402
import generation  # noqa: E402
import solar_irradiance  # noqa: E402
import solar_optimiser  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0
SKIPPED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


def skip(msg: str) -> None:
    global SKIPPED
    SKIPPED += 1
    print(f"  SKIP  {msg} NOT counted as a pass.")


# The two REAL jobs (R7/R8). TOU_JOB's stored tariff carries a 1.05 $/day
# supply charge; NULL_JOB's carries NULL — asserted live in R8, never assumed.
TOU_JOB = "a57e13f1-24f2-48e3-b816-8a08cb6b2fed"
NULL_JOB = "456e0242-17f9-4b2a-8faa-f664ddd9eed9"

# ── The synthetic fixture (the verify_battery_contract.py B1 site) ───────────
# Built entirely from profiles ALREADY IN pvgis_cache; lat/lon are exact
# GRID_DEG multiples so the cache keys resolve to the two Adelaide rows.
FIX_LAT, FIX_LON = -34.93, 138.60
FIX_TILT = 22.0
FIX_PANEL_ID = "7ea2822f-2293-42b0-a511-88d33843699b"  # Jinko 440 W, priced
FIX_PANEL_W = 440
FIX_ANNUAL_LOAD_KWH = 14000.0
FIX_LOAD_SHAPE = ([0.2] * 6 + [0.4, 0.6, 0.5, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,
                               0.5, 0.8, 2.2, 3.2, 3.2, 2.6, 1.6, 0.8, 0.4])
FIX_RATE_24 = [0.45] * 24
FIX_FIT = 0.05
FIX_EXPORT_LIMIT_KW = 5.0

# financials()/optimise() read exactly these five keys; hardcoded so R1-R6
# run with no dependency on cost_assumptions being reachable.
FIN = {"performance_ratio_non_temp": 0.88, "discount_rate": 0.055,
       "analysis_years": 25, "degradation_annual_pct": 0.5,
       "tariff_escalation_pct": 0.0}


def _fixture_planes() -> tuple[list[dict], list[dict], list[float]]:
    """The two-plane roof + candidate configs + azimuths, azimuths DERIVED by
    running the converter over every whole degree (a value not derived is a
    value that cannot be defended). Pure — the caller asserts uniqueness."""
    azs = []
    for aspect in (-180.0, -90.0):
        hits = [g for g in range(360)
                if solar_irradiance.google_azimuth_to_pvgis_aspect(float(g))
                == aspect]
        azs.append(hits)
    planes = [
        {"pitch": FIX_TILT, "azimuth": float(azs[0][0]) if azs[0] else 0.0,
         "panel_count": 24, "kwp": round(24 * FIX_PANEL_W / 1000.0, 2)},
        {"pitch": FIX_TILT, "azimuth": float(azs[1][0]) if azs[1] else 0.0,
         "panel_count": 12, "kwp": round(12 * FIX_PANEL_W / 1000.0, 2)},
    ]
    configs = [{"plane_indices": [0]}, {"plane_indices": [0, 1]}]
    return planes, configs, azs


def _fixture_load() -> list[float]:
    total = sum(FIX_LOAD_SHAPE)
    frac = [x / total for x in FIX_LOAD_SHAPE]
    daily = FIX_ANNUAL_LOAD_KWH / 365.0
    return [daily * frac[h] for _ in range(365) for h in range(24)]


def _run_fixture_optimise() -> dict:
    """The R3 run — also executed by the R4 subprocess probe against the
    sabotaged file, so it must stay pure and offline (cache_put no-opped)."""
    planes, configs, _ = _fixture_planes()
    original_cache = generation._cache_put
    generation._cache_put = lambda *a, **k: None
    try:
        return solar_optimiser.optimise(
            roof_planes=planes, candidate_configs=configs,
            lat=FIX_LAT, lon=FIX_LON, utc_offset_hours=9.5,
            panel={"id": FIX_PANEL_ID, "watts": FIX_PANEL_W},
            load_hourly=_fixture_load(), rate_24=list(FIX_RATE_24),
            fit=FIX_FIT, export_limit_kw=FIX_EXPORT_LIMIT_KW,
            objective="max_npv", fin=dict(FIN), postcode="5000", state="SA",
            installer_id=None, flags=[],
        )
    finally:
        generation._cache_put = original_cache


def subprocess_probe() -> dict:
    """Called by the R4 runner in a FRESH interpreter, where solar_optimiser
    was imported from whatever bytes are on disk. Returns the facts R4 needs."""
    res = _run_fixture_optimise()
    opt = res["optimal"]
    bd = opt.get("cost_breakdown")
    net = bd.get("net_cost") if isinstance(bd, dict) else None
    return {
        "net": net,
        "system_cost": opt.get("system_cost"),
        "match": net is not None and round(net, 2) == opt.get("system_cost"),
        "disagree_flag": any(str(f).startswith("cost_breakdown_disagrees")
                             for f in res.get("flags", [])),
        "cache_misses": res.get("cache_misses"),
    }


# ── RC: the fourteen counts, direct Postgres (F77) ────────────────────────────
_PUBLIC_TABLES = ["companies", "company_members", "jobs", "roof_geometry",
                  "interval_data", "bills", "surveys", "load_profiles",
                  "tariffs", "sizing_results", "financial_results",
                  "pvgis_cache"]


def _counts() -> dict | None:
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        psycopg2 = None
    if not db_url or psycopg2 is None:
        skip("(RC) the fourteen counts need SUPABASE_DB_URL + psycopg2 "
             "(auth.users and storage.objects are not REST-visible).")
        return None
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    out: dict = {}
    cur.execute("select count(*) from auth.users")
    out["auth.users"] = cur.fetchone()[0]
    for t in _PUBLIC_TABLES:
        cur.execute(f"select count(*) from public.{t}")
        out[t] = cur.fetchone()[0]
    cur.execute("select count(*) from storage.objects where bucket_id = 'bills'")
    out["bills bucket"] = cur.fetchone()[0]
    conn.close()
    return out


# ── R1 / R2: financials, offline ──────────────────────────────────────────────
_R1_ARGS = dict(self_consumed_value=800.0, load_value=2500.0,
                import_value=1700.0, export=3000.0, fit=0.05,
                system_cost=10000.0, fin=FIN)


def t_r1() -> None:
    print("R1. the supply charge joins the bills and CANCELS in the "
          "recommendation figures")
    base = solar_optimiser.financials(**_R1_ARGS, supply_charge_annual=None)
    sc = 383.25
    with_sc = solar_optimiser.financials(**_R1_ARGS, supply_charge_annual=sc)
    for key in ("annual_savings", "simple_payback_years", "npv_25yr"):
        check(f"(R1) {key} is EQUAL to the cent with and without the charge — "
              "the charge is paid with or without the system, so a difference "
              "here means it leaked into the recommendation",
              base[key] == with_sc[key],
              f"without={base[key]} with={with_sc[key]}")
    check("(R1) annual_bill_before differs by EXACTLY the charge",
          round(with_sc["annual_bill_before"] - base["annual_bill_before"], 2)
          == sc,
          f"{base['annual_bill_before']} -> {with_sc['annual_bill_before']}")
    check("(R1) annual_bill_after differs by EXACTLY the charge too — both "
          "bills carry it, which is WHY the difference cancels",
          round(with_sc["annual_bill_after"] - base["annual_bill_after"], 2)
          == sc,
          f"{base['annual_bill_after']} -> {with_sc['annual_bill_after']}")
    check("(R1) the charged run says so: annual_supply_charge == 383.25 and "
          "bill_includes_supply_charge is True",
          with_sc["annual_supply_charge"] == sc
          and with_sc["bill_includes_supply_charge"] is True,
          f"{with_sc['annual_supply_charge']} / "
          f"{with_sc['bill_includes_supply_charge']}")
    check("(R1) the uncharged run says so too: annual_supply_charge is None "
          "and bill_includes_supply_charge is False — a missing charge is "
          "never a zero charge",
          base["annual_supply_charge"] is None
          and base["bill_includes_supply_charge"] is False,
          f"{base['annual_supply_charge']} / "
          f"{base['bill_includes_supply_charge']}")


def t_r2() -> None:
    print("\nR2. the edge inputs: None, 0.0, negative, NaN — no branch raises")
    cases = [(None, False), (0.0, True), (-1.0, False), (float("nan"), False)]
    for value, want_flag in cases:
        label = "NaN" if isinstance(value, float) and value != value else repr(value)
        try:
            out = solar_optimiser.financials(**_R1_ARGS,
                                             supply_charge_annual=value)
            err = None
        except Exception as ex:  # noqa: BLE001
            out, err = None, f"{type(ex).__name__}: {ex}"
        check(f"(R2) supply_charge_annual={label}: does not raise",
              err is None, str(err))
        if out is None:
            continue
        check(f"(R2) supply_charge_annual={label}: "
              f"bill_includes_supply_charge is {want_flag}",
              out["bill_includes_supply_charge"] is want_flag,
              repr(out["bill_includes_supply_charge"]))
        if want_flag:
            check(f"(R2) supply_charge_annual={label}: annual_supply_charge "
                  "is the number (0.0 is a KNOWN charge of zero)",
                  out["annual_supply_charge"] == round(float(value), 2),
                  repr(out["annual_supply_charge"]))
        else:
            check(f"(R2) supply_charge_annual={label}: annual_supply_charge "
                  "is None and the bills stay energy-only",
                  out["annual_supply_charge"] is None
                  and out["annual_bill_before"] == round(
                      _R1_ARGS["load_value"], 2),
                  f"{out['annual_supply_charge']} / "
                  f"{out['annual_bill_before']}")


# ── R3: the fixture optimise run ─────────────────────────────────────────────
def t_r3() -> dict | None:
    print("\nR3. optimise() keeps the layout and the breakdown — synthetic "
          "two-plane roof, cached profiles")
    _planes, _configs, azs = _fixture_planes()
    check("(R3/fixture) exactly one whole-degree Google azimuth produces each "
          "PVGIS aspect (-180 north, -90 east) — derived, not typed",
          len(azs[0]) == 1 and len(azs[1]) == 1, f"{azs}")
    check("(R3/fixture) lat/lon are exact GRID_DEG multiples — the cache keys "
          "are the ones intended",
          generation._grid(FIX_LAT) == FIX_LAT
          and generation._grid(FIX_LON) == FIX_LON,
          f"{generation._grid(FIX_LAT)}, {generation._grid(FIX_LON)}")

    res = _run_fixture_optimise()
    check("(R3) the run answered from cache — cache_misses == 0, no failed "
          "planes (the gate never calls PVGIS)",
          res.get("cache_misses") == 0 and res.get("failed_planes") == [],
          f"misses={res.get('cache_misses')} failed={res.get('failed_planes')}")

    curve = res.get("score_curve") or []
    missing = [i for i, p in enumerate(curve)
               if not ("plane_indices" in p and "panels_per_plane" in p
                       and "panel_count" in p)]
    check("(R3) EVERY score_curve point carries plane_indices, "
          "panels_per_plane and panel_count",
          bool(curve) and not missing,
          f"{len(curve)} points, missing on {missing}")
    cidx = res.get("chosen_index")
    opt = res.get("optimal") or {}
    check("(R3) chosen_index is an int naming a curve point",
          isinstance(cidx, int) and not isinstance(cidx, bool)
          and 0 <= cidx < len(curve), repr(cidx))
    check("(R3) score_curve[chosen_index].solar_kw == optimal.solar_kw",
          isinstance(cidx, int) and 0 <= cidx < len(curve)
          and curve[cidx].get("solar_kw") == opt.get("solar_kw"),
          f"curve={curve[cidx].get('solar_kw') if isinstance(cidx, int) and 0 <= cidx < len(curve) else None} "
          f"optimal={opt.get('solar_kw')}")
    bd = opt.get("cost_breakdown")
    check("(R3) optimal.cost_breakdown is the whole itemised dict "
          "(line_items and net_cost present)",
          isinstance(bd, dict) and isinstance(bd.get("line_items"), list)
          and "net_cost" in bd,
          f"{sorted(bd) if isinstance(bd, dict) else bd!r}")
    check("(R3) optimal.cost_breakdown.net_cost ROUNDS TO optimal.system_cost "
          "— two views of one figure agree (R4 proves this can fail)",
          isinstance(bd, dict)
          and round(bd.get("net_cost") or 0, 2) == opt.get("system_cost"),
          f"net={bd.get('net_cost') if isinstance(bd, dict) else None} "
          f"system_cost={opt.get('system_cost')}")
    empty = next((p for p in curve if p.get("solar_kw") == 0
                  and not p.get("plane_indices")), None)
    check("(R3) the empty/no-solar point exists in the curve with panel_count "
          "0 — 'no system' stays distinguishable",
          isinstance(empty, dict) and empty.get("panel_count") == 0,
          repr(empty))
    check("(R3) no cost_breakdown_disagrees flag on the healthy run — the "
          "in-engine assertion is quiet when the two views agree",
          not any(str(f).startswith("cost_breakdown_disagrees")
                  for f in res.get("flags", [])),
          str(res.get("flags")))
    return res


# ── R4: the red proof, subprocess against a sabotaged file ───────────────────
_SABOTAGE_FROM = '            system_cost = cost["net_cost"]\n'
_SABOTAGE_TO = '            system_cost = cost["net_cost"] + 100.0\n'


def _probe_via_subprocess() -> dict | None:
    """Fresh interpreter, fresh import of whatever solar_optimiser.py holds."""
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {SCRIPTS_DIR!r})\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import verify_results_contract as g\n"
        "print('PROBE:' + json.dumps(g.subprocess_probe()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", runner],
                          capture_output=True, text=True, timeout=600)
    for line in proc.stdout.splitlines():
        if line.startswith("PROBE:"):
            return json.loads(line[len("PROBE:"):])
    print(f"        probe stdout: {proc.stdout[-400:]!r}")
    print(f"        probe stderr: {proc.stderr[-400:]!r}")
    return None


def _rm_pycache() -> None:
    shutil.rmtree(os.path.join(BACKEND_DIR, "__pycache__"),
                  ignore_errors=True)


def t_r4() -> None:
    print("\nR4. THE RED PROOF — a deliberately mismatched cost makes R3's "
          "net-cost assertion FAIL, then the file is restored byte-for-byte")
    target = os.path.join(BACKEND_DIR, "solar_optimiser.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")

    text = original.decode("utf-8")
    n = text.count(_SABOTAGE_FROM)
    check("(R4) the sabotage line exists EXACTLY once in solar_optimiser.py",
          n == 1, f"count={n}")
    if n != 1:
        return

    tmpdir = tempfile.mkdtemp(prefix="r4_")
    backup = os.path.join(tmpdir, "solar_optimiser.py.bak")
    shutil.copyfile(target, backup)
    check("(R4) the byte copy was taken FIRST and matches the original hash",
          hashlib.sha256(open(backup, "rb").read()).hexdigest()
          == original_hash, backup)

    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_SABOTAGE_FROM, _SABOTAGE_TO))
        _rm_pycache()
        red = _probe_via_subprocess()
        print(f"        sabotaged probe: {red}")
        check("(R4) RED: against the sabotaged engine the net-cost assertion "
              "FAILS — net_cost no longer rounds to system_cost",
              isinstance(red, dict) and red.get("match") is False,
              repr(red))
        check("(R4) RED: ...and the in-engine flag fires, naming the "
              "disagreement rather than silently preferring one number",
              isinstance(red, dict) and red.get("disagree_flag") is True,
              repr(red))
    finally:
        # Restore FROM THE COPY (never from git — the tree carries this
        # task's other edits), then prove it by hash.
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"        restored SHA-256: {restored_hash}")
    check("(R4) RESTORED: the file on disk is byte-identical to the one "
          "tested (SHA-256 equal)",
          restored_hash == original_hash,
          f"{restored_hash} != {original_hash}")
    green = _probe_via_subprocess()
    print(f"        restored probe : {green}")
    check("(R4) GREEN AGAIN: the restored engine passes the same assertion, "
          "with no disagreement flag",
          isinstance(green, dict) and green.get("match") is True
          and green.get("disagree_flag") is False,
          repr(green))
    shutil.rmtree(tmpdir, ignore_errors=True)


# ── R5 / R6: optimise_battery on the fixture ─────────────────────────────────
def _fixture_solar_8760(opt3: dict) -> tuple[list[float], dict]:
    """The chosen config's net 8,760 — the _solar_chosen reconstruction."""
    planes, _configs, _ = _fixture_planes()
    original_cache = generation._cache_put
    generation._cache_put = lambda *a, **k: None
    try:
        built = generation.build_plane_profiles(planes, FIX_LAT, FIX_LON, 9.5)
    finally:
        generation._cache_put = original_cache
    pr = FIN["performance_ratio_non_temp"]
    net = [{**p, "hourly_kwh_per_kwp": [v * pr for v in p["hourly_kwh_per_kwp"]]}
           for p in built["planes"]]
    cfg = [{"plane_index": i,
            "kwp": opt3["panels_per_plane"][i] * FIX_PANEL_W / 1000.0}
           for i in opt3["plane_indices"]]
    s8760 = (generation.system_generation_for_config(net, cfg)["hourly_kwh"]
             if cfg else [0.0] * solar_optimiser.HOURS)
    return s8760, built


def _run_fixture_battery(opt3: dict, s8760: list[float], catalogue: list[dict],
                         budget) -> dict:
    return battery_optimiser.optimise_battery(
        solar_8760=s8760, load_8760=_fixture_load(),
        rate_24=list(FIX_RATE_24), fit=FIX_FIT,
        export_limit_kw=FIX_EXPORT_LIMIT_KW, battery_rows=catalogue,
        fin=dict(FIN), solar_kw=opt3["solar_kw"], panel_id=FIX_PANEL_ID,
        panel_count=opt3["panel_count"],
        solar_only_net_cost=opt3["system_cost"],
        solar_only_cost_breakdown=opt3["cost_breakdown"],
        postcode="5000", state="SA", installer_id=None, objective="max_npv",
        budget=budget, flags=[],
    )


def _wb_arithmetic(label: str, cands: list[dict], budget) -> None:
    missing = [c for c in cands if not isinstance(c.get("within_budget"), bool)]
    check(f"({label}) every candidate carries a boolean within_budget "
          "(the no-battery baseline included)",
          bool(cands) and not missing,
          f"{len(missing)} of {len(cands)} missing/non-bool")
    wrong = [c for c in cands
             if isinstance(c.get("within_budget"), bool)
             and c["within_budget"] != ((budget is None)
                                        or (c.get("system_cost", 0) <= budget))]
    check(f"({label}) every within_budget == (budget is None) or "
          f"(system_cost <= budget), recomputed under budget={budget}",
          bool(cands) and not wrong,
          f"{len(wrong)} wrong; first: {wrong[0] if wrong else None}")


def t_r5_r6(client, opt3: dict) -> None:
    print("\nR5. optimise_battery keeps within_budget and the breakdowns — "
          "job-free fixture that chooses a battery")
    s8760, built = _fixture_solar_8760(opt3)
    check("(R5/fixture) the generation build hit cache only — misses 0, "
          "failures none",
          built["cache_misses"] == 0 and built["failed_planes"] == [],
          f"misses={built['cache_misses']} failed={built['failed_planes']}")
    catalogue = (client.table("batteries").select("*")
                 .eq("status", "active").eq("origin", "catalogue")
                 .execute().data) or []
    check("(R5/fixture) at least two catalogue batteries exist — R6 needs a "
          "cap that can cut SOME but not all",
          len(catalogue) >= 2, f"{len(catalogue)} rows")

    r5 = _run_fixture_battery(opt3, s8760, catalogue, budget=None)
    opt_b = r5.get("optimal_battery") or {}
    cands = r5.get("candidates") or []
    print(f"        chosen: {opt_b.get('model')!r} "
          f"{opt_b.get('usable_kwh')} kWh, system ${opt_b.get('system_cost')}; "
          f"{len(cands)} candidates")
    check("(R5/fixture) THE FIXTURE BITES: a battery IS chosen (if this "
          "fails the fixture is wrong — re-tune it, never add a skip)",
          (opt_b.get("usable_kwh") or 0) > 0, repr(opt_b.get("usable_kwh")))
    _wb_arithmetic("R5", cands, None)
    baselines = [c for c in cands if c.get("battery_id") is None]
    check("(R5) exactly one no-battery baseline",
          len(baselines) == 1, f"{len(baselines)}")
    base = baselines[0] if baselines else {}
    check("(R5) the baseline carries the cost_breakdown that was PASSED IN — "
          "the solar-only breakdown, produced by the solar run, not here",
          base.get("cost_breakdown") == opt3["cost_breakdown"],
          f"baseline breakdown keys: "
          f"{sorted(base.get('cost_breakdown') or {}) if isinstance(base.get('cost_breakdown'), dict) else base.get('cost_breakdown')!r}")
    bad_bd = [c for c in cands if c.get("battery_id") is not None
              and not (isinstance(c.get("cost_breakdown"), dict)
                       and round(c["cost_breakdown"].get("net_cost") or 0, 2)
                       == c.get("system_cost"))]
    check("(R5) every battery candidate's kept breakdown net_cost rounds to "
          "its own system_cost",
          not bad_bd, f"{len(bad_bd)} wrong; first: "
          f"{(bad_bd[0].get('model'), bad_bd[0].get('system_cost')) if bad_bd else None}")

    print("\nR6. a budget that cuts SOME but not all candidates")
    batt_costs = sorted({c["system_cost"] for c in cands
                         if c.get("battery_id") is not None})
    check("(R6/fixture) the battery candidates carry at least two DISTINCT "
          "system_costs — a midpoint cap can separate them",
          len(batt_costs) >= 2, f"{batt_costs}")
    if len(batt_costs) < 2:
        return
    cap = round((batt_costs[0] + batt_costs[-1]) / 2.0, 2)
    print(f"        derived cap ${cap} between ${batt_costs[0]} and "
          f"${batt_costs[-1]} (never typed)")
    r6 = _run_fixture_battery(opt3, s8760, catalogue, budget=cap)
    cands6 = r6.get("candidates") or []
    _wb_arithmetic("R6", cands6, cap)
    wbs = {bool(c.get("within_budget")) for c in cands6
           if isinstance(c.get("within_budget"), bool)}
    check("(R6) within_budget is False on at least one candidate AND True on "
          "at least one — the cap provably cut some but not all",
          wbs == {True, False}, str(wbs))
    check("(R6) cache_misses == 0 across the fixture's generation build — "
          "this gate can never start calling the network",
          built["cache_misses"] == 0, str(built["cache_misses"]))


# ── R7 / R8: the live endpoints, recorder in place ───────────────────────────
def _caller_for(client, job_id: str) -> auth.Caller:
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", job_id).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    return auth.Caller(user_id="gate-runner", email="gate@example.com",
                       company_id=company_id, role="owner")


def _run_endpoint(coro_fn, request, caller):
    recorded: list[dict] = []
    original_save = capture.save_sizing_result
    original_cache = generation._cache_put
    capture.save_sizing_result = lambda p: (recorded.append(dict(p)) or "fake-id")
    generation._cache_put = lambda *a, **k: None
    try:
        resp = asyncio.run(coro_fn(request, caller))
    finally:
        capture.save_sizing_result = original_save
        generation._cache_put = original_cache
    return resp, recorded


def t_r7(client) -> dict:
    print("\nR7. BOTH endpoints against the LIVE fixture job — writer "
          "recorded, nothing written")
    caller = _caller_for(client, TOU_JOB)
    sol, sol_rec = _run_endpoint(sizing_route.optimise_sizing,
                                 sizing_route.OptimiseRequest(job_id=TOU_JOB),
                                 caller)
    bat, bat_rec = _run_endpoint(sizing_route.battery_sizing,
                                 sizing_route.BatteryRequest(job_id=TOU_JOB),
                                 caller)
    check("(R7) each endpoint attempted exactly one persist — both "
          "intercepted by the recorder",
          len(sol_rec) == 1 and len(bat_rec) == 1,
          f"{len(sol_rec)} + {len(bat_rec)}")
    if not (sol_rec and bat_rec):
        return {"sol": sol}

    sopts = sol_rec[0].get("evaluated_options") or {}
    bopts = bat_rec[0].get("evaluated_options") or {}
    check("(R7) solar: persisted evaluated_options carries "
          "chosen_cost_breakdown (a dict with net_cost)",
          isinstance(sopts.get("chosen_cost_breakdown"), dict)
          and "net_cost" in sopts["chosen_cost_breakdown"],
          f"{type(sopts.get('chosen_cost_breakdown'))}")
    check("(R7) solar: persisted chosen_index is an int naming a point",
          isinstance(sopts.get("chosen_index"), int)
          and not isinstance(sopts.get("chosen_index"), bool)
          and 0 <= sopts["chosen_index"] < len(sopts.get("points") or []),
          repr(sopts.get("chosen_index")))
    check("(R7) battery: persisted evaluated_options carries "
          "chosen_cost_breakdown",
          isinstance(bopts.get("chosen_cost_breakdown"), dict)
          and "net_cost" in bopts["chosen_cost_breakdown"],
          f"{type(bopts.get('chosen_cost_breakdown'))}")
    bsolar = bopts.get("chosen_solar")
    check("(R7) battery: persisted chosen_solar carries a NON-EMPTY "
          "plane_indices plus solar_kw, panel_count, panels_per_plane",
          isinstance(bsolar, dict)
          and isinstance(bsolar.get("plane_indices"), list)
          and len(bsolar["plane_indices"]) > 0
          and all(k in bsolar for k in
                  ("solar_kw", "panel_count", "panels_per_plane")),
          repr(bsolar))
    print(f"        battery chosen_solar: {json.dumps(bsolar, default=str)[:200]}")
    return {"sol": sol}


def t_r8(client, sol_tou: dict) -> None:
    print("\nR8. the two supply-charge branches, on the two REAL jobs, "
          "read-only")
    rows = (client.table("tariffs")
            .select("job_id,supply_charge")
            .in_("job_id", [TOU_JOB, NULL_JOB]).execute().data) or []
    by_job = {r["job_id"]: r.get("supply_charge") for r in rows}
    tou_charge = by_job.get(TOU_JOB)
    check("(R8/premise) the fixture job's stored tariff CARRIES a supply "
          "charge — the known branch runs on live data",
          isinstance(tou_charge, (int, float)) and tou_charge >= 0,
          repr(tou_charge))
    check("(R8/premise) the other sized job's stored tariff does NOT — the "
          "unknown branch runs on live data, not on one lucky row",
          NULL_JOB in by_job and by_job[NULL_JOB] is None,
          repr(by_job.get(NULL_JOB)))

    asm = sol_tou.get("assumptions") or {}
    opt = sol_tou.get("optimal") or {}
    want_annual = (round(float(tou_charge) * 365, 2)
                   if isinstance(tou_charge, (int, float)) else None)
    check("(R8/known) assumptions.supply_charge_annual is the stored daily "
          "charge × 365 — derived from the live row, never typed",
          isinstance(asm.get("supply_charge_annual"), (int, float))
          and round(asm["supply_charge_annual"], 2) == want_annual,
          f"{asm.get('supply_charge_annual')} vs {want_annual}")
    check("(R8/known) assumptions.supply_charge_source is a real source, "
          "not 'not stated'",
          isinstance(asm.get("supply_charge_source"), str)
          and asm["supply_charge_source"] != "not stated",
          repr(asm.get("supply_charge_source")))
    check("(R8/known) the supply_charge_unknown flag does NOT appear",
          not any(str(f).startswith("supply_charge_unknown")
                  for f in sol_tou.get("flags") or []),
          str(sol_tou.get("flags")))
    check("(R8/known) optimal says so: bill_includes_supply_charge True and "
          "annual_supply_charge == the derived annual",
          opt.get("bill_includes_supply_charge") is True
          and opt.get("annual_supply_charge") == want_annual,
          f"{opt.get('bill_includes_supply_charge')} / "
          f"{opt.get('annual_supply_charge')}")

    caller = _caller_for(client, NULL_JOB)
    sol_null, rec = _run_endpoint(sizing_route.optimise_sizing,
                                  sizing_route.OptimiseRequest(job_id=NULL_JOB),
                                  caller)
    check("(R8/unknown) the NULL-charge run attempted exactly one persist — "
          "recorded, never written",
          len(rec) == 1, f"{len(rec)}")
    asm_n = sol_null.get("assumptions") or {}
    opt_n = sol_null.get("optimal") or {}
    check("(R8/unknown) assumptions.supply_charge_annual is None and the "
          "source is the literal 'not stated'",
          asm_n.get("supply_charge_annual") is None
          and asm_n.get("supply_charge_source") == "not stated",
          f"{asm_n.get('supply_charge_annual')!r} / "
          f"{asm_n.get('supply_charge_source')!r}")
    check("(R8/unknown) the supply_charge_unknown flag IS present — the "
          "omission is stated, never silent",
          any(str(f).startswith("supply_charge_unknown")
              for f in sol_null.get("flags") or []),
          str(sol_null.get("flags"))[:300])
    check("(R8/unknown) optimal says so: bill_includes_supply_charge False, "
          "annual_supply_charge None — energy-only bills, honestly labelled",
          opt_n.get("bill_includes_supply_charge") is False
          and opt_n.get("annual_supply_charge") is None,
          f"{opt_n.get('bill_includes_supply_charge')} / "
          f"{opt_n.get('annual_supply_charge')}")


def main() -> int:
    print("verify_results_contract.py — 3.13 prompt 1 (writes nothing)\n")
    start = _counts()
    if start is not None:
        print(f"        start counts: {start}\n")

    t_r1()
    t_r2()

    client = sizing_route._sb()
    if client is None:
        skip("(R3-R8) need the live Supabase env (pvgis_cache, catalogue "
             "pricing, the two real jobs).")
    else:
        r3 = t_r3()
        t_r4()
        if r3 is not None and isinstance(r3.get("optimal"), dict) \
                and isinstance(r3["optimal"].get("cost_breakdown"), dict):
            t_r5_r6(client, r3["optimal"])
        else:
            skip("(R5/R6) R3 did not produce a usable optimum to feed the "
                 "battery fixture.")
        r7 = t_r7(client)
        t_r8(client, r7.get("sol") or {})

    if start is not None:
        end = _counts()
        print(f"\nRC. the database delta (F77)")
        print(f"        end counts:   {end}")
        for k in start:
            check(f"(RC) {k} count unchanged",
                  end is not None and end.get(k) == start[k],
                  f"{start[k]} -> {end.get(k) if end else None}")

    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed "
              f"({SKIPPED} skipped, not counted):")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print(f"OK: all {CHECKS_RUN} checks passed ({SKIPPED} skipped, not counted)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
