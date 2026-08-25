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
        # 3.13 prompt 4c (W1): the undiscounted figure composes exactly as
        # the NPV does — solar plus incremental — and the stored whole IS
        # that sum. WHY IT MOVES: if either engine changed an existing figure,
        # or the route re-derived instead of composing, these sums break.
        _sol_und = (sol.get("optimal") or {}).get("undiscounted_savings_25yr")
        _inc_und = (bat.get("optimal_battery") or {}).get("undiscounted_savings_25yr")
        check("(W1) solar fin payload carries undiscounted_savings_25yr == "
              "the engine's own figure",
              sol_fin[0].get("undiscounted_savings_25yr") == _sol_und
              and isinstance(_sol_und, (int, float)),
              f"{sol_fin[0].get('undiscounted_savings_25yr')} vs {_sol_und}")
        check("(W1) battery fin payload: whole undiscounted == solar + "
              "incremental, to the cent",
              isinstance(_sol_und, (int, float))
              and isinstance(_inc_und, (int, float))
              and isinstance(bat_fin[0].get("undiscounted_savings_25yr"), (int, float))
              and abs(bat_fin[0]["undiscounted_savings_25yr"]
                      - round(_sol_und + _inc_und, 2)) <= 0.01,
              f"{bat_fin[0].get('undiscounted_savings_25yr')} vs "
              f"{_sol_und}+{_inc_und}")

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
        # 3.13 prompt 4 (S1): run_assumptions is persisted on BOTH payloads
        # and is the SAME OBJECT the response carries — asserted by identity,
        # which is stronger than equality: the route builds the dict once and
        # hands the one object to both, so no copy exists to drift.
        s_ra = sol_rec[0].get("run_assumptions")
        b_ra = bat_rec[0].get("run_assumptions")
        print(f"        solar   run_assumptions keys: {sorted(s_ra) if isinstance(s_ra, dict) else s_ra!r}")
        print(f"        battery run_assumptions keys: {sorted(b_ra) if isinstance(b_ra, dict) else b_ra!r}")
        check("(S1) solar: persisted run_assumptions IS the response's "
              "assumptions object (identity, not a copy)",
              isinstance(s_ra, dict) and s_ra is sol.get("assumptions"),
              f"identity={s_ra is sol.get('assumptions')}")
        check("(S1) battery: persisted run_assumptions IS the response's "
              "assumptions object (identity, not a copy)",
              isinstance(b_ra, dict) and b_ra is bat.get("assumptions"),
              f"identity={b_ra is bat.get('assumptions')}")
        check("(S1) both blocks carry the supply charge and its provenance — "
              "the keys the tab's assumptions panel headlines",
              isinstance(s_ra, dict) and isinstance(b_ra, dict)
              and all("supply_charge_annual" in d and "supply_charge_source" in d
                      for d in (s_ra, b_ra))
              and "resolution" in b_ra,
              "")

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

    # 3.14 prompt 2 (F195/F202, V3): the battery run's chosen_index and
    # solar_options reach BOTH the row and the response, and they are the
    # SAME — identity for the dict (the route builds it once), equality both
    # ways for the int. WHY THESE MOVE: pre-3.14 neither the payload nor the
    # response carries either key; a route that built two dicts would fail
    # the identity check even while both copies were equal.
    b_pts = bopts.get("points") if isinstance(bopts.get("points"), list) else []
    ci_row, ci_resp = bopts.get("chosen_index"), bat.get("chosen_index")
    print(f"        battery chosen_index: row={ci_row!r} response={ci_resp!r} "
          f"of {len(b_pts)} points")
    check("(V3) battery: chosen_index is an int in range of points on the "
          "ROW and on the RESPONSE, and row == response == row",
          isinstance(ci_row, int) and not isinstance(ci_row, bool)
          and 0 <= ci_row < len(b_pts)
          and ci_row == ci_resp and ci_resp == ci_row,
          f"row={ci_row!r} response={ci_resp!r}")
    check("(V3) battery: points[chosen_index] IS the response's "
          "optimal_battery (identity) and its usable_kwh == the row's "
          "battery_kwh",
          isinstance(ci_row, int) and 0 <= ci_row < len(b_pts)
          and b_pts[ci_row] is bat.get("optimal_battery")
          and b_pts[ci_row].get("usable_kwh") == bat_rec[0].get("battery_kwh"),
          f"point={b_pts[ci_row].get('usable_kwh') if isinstance(ci_row, int) and 0 <= ci_row < len(b_pts) else None!r} "
          f"row={bat_rec[0].get('battery_kwh')!r}")
    so_row, so_resp = bopts.get("solar_options"), bat.get("solar_options")
    print(f"        battery solar_options: row keys="
          f"{sorted(so_row) if isinstance(so_row, dict) else so_row!r} "
          f"response keys={sorted(so_resp) if isinstance(so_resp, dict) else so_resp!r} "
          f"identity={so_row is so_resp}")
    check("(V3) battery: persisted solar_options IS the response's "
          "solar_options (identity, both ways)",
          isinstance(so_row, dict) and so_row is so_resp and so_resp is so_row,
          f"row id={id(so_row)} response id={id(so_resp)}")
    so = so_row if isinstance(so_row, dict) else {}
    s_pts = so.get("points") if isinstance(so.get("points"), list) else []
    s_ci = so.get("chosen_index")
    s_ok = (isinstance(s_ci, int) and not isinstance(s_ci, bool)
            and 0 <= s_ci < len(s_pts))
    print(f"        battery solar_options: dims={so.get('dimension_keys')!r} "
          f"points={len(s_pts)} chosen_index={s_ci!r} "
          f"point.solar_kw={s_pts[s_ci].get('solar_kw') if s_ok else None!r} "
          f"row.solar_kw={bat_rec[0].get('solar_kw')!r}")
    check("(V3) battery: solar_options mirrors the solar run's shape — "
          "dimension_keys ['solar_kw'], a non-empty points list whose every "
          "point carries solar_kw, score and the layout keys, and an int "
          "chosen_index in range",
          so.get("dimension_keys") == ["solar_kw"] and len(s_pts) > 0
          and all(isinstance(q, dict) and "solar_kw" in q and "score" in q
                  and "plane_indices" in q and "panels_per_plane" in q
                  and "panel_count" in q for q in s_pts)
          and s_ok,
          f"dims={so.get('dimension_keys')!r} points={len(s_pts)} ci={s_ci!r}")
    check("(V3) battery: solar_options.points[chosen_index].solar_kw == the "
          "row's solar_kw == the response's chosen_solar.solar_kw",
          s_ok and s_pts[s_ci].get("solar_kw") is not None
          and s_pts[s_ci].get("solar_kw") == bat_rec[0].get("solar_kw")
          == (bat.get("chosen_solar") or {}).get("solar_kw"),
          f"point={s_pts[s_ci].get('solar_kw') if s_ok else None!r} "
          f"row={bat_rec[0].get('solar_kw')!r} "
          f"response={(bat.get('chosen_solar') or {}).get('solar_kw')!r}")
    # The solar run itself is UNCHANGED by 3.14 — no solar_options key, and
    # its curve still sits at top level.
    check("(V3) solar payload: NO solar_options key (the solar run stores "
          "its curve at top level, unchanged)",
          "solar_options" not in sopts and isinstance(sopts.get("points"), list),
          str(sorted(sopts)))
    return {"sol": sol, "bat": bat}


def t_v_persist_flag(client) -> None:
    """3.14 prompt 2 (D36, V4): persist=false computes and answers but writes
    NOTHING — no sizing row, no financial row, no jobs.quoted_value_aud — and
    says so with the flag routes/roof.py already uses. The two FAILED-write
    flags must be absent: a declined save and a broken save are two facts.
    Then the SAME call with persist omitted records exactly one insert per
    endpoint — the pair is what proves the flag does something rather than
    nothing. The recorded lists are PRINTED so an empty result is visible
    rather than assumed."""
    print("\nV4. persist=false writes NOTHING, and persist omitted writes "
          "exactly one — the pair, both endpoints, recorder in place")
    caller = _caller_for(client, TOU_JOB)
    check("(V4) OptimiseRequest.persist and BatteryRequest.persist exist and "
          "default True — additive, every existing caller unchanged",
          sizing_route.OptimiseRequest().persist is True
          and sizing_route.BatteryRequest().persist is True
          and "persist" in sizing_route.OptimiseRequest.model_fields
          and "persist" in sizing_route.BatteryRequest.model_fields, "")
    roof_src = open(os.path.join(BACKEND_DIR, "routes", "roof.py"),
                    encoding="utf-8").read()
    check("(V4) the flag string 'not_persisted_by_request' is the one "
          "routes/roof.py already uses — no second name for one fact",
          "not_persisted_by_request" in roof_src, "")
    for label, fn, req_cls, answer_key in (
        ("solar", sizing_route.optimise_sizing, sizing_route.OptimiseRequest, "optimal"),
        ("battery", sizing_route.battery_sizing, sizing_route.BatteryRequest, "optimal_battery"),
    ):
        resp, rec, fin_rec, quotes = _run_endpoint(
            fn, req_cls(job_id=TOU_JOB, persist=False), caller)
        flags = resp.get("flags") or []
        print(f"        {label} persist=false: sizing inserts recorded = {rec!r}; "
              f"financial inserts recorded = {fin_rec!r}; "
              f"quote writes recorded = {quotes!r}")
        print(f"        {label} persist=false: persisted={resp.get('persisted')!r} "
              f"financial_persisted={resp.get('financial_persisted')!r} "
              f"flags={[f for f in flags if 'persist' in str(f)]!r}")
        check(f"(V4) {label} persist=false: ZERO sizing insert attempts — the "
              "recorded list is empty",
              rec == [] and isinstance(rec, list), f"recorded={rec!r}")
        check(f"(V4) {label} persist=false: ZERO financial insert attempts "
              "and ZERO writes against jobs.quoted_value_aud",
              fin_rec == [] and quotes == [],
              f"financial={fin_rec!r} quotes={quotes!r}")
        check(f"(V4) {label} persist=false: persisted False and "
              "financial_persisted False",
              resp.get("persisted") is False
              and resp.get("financial_persisted") is False,
              f"{resp.get('persisted')!r} / {resp.get('financial_persisted')!r}")
        check(f"(V4) {label} persist=false: 'not_persisted_by_request' in flags",
              "not_persisted_by_request" in flags, str(flags)[:300])
        check(f"(V4) {label} persist=false: sizing_result_not_persisted and "
              "financial_result_not_persisted BOTH ABSENT — a declined save "
              "is not reported as a broken one",
              "sizing_result_not_persisted" not in flags
              and "financial_result_not_persisted" not in flags
              and "quote_value_not_updated" not in flags,
              str([f for f in flags if "persisted" in str(f)
                   or "quote" in str(f)]))
        check(f"(V4) {label} persist=false: the answer still arrives — "
              f"{answer_key} is a dict and there is no error",
              isinstance(resp.get(answer_key), dict) and "error" not in resp,
              f"keys={sorted(resp)[:12]}")
        if label == "battery":
            # With no row, the response is the ONLY place these exist.
            so = resp.get("solar_options")
            check("(V4) battery persist=false: the response carries "
                  "chosen_index (int) and solar_options (dict with points "
                  "and chosen_index) — the only copy there is",
                  isinstance(resp.get("chosen_index"), int)
                  and isinstance(so, dict)
                  and isinstance(so.get("points"), list)
                  and "chosen_index" in so,
                  f"chosen_index={resp.get('chosen_index')!r} "
                  f"solar_options={type(so)}")
        # THE PAIR: the same request with persist omitted.
        resp2, rec2, fin2, q2 = _run_endpoint(fn, req_cls(job_id=TOU_JOB), caller)
        print(f"        {label} persist omitted: {len(rec2)} sizing insert(s) "
              f"recorded (job_id={[r.get('job_id') for r in rec2]!r}), "
              f"{len(fin2)} financial, {len(q2)} quote write(s); "
              f"persisted={resp2.get('persisted')!r}")
        check(f"(V4) {label} persist omitted: EXACTLY ONE sizing insert, one "
              "financial insert and one quote write recorded — the flag does "
              "something rather than nothing",
              len(rec2) == 1 and len(fin2) == 1 and len(q2) == 1
              and rec2[0].get("job_id") == TOU_JOB,
              f"{len(rec2)} / {len(fin2)} / {len(q2)}")
        check(f"(V4) {label} persist omitted: persisted True, "
              "financial_persisted True, and 'not_persisted_by_request' "
              "ABSENT",
              resp2.get("persisted") is True
              and resp2.get("financial_persisted") is True
              and "not_persisted_by_request" not in (resp2.get("flags") or []),
              f"{resp2.get('persisted')!r} / {resp2.get('financial_persisted')!r}")


