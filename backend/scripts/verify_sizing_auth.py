#!/usr/bin/env python3
"""
verify_sizing_auth.py — the 3.11 prompt-1b gate: the two sizing endpoints have
a caller. Runs FastAPI's TestClient against main.app so the REAL dependency
graph executes.

NO ROWS ARE WRITTEN, check by check:
  (1a)(1b)(1c)  fail at the auth layer, before any endpoint code runs.
  (2a)(2b)(2c)  fail at the ownership check, before any resolver or writer.
  (4)           fails at the ownership check for the same reason.
  (3)(5)        reach the writer — capture.save_sizing_result is replaced by a
                recorder for those runs, and generation._cache_put is no-opped
                (the live job's roof planes are PVGIS cache misses).

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_sizing_auth.py
"""
from __future__ import annotations

import json
import os
import sys
import traceback

import httpx

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import capture  # noqa: E402
import cost_model  # noqa: E402
import generation  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
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
ENDPOINTS = ("/api/sizing/optimise", "/api/sizing/battery")

client_http = TestClient(main.app, raise_server_exceptions=False)


# ── A stub Supabase client for the ownership check only ──────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _OwnershipStub:
    """Serves ONLY the jobs read _get_company_job performs. mode: 'foreign' —
    a row owned by company-B; 'absent' — zero rows; 'transport' — raises."""

    def __init__(self, mode: str):
        self.mode = mode

    def table(self, name):
        return self

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def execute(self):
        if self.mode == "transport":
            raise httpx.TransportError("stub: network down")
        if self.mode == "foreign":
            return _Result([{"job_id": LIVE_JOB, "company_id": "company-B"}])
        return _Result([])  # absent


def t1_auth_layer() -> None:
    print("T1. the auth layer — the REAL dependency, no overrides")
    for path in ENDPOINTS:
        r = client_http.post(path, json={"job_id": LIVE_JOB})
        check(f"(1a) {path} with NO Authorization header -> 401",
              r.status_code == 401, f"{r.status_code} {r.text[:80]}")
    for header in ("Bearer", "Basic xyz", "Bearer "):
        r = client_http.post(ENDPOINTS[0], json={},
                             headers={"Authorization": header})
        check(f"(1b) malformed header {header!r} -> 401",
              r.status_code == 401, f"{r.status_code} {r.text[:80]}")

    # (1c) valid token, NO company: _validate_token stubbed to a real-shaped
    # identity and _lookup_company stubbed to (None, None) — never the
    # database. A UNIQUE token keeps the 60s Caller cache clean.
    orig_validate, orig_lookup = auth._validate_token, auth._lookup_company
    auth._validate_token = lambda token: {"user_id": "u-1c", "email": "c@example.com"}
    auth._lookup_company = lambda user_id: (None, None)
    try:
        r = client_http.post(ENDPOINTS[0], json={},
                             headers={"Authorization": "Bearer gate-1c-unique-token"})
    finally:
        auth._validate_token, auth._lookup_company = orig_validate, orig_lookup
    check("(1c) valid token with company_id None -> 403",
          r.status_code == 403, f"{r.status_code} {r.text[:80]}")


def _as_company_a():
    main.app.dependency_overrides[auth.require_company] = lambda: auth.Caller(
        user_id="user-A", email="a@example.com", company_id="company-A", role="owner")


def _clear_overrides():
    main.app.dependency_overrides.clear()


def t2_ownership() -> None:
    print("\nT2. the ownership rule — absent and foreign are the same 404")
    _as_company_a()
    orig_sb = sizing_route._sb
    try:
        sizing_route._sb = lambda: _OwnershipStub("foreign")
        r_foreign = client_http.post(ENDPOINTS[0], json={"job_id": LIVE_JOB})
        check("(2a) a job owned by company-B -> 404 for company-A",
              r_foreign.status_code == 404, f"{r_foreign.status_code} {r_foreign.text[:80]}")

        sizing_route._sb = lambda: _OwnershipStub("absent")
        r_absent = client_http.post(ENDPOINTS[0], json={"job_id": LIVE_JOB})
        check("(2b) an absent job -> 404", r_absent.status_code == 404,
              f"{r_absent.status_code} {r_absent.text[:80]}")
        print(f"        foreign body: {r_foreign.text}")
        print(f"        absent  body: {r_absent.text}")
        check("(2b) the two 404 bodies are BYTE-IDENTICAL — existence never leaks",
              r_foreign.text == r_absent.text,
              f"{r_foreign.text!r} vs {r_absent.text!r}")

        sizing_route._sb = lambda: _OwnershipStub("transport")
        r_down = client_http.post(ENDPOINTS[0], json={"job_id": LIVE_JOB})
        check("(2c) a transport failure -> 503, never 404 and never 200",
              r_down.status_code == 503, f"{r_down.status_code} {r_down.text[:80]}")
    finally:
        sizing_route._sb = orig_sb
        _clear_overrides()


