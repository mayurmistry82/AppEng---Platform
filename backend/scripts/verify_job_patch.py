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
    def __init__(self, client):
        self._client = client
        self._update_payload = None

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def update(self, payload):
        self._update_payload = payload
        return self

    def execute(self):
        if self._client.raise_transport:
            raise httpx.ConnectError("connection refused")
        if self._update_payload is not None:
            self._client.updates.append(self._update_payload)
            self._update_payload = None
            return _Result([])
        return _Result(list(self._client.jobs_rows))


class StubClient:
    """Records every update() payload; serves fixed job rows."""

    def __init__(self, jobs_rows=None, raise_transport=False):
        self.jobs_rows = jobs_rows if jobs_rows is not None else [dict(JOB_ROW)]
        self.updates: list[dict] = []
        self.raise_transport = raise_transport

    def table(self, _name):
        return _Table(self)


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

    print("1. the whitelist: exactly seven fields, everything else DROPPED silently")
    fields = set(job_route.JobSitePatch.model_fields.keys())
    check("model has exactly the seven fields",
          fields == {"storeys", "roof_material", "dwelling_type", "year_built",
                     "bedrooms", "floor_area_m2", "electrical_phase"}, str(fields))
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
                         ("electrical_phase", "three")]:
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