def t_r8(client, sol_tou: dict) -> dict:
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
    return {"sol_null": sol_null}


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


_S2_FROM = '        "run_assumptions",\n'


def t_s2_s3(client) -> None:
    print("\nS2. the allowlist entry is load-bearing — proven by removing it "
          "in a byte-hashed copy of capture.py")
    probe = {"job_id": "j", "solar_kw": 1.0, "run_assumptions": {"fit": 0.05}}
    kept = capture._filtered("sizing_results", dict(probe))
    check("(S2) GREEN: _filtered KEEPS run_assumptions with the entry in "
          "place",
          kept.get("run_assumptions") == {"fit": 0.05}, str(sorted(kept)))

    target = os.path.join(BACKEND_DIR, "capture.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")
    text = original.decode("utf-8")
    n = text.count(_S2_FROM)
    check("(S2) the allowlist line exists EXACTLY once", n == 1, f"count={n}")
    if n != 1:
        return
    tmpdir = tempfile.mkdtemp(prefix="s2_")
    backup = os.path.join(tmpdir, "capture.py.bak")
    shutil.copyfile(target, backup)
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import capture\n"
        "out = capture._filtered('sizing_results', "
        "{'job_id': 'j', 'solar_kw': 1.0, 'run_assumptions': {'fit': 0.05}})\n"
        "print('PROBE:' + json.dumps({'kept': 'run_assumptions' in out}))\n"
    )
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_S2_FROM, ""))
        _rm_pycache()
        proc = subprocess.run([sys.executable, "-c", runner],
                              capture_output=True, text=True, timeout=120)
        red = next((json.loads(l[len("PROBE:"):])
                    for l in proc.stdout.splitlines()
                    if l.startswith("PROBE:")), None)
        print(f"        without the entry: {red}")
        check("(S2) RED: without the allowlist entry the key VANISHES — the "
              "silent drop is real, which is why the entry ships in the same "
              "change as the migration",
              isinstance(red, dict) and red.get("kept") is False, repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    check("(S2) RESTORED: capture.py byte-identical (from the copy, never "
          "git)",
          restored_hash == original_hash, restored_hash)
    shutil.rmtree(tmpdir, ignore_errors=True)

    print("\nS3. the rows stored BEFORE the column existed read back NULL — "
          "a legal state, not a defect")
    rows = (client.table("sizing_results")
            .select("sizing_result_id,run_assumptions,created_at")
            .lt("created_at", "2026-08-20T13:07:00+00:00")
            .execute().data) or []
    check("(S3) the pre-migration rows are all readable (the eight known "
          "rows, none raising)",
          len(rows) >= 8, f"{len(rows)} rows")
    check("(S3) every pre-migration row reads run_assumptions NULL — no "
          "default invented assumptions they never had",
          all(r.get("run_assumptions") is None for r in rows),
          str([r["sizing_result_id"][:8] for r in rows
               if r.get("run_assumptions") is not None]))


def t_u_provenance(bat: dict, sol_null: dict) -> None:
    """3.13 prompt 4b TEST 2 — the defect, proven on the real jobs. NOTE, and
    it contradicts the prompt: the prompt asserts fit_source == 'default' on
    the fixture, claiming its tariffs row stores no feed-in figure. The LIVE
    row stores fit_aud_per_kwh = 0.05 (and every stored run records
    fit_is_fallback false), so the honest per-field label is 'installer'.
    Asserting 'default' would re-create the exact misattribution this prompt
    exists to end, in the other direction. Reported to the inbox."""
    print("\nU. per-field provenance on the REAL jobs — the defect closed")
    asm = bat.get("assumptions") or {}
    four = {k: asm.get(k) for k in ("rate_24_source", "tariff_type_source",
                                    "supply_charge_source", "fit_source")}
    print(f"        a57e13f1 (stored TOU windows): {four}")
    check("(U/tou) rate_24_source 'installer' — the installer typed those "
          "windows; pre-4b this read 'default' off the scalar's flag",
          asm.get("rate_24_source") == "installer",
          repr(asm.get("rate_24_source")))
    check("(U/tou) tariff_type_source 'installer'",
          asm.get("tariff_type_source") == "installer",
          repr(asm.get("tariff_type_source")))
    check("(U/tou) supply_charge_source 'installer' (unchanged from prompt 2)",
          asm.get("supply_charge_source") == "installer",
          repr(asm.get("supply_charge_source")))
    check("(U/tou) fit_source 'installer' — the LIVE row stores "
          "fit_aud_per_kwh 0.05 (fit_is_fallback false on every stored run), "
          "so 'default' would be the misattribution; contradicts the prompt "
          "and is reported",
          asm.get("fit_source") == "installer" and asm.get("fit_is_fallback") is False,
          f"{asm.get('fit_source')!r}/{asm.get('fit_is_fallback')!r}")

    asm_n = sol_null.get("assumptions") or {}
    four_n = {k: asm_n.get(k) for k in ("rate_24_source", "tariff_type_source",
                                        "supply_charge_source", "fit_source")}
    print(f"        456e0242 (flat installer scalar): {four_n}")
    check("(U/flat) rate_24_source 'installer' — the flat vector is the "
          "installer's stored scalar tiled",
          asm_n.get("rate_24_source") == "installer",
          repr(asm_n.get("rate_24_source")))
    check("(U/flat) the two jobs DIFFER (supply charge: installer vs not "
          "stated) — the check tests the fix, not one lucky shape",
          four != four_n and asm_n.get("supply_charge_source") == "not stated",
          f"{four} vs {four_n}")


def subprocess_probe_u() -> dict:
    """Fresh interpreter: the battery endpoint's four provenance labels on the
    fixture job, for the red proof."""
    client = sizing_route._sb()
    caller = _caller_for(client, TOU_JOB)
    bat, _r, _f, _q = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB), caller)
    asm = bat.get("assumptions") or {}
    return {k: asm.get(k) for k in ("rate_24_source", "tariff_type_source",
                                    "supply_charge_source", "fit_source")}


def _probe_u_via_subprocess() -> dict | None:
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {SCRIPTS_DIR!r})\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import verify_results_contract as g\n"
        "print('PROBE:' + json.dumps(g.subprocess_probe_u()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", runner],
                          capture_output=True, text=True, timeout=600)
    for line in proc.stdout.splitlines():
        if line.startswith("PROBE:"):
            return json.loads(line[len("PROBE:"):])
    print(f"        probe stdout: {proc.stdout[-400:]!r}")
    print(f"        probe stderr: {proc.stderr[-400:]!r}")
    return None


_U_FROM = "        rate_24_source = vector_origin\n"
_U_TO = "        rate_24_source = source\n"


def t_u_red() -> None:
    print("\nU-RED. the provenance check can FAIL — rate_24_source forced "
          "back to the old single flag in a byte-hashed copy")
    target = os.path.join(BACKEND_DIR, "routes", "sizing.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")
    text = original.decode("utf-8")
    n = text.count(_U_FROM)
    check("(U-RED) the assignment line exists EXACTLY once", n == 1, f"count={n}")
    if n != 1:
        return
    tmpdir = tempfile.mkdtemp(prefix="u_")
    backup = os.path.join(tmpdir, "sizing.py.bak")
    shutil.copyfile(target, backup)
    check("(U-RED) the byte copy was taken FIRST and matches the original hash",
          hashlib.sha256(open(backup, "rb").read()).hexdigest() == original_hash,
          backup)
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_U_FROM, _U_TO))
        _rm_pycache()
        red = _probe_u_via_subprocess()
        print(f"        perturbed probe: {red}")
        check("(U-RED) RED: with the vector's source falling back to the old "
              "single flag, the fixture's installer-typed windows read "
              "'default' again — the U check genuinely bites",
              isinstance(red, dict) and red.get("rate_24_source") == "default",
              repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"        restored SHA-256: {restored_hash}")
    check("(U-RED) RESTORED: routes/sizing.py byte-identical (from the copy, "
          "never git)",
          restored_hash == original_hash, restored_hash)
    green = _probe_u_via_subprocess()
    print(f"        restored probe : {green}")
    check("(U-RED) GREEN AGAIN after the restore",
          isinstance(green, dict) and green.get("rate_24_source") == "installer",
          repr(green))
    shutil.rmtree(tmpdir, ignore_errors=True)


