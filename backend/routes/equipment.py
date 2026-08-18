"""
GET /api/equipment (3.10) — the catalogue a company is allowed to see.

AUTHENTICATED FROM ITS FIRST LINE: this is a brand-new endpoint, so there is no
backwards-compatibility argument for leaving it open, and 9.3b should find
nothing to do here. Caller identity comes from require_company (the validated
token plus the server-side company_members lookup) — never from the request.

THE SCOPING RULE, and it is the security boundary of this endpoint: a row is
returned when origin = 'catalogue' OR owner_company_id = the caller's company.
The service role BYPASSES RLS, so the 1.6 read policies give this query no
protection at all — the filter is enforced IN THE QUERY, in code, the same rule
every company-scoped endpoint in this codebase follows.

THE COLUMN CONSTANTS ARE THE ACCURACY CONTRACT. Every column the ENGINE reads
to drive a number is present (battery_optimiser.battery_specs,
roof_geometry._panel_from_row, cost_model's fetches — verified by RUNNING those
readers in verify_equipment_contract.py, not by reading them), so the screen at
prompt 3 shows the same numbers the engine used. The extra fields (series,
chemistry, coupling, …, origin, verified) are identification and the
transparency half of PLATFORM_SPEC §7 — origin/verified let the screen mark a
user-defined unit as unverified rather than passing it off as catalogue.

TOTAL, NEVER RAISES: a missing client or a failed query yields [] lists plus
one "equipment_catalogue_unavailable" flag, HTTP 200. A NULL spec is returned
as null — never 0, never omitted, never defaulted; the engine has its own
documented defaults and flags them itself.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter, Depends

from auth import Caller, require_company

logger = logging.getLogger(__name__)

router = APIRouter()

# Load-bearing names: verify_equipment_contract.py imports all three and
# asserts the engine's observed reads are subsets.
PANEL_COLUMNS: tuple[str, ...] = (
    "id", "brand", "model", "series", "cell_technology", "rated_power_w",
    "module_efficiency_pct", "length_mm", "width_mm", "cost_aud",
    "origin", "verified",
)
INVERTER_COLUMNS: tuple[str, ...] = (
    "id", "brand", "model", "series", "inverter_type", "phases",
    "battery_ready", "rated_ac_power_kw", "max_efficiency_pct", "cost_aud",
    "origin", "verified",
)
BATTERY_COLUMNS: tuple[str, ...] = (
    "id", "brand", "model", "series", "chemistry", "coupling",
    "nominal_capacity_kwh", "usable_capacity_kwh", "depth_of_discharge_pct",
    "round_trip_efficiency_pct", "max_continuous_charge_kw",
    "max_continuous_discharge_kw", "warranty_cycles", "warranty_years",
    "cost_aud", "origin", "verified",
)

_SVC: Any = None
_SVC_READY = False


def _svc() -> Any:
    """Service-role client (bypasses RLS — which is exactly why the query below
    scopes by origin/owner_company_id in code). Service-role ONLY, no anon
    fallback, matching routes/job.py; never raises at import or call."""
    global _SVC, _SVC_READY
    if _SVC_READY:
        return _SVC
    _SVC_READY = True
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("equipment: SUPABASE_SERVICE_ROLE_KEY missing — catalogue will read unavailable.")
        _SVC = None
        return None
    try:
        from supabase import create_client

        _SVC = create_client(url, key)
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        _SVC = None
    return _SVC


def _visible_rows(
    client: Any,
    table: str,
    columns: tuple[str, ...],
    company_id: str,
    flags: list[str],
) -> list[dict]:
    """One kind's visible rows, sorted (brand, model, id) for a stable order —
    an unsorted list makes a UI diff unreadable and a test flaky for nothing.
    [] plus ONE shared flag on any failure; never raises, never a partial row."""
    if client is None:
        if "equipment_catalogue_unavailable" not in flags:
            flags.append("equipment_catalogue_unavailable")
        return []
    try:
        res = (
            client.table(table)
            .select(",".join(columns))
            .eq("status", "active")
            # The security boundary, enforced in the query because the service
            # role bypasses RLS. company_id comes from the server-side
            # membership lookup, NEVER from the request.
            .or_(f"origin.eq.catalogue,owner_company_id.eq.{company_id}")
            .execute()
        )
        rows = [r for r in (res.data or []) if isinstance(r, dict)]
        # The key is present with value null when the spec is NULL — report
        # what is stored, exactly.
        shaped = [{col: row.get(col) for col in columns} for row in rows]
        shaped.sort(key=lambda r: (str(r.get("brand") or ""), str(r.get("model") or ""), str(r.get("id") or "")))
        return shaped
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        if "equipment_catalogue_unavailable" not in flags:
            flags.append("equipment_catalogue_unavailable")
        return []


@router.get("/api/equipment")
async def list_equipment(caller: Caller = Depends(require_company)) -> dict:
    """The catalogue this company may see: curated rows plus its own
    user-defined rows, never another company's. See the module docstring."""
    flags: list[str] = []
    client = _svc()
    return {
        "panels": _visible_rows(client, "panels", PANEL_COLUMNS, caller.company_id, flags),
        "inverters": _visible_rows(client, "inverters", INVERTER_COLUMNS, caller.company_id, flags),
        "batteries": _visible_rows(client, "batteries", BATTERY_COLUMNS, caller.company_id, flags),
        "flags": flags,
    }
