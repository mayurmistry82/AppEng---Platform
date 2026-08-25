#!/usr/bin/env python3
"""
verify_roof_confirmation.py — the 3.4c prompt-1 gate: the roof CONFIRMED state.

  (1) CONFIRMED_SOURCES exists in routes/roof.py, is a non-empty frozenset —
      the D33 pattern (RUN_KINDS / ENGINE_MODES in capture.py): ONE Python
      constant, no CHECK constraint, refusal at write time, drift checked here.
  (2) THE INHERITANCE PROOF, run rather than read (F148): _persist's inserted
      row dict, captured through a recording stub client, carries NONE of the
      three confirmation columns — its key set is asserted EXPLICITLY — so a
      fresh lookup appends a row whose confirmation is NULL by construction,
      because of the shape of the code rather than because someone remembered.
  (3) REFUSAL BEFORE WRITE: the confirm endpoint run against a recording stub
      with an unknown source answers 422 naming the accepted values and
      performs ZERO writes. WHY IT MOVES IF THE FAULT IS PRESENT: an endpoint
      that validates after writing leaves a timestamp behind.
  (4) UPDATE, NEVER APPEND: a valid confirm against the stub records exactly
      ONE update, targeting the NEWEST roof row's id, with exactly the three
      confirmation columns in its patch, ZERO inserts — and the identity
      written is the Caller's, never anything from the body.
  (5) THE VOCABULARY vs what is actually STORED, both directions, both sorted
      lists printed (live read): a stored label outside the constant FAILS —
      this drift check is what replaces a CHECK constraint (D33); a constant
      label not yet stored is printed as INFORMATION, not failed — a
      vocabulary may name a label before its first write ("customer" starts
      life unused until a customer confirms one).
  (6) THE COLUMNS EXIST — all three nullable, no default, and
      roof_confirmed_source carries NO CHECK constraint (D33). Needs the
      Postgres catalogues, which PostgREST does not expose, so it runs over a
      direct connection (SUPABASE_DB_URL + psycopg2) and SKIPS LOUDLY
      otherwise — printed, uncounted, never a pass (F177). With a connection,
      any error other than absence FAILS so the bridge cannot rot.

READS the live database ((5) the stored sources, (6) the catalogues); WRITES
NOTHING — every endpoint run in here is against a stub client.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_roof_confirmation.py
Use the interpreter the backend runs under, never bare `python3` (F91).
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

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

import auth  # noqa: E402
from routes import roof  # noqa: E402

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
    print(f"  SKIP  {msg} NOT counted as a pass (F177).")


CALLER = auth.Caller(user_id="caller-from-token", email="u@example.com",
                     company_id="co-1", role="owner")

# The three columns this task added — THE trio, named once.
TRIO = ("roof_confirmed_at", "roof_confirmed_by", "roof_confirmed_source")

# _persist's inserted row dict, key for key (routes/roof.py). Asserted as an
# EXACT set: a key added to _persist without this gate hearing about it is
# exactly the kind of silent drift the inheritance proof exists to catch.
EXPECTED_PERSIST_KEYS = {
    "job_id", "address", "lat", "lng", "found", "source", "imagery_quality",
    "imagery_date", "imagery_stale", "manual_entry_required", "low_confidence",
    "needs_manual_confirmation", "reason", "flags", "selected_panel",
    "usability_factor", "planes", "candidate_configs", "total_kwp",
    "max_panels", "google_max_array_panels_count", "panels_raw",
    "segment_bounding_boxes", "building_center", "building_bounding_box",
    "geocoded_postcode", "geocoded_state", "geocoded_formatted_address",
    "solar_data_captured_at", "google_panel_width_m", "google_panel_height_m",
    "google_panel_capacity_w",
}


# ── Stub Supabase client (offline; records every write) ──────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, client, name):
        self._c, self._name = client, name
        self._mode, self._patch, self._eqs = "select", None, []

    def select(self, *_a, **_k):
        self._mode = "select"
        return self

    def eq(self, col, val):
        self._eqs.append((col, val))
        return self

    def order(self, *_a, **_k):
        return self  # configured rows are already newest-first

    def limit(self, n, *_a, **_k):
        self._limit = n
        return self

    def insert(self, row):
        self._mode = "insert"
        self._c.inserts.append((self._name, row))
        return self

    def update(self, patch):
        self._mode = "update"
        self._patch = dict(patch)
        return self

    def _match(self):
        return [r for r in self._c.rows.get(self._name, [])
                if all(r.get(c) == v for c, v in self._eqs)]

    def execute(self):
        if self._mode == "insert":
            return _Result([])
        if self._mode == "update":
            self._c.updates.append((self._name, dict(self._patch), list(self._eqs)))
            return _Result([dict(r, **self._patch) for r in self._match()])
        rows = self._match()
        if getattr(self, "_limit", None):
            rows = rows[: self._limit]
        return _Result(rows)


class StubClient:
    """Fixed rows per table (newest-first, as the real order-by would return);
    records every insert and update."""

    def __init__(self, rows: dict):
        self.rows = rows
        self.inserts: list = []
        self.updates: list = []

    def table(self, name):
        return _Table(self, name)


def _run(coro):
    return asyncio.run(coro)


def _body_of(resp) -> dict:
    if hasattr(resp, "body"):
        return json.loads(resp.body)
    return resp


JOBS = [{"job_id": "j1", "company_id": "co-1", "site_postcode": "5000",
         "site_state": "SA"}]
ROOFS = [  # newest FIRST — the created_at-desc rule
    {"roof_geometry_id": "roof-NEW", "job_id": "j1",
     "created_at": "2026-08-25T02:00:00+00:00"},
    {"roof_geometry_id": "roof-OLD", "job_id": "j1",
     "created_at": "2026-08-01T02:00:00+00:00"},
]


def t1_constant() -> None:
    print("T1. the vocabulary constant — ONE definition, the D33 shape")
    cs = getattr(roof, "CONFIRMED_SOURCES", None)
    check("(1) CONFIRMED_SOURCES exists in routes/roof.py and is a frozenset",
          isinstance(cs, frozenset), str(type(cs)))
    check("(1) ...and is non-empty (an empty vocabulary refuses everything)",
          bool(cs), str(cs))
    print(f"        CONFIRMED_SOURCES: {sorted(cs or [])}")


def t2_inheritance() -> None:
    print("\nT2. the inheritance proof — _persist's row dict, RUN and recorded "
          "(F148), key set asserted explicitly")
    stub = StubClient({"jobs": JOBS, "roof_geometry": ROOFS})
    original = roof._client
    roof._client = lambda: stub
    try:
        persisted, err = roof._persist({"flags": []}, "j1")
    finally:
        roof._client = original
    check("(2) _persist inserted exactly one row through the stub",
          persisted is True and err is None and len(stub.inserts) == 1
          and stub.inserts[0][0] == "roof_geometry",
          f"persisted={persisted} err={err} inserts={len(stub.inserts)}")
    if not stub.inserts:
        return
    keys = set(stub.inserts[0][1].keys())
    print(f"        inserted key set ({len(keys)}): {sorted(keys)}")
    check("(2) NONE of the three confirmation columns is in _persist's row — "
          "an appended row cannot carry a confirmation forward",
          not (keys & set(TRIO)), f"leaked: {sorted(keys & set(TRIO))}")
    check("(2) the key set matches routes/roof.py's row dict EXACTLY — any "
          "drift in _persist's shape is heard here, not discovered later",
          keys == EXPECTED_PERSIST_KEYS,
          f"extra={sorted(keys - EXPECTED_PERSIST_KEYS)} "
          f"missing={sorted(EXPECTED_PERSIST_KEYS - keys)}")


def t3_refusal() -> None:
    print("\nT3. refusal BEFORE write — unknown source: 422, values named, "
          "ZERO writes recorded")
    stub = StubClient({"jobs": JOBS, "roof_geometry": ROOFS})
    original = roof._client
    roof._client = lambda: stub
    try:
        resp = _run(roof.roof_confirm_endpoint(
            roof.RoofConfirmRequest(job_id="j1", source="carrier-pigeon"), CALLER))
    finally:
        roof._client = original
    body = _body_of(resp)
    status = getattr(resp, "status_code", 200)
    print(f"        status={status} body={body}")
    check("(3) unknown source answers 422", status == 422, str(status))
    check("(3) ...naming every accepted value in the message",
          all(s in str(body.get("error", "")) for s in roof.CONFIRMED_SOURCES),
          str(body))
    check("(3) ...and recorded ZERO updates and ZERO inserts — the refusal "
          "happens before any write path is reachable",
          stub.updates == [] and stub.inserts == [],
          f"updates={stub.updates} inserts={stub.inserts}")


def t4_update_never_append() -> None:
    print("\nT4. a valid confirm UPDATES the newest row — never appends, "
          "never trusts the body for identity")
    stub = StubClient({"jobs": JOBS, "roof_geometry": ROOFS})
    original = roof._client
    roof._client = lambda: stub
    try:
        resp = _run(roof.roof_confirm_endpoint(
            roof.RoofConfirmRequest(job_id="j1", source="installer"), CALLER))
    finally:
        roof._client = original
    body = _body_of(resp)
    print(f"        response: {body}")
    print(f"        updates recorded: {stub.updates}")
    check("(4) exactly ONE update, ZERO inserts",
          len(stub.updates) == 1 and stub.inserts == [],
          f"updates={len(stub.updates)} inserts={len(stub.inserts)}")
    if not stub.updates:
        return
    table, patch, eqs = stub.updates[0]
    check("(4) the update targets roof_geometry by the NEWEST row's id",
          table == "roof_geometry"
          and ("roof_geometry_id", "roof-NEW") in eqs, f"{table} {eqs}")
    check("(4) the patch is EXACTLY the three confirmation columns",
          set(patch.keys()) == set(TRIO), str(sorted(patch.keys())))
    check("(4) roof_confirmed_by is the CALLER's user_id — identity from the "
          "auth dependency, never the body",
          patch.get("roof_confirmed_by") == CALLER.user_id,
          str(patch.get("roof_confirmed_by")))
    check("(4) roof_confirmed_source is the given label",
          patch.get("roof_confirmed_source") == "installer",
          str(patch.get("roof_confirmed_source")))
    check("(4) the response names WHICH roof was confirmed and echoes the "
          "three STORED values",
          body.get("confirmed") is True
          and body.get("roof_geometry_id") == "roof-NEW"
          and body.get("roof_confirmed_source") == "installer"
          and body.get("roof_confirmed_by") == CALLER.user_id
          and bool(body.get("roof_confirmed_at")), str(body))


def t5_vocabulary_live() -> int:
    print("\nT5. the vocabulary vs what is actually STORED — both directions, "
          "live read (the drift check that replaces a CHECK constraint, D33)")
    client = roof._client()
    if client is None:
        skip("(5) the live read needs the Supabase env (SUPABASE_URL + key).")
        return 1
    try:
        res = client.table("roof_geometry").select("roof_confirmed_source").execute()
        rows = getattr(res, "data", None) or []
    except Exception as exc:  # noqa: BLE001 — a missing column must FAIL, not skip
        check("(5) the live read of roof_confirmed_source ran", False, repr(exc))
        return 0
    stored = {r.get("roof_confirmed_source") for r in rows} - {None}
    constant = roof.CONFIRMED_SOURCES
    print(f"        stored distinct sources : {sorted(stored)}")
    print(f"        CONFIRMED_SOURCES       : {sorted(constant)}")
    print(f"        stored but not in constant: {sorted(stored - constant)}")
    print(f"        in constant, never stored : {sorted(constant - stored)} "
          "(INFORMATION, not a failure — a label may exist before its first write)")
    check("(5) every STORED source is in CONFIRMED_SOURCES — no unknown label "
          "has reached the database", stored <= constant,
          f"unknown stored: {sorted(stored - constant)}")
    return 0


def t6_catalogues() -> int:
    print("\nT6. the columns exist — nullable, no default, NO CHECK constraint "
          "(system catalogues; direct Postgres or a loud skip)")
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        psycopg2 = None
    if not db_url or psycopg2 is None:
        skip("(6) needs SUPABASE_DB_URL + psycopg2 (PostgREST does not expose "
             "the catalogues).")
        return 1
    try:
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute(
            "select column_name, data_type, is_nullable, column_default "
            "from information_schema.columns where table_schema='public' "
            "and table_name='roof_geometry' and column_name = any(%s) "
            "order by column_name", (list(TRIO),))
        cols = {r[0]: r[1:] for r in cur.fetchall()}
        print(f"        catalogue rows: {cols}")
        want = {"roof_confirmed_at": "timestamp with time zone",
                "roof_confirmed_by": "uuid",
                "roof_confirmed_source": "text"}
        for name, dtype in want.items():
            row = cols.get(name)
            check(f"(6) {name} exists as {dtype}, nullable, no default",
                  row is not None and row[0] == dtype and row[1] == "YES"
                  and row[2] is None, str(row))
        cur.execute(
            "select conname, pg_get_constraintdef(oid) from pg_constraint "
            "where conrelid = 'public.roof_geometry'::regclass and contype='c'")
        checks = cur.fetchall()
        offenders = [c for c in checks if "roof_confirmed_source" in c[1]]
        check("(6) roof_confirmed_source carries NO CHECK constraint (D33 — "
              "the vocabulary lives in CONFIRMED_SOURCES, not a migration)",
              offenders == [], str(offenders))
        conn.close()
    except Exception as exc:  # noqa: BLE001 — with a bridge, an error FAILS
        check("(6) catalogue comparison ran", False, f"errored (not skipped): {exc!r}")
    return 0


def main() -> int:
    print("verify_roof_confirmation.py — 3.4c prompt 1 (stubbed writes, live "
          "reads only)\n")
    global SKIPPED
    try:
        t1_constant()
        t2_inheritance()
        t3_refusal()
        t4_update_never_append()
        t5_vocabulary_live()
        t6_catalogues()
    except Exception:
        traceback.print_exc()
        FAILURES.append("unhandled exception")
    tail = f" ({SKIPPED} skipped LOUDLY, not counted)" if SKIPPED else ""
    if FAILURES:
        print(f"\nFAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed{tail}:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print(f"\nOK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
