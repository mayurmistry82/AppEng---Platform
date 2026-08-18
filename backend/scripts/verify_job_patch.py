#!/usr/bin/env python3
"""
verify_job_patch.py — proves the 3.4b PATCH /api/job/{id} contract: the
seven-field whitelist, absent-vs-null semantics, ownership, and fail-closed
transport errors.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_job_patch.py

Use the interpreter the BACKEND runs under, never bare `python3` (F91).

OFFLINE — no network, no database. The Supabase client is a stub that records
every update() dict it receives, because the assertions that matter here are
about WHAT REACHES THE DATABASE, not what the response says: absent-vs-null is
the case that silently destroys data if wrong, and only the stub's recording
can prove it.
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

import httpx  # noqa: E402

import auth  # noqa: E402
from routes import job as job_route  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import ValidationError  # noqa: E402

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


CALLER = auth.Caller(user_id="u1", email="u@example.com", company_id="co-1", role="owner")

JOB_ROW = {
    "job_id": "j1",
    "company_id": "co-1",
    "path": "A",
    "status": "draft",
    "storeys": None,
    "roof_material": None,
    "dwelling_type": None,
}


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, client, name):
        self._client = client
        self._name = name
        self._update_payload = None
        self._upsert = None

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def update(self, payload):
        self._update_payload = payload
        return self

    def upsert(self, payload, on_conflict=None):
        self._upsert = (payload, on_conflict)
        return self

    def execute(self):
        if self._client.raise_transport:
            raise httpx.ConnectError("connection refused")
        if self._update_payload is not None:
            # `updates` stays the flat list the pre-3.3c checks index into; the
            # (table, payload) record is what proves customer fields never land
            # in a jobs update (check 1b).
            self._client.updates.append(self._update_payload)
            self._client.update_calls.append((self._name, self._update_payload))
            self._update_payload = None
            return _Result([])
        if self._upsert is not None:
            payload, on_conflict = self._upsert
            self._client.upserts.append((self._name, payload, on_conflict))
            self._upsert = None
            return _Result([dict(payload)])
        return _Result(list(self._client.tables.get(self._name, [])))


class StubClient:
    """Records every update()/upsert() payload; serves fixed rows PER TABLE.

    3.3c: patch_job reads jobs, the four address-lock tables and job_customers,
    and writes jobs (update) and job_customers (upsert) — so the stub carries a
    table map. `jobs_rows` keeps its original meaning; `table_rows` seeds any
    other table (the lock checks read roof_geometry / sizing_results / tariffs
    / interval_data)."""

    def __init__(self, jobs_rows=None, raise_transport=False, table_rows=None):
        self.tables: dict[str, list] = {
            "jobs": jobs_rows if jobs_rows is not None else [dict(JOB_ROW)],
        }
        if table_rows:
            self.tables.update(table_rows)
        self.updates: list[dict] = []
        self.update_calls: list[tuple[str, dict]] = []
        self.upserts: list[tuple[str, dict, str]] = []
        self.raise_transport = raise_transport

    @property
    def jobs_rows(self):
        return self.tables["jobs"]

    def table(self, name):
        return _Table(self, name)


def run_patch(stub, payload, job_id="j1"):
    """Drive the REAL endpoint with the stub in place. Returns (result, exception)."""
    original = job_route._svc
    job_route._svc = lambda: stub
    try:
        body = job_route.JobSitePatch(**payload)
        return asyncio.run(job_route.patch_job(job_id, body, CALLER)), None
    except HTTPException as exc:
        return None, exc
    finally:
        job_route._svc = original


def main() -> int:
    print("verify_job_patch.py — PATCH /api/job/{id} contract (offline)\n")

    print("1. the whitelist: exactly sixteen fields, everything else DROPPED silently")
    # 3.3c grew the seven site fields by the six job-bar-edit fields; 3.9 grew
    # them again by the three optimisation inputs — one whitelist that grows,
    # never a second implementation (D2).
    fields = set(job_route.JobSitePatch.model_fields.keys())
    check("model has exactly the sixteen fields",
          fields == {"storeys", "roof_material", "dwelling_type", "year_built",
                     "bedrooms", "floor_area_m2", "electrical_phase",
                     "customer_name", "has_existing_solar", "existing_solar_kw",
                     "existing_inverter_kw", "intent", "address",
                     "objective", "custom_weight", "budget_aud"}, str(fields))
    stub = StubClient()
    smuggle = {"storeys": 2, "company_id": "co-EVIL", "installer_id": "x",
               "path": "F", "status": "won", "address": "1 Evil St"}
    _res, exc = run_patch(stub, smuggle)
    check("a payload smuggling company_id/path/status/address does not error", exc is None,
          f"raised {exc}")
    check("exactly one update reached the stub", len(stub.updates) == 1, str(stub.updates))
    sent = stub.updates[0] if stub.updates else {}
    banned = {"company_id", "installer_id", "path", "status", "address"} & set(sent)
    check("none of the banned keys reached the update call", banned == set(), str(sent))
    check("the whitelisted field DID reach it", sent.get("storeys") == 2, str(sent))
    check("updated_at was set", "updated_at" in sent, str(sent))

    print("\n2. absent vs explicit null — the one that destroys data if wrong")
    stub = StubClient()
    _res, exc = run_patch(stub, {"storeys": None})
    sent = stub.updates[0] if stub.updates else {}
    check("{'storeys': null} sends storeys=None (CLEARS the column)",
          exc is None and "storeys" in sent and sent["storeys"] is None, str(sent))
    check("...and touches nothing else (only storeys + updated_at)",
          set(sent) == {"storeys", "updated_at"}, str(sent))

    stub = StubClient()
    _res, exc = run_patch(stub, {"bedrooms": 3})
    sent = stub.updates[0] if stub.updates else {}
    check("{'bedrooms': 3} leaves storeys UNTOUCHED (absent from the dict)",
          exc is None and "storeys" not in sent, str(sent))
    check("...exact dict is bedrooms + updated_at only",
          set(sent) == {"bedrooms", "updated_at"} and sent["bedrooms"] == 3, str(sent))

    print("\n3. validation bounds — 422 naming the field, never a silent clamp")
    bad = [
        ("storeys", 0), ("storeys", 6),
        ("year_built", 1799), ("year_built", 2101),
        ("bedrooms", -1), ("bedrooms", 21),
        ("floor_area_m2", 0), ("floor_area_m2", 2001),
        ("dwelling_type", "apartment"), ("dwelling_type", "duplex"),
        ("electrical_phase", "two"),
        # 3.9 — the optimisation inputs' bounds. budget_aud 0 is a typo, never
        # an instruction (gt=0); "backup" rejected is the check that fails the
        # day someone adds backup to the model without adding it to the engine.
        ("budget_aud", 0), ("budget_aud", 500001),
        ("custom_weight", -0.1), ("custom_weight", 1.1),
        ("objective", "backup"),
    ]
    for field, value in bad:
        try:
            job_route.JobSitePatch(**{field: value})
            check(f"{field}={value!r} rejected", False, "validated cleanly")
        except ValidationError as exc:
            named = any(field in str(err.get("loc", "")) for err in exc.errors())
            check(f"{field}={value!r} rejected naming the field", named, str(exc.errors())[:120])
    for field, value in [("storeys", 1), ("storeys", 5), ("year_built", 1800),
                         ("year_built", 2100), ("bedrooms", 0), ("bedrooms", 20),
                         ("floor_area_m2", 2000), ("dwelling_type", "unit"),
                         ("electrical_phase", "three"),
                         ("budget_aud", 1), ("budget_aud", 500000),
                         ("custom_weight", 0), ("custom_weight", 1),
                         ("objective", "custom")]:
        try:
            job_route.JobSitePatch(**{field: value})
            check(f"boundary {field}={value!r} accepted", True)
        except ValidationError as exc:
            check(f"boundary {field}={value!r} accepted", False, str(exc)[:120])

    print("\n4. roof_material is normalised (no DB constraint — this IS the guard)")
    stub = StubClient()
    run_patch(stub, {"roof_material": "  Colorbond or metal  "})
    sent = stub.updates[0] if stub.updates else {}
    check("stored lowercase and trimmed", sent.get("roof_material") == "colorbond or metal",
          str(sent))

    print("\n5. ownership and fail-closed")
    foreign = StubClient(jobs_rows=[{**JOB_ROW, "company_id": "co-OTHER"}])
    _res, exc_foreign = run_patch(foreign, {"storeys": 2})
    check("foreign job -> 404", exc_foreign is not None and exc_foreign.status_code == 404,
          str(exc_foreign))
    check("foreign job -> NO update reached the stub", foreign.updates == [], str(foreign.updates))
    absent = StubClient(jobs_rows=[])
    _res, exc_absent = run_patch(absent, {"storeys": 2})
    check("absent job -> 404", exc_absent is not None and exc_absent.status_code == 404)
    check("details IDENTICAL — existence never leaks",
          exc_foreign is not None and exc_absent is not None
          and exc_foreign.detail == exc_absent.detail,
          f"{getattr(exc_foreign,'detail',None)!r} vs {getattr(exc_absent,'detail',None)!r}")
    down = StubClient(raise_transport=True)
    _res, exc_down = run_patch(down, {"storeys": 2})
    check("Supabase unreachable -> 503, never 404 (F88)",
          exc_down is not None and exc_down.status_code == 503,
          f"got {getattr(exc_down, 'status_code', None)}")

    print("\n7. 3.3c — the two-table write and the address lock")
    ALL13 = {
        "storeys": 2, "roof_material": "tile", "dwelling_type": "unit",
        "year_built": 1995, "bedrooms": 3, "floor_area_m2": 180.0,
        "electrical_phase": "single",
        "customer_name": "N. Chen", "has_existing_solar": True,
        "existing_solar_kw": 6.6, "existing_inverter_kw": 5.0, "intent": "both",
        "address": "10 High St, Adelaide SA 5000",
    }
    stub = StubClient()
    _res, exc = run_patch(stub, dict(ALL13))
    check("(1a) all 13 accepted — no error", exc is None, str(exc))
    jobs_sent = stub.updates[0] if stub.updates else {}
    check("(1a) the jobs dict carries the 11 jobs columns + updated_at",
          set(jobs_sent) == {"storeys", "roof_material", "dwelling_type",
                             "year_built", "bedrooms", "floor_area_m2",
                             "electrical_phase", "has_existing_solar",
                             "existing_solar_kw", "existing_inverter_kw",
                             "intent", "updated_at"}, str(sorted(jobs_sent)))
    cust_upserts = [(t, p, oc) for (t, p, oc) in stub.upserts if t == "job_customers"]
    cust_sent = cust_upserts[0][1] if cust_upserts else {}
    check("(1a) the job_customers upsert carries name + mapped address + key",
          set(cust_sent) == {"customer_name", "property_address_full",
                             "updated_at", "job_id"}
          and cust_sent.get("property_address_full") == ALL13["address"]
          and cust_upserts[0][2] == "job_id", str(cust_sent))

    # (1b) THE CENTRAL CHECK: PII never lands in a jobs update, in ANY update.
    jobs_update_payloads = [p for (t, p) in stub.update_calls if t == "jobs"]
    check("(1b) customer_name / address in NO jobs update dict",
          all("customer_name" not in p and "address" not in p
              and "property_address_full" not in p for p in jobs_update_payloads),
          str(jobs_update_payloads))
    check("(1b) ...and they DID land in job_customers",
          cust_sent.get("customer_name") == "N. Chen", str(cust_sent))

    stub = StubClient()
    _res, exc = run_patch(stub, {"storeys": 1, "path": "F", "company_id": "co-EVIL",
                                 "installer_id": "x", "status": "won", "job_id": "zzz"})
    check("(1c) path/company_id/installer_id/status/job_id silently dropped",
          exc is None and stub.updates
          and set(stub.updates[0]) == {"storeys", "updated_at"}
          and stub.upserts == [], f"{stub.updates} / {stub.upserts}")

    stub = StubClient()
    _res, exc = run_patch(stub, {"customer_name": None})
    cust = [p for (t, p, _o) in stub.upserts if t == "job_customers"]
    check("(1d) {'customer_name': null} -> upsert KEYS carry customer_name=None",
          exc is None and cust and "customer_name" in cust[0]
          and cust[0]["customer_name"] is None
          and set(cust[0]) == {"customer_name", "updated_at", "job_id"},
          str(cust))
    check("(1d) ...and NO jobs update for a customer-only payload",
          stub.updates == [], str(stub.updates))
    stub = StubClient()
    _res, exc = run_patch(stub, {"intent": "both"})
    check("(1d) {'intent':'both'} -> jobs update only, ZERO job_customers writes",
          exc is None and stub.updates
          and set(stub.updates[0]) == {"intent", "updated_at"}
          and stub.upserts == [], f"{stub.updates} / {stub.upserts}")

    for label, payload in (
        ("intent='rubbish'", {"intent": "rubbish"}),
        ("existing_solar_kw=-1", {"existing_solar_kw": -1}),
        ("address=''", {"address": ""}),
    ):
        try:
            job_route.JobSitePatch(**payload)
            check(f"(1e) {label} rejected", False, "validated cleanly")
        except ValidationError:
            check(f"(1e) {label} rejected", True)

    # (1f) THE LOCK, each table independently — a rule written as
    # `if roof_geometry_count` passes one combined test and fails three of these.
    for table in ("roof_geometry", "sizing_results", "tariffs", "interval_data"):
        stub = StubClient(table_rows={table: [{"job_id": "j1"}]})
        res, exc = run_patch(stub, {"address": "1 New St, Adelaide SA 5000"})
        body_json = json.loads(res.body) if isinstance(res, JSONResponse) else None
        check(f"(1f) {table} row present -> 409, exact detail",
              exc is None and isinstance(res, JSONResponse)
              and res.status_code == 409
              and body_json == {"detail": job_route._ADDRESS_LOCKED_DETAIL},
              f"res={res!r} body={body_json}")
        check(f"(1f) {table}: ZERO update calls and ZERO upserts",
              stub.updates == [] and stub.upserts == [],
              f"{stub.updates} / {stub.upserts}")
    stub = StubClient()  # all four empty
    _res, exc = run_patch(stub, {"address": "1 New St, Adelaide SA 5000"})
    check("(1f) all four empty -> the address writes normally",
          exc is None and stub.upserts
          and stub.upserts[0][1].get("property_address_full")
          == "1 New St, Adelaide SA 5000", str(stub.upserts))

    stub = StubClient(table_rows={"roof_geometry": [{"job_id": "j1"}]})
    res, exc = run_patch(stub, {"address": "1 New St", "customer_name": "X",
                                "storeys": 3})
    check("(1g) locked + mixed payload -> 409 and NOTHING written at all",
          exc is None and isinstance(res, JSONResponse) and res.status_code == 409
          and stub.updates == [] and stub.upserts == [],
          f"{stub.updates} / {stub.upserts}")

    check("(1h) updated_at set on the jobs write", "updated_at" in jobs_sent)
    check("(1h) updated_at set on the job_customers write — no trigger sets it",
          "updated_at" in cust_sent)

    print("\n6. empty payload -> no update call at all")
    stub = StubClient()
    res, exc = run_patch(stub, {})
    check("no exception", exc is None, str(exc))
    check("ZERO updates reached the stub", stub.updates == [], str(stub.updates))
    check("the job row still comes back",
          isinstance(res, dict) and res.get("job_id") == "j1"
          and not isinstance(res, JSONResponse), str(type(res)))

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
    except Exception:  # noqa: BLE001 — a crashing verifier must not read as success
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
