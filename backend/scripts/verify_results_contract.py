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

3.13 PROMPT 2 GREW IT — the run gets a financial result:
  P1  the composition proof: whole-system NPV from ONE discount loop written
      inside this gate (raw savings rebuilt from the engines' own building
      blocks) equals solar npv_25yr + incremental_npv to within one cent.
  P2  the two-engine agreement (no-battery grid_cost vs the solar engine's
      energy-only bill, one clock: full_year blocks), with a RED PROOF by
      perturbing battery_optimiser.baseline in a byte-hashed copy.
  P3  _payback_years at zero / negative / None savings: None, never a raise,
      never an infinity.
  P4  save_financial_result accepts 'modelled' and None, REFUSES 'installer'
      loudly (returns None, logs, _write never reached).
  P5  the KPI month on the job's own state's LOCAL STANDARD clock — the three
      boundary rows, old rule vs new rule, at least one row DIFFERS.
  P6  a null / unrecognised site_state: counted in UTC, never dropped,
      nothing raises (list_jobs against a stub).
  P7  the list pairing: the financial row must MATCH the chosen sizing row;
      an unmatched newest financial row yields null, never itself.
  P8  supply_charge_source: a stored charge beside a NULL import rate reads
      'installer', never 'default' — the exact fixture case that was wrong.
  P9  roi_percent is None on every payload both endpoints build, and 'D34'
      stands in the code beside it — the settled never-populate decision
      (three ROI definitions, all derived at render) leaves a trace.

RUNS the code, never parses it (F148) — except R4 and P2, which edit and
RESTORE an engine file by design, byte-hash verified, inside a try/finally.
WRITES NOTHING to the database: all three writers (sizing, financial, the
jobs quote update) are recorded on every endpoint run, and the faked sizing
id is deliberately UUID-shaped so the financial branch is observable.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_results_contract.py
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Optional

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
from routes import job as job_route  # noqa: E402
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
    # 3.13 prompt 2: an UPDATE leaves every row count unchanged, so the quote
    # values are snapshotted BY VALUE — a gate run that mutated
    # jobs.quoted_value_aud would pass fourteen count checks and fail here.
    cur.execute("select job_id::text, coalesce(quoted_value_aud::text, 'NULL') "
                "from public.jobs order by job_id")
    out["jobs quoted values"] = tuple(map(tuple, cur.fetchall()))
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
    shutil.rmtree(os.path.join(BACKEND_DIR, "routes", "__pycache__"),
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


def t_r5_r6(client, opt3: dict) -> Optional[dict]:
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
    ctx = {"r5": r5, "s8760": s8760, "catalogue": catalogue}
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
        return ctx
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
    return ctx


# ── R7 / R8: the live endpoints, recorder in place ───────────────────────────
def _caller_for(client, job_id: str) -> auth.Caller:
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", job_id).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    return auth.Caller(user_id="gate-runner", email="gate@example.com",
                       company_id=company_id, role="owner")


# 3.13 prompt 2: the faked sizing id is UUID-SHAPED on purpose — the endpoint
# refuses to link a financial row to a non-UUID id (uuid FK), so a plain
# "fake-id" would make the financial branch unobservable here.
FAKE_SID = "00000000-0000-4000-8000-0000000313f2"


def _run_endpoint(coro_fn, request, caller):
    """Run one endpoint with ALL THREE writers recorded — sizing, financial,
    and the jobs quote update — restored in a finally. Nothing is written."""
    recorded: list[dict] = []
    fin_recorded: list[dict] = []
    quote_recorded: list[tuple] = []
    original_save = capture.save_sizing_result
    original_fin = capture.save_financial_result
    original_quote = sizing_route._set_quoted_value
    original_cache = generation._cache_put
    capture.save_sizing_result = lambda p: (recorded.append(dict(p)) or FAKE_SID)
    capture.save_financial_result = lambda p: (fin_recorded.append(dict(p)) or "fake-fin-id")
    sizing_route._set_quoted_value = (
        lambda client, job_id, company_id, value:
        (quote_recorded.append((job_id, company_id, value)) or True)
    )
    generation._cache_put = lambda *a, **k: None
    try:
        resp = asyncio.run(coro_fn(request, caller))
    finally:
        capture.save_sizing_result = original_save
        capture.save_financial_result = original_fin
        sizing_route._set_quoted_value = original_quote
        generation._cache_put = original_cache
    return resp, recorded, fin_recorded, quote_recorded