def t_w2_replacement() -> None:
    """3.13 prompt 4c (W2). THIS CHECK FAILS IF THE REPLACEMENT IS IGNORED:
    the fixture's battery is replaced in year 10, and the undiscounted total
    must pay for it — a 'total savings' that quietly ignored a cost the NPV
    pays for would make the largest ROI figure the least honest."""
    print("\nW2. the battery replacement is paid undiscounted too")
    fin = {"degradation_annual_pct": 0.5, "discount_rate": 0.055,
           "tariff_escalation_pct": 0.0, "analysis_years": 25}
    with_repl = battery_optimiser.battery_financials(
        savings=1000.0, incr_capex=8000.0, hardware_cost=6000.0,
        cycles_per_year=400.0, cycle_life=4000, fin=fin)
    no_repl = battery_optimiser.battery_financials(
        savings=1000.0, incr_capex=8000.0, hardware_cost=6000.0,
        cycles_per_year=400.0, cycle_life=10_000_000, fin=fin)
    expected = round(sum(1000.0 * (1 - 0.005) ** y for y in range(1, 26))
                     - 6000.0, 2)
    print(f"        with replacement: {with_repl['undiscounted_savings_25yr']} "
          f"(gate-derived {expected}); without: "
          f"{no_repl['undiscounted_savings_25yr']}")
    check("(W2) replacement inside the horizon (year "
          f"{with_repl['replacement_year']}): the undiscounted total equals "
          "the gate's own loop MINUS the hardware cost",
          with_repl["replacement_year"] == 10
          and with_repl["undiscounted_savings_25yr"] == expected,
          f"{with_repl['undiscounted_savings_25yr']} vs {expected}")
    check("(W2) ...and differs from the no-replacement control by EXACTLY the "
          "hardware cost — ignoring the replacement would erase this gap and "
          "fail the check above",
          round(no_repl["undiscounted_savings_25yr"]
                - with_repl["undiscounted_savings_25yr"], 2) == 6000.0,
          f"gap={round(no_repl['undiscounted_savings_25yr'] - with_repl['undiscounted_savings_25yr'], 2)}")
    # The untouched keys: the NPV's replacement term is the DISCOUNTED
    # hardware cost — the same gap, divided by 1.055^10. Asserting the exact
    # relationship pins that the 4c edit changed neither term.
    npv_gap = round(no_repl["incremental_npv"] - with_repl["incremental_npv"], 2)
    check("(W2) the NPV still pays the replacement DISCOUNTED — its gap is "
          "hardware/(1.055^10), unchanged by the 4c edit",
          abs(npv_gap - round(6000.0 / (1.055 ** 10), 2)) <= 0.01,
          f"npv gap {npv_gap} vs {round(6000.0 / (1.055 ** 10), 2)}")


def subprocess_probe_w1() -> dict:
    """Fresh interpreter: does the stored whole still equal solar + incremental?"""
    client = sizing_route._sb()
    caller = _caller_for(client, TOU_JOB)
    sol, _r1, sol_fin, _q1 = _run_endpoint(
        sizing_route.optimise_sizing,
        sizing_route.OptimiseRequest(job_id=TOU_JOB), caller)
    bat, _r2, bat_fin, _q2 = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB), caller)
    s = (sol.get("optimal") or {}).get("undiscounted_savings_25yr")
    i = (bat.get("optimal_battery") or {}).get("undiscounted_savings_25yr")
    w = bat_fin[0].get("undiscounted_savings_25yr") if bat_fin else None
    ok = (isinstance(s, (int, float)) and isinstance(i, (int, float))
          and isinstance(w, (int, float)) and abs(w - round(s + i, 2)) <= 0.01)
    return {"s": s, "i": i, "w": w, "ok": ok}


def _probe_w1_via_subprocess() -> dict | None:
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {SCRIPTS_DIR!r})\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import verify_results_contract as g\n"
        "print('PROBE:' + json.dumps(g.subprocess_probe_w1()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", runner],
                          capture_output=True, text=True, timeout=600)
    for line in proc.stdout.splitlines():
        if line.startswith("PROBE:"):
            return json.loads(line[len("PROBE:"):])
    print(f"        probe stdout: {proc.stdout[-400:]!r}")
    print(f"        probe stderr: {proc.stderr[-400:]!r}")
    return None


_W_FROM = "                _sol_und + _inc_und\n"
_W_TO = "                _sol_und + _inc_und + 1.0\n"


def t_w1_red() -> None:
    print("\nW1-RED. the composition check can FAIL — one part perturbed in a "
          "byte-hashed copy of routes/sizing.py")
    target = os.path.join(BACKEND_DIR, "routes", "sizing.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    print(f"        original SHA-256: {original_hash}")
    text = original.decode("utf-8")
    n = text.count(_W_FROM)
    check("(W1-RED) the composed line exists EXACTLY once", n == 1, f"count={n}")
    if n != 1:
        return
    tmpdir = tempfile.mkdtemp(prefix="w1_")
    backup = os.path.join(tmpdir, "sizing.py.bak")
    shutil.copyfile(target, backup)
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(_W_FROM, _W_TO))
        _rm_pycache()
        red = _probe_w1_via_subprocess()
        print(f"        perturbed probe: {red}")
        check("(W1-RED) RED: one dollar added to the composed whole breaks "
              "the sum — the check genuinely bites",
              isinstance(red, dict) and red.get("ok") is False, repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored_hash = hashlib.sha256(open(target, "rb").read()).hexdigest()
    check("(W1-RED) RESTORED byte-identical (from the copy, never git)",
          restored_hash == original_hash, restored_hash)
    green = _probe_w1_via_subprocess()
    check("(W1-RED) GREEN AGAIN after the restore",
          isinstance(green, dict) and green.get("ok") is True, repr(green))
    shutil.rmtree(tmpdir, ignore_errors=True)


def _allowlist_trap(label: str, line: str, table: str, key: str,
                    probe_payload: str) -> None:
    """The S2 pattern: remove one allowlist line in a byte-hashed copy of
    capture.py and show the value VANISH, then restore by hash."""
    print(f"\n{label}. the allowlist trap — {table}.{key}")
    target = os.path.join(BACKEND_DIR, "capture.py")
    original = open(target, "rb").read()
    original_hash = hashlib.sha256(original).hexdigest()
    text = original.decode("utf-8")
    n = text.count(line)
    check(f"({label}) the entry line exists EXACTLY once", n == 1, f"count={n}")
    if n != 1:
        return
    kept = capture._filtered(table, json.loads(probe_payload))
    check(f"({label}) GREEN: _filtered KEEPS {key} with the entry in place",
          key in kept, str(sorted(kept)))
    tmpdir = tempfile.mkdtemp(prefix="trap_")
    backup = os.path.join(tmpdir, "capture.py.bak")
    shutil.copyfile(target, backup)
    runner = (
        "import json, sys\n"
        f"sys.path.insert(0, {BACKEND_DIR!r})\n"
        "import capture\n"
        f"out = capture._filtered({table!r}, json.loads({probe_payload!r}))\n"
        f"print('PROBE:' + json.dumps({{'kept': {key!r} in out}}))\n"
    )
    try:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text.replace(line, ""))
        _rm_pycache()
        proc = subprocess.run([sys.executable, "-c", runner],
                              capture_output=True, text=True, timeout=120)
        red = next((json.loads(l[len("PROBE:"):])
                    for l in proc.stdout.splitlines()
                    if l.startswith("PROBE:")), None)
        check(f"({label}) RED: without the entry the value VANISHES silently",
              isinstance(red, dict) and red.get("kept") is False, repr(red))
    finally:
        shutil.copyfile(backup, target)
        _rm_pycache()
    restored = hashlib.sha256(open(target, "rb").read()).hexdigest()
    check(f"({label}) RESTORED byte-identical", restored == original_hash,
          restored)
    shutil.rmtree(tmpdir, ignore_errors=True)


def t_w3_w4_traps() -> None:
    _allowlist_trap(
        "W3", '        "show_roi",\n', "jobs", "show_roi",
        '{"job_id": "j", "show_roi": true}')
    _allowlist_trap(
        "W4", '        "undiscounted_savings_25yr",\n', "financial_results",
        "undiscounted_savings_25yr",
        '{"job_id": "j", "undiscounted_savings_25yr": 45210.5}')


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
          and t.get("import_rate_source") == "default",
          f"supply_charge_source={t.get('supply_charge_source')!r} "
          f"import_rate_source={t.get('import_rate_source')!r}")
    fl: list[str] = []
    annual, src = sizing_route._annual_supply_charge(t, fl)
    check("(P8) ...and the annualiser carries it: 383.25 labelled "
          "'installer'",
          annual == 383.25 and src == "installer", f"{annual!r} / {src!r}")



# ── 3.14 prompt 5 (D37): the RE-COST — one candidate, the same maths, no shadow run ──
#
# A re-cost asks "what is THIS system worth under these inputs", never "which
# system is best". The constraint machinery already pins a system; what was
# missing is the right to DECLINE the throwaway unconstrained run that exists
# only to report constraint_deltas — the rail compares against the STORED run.
COMPARISON_FLAG = "unconstrained_comparison_not_run_by_request"


class _CallCounter:
    """Wraps a MODULE ATTRIBUTE so every call through it is counted and then
    delegated to the original; restored in __exit__. routes/sizing.py calls
    `solar_optimiser.optimise(...)` and `battery_optimiser.optimise_battery(...)`
    through the module objects, so the route sees the wrapper. This counts
    RUNS, which a null delta in the response cannot prove — the run could have
    happened and its result been dropped."""

    def __init__(self, module, name: str):
        self.module, self.name, self.calls = module, name, 0

    def __enter__(self):
        self.original = getattr(self.module, self.name)

        def wrapped(*a, **k):
            self.calls += 1
            return self.original(*a, **k)

        setattr(self.module, self.name, wrapped)
        return self

    def __exit__(self, *exc):
        setattr(self.module, self.name, self.original)
        return False


