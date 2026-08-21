#!/usr/bin/env python3
"""
verify_sizing_confidence.py — the 3.11 prompt-1 gate (F93): roof doubt travels
to the sizing result. The live roof read and its created_at-desc ordering, the
one-reader rule, the persisted payload PROVEN BY RUNNING THE WRITERS (F148),
the allowlist growth, the legacy path, and the no-number-moved evidence.

READS the live database (the same read-only pattern verify_sizing_time_base
uses); WRITES NOTHING — capture.save_sizing_result is replaced by a recorder
for every endpoint run, and generation._cache_put is no-opped as belt and
braces (this job's roof planes are 76-77 degrees, which are PVGIS cache
misses, so a real _cache_put would grow pvgis_cache).

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_sizing_confidence.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import capture  # noqa: E402
import generation  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


LIVE_JOB = "456e0242-17f9-4b2a-8faa-f664ddd9eed9"
NEW_ROOF = "d9a9d4df-5384-4ec6-bc72-6eead7eee5b2"   # 2026-08-14 04:32, flagged
OLD_ROOF = "8276cbf2-8692-4664-a65e-557e17ba2490"   # 2026-08-14 03:50, clean

ROOF_KEYS = ("roof_geometry_id", "roof_low_confidence",
             "roof_needs_manual_confirmation", "roof_flags", "roof_reason")


def t1_live_read(client) -> None:
    print("T1. the live roof read AND the created_at-desc ordering, in one assertion")
    roof = sizing_route._load_roof(client, LIVE_JOB)
    check("(1) a roof row was read", roof is not None, "None")
    if roof is None:
        return
    print(f"        id={roof.get('roof_geometry_id')} low={roof.get('low_confidence')} "
          f"needs={roof.get('needs_manual_confirmation')} "
          f"n_flags={len(roof.get('flags') or [])}")
    print(f"        reason: {str(roof.get('reason'))[:100]}")
    check("(1) the NEWER row won: roof_geometry_id is the 04:32 flagged row",
          roof.get("roof_geometry_id") == NEW_ROOF, str(roof.get("roof_geometry_id")))
    check("(1) low_confidence True", roof.get("low_confidence") is True,
          str(roof.get("low_confidence")))
    check("(1) needs_manual_confirmation True",
          roof.get("needs_manual_confirmation") is True,
          str(roof.get("needs_manual_confirmation")))
    check("(1) len(flags) == 6", len(roof.get("flags") or []) == 6,
          str(len(roof.get("flags") or [])))
    check('(1) reason contains "too steep to be a roof"',
          "too steep to be a roof" in str(roof.get("reason")),
          str(roof.get("reason"))[:120])

    # THE ORDERING CAN DEMONSTRABLY FAIL: the same query with desc flipped, in
    # a COPY here (never in _load_one), must return the OLDER clean row — three
    # of the five values above change with it.
    res = (
        client.table("roof_geometry")
        .select(sizing_route._ROOF_COLUMNS)
        .eq("job_id", LIVE_JOB)
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    older = res.data[0] if res.data else {}
    print(f"        desc=False returns: id={older.get('roof_geometry_id')} "
          f"low={older.get('low_confidence')} n_flags={len(older.get('flags') or [])}")
    check("(1) flipping the ordering returns the OLDER clean row — the ordering is load-bearing",
          older.get("roof_geometry_id") == OLD_ROOF
          and older.get("low_confidence") is False
          and len(older.get("flags") or []) == 2,
          str(older.get("roof_geometry_id")))


def t2_one_reader() -> None:
    print("\nT2. one reader, not two — A SOURCE-TEXT CHECK (parsed, not run; weaker "
          "than the node-bridge pattern and named so)")
    src = open(os.path.join(BACKEND_DIR, "routes", "sizing.py")).read()
    literal = "found,manual_entry_required,low_confidence,needs_manual_confirmation,flags,reason"
    check("(2) the roof column list literal appears exactly ONCE (inside _ROOF_COLUMNS)",
          src.count(literal) == 1, f"{src.count(literal)} occurrences")
    check('(2) the inline read `"roof_geometry", body.job_id` appears ZERO times',
          src.count('"roof_geometry", body.job_id') == 0,
          f"{src.count(chr(34) + 'roof_geometry' + chr(34) + ', body.job_id')} occurrences")
    check("(2) _load_roof: 1 definition + 2 call sites",
          src.count("def _load_roof(") == 1
          and src.count("_load_roof(client, body.job_id)") == 2,
          f"defs={src.count('def _load_roof(')} calls={src.count('_load_roof(client, body.job_id)')}")


def t3_run_the_writers(client) -> tuple[dict, dict]:
    print("\nT3. the persisted payload, BY RUNNING THE WRITERS (F148) — recorder in "
          "place, nothing written")
    # 3.11b: the endpoints require a Caller (no usable default). The gate
    # constructs one whose company_id is READ FROM THE LIVE DATABASE — never
    # hardcoded — so it is the company that genuinely owns the live job and
    # the ownership check passes on truth rather than on a copied constant.
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", LIVE_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    check("(3) the live job's owning company was read", bool(company_id),
          str(company_id))
    gate_caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                              company_id=company_id, role="owner")

    recorded: list[dict] = []
    responses: list[dict] = []
    original_save = capture.save_sizing_result
    original_cache = generation._cache_put
    capture.save_sizing_result = lambda payload: (recorded.append(dict(payload)) or "fake-id")
    generation._cache_put = lambda *a, **k: None
    try:
        solar_res = asyncio.run(
            sizing_route.optimise_sizing(
                sizing_route.OptimiseRequest(job_id=LIVE_JOB), gate_caller))
        responses.append(solar_res)
        battery_res = asyncio.run(
            sizing_route.battery_sizing(
                sizing_route.BatteryRequest(job_id=LIVE_JOB), gate_caller))
        responses.append(battery_res)
    finally:
        capture.save_sizing_result = original_save
        generation._cache_put = original_cache

    check("(3) both endpoints attempted exactly one persist each",
          len(recorded) == 2, f"{len(recorded)} payloads recorded")
    if len(recorded) != 2:
        return {}, {}
    solar_payload, battery_payload = recorded
    print("        solar payload  :", json.dumps(solar_payload, default=str))
    print("        battery payload:", json.dumps(battery_payload, default=str))

    check("(3a) the SOLAR payload's battery_kwh IS None — not 0, not absent",
          "battery_kwh" in solar_payload and solar_payload["battery_kwh"] is None,
          str(solar_payload.get("battery_kwh", "<absent>")))
    check("(3b) the BATTERY payload's battery_kwh is a number",
          isinstance(battery_payload.get("battery_kwh"), (int, float))
          and not isinstance(battery_payload.get("battery_kwh"), bool),
          str(battery_payload.get("battery_kwh")))
    allow = capture._ALLOWED["sizing_results"]
    check("(3c) solar payload keys ⊆ the sizing_results allowlist",
          set(solar_payload) <= allow, str(set(solar_payload) - allow))
    check("(3c) battery payload keys ⊆ the sizing_results allowlist",
          set(battery_payload) <= allow, str(set(battery_payload) - allow))
    check("(3d) solar payload carries all five roof keys",
          set(ROOF_KEYS) <= set(solar_payload), str(set(ROOF_KEYS) - set(solar_payload)))
    check("(3d) battery payload carries all five roof keys",
          set(ROOF_KEYS) <= set(battery_payload), str(set(ROOF_KEYS) - set(battery_payload)))

    # (3e) THE 2Q.1 INSTRUMENT: the five persisted roof keys vs the five
    # confidence-bearing names inside _ROOF_COLUMNS, as SETS, both directions.
    persisted_roof = {k for k in solar_payload if k.startswith("roof_")}
    source_cols = {c for c in sizing_route._ROOF_COLUMNS.split(",")
                   if c in ("low_confidence", "needs_manual_confirmation",
                            "flags", "reason", "roof_geometry_id")}
    mapped = {("roof_" + c) if not c.startswith("roof_") else c for c in source_cols}
    print(f"        persisted roof keys: {sorted(persisted_roof)}")
    print(f"        _ROOF_COLUMNS confidence names (mapped): {sorted(mapped)}")
    check("(3e) persisted roof keys == the confidence names read from the roof "
          "(both directions)",
          persisted_roof == mapped,
          f"persisted-only={persisted_roof - mapped} read-only={mapped - persisted_roof}")

    # (3f) same object by construction — response vs payload.
    rc = responses[0].get("roof_confidence") or {}
    same = all(solar_payload.get(k) == rc.get(k) for k in ROOF_KEYS)
    check("(3f) the solar response's roof_confidence EQUALS the persisted roof values",
          same, f"response={rc} payload={ {k: solar_payload.get(k) for k in ROOF_KEYS} }")
    check("(3f) roof_confidence_read is True on this run (a roof row was read)",
          rc.get("roof_confidence_read") is True, str(rc))
    check("(3) the flagged-roof flag is in the solar response's flags, exactly once",
          sum(1 for f in responses[0].get("flags", [])
              if f.startswith("roof_flagged_before_sizing")) == 1,
          str(responses[0].get("flags")))
    check("(3) ...and in the battery response's flags, exactly once",
          sum(1 for f in responses[1].get("flags", [])
              if f.startswith("roof_flagged_before_sizing")) == 1,
          str(responses[1].get("flags")))
    check("(3) roof_confidence sits in both responses",
          "roof_confidence" in responses[0] and "roof_confidence" in responses[1], "")
    return solar_payload, responses[0]


def t4_allowlist() -> None:
    print("\nT4. the allowlist vs the REAL column list — both directions, live")
    payload = {k: "x" for k in ROOF_KEYS}
    payload.update({"job_id": "j", "solar_kw": 1})
    out = capture._filtered("sizing_results", payload)
    check("(4) _filtered keeps all five new keys",
          set(ROOF_KEYS) <= set(out), str(set(ROOF_KEYS) - set(out)))
    # 3.11b replaced the absolute count ("the allowlist holds exactly N names")
    # — an enumeration of a set that is EXPECTED to grow, a shape that has gone
    # stale three times in this project — with a comparison that cannot: the
    # real column list, read LIVE, against _ALLOWED, in BOTH directions. This
    # catches the failure that actually happens: a column added to the database
    # and forgotten in the allowlist, which _filtered then drops in silence.
    #
    # Source of the live column list: the PostgREST OpenAPI root (GET /rest/v1/).
    # PostgREST does not expose information_schema to REST clients, but its
    # OpenAPI document is generated from that same schema on every reload and
    # lists every column of every table — so this is the live column list the
    # service-role key CAN read, not a transcription.
    import httpx  # noqa: PLC0415 — scoped to the one check that needs it
    base = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    api_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY")
               or os.getenv("SUPABASE_ANON_KEY") or "")
    if not base or not api_key:
        check("(4) live column list readable (SUPABASE_URL + key set)", False,
              "env not configured")
        return
    resp = httpx.get(f"{base}/rest/v1/",
                     headers={"apikey": api_key,
                              "Authorization": f"Bearer {api_key}"},
                     timeout=30)
    check("(4) the PostgREST OpenAPI root answered 200", resp.status_code == 200,
          str(resp.status_code))
    definitions = (resp.json() or {}).get("definitions") or {}
    for table in ("sizing_results", "financial_results"):
        columns = set((definitions.get(table) or {}).get("properties") or {})
        allowed = capture._ALLOWED[table]
        print(f"        {table} columns : {sorted(columns)}")
        print(f"        {table} _ALLOWED: {sorted(allowed)}")
        check(f"(4) {table}: (columns - _ALLOWED) == {{'created_at'}} — the only "
              "intended exception, database-set and deliberately not writable",
              (columns - allowed) == {"created_at"},
              f"unexpected diff: {sorted(columns - allowed)}")
        check(f"(4) {table}: (_ALLOWED - columns) == set() — no phantom names",
              not (allowed - columns), f"phantom: {sorted(allowed - columns)}")


def t5_legacy() -> None:
    print("\nT5. the legacy routes/job.py capture shape is unharmed")
    old_payload = {
        "job_id": "j", "solar_kw": 6.6, "battery_kwh": 13.5,
        "self_consumption_ratio": 0.64, "system_cost": 12000,
        "annual_solar_generation_kwh": 9000, "within_budget": True,
        "engine_version": "x", "objective_used": "max_npv",
        "sizing_result_id": "sr-1",
    }
    out = capture._filtered("sizing_results", old_payload)
    check("(5) the exact 10-key legacy shape passes through complete, nothing added",
          set(out) == set(old_payload), f"diff={set(out) ^ set(old_payload)}")


def t6_numbers(solar_response: dict) -> None:
    print("\nT6. no number moved — the five optimal figures, printed for the "
          "before/after comparison performed at build time (3.11 prompt 1)")
    opt = solar_response.get("optimal") or {}
    for key in ("solar_kw", "system_cost", "npv_25yr",
                "annual_generation_kwh", "self_sufficiency_pct"):
        value = opt.get(key)
        print(f"        {key} = {value}")
        check(f"(6) optimal.{key} present and finite",
              isinstance(value, (int, float)) and value == value, str(value))


def t7_no_battery_index() -> None:
    """3.14 prompt 2 (F195), OFFLINE: battery_optimiser.optimise_battery
    returns chosen_index from BOTH of its returns, derived by object IDENTITY
    against the list it returns. Three cases, none touching the database:
      (7a) the EARLY return (force_no_battery) — the optimum IS the no-battery
           baseline and still gets a real index, never None;
      (7b) the MAIN return with nothing to evaluate — economics pick the
           baseline, which again gets a real index;
      (7c) the tie that justifies identity: two catalogue rows with IDENTICAL
           specs and price produce two candidates equal on usable_kwh AND
           system_cost. A value matcher cannot say which won; the index must
           name the very object optimal_battery is. cost_model is stubbed so
           this stays offline; the LP runs for real."""
    print("\nT7. the no-battery optimum still gets an index (F195) — offline, "
          "both returns, plus the tie")
    import battery_optimiser  # noqa: PLC0415

    def _ok_idx(res: dict) -> bool:
        ci = res.get("chosen_index")
        return (isinstance(ci, int) and not isinstance(ci, bool)
                and 0 <= ci < len(res.get("candidates") or []))

    hours = 8760
    # Flat 1 kW load, no solar, a TOU shape with an evening peak — enough for
    # a cheap battery to earn its keep in (7c); irrelevant to (7a)/(7b).
    load = [1.0] * hours
    solar = [0.0] * hours
    rate_24 = [0.15] * 17 + [0.60] * 4 + [0.15] * 3
    fin = {"performance_ratio_non_temp": 0.88, "discount_rate": 0.055,
           "analysis_years": 25, "degradation_annual_pct": 0.5,
           "tariff_escalation_pct": 0.0}
    common = dict(solar_8760=solar, load_8760=load, rate_24=rate_24, fit=0.05,
                  export_limit_kw=5.0, fin=fin, solar_kw=5.0, panel_id=None,
                  panel_count=None, solar_only_net_cost=8000.0, postcode=None,
                  state=None, installer_id=None, objective="max_npv")

    # (7a) the EARLY return.
    flags_a: list[str] = []
    res_a = battery_optimiser.optimise_battery(
        battery_rows=[], force_no_battery=True, flags=flags_a, **common)
    print(f"        (7a) force_no_battery: chosen_index={res_a.get('chosen_index')!r} "
          f"of {len(res_a.get('candidates') or [])} candidate(s); "
          f"reason={res_a.get('not_economic_reason')!r}")
    check("(7a) force_no_battery (the early return): chosen_index is an int "
          "in range — the baseline is a real position, not None",
          _ok_idx(res_a), repr(res_a.get("chosen_index")))
    check("(7a) ...and candidates[chosen_index] IS optimal_battery IS "
          "no_battery_baseline (identity)",
          _ok_idx(res_a)
          and res_a["candidates"][res_a["chosen_index"]] is res_a["optimal_battery"]
          and res_a["optimal_battery"] is res_a["no_battery_baseline"], "")
    check("(7a) no chosen_index_unresolved flag",
          not any(str(f).startswith("chosen_index_unresolved") for f in flags_a),
          str(flags_a))

    # (7b) the MAIN return, baseline by economics (nothing else to evaluate).
    flags_b: list[str] = []
    res_b = battery_optimiser.optimise_battery(
        battery_rows=[], force_no_battery=False, flags=flags_b, **common)
    print(f"        (7b) no rows: chosen_index={res_b.get('chosen_index')!r} "
          f"usable_kwh={(res_b.get('optimal_battery') or {}).get('usable_kwh')!r} "
          f"reason={res_b.get('not_economic_reason')!r}")
    check("(7b) the main return with the no-battery outcome: chosen_index is "
          "an int in range, naming the baseline",
          _ok_idx(res_b)
          and res_b["candidates"][res_b["chosen_index"]] is res_b["no_battery_baseline"]
          and res_b["optimal_battery"].get("usable_kwh") == 0.0
          and isinstance(res_b.get("not_economic_reason"), str),
          f"{res_b.get('chosen_index')!r} / {res_b.get('not_economic_reason')!r}")
    check("(7b) no chosen_index_unresolved flag",
          not any(str(f).startswith("chosen_index_unresolved") for f in flags_b),
          str(flags_b))

    # (7c) the tie. cost_model stubbed: a fixed incremental cost, offline.
    twin = {"usable_capacity_kwh": 10.0, "cost_aud": 1000.0,
            "depth_of_discharge_pct": 100.0, "round_trip_efficiency_pct": 90.0,
            "max_continuous_charge_kw": 5.0, "max_continuous_discharge_kw": 5.0,
            "warranty_cycles": 6000}
    rows = [{"id": "twin-a", "brand": "Twin", "model": "A", **twin},
            {"id": "twin-b", "brand": "Twin", "model": "B", **twin}]
    original_cost = battery_optimiser.cost_model.compute_system_cost
    battery_optimiser.cost_model.compute_system_cost = (
        lambda **kw: {"net_cost": 8000.0 + 1000.0, "line_items": [], "flags": []})
    flags_c: list[str] = []
    try:
        res_c = battery_optimiser.optimise_battery(
            battery_rows=rows, force_no_battery=False, flags=flags_c, **common)
    finally:
        battery_optimiser.cost_model.compute_system_cost = original_cost
    cands = res_c.get("candidates") or []
    opt_c = res_c.get("optimal_battery") or {}
    ci_c = res_c.get("chosen_index")
    twins = [c for c in cands if c.get("battery_id") in ("twin-a", "twin-b")]
    print(f"        (7c) candidates: "
          f"{[(c.get('battery_id'), c.get('usable_kwh'), c.get('system_cost'), c.get('incremental_npv')) for c in cands]}")
    print(f"        (7c) optimal={opt_c.get('battery_id')!r} chosen_index={ci_c!r}")
    check("(7c/premise) the two twins BOTH survived the LP and tie on "
          "usable_kwh AND system_cost — a value matcher cannot tell them apart",
          len(twins) == 2
          and twins[0].get("usable_kwh") == twins[1].get("usable_kwh")
          and twins[0].get("system_cost") == twins[1].get("system_cost"),
          f"{[(c.get('battery_id'), c.get('usable_kwh'), c.get('system_cost')) for c in twins]}")
    check("(7c/premise) a battery WON (the tie is exercised, not the baseline)",
          opt_c.get("battery_id") in ("twin-a", "twin-b"),
          repr(opt_c.get("battery_id")))
    value_matches = [i for i, c in enumerate(cands)
                     if c.get("usable_kwh") == opt_c.get("usable_kwh")
                     and c.get("system_cost") == opt_c.get("system_cost")]
    check("(7c/premise) matching on capacity-and-cost names MORE THAN ONE "
          "point — the ambiguity identity exists to remove",
          len(value_matches) >= 2, str(value_matches))
    check("(7c) chosen_index names THE object optimal_battery is (identity), "
          "and no other",
          _ok_idx(res_c) and cands[ci_c] is opt_c
          and sum(1 for c in cands if c is opt_c) == 1,
          f"chosen_index={ci_c!r} value_matches={value_matches}")
    check("(7c) no chosen_index_unresolved flag",
          not any(str(f).startswith("chosen_index_unresolved") for f in flags_c),
          str([f for f in flags_c if "chosen_index" in str(f)]))


def main() -> int:
    print("verify_sizing_confidence.py — 3.11 prompt 1 (reads live, WRITES NOTHING)\n")
    client = sizing_route._sb()
    if client is None:
        check("(live) Supabase client available", False, "env not configured")
    else:
        t1_live_read(client)
        t2_one_reader()
        _payload, solar_response = t3_run_the_writers(client)
        t4_allowlist()
        t5_legacy()
        if solar_response:
            t6_numbers(solar_response)
    t7_no_battery_index()
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print(f"OK: all {CHECKS_RUN} checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