def t_r7(client) -> dict:
    print("\nR7. BOTH endpoints against the LIVE fixture job — writer "
          "recorded, nothing written")
    caller = _caller_for(client, TOU_JOB)
    sol, sol_rec, sol_fin, sol_quote = _run_endpoint(
        sizing_route.optimise_sizing,
        sizing_route.OptimiseRequest(job_id=TOU_JOB), caller)
    bat, bat_rec, bat_fin, bat_quote = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB), caller)
    check("(R7) each endpoint attempted exactly one persist — both "
          "intercepted by the recorder",
          len(sol_rec) == 1 and len(bat_rec) == 1,
          f"{len(sol_rec)} + {len(bat_rec)}")
    if not (sol_rec and bat_rec):
        return {"sol": sol}

    # 3.13 prompt 2: the SECOND writer call per endpoint, and the quote.
    # WHY THESE MOVE: pre-prompt-2 neither endpoint writes financial_results
    # or quoted_value_aud at all — every list below would be empty.
    check("(P/R7) each endpoint persisted exactly one financial result, "
          "linked to the sizing id the writer returned",
          len(sol_fin) == 1 and len(bat_fin) == 1
          and sol_fin[0].get("sizing_result_id") == FAKE_SID
          and bat_fin[0].get("sizing_result_id") == FAKE_SID,
          f"{len(sol_fin)} + {len(bat_fin)}")
    if sol_fin and bat_fin:
        check("(P/R7) both: system_capex == the sizing row's system_cost, "
              "exactly — the one derived expectation, both endpoints",
              sol_fin[0].get("system_capex") == sol_rec[0].get("system_cost")
              and bat_fin[0].get("system_capex") == bat_rec[0].get("system_cost"),
              f"solar {sol_fin[0].get('system_capex')} vs {sol_rec[0].get('system_cost')}; "
              f"battery {bat_fin[0].get('system_capex')} vs {bat_rec[0].get('system_cost')}")
        check("(P9) both endpoints: pricing_basis 'modelled' and roi_percent "
              "None PERMANENTLY (D34) — the three ROI definitions are "
              "derived at render from system_capex / annual_savings / "
              "npv_25_year, stored beside it",
              all(f.get("pricing_basis") == "modelled"
                  and "roi_percent" in f and f.get("roi_percent") is None
                  for f in (sol_fin[0], bat_fin[0])),
              f"{sol_fin[0].get('pricing_basis')!r}/{sol_fin[0].get('roi_percent')!r} "
              f"{bat_fin[0].get('pricing_basis')!r}/{bat_fin[0].get('roi_percent')!r}")
        # P9's second half: the settled decision leaves a TRACE in the code —
        # the string "D34" stands beside roi_percent in the one writer both
        # endpoints share. A settled decision with no trace gets re-litigated
        # in three weeks.
        src = open(os.path.join(BACKEND_DIR, "routes", "sizing.py")).read()
        roi_at = src.find('"roi_percent": None')
        window = src[max(0, roi_at - 400):roi_at + 100] if roi_at != -1 else ""
        check("(P9) the string 'D34' appears in the comment beside "
              "roi_percent in routes/sizing.py",
              roi_at != -1 and "D34" in window,
              f"roi_percent found at {roi_at}; window carries D34: "
              f"{'D34' in window}")
        # The solar half is read from the SOLAR endpoint's own run on the same
        # job — both endpoints choose the same solar on the same stored
        # inputs (the battery gate's AGREE check pins that), so its optimal
        # carries the same annual_savings / npv_25yr the battery endpoint
        # composed from internally.
        _sopt = sol.get("optimal") or {}
        _bopt = bat.get("optimal_battery") or {}
        check("(P/R7) battery: the composed figures are the sums — "
              "annual_savings == solar + incremental and npv == solar + "
              "incremental, to the cent (if the endpoint re-derived either "
              "half instead of composing, these sums would drift)",
              isinstance(bat_fin[0].get("annual_savings"), (int, float))
              and abs(bat_fin[0]["annual_savings"]
                      - round(_sopt.get("annual_savings", 0)
                              + _bopt.get("annual_savings_vs_solar_only", 0), 2))
              <= 0.01
              and isinstance(bat_fin[0].get("npv_25_year"), (int, float))
              and abs(bat_fin[0]["npv_25_year"]
                      - round(_sopt.get("npv_25yr", 0)
                              + _bopt.get("incremental_npv", 0), 2)) <= 0.01,
              f"savings {bat_fin[0].get('annual_savings')} vs "
              f"{_sopt.get('annual_savings')}+{_bopt.get('annual_savings_vs_solar_only')}; "
              f"npv {bat_fin[0].get('npv_25_year')} vs "
              f"{_sopt.get('npv_25yr')}+{_bopt.get('incremental_npv')}")
        check("(P/R7) each endpoint set the quote once, to its own "
              "system_capex, company-scoped",
              len(sol_quote) == 1 and len(bat_quote) == 1
              and sol_quote[0] == (TOU_JOB, caller.company_id,
                                   sol_fin[0].get("system_capex"))
              and bat_quote[0] == (TOU_JOB, caller.company_id,
                                   bat_fin[0].get("system_capex")),
              f"{sol_quote} / {bat_quote}")
        check("(P/R7) both responses say financial_persisted True — the "
              "recorder accepted, and the response reports it",
              sol.get("financial_persisted") is True
              and bat.get("financial_persisted") is True,
              f"{sol.get('financial_persisted')!r} / "
              f"{bat.get('financial_persisted')!r}")
        check("(P10/R7) the battery run reports resolution 'full_year' in "
              "the response and in assumptions — the screen can always say "
              "which mode produced a number",
              bat.get("resolution") == "full_year"
              and (bat.get("assumptions") or {}).get("resolution")
              == "full_year",
              f"{bat.get('resolution')!r} / "
              f"{(bat.get('assumptions') or {}).get('resolution')!r}")

        # 3.13 prompt 3 (Q2): the dispatch mode is STORED with the run —
        # present on BOTH payloads, the string the run used on the battery
        # side, and None on the solar side (a solar-only run performs no
        # dispatch; the recorded None is a fact, not an omission).
        sopts = sol_rec[0].get("evaluated_options") or {}
        bopts = bat_rec[0].get("evaluated_options") or {}
        check("(Q2) solar payload: dispatch_resolution key present and None",
              "dispatch_resolution" in sopts
              and sopts.get("dispatch_resolution") is None,
              repr(sopts.get("dispatch_resolution", "<absent>")))
        check("(Q2) battery payload: dispatch_resolution == the resolution "
              "the response reports",
              bopts.get("dispatch_resolution") == bat.get("resolution")
              and isinstance(bopts.get("dispatch_resolution"), str),
              f"{bopts.get('dispatch_resolution')!r} vs "
              f"{bat.get('resolution')!r}")
        # (Q3) a solar-only run has no parts to split.
        check("(Q3) solar payload: NO split key — a solar-only run has no "
              "parts to split",
              "split" not in sopts, str(sorted(sopts)))
        # (Q1, healthy half): the split parts SUM to the stored whole, both
        # figures, to the cent — the deliberate redundancy is two-sidedly
        # gated. WHY IT MOVES: the whole-system annual_savings and npv_25_year
        # on the financial row are round(solar + increment, 2) by construction
        # (prompt 2 step C); if either copy ever drifts the sum breaks and
        # this names which side moved.
        split = bopts.get("split") or {}
        so = split.get("solar_only") or {}
        bi = split.get("battery_increment") or {}
        check("(Q1) battery payload carries split.solar_only and "
              "split.battery_increment with all four keys each",
              all(k in so for k in ("annual_savings", "npv_25yr",
                                    "simple_payback_years", "system_cost"))
              and all(k in bi for k in ("annual_savings_vs_solar_only",
                                        "incremental_npv",
                                        "incremental_payback_years",
                                        "battery_cost")),
              f"solar_only={sorted(so)} battery_increment={sorted(bi)}")
        s_sum = round((so.get("annual_savings") or 0)
                      + (bi.get("annual_savings_vs_solar_only") or 0), 2)
        n_sum = round((so.get("npv_25yr") or 0)
                      + (bi.get("incremental_npv") or 0), 2)
        print(f"        split sums: savings {so.get('annual_savings')} + "
              f"{bi.get('annual_savings_vs_solar_only')} = {s_sum} vs stored "
              f"{bat_fin[0].get('annual_savings')}; npv {so.get('npv_25yr')} "
              f"+ {bi.get('incremental_npv')} = {n_sum} vs stored "
              f"{bat_fin[0].get('npv_25_year')}")
        check("(Q1) solar_only + battery_increment == the stored whole-system "
              "annual_savings, to the cent",
              isinstance(bat_fin[0].get("annual_savings"), (int, float))
              and abs(s_sum - bat_fin[0]["annual_savings"]) <= 0.01,
              f"{s_sum} vs {bat_fin[0].get('annual_savings')}")
        check("(Q1) ...and the same for the two NPVs",
              isinstance(bat_fin[0].get("npv_25_year"), (int, float))
              and abs(n_sum - bat_fin[0]["npv_25_year"]) <= 0.01,
              f"{n_sum} vs {bat_fin[0].get('npv_25_year')}")

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
    # 3.13 prompt 2 (P8, on the live row): this stored tariff has a charge the
    # installer typed and a NULL import rate — the exact fixture case prompt 1
    # labelled "default". WHY IT MOVES: pre-prompt-2 the label borrowed
    # `source`, which only the import-rate resolution ever assigns.
    check("(R8/known · P8) assumptions.supply_charge_source is 'installer' — "
          "never 'default', the import rate's provenance",
          asm.get("supply_charge_source") == "installer",
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
    sol_null, rec, fin_rec, _quotes = _run_endpoint(
        sizing_route.optimise_sizing,
        sizing_route.OptimiseRequest(job_id=NULL_JOB), caller)
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
    # 3.13 prompt 2: the financial payload still BUILDS on the unknown branch,
    # with the energy-only spend figures the optimal dict carries.
    check("(R8/unknown) the financial payload built anyway, spend figures "
          "energy-only (== the optimal dict's own bill figures)",
          len(fin_rec) == 1
          and fin_rec[0].get("current_annual_spend") == opt_n.get("annual_bill_before")
          and fin_rec[0].get("projected_annual_spend") == opt_n.get("annual_bill_after")
          and fin_rec[0].get("pricing_basis") == "modelled",
          f"{len(fin_rec)} payload(s); "
          f"{fin_rec[0].get('current_annual_spend') if fin_rec else None} vs "
          f"{opt_n.get('annual_bill_before')}")


# ── P1: the composition proof ─────────────────────────────────────────────────
def t_p1(opt3: dict, ctx: dict) -> None:
    print("\nP1. the composition proof — one discount loop, written HERE, "
          "equals the two engines' sum")
    r5 = ctx["r5"]
    chosen = r5.get("optimal_battery") or {}
    row = next((r for r in ctx["catalogue"]
                if r.get("id") == chosen.get("battery_id")), None)
    check("(P1/fixture) the chosen battery's catalogue row is in hand "
          "(its hardware cost prices the replacement term)",
          row is not None, repr(chosen.get("battery_id")))
    if row is None:
        return
    bat = battery_optimiser.battery_specs(dict(row), [])
    load = _fixture_load()

    # RAW savings, rebuilt from the ENGINES' OWN building blocks (never this
    # gate's arithmetic): the battery's from build_blocks/baseline/
    # solve_candidate, the solar's from net_config — then pinned to the
    # candidates' rounded figures so the reconstruction is provably the same
    # computation and not a lookalike.
    # 3.13 prompt 2b: the SAME resolution the engine now defaults to — the
    # candidates being verified were produced by the full-year dispatch, so
    # the raw savings must be rebuilt on the same 365 real daily blocks.
    blocks = battery_optimiser.build_blocks(
        ctx["s8760"], load, list(FIX_RATE_24), "full_year")
    base = battery_optimiser.baseline(blocks, FIX_FIT, FIX_EXPORT_LIMIT_KW)
    res = battery_optimiser.solve_candidate(blocks, bat, FIX_FIT,
                                            FIX_EXPORT_LIMIT_KW)
    check("(P1/fixture) the candidate LP re-solved to optimality",
          res is not None, "solver failed")
    if res is None:
        return
    sav_b_raw = base["cost"] - res["cost"]
    netd = solar_optimiser.net_config(ctx["s8760"], load,
                                      FIX_EXPORT_LIMIT_KW, list(FIX_RATE_24))
    sav_s_raw = netd["self_consumed_value"] + netd["export"] * FIX_FIT
    check("(P1/fixture) the rebuilt raw savings ARE the engines' own — both "
          "round to the candidates' stored figures",
          round(sav_s_raw, 2) == opt3.get("annual_savings")
          and round(sav_b_raw, 2) == chosen.get("annual_savings_vs_solar_only"),
          f"solar {round(sav_s_raw, 2)} vs {opt3.get('annual_savings')}; "
          f"battery {round(sav_b_raw, 2)} vs "
          f"{chosen.get('annual_savings_vs_solar_only')}")

    S = opt3["system_cost"]
    incr = chosen["battery_cost"]
    deg = FIN["degradation_annual_pct"] / 100.0
    disc = FIN["discount_rate"]
    esc = FIN["tariff_escalation_pct"] / 100.0
    N = FIN["analysis_years"]
    npv_direct = -(S + incr)
    for y in range(1, N + 1):
        npv_direct += ((sav_s_raw + sav_b_raw)
                       * ((1 - deg) ** y) * ((1 + esc) ** y) / ((1 + disc) ** y))
    repl = chosen.get("replacement_year")
    if repl:
        npv_direct -= bat["cost_aud"] / ((1 + disc) ** repl)
    engine_sum = opt3["npv_25yr"] + chosen["incremental_npv"]
    print(f"        direct loop: {npv_direct:.4f}   solar npv + incremental: "
          f"{engine_sum:.2f}   replacement year: {repl}")
    check("(P1) whole-system NPV from ONE gate-written discount loop == "
          "solar npv_25yr + incremental_npv within one cent — this moves the "
          "moment the two engines discount on different clocks (a different "
          "fin dict breaks the factor-by-factor identity) or a capex leaks "
          "into the wrong half",
          abs(npv_direct - engine_sum) <= 0.011,
          f"direct {npv_direct:.4f} vs engines {engine_sum:.2f} "
          f"(diff {npv_direct - engine_sum:+.4f})")


# ── P2: the two-engine agreement + its red proof ─────────────────────────────
def subprocess_probe_p2() -> dict:
    """One clock (full_year blocks), two engines: the battery engine's
    no-battery grid cost vs the solar engine's energy-only bill for the same
    chosen solar. Run in a FRESH interpreter for the sabotage/restore runs."""
    res3 = _run_fixture_optimise()
    opt = res3["optimal"]
    s8760, _built = _fixture_solar_8760(opt)
    load = _fixture_load()
    netd = solar_optimiser.net_config(s8760, load, FIX_EXPORT_LIMIT_KW,
                                      list(FIX_RATE_24))
    bill_energy = netd["import_value"] - netd["export"] * FIX_FIT
    blocks = battery_optimiser.build_blocks(s8760, load, list(FIX_RATE_24),
                                            "full_year")
    base = battery_optimiser.baseline(blocks, FIX_FIT, FIX_EXPORT_LIMIT_KW)
    diff = base["cost"] - bill_energy
    return {"grid_cost": round(base["cost"], 2),
            "bill_energy": round(bill_energy, 2),
            "diff": diff, "agree": abs(diff) <= 0.01}


def _probe_p2_via_subprocess() -> dict | None:
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {SCRIPTS_DIR!r})\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import verify_results_contract as g\n"
        "print('PROBE:' + json.dumps(g.subprocess_probe_p2()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", runner],
                          capture_output=True, text=True, timeout=600)
    for line in proc.stdout.splitlines():
        if line.startswith("PROBE:"):
            return json.loads(line[len("PROBE:"):])
    print(f"        probe stdout: {proc.stdout[-400:]!r}")
    print(f"        probe stderr: {proc.stderr[-400:]!r}")
    return None