def _is_unconstrained(constraints_applied) -> bool:
    """3.14b prompt 1: constraints_applied now ALWAYS carries the two
    equipment-pin record keys (present-and-null means "no pin", F191), so
    "unconstrained" is no longer "an empty dict": it is every size/product key
    None and every pin-record value None."""
    if not constraints_applied:
        return True
    if not isinstance(constraints_applied, dict):
        return False
    for key, value in constraints_applied.items():
        if key in ("equipment_pin_source", "equipment_pin_unavailable"):
            if isinstance(value, dict) and any(v is not None for v in value.values()):
                return False
            continue
        if value not in (None, False):
            return False
    return True


def _pick_unconstrained(rows: list) -> tuple:
    """(the newest UNCONSTRAINED run, how many constrained ones were passed
    over) from rows already newest-first. Pure, so the suite can prove it
    MOVES ON rather than skipping the whole check."""
    skipped = 0
    for row in rows:
        ra = row.get("run_assumptions") if isinstance(row, dict) else None
        ca = (ra or {}).get("constraints_applied") if isinstance(ra, dict) else None
        if _is_unconstrained(ca):
            return row, skipped
        skipped += 1
    return None, skipped


def _newest_stored_battery_run(client, job_id: str):
    rows = (client.table("sizing_results").select("*")
            .eq("job_id", job_id).eq("run_kind", "solar_battery")
            .order("created_at", desc=True).order("sizing_result_id", desc=True)
            .limit(sizing_route.RUNS_PAGE_MAX).execute().data) or []
    stored, skipped = _pick_unconstrained(rows)
    print(f"        (X1) newest UNCONSTRAINED solar_battery run: "
          f"{(stored or {}).get('sizing_result_id')} — passed over {skipped} "
          f"constrained run(s) of {len(rows)}")
    if stored is None:
        return None, None
    fins = (client.table("financial_results").select("*")
            .eq("sizing_result_id", stored.get("sizing_result_id"))
            .order("created_at", desc=True).limit(1).execute().data) or []
    return stored, (fins[0] if fins else None)


def t_x1_recost_reproduces(client) -> dict | None:
    """THE ACCEPTANCE TEST THE FEATURE TURNS ON: a re-cost with nothing
    changed reproduces the stored run EXACTLY — solar_kw, the LAYOUT (plane
    indices and panels per plane, because two configurations can tie on kW),
    battery, system cost, the split parts, the whole-system annual savings,
    payback and NPV, and self-sufficiency. Both sets of figures print side by
    side whether it passes or fails.

    2U.2 — the fixture is read for its INPUTS: the stored run_assumptions are
    compared with what the endpoint resolves NOW, and if the job has moved
    (a new tariff, load, roof, panel) the check SKIPS LOUDLY rather than
    asserting a reproduction of inputs that no longer exist."""
    print("\nX1. THE RE-COST REPRODUCES THE STORED RUN EXACTLY (D37) — job "
          "a57e13f1, newest solar_battery run, pinned to its own array and "
          "battery, compare_to_unconstrained false, persist false")
    stored, fin = _newest_stored_battery_run(client, TOU_JOB)
    if stored is None:
        skip("(X1) a57e13f1 holds no stored solar_battery run.")
        return None
    eo = stored.get("evaluated_options") or {}
    pts = eo.get("points") if isinstance(eo.get("points"), list) else []
    ci = eo.get("chosen_index")
    so = eo.get("solar_options") or {}
    spts = so.get("points") if isinstance(so.get("points"), list) else []
    sci = so.get("chosen_index")
    split = eo.get("split") or {}
    s_only = split.get("solar_only") or {}
    s_inc = split.get("battery_increment") or {}
    cs = eo.get("chosen_solar") or {}
    ra = stored.get("run_assumptions") or {}
    print(f"        stored run {stored.get('sizing_result_id')} created "
          f"{stored.get('created_at')}; constraints_applied="
          f"{ra.get('constraints_applied')!r}")
    shape_ok = (
        isinstance(ci, int) and 0 <= ci < len(pts)
        and isinstance(sci, int) and 0 <= sci < len(spts)
        and isinstance(pts[ci].get("battery_id"), str)
        and isinstance(cs.get("plane_indices"), list)
        and isinstance(cs.get("panels_per_plane"), list)
        and bool(s_only) and bool(s_inc)
        and _is_unconstrained(ra.get("constraints_applied"))
    )
    if not shape_ok:
        skip("(X1) the newest stored run is not in the shape this check "
             "needs (a 3.14-prompt-2 row with chosen_index, solar_options, "
             "chosen_solar and split, itself unconstrained) — it was "
             f"{sorted(eo)}; constraints {ra.get('constraints_applied')!r}.")
        return None
    chosen_batt = pts[ci]
    pin = {"fix_solar_kwp": stored.get("solar_kw"),
           "battery_ids": [chosen_batt["battery_id"]]}
    caller = _caller_for(client, TOU_JOB)
    resp, rec, fin_rec, quotes = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                    compare_to_unconstrained=False,
                                    constraints=pin),
        caller)
    check("(X1) the re-cost attempted NO write — persist false, proven by the "
          "recorders",
          rec == [] and fin_rec == [] and quotes == [],
          f"{rec!r} {fin_rec!r} {quotes!r}")
    if "error" in resp:
        check("(X1) the re-cost answered", False, repr(resp.get("error")))
        return {"pin": pin, "stored": stored}

    # ── THE PREMISE (2U.2): the inputs the stored run was made from are the
    # inputs the endpoint resolves today. Compared, never assumed.
    asm = resp.get("assumptions") or {}
    drift = []
    for key in ("resolution", "import_rates_24", "fit", "export_limit_kw",
                "total_load_kwh"):
        if asm.get(key) != ra.get(key):
            drift.append((key, ra.get(key), asm.get(key)))
    sp, ap = ra.get("panel") or {}, asm.get("panel") or {}
    if (sp.get("id"), sp.get("watts")) != (ap.get("id"), ap.get("watts")):
        drift.append(("panel", sp, ap))
    if drift:
        skip("(X1) the job's inputs have CHANGED since the stored run, so a "
             "reproduction cannot be asserted against it: "
             + "; ".join(f"{k}: stored {a!r} -> now {b!r}" for k, a, b in drift))
        return {"pin": pin, "stored": stored}
    print("        inputs unchanged since the stored run: resolution, the 24 "
          "import rates, fit, export limit, annual load and panel all match")

    # ── THE COMPARISON, side by side.
    opt = resp.get("optimal_battery") or {}
    rcs = resp.get("chosen_solar") or {}
    rso = resp.get("solar_options") or {}
    rspts = rso.get("points") if isinstance(rso.get("points"), list) else []
    rsci = rso.get("chosen_index")
    rsp = rspts[rsci] if isinstance(rsci, int) and 0 <= rsci < len(rspts) else {}
    whole_sav = (
        round(rsp.get("annual_savings", 0) + opt.get("annual_savings_vs_solar_only", 0), 2)
        if isinstance(rsp.get("annual_savings"), (int, float))
        and isinstance(opt.get("annual_savings_vs_solar_only"), (int, float)) else None
    )
    whole_npv = (
        round(rsp.get("npv_25yr", 0) + opt.get("incremental_npv", 0), 2)
        if isinstance(rsp.get("npv_25yr"), (int, float))
        and isinstance(opt.get("incremental_npv"), (int, float)) else None
    )
    whole_pb = sizing_route._payback_years(opt.get("system_cost"), whole_sav)
    fin = fin or {}
    rows = [
        # label, stored, re-cost
        ("solar_kw",                 stored.get("solar_kw"),            rcs.get("solar_kw")),
        ("panel_count",              cs.get("panel_count"),             rcs.get("panel_count")),
        ("plane_indices",            cs.get("plane_indices"),           rcs.get("plane_indices")),
        ("panels_per_plane",         cs.get("panels_per_plane"),        rcs.get("panels_per_plane")),
        ("battery_id",               chosen_batt.get("battery_id"),     opt.get("battery_id")),
        ("battery model",            chosen_batt.get("model"),          opt.get("model")),
        ("battery_kwh",              stored.get("battery_kwh"),         opt.get("usable_kwh")),
        ("system_cost (whole)",      stored.get("system_cost"),         opt.get("system_cost")),
        ("self_sufficiency_pct",     chosen_batt.get("self_sufficiency_pct"), opt.get("self_sufficiency_pct")),
        ("solar-only system_cost",   s_only.get("system_cost"),         rcs.get("system_cost_solar_only")),
        ("solar-only npv_25yr",      s_only.get("npv_25yr"),            rsp.get("npv_25yr")),
        ("solar-only annual_savings", s_only.get("annual_savings"),     rsp.get("annual_savings")),
        ("solar-only payback",       s_only.get("simple_payback_years"), rsp.get("simple_payback_years")),
        ("battery_cost (added)",     s_inc.get("battery_cost"),         opt.get("battery_cost")),
        ("incremental_npv",          s_inc.get("incremental_npv"),      opt.get("incremental_npv")),
        ("incremental_payback",      s_inc.get("incremental_payback_years"), opt.get("incremental_payback_years")),
        ("incremental savings",      s_inc.get("annual_savings_vs_solar_only"), opt.get("annual_savings_vs_solar_only")),
        ("WHOLE annual_savings (fin row vs solar+increment)", fin.get("annual_savings"), whole_sav),
        ("WHOLE npv_25_year (fin row vs solar+increment)",    fin.get("npv_25_year"),    whole_npv),
        ("WHOLE payback_years (fin row vs _payback_years)",   fin.get("payback_years"),  whole_pb),
    ]
    print(f"        {'figure':52s} {'STORED':>28s}   {'RE-COST':>28s}")
    all_equal = True
    for label, a, b in rows:
        same = a == b and a is not None
        all_equal = all_equal and same
        mark = "=" if same else "≠"
        print(f"        {label:52s} {str(a):>28s} {mark} {str(b):>28s}")
    for label, a, b in rows:
        check(f"(X1) {label}: re-cost == stored", a == b and a is not None,
              f"stored={a!r} recost={b!r}")
    check("(X1) no financial row missing: the stored run HAS its financial "
          "row (the whole-system figures were compared against real values)",
          bool(fin), "no financial_results row for the stored run")
    # The recorded facts of the re-cost itself.
    flags = resp.get("flags") or []
    check("(X1) the response says where its figures came from: engine_mode "
          "'sequential' and resolution == the stored dispatch_resolution",
          resp.get("engine_mode") == "sequential"
          and resp.get("resolution") == eo.get("dispatch_resolution")
          and resp.get("resolution") == "full_year",
          f"{resp.get('engine_mode')!r} / {resp.get('resolution')!r} vs "
          f"{eo.get('dispatch_resolution')!r}")
    check("(X1) the comparison was declined BY REQUEST: constraint_deltas "
          "None, unconstrained_optimum_battery None, and the flag present",
          resp.get("constraint_deltas") is None
          and resp.get("unconstrained_optimum_battery") is None
          and COMPARISON_FLAG in flags,
          f"{resp.get('constraint_deltas')!r} / "
          f"{resp.get('unconstrained_optimum_battery')!r} / "
          f"{[f for f in flags if 'by_request' in str(f)]}")
    check("(X1) not_persisted_by_request present, and NO failed-write flag",
          "not_persisted_by_request" in flags
          and "sizing_result_not_persisted" not in flags
          and "financial_result_not_persisted" not in flags, str(flags)[:300])
    check("(X1) no 'not in the active catalogue' flag — the pinned battery "
          "was found",
          not any("not in the active catalogue" in str(f) for f in flags),
          str([f for f in flags if "catalogue" in str(f)]))
    return {"pin": pin, "stored": stored, "reproduced": all_equal}


