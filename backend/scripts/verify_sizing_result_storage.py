#!/usr/bin/env python3
"""
verify_sizing_result_storage.py — the 3.11b prompt-2 gate: sizing_results and
financial_results are an APPEND-ONLY RUN LOG.

  (a) the two UNIQUE (job_id) constraints are GONE            (pg_constraint)
  (b) the replacement (job_id, created_at DESC) indexes exist (pg_indexes)
  (c) capture._CONFLICT maps both tables to their pk; _PK unchanged
  (d) RUN_KINDS / ENGINE_MODES exist, and every label actually STORED is a
      member — the drift check that replaces a CHECK constraint (D33)
  (e) save_sizing_result REFUSES an unknown label before _write is reached
  (f) both endpoint payloads carry run_kind / engine_mode / evaluated_options,
      valid and self-describing — PROVEN BY RUNNING THE WRITERS (F148)

READS the live database; WRITES NOTHING — capture.save_sizing_result is
replaced by a recorder for every endpoint run, capture._write by a recorder for
the refusal check, and generation._cache_put is no-opped (the live job's roof
planes are 76-77 degree PVGIS cache misses).

(a)/(b) need the system catalogs, which PostgREST does NOT expose to REST
clients — the same boundary verify_equipment_contract.py's check 7c hit. They
run live over a direct Postgres connection (SUPABASE_DB_URL + psycopg2) when
one exists and SKIP LOUDLY otherwise (printed, uncounted, never a pass); the
catalog state was verified live in the 3.11b prompt-2 transcript. With a
connection, any error other than absence FAILS so the bridge cannot rot.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_sizing_result_storage.py
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


def t_ab_catalogs() -> int:
    """(a)+(b) over a direct Postgres connection, or one loud skip."""
    print("Ta/Tb. the constraints are gone, the indexes exist (system catalogs)")
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        psycopg2 = None
    if not db_url or psycopg2 is None:
        print("  SKIP  (a)(b) pg_constraint / pg_indexes need a direct Postgres "
              "connection (SUPABASE_DB_URL + psycopg2); the REST client cannot "
              "see the system catalogs. NOT counted as a pass. The catalog state "
              "was verified live in the 3.11b prompt-2 transcript: both "
              "*_job_id_key constraints absent, both *_job_id_created_at_idx "
              "indexes present.")
        return 1
    try:
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute(
            "select conname from pg_constraint where conrelid in "
            "('public.sizing_results'::regclass, 'public.financial_results'::regclass)")
        cons = {row[0] for row in cur.fetchall()}
        check("(a) sizing_results_job_id_key does NOT exist",
              "sizing_results_job_id_key" not in cons, str(sorted(cons)))
        check("(a) financial_results_job_id_key does NOT exist",
              "financial_results_job_id_key" not in cons, str(sorted(cons)))
        cur.execute(
            "select tablename, indexname, indexdef from pg_indexes "
            "where tablename in ('sizing_results', 'financial_results')")
        idx = cur.fetchall()
        names = {row[1] for row in idx}
        check("(b) sizing_results_job_id_created_at_idx exists",
              "sizing_results_job_id_created_at_idx" in names, str(sorted(names)))
        check("(b) financial_results_job_id_created_at_idx exists",
              "financial_results_job_id_created_at_idx" in names, str(sorted(names)))
        for table in ("sizing_results", "financial_results"):
            on_job_id = [r[1] for r in idx if r[0] == table and "(job_id" in r[2]]
            check(f"(b) at least one index on {table}.job_id",
                  len(on_job_id) >= 1, str(idx))
        conn.close()
    except Exception as exc:  # noqa: BLE001
        check("(a)(b) catalog comparison ran", False, f"errored (not skipped): {exc!r}")
    return 0


def t_c_conflict() -> None:
    print("\nTc. capture's conflict keys — the corrections pattern, pk = insert-always")
    check("(c) _CONFLICT['sizing_results'] == 'sizing_result_id'",
          capture._CONFLICT.get("sizing_results") == "sizing_result_id",
          str(capture._CONFLICT.get("sizing_results")))
    check("(c) _CONFLICT['financial_results'] == 'financial_result_id'",
          capture._CONFLICT.get("financial_results") == "financial_result_id",
          str(capture._CONFLICT.get("financial_results")))
    expected_pk = {
        "jobs": "job_id", "bills": "bill_id", "tariffs": "tariff_id",
        "surveys": "survey_id", "load_profiles": "load_profile_id",
        "solar_resources": "solar_resource_id",
        "sizing_results": "sizing_result_id",
        "financial_results": "financial_result_id",
        "corrections": "correction_id",
    }
    check("(c) _PK is unchanged — the caller still gets the new row's id back",
          capture._PK == expected_pk, str(capture._PK))


def t_d_vocabulary(client) -> None:
    print("\nTd. the vocabularies vs what is actually stored — the drift check "
          "that replaces the CHECK constraint (D33)")
    check("(d) RUN_KINDS exists and is a frozenset",
          isinstance(getattr(capture, "RUN_KINDS", None), frozenset),
          str(type(getattr(capture, "RUN_KINDS", None))))
    check("(d) ENGINE_MODES exists and is a frozenset",
          isinstance(getattr(capture, "ENGINE_MODES", None), frozenset),
          str(type(getattr(capture, "ENGINE_MODES", None))))
    rows = (client.table("sizing_results")
            .select("run_kind,engine_mode").execute().data) or []
    stored_kinds = {r["run_kind"] for r in rows if r.get("run_kind") is not None}
    stored_modes = {r["engine_mode"] for r in rows if r.get("engine_mode") is not None}
    print(f"        stored run_kind values   : {sorted(stored_kinds)}")
    print(f"        RUN_KINDS constant       : {sorted(capture.RUN_KINDS)}")
    print(f"        stored engine_mode values: {sorted(stored_modes)}")
    print(f"        ENGINE_MODES constant    : {sorted(capture.ENGINE_MODES)}")
    check("(d) every stored run_kind is in RUN_KINDS",
          stored_kinds <= capture.RUN_KINDS,
          f"unknown stored: {sorted(stored_kinds - capture.RUN_KINDS)}")
    check("(d) every stored engine_mode is in ENGINE_MODES",
          stored_modes <= capture.ENGINE_MODES,
          f"unknown stored: {sorted(stored_modes - capture.ENGINE_MODES)}")


def t_e_refusal() -> None:
    print("\nTe. save_sizing_result REFUSES an unknown label BEFORE _write")
    # WHY THIS ASSERTION MOVES WHEN THE FAULT IS PRESENT: if the refusal is
    # missing, save_sizing_result falls straight through to _write, so the
    # recorder fires and the reached-count is 1 instead of 0. The valid-label
    # control below proves the recorder genuinely intercepts _write, so a zero
    # count means refusal, never a broken patch. Nothing touches the database:
    # _write is replaced for every call in this test.
    reached: list = []
    original_write = capture._write
    capture._write = lambda table, payload: (reached.append(table) or "stub-id")
    try:
        out = capture.save_sizing_result(
            {"job_id": "j", "solar_kw": 1, "run_kind": "nonsense"})
        check("(e) unknown run_kind -> None", out is None, repr(out))
        check("(e) ...and _write was NEVER reached", len(reached) == 0,
              f"{len(reached)} call(s)")
        out2 = capture.save_sizing_result(
            {"job_id": "j", "solar_kw": 1, "run_kind": "solar",
             "engine_mode": "nonsense"})
        check("(e) unknown engine_mode -> None, _write still not reached",
              out2 is None and len(reached) == 0,
              f"returned {out2!r}, {len(reached)} call(s)")
        out3 = capture.save_sizing_result(
            {"job_id": "j", "solar_kw": 1,
             "run_kind": "solar", "engine_mode": "sequential"})
        check("(e) CONTROL: a valid label DOES reach _write (the patch bites)",
              out3 == "stub-id" and reached == ["sizing_results"],
              f"returned {out3!r}, reached={reached}")
        out4 = capture.save_sizing_result({"job_id": "j", "solar_kw": 1})
        check("(e) absent labels are legal (legacy shape) — _write reached",
              out4 == "stub-id" and len(reached) == 2,
              f"returned {out4!r}, {len(reached)} call(s)")
    finally:
        capture._write = original_write


def t_f_endpoint_payloads(client) -> None:
    print("\nTf. both endpoint payloads, BY RUNNING THE WRITERS (F148) — recorder "
          "in place, nothing written")
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", LIVE_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    check("(f) the live job's owning company was read", bool(company_id),
          str(company_id))
    gate_caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                              company_id=company_id, role="owner")

    recorded: list[dict] = []
    original_save = capture.save_sizing_result
    original_cache = generation._cache_put
    capture.save_sizing_result = lambda payload: (recorded.append(dict(payload)) or "fake-id")
    generation._cache_put = lambda *a, **k: None
    try:
        asyncio.run(sizing_route.optimise_sizing(
            sizing_route.OptimiseRequest(job_id=LIVE_JOB), gate_caller))
        asyncio.run(sizing_route.battery_sizing(
            sizing_route.BatteryRequest(job_id=LIVE_JOB), gate_caller))
    finally:
        capture.save_sizing_result = original_save
        generation._cache_put = original_cache

    check("(f) both endpoints attempted exactly one persist each",
          len(recorded) == 2, f"{len(recorded)} payloads recorded")
    if len(recorded) != 2:
        return
    for label, payload, want_kind, want_dims in (
        ("solar", recorded[0], "solar", ["solar_kw"]),
        ("battery", recorded[1], "solar_battery", ["battery_id"]),
    ):
        print(f"        {label} run_kind={payload.get('run_kind')!r} "
              f"engine_mode={payload.get('engine_mode')!r}")
        check(f"(f) {label}: run_kind == {want_kind!r} and is in RUN_KINDS",
              payload.get("run_kind") == want_kind
              and payload.get("run_kind") in capture.RUN_KINDS,
              repr(payload.get("run_kind")))
        check(f"(f) {label}: engine_mode is in ENGINE_MODES",
              payload.get("engine_mode") in capture.ENGINE_MODES,
              repr(payload.get("engine_mode")))
        opts = payload.get("evaluated_options")
        check(f"(f) {label}: evaluated_options is a dict", isinstance(opts, dict),
              str(type(opts)))
        if not isinstance(opts, dict):
            continue
        dims = opts.get("dimension_keys")
        points = opts.get("points")
        check(f"(f) {label}: dimension_keys == {want_dims} (non-empty list)",
              dims == want_dims and isinstance(dims, list) and len(dims) > 0,
              repr(dims))
        check(f"(f) {label}: points is a list", isinstance(points, list),
              str(type(points)))
        # The self-describing clause: without it the field is decorative, a
        # name list pointing at keys the points do not carry. The literal form
        # "present on the first point" is WRONG for the battery endpoint: its
        # candidates list deliberately opens with the no-battery baseline
        # (battery_optimiser.py, "No battery"), whose battery_id is honestly
        # ABSENT — absence IS the no-choice option, and the writer stores the
        # list verbatim. The honest form of the same intent: every point
        # carries every dimension key, except at most ONE no-choice baseline
        # point that carries none of them.
        pts = points if isinstance(points, list) else []
        selections = [p for p in pts if isinstance(p, dict)
                      and all(k in p for k in (dims or []))]
        baselines = [p for p in pts if isinstance(p, dict)
                     and not any(k in p for k in (dims or []))]
        check(f"(f) {label}: every point carries every dimension key, except at "
              "most one no-choice baseline (self-describing, not decorative)",
              len(selections) >= 1
              and len(selections) + len(baselines) == len(pts)
              and len(baselines) <= 1,
              f"{len(pts)} points, {len(selections)} selections, "
              f"{len(baselines)} baselines; first point keys: "
              f"{sorted(pts[0]) if pts and isinstance(pts[0], dict) else pts[:1]}")
        print(f"        {label} first point: "
              f"{json.dumps(pts[0] if pts else {}, default=str)[:200]}")
        print(f"        {label} first SELECTION point: "
              f"{json.dumps(selections[0] if selections else {}, default=str)[:200]}")


def main() -> int:
    print("verify_sizing_result_storage.py — 3.11b prompt 2 (writes nothing)\n")
    client = sizing_route._sb()
    if client is None:
        check("(setup) live Supabase client available", False, "env not configured")
    skipped = t_ab_catalogs()
    t_c_conflict()
    if client is not None:
        t_d_vocabulary(client)
    t_e_refusal()
    if client is not None:
        t_f_endpoint_payloads(client)
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({skipped} skipped, not counted)" if skipped else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