_P2_FROM = "            cost += w * (i * r - e * fit)\n"
_P2_TO = "            cost += w * (i * r - e * fit) + 0.001\n"


def t_p2() -> None:
    print("\nP2. the two-engine agreement, and the proof it can FAIL")
    healthy = _probe_p2_via_subprocess()
    print(f"        healthy probe: {healthy}")
    check("(P2) GREEN: on one clock (full_year blocks) the no-battery "
          "grid_cost equals the solar engine's energy-only bill within one "
          "cent — the only comparison of the two engines' pricing arithmetic",
          isinstance(healthy, dict) and healthy.get("agree") is True,
          repr(healthy))

    target = os.path.join(BACKEND_DIR, "battery_optimiser.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")
    text = original.decode("utf-8")
    n = text.count(_P2_FROM)
    check("(P2) the perturbation line exists EXACTLY once in "
          "battery_optimiser.py (the baseline's pricing line)",
          n == 1, f"count={n}")
    if n != 1:
        return
    tmpdir = tempfile.mkdtemp(prefix="p2_")
    backup = os.path.join(tmpdir, "battery_optimiser.py.bak")
    shutil.copyfile(target, backup)
    check("(P2) the byte copy was taken FIRST and matches the original hash",
          hashlib.sha256(open(backup, "rb").read()).hexdigest()
          == original_hash, backup)
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_P2_FROM, _P2_TO))
        _rm_pycache()
        red = _probe_p2_via_subprocess()
        print(f"        perturbed probe: {red}")
        check("(P2) RED: with the baseline's pricing perturbed by a tenth of "
              "a cent per hour the agreement FAILS — the check genuinely "
              "compares the two engines and is not vacuous",
              isinstance(red, dict) and red.get("agree") is False,
              repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"        restored SHA-256: {restored_hash}")
    check("(P2) RESTORED: battery_optimiser.py is byte-identical to the one "
          "tested (SHA-256 equal, restored from the copy, never from git)",
          restored_hash == original_hash, restored_hash)
    green = _probe_p2_via_subprocess()
    print(f"        restored probe : {green}")
    check("(P2) GREEN AGAIN after the restore",
          isinstance(green, dict) and green.get("agree") is True, repr(green))
    shutil.rmtree(tmpdir, ignore_errors=True)