def t_x2_decline_counted(client, pin: dict | None) -> None:
    """TEST 3 + TEST 5: the decline SKIPS the shadow run, proven by COUNTING
    optimiser calls through _CallCounter — and the DEFAULT (field omitted)
    still performs it and still returns deltas. The pair is what makes a null
    delta mean 'declined' rather than 'dropped'."""
    print("\nX2. compare_to_unconstrained: the shadow run COUNTED, both "
          "endpoints — default omitted vs false")
    if pin is None:
        skip("(X2) no pin available from X1 (no usable stored run).")
        return
    caller = _caller_for(client, TOU_JOB)
    kw = pin["fix_solar_kwp"]

    # ── battery endpoint, field OMITTED (the default).
    with _CallCounter(solar_optimiser, "optimise") as s, \
            _CallCounter(battery_optimiser, "optimise_battery") as b:
        on, *_ = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                        constraints=dict(pin)), caller)
    print(f"        battery, field omitted : solar searches={s.calls} "
          f"dispatches={b.calls} deltas={type(on.get('constraint_deltas')).__name__} "
          f"flag={COMPARISON_FLAG in (on.get('flags') or [])}")
    check("(X5/default) battery, field OMITTED: TWO solar searches and TWO "
          "dispatches — the shadow run still happens",
          s.calls == 2 and b.calls == 2, f"{s.calls} / {b.calls}")
    check("(X5/default) ...and constraint_deltas is a dict, the "
          "unconstrained optimum present, and the decline flag ABSENT",
          isinstance(on.get("constraint_deltas"), dict)
          and isinstance(on.get("unconstrained_optimum_battery"), dict)
          and COMPARISON_FLAG not in (on.get("flags") or []),
          f"{on.get('constraint_deltas')!r}")
    check("(X5/default) the model default is True on BOTH request models",
          sizing_route.BatteryRequest().compare_to_unconstrained is True
          and sizing_route.OptimiseRequest().compare_to_unconstrained is True,
          f"{sizing_route.BatteryRequest().compare_to_unconstrained!r} / "
          f"{sizing_route.OptimiseRequest().compare_to_unconstrained!r}")

    # ── battery endpoint, DECLINED.
    with _CallCounter(solar_optimiser, "optimise") as s, \
            _CallCounter(battery_optimiser, "optimise_battery") as b:
        off, *_ = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                        compare_to_unconstrained=False,
                                        constraints=dict(pin)), caller)
    print(f"        battery, declined      : solar searches={s.calls} "
          f"dispatches={b.calls} deltas={off.get('constraint_deltas')!r} "
          f"flag={COMPARISON_FLAG in (off.get('flags') or [])}")
    check("(X3) battery, DECLINED: ONE solar search and ONE dispatch — the "
          "unconstrained run was NOT performed (counted, not inferred)",
          s.calls == 1 and b.calls == 1, f"{s.calls} / {b.calls}")
    check("(X3) ...constraint_deltas None, unconstrained_optimum_battery "
          "None, the flag PRESENT",
          off.get("constraint_deltas") is None
          and off.get("unconstrained_optimum_battery") is None
          and COMPARISON_FLAG in (off.get("flags") or []), str(off.get("flags"))[:300])
    check("(X3) the declined run still dispatched at full_year — D35 stands, "
          "no shortcut for speed",
          off.get("resolution") == "full_year"
          and (off.get("assumptions") or {}).get("resolution") == "full_year",
          repr(off.get("resolution")))
    check("(X3) the declined run answers the SAME system the default run "
          "did — declining the comparison changes nothing about the result",
          (off.get("chosen_solar") or {}).get("solar_kw") == (on.get("chosen_solar") or {}).get("solar_kw")
          and (off.get("optimal_battery") or {}).get("battery_id") == (on.get("optimal_battery") or {}).get("battery_id")
          and (off.get("optimal_battery") or {}).get("system_cost") == (on.get("optimal_battery") or {}).get("system_cost"),
          f"{(off.get('optimal_battery') or {}).get('system_cost')!r} vs "
          f"{(on.get('optimal_battery') or {}).get('system_cost')!r}")

    # ── solar endpoint, the same pair.
    with _CallCounter(solar_optimiser, "optimise") as s:
        s_on, *_ = _run_endpoint(
            sizing_route.optimise_sizing,
            sizing_route.OptimiseRequest(job_id=TOU_JOB, persist=False,
                                         constraints={"fix_solar_kwp": kw}), caller)
    n_on = s.calls
    with _CallCounter(solar_optimiser, "optimise") as s:
        s_off, *_ = _run_endpoint(
            sizing_route.optimise_sizing,
            sizing_route.OptimiseRequest(job_id=TOU_JOB, persist=False,
                                         compare_to_unconstrained=False,
                                         constraints={"fix_solar_kwp": kw}), caller)
    print(f"        solar, field omitted   : solar searches={n_on} "
          f"deltas={type(s_on.get('constraint_deltas')).__name__}")
    print(f"        solar, declined        : solar searches={s.calls} "
          f"deltas={s_off.get('constraint_deltas')!r}")
    check("(X5/default) solar, field OMITTED: TWO searches and a deltas dict",
          n_on == 2 and isinstance(s_on.get("constraint_deltas"), dict)
          and isinstance(s_on.get("unconstrained_optimum"), dict)
          and COMPARISON_FLAG not in (s_on.get("flags") or []),
          f"{n_on} / {s_on.get('constraint_deltas')!r}")
    check("(X3) solar, DECLINED: ONE search, deltas None, unconstrained_optimum "
          "None, the flag present",
          s.calls == 1 and s_off.get("constraint_deltas") is None
          and s_off.get("unconstrained_optimum") is None
          and COMPARISON_FLAG in (s_off.get("flags") or []),
          f"{s.calls} / {s_off.get('constraint_deltas')!r}")
    check("(X2) both responses carry engine_mode 'sequential'; the solar "
          "response's resolution is None (no dispatch), the battery's "
          "'full_year'",
          s_off.get("engine_mode") == "sequential" and "resolution" in s_off
          and s_off.get("resolution") is None
          and off.get("engine_mode") == "sequential"
          and off.get("resolution") == "full_year",
          f"solar {s_off.get('engine_mode')!r}/{s_off.get('resolution', '<absent>')!r}; "
          f"battery {off.get('engine_mode')!r}/{off.get('resolution')!r}")


def t_x3_flag_absent_unconstrained(client) -> None:
    """TEST 4 — the pair that makes X2 mean something: with NO constraint
    active there is no shadow run to decline, so the flag must NOT fire, on
    either endpoint, even with compare_to_unconstrained false."""
    print("\nX3. no constraint active + compare_to_unconstrained false: the "
          "flag does NOT fire (a flag that appears when nothing was declined "
          "teaches a reader to ignore it)")
    # 3.14b: a job's OWN equipment pin is a constraint (prompt 1), so "no
    # constraint active" needs a job with no pins — DERIVED, never assumed
    # (2U.2). a57e13f1 now pins a panel; 456e0242 does not, and its roof
    # profiles are cached.
    unpinned_job = None
    for candidate in (TOU_JOB, NULL_JOB):
        row = (client.table("jobs")
               .select("equipment_panel_id,equipment_inverter_id,equipment_battery_id")
               .eq("job_id", candidate).limit(1).execute().data or [{}])[0]
        if not any(row.get(k) for k in ("equipment_panel_id", "equipment_inverter_id", "equipment_battery_id")):
            unpinned_job = candidate
            break
        print(f"        {candidate[:8]} carries an equipment pin "
              f"({ {k: v for k, v in row.items() if v} }) — a constraint, so not this job")
    if unpinned_job is None:
        skip("(X4) every candidate job carries an equipment pin, so 'no constraint active' "
             "cannot be constructed on live data today — clear a pin and it runs.")
        return
    print(f"        using job {unpinned_job[:8]} (no equipment pins)")
    TOU_JOB_ = unpinned_job
    caller = _caller_for(client, TOU_JOB_)
    with _CallCounter(solar_optimiser, "optimise") as s, \
            _CallCounter(battery_optimiser, "optimise_battery") as b:
        bat, rec, *_ = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB_, persist=False,
                                        compare_to_unconstrained=False), caller)
    print(f"        battery unconstrained + declined: searches={s.calls} "
          f"dispatches={b.calls} flags with 'by_request'="
          f"{[f for f in bat.get('flags') or [] if 'by_request' in str(f)]}")
    check("(X4) battery, no constraint: ONE search, ONE dispatch — nothing "
          "was skipped because nothing extra was ever going to run",
          s.calls == 1 and b.calls == 1, f"{s.calls} / {b.calls}")
    check("(X4) battery, no constraint: the decline flag is ABSENT",
          COMPARISON_FLAG not in (bat.get("flags") or []), str(bat.get("flags"))[:300])
    check("(X4) battery, no constraint: deltas None (as always when "
          "unconstrained) and the answer present",
          bat.get("constraint_deltas") is None
          and isinstance(bat.get("optimal_battery"), dict) and rec == [], "")
    with _CallCounter(solar_optimiser, "optimise") as s:
        sol, *_ = _run_endpoint(
            sizing_route.optimise_sizing,
            sizing_route.OptimiseRequest(job_id=TOU_JOB_, persist=False,
                                         compare_to_unconstrained=False), caller)
    print(f"        solar unconstrained + declined  : searches={s.calls} "
          f"flags with 'by_request'="
          f"{[f for f in sol.get('flags') or [] if 'by_request' in str(f)]}")
    check("(X4) solar, no constraint: ONE search and the decline flag ABSENT",
          s.calls == 1 and COMPARISON_FLAG not in (sol.get("flags") or []),
          f"{s.calls} / {str(sol.get('flags'))[:200]}")


