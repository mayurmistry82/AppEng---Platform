#!/usr/bin/env python3
"""
verify_sizing_result_storage.py — the 3.11b gate: sizing_results and
financial_results are an APPEND-ONLY RUN LOG (prompt 2), and GET /api/job/{id}
hydrates it ORDERED and BOUNDED (prompt 3).

  (a) the two UNIQUE (job_id) constraints are GONE            (pg_constraint)
  (b) the replacement (job_id, created_at DESC) indexes exist (pg_indexes)
  (c) capture._CONFLICT maps both tables to their pk; _PK unchanged
  (d) RUN_KINDS / ENGINE_MODES exist, and every label actually STORED is a
      member — the drift check that replaces a CHECK constraint (D33)
  (e) save_sizing_result REFUSES an unknown label before _write is reached
  (f) both endpoint payloads carry run_kind / engine_mode / evaluated_options,
      valid and self-describing — PROVEN BY RUNNING THE WRITERS (F148)
  (g)(1a-1e) hydration orders EVERY child table by created_at DESC and fetches
      LIMIT+1, returning LIMIT and logging the truncation — against a stub
      client that records the query chain (no database write)
  (3)(4) the LIVE read: hydrated counts == the real per-job counts, the run log
      leads with the F93 row, and the two-row roof_geometry case returns the
      NEWER (flagged) row first with the redaction applied to every row returned

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
import solar_retention  # noqa: E402
from routes import job as job_route  # noqa: E402
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



# ── 3.11b prompt 3 — hydration is ORDERED and BOUNDED ────────────────────────
LIVE_ROOF_JOB = LIVE_JOB   # the one live job with two roof_geometry rows


class _StubResult:
    def __init__(self, data):
        self.data = data


class _StubQuery:
    """Records the chain it was given and answers with canned rows."""

    def __init__(self, recorder, table, rows):
        self.recorder = recorder
        self.table_name = table
        self.rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, column, desc=None, **_k):
        self.recorder.setdefault(self.table_name, {}).setdefault(
            "order", []).append((column, desc))
        return self

    def limit(self, n, **_k):
        self.recorder.setdefault(self.table_name, {}).setdefault(
            "limit", []).append(n)
        return self

    def execute(self):
        return _StubResult(list(self.rows))


class _StubClient:
    """table('jobs') answers the ownership read; every child table answers rows."""

    def __init__(self, recorder, rows, job_id, company_id):
        self.recorder = recorder
        self.rows = rows
        self.job_id = job_id
        self.company_id = company_id

    def table(self, name):
        if name == "jobs":
            return _StubQuery(self.recorder, name,
                              [{"job_id": self.job_id, "company_id": self.company_id,
                                "path": None}])
        return _StubQuery(self.recorder, name, self.rows)


def _synthetic_rows(n: int) -> list[dict]:
    """n rows, NEWEST FIRST — row-00 is the newest, exactly as an ordered query
    would return them. The assertions name row-00 by id, so a slice taken from
    the wrong end, or an ordering that was never applied, returns a different id."""
    return [{"id": f"row-{i:02d}",
             "created_at": f"2026-08-{19 - i:02d}T00:00:00+00:00"} for i in range(n)]


def _run_get_job_with_stub(rows: list[dict]) -> tuple[dict, dict, list[str]]:
    """Run get_job against the stub. Returns (response, chain recorder, messages)."""
    recorder: dict = {}
    messages: list[str] = []
    caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                         company_id="co-gate", role="owner")
    stub = _StubClient(recorder, rows, LIVE_JOB, "co-gate")
    original_svc = job_route._require_svc
    original_capture = job_route.sentry_sdk.capture_message
    job_route._require_svc = lambda: stub
    job_route.sentry_sdk.capture_message = lambda msg, *a, **k: messages.append(str(msg))
    try:
        response = asyncio.run(job_route.get_job(LIVE_JOB, caller))
    finally:
        job_route._require_svc = original_svc
        job_route.sentry_sdk.capture_message = original_capture
    return response, recorder, messages


def t_g_order_and_limit() -> None:
    print("\nTg. hydration is ORDERED and BOUNDED — the stub records the chain")
    check("(g) _HYDRATION_LIMIT is 20", job_route._HYDRATION_LIMIT == 20,
          str(job_route._HYDRATION_LIMIT))

    # (a)(b)(c)(d) — 21 rows come back, so every table truncates.
    response, recorder, messages = _run_get_job_with_stub(_synthetic_rows(21))
    child_tables = [t for _k, t in job_route._CHILD_TABLES]
    print(f"        twelve child tables: {child_tables}")
    check("(g) twelve child tables were hydrated", len(child_tables) == 12,
          str(len(child_tables)))

    missing_order = [t for t in child_tables
                     if recorder.get(t, {}).get("order") != [("created_at", True)]]
    check("(1a) EVERY child table ordered by created_at DESC — all twelve, not one",
          not missing_order,
          f"wrong/absent order on: {missing_order} "
          f"(got {[(t, recorder.get(t, {}).get('order')) for t in missing_order][:3]})")
    bad_limit = [t for t in child_tables if recorder.get(t, {}).get("limit") != [21]]
    check("(1b) EVERY child table fetched LIMIT+1 = 21, never 20 — the extra row "
          "is how truncation is detected at all",
          not bad_limit,
          f"wrong limit on: {[(t, recorder.get(t, {}).get('limit')) for t in bad_limit][:3]}")

    for key, _table in job_route._CHILD_TABLES:
        returned = response.get(key)
        check(f"(1c) {key}: 20 rows returned, newest ('row-00') FIRST",
              isinstance(returned, list) and len(returned) == 20
              and returned[0].get("id") == "row-00",
              f"len={len(returned) if isinstance(returned, list) else returned!r} "
              f"first={returned[0].get('id') if isinstance(returned, list) and returned else None!r}")

    print(f"        truncation messages: {len(messages)}")
    if messages:
        print(f"        sample: {messages[0]}")
    check("(1d) one truncation message per table, naming the table AND the job id",
          len(messages) == 12
          and all(LIVE_JOB in m for m in messages)
          and all(any(t in m for t in child_tables) for m in messages),
          f"{len(messages)} messages; sample={messages[:1]}")

    # (e) — exactly 20 rows: full, and SILENT.
    response20, _rec20, messages20 = _run_get_job_with_stub(_synthetic_rows(20))
    check("(1e) with exactly 20 rows every table returns 20...",
          all(len(response20.get(k) or []) == 20 for k, _t in job_route._CHILD_TABLES),
          str({k: len(response20.get(k) or []) for k, _t in job_route._CHILD_TABLES}))
    check("(1e) ...and NO truncation message is recorded", not messages20,
          str(messages20))


def t_h_live_hydration(client) -> None:
    print("\nTh. the LIVE read — hydrated counts vs what the tables actually hold")
    owner = (client.table("jobs").select("company_id")
             .eq("job_id", LIVE_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    caller = auth.Caller(user_id="gate-runner", email="gate@example.com",
                         company_id=company_id, role="owner")
    messages: list[str] = []
    original_capture = job_route.sentry_sdk.capture_message
    job_route.sentry_sdk.capture_message = lambda msg, *a, **k: messages.append(str(msg))
    try:
        response = asyncio.run(job_route.get_job(LIVE_JOB, caller))
    finally:
        job_route.sentry_sdk.capture_message = original_capture

    # Counted in THIS run from the database, never quoted from the prompt.
    for key, table in job_route._CHILD_TABLES:
        actual = (client.table(table).select("*", count="exact")
                  .eq("job_id", LIVE_JOB).limit(1).execute().count)
        hydrated = len(response.get(key) or [])
        print(f"        {key:18s} database={actual:<3} hydrated={hydrated}")
        check(f"(3) {key}: hydrated count == the database count",
              hydrated == actual, f"db={actual} hydrated={hydrated}")

    sizing = response.get("sizing_results") or []
    check("(3) sizing_results[0] is the F93 run 24712cbf…",
          bool(sizing) and sizing[0].get("sizing_result_id")
          == "24712cbf-3cff-44bd-86cc-bb7f2018e61b",
          str(sizing[0].get("sizing_result_id") if sizing else None))
    check("(3) ...with run_kind 'solar' and engine_mode 'sequential'",
          bool(sizing) and sizing[0].get("run_kind") == "solar"
          and sizing[0].get("engine_mode") == "sequential",
          f"{sizing[0].get('run_kind') if sizing else None!r} / "
          f"{sizing[0].get('engine_mode') if sizing else None!r}")
    check("(3) nothing on this job truncated", not messages, str(messages))

    # (4) THE ROOF ORDERING — the one live case with more than one row, and the
    # one where getting it backwards is a PRODUCT fault: on this job the newer
    # row is the FLAGGED one, so the wrong order shows a clean roof where the
    # product should be showing doubt. Which row is newer is DERIVED here.
    roof = response.get("roof_geometry") or []
    check("(4) this job holds more than one roof_geometry row", len(roof) >= 2,
          str(len(roof)))
    if len(roof) >= 2:
        newest = max(roof, key=lambda r: str(r.get("created_at") or ""))
        print(f"        newest roof by created_at: {newest.get('roof_geometry_id')} "
              f"({newest.get('created_at')}) low_confidence={newest.get('low_confidence')}")
        print(f"        returned FIRST           : {roof[0].get('roof_geometry_id')} "
              f"({roof[0].get('created_at')})")
        check("(4) the FIRST returned roof row IS the newest by created_at",
              roof[0].get("roof_geometry_id") == newest.get("roof_geometry_id"),
              f"first={roof[0].get('roof_geometry_id')} newest={newest.get('roof_geometry_id')}")
        check("(4) ...and it is the FLAGGED one — the wrong order would show a "
              "clean roof where the product should show doubt",
              roof[0].get("low_confidence") is True, str(roof[0].get("low_confidence")))
        # The redaction still ran on every RETURNED row (it is applied after the
        # slice, so the redacted count matches the returned count).
        expired = [r for r in roof
                   if solar_retention.is_solar_data_expired(r)]
        marked = [r for r in roof if r.get("solar_data_expired") is True]
        check("(4) redaction ran on every returned row — every expired row is "
              "marked, and no unexpired row is",
              len(marked) == len(expired),
              f"{len(expired)} expired, {len(marked)} marked")


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
    t_g_order_and_limit()
    if client is not None:
        t_h_live_hydration(client)
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