# ── P3 / P4: the payback edge and the pricing_basis vocabulary ───────────────
def t_p3_p4() -> None:
    print("\nP3. payback at zero / negative / missing savings")
    for label, savings in (("exactly 0", 0.0), ("negative", -812.5),
                           ("None", None)):
        try:
            out = sizing_route._payback_years(10000.0, savings)
            err = None
        except Exception as ex:  # noqa: BLE001
            out, err = "RAISED", f"{type(ex).__name__}: {ex}"
        check(f"(P3) whole_savings {label}: payback is None — never negative, "
              "never an infinity, no exception",
              err is None and out is None, f"{out!r} {err or ''}")
    check("(P3) CONTROL: positive savings still produce a payback "
          "(10000 / 2500 = 4.0)",
          sizing_route._payback_years(10000.0, 2500.0) == 4.0,
          repr(sizing_route._payback_years(10000.0, 2500.0)))

    print("\nP4. save_financial_result: 'modelled' accepted, 'installer' "
          "REFUSED, None accepted")
    reached: list = []
    logs: list = []
    original_write = capture._write
    original_error = capture.logger.error
    capture._write = lambda table, payload: (reached.append(table) or "stub-id")
    capture.logger.error = lambda msg, *a, **k: logs.append(msg % a if a else msg)
    try:
        ok = capture.save_financial_result(
            {"job_id": "j", "system_capex": 1.0, "pricing_basis": "modelled"})
        check("(P4) 'modelled' (in PRICING_BASES) reaches _write",
              ok == "stub-id" and reached == ["financial_results"],
              f"{ok!r} {reached}")
        refused = capture.save_financial_result(
            {"job_id": "j", "system_capex": 1.0, "pricing_basis": "installer"})
        check("(P4) 'installer' (row 4.12's future value, not yet in the "
              "vocabulary) is REFUSED: returns None, _write NEVER reached",
              refused is None and len(reached) == 1,
              f"{refused!r} {len(reached)} write(s)")
        check("(P4) ...and the refusal is LOGGED, naming the label and the "
              "known set",
              any("pricing_basis" in str(m) and "installer" in str(m)
                  for m in logs), f"{logs}")
        ok_none = capture.save_financial_result(
            {"job_id": "j", "system_capex": 1.0})
        check("(P4) an ABSENT pricing_basis stays legal ('not recorded') — "
              "_write reached",
              ok_none == "stub-id" and len(reached) == 2,
              f"{ok_none!r} {len(reached)} write(s)")
    finally:
        capture._write = original_write
        capture.logger.error = original_error