def t_x4_missing_battery_named(client, pin: dict | None) -> None:
    """FALLBACK: a pinned battery that is not in the catalogue is NAMED —
    never silently replaced by an unpinned answer presented as a re-cost."""
    print("\nX4b. a pinned battery that is NOT in the catalogue is named in a flag")
    if pin is None:
        skip("(X4b) no pin available from X1.")
        return
    caller = _caller_for(client, TOU_JOB)
    ghost = "00000000-0000-4000-8000-00000000dead"
    resp, *_ = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                    compare_to_unconstrained=False,
                                    constraints={"fix_solar_kwp": pin["fix_solar_kwp"],
                                                 "battery_ids": [ghost]}), caller)
    flags = resp.get("flags") or []
    named = [f for f in flags if "not in the active catalogue" in str(f) and ghost in str(f)]
    print(f"        flag: {named[:1]!r}; optimal usable_kwh="
          f"{(resp.get('optimal_battery') or {}).get('usable_kwh')!r}")
    check("(X4b) the missing battery id is NAMED in a flag",
          len(named) == 1, str([f for f in flags if "catalogue" in str(f)]))
    check("(X4b) ...and the engine did NOT quietly search the full catalogue "
          "instead — only the no-battery baseline was evaluated",
          (resp.get("optimal_battery") or {}).get("usable_kwh") == 0.0
          and len(resp.get("candidates") or []) == 1,
          f"{len(resp.get('candidates') or [])} candidate(s)")


# ── 3.14 prompt 9 — THE 2Q.1 GATE: the two languages must agree ──────────────
#
# The history endpoint projects the chosen option's self-sufficiency in SQL
# (by the marker, via fixed-index scalars) and the frontend derives it in
# TypeScript (storedSelfSufficiencyPct, marker first). Both sides are RUN —
# the Python endpoint and the TypeScript derivation over node (the
# verify_objective_contract bridge) — never parsed (F148), and the figures are
# compared both ways for every marker-bearing run on the live fixture job.
def t_z_pins_live(client) -> None:
    """3.14b prompt 1 — LIVE, persist=False, reads only, on job a57e13f1.
      (Z0) the X1 selector MOVES ON past a constrained run (pure, constructed).
      (Z1) a request-level panel pin whose DIMENSIONS differ from the roof's
           selected_panel: the run lays out, prices and names THAT panel, and
           the layout is RE-DERIVED (a different panel area changes how many
           fit) — every expectation derived from the database in this run,
           never a figure typed in (F144).
      (Z2) a user-defined battery owned by the job's company IS evaluated —
           the case A5 shows is broken before this change (the red proof).
    cache_misses == 0 on every run: the six roof profiles are cached, so a
    PVGIS call means something is wrong."""
    print("\nZ. equipment pins reach the engine — LIVE, persist=False, reads only")
    # (Z0)
    constrained = {"sizing_result_id": "c", "run_assumptions": {"constraints_applied": {
        "panel_id": "p", "fix_solar_kwp": None,
        "equipment_pin_source": {"panel": "request", "inverter": None, "battery": None},
        "equipment_pin_unavailable": {"panel": None, "inverter": None, "battery": None}}}}
    plain = {"sizing_result_id": "u", "run_assumptions": {"constraints_applied": {
        "equipment_pin_source": {"panel": None, "inverter": None, "battery": None},
        "equipment_pin_unavailable": {"panel": None, "inverter": None, "battery": None}}}}
    legacy = {"sizing_result_id": "l", "run_assumptions": {"constraints_applied": {}}}
    picked, skipped = _pick_unconstrained([constrained, constrained, plain, legacy])
    print(f"        (Z0) selector over [constrained, constrained, plain, legacy] -> "
          f"{picked['sizing_result_id']} skipping {skipped}")
    check("(Z0) the X1 selector MOVES ON past constrained runs to the newest "
          "unconstrained one, and counts what it passed over",
          picked is plain and skipped == 2, f"{picked} / {skipped}")
    check("(Z0) present-and-null pin keys read as UNCONSTRAINED; a pinned run does not",
          _is_unconstrained(plain["run_assumptions"]["constraints_applied"])
          and _is_unconstrained({}) and _is_unconstrained(None)
          and not _is_unconstrained(constrained["run_assumptions"]["constraints_applied"]),
          "")

    caller = _caller_for(client, TOU_JOB)
    # 3.14b: the job may carry its OWN pin, which wins over a request pin by
    # design (prompt 1's precedence). Read it, never assume it (2U.2).
    job_row = (client.table("jobs").select("equipment_panel_id")
               .eq("job_id", TOU_JOB).limit(1).execute().data or [{}])[0]
    job_pin = job_row.get("equipment_panel_id") if isinstance(job_row.get("equipment_panel_id"), str) else None
    roof = (client.table("roof_geometry").select("planes,selected_panel")
            .eq("job_id", TOU_JOB).order("created_at", desc=True).limit(1).execute().data or [None])[0]
    if not roof or not isinstance(roof.get("selected_panel"), dict):
        skip("(Z1) the job's roof row or its selected_panel could not be read.")
        return
    cur = roof["selected_panel"]
    cur_area = tariff_area = None
    try:
        cur_area = float(cur["length_mm"]) * float(cur["width_mm"]) / 1e6
    except (KeyError, TypeError, ValueError):
        pass
    if cur_area is None:
        skip("(Z1) the roof's selected_panel carries no dimensions to derive from.")
        return
    panels = (client.table("panels").select("id,brand,model,rated_power_w,length_mm,width_mm,origin,status")
              .eq("status", "active").eq("origin", "catalogue").execute().data or [])
    # A DIFFERENT-dimension panel, chosen to change the per-plane capacity
    # the most — derived, never typed.
    planes = roof.get("planes") if isinstance(roof.get("planes"), list) else []
    areas = [tariffnum for tariffnum in (
        (float(p.get("usable_area_m2")) if isinstance(p, dict) and p.get("usable_area_m2") is not None else None)
        for p in planes)]
    googles = [(p.get("google_panel_count") if isinstance(p, dict) else None) for p in planes]
    def caps(area_m2):
        # 3.14b prompt 2 (F134): the per-plane capacity is the ONE shared rule
        # — the area rule CAPPED by Google's measured count where there is one.
        out = []
        for a, g in zip(areas, googles):
            c = int(a // area_m2) if a is not None else 0
            if isinstance(g, (int, float)) and not isinstance(g, bool):
                c = min(c, int(g))
            out.append(max(0, c))
        return out
    old_caps = caps(cur_area)
    best, best_diff = None, -1
    for p in panels:
        if p["id"] == cur.get("id"):
            continue
        try:
            area = float(p["length_mm"]) * float(p["width_mm"]) / 1e6
        except (KeyError, TypeError, ValueError):
            continue
        if abs(area - cur_area) < 1e-6:
            continue
        diff = sum(1 for a, b in zip(old_caps, caps(area)) if a != b)
        if diff > best_diff:
            best, best_diff, best_area = p, diff, area
    print(f"        (Z1) roof panel: {cur.get('brand')} {cur.get('model')} "
          f"{cur.get('length_mm')}x{cur.get('width_mm')} mm = {cur_area:.4f} m²; "
          f"per-plane capacity {old_caps} (area rule capped by Google {googles})")
    if best is None:
        skip("(Z1) no catalogue panel has different dimensions from the roof's.")
        return
    # The panel the ENGINE will use: the job's pin when there is one (it wins),
    # else the request's. The expectation is derived from that panel.
    requested = best
    if job_pin:
        jp = next((p for p in panels if p["id"] == job_pin), None)
        if jp is None:
            skip("(Z1) the job's pinned panel is not an active catalogue panel — cannot derive its capacity.")
            return
        best = jp
        best_area = float(jp["length_mm"]) * float(jp["width_mm"]) / 1e6
        best_diff = sum(1 for a, b in zip(old_caps, caps(best_area)) if a != b)
        print(f"        (Z1) the JOB pins {jp['brand']} {jp['model']} — it wins over the request's "
              f"{requested['brand']} {requested['model']}; expectations derive from the job's pin")
    new_caps = caps(best_area)
    print(f"        (Z1) expected panel {best['brand']} {best['model']} "
          f"{best['length_mm']}x{best['width_mm']} mm = {best_area:.4f} m²; "
          f"per-plane capacity {new_caps}")
    if best_diff == 0:
        # Identical CAPS no longer end the instrument (3.14b prompt 4 part B):
        # the wattage clause below tells a re-price from a re-derivation even
        # then, PROVIDED the rated watts differ. Only when both are identical
        # is there genuinely nothing to distinguish.
        if best.get("rated_power_w") == cur.get("watts"):
            skip("(Z1) the per-plane capacities AND rated watts are identical under "
                 "both panels, so a re-derived layout cannot be told from a re-priced "
                 "one on this roof.")
            return
        print("        (Z1) capacities identical under both panels — the wattage "
              "arithmetic is the instrument here")
    # The stored newest run's layout — PRINTED FOR CONTEXT ONLY. The original
    # check asserted the live layout DIFFERED from it, which was true only
    # while a pre-fix run was the newest stored row; Mayur pressing Size
    # stored a corrected run and erased that contrast (3.14b prompt 4 part B).
    # No assertion below leans on whatever run happens to be newest.
    newest = (client.table("sizing_results").select("solar_kw,evaluated_options")
              .eq("job_id", TOU_JOB).order("created_at", desc=True).limit(1).execute().data or [{}])[0]
    stored_layout = ((newest.get("evaluated_options") or {}).get("chosen_solar") or {}).get("panels_per_plane")
    print(f"        (Z1) newest stored run (context only): {newest.get('solar_kw')} kW, panels_per_plane {stored_layout}")

    puts: list = []
    original_cache = generation._cache_put
    generation._cache_put = lambda *a, **k: (puts.append(1) or True)
    try:
        resp, rec, fin_rec, quotes = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                        compare_to_unconstrained=False,
                                        constraints={"panel_id": requested["id"]}),
            caller)
    finally:
        generation._cache_put = original_cache
    check("(Z1) nothing was written (persist=False) and cache_misses == 0",
          rec == [] and fin_rec == [] and quotes == [] and puts == [],
          f"writes={len(rec)} cache_puts={len(puts)}")
    if "error" in resp:
        check("(Z1) the pinned run answered", False, repr(resp.get("error")))
        return
    asm = resp.get("assumptions") or {}
    used = asm.get("panel") or {}
    bd = resp.get("cost_breakdown") or {}
    line0 = ((bd.get("line_items") or [{}])[0]) or {}
    cs = resp.get("chosen_solar") or {}
    ca = asm.get("constraints_applied") or {}
    print(f"        (Z1) run_assumptions.panel = {used}")
    print(f"        (Z1) chosen_cost_breakdown.line_items[0] = {line0}")
    print(f"        (Z1) chosen_solar: {cs.get('solar_kw')} kW, panel_count {cs.get('panel_count')}, "
          f"panels_per_plane {cs.get('panels_per_plane')}")
    print(f"        (Z1) constraints_applied = {ca}")
    check("(Z1) run_assumptions.panel.id IS the pinned id",
          used.get("id") == best["id"], f"{used.get('id')} vs {best['id']}")
    check("(Z1) chosen_cost_breakdown.line_items[0].detail names the pinned brand AND model",
          best["brand"] in str(line0.get("detail")) and best["model"] in str(line0.get("detail")),
          repr(line0))
    ppp = cs.get("panels_per_plane")
    # RE-ANCHORED (3.14b prompt 4 part B): the old "differs from the stored
    # run's" contrast could only pass while a pre-fix row was newest, and
    # normal use erased it. The SAME property — the layout is derived from the
    # PINNED panel, not re-priced from the stored one — is asserted on what
    # cannot decay: this freshly computed run against (i) the pinned panel's
    # own per-plane capacity built from the roof row's STORED Google counts
    # (new_caps), and (ii) the pinned panel's own wattage arithmetic — the
    # answered kW IS sum(panels_per_plane) × its rated watts. A re-price of a
    # layout built for a different-dimension panel cannot satisfy (i) on every
    # plane the two panels disagree on, and a kW not built from the pinned
    # panel cannot satisfy (ii).
    pin_watts = used.get("watts") if isinstance(used.get("watts"), (int, float)) else None
    answered_kw = cs.get("solar_kw")
    check("(Z1) THE LAYOUT WAS RE-DERIVED from the PINNED panel, not re-priced — every "
          "plane obeys that panel's capacity under the SHARED rule (area rule capped by "
          "the roof row's stored Google counts), and sum(panels_per_plane) × its rated "
          "watts IS the answered kW. Speaks for THIS freshly computed run only, never "
          "for the stored history",
          isinstance(ppp, list) and len(ppp) == len(new_caps)
          and all(int(n) <= c for n, c in zip(ppp, new_caps))
          and pin_watts is not None and isinstance(answered_kw, (int, float))
          and abs(sum(int(n) for n in ppp) * pin_watts / 1000.0 - answered_kw) < 1e-6,
          f"layout={ppp} new_caps={new_caps} old_caps={old_caps} "
          f"watts={pin_watts} kw={answered_kw}")
    check("(Z1) ...and NO plane exceeds Google's measured count — the cap bites on the "
          "pinned path too",
          isinstance(ppp, list) and all(
              not (isinstance(g, (int, float)) and not isinstance(g, bool)) or int(n) <= int(g)
              for n, g in zip(ppp, googles)),
          f"layout={ppp} google={googles}")
    expected_source = "job" if job_pin else "request"
    check(f"(Z1) the two record keys are PRESENT: panel pinned by the {expected_source}, nothing unavailable",
          ca.get("equipment_pin_source") == {"panel": expected_source, "inverter": None, "battery": None}
          and ca.get("equipment_pin_unavailable") == {"panel": None, "inverter": None, "battery": None},
          str(ca))
    if job_pin and requested["id"] != job_pin:
        check("(Z1) the job's pin overrode the request's differing panel, and SAID so",
              any(str(f).startswith("equipment pin: the job's panel") and requested["id"] in str(f)
                  for f in resp.get("flags") or []),
              str([f for f in resp.get("flags") or [] if "equipment pin" in str(f)]))
    check("(Z1) the old 'not found — ignored' flag never appears",
          not any("ignored" in str(f) for f in resp.get("flags") or []), str(resp.get("flags"))[:200])

    # (Z2) THE USER-DEFINED BATTERY — derived from the database: one owned by
    # the job's company.
    company = (client.table("jobs").select("company_id").eq("job_id", TOU_JOB).limit(1).execute().data or [{}])[0].get("company_id")
    mine = (client.table("batteries").select("id,brand,model,usable_capacity_kwh,origin,owner_company_id,status")
            .eq("origin", "user_defined").eq("owner_company_id", company).eq("status", "active").execute().data or [])
    if not mine:
        skip("(Z2) this company owns no user-defined battery to pin.")
        return
    unit = mine[0]
    print(f"        (Z2) pinning user-defined battery {unit['brand']} {unit['model']} ({unit['id'][:8]}…) "
          f"owned by the job's company")
    puts = []
    generation._cache_put = lambda *a, **k: (puts.append(1) or True)
    try:
        resp2, rec2, *_ = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                        compare_to_unconstrained=False,
                                        constraints={"fix_solar_kwp": newest.get("solar_kw"),
                                                     "battery_ids": [unit["id"]]}),
            caller)
    finally:
        generation._cache_put = original_cache
    cands = [c.get("battery_id") for c in resp2.get("candidates") or []]
    flags2 = resp2.get("flags") or []
    print(f"        (Z2) candidates evaluated: {cands}")
    print(f"        (Z2) flags mentioning the catalogue: {[f for f in flags2 if 'catalogue' in str(f)]}")
    check("(Z2) nothing written, cache_misses == 0", rec2 == [] and puts == [], f"{len(rec2)} / {len(puts)}")
    check("(Z2) the user-defined battery IS evaluated — it is a candidate, by id",
          unit["id"] in cands, str(cands))
    check("(Z2) ...and NOT flagged 'not in the active catalogue' — the silent filter is gone",
          not any("not in the active catalogue" in str(f) for f in flags2), str(flags2)[:300])
    check("(Z2) the record says the battery came from the request and nothing was unavailable",
          ((resp2.get("assumptions") or {}).get("constraints_applied") or {}).get("equipment_pin_source", {}).get("battery") == "request"
          and ((resp2.get("assumptions") or {}).get("constraints_applied") or {}).get("equipment_pin_unavailable", {}).get("battery") is None,
          str(((resp2.get("assumptions") or {}).get("constraints_applied") or {})))


