"""
backend/auth.py — the security boundary for every future endpoint.

Verifies the caller's Supabase JWT REMOTELY (``client.auth.get_user(<jwt>)``, which hits
Supabase's ``/auth/v1/user`` — the token's signature is checked by Supabase itself, never
by hand-rolled JWT code in this repo), resolves the caller's company membership
server-side with the service-role client, and exposes the result as FastAPI dependencies:

    Caller           — the ONLY sanctioned source of identity for any endpoint
    require_caller   — 401 unless a valid `Authorization: Bearer <token>` is presented
    require_company  — 403 on top of that when the caller belongs to no company
    require_owner    — 403 on top of that unless the caller's role is 'owner'

Identity is NEVER read from the request body or query string. A payload may claim any
installer_id / company_id it likes — those are assertions, not identities, and nothing in
this module looks at them. The trusted sources are exactly two: the validated token, and
the company_members lookup performed here with the service-role key (so RLS cannot skew it).

FAIL-CLOSED CONTRACT:
  * Invalid / expired / forged / malformed token  -> 401 ("Not authenticated" — the body
    never distinguishes forged from expired; the distinction is logged server-side only).
  * Supabase auth service unreachable             -> 503. Failing OPEN — returning a
    Caller without a verified token — is the one outcome that is never acceptable here.
  * company_members lookup fails                  -> Caller with company_id=None. Never
    guess a company, never fall back to "the only company in the table".
  * No unhandled exceptions escape: every failure becomes a 401 or 503, never a 500.

ACCEPTED TRADE-OFF — token cache: validated tokens are cached in-process for
CACHE_TTL_SECONDS (default 60s, keyed on the raw token, capped at CACHE_MAX_ENTRIES with
oldest-first eviction) so a debounced UI does not cost one auth round-trip per keystroke.
A token revoked mid-TTL therefore stays usable here for up to 60 seconds. That window is
deliberate and bounded; lower CACHE_TTL_SECONDS if it ever matters.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

load_dotenv()

logger = logging.getLogger("enrgengine.auth")

CACHE_TTL_SECONDS = 60.0
CACHE_MAX_ENTRIES = 1000

_401 = HTTPException(
    status_code=401, detail="Not authenticated", headers={"WWW-Authenticate": "Bearer"}
)
_503 = HTTPException(status_code=503, detail="Authentication service unavailable")


class Caller(BaseModel):
    """Verified identity. user_id/email come from the validated token; company_id/role
    from the server-side company_members lookup. Nothing here originates in the request
    payload."""

    user_id: str
    email: Optional[str] = None
    company_id: Optional[str] = None
    role: Optional[str] = None


# ── Supabase clients (lazy, cached; never raise at import time) ───────────────
_lock = threading.Lock()
_auth_client: Any = None       # anon-key client — used only to validate tokens remotely
_service_client: Any = None    # service-role client — company_members lookup (bypasses RLS)
_clients_ready = False


def _build_clients() -> None:
    global _auth_client, _service_client, _clients_ready
    if _clients_ready:
        return
    with _lock:
        if _clients_ready:
            return
        url = os.getenv("SUPABASE_URL")
        anon = os.getenv("SUPABASE_ANON_KEY")
        service = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        try:
            from supabase import create_client

            if url and anon:
                _auth_client = create_client(url, anon)
            # The service client is service-role ONLY — no anon fallback. An anon-key
            # "service" client would have the company_members lookup silently return
            # nothing (RLS + no grant), making every caller company-less and 403-ing
            # everyone with no obvious cause. A security boundary must not degrade
            # quietly: without the key there is no service client, and requests fail 503.
            if url and service:
                _service_client = create_client(url, service)
            elif url:
                logger.error(
                    "auth: SUPABASE_SERVICE_ROLE_KEY is not set — company lookups are "
                    "impossible. Refusing to fall back to the anon key; requests that "
                    "need identity will fail 503 until the key is configured."
                )
        except Exception as exc:  # noqa: BLE001 — missing config surfaces as 503 per-request
            logger.error("auth: failed to initialise Supabase clients: %s", exc)
        _clients_ready = True


def reset_clients() -> None:
    """Test/ops hook — drop cached clients (and the token cache) so env is re-read."""
    global _auth_client, _service_client, _clients_ready
    with _lock:
        _auth_client = None
        _service_client = None
        _clients_ready = False
    with _cache_lock:
        _cache.clear()


# ── Token validation (remote — Supabase checks the signature, not us) ─────────
def _validate_token(token: str) -> Optional[dict]:
    """
    Ask Supabase whether this token is valid. Returns {"user_id","email"} on success.
    Raises the module's HTTPExceptions on failure:
      401 — Supabase rejected the token (forged/expired/garbage). Detail logged, not returned.
      503 — Supabase unreachable / not configured. FAIL CLOSED: without a verdict from
            Supabase there is no identity, so there must be no Caller. Never fail open.
    """
    _build_clients()
    if _auth_client is None:
        logger.error("auth: SUPABASE_URL / SUPABASE_ANON_KEY not configured — failing closed (503).")
        raise _503

    try:
        resp = _auth_client.auth.get_user(token)
    except Exception as exc:  # noqa: BLE001 — classified below, never re-raised raw
        try:
            from supabase_auth.errors import AuthError, AuthRetryableError

            if isinstance(exc, AuthRetryableError):
                # Transient upstream failure — no verdict, so no identity: 503, never 200.
                logger.warning("auth: Supabase auth transient failure: %s", exc)
                raise _503 from None
            if isinstance(exc, AuthError):
                # Supabase examined the token and said no (forged, expired, malformed…).
                logger.info("auth: token rejected by Supabase: %s", getattr(exc, "message", exc))
                raise _401 from None
        except ImportError:  # pragma: no cover — package always ships with supabase
            pass
        # Unclassified (network layer, DNS, timeout…): no verdict -> fail closed.
        logger.warning("auth: token validation failed without a verdict: %s", exc)
        raise _503 from None

    user = getattr(resp, "user", None)
    uid = getattr(user, "id", None)
    if not uid:
        logger.info("auth: get_user returned no user for presented token.")
        raise _401
    return {"user_id": str(uid), "email": getattr(user, "email", None)}


# ── Company membership lookup (service role — RLS must not affect this) ───────
def _lookup_company(user_id: str) -> tuple[Optional[str], Optional[str]]:
    """
    (company_id, role) for this user, or (None, None) if there is no membership or a
    TRANSIENT lookup failure. Never guesses, never falls back to "the only company in
    the table". Deterministic when a user someday has multiple memberships: earliest
    joined wins.

    MISCONFIGURATION IS NOT "NO COMPANY": when the service client is absent (no
    SUPABASE_SERVICE_ROLE_KEY), membership is unknowable for every caller — silently
    treating that as company-less would 403 everyone with no visible cause. Fail 503.
    """
    _build_clients()
    if _service_client is None:
        logger.error(
            "auth: no service-role client (SUPABASE_SERVICE_ROLE_KEY missing) — "
            "cannot resolve company membership; failing 503, not company-less."
        )
        raise _503
    try:
        res = (
            _service_client.table("company_members")
            .select("company_id, role, created_at")
            .eq("user_id", user_id)
            .order("created_at")
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        if not rows:
            return None, None
        return rows[0].get("company_id"), rows[0].get("role")
    except Exception as exc:  # noqa: BLE001 — membership failure must not block identity
        logger.warning("auth: company_members lookup failed for %s: %s", user_id, exc)
        return None, None


# ── Short-TTL token -> Caller cache ───────────────────────────────────────────
# Keyed on the RAW TOKEN (never user_id — two tokens for one user are two entries, and a
# forged token can never collide into a real user's entry). Bounded: oldest evicted first.
_cache: "OrderedDict[str, tuple[float, Caller]]" = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(token: str) -> Optional[Caller]:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(token)
        if hit is None:
            return None
        expires, caller = hit
        if now >= expires:
            _cache.pop(token, None)
            return None
        return caller


def _cache_put(token: str, caller: Caller) -> None:
    with _cache_lock:
        _cache[token] = (time.monotonic() + CACHE_TTL_SECONDS, caller)
        _cache.move_to_end(token)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)


# ── Dependencies ──────────────────────────────────────────────────────────────
def require_caller(request: Request) -> Caller:
    """
    FastAPI dependency: authenticate the request or raise.

    Reads ONLY the Authorization header (exact form `Bearer <token>`). The request body
    and query string are never consulted — a payload claiming someone else's user_id or
    company_id changes nothing.
    """
    header = request.headers.get("Authorization") or request.headers.get("authorization")
    if not header:
        raise _401
    parts = header.split()
    if len(parts) != 2 or parts[0] != "Bearer" or not parts[1]:
        raise _401
    token = parts[1]

    cached = _cache_get(token)
    if cached is not None:
        return cached

    identity = _validate_token(token)          # 401/503 on any failure — never None here
    company_id, role = _lookup_company(identity["user_id"])
    caller = Caller(
        user_id=identity["user_id"],
        email=identity["email"],
        company_id=company_id,
        role=role,
    )
    _cache_put(token, caller)
    return caller


def require_company(caller: Caller = Depends(require_caller)) -> Caller:
    """Dependency for endpoints that operate on jobs: authenticated AND in a company."""
    if caller.company_id is None:
        raise HTTPException(status_code=403, detail="No company membership")
    return caller


def require_owner(caller: Caller = Depends(require_company)) -> Caller:
    """Dependency for team-management endpoints: company owner only."""
    if caller.role != "owner":
        raise HTTPException(status_code=403, detail="Owner role required")
    return caller


# ── Proof-of-life endpoint ────────────────────────────────────────────────────
router = APIRouter()


@router.get("/api/auth/me")
async def auth_me(caller: Caller = Depends(require_caller)):
    """Return the verified caller. Exists so the dependency is provably exercised."""
    return caller.model_dump()


__all__ = [
    "Caller",
    "require_caller",
    "require_company",
    "require_owner",
    "router",
    "reset_clients",
]