# ── P5 / P6 / P7: the KPI month and the list pairing ─────────────────────────
class _LJQuery:
    def __init__(self, rows):
        self.rows = rows
        self._order = None
        self._desc = True

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, *_a, **_k):
        return self

    def order(self, column, desc=None, **_k):
        self._order, self._desc = column, bool(desc)
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        rows = list(self.rows)
        if self._order:
            rows.sort(key=lambda r: str(r.get(self._order) or ""),
                      reverse=self._desc)
        return SimpleNamespace(data=rows)


class _LJClient:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _LJQuery(self.tables.get(name, []))


def _run_list_jobs(tables: dict):
    caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                         company_id="co-gate", role="owner")
    original_svc = job_route._require_svc
    job_route._require_svc = lambda: _LJClient(tables)
    try:
        return asyncio.run(job_route.list_jobs(
            caller=caller, status=None, q=None, sort="updated_desc",
            limit=50, offset=0))
    finally:
        job_route._require_svc = original_svc


def t_p5_p6() -> None:
    print("\nP5. the KPI month on the job's own state's local standard clock")
    # A fixed 'now' mid-March so the boundary rows are decidable: the rule is
    # (ts key == now key), both sides through _won_month_key on ONE clock.
    now_fixed = datetime(2026, 3, 15, 0, 0, 0, tzinfo=timezone.utc)
    rows = [
        ("SA", datetime(2026, 3, 1, 0, 15, tzinfo=timezone.utc), (2026, 3), (2026, 3)),
        ("WA", datetime(2026, 3, 1, 0, 15, tzinfo=timezone.utc), (2026, 3), (2026, 3)),
        ("SA", datetime(2026, 2, 28, 23, 0, tzinfo=timezone.utc), (2026, 3), (2026, 2)),
    ]
    differs = 0
    for state, ts, want_new, want_old in rows:
        new_key = job_route._won_month_key(ts, state)
        old_key = (ts.year, ts.month)
        label = ts.strftime("%Y-%m-%dT%H:%MZ")
        print(f"        {state} @ {label}: new {new_key}  old {old_key}")
        check(f"(P5) {state} site @ {label}: lands in {want_new} on the "
              "local clock",
              new_key == want_new, str(new_key))
        check(f"(P5) {state} site @ {label}: the OLD (UTC) rule says "
              f"{want_old}",
              old_key == want_old, str(old_key))
        if new_key != old_key:
            differs += 1
    check("(P5) the two rules DIFFER for at least one row — the check is "
          "testing the fix, not restating UTC (the 23:00Z Feb-28 SA row is "
          "08:30 on March 1st in Adelaide)",
          differs >= 1, f"{differs} rows differ")
    check("(P5) both sides on one clock: now itself moves month under the "
          "same key for the same state",
          job_route._won_month_key(now_fixed, "SA") == (2026, 3),
          str(job_route._won_month_key(now_fixed, "SA")))

    print("\nP6. a null / unrecognised site_state: counted in UTC, never "
          "dropped, nothing raises")
    now_iso = datetime.now(timezone.utc).isoformat()
    jobs = [
        {"job_id": "p6-null", "company_id": "co-gate", "status": "won",
         "quoted_value_aud": 1000.0, "updated_at": now_iso,
         "site_state": None, "path": None},
        {"job_id": "p6-zz", "company_id": "co-gate", "status": "won",
         "quoted_value_aud": 500.0, "updated_at": now_iso,
         "site_state": "ZZ", "path": None},
    ]
    try:
        resp = _run_list_jobs({"jobs": jobs})
        err = None
    except Exception as ex:  # noqa: BLE001
        resp, err = None, f"{type(ex).__name__}: {ex}"
    check("(P6) list_jobs did not raise", err is None, str(err))
    if resp is None:
        return
    won = (resp.get("kpis") or {}).get("won_this_month") or {}
    check("(P6) BOTH jobs counted this month (updated_at is now, so UTC and "
          "any local clock agree) — the unresolvable state falls back to "
          "UTC and the job is never dropped",
          won.get("count") == 2 and won.get("value") == 1500.0,
          f"{won}")