def t3_t5_happy_and_identity() -> None:
    print("\nT3/T5. the happy path and the installer identity — recorder installed")
    real_client = sizing_route._sb()
    if real_client is None:
        check("(3) live Supabase client available", False, "env not configured")
        return
    owner = (real_client.table("jobs").select("company_id")
             .eq("job_id", LIVE_JOB).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    check("(3) the live job's owning company was read", bool(company_id), str(company_id))
    main.app.dependency_overrides[auth.require_company] = lambda: auth.Caller(
        user_id="gate-runner", email="gate@example.com",
        company_id=company_id, role="owner")

    recorded: list[dict] = []
    override_calls: list = []
    orig_save = capture.save_sizing_result
    orig_cache = generation._cache_put
    orig_override = cost_model._fetch_installer_override
    capture.save_sizing_result = lambda p: (recorded.append(dict(p)) or "fake-id")
    generation._cache_put = lambda *a, **k: None
    cost_model._fetch_installer_override = (
        lambda installer_id: (override_calls.append(installer_id), None)[1])
    try:
        # Run A — installer_id ABSENT. This is both (3)'s happy path and (5)'s
        # first arm.
        r_a = client_http.post(ENDPOINTS[0], json={"job_id": LIVE_JOB})
        check("(3) authenticated owner + real job -> 200", r_a.status_code == 200,
              f"{r_a.status_code} {r_a.text[:120]}")
        body_a = r_a.json() if r_a.status_code == 200 else {}
        check("(3) optimal.solar_kw present",
              isinstance((body_a.get("optimal") or {}).get("solar_kw"), (int, float)),
              str((body_a.get("optimal") or {}).get("solar_kw")))
        check("(3) the recorder captured exactly ONE payload", len(recorded) == 1,
              str(len(recorded)))
        if recorded:
            print("        payload:", json.dumps(recorded[0], default=str)[:400])

        # Run B — installer_id asserting SOMEONE ELSE.
        r_b = client_http.post(ENDPOINTS[0], json={
            "job_id": LIVE_JOB, "installer_id": "some-other-user-id"})
        body_b = r_b.json() if r_b.status_code == 200 else {}
        flag_prefix = "installer_identity_from_login"
        check("(5) run B (foreign installer_id) -> 200 with the identity flag",
              r_b.status_code == 200
              and any(f.startswith(flag_prefix) for f in body_b.get("flags", [])),
              f"{r_b.status_code} flags={body_b.get('flags')}")
        check("(5) ...exactly once", sum(
            1 for f in body_b.get("flags", []) if f.startswith(flag_prefix)) == 1,
            str(body_b.get("flags")))
        check("(5) run A (absent installer_id) carries NO identity flag",
              not any(f.startswith(flag_prefix) for f in body_a.get("flags", [])),
              str(body_a.get("flags")))
        # F148 — run the thing: the override fetcher was CALLED, and every call
        # used the LOGIN identity, in both runs, never the body's value.
        check("(5) _fetch_installer_override was called (both runs exercise it)",
              len(override_calls) >= 2, f"{len(override_calls)} calls")
        check("(5) every override call used caller.user_id, never the body's id",
              all(c == "gate-runner" for c in override_calls),
              str(sorted(set(override_calls))))
    finally:
        capture.save_sizing_result = orig_save
        generation._cache_put = orig_cache
        cost_model._fetch_installer_override = orig_override
        _clear_overrides()


def t4_ordering() -> None:
    print("\nT4. ordering — 404 beats invalid-objective")
    _as_company_a()
    orig_sb = sizing_route._sb
    try:
        sizing_route._sb = lambda: _OwnershipStub("foreign")
        r = client_http.post(ENDPOINTS[0], json={
            "job_id": LIVE_JOB, "objective": "nonsense"})
        check("(4) foreign job + objective 'nonsense' -> 404, NOT the "
              "invalid-objective 200 body (the ownership check runs first)",
              r.status_code == 404 and "invalid objective" not in r.text,
              f"{r.status_code} {r.text[:120]}")
    finally:
        sizing_route._sb = orig_sb
        _clear_overrides()


def main_() -> int:
    print("verify_sizing_auth.py — 3.11 prompt 1b (TestClient, writes nothing)\n")
    t1_auth_layer()
    t2_ownership()
    t3_t5_happy_and_identity()
    t4_ordering()
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
        sys.exit(main_())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
