#!/usr/bin/env python3
"""
verify_battery_contract.py — the 3.12 prompt-1 gate: one meaning of budget_aud
on BOTH sizing endpoints, an `hours` value that is not a list, plain-English
engine sentences, and an honest reason on every no-battery outcome.

  B1  THE BUDGET CONTRACT, on a SYNTHETIC JOB-FREE FIXTURE that provably
      chooses a battery: one derived cap, both endpoints, the chosen
      whole-system cost obeys the cap or within_budget is false, and the
      capped battery answer names the BUDGET rather than economics (F152, D33).
      There is NO skip path — a fixture that fails to choose a battery is a
      BROKEN FIXTURE and fails the gate. (Prompt 1's B1 ran against the one
      live job, whose near-vertical roof means no battery is ever economic, so
      it skipped on every run and the central F152 claim went unmeasured —
      F177. The fixture is ours to make bite; a live job is not.)
  B2  every candidate carries system_cost == round(solar_only + battery_cost, 2),
      the baseline's equals solar_only, and the baseline is still the ONLY
      no-choice point (the count verify_sizing_result_storage.py permits) —
      run against BOTH the fixture and the live job
  BL  the LIVE job end-to-end: both endpoints against stored job state, and the
      writer's within_budget DERIVED from the persisted system_cost under a cap
      that bites. It does NOT speak for the two-endpoint budget contract — B1
      owns that (2R.3: a check names the subset it speaks for).
  B3  F142: five window shapes through _build_rate_24, expected outputs DERIVED
      by running the function, plus the F136 flat-window regression guard
  B4  F161 made mechanical: no snake_case identifier in any installer-facing
      string ORIGINATING IN battery_optimiser.py (the route's own markers are
      deliberately OUT of scope — they are load-bearing machine prefixes)
  B5  every no-battery outcome carries a non-empty not_economic_reason; the
      budget-driven and economics-driven reasons are DIFFERENT strings; the
      reason is null when a battery IS chosen
  B6  the database delta (F77): thirteen counts read at start, asserted
      unchanged at the end — never an absolute count

RUNS the code, never parses it (F148). WRITES NOTHING: capture.save_sizing_result
is replaced by a recorder for every endpoint run (the t_f_endpoint_payloads
pattern) and restored in a finally; generation._cache_put is no-opped.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_battery_contract.py
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import battery_optimiser  # noqa: E402
import capture  # noqa: E402
import cost_model  # noqa: E402
import generation  # noqa: E402
import solar_irradiance  # noqa: E402
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


LIVE_JOB = "456e0242-17f9-4b2a-8faa-f664ddd9eed9"

# The snake_case shape a database identifier leaks through (B4). Lowercase
# words joined by underscores — exactly the shape of a column name.
SNAKE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")

# battery_financials reads exactly these four keys; hardcoded so B4/B5 run
# offline with no dependency on cost_assumptions being reachable.
FIN = {"degradation_annual_pct": 0.5, "discount_rate": 0.05,
       "tariff_escalation_pct": 2.0, "analysis_years": 25}


# ── B6: the thirteen counts, direct Postgres (F77) ────────────────────────────
_PUBLIC_TABLES = ["companies", "company_members", "jobs", "roof_geometry",
                  "interval_data", "bills", "surveys", "load_profiles",
                  "tariffs", "sizing_results", "financial_results"]


def _counts() -> dict | None:
    """All thirteen counts over the direct Postgres connection, or None with a
    LOUD, uncounted skip (2Q.1) when the bridge is absent — never a pass."""
    global SKIPPED
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        psycopg2 = None
    if not db_url or psycopg2 is None:
        SKIPPED += 1
        print("  SKIP  (B6) the thirteen counts need SUPABASE_DB_URL + psycopg2 "
              "(auth.users and storage.objects are not REST-visible). NOT "
              "counted as a pass.")
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


# ── Endpoint runner: recorder in place, nothing written ──────────────────────
def _gate_caller(client) -> auth.Caller:
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", LIVE_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    return auth.Caller(user_id="gate-runner", email="gate@example.com",
                       company_id=company_id, role="owner")


def _run_endpoint(coro_fn, request, caller):
    """Run one endpoint with BOTH writers replaced by recorders, restored in a
    finally. Returns (response, [persist payloads]). generation._cache_put is
    no-opped so a lookup that ever missed still could not write pvgis_cache."""
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


def _run_battery(caller, budget):
    resp, rec = _run_endpoint(
        sizing_route.battery_sizing,
        sizing_route.BatteryRequest(job_id=LIVE_JOB, budget=budget), caller)
    return resp, (rec[0] if rec else {})


def _run_solar(caller, budget):
    resp, rec = _run_endpoint(
        sizing_route.optimise_sizing,
        sizing_route.OptimiseRequest(job_id=LIVE_JOB, budget=budget), caller)
    return resp, (rec[0] if rec else {})


# ── THE FIXTURE (R1) ─────────────────────────────────────────────────────────
# A synthetic, JOB-FREE site built entirely from PROFILES ALREADY IN
# pvgis_cache, so the gate never touches the network. Both endpoints accept a
# fully explicit body, and both guard their persist block on `if body.job_id:`
# — so a body with no job_id CANNOT write a sizing_results row. R3 asserts that
# rather than trusting it.
#
# lat/lon are exact multiples of generation.GRID_DEG, so _grid() is the
# identity on them (asserted, not assumed) and the cache keys resolve to the
# two Adelaide rows at 1848.32 (north) and 1588.20 (east) kWh/kWp.
FIX_LAT, FIX_LON = -34.93, 138.60
FIX_TILT = 22.0
# The Jinko 440 W catalogue panel — a real priced row, so cost_model returns a
# real bottom-up cost rather than a default.
FIX_PANEL_ID = "7ea2822f-2293-42b0-a511-88d33843699b"
FIX_PANEL_W = 440
# WHY A BATTERY WINS HERE, stated so the fixture can be argued with: a big
# north-facing array generates ~17 MWh against a 14 MWh load whose consumption
# is concentrated at 18:00-21:00, hours at which generation is zero. Every
# surplus kWh is worth $0.05 exported but $0.45 when discharged into the
# evening instead — a $0.40/kWh margin on every cycled kWh. That gap — surplus
# at midday, demand after sunset — is exactly what a battery is paid to close.
#
# ONE FLAT TARIFF FOR BOTH ENDPOINTS, deliberately (3.12 pricing fix): the two
# endpoints must now agree on the chosen solar, and a stateless OptimiseRequest
# can only carry a flat rate — so the battery body carries NO tou_windows
# either, and the agreement check below holds the two to the same answer.
FIX_ANNUAL_LOAD_KWH = 14000.0
FIX_LOAD_SHAPE = ([0.2] * 6 + [0.4, 0.6, 0.5, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,
                               0.5, 0.8, 2.2, 3.2, 3.2, 2.6, 1.6, 0.8, 0.4])
FIX_FLAT_RATE = 0.45   # both endpoints' import rate — one price, one meaning
FIX_FIT = 0.05
FIX_EXPORT_LIMIT_KW = 5.0


def _derive_azimuth_for_aspect(aspect: float) -> float:
    """The Google azimuth that produces this PVGIS aspect, DERIVED by running
    the converter over every whole degree — never a number typed into a prompt
    (a value I did not derive is a value I cannot defend). Exactly one whole
    degree must produce each aspect, and that uniqueness is asserted."""
    hits = [g for g in range(360)
            if solar_irradiance.google_azimuth_to_pvgis_aspect(float(g)) == aspect]
    check(f"(B1/fixture) exactly one whole-degree Google azimuth gives PVGIS "
          f"aspect {aspect} — derived by running the converter",
          len(hits) == 1, f"{hits}")
    return float(hits[0]) if hits else 0.0


def _fixture_load() -> list[float]:
    """8,760 hours, evening-heavy, energy preserved at FIX_ANNUAL_LOAD_KWH."""
    total = sum(FIX_LOAD_SHAPE)
    frac = [x / total for x in FIX_LOAD_SHAPE]
    daily = FIX_ANNUAL_LOAD_KWH / 365.0
    return [daily * frac[h] for _ in range(365) for h in range(24)]


def t_b1_fixture() -> None:
    """B1 — the budget contract, on a fixture that PROVABLY chooses a battery.
    NO SKIP PATH: a fixture that fails to choose one is a broken fixture and
    fails the gate (the fixture is ours to control; a live job is not)."""
    print("B1. THE BUDGET CONTRACT — synthetic, job-free fixture (no skip path)")

    check("(B1/fixture) lat is an exact GRID_DEG multiple, so _grid() is the "
          "identity and the cache key is the one we intend",
          generation._grid(FIX_LAT) == FIX_LAT, f"{generation._grid(FIX_LAT)}")
    check("(B1/fixture) lon is an exact GRID_DEG multiple",
          generation._grid(FIX_LON) == FIX_LON, f"{generation._grid(FIX_LON)}")

    az_north = _derive_azimuth_for_aspect(-180.0)
    az_east = _derive_azimuth_for_aspect(-90.0)
    print(f"        azimuth_google {az_north} -> aspect "
          f"{solar_irradiance.google_azimuth_to_pvgis_aspect(az_north)} (north)")
    print(f"        azimuth_google {az_east} -> aspect "
          f"{solar_irradiance.google_azimuth_to_pvgis_aspect(az_east)} (east)")

    # Plane keys are the roof_geometry shape (pitch/azimuth/panel_count/kwp) —
    # read off a live roof_geometry row, not invented. generation.normalise_planes
    # accepts pitch/azimuth; solar_optimiser reads panel_count and kwp.
    planes = [
        {"pitch": FIX_TILT, "azimuth": az_north, "panel_count": 24,
         "kwp": round(24 * FIX_PANEL_W / 1000.0, 2)},
        {"pitch": FIX_TILT, "azimuth": az_east, "panel_count": 12,
         "kwp": round(12 * FIX_PANEL_W / 1000.0, 2)},
    ]
    candidate_configs = [{"plane_indices": [0]}, {"plane_indices": [0, 1]}]

    # (b) THE OFFLINE PROOF. Neither sandbox can reach PVGIS, so a gate that
    # silently began calling it would fail for reasons unrelated to what it
    # measures. Make the offline property OBSERVABLE. _cache_put is no-opped
    # for the probe too, so even a miss could not write pvgis_cache.
    original_cache = generation._cache_put
    generation._cache_put = lambda *a, **k: None
    try:
        built = generation.build_plane_profiles(planes, FIX_LAT, FIX_LON, 9.5)
    finally:
        generation._cache_put = original_cache
    wanted = [(generation._grid(FIX_LAT), generation._grid(FIX_LON), FIX_TILT, a)
              for a in (-180.0, -90.0)]
    print(f"        cache_hits={built['cache_hits']} "
          f"cache_misses={built['cache_misses']} "
          f"failed_planes={built['failed_planes']}")
    print(f"        plane annual kWh/kWp: "
          f"{[p['annual_kwh_per_kwp'] for p in built['planes']]}")
    check("(B1/fixture) every plane profile came from pvgis_cache — 0 misses, "
          "0 failures, hits == plane count (the gate never calls PVGIS)",
          built["cache_misses"] == 0 and built["failed_planes"] == []
          and built["cache_hits"] == len(planes),
          f"hits={built['cache_hits']} misses={built['cache_misses']} "
          f"failed={built['failed_planes']} — wanted cached rows at "
          f"(lat_cell, lon_cell, tilt, aspect) {wanted}")

    load = _fixture_load()
    common = dict(planes=planes, candidate_configs=candidate_configs,
                  lat=FIX_LAT, lon=FIX_LON, panel_id=FIX_PANEL_ID,
                  panel_watts=FIX_PANEL_W, load_hourly_8760=load,
                  load_source="representative", fit=FIX_FIT,
                  export_limit_kw=FIX_EXPORT_LIMIT_KW, postcode="5000",
                  state="SA", objective="max_npv")
    # No job to own, so no ownership read runs (both endpoints guard it on
    # job_id) — a synthetic company is correct here, not a shortcut.
    caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                         company_id="co-gate-fixture", role="owner")
    print(f"        annual load {round(sum(load), 1)} kWh, flat "
          f"${FIX_FLAT_RATE}/kWh import vs ${FIX_FIT} feed-in on BOTH endpoints")

    def solar_run(budget):
        return _run_endpoint(sizing_route.optimise_sizing,
                             sizing_route.OptimiseRequest(
                                 import_rate=FIX_FLAT_RATE, budget=budget, **common),
                             caller)

    def battery_run(budget):
        # SAME tariff as the solar run — no tou_windows, one flat rate. The
        # agreement check below is what this buys: both endpoints must choose
        # the same solar under the same price (3.12 pricing fix).
        return _run_endpoint(sizing_route.battery_sizing,
                             sizing_route.BatteryRequest(
                                 import_rate=FIX_FLAT_RATE,
                                 budget=budget, **common),
                             caller)

    # ── (d1) both endpoints, uncapped ──
    sol0, sol0_rec = solar_run(None)
    bat0, bat0_rec = battery_run(None)

    # ── R3: the job_id guard is a CLAIM about the code; this makes it a FACT
    # about the run. The recorders above intercept every write attempt.
    check("(R3) job-free solar run attempted ZERO persists",
          sol0_rec == [], f"{len(sol0_rec)} payload(s)")
    check("(R3) job-free battery run attempted ZERO persists",
          bat0_rec == [], f"{len(bat0_rec)} payload(s)")

    opt_s = sol0.get("optimal") or {}
    opt_b = bat0.get("optimal_battery") or {}
    chosen_solar = bat0.get("chosen_solar") or {}
    S = opt_s.get("system_cost")
    S_b = chosen_solar.get("system_cost_solar_only")
    incr = opt_b.get("battery_cost")
    print(f"        solar endpoint  : {opt_s.get('solar_kw')} kW, "
          f"generation {opt_s.get('annual_generation_kwh')} kWh, S=${S}")
    print(f"        battery endpoint: solar-only ${S_b} + battery "
          f"{opt_b.get('model')!r} {opt_b.get('usable_kwh')} kWh "
          f"(incremental ${incr}, NPV ${opt_b.get('incremental_npv')})")
    check("(B1/fixture) both endpoints returned numbers (no error body)",
          isinstance(S, (int, float)) and isinstance(S_b, (int, float))
          and isinstance(incr, (int, float)),
          f"S={S!r} S_b={S_b!r} incr={incr!r} "
          f"solar_error={sol0.get('error')!r} battery_error={bat0.get('error')!r}")
    if not (isinstance(S, (int, float)) and isinstance(S_b, (int, float))
            and isinstance(incr, (int, float))):
        return

    # ── THE AGREEMENT CHECK, flat case (3.12 pricing fix — the control). Both
    # endpoints were given the SAME flat tariff, so they must choose the SAME
    # solar. On a flat tariff the old scalar and the old 24-hour mean were the
    # same number, so this case passes even against pre-fix code — it is the
    # control that proves the TOU case below fails for the price vector and
    # not for some other divergence between the two endpoints.
    check("(AGREE/flat) both endpoints choose the SAME solar_kw under one "
          "flat tariff",
          opt_s.get("solar_kw") == chosen_solar.get("solar_kw"),
          f"solar endpoint {opt_s.get('solar_kw')} kW vs battery endpoint "
          f"{chosen_solar.get('solar_kw')} kW")
    check("(AGREE/flat) ...and the SAME solar-only system_cost",
          S == S_b, f"${S} vs ${S_b}")

    C = round(S_b + incr, 2)
    check("(B1/fixture) C (whole-system cost) == the chosen candidate's own "
          "system_cost key — the response's two numbers agree",
          opt_b.get("system_cost") == C, f"{opt_b.get('system_cost')} vs {C}")

    # ── (d2) THE FIXTURE'S OWN HEALTH CHECK. No skip: if the fixture does not
    # choose a battery it is not exercising the fault and the gate says so.
    check("(B1/fixture) THE FIXTURE BITES: a battery IS chosen, so C > S "
          "(if this fails the FIXTURE is wrong, not the product — re-tune the "
          "tariff spread or the load until a battery wins; never add a skip)",
          C > S and (opt_b.get("usable_kwh") or 0) > 0,
          f"S={S} C={C} usable_kwh={opt_b.get('usable_kwh')}")
    if not (C > S):
        return

    # ── B2 arithmetic on the fixture — the more valuable of the two runs,
    # because the fixture's pool actually HAS batteries in it.
    _b2_candidates("fixture", bat0.get("candidates") or [], S_b)

    # ── (d3) THE CAP, DERIVED, never typed (F156) ──
    cap = round((S + C) / 2.0, 2)
    batt_costs = [c["system_cost"] for c in (bat0.get("candidates") or [])
                  if c.get("battery_id") is not None and "system_cost" in c]
    cheapest = min(batt_costs) if batt_costs else None
    print(f"        S=${S}  C=${C}  derived cap = (S + C) / 2 = ${cap}")
    print(f"        cheapest solar-plus-battery system in the pool: ${cheapest}")
    check("(B1/fixture) the cap provably lies between S and C — it admits the "
          "solar and excludes the chosen battery",
          S < cap < C, f"S={S} cap={cap} C={C}")
    check("(B1/fixture) FIXTURE HEALTH: the cap excludes EVERY battery in the "
          "pool, so a battery surviving it is the fault, never a cheaper "
          "candidate legitimately fitting (re-tune the fixture if this fails)",
          cheapest is not None and cap < cheapest,
          f"cap={cap} cheapest battery system_cost={cheapest}")

    # ── (d4) both endpoints again, under the cap ──
    sol1, sol1_rec = solar_run(cap)
    bat1, bat1_rec = battery_run(cap)
    check("(R3) capped job-free runs attempted ZERO persists",
          sol1_rec == [] and bat1_rec == [],
          f"{len(sol1_rec)} + {len(bat1_rec)} payload(s)")

    # SOLAR: within_budget is IN the response, so the flag and the figure it
    # describes can be compared directly.
    opt_s1 = sol1.get("optimal") or {}
    s_cost, s_wb = opt_s1.get("system_cost"), opt_s1.get("within_budget")
    print(f"        solar capped   : system_cost=${s_cost} within_budget={s_wb}")
    check("(B1/fixture) solar: never system_cost > cap AND within_budget true",
          not (isinstance(s_cost, (int, float)) and s_cost > cap and s_wb is True),
          f"system_cost={s_cost} cap={cap} within_budget={s_wb}")
    check("(B1/fixture) solar: within_budget agrees with recomputing "
          "(system_cost <= cap) from the response's own numbers",
          isinstance(s_cost, (int, float)) and s_wb == (s_cost <= cap),
          f"stored {s_wb} vs recomputed {isinstance(s_cost, (int, float)) and s_cost <= cap}")

    # BATTERY: the response carries no within_budget (the writer computes it,
    # and the writer only runs with a job_id — see the LIVE section, which
    # pins that derivation under a cap that bites). What IS observable here is
    # the number the writer would be given, and it is the one under test.
    opt_b1 = bat1.get("optimal_battery") or {}
    cs1 = bat1.get("chosen_solar") or {}
    C1 = round((cs1.get("system_cost_solar_only") or 0)
               + (opt_b1.get("battery_cost") or 0), 2)
    reason1 = bat1.get("not_economic_reason")
    print(f"        battery capped : whole-system ${C1} "
          f"(solar-only ${cs1.get('system_cost_solar_only')}, battery "
          f"{opt_b1.get('usable_kwh')} kWh), reason={reason1!r}")
    # WHY THESE MOVE WHEN THE FAULT IS PRESENT: with the pool filtered on the
    # INCREMENTAL battery cost, a battery whose increment sits under the cap is
    # still chosen, so C1 stays at C (above the cap) and the reason stays null.
    check("(B1/fixture) battery: the whole-system cost obeys the cap",
          C1 <= cap, f"whole-system={C1} cap={cap}")
    check("(B1/fixture) battery: the capped answer costs STRICTLY LESS than "
          "the uncapped one — the cap actually moved the recommendation",
          C1 < C, f"capped={C1} uncapped={C}")
    check("(B1/fixture) battery: the capped answer names the BUDGET, not "
          "economics — the two causes are distinguishable strings (change 4c)",
          isinstance(reason1, str) and bool(reason1.strip())
          and "budget" in reason1.lower(), repr(reason1))
    check("(B1/fixture) ...and that budget reason is NOT the economics "
          "sentence the same engine emits when no battery pays",
          isinstance(reason1, str)
          and reason1 != "no battery beats solar-only on NPV — battery not "
                         "economic for this job.",
          repr(reason1))

    # 3.13: the response now carries within_budget from the engine's own
    # candidate — the chosen answer obeys the cap, so it must be True, and it
    # must agree with recomputing from the response's own numbers.
    check("(B1/fixture) capped battery response carries within_budget True — "
          "the chosen answer obeys the cap and says so",
          bat1.get("within_budget") is True, repr(bat1.get("within_budget")))
    check("(B1/fixture) uncapped battery response carries within_budget True "
          "(no cap means no cap)",
          bat0.get("within_budget") is True, repr(bat0.get("within_budget")))
    # B2 + within_budget arithmetic on the CAPPED candidate list — the one
    # list where the truth values are provably MIXED (fixture health above
    # pinned cap < every battery system_cost, and the downsized solar sits
    # under the cap), so the equality cannot pass vacuously all-True.
    _b2_candidates("fixture-capped", bat1.get("candidates") or [],
                   cs1.get("system_cost_solar_only"), budget=cap)
    wbs = {bool(c.get("within_budget"))
           for c in (bat1.get("candidates") or [])
           if isinstance(c.get("within_budget"), bool)}
    check("(B1/fixture) the capped candidate list carries BOTH truth values "
          "of within_budget — the flag is not vacuous",
          wbs == {True, False}, str(wbs))


def _b2_candidates(label: str, cands: list[dict], solar_only,
                   budget=None) -> None:
    """B2's arithmetic, run against whichever candidate list is supplied.
    WHY IT MOVES: without change 1(a) no candidate carries system_cost at all,
    so every equality below fails on a missing key. 3.13 grew it: every
    candidate must also carry within_budget derived from that SAME system_cost
    — pre-3.13 no candidate carries the key at all, so the checks fail on a
    missing key."""
    baselines = [c for c in cands if "battery_id" not in c]
    with_id = [c for c in cands if "battery_id" in c]
    check(f"(B2/{label}) the baseline is the ONLY entry without a battery_id — "
          "the no-choice count verify_sizing_result_storage.py permits is "
          "unchanged",
          len(baselines) == 1 and len(baselines) + len(with_id) == len(cands),
          f"{len(cands)} candidates, {len(baselines)} baselines")
    check(f"(B2/{label}) baseline system_cost == round(solar_only, 2)",
          bool(baselines) and isinstance(solar_only, (int, float))
          and baselines[0].get("system_cost") == round(solar_only, 2),
          f"{baselines[0].get('system_cost') if baselines else None} vs "
          f"{round(solar_only, 2) if isinstance(solar_only, (int, float)) else None}")
    bad = [c for c in with_id
           if c.get("system_cost") != round((solar_only or 0)
                                            + c.get("battery_cost", 0), 2)]
    check(f"(B2/{label}) EVERY battery candidate: system_cost == "
          "round(solar_only + battery_cost, 2)",
          len(with_id) > 0 and not bad,
          f"{len(bad)} of {len(with_id)} wrong; first: {bad[0] if bad else None}")
    # 3.13: within_budget on EVERY candidate (baseline included), equal to
    # (budget is None) or (system_cost <= budget) — derived from the same
    # system_cost key the equalities above just tested.
    missing_wb = [c for c in cands if not isinstance(c.get("within_budget"), bool)]
    check(f"(B2/{label}) every candidate carries a boolean within_budget",
          bool(cands) and not missing_wb,
          f"{len(missing_wb)} of {len(cands)} missing/non-bool")
    wrong_wb = [c for c in cands
                if isinstance(c.get("within_budget"), bool)
                and c["within_budget"] != ((budget is None)
                                           or (c.get("system_cost", 0) <= budget))]
    check(f"(B2/{label}) every within_budget == (budget is None) or "
          f"(system_cost <= budget), recomputed under budget={budget}",
          bool(cands) and not wrong_wb,
          f"{len(wrong_wb)} wrong; first: {wrong_wb[0] if wrong_wb else None}")


def t_live_endpoints(client) -> None:
    """THE LIVE JOB, end to end. It exercises both endpoints against real
    stored job state — roof, load, tariff, ownership — which no fixture covers.
    It does NOT speak for the two-endpoint budget contract: on this job's
    near-vertical roof no battery is ever economic, so a cap cannot separate
    the endpoints here. B1 owns that claim (2R.3)."""
    print("\nBL. the LIVE job end-to-end — stored state, NOT the budget "
          "contract (B1 owns that)")
    caller = _gate_caller(client)

    resp0, pay0 = _run_battery(caller, None)
    C = pay0.get("system_cost")
    S = (resp0.get("chosen_solar") or {}).get("system_cost_solar_only")
    print(f"        uncapped battery run: persisted system_cost ${C}, "
          f"solar-only ${S}")
    check("(BL) the uncapped live run persisted a system_cost and returned a "
          "solar-only cost",
          isinstance(C, (int, float)) and isinstance(S, (int, float)),
          f"C={C!r} S={S!r}")

    _b2_candidates("live", resp0.get("candidates") or [], S)

    # The response-to-payload identity: the row's system_cost IS the two
    # numbers the response returns, so a reader of either sees one figure.
    opt = resp0.get("optimal_battery") or {}
    check("(BL) the persisted system_cost == round(chosen_solar + "
          "optimal battery_cost, 2) from the SAME response",
          isinstance(C, (int, float)) and isinstance(S, (int, float))
          and C == round(S + (opt.get("battery_cost") or 0), 2),
          f"persisted={C} response-derived="
          f"{round((S or 0) + (opt.get('battery_cost') or 0), 2)}")
    check("(BL) uncapped: within_budget is true (no cap means no cap)",
          pay0.get("within_budget") is True, repr(pay0.get("within_budget")))
    check("(BL) 3.13: the response's within_budget IS the persisted one — "
          "one number, one place, both readers see the same flag",
          resp0.get("within_budget") == pay0.get("within_budget"),
          f"response={resp0.get('within_budget')!r} "
          f"persisted={pay0.get('within_budget')!r}")

    # THE WRITER'S within_budget UNDER A CAP THAT BITES. The fixture cannot
    # reach this — a job-free run never enters the persist block — so it is
    # pinned here, where the recorder can see the payload. The cap is DERIVED
    # from the cost just observed (F156), never typed, and it is deliberately
    # below even the solar, which is the one no-battery cause this job CAN
    # exercise.
    if isinstance(C, (int, float)) and C > 0:
        biting = round(C / 2.0, 2)
        resp1, pay1 = _run_battery(caller, biting)
        sc, wb = pay1.get("system_cost"), pay1.get("within_budget")
        print(f"        cap ${biting} (half the observed cost): persisted "
              f"system_cost=${sc} within_budget={wb}")
        print(f"        reason: {resp1.get('not_economic_reason')!r}")
        check("(BL) under a cap that bites, within_budget is DERIVED from the "
              "persisted system_cost — recomputed from the payload itself",
              isinstance(sc, (int, float)) and wb == (sc <= biting),
              f"stored {wb} vs recomputed "
              f"{isinstance(sc, (int, float)) and sc <= biting}")
        check("(BL) ...and it is FALSE here, so the check is not passing "
              "vacuously on an always-true flag",
              wb is False, repr(wb))
        check("(BL) 3.13: under the biting cap the RESPONSE's within_budget "
              "is the same False the writer stored",
              resp1.get("within_budget") is False
              and resp1.get("within_budget") == wb,
              f"response={resp1.get('within_budget')!r} persisted={wb!r}")
        check("(BL) ...and the run still RETURNED a result with an honest "
              "budget reason — an impossible cap never becomes an error (D24)",
              "error" not in resp1
              and isinstance(resp1.get("not_economic_reason"), str)
              and "budget" in resp1["not_economic_reason"].lower(),
              f"error={resp1.get('error')!r} "
              f"reason={resp1.get('not_economic_reason')!r}")
        check("(BL) ...and the solar downsizing that the cap forced is VISIBLE "
              "in the response flags (2N.1 — a capped array is never silent)",
              any("budget_too_low" in f for f in (resp1.get("flags") or [])),
              str(resp1.get("flags")))


# ── AGREE/tou: the 3.12 pricing fault, on the live time-of-use job ───────────
# One job, one stored tariff, one minute — and pre-fix, two different systems:
# the solar endpoint priced self-consumption at the DEFAULT scalar ($0.40,
# because a stored TOU tariff has import_rate NULL) while the battery
# endpoint's internal solar run priced it at sum(rate_24)/24. F152's family:
# one input meaning two things across two endpoints, nothing comparing them.
# This check IS the comparison. It needs no synthetic fixture and no economic
# battery — it depends only on both endpoints receiving the same price vector.
TOU_JOB = "a57e13f1-24f2-48e3-b816-8a08cb6b2fed"


def t_agree_live(client) -> None:
    print("\nAGREE. one live TOU job, both endpoints, the SAME chosen solar")
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", TOU_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                        company_id=company_id, role="owner")

    sol, _ = _run_endpoint(sizing_route.optimise_sizing,
                           sizing_route.OptimiseRequest(job_id=TOU_JOB), caller)
    bat, _ = _run_endpoint(sizing_route.battery_sizing,
                           sizing_route.BatteryRequest(job_id=TOU_JOB), caller)
    opt = sol.get("optimal") or {}
    cs = bat.get("chosen_solar") or {}
    print(f"        solar endpoint : {opt.get('solar_kw')} kW  "
          f"${opt.get('system_cost')}")
    print(f"        battery's solar: {cs.get('solar_kw')} kW  "
          f"${cs.get('system_cost_solar_only')}")
    check("(AGREE/tou) the job's stored tariff is genuinely TOU — the case "
          "can bite (a flat tariff here would make this the control twice)",
          (sol.get("assumptions") or {}).get("tariff_type") == "tou",
          repr((sol.get("assumptions") or {}).get("tariff_type")))
    # WHY IT MOVES: pre-3.12 the two endpoints price solar with two different
    # scalars, so on this TOU job they choose different systems (observed live
    # 2026-08-20: 11.44 kW vs 9.24 kW).
    check("(AGREE/tou) both endpoints choose the SAME solar_kw on the same "
          "job with the same stored inputs",
          opt.get("solar_kw") is not None
          and opt.get("solar_kw") == cs.get("solar_kw"),
          f"solar endpoint {opt.get('solar_kw')} kW vs battery endpoint "
          f"{cs.get('solar_kw')} kW")
    check("(AGREE/tou) ...and the SAME solar-only system_cost",
          opt.get("system_cost") is not None
          and opt.get("system_cost") == cs.get("system_cost_solar_only"),
          f"${opt.get('system_cost')} vs ${cs.get('system_cost_solar_only')}")


# ── B3: F142 — five window shapes through _build_rate_24 directly ────────────
def _build(windows, flat=0.40):
    flags: list[str] = []
    try:
        rate, is_tou = sizing_route._build_rate_24(None, windows, None, flat, flags)
        return rate, is_tou, flags, None
    except Exception as ex:  # noqa: BLE001
        return None, None, flags, f"{type(ex).__name__}: {ex}"


def t_b3() -> None:
    print("\nB3. F142 — an `hours` value that is not a list (outputs DERIVED, "
          "not predicted)")
    unreadable = "A TOU window had an unreadable hours list and was ignored: "

    # WHY IT MOVES: today a bare string is truthy AND iterable, so '06:00'
    # iterates character by character and hours 0 and 6 take the rate.
    for label, hours_val in (("'06:00' (bare string)", "06:00"),
                             ("{'a': 1} (a dict)", {"a": 1}),
                             ("6 (a bare int)", 6)):
        rate, is_tou, flags, err = _build([{"rate": 0.60, "hours": hours_val}])
        check(f"(B3) hours {label}: does not raise", err is None, str(err))
        check(f"(B3) hours {label}: whole window ignored — flat fill, "
              "is_tou False, mean 0.4000",
              rate == [0.40] * 24 and is_tou is False
              and round(sum(rate) / 24, 4) == 0.4000 if rate else False,
              f"rate[0]={rate[0] if rate else None} rate[6]={rate[6] if rate else None} "
              f"is_tou={is_tou}")
        check(f"(B3) hours {label}: flagged as an unreadable HOURS LIST "
              "(never as unreadable times)",
              any(f.startswith(unreadable) for f in flags)
              and not any("unreadable times" in f for f in flags), str(flags))

    # A real hours list is UNCHANGED by the fix.
    rate, is_tou, flags, err = _build([{"rate": 0.60, "hours": [6, 7, 8]}])
    check("(B3) hours [6,7,8]: rate[0]=0.40, rate[6]=0.60, is_tou True, "
          "mean 0.4250 (UNCHANGED)",
          err is None and rate[0] == 0.40 and rate[6] == 0.60 and rate[8] == 0.60
          and is_tou is True and round(sum(rate) / 24, 4) == 0.4250,
          f"{err} {rate}")

    # A PARTIAL list is still partial, not unreadable.
    rate, is_tou, flags, err = _build([{"rate": 0.60, "hours": [6, "07:00", "zz"]}])
    check("(B3) hours [6,'07:00','zz']: 6 and 7 applied, mean 0.4167, "
          "partial-hours flag (UNCHANGED)",
          err is None and rate[6] == 0.60 and rate[7] == 0.60 and rate[0] == 0.40
          and is_tou is True and round(sum(rate) / 24, 4) == 0.4167
          and "Some hours in a TOU window were unreadable and were skipped." in flags
          and not any(f.startswith(unreadable) for f in flags),
          f"{err} {rate} {flags}")

    # THE F136 REGRESSION GUARD: the parser's synthesised flat window.
    rate, is_tou, flags, err = _build(
        [{"label": "flat", "rate": 0.40, "start": "00:00", "end": "24:00",
          "days": "all"}])
    check("(B3) F136 guard: flat 00:00-24:00 window -> all 24 at 0.40, "
          "is_tou True, NO extra flag",
          err is None and rate == [0.40] * 24 and is_tou is True and flags == [],
          f"{err} {rate} {flags}")


# ── B4: F161 made mechanical — battery_optimiser.py strings ONLY ─────────────
def _optimise_kwargs(**over):
    zeros = [0.0] * 8760
    kw = dict(solar_8760=zeros, load_8760=zeros, rate_24=[0.4] * 24, fit=0.05,
              export_limit_kw=5.0, battery_rows=[], fin=FIN, solar_kw=6.6,
              panel_id=None, panel_count=None, solar_only_net_cost=10000.0,
              postcode=None, state=None, installer_id=None, objective="max_npv",
              flags=[])
    kw.update(over)
    return kw


def t_b4() -> None:
    print("\nB4. F161 — no snake_case identifier in any installer-facing string "
          "ORIGINATING IN battery_optimiser.py (route markers deliberately "
          "excluded — they are load-bearing machine prefixes, 2R.3)")
    collected: list[str] = []

    # battery_specs over a row missing EVERY defaultable spec, then rows
    # missing the two non-defaultable ones (usable capacity, price).
    fl: list[str] = []
    battery_optimiser.battery_specs(
        {"brand": "Acme", "model": "AX1", "usable_capacity_kwh": 10.0,
         "cost_aud": 7000}, fl)
    collected += fl
    fl2: list[str] = []
    battery_optimiser.battery_specs({"brand": "Acme", "model": "AX2",
                                     "cost_aud": 7000}, fl2)
    collected += fl2
    fl3: list[str] = []
    battery_optimiser.battery_specs({"brand": "Acme", "model": "AX3",
                                     "usable_capacity_kwh": 10.0}, fl3)
    collected += fl3

    # optimise_battery down its constraint branches. The LP is stubbed to None
    # (restored in the finally) so no solver, cost model or network runs — the
    # branches still emit their strings.
    r_force = battery_optimiser.optimise_battery(
        **_optimise_kwargs(force_no_battery=True))
    collected += r_force["flags"] + [r_force["not_economic_reason"] or ""]

    original_solve = battery_optimiser.solve_candidate
    battery_optimiser.solve_candidate = lambda *a, **k: None
    try:
        r_fix = battery_optimiser.optimise_battery(**_optimise_kwargs(
            fix_battery_kwh=10.0,
            battery_rows=[{"id": "b1", "brand": "Acme", "model": "AX1",
                           "usable_capacity_kwh": 13.0, "cost_aud": 9000}]))
    finally:
        battery_optimiser.solve_candidate = original_solve
    collected += r_fix["flags"] + [r_fix["not_economic_reason"] or ""]

    r_fix2 = battery_optimiser.optimise_battery(**_optimise_kwargs(
        fix_battery_kwh=10.0,
        battery_rows=[{"id": "b2", "brand": "Acme", "model": "AX4"}]))
    collected += r_fix2["flags"] + [r_fix2["not_economic_reason"] or ""]

    seen: set = set()
    strings = [s for s in collected if s and not (s in seen or seen.add(s))]
    print(f"        {len(strings)} distinct strings collected")
    for s in strings:
        # WHY IT MOVES: against pre-3.12 code exactly NINE of these carry a
        # raw database identifier (usable_capacity_kwh, cost_aud,
        # depth_of_discharge, warranty_cycles, force_no_battery ×2,
        # fix_battery_kwh ×2, battery_not_economic).
        m = SNAKE.search(s)
        check(f"(B4/battery_optimiser only) no snake_case token in: {s[:80]!r}",
              m is None, f"matched {m.group(0)!r}" if m else "")


# ── B5: every no-battery outcome carries an honest reason ────────────────────
def t_b5() -> None:
    print("\nB5. every no-battery outcome has a reason; budget and economics "
          "reasons DIFFER; a chosen battery has none")
    econ: dict = {}
    for obj in ("max_npv", "min_payback", "max_self_sufficiency", "custom"):
        r = battery_optimiser.optimise_battery(**_optimise_kwargs(objective=obj))
        reason = r.get("not_economic_reason")
        # WHY IT MOVES: pre-3.12, max_self_sufficiency and custom leave the
        # reason null when the baseline wins the max().
        check(f"(B5) {obj}: empty-catalogue no-battery answer carries a "
              "non-empty reason",
              isinstance(reason, str) and bool(reason.strip()), repr(reason))
        econ[obj] = reason

    # force_no_battery keeps its own early constraint reason.
    r_force = battery_optimiser.optimise_battery(
        **_optimise_kwargs(force_no_battery=True))
    check("(B5) force_no_battery: its own constraint reason, non-empty",
          isinstance(r_force.get("not_economic_reason"), str)
          and bool(r_force["not_economic_reason"].strip())
          and r_force["not_economic_reason"] != econ["max_npv"],
          repr(r_force.get("not_economic_reason")))

    # Budget-driven cases, with the LP and cost model stubbed (restored in the
    # finally) so a battery candidate exists without a solver or DB read.
    full_row = {"id": "bx", "brand": "Acme", "model": "AX9",
                "usable_capacity_kwh": 10.0, "cost_aud": 8000,
                "depth_of_discharge_pct": 100, "round_trip_efficiency_pct": 96,
                "max_continuous_charge_kw": 5, "max_continuous_discharge_kw": 5,
                "warranty_cycles": 6000, "warranty_years": 10}
    fake_solve = {"cost": -2000.0, "import": 0.0, "export": 0.0,
                  "discharge": 3650.0, "charge": 4000.0, "load": 0.0,
                  "peak_import": 0.0}
    original_solve = battery_optimiser.solve_candidate
    original_cost = cost_model.compute_system_cost
    battery_optimiser.solve_candidate = lambda *a, **k: dict(fake_solve)
    cost_model.compute_system_cost = lambda **k: {"net_cost": 18000.0}
    try:
        # cap between solar-only (10000) and the battery system (18000):
        # every battery is cut by the cap, solar-only survives.
        r_cut = battery_optimiser.optimise_battery(**_optimise_kwargs(
            battery_rows=[dict(full_row)], budget=10500.0))
        # cap below even solar-only (10000): the pool empties entirely.
        r_over = battery_optimiser.optimise_battery(**_optimise_kwargs(
            battery_rows=[dict(full_row)], budget=1000.0))
        # no cap: the stubbed battery is strongly NPV-positive and is chosen.
        r_win = battery_optimiser.optimise_battery(**_optimise_kwargs(
            battery_rows=[dict(full_row)]))
    finally:
        battery_optimiser.solve_candidate = original_solve
        cost_model.compute_system_cost = original_cost

    cut_reason = r_cut.get("not_economic_reason")
    over_reason = r_over.get("not_economic_reason")
    print(f"        budget-cut reason : {cut_reason!r}")
    print(f"        solar-over reason : {over_reason!r}")
    print(f"        economics reason  : {econ['max_npv']!r}")
    # WHY THESE MOVE: pre-3.12 the filter tests the incremental battery cost
    # (8000 <= 10500), so r_cut CHOOSES the battery and the reason is null;
    # and r_over falls back to the baseline with the max_npv ECONOMICS reason,
    # indistinguishable from a genuine not-economic outcome.
    check("(B5) batteries cut by the cap: chosen is no-battery with a "
          "non-empty BUDGET reason",
          (r_cut.get("optimal_battery") or {}).get("usable_kwh") == 0.0
          and isinstance(cut_reason, str) and bool(cut_reason.strip()),
          f"optimal={r_cut.get('optimal_battery')!r:.120} reason={cut_reason!r}")
    check("(B5) ...and it DIFFERS from the economics reason",
          cut_reason != econ["max_npv"], repr(cut_reason))
    check("(B5) even solar alone over the cap: non-empty reason, still a "
          "result (never an error)",
          isinstance(over_reason, str) and bool(over_reason.strip())
          and isinstance(r_over.get("optimal_battery"), dict),
          repr(over_reason))
    check("(B5) ...and the two budget cases are THEMSELVES different strings",
          over_reason != cut_reason and over_reason != econ["max_npv"],
          f"{over_reason!r} vs {cut_reason!r}")
    check("(B5) a CHOSEN battery has a null reason — a reason that is always "
          "present is not a signal",
          (r_win.get("optimal_battery") or {}).get("usable_kwh") == 10.0
          and r_win.get("not_economic_reason") is None,
          f"optimal usable={(r_win.get('optimal_battery') or {}).get('usable_kwh')} "
          f"reason={r_win.get('not_economic_reason')!r}")


def main() -> int:
    print("verify_battery_contract.py — 3.12 prompt 1 (writes nothing)\n")
    start = _counts()
    if start is not None:
        print(f"        start counts: {start}")

    client = sizing_route._sb()
    if client is None:
        check("(setup) live Supabase client available", False, "env not configured")
    t_b1_fixture()
    if client is not None:
        t_live_endpoints(client)
        t_agree_live(client)
    t_b3()
    t_b4()
    t_b5()

    if start is not None:
        end = _counts()
        print(f"\nB6. the database delta (F77)")
        print(f"        end counts:   {end}")
        for k in start:
            check(f"(B6) {k} count unchanged", end is not None and end.get(k) == start[k],
                  f"{start[k]} -> {end.get(k) if end else None}")

    # R4 — coverage, stated in one line, because a reader of the summary
    # cannot otherwise tell which claims rest on a fixture and which on live
    # data. A skip is reported on the FINAL line too: a skip visible only
    # mid-scroll is a skip nobody sees.
    print(f"\n{'-' * 60}")
    print("COVERAGE: B1 (the budget contract, F152) ran against a SYNTHETIC "
          "JOB-FREE FIXTURE built from cached PVGIS profiles, which provably "
          "chooses a battery and has NO skip path. B2's arithmetic ran against "
          "BOTH that fixture and the LIVE job. BL (endpoints against stored "
          "job state, and the writer's within_budget under a biting cap) ran "
          "against LIVE data. B3/B4/B5 are offline unit checks on the engine "
          "and the tariff reader. B6 read the thirteen counts LIVE.")
    print(f"{'-' * 60}")
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