def t_p7() -> None:
    print("\nP7. the list pairing — the financial row must MATCH the chosen "
          "sizing row")
    job = {"job_id": "p7", "company_id": "co-gate", "status": "sized",
           "quoted_value_aud": None, "updated_at": "2026-08-10T00:00:00+00:00",
           "site_state": "SA", "path": None}
    s_old = {"job_id": "p7", "sizing_result_id": "s1", "solar_kw": 5.5,
             "battery_kwh": None, "created_at": "2026-08-01T00:00:00+00:00"}
    s_new = {"job_id": "p7", "sizing_result_id": "s2", "solar_kw": 9.9,
             "battery_kwh": None, "created_at": "2026-08-02T00:00:00+00:00"}
    # The financial rows are DELIBERATELY created in the OPPOSITE order to
    # their sizing rows: the NEWEST financial row (f-for-s1) belongs to the
    # OLDER sizing run.
    f_for_s2 = {"job_id": "p7", "sizing_result_id": "s2", "payback_years": 3.3,
                "created_at": "2026-08-03T00:00:00+00:00"}
    f_for_s1 = {"job_id": "p7", "sizing_result_id": "s1", "payback_years": 9.9,
                "created_at": "2026-08-04T00:00:00+00:00"}
    resp = _run_list_jobs({"jobs": [job],
                           "sizing_results": [s_old, s_new],
                           "financial_results": [f_for_s2, f_for_s1]})
    row = (resp.get("jobs") or [{}])[0]
    head = row.get("headline") or {}
    print(f"        headline: {head}")
    check("(P7) the chosen sizing row is the newest (solar 9.9 kW from s2)",
          head.get("solar_kw") == 9.9, repr(head.get("solar_kw")))
    check("(P7) payback_years is 3.3 — the row MATCHING s2, not the newest "
          "financial row (9.9, which belongs to the older run s1). WHY IT "
          "MOVES: the old rule picked newest-per-job independently on both "
          "tables",
          head.get("payback_years") == 3.3, repr(head.get("payback_years")))

    # An unmatched newest financial row yields NULL, never itself.
    f_orphan = {"job_id": "p7", "sizing_result_id": "s0", "payback_years": 7.7,
                "created_at": "2026-08-05T00:00:00+00:00"}
    resp2 = _run_list_jobs({"jobs": [job],
                            "sizing_results": [s_old, s_new],
                            "financial_results": [f_for_s1, f_orphan]})
    head2 = ((resp2.get("jobs") or [{}])[0].get("headline")) or {}
    check("(P7) no financial row matches the chosen sizing row: "
          "payback_years is NULL — a missing number is honest, a mismatched "
          "one is not",
          head2.get("payback_years") is None, repr(head2.get("payback_years")))


