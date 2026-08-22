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
# 3.14 prompt 7: the run history is a GET beside the two POSTs, and it is
# authenticated by the SAME dependency and the SAME ownership helper.
RUNS = "/api/sizing/runs"
# The job with a real history (16 runs at the time of writing) — read for its
# SHAPE, never for a count typed into this file (2U.2).
HISTORY_JOB = "a57e13f1-24f2-48e3-b816-8a08cb6b2fed"

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
    # 3.14 prompt 7: the GET is not a special case — same layer, same answers.
    r = client_http.get(RUNS, params={"job_id": LIVE_JOB})
    check(f"(1a) {RUNS} with NO Authorization header -> 401",
          r.status_code == 401, f"{r.status_code} {r.text[:80]}")
    for header in ("Bearer", "Basic xyz", "Bearer "):
        r = client_http.get(RUNS, params={"job_id": LIVE_JOB},
                            headers={"Authorization": header})
        check(f"(1b) {RUNS} malformed header {header!r} -> 401",
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

    # 3.14 prompt 7: a caller with no company is refused the SAME way on the
    # history read — and with the SAME body, not merely the same status.
    orig_validate, orig_lookup = auth._validate_token, auth._lookup_company
    auth._validate_token = lambda token: {"user_id": "u-1c", "email": "c@example.com"}
    auth._lookup_company = lambda user_id: (None, None)
    try:
        r_runs = client_http.get(RUNS, params={"job_id": LIVE_JOB},
                                 headers={"Authorization": "Bearer gate-1c-runs-token"})
    finally:
        auth._validate_token, auth._lookup_company = orig_validate, orig_lookup
    print(f"        POST 403 body: {r.text}")
    print(f"        GET  403 body: {r_runs.text}")
    check(f"(1c) {RUNS} with company_id None -> 403, byte-identical to the "
          "siblings' refusal",
          r_runs.status_code == 403 and r_runs.text == r.text,
          f"{r_runs.status_code} {r_runs.text[:80]}")


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

        # ── 3.14 prompt 7: THE SAME THREE ANSWERS on the history read. The
        # foreign/absent pair is compared BODY TO BODY, not read off the code.
        sizing_route._sb = lambda: _OwnershipStub("foreign")
        g_foreign = client_http.get(RUNS, params={"job_id": LIVE_JOB})
        sizing_route._sb = lambda: _OwnershipStub("absent")
        g_absent = client_http.get(RUNS, params={"job_id": LIVE_JOB})
        print(f"        runs foreign: {g_foreign.status_code} {g_foreign.text}")
        print(f"        runs absent : {g_absent.status_code} {g_absent.text}")
        check(f"(2a) {RUNS}: a job owned by company-B -> 404 for company-A",
              g_foreign.status_code == 404,
              f"{g_foreign.status_code} {g_foreign.text[:80]}")
        check(f"(2b) {RUNS}: an absent job -> 404",
              g_absent.status_code == 404,
              f"{g_absent.status_code} {g_absent.text[:80]}")
        check(f"(2b) {RUNS}: the two 404 responses are IDENTICAL in status AND "
              "body — existence never leaks from the new endpoint either",
              g_foreign.status_code == g_absent.status_code
              and g_foreign.text == g_absent.text,
              f"{g_foreign.status_code}/{g_foreign.text!r} vs "
              f"{g_absent.status_code}/{g_absent.text!r}")
        check("(2b) ...and identical to the POST siblings' 404 body, so the "
              "three endpoints cannot be told apart by their refusals",
              g_foreign.text == r_foreign.text,
              f"{g_foreign.text!r} vs {r_foreign.text!r}")

        sizing_route._sb = lambda: _OwnershipStub("transport")
        g_down = client_http.get(RUNS, params={"job_id": LIVE_JOB})
        check(f"(2c) {RUNS}: a transport failure -> 503, never 404 and never 200",
              g_down.status_code == 503, f"{g_down.status_code} {g_down.text[:80]}")
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


def _as_owner_of(job_id: str):
    """A caller whose company genuinely owns `job_id`, read from the database."""
    real_client = sizing_route._sb()
    if real_client is None:
        return None
    owner = (real_client.table("jobs").select("company_id")
             .eq("job_id", job_id).limit(1).execute())
    company_id = (owner.data or [{}])[0].get("company_id")
    if not company_id:
        return None
    main.app.dependency_overrides[auth.require_company] = lambda: auth.Caller(
        user_id="gate-runner", email="gate@example.com",
        company_id=company_id, role="owner")
    return company_id


def t6_runs_contract() -> None:
    """3.14 prompt 7 — the history read: LEAN, COUNTED, DETERMINISTIC, and an
    empty history is an empty list rather than a 404."""
    print("\nT6. the run history — lean, counted, ordered, and never a 404 "
          "for a job with no runs")
    company_id = _as_owner_of(HISTORY_JOB)
    if company_id is None:
        check("(6) the live job's owning company was read", False,
              "env not configured or job absent")
        return
    try:
        r = client_http.get(RUNS, params={"job_id": HISTORY_JOB})
        check("(6) authenticated owner + real job -> 200",
              r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        if r.status_code != 200:
            return
        body = r.json()
        runs = body.get("runs") or []
        total = body.get("total")
        print(f"        total={total} returned={body.get('returned')} "
              f"limit={body.get('limit')} offset={body.get('offset')} "
              f"truncated={body.get('truncated')}")
        check("(6) the envelope carries the job id, the page and the TOTAL",
              body.get("job_id") == HISTORY_JOB
              and isinstance(total, int) and isinstance(runs, list)
              and body.get("returned") == len(runs)
              and isinstance(body.get("truncated"), bool),
              str({k: v for k, v in body.items() if k != "runs"}))
        # 2U.2: the count is DERIVED here, not typed into this file.
        real_client = sizing_route._sb()
        actual = (real_client.table("sizing_results")
                  .select("sizing_result_id", count="exact")
                  .eq("job_id", HISTORY_JOB).limit(1).execute().count)
        check("(6) total == the number of rows the table actually holds for "
              "this job — counted here, never quoted",
              total == actual, f"endpoint {total} vs database {actual}")

        # ── (6a) THE LEAN GUARANTEE. Every heavy key, at every depth.
        blob = json.dumps(body)
        present = sorted(k for k in sizing_route.RUNS_FORBIDDEN_KEYS if f'"{k}"' in blob)
        print(f"        forbidden keys anywhere in the response: {present or 'none'}")
        check("(6a) the response carries NONE of the heavy keys — no evaluated "
              "options, no cost breakdown, no run assumptions",
              present == [], f"found {present}")
        if runs:
            keys = sorted(runs[0])
            print(f"        one run's fields ({len(keys)}): {keys}")
            check("(6a) every run carries the SAME field set — a summary with "
                  "a variable shape is one a reader cannot rely on",
                  all(sorted(x) == keys for x in runs), "")
            for field in ("sizing_result_id", "created_at", "run_kind",
                          "engine_mode", "objective_used", "dispatch_resolution",
                          "solar_kw", "system_cost", "has_chosen_marker",
                          "has_solar_curve", "payback_years", "npv_25_year",
                          "undiscounted_savings_25yr", "financial_result_id"):
                check(f"(6a) every run carries {field}",
                      all(field in x for x in runs), f"missing from some run")
            # F191: recorded-as-absent, not omitted.
            check("(6a) dispatch_resolution is PRESENT on every run, null on "
                  "those stored before it was recorded",
                  all("dispatch_resolution" in x for x in runs)
                  and any(x["dispatch_resolution"] is None for x in runs),
                  str(sorted({str(x["dispatch_resolution"]) for x in runs})))
            check("(6a) has_chosen_marker is a bool on every run, and this "
                  "job holds BOTH answers — the flag is not constant",
                  all(isinstance(x["has_chosen_marker"], bool) for x in runs)
                  and len({x["has_chosen_marker"] for x in runs}) == 2,
                  str(sorted({x["has_chosen_marker"] for x in runs})))
            check("(6a) has_solar_curve is a bool on every run, and this job "
                  "holds BOTH answers",
                  all(isinstance(x["has_solar_curve"], bool) for x in runs)
                  and len({x["has_solar_curve"] for x in runs}) == 2,
                  str(sorted({x["has_solar_curve"] for x in runs})))
            # A run with no financial row keeps the run and loses the figures.
            missing_fin = [x for x in runs if x["financial_result_id"] is None]
            print(f"        runs with no financial row: {len(missing_fin)} of {len(runs)}")
            check("(6a) a run whose financial row is missing still APPEARS, "
                  "with its figures null rather than borrowed or zeroed",
                  all(x["payback_years"] is None and x["npv_25_year"] is None
                      and x["undiscounted_savings_25yr"] is None
                      for x in missing_fin),
                  str([(x["sizing_result_id"], x["npv_25_year"]) for x in missing_fin][:3]))

        # ── (6b) THE COUNT IS HONEST: a page smaller than the history.
        small = client_http.get(RUNS, params={"job_id": HISTORY_JOB, "limit": 3})
        sb = small.json()
        print(f"        limit=3 -> returned={sb.get('returned')} total={sb.get('total')} "
              f"truncated={sb.get('truncated')}")
        check("(6b) with limit=3 the LIST is short but the TOTAL still says "
              "how many exist — the whole reason this endpoint exists",
              small.status_code == 200 and len(sb.get("runs") or []) == 3
              and sb.get("total") == actual and sb.get("returned") == 3
              and sb.get("truncated") is True and actual > 3,
              f"returned={sb.get('returned')} total={sb.get('total')} "
              f"truncated={sb.get('truncated')} actual={actual}")
        check("(6b) the full page reports truncated FALSE — a complete list "
              "and a bounded one are distinguishable both ways",
              body.get("truncated") is False and body.get("returned") == actual,
              f"{body.get('truncated')} / {body.get('returned')} vs {actual}")
        over = client_http.get(RUNS, params={"job_id": HISTORY_JOB, "limit": 10_000})
        check("(6b) limit is clamped to the stated maximum, never unbounded",
              over.status_code == 200
              and over.json().get("limit") == sizing_route.RUNS_PAGE_MAX,
              f"{over.json().get('limit')} vs max {sizing_route.RUNS_PAGE_MAX}")
        deflt = client_http.get(RUNS, params={"job_id": HISTORY_JOB, "limit": 0})
        check("(6b) a nonsense limit floors at 1 rather than returning nothing",
              deflt.status_code == 200 and deflt.json().get("limit") == 1,
              str(deflt.json().get("limit")))

        # ── (6c) ORDER. Newest first, and the page boundary does not drop or
        # duplicate a row — the property that a tie-break exists to protect.
        ids = [x["sizing_result_id"] for x in runs]
        stamps = [x["created_at"] for x in runs]
        check("(6c) newest first by created_at",
              stamps == sorted(stamps, reverse=True), str(stamps[:3]))
        page1 = client_http.get(RUNS, params={"job_id": HISTORY_JOB, "limit": 5, "offset": 0}).json()
        page2 = client_http.get(RUNS, params={"job_id": HISTORY_JOB, "limit": 5, "offset": 5}).json()
        paged = [x["sizing_result_id"] for x in page1["runs"] + page2["runs"]]
        check("(6c) two consecutive pages reproduce the single-page order "
              "exactly — no row dropped, none seen twice",
              paged == ids[:10] and len(set(paged)) == 10,
              f"{paged[:3]}... vs {ids[:3]}...")
    finally:
        _clear_overrides()


def t7_runs_tiebreak_and_empty() -> None:
    """(7a) 2U.2 — the tie is CONSTRUCTED, not hoped for: no two live runs
    share a created_at today, so a stub serves rows that do. (7b) a job with
    no runs is an empty list and a zero, never a 404."""
    print("\nT7. a constructed timestamp tie, and the empty history")
    _as_company_a()
    orig_sb = sizing_route._sb
    SHARED = "2026-08-22T01:00:00+00:00"
    tied_rows = [
        {"sizing_result_id": "aaaaaaaa-0000-4000-8000-000000000001",
         "created_at": SHARED, "run_kind": "solar", "financial_results": []},
        {"sizing_result_id": "cccccccc-0000-4000-8000-000000000003",
         "created_at": SHARED, "run_kind": "solar", "financial_results": []},
        {"sizing_result_id": "bbbbbbbb-0000-4000-8000-000000000002",
         "created_at": SHARED, "run_kind": "solar", "financial_results": []},
    ]

    class _RunsStub:
        """jobs -> owned by company-A; sizing_results -> the tied rows, with
        the ORDER the endpoint asked for actually applied, so the assertion
        tests the endpoint's ordering rather than the stub's."""

        def __init__(self, rows):
            self.rows, self.table_name, self.orders = rows, None, []

        def table(self, name):
            self.table_name = name
            self.orders = []
            return self

        def select(self, *_a, **_k):
            self.counting = _k.get("count") == "exact"
            return self

        def eq(self, *_a, **_k):
            return self

        def limit(self, *_a, **_k):
            return self

        def order(self, column, desc=False, **_k):
            self.orders.append((column, desc))
            return self

        def range(self, start, end):
            self.window = (start, end)
            return self

        def execute(self):
            if self.table_name == "jobs":
                return _Result([{"job_id": "j", "company_id": "company-A"}])
            rows = list(self.rows)
            for column, desc in reversed(self.orders):
                rows.sort(key=lambda r: str(r.get(column) or ""), reverse=bool(desc))
            start, end = getattr(self, "window", (0, len(rows) - 1))
            out = rows[start:end + 1]
            res = _Result(out)
            res.count = len(rows)
            return res

    try:
        stub = _RunsStub(tied_rows)
        sizing_route._sb = lambda: stub
        r = client_http.get(RUNS, params={"job_id": "j"})
        body = r.json()
        ids = [x["sizing_result_id"] for x in body.get("runs") or []]
        print(f"        three runs sharing {SHARED}")
        print(f"        order applied by the endpoint: {stub.orders}")
        print(f"        ids returned: {[i[:8] for i in ids]}")
        check("(7a) the endpoint asks for created_at DESC and then breaks the "
              "tie on sizing_result_id DESC — a timestamp alone is not a "
              "total order",
              stub.orders == [("created_at", True), ("sizing_result_id", True)],
              str(stub.orders))
        check("(7a) three runs sharing one timestamp come back in a "
              "DETERMINISTIC order (the id, descending)",
              ids == sorted(ids, reverse=True) and len(ids) == 3,
              str(ids))
        again = client_http.get(RUNS, params={"job_id": "j"}).json()
        check("(7a) ...and the same order on a second identical request",
              [x["sizing_result_id"] for x in again["runs"]] == ids, "")

        # (7b) the empty history.
        empty = _RunsStub([])
        sizing_route._sb = lambda: empty
        r_empty = client_http.get(RUNS, params={"job_id": "j"})
        eb = r_empty.json()
        print(f"        empty history -> {r_empty.status_code} {json.dumps(eb)}")
        check("(7b) a job with NO runs -> 200 with an empty list and a total "
              "of zero, NEVER a 404 (the job exists; its history is empty, "
              "and those are different facts)",
              r_empty.status_code == 200 and eb.get("runs") == []
              and eb.get("total") == 0 and eb.get("returned") == 0
              and eb.get("truncated") is False,
              f"{r_empty.status_code} {eb}")
    finally:
        sizing_route._sb = orig_sb
        _clear_overrides()


def main_() -> int:
    print("verify_sizing_auth.py — 3.11 prompt 1b (TestClient, writes nothing)\n")
    t1_auth_layer()
    t2_ownership()
    t3_t5_happy_and_identity()
    t4_ordering()
    t6_runs_contract()
    t7_runs_tiebreak_and_empty()
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