def t_z3_own_panel_reproduces(client) -> None:
    """3.14b prompt 2 (F134), LIVE, persist=False: pinning the roof's OWN panel
    with compare_to_unconstrained=True must reproduce the unpinned run — every
    constraint delta ZERO and the same per-plane layout as the newest
    UNPINNED stored run (derived here). While the job pins a DIFFERENT panel
    (which wins by design), that form is loudly skipped and the instrument is
    the live run alone: the Google cap plus the pinned panel's own wattage
    arithmetic — re-anchored at 3.14b prompt 4 part B after normal use erased
    the original stored-run contrast."""
    print("\nZ3. pinning the roof's OWN panel reproduces the unpinned answer — LIVE, persist=False")
    caller = _caller_for(client, TOU_JOB)
    roof = (client.table("roof_geometry").select("selected_panel,planes")
            .eq("job_id", TOU_JOB).order("created_at", desc=True).limit(1).execute().data or [None])[0]
    own = ((roof or {}).get("selected_panel") or {}).get("id")
    if not own:
        skip("(Z3) the roof's selected_panel has no id to pin.")
        return
    rows = (client.table("sizing_results").select("*")
            .eq("job_id", TOU_JOB).eq("run_kind", "solar_battery")
            .order("created_at", desc=True).order("sizing_result_id", desc=True)
            .limit(sizing_route.RUNS_PAGE_MAX).execute().data) or []
    unpinned, passed = _pick_unconstrained(rows)
    if unpinned is None:
        skip("(Z3) no unconstrained stored run to compare the pinned layout against.")
        return
    stored_layout = (((unpinned.get("evaluated_options") or {}).get("chosen_solar") or {}).get("panels_per_plane"))
    print(f"        (Z3) own panel {own[:8]}…; newest UNPINNED run {unpinned.get('sizing_result_id')[:8]}… "
          f"(passed over {passed}) layout {stored_layout}, {unpinned.get('solar_kw')} kW")
    googles = [p.get("google_panel_count") if isinstance(p, dict) else None for p in (roof or {}).get("planes") or []]
    job_row = (client.table("jobs").select("equipment_panel_id")
               .eq("job_id", TOU_JOB).limit(1).execute().data or [{}])[0]
    job_pin = job_row.get("equipment_panel_id") if isinstance(job_row.get("equipment_panel_id"), str) else None
    puts: list = []
    original_cache = generation._cache_put
    generation._cache_put = lambda *a, **k: (puts.append(1) or True)
    try:
        resp, rec, fin_rec, quotes = _run_endpoint(
            sizing_route.battery_sizing,
            sizing_route.BatteryRequest(job_id=TOU_JOB, persist=False,
                                        compare_to_unconstrained=True,
                                        constraints={"panel_id": own}),
            caller)
    finally:
        generation._cache_put = original_cache
    check("(Z3) nothing written and cache_misses == 0",
          rec == [] and fin_rec == [] and quotes == [] and puts == [], f"writes={len(rec)} puts={len(puts)}")
    if "error" in resp:
        check("(Z3) the pinned run answered", False, repr(resp.get("error")))
        return
    deltas = resp.get("constraint_deltas")
    cs = resp.get("chosen_solar") or {}
    opt = resp.get("optimal_battery") or {}
    unc = resp.get("unconstrained_optimum_battery") or {}
    used = ((resp.get("assumptions") or {}).get("panel") or {}).get("id")
    print(f"        (Z3) constraint_deltas = {deltas}")
    print(f"        (Z3) panel used {str(used)[:8]}…; pinned layout {cs.get('panels_per_plane')} "
          f"({cs.get('solar_kw')} kW, {cs.get('panel_count')} panels); Google {googles}")
    print(f"        (Z3) pinned battery {opt.get('battery_id')} ${opt.get('system_cost')} vs unconstrained "
          f"{unc.get('battery_id')} ${unc.get('system_cost')}")
    ppp = cs.get("panels_per_plane")
    check("(Z3) NO plane exceeds Google's measured count on the pinned path",
          isinstance(ppp, list) and all(
              not (isinstance(g, (int, float)) and not isinstance(g, bool)) or int(n) <= int(g)
              for n, g in zip(ppp, googles)),
          f"layout={ppp} google={googles}")
    if job_pin is None or job_pin == own:
        # THE JOB IS UNPINNED (or pins its own panel): the request's own-panel
        # pin reaches the engine and must reproduce the unpinned run exactly.
        check("(Z3) constraint_deltas is PRESENT and every numeric delta is ZERO — pinning the "
              "roof's own panel changes nothing",
              isinstance(deltas, dict) and len(deltas) > 0
              and all(v == 0 for v in deltas.values() if isinstance(v, (int, float)) and not isinstance(v, bool)),
              str(deltas))
        check("(Z3) chosen_solar.panels_per_plane == the newest UNPINNED stored run's layout, "
              "re-derived from the database in this run",
              cs.get("panels_per_plane") == stored_layout and stored_layout is not None,
              f"{cs.get('panels_per_plane')} vs {stored_layout}")
        check("(Z3) the pinned answer IS the unconstrained answer — same battery, same whole-system cost",
              opt.get("battery_id") == unc.get("battery_id") and opt.get("system_cost") == unc.get("system_cost"),
              f"{opt.get('battery_id')}/{opt.get('system_cost')} vs {unc.get('battery_id')}/{unc.get('system_cost')}")
    else:
        # THE JOB PINS A DIFFERENT PANEL, which wins over the request by design
        # (3.14b prompt 1) — so the zero-delta form cannot be asserted on this
        # job while its pin stands. Said loudly. The original fallback here
        # contrasted the live layout against a stored run made BEFORE the
        # prompt-2 fix; Mayur pressing Size stored a corrected run and erased
        # that contrast (3.14b prompt 4 part B). The instrument is now the
        # live run alone: the cap check above (roof row's own stored Google
        # counts), plus the pinned panel's wattage arithmetic below — neither
        # of which a new stored row can erase.
        skip(f"(Z3) job a57e13f1 pins panel {job_pin[:8]}…, which wins over the request's own-panel "
             "pin, so 'deltas all zero against the unpinned run' cannot be asserted on this job "
             "while that pin stands — it runs the moment the pin is cleared.")
        check("(Z3) the job's pin was used and the request's own-panel pin was overridden AND flagged",
              used == job_pin and any(str(f).startswith("equipment pin: the job's panel") for f in resp.get("flags") or []),
              f"used={used} flags={[f for f in resp.get('flags') or [] if 'equipment pin' in str(f)]}")
        pin_watts = ((resp.get("assumptions") or {}).get("panel") or {}).get("watts")
        answered_kw = cs.get("solar_kw")
        print(f"        (Z3) pinned panel watts {pin_watts}; sum(layout) {sum(int(n) for n in ppp) if isinstance(ppp, list) else None} "
              f"-> {sum(int(n) for n in ppp) * pin_watts / 1000.0 if isinstance(ppp, list) and isinstance(pin_watts, (int, float)) else None} kW "
              f"vs answered {answered_kw} kW")
        check("(Z3) THE ARRAY IS BUILT FROM THE PINNED PANEL — sum(panels_per_plane) × the "
              "answer's own rated watts IS the answered kW; with the Google-cap check above "
              "this speaks for the LIVE pinned run only, never for the stored history",
              isinstance(ppp, list)
              and isinstance(pin_watts, (int, float)) and not isinstance(pin_watts, bool)
              and isinstance(answered_kw, (int, float))
              and abs(sum(int(n) for n in ppp) * pin_watts / 1000.0 - answered_kw) < 1e-6,
              f"layout={ppp} watts={pin_watts} kw={answered_kw}")