def subprocess_probe_q1() -> dict:
    """Fresh interpreter: run the battery endpoint on the fixture job with all
    writers recorded and report whether the persisted split parts still sum to
    the stored whole-system figures."""
    client = sizing_route._sb()
    caller = _caller_for(client, TOU_JOB)
    _bat, bat_rec, bat_fin, _q = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB), caller)
    split = ((bat_rec[0].get("evaluated_options") or {}).get("split")
             if bat_rec else {}) or {}
    so = split.get("solar_only") or {}
    bi = split.get("battery_increment") or {}
    fin = bat_fin[0] if bat_fin else {}
    s_sum = round((so.get("annual_savings") or 0)
                  + (bi.get("annual_savings_vs_solar_only") or 0), 2)
    n_sum = round((so.get("npv_25yr") or 0)
                  + (bi.get("incremental_npv") or 0), 2)
    return {
        "s_sum": s_sum, "fin_savings": fin.get("annual_savings"),
        "n_sum": n_sum, "fin_npv": fin.get("npv_25_year"),
        "savings_ok": isinstance(fin.get("annual_savings"), (int, float))
                      and abs(s_sum - fin["annual_savings"]) <= 0.01,
        "npv_ok": isinstance(fin.get("npv_25_year"), (int, float))
                  and abs(n_sum - fin["npv_25_year"]) <= 0.01,
    }


def _probe_q1_via_subprocess() -> dict | None:
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {SCRIPTS_DIR!r})\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import verify_results_contract as g\n"
        "print('PROBE:' + json.dumps(g.subprocess_probe_q1()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", runner],
                          capture_output=True, text=True, timeout=600)
    for line in proc.stdout.splitlines():
        if line.startswith("PROBE:"):
            return json.loads(line[len("PROBE:"):])
    print(f"        probe stdout: {proc.stdout[-400:]!r}")
    print(f"        probe stderr: {proc.stderr[-400:]!r}")
    return None


_Q1_FROM = '                                "annual_savings": chosen_solar["annual_savings"],\n'
_Q1_TO = '                                "annual_savings": chosen_solar["annual_savings"] + 1.0,\n'


def t_q1_red() -> None:
    print("\nQ1-RED. the split-sum check can FAIL — one part perturbed in a "
          "byte-hashed copy of routes/sizing.py")
    target = os.path.join(BACKEND_DIR, "routes", "sizing.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")
    text = original.decode("utf-8")
    n = text.count(_Q1_FROM)
    check("(Q1-RED) the perturbation line (the split's solar_only "
          "annual_savings) exists EXACTLY once",
          n == 1, f"count={n}")
    if n != 1:
        return
    tmpdir = tempfile.mkdtemp(prefix="q1_")
    backup = os.path.join(tmpdir, "sizing.py.bak")
    shutil.copyfile(target, backup)
    check("(Q1-RED) the byte copy was taken FIRST and matches the original "
          "hash",
          hashlib.sha256(open(backup, "rb").read()).hexdigest()
          == original_hash, backup)
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_Q1_FROM, _Q1_TO))
        _rm_pycache()
        red = _probe_q1_via_subprocess()
        print(f"        perturbed probe: {red}")
        check("(Q1-RED) RED: with one dollar added to the stored solar part, "
              "the savings sum no longer matches the stored whole — the "
              "two-sided check genuinely bites",
              isinstance(red, dict) and red.get("savings_ok") is False,
              repr(red))
        check("(Q1-RED) RED: ...and the NPV sum, untouched, still matches — "
              "the check localises WHICH figure moved",
              isinstance(red, dict) and red.get("npv_ok") is True,
              repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"        restored SHA-256: {restored_hash}")
    check("(Q1-RED) RESTORED: routes/sizing.py is byte-identical to the one "
          "tested (restored from the copy, never from git)",
          restored_hash == original_hash, restored_hash)
    green = _probe_q1_via_subprocess()
    print(f"        restored probe : {green}")
    check("(Q1-RED) GREEN AGAIN: both sums match after the restore",
          isinstance(green, dict) and green.get("savings_ok") is True
          and green.get("npv_ok") is True, repr(green))
    shutil.rmtree(tmpdir, ignore_errors=True)


