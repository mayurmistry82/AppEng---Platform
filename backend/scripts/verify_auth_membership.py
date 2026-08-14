#!/usr/bin/env python3
"""
verify_auth_membership.py — proves auth.py tells "no company" apart from
"could not check", and fails closed when it cannot check.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_auth_membership.py

Use the interpreter the BACKEND runs under, not whatever `python3` resolves to
on PATH — auth.py imports dotenv/fastapi/supabase, and the system python3 on
this machine has none of them (it fails at `import dotenv`, before any check
runs). The backend is launched as `/opt/anaconda3/bin/uvicorn main:app`.

Exits 0 when every check passes, non-zero with the failing check named.

There is no pytest in this repo, so this is a plain script in the same spirit
as the frontend's verify-* scripts: no framework, real assertions, honest exit
code.

NO NETWORK, NO DATABASE. The seam is `auth._clients_ready`: `_lookup_company`
calls `_build_clients()` first, and that function returns immediately when
`_clients_ready` is True. Setting the flag True and assigning a stub to
`auth._service_client` therefore prevents the real Supabase client from ever
being constructed — `create_client` is imported INSIDE `_build_clients`, so it
is never even reached. Importing auth is itself inert: it only calls
`load_dotenv()`, which reads a file.

Covers the regression observed live on 2026-08-14: a transient
`company_members` lookup failure surfaced to a valid company member as
403 "Forbidden", and the token cache then held that wrong answer for the rest
of the 60s TTL.
"""
from __future__ import annotations

import os
import sys
import traceback

# backend/ on the path — the app's modules import each other flat (`import auth`),
# matching how uvicorn is launched from backend/.
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
from fastapi import HTTPException  # noqa: E402

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


# ── Stubs ─────────────────────────────────────────────────────────────────────
class RaisingClient:
    """A service client whose query blows up — the transient-failure case."""

    def table(self, *_args, **_kwargs):
        raise OSError(35, "Resource temporarily unavailable")


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Chainable no-op query that yields a fixed row set."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return _Result(self._rows)


class RowsClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, *_a, **_k):
        return _Query(self._rows)


def install(service_client) -> None:
    """
    Put a stub in place of the service-role client and make sure the real one is
    never rebuilt over it. Also clears the token cache so each check starts cold.
    """
    with auth._cache_lock:
        auth._cache.clear()
    auth._service_client = service_client
    auth._auth_client = None
    auth._clients_ready = True  # the seam: _build_clients() now early-returns


class FakeRequest:
    """Only `.headers.get` is ever touched by require_caller."""

    def __init__(self, headers: dict):
        self.headers = headers


def main() -> int:
    print("verify_auth_membership.py — auth.py membership-lookup contract\n")

    # 1. A raising lookup must 503, not report "no company".
    print("1. transient lookup failure -> 503")
    install(RaisingClient())
    raised: HTTPException | None = None
    returned = None
    try:
        returned = auth._lookup_company("user-1")
    except HTTPException as exc:
        raised = exc
    check(
        "raises HTTPException",
        raised is not None,
        f"returned {returned!r} instead of raising",
    )
    check("status is 503", raised is not None and raised.status_code == 503,
          f"status {getattr(raised, 'status_code', None)}")
    check(
        "detail is distinguishable from the auth-service 503",
        raised is not None and raised.detail != auth._503.detail,
        f"detail {getattr(raised, 'detail', None)!r} collides with the auth 503",
    )
    check(
        "detail leaks neither the exception text nor the user id",
        raised is not None
        and "Errno" not in str(raised.detail)
        and "user-1" not in str(raised.detail),
        f"detail {getattr(raised, 'detail', None)!r}",
    )

    # 2. Zero rows is a real answer: the user genuinely has no company.
    print("\n2. query succeeds with zero rows -> (None, None)")
    install(RowsClient([]))
    try:
        result = auth._lookup_company("user-2")
        check("returns (None, None)", result == (None, None), f"got {result!r}")
    except HTTPException as exc:
        check("does not raise", False, f"raised {exc.status_code} {exc.detail!r}")

    # 3. One row is returned faithfully.
    print("\n3. query succeeds with one row -> (company_id, role)")
    install(RowsClient([{"company_id": "co-123", "role": "owner", "created_at": "2026-01-01"}]))
    try:
        result = auth._lookup_company("user-3")
        check("returns the row", result == ("co-123", "owner"), f"got {result!r}")
    except HTTPException as exc:
        check("does not raise", False, f"raised {exc.status_code} {exc.detail!r}")

    # 4. The pre-existing missing-service-key path is unbroken.
    print("\n4. service client absent -> 503 (pre-existing path)")
    install(None)
    raised = None
    try:
        auth._lookup_company("user-4")
    except HTTPException as exc:
        raised = exc
    check("raises 503", raised is not None and raised.status_code == 503,
          f"got {getattr(raised, 'status_code', None)}")

    # 5. FAIL CLOSED — a failed lookup must never yield a company-bearing Caller.
    print("\n5. fail-closed: no Caller survives a failed lookup")
    install(RaisingClient())
    original_validate = auth._validate_token
    auth._validate_token = lambda _token: {"user_id": "user-5", "email": "u@example.com"}
    try:
        request = FakeRequest({"Authorization": "Bearer token-5"})
        caller = None
        raised = None
        try:
            caller = auth.require_caller(request)
        except HTTPException as exc:
            raised = exc
        check(
            "require_caller raises rather than returning a Caller",
            caller is None and raised is not None,
            f"returned {caller!r}",
        )
        check("it raises 503, not 403", raised is not None and raised.status_code == 503,
              f"status {getattr(raised, 'status_code', None)}")
        # The direction that must never happen: a Caller that passes require_company.
        survived_to_company = False
        if caller is not None:
            try:
                auth.require_company(caller)
                survived_to_company = True
            except HTTPException:
                survived_to_company = False
        check("no Caller reaches require_company", not survived_to_company,
              "a failed lookup produced a company-bearing Caller — FAIL OPEN")

        # 6. Nothing was cached for that token.
        print("\n6. the failed lookup is not cached")
        with auth._cache_lock:
            cached_keys = list(auth._cache.keys())
        check("token absent from the cache", "token-5" not in cached_keys,
              f"cache holds {cached_keys!r}")
        check("cache is empty", len(cached_keys) == 0, f"cache holds {cached_keys!r}")
        check("_cache_get returns nothing for it", auth._cache_get("token-5") is None)

        # And the legitimate company-less user still authenticates (unchanged
        # behaviour): require_caller succeeds, require_company answers 403.
        print("\n   (bonus) a genuinely company-less user still authenticates")
        install(RowsClient([]))
        auth._validate_token = lambda _token: {"user_id": "user-6", "email": "u6@example.com"}
        legit = auth.require_caller(FakeRequest({"Authorization": "Bearer token-6"}))
        check("require_caller returns a Caller", legit is not None and legit.company_id is None)
        denied = None
        try:
            auth.require_company(legit)
        except HTTPException as exc:
            denied = exc
        check("require_company answers 403", denied is not None and denied.status_code == 403,
              f"got {getattr(denied, 'status_code', None)}")
    finally:
        auth._validate_token = original_validate
        install(None)
        with auth._cache_lock:
            auth._cache.clear()

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