def t_y_two_languages_agree(client) -> None:
    """A skip here goes through skip(), which counts it — NOT a pass."""
    print("\nY. self-sufficiency by the marker — SQL projection vs TypeScript "
          "derivation, every marker-bearing run on a57e13f1, both directions")
    caller = _caller_for(client, TOU_JOB)
    # The Python side: the endpoint, RUN.
    page = asyncio.run(sizing_route.sizing_runs(
        job_id=TOU_JOB, limit=sizing_route.RUNS_PAGE_MAX, offset=0, caller=caller))
    runs = page.get("runs") or []
    check("(Y) the endpoint answered with the whole history (not truncated)",
          page.get("truncated") is False and len(runs) == page.get("total"),
          f"returned={page.get('returned')} total={page.get('total')} "
          f"truncated={page.get('truncated')}")
    # The job payload the frontend derives from, RUN through the same route
    # the worksheet uses; it hydrates child tables at _HYDRATION_LIMIT.
    job = asyncio.run(job_route.get_job(TOU_JOB, caller))
    rows = job.get("sizing_results") or []
    if len(rows) != len(runs):
        skip("(Y) the job payload hydrates "
             f"{len(rows)} sizing rows but the history holds {len(runs)} — the "
             "payload is capped at _HYDRATION_LIMIT, so the two sides cannot be "
             "compared run-for-run today.")
        return
    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(rows, fh, default=str)
        rows_path = fh.name
    script = (
        'import { storedSelfSufficiencyPct } from "./lib/worksheet.ts"; '
        'import { readFileSync } from "node:fs"; '
        f"const rows = JSON.parse(readFileSync({rows_path!r}, 'utf8')); "
        "const out = {}; "
        "for (const r of rows) { out[r.sizing_result_id] = "
        "storedSelfSufficiencyPct(r, r.evaluated_options ?? {}); } "
        "console.log(JSON.stringify(out));"
    )
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=frontend, capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        skip("(Y) node is not available, so the TypeScript side cannot be RUN.")
        return
    finally:
        os.unlink(rows_path)
    if proc.returncode != 0:
        check("(Y) node ran the TypeScript derivation", False,
              (proc.stderr or "").strip()[:300])
        return
    ts_side = json.loads(proc.stdout.strip())
    py_side = {r["sizing_result_id"]: r.get("self_sufficiency_pct") for r in runs}
    marked = {r["sizing_result_id"] for r in runs if r.get("has_chosen_marker")}
    print(f"        {'run':10s} {'marker':7s} {'SQL projection':>16s} {'TS derivation':>16s}")
    for r in runs:
        sid = r["sizing_result_id"]
        print(f"        {sid[:8]:10s} {str(sid in marked):7s} "
              f"{str(py_side.get(sid)):>16s} {str(ts_side.get(sid)):>16s}")
    py_marked = {sid: py_side.get(sid) for sid in marked}
    ts_marked = {sid: ts_side.get(sid) for sid in marked}
    print(f"        SQL, marker runs : {py_marked}")
    print(f"        TS,  marker runs : {ts_marked}")
    check("(Y/premise) the fixture job holds marker-bearing runs AND pre-marker "
          "runs — both branches are exercised",
          0 < len(marked) < len(runs), f"{len(marked)} of {len(runs)} marked")
    check("(Y) for every marker-bearing run: SQL == TypeScript",
          all(py_marked[s] == ts_marked[s] for s in marked),
          str({s[:8]: (py_marked[s], ts_marked[s]) for s in marked if py_marked[s] != ts_marked[s]}))
    check("(Y) ...and TypeScript == SQL (the other direction, key for key)",
          all(ts_marked[s] == py_marked[s] for s in marked)
          and set(py_marked) == set(ts_marked), "")
    check("(Y) every marker-bearing run RESOLVED on both sides — a number, "
          "never null",
          all(isinstance(py_marked[s], (int, float)) for s in marked)
          and all(isinstance(ts_marked[s], (int, float)) for s in marked),
          str([s[:8] for s in marked if py_marked[s] is None or ts_marked[s] is None]))
    unmarked = [r["sizing_result_id"] for r in runs if r["sizing_result_id"] not in marked]
    check("(Y) every PRE-MARKER run is NULL on the SQL side — never matched by "
          "numbers in a second language",
          all(py_side.get(s) is None for s in unmarked),
          str([s[:8] for s in unmarked if py_side.get(s) is not None]))
    print(f"        pre-marker runs, TS legacy fallback: "
          f"{ {s[:8]: ts_side.get(s) for s in unmarked} }")
    # The lean guarantee from prompt 7 still holds after the projection.
    blob = json.dumps(page)
    present = sorted(k for k in sizing_route.RUNS_FORBIDDEN_KEYS if f'"{k}"' in blob)
    check("(Y) the history stays LEAN — none of the heavy keys appear",
          present == [], str(present))
    check("(Y) self_consumption_ratio is gone from the history",
          "self_consumption_ratio" not in blob
          and all("self_consumption_ratio" not in r for r in runs), "")

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
    t_w2_replacement()
    t_w3_w4_traps()

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
        r8 = t_r8(client, r7.get("sol") or {})
        t_u_provenance(r7.get("bat") or {}, (r8 or {}).get("sol_null") or {})
        t_v_persist_flag(client)
        x1 = t_x1_recost_reproduces(client)
        t_x2_decline_counted(client, (x1 or {}).get("pin"))
        t_x3_flag_absent_unconstrained(client)
        t_x4_missing_battery_named(client, (x1 or {}).get("pin"))
        t_y_two_languages_agree(client)
        t_z_pins_live(client)
        t_z3_own_panel_reproduces(client)
        t_q1_red()
        t_u_red()
        t_w1_red()
        t_s2_s3(client)

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