def t_p10_full_year_blocks() -> None:
    """3.13 prompt 2b (D35): full_year is 365 REAL daily blocks, day-cyclic by
    construction. WHY THESE MOVE: the pre-2b branch returned ONE 8,760-step
    block, which made state of charge cyclic over the YEAR and let the solver
    bank summer energy into winter — every check below fails against that
    shape on the block count alone."""
    print("\nP10. build_blocks('full_year') — 365 real days, no averaging, "
          "and the default")
    s = [float(h % 24) for h in range(8760)]
    ld = [1.0] * 8760
    blocks = battery_optimiser.build_blocks(s, ld, [0.4] * 24, "full_year")
    check("(P10) 365 blocks of 24 steps, every weight 1.0 — never one "
          "year-cyclic block",
          len(blocks) == 365
          and all(b["steps"] == 24 and b["weight"] == 1.0 for b in blocks),
          f"{len(blocks)} blocks")
    flat = [v for b in blocks for v in b["solar"]]
    check("(P10) the blocks carry the REAL hours in calendar order — "
          "concatenating them reproduces the input series exactly, no "
          "averaging",
          flat == s, f"first mismatch at "
          f"{next((i for i, (a, b) in enumerate(zip(flat, s)) if a != b), None)}")
    check("(P10) each block's rate is the 24-hour vector",
          all(b["rate"] == [0.4] * 24 for b in blocks), "")
    # A short series: whole days only, flagged, never padded (padding invents
    # nights) and never silently truncated.
    fl: list[str] = []
    short = battery_optimiser.build_blocks(s[:2500], ld[:2500], [0.4] * 24,
                                           "full_year", fl)
    check("(P10) a 2,500-hour series yields 104 WHOLE days and a flag — "
          "no zero-padding, no silent truncation",
          len(short) == 104
          and any("shorter than a year" in f for f in fl),
          f"{len(short)} blocks; flags={fl}")
    check("(P10) the default resolution IS full_year on both the engine and "
          "the request model — hard mode is the default, the shortcut is "
          "never auto-selected",
          battery_optimiser.optimise_battery.__kwdefaults__.get("resolution")
          == "full_year"
          and sizing_route.BatteryRequest.model_fields["resolution"].default
          == "full_year",
          f"engine={battery_optimiser.optimise_battery.__kwdefaults__.get('resolution')!r} "
          f"request={sizing_route.BatteryRequest.model_fields['resolution'].default!r}")


def t_p8_resolver() -> None:
    print("\nP8. supply_charge_source at the resolver — the exact fixture "
          "case that was wrong")
    stored = {"job_id": "j8", "tariff_type": "tou", "supply_charge": 1.05,
              "tou_windows": [{"label": "peak", "rate": 0.45,
                               "start": "00:00", "end": "24:00",
                               "days": "all"}],
              "import_rate": None, "fit_aud_per_kwh": 0.05,
              "export_limit_kw": 5.0, "source": "installer"}
    body = SimpleNamespace(job_id="j8", import_rate=None, fit=None,
                           export_limit_kw=None, import_rates_24=None,
                           tou_windows=None)
    flags: list[str] = []
    t = sizing_route._resolve_tariff(
        _LJClient({"tariffs": [stored], "bills": []}), body, "SA", "5000",
        flags)
    check("(P8) a stored charge beside a NULL import rate: "
          "supply_charge_source is 'installer', not 'default' — prompt 1's "
          "label borrowed the import rate's provenance and said 'default' "
          "about a number the installer typed",
          t.get("supply_charge_source") == "installer"
          and t.get("source") == "default",
          f"supply_charge_source={t.get('supply_charge_source')!r} "
          f"source={t.get('source')!r}")
    fl: list[str] = []
    annual, src = sizing_route._annual_supply_charge(t, fl)
    check("(P8) ...and the annualiser carries it: 383.25 labelled "
          "'installer'",
          annual == 383.25 and src == "installer", f"{annual!r} / {src!r}")


def main() -> int:
    print("verify_results_contract.py — 3.13 prompts 1+2 (writes nothing)\n")
    start = _counts()
    if start is not None:
        print(f"        start counts: {start}\n")

    t_r1()
    t_r2()
    t_p3_p4()
    t_p5_p6()
    t_p7()
    t_p8_resolver()
    t_p10_full_year_blocks()

    client = sizing_route._sb()
    if client is None:
        skip("(R3-R8, P1, P2) need the live Supabase env (pvgis_cache, "
             "catalogue pricing, the two real jobs).")
    else:
        r3 = t_r3()
        t_r4()
        if r3 is not None and isinstance(r3.get("optimal"), dict) \
                and isinstance(r3["optimal"].get("cost_breakdown"), dict):
            ctx = t_r5_r6(client, r3["optimal"])
            if ctx is not None:
                t_p1(r3["optimal"], ctx)
            else:
                skip("(P1) R5/R6 did not produce a usable battery context.")
        else:
            skip("(R5/R6, P1) R3 did not produce a usable optimum to feed "
                 "the battery fixture.")
        t_p2()
        r7 = t_r7(client)
        t_r8(client, r7.get("sol") or {})
        t_q1_red()

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
