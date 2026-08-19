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


# ═════════════════════════════════════════════════════════════════════════════
# POST /api/equipment/{kind} (3.10 prompt 2) — the "Other / New" write path.
#
# THE ONE IDEA: the LP does not read a battery row — it reads
# battery_optimiser.battery_specs(row, flags), and that function is the ENTIRE
# interface between a stored row and the optimiser. So this endpoint validates
# by CALLING IT (and roof_geometry._panel_from_row for panels) rather than
# re-implementing either rule set: a second copy of the battery defaults is the
# two-places-that-must-agree problem, avoidable entirely here. A unit the
# reader returns None for is REFUSED — a row the engine cannot use is a control
# that stores a choice and changes no number (D29); for panels it is worse,
# because _panel_from_row's caller silently substitutes the DEFAULT catalogue
# panel — a wrong roof with no error.
# ═════════════════════════════════════════════════════════════════════════════

from typing import Literal, Optional  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from pydantic import BaseModel, Field, field_validator  # noqa: E402

# The POST's accepted kinds and the GET response's equipment keys are ONE set,
# defined once, so the two can never drift apart (the gate asserts equality
# with the GET's actual response keys in both directions).
EQUIPMENT_KINDS: tuple[str, ...] = ("panels", "inverters", "batteries")


class _EquipmentIn(BaseModel):
    """Common base. Unknown keys are DROPPED SILENTLY by pydantic — that is the
    security boundary for the server-fixed fields (origin, owner_company_id,
    verified, status, promoted_from, id, created_at), exactly the JobSitePatch
    whitelist mechanism: they are simply not declared here, so a payload
    smuggling them is accepted without error and they are ignored."""

    brand: str = Field(max_length=200)
    model: str = Field(max_length=200)
    series: Optional[str] = Field(default=None, max_length=200)
    cost_aud: Optional[float] = Field(default=None, gt=0, le=1000000)

    @field_validator("brand", "model")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        # A model called " " would satisfy max_length and destroy every
        # duplicate check downstream — trimmed, and non-empty after trimming.
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("series")
    @classmethod
    def _trim_series(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


class PanelIn(_EquipmentIn):
    # Mandatory because the DATABASE requires it (is_nullable NO).
    rated_power_w: int = Field(gt=0, le=1000)
    # length_mm / width_mm are ENGINE-mandatory, but deliberately Optional
    # here: the refusal comes from RUNNING _panel_from_row (which returns None
    # without them), not from a pydantic re-statement of its rule.
    length_mm: Optional[float] = Field(default=None, gt=0, le=5000)
    width_mm: Optional[float] = Field(default=None, gt=0, le=5000)
    cell_technology: Optional[
        Literal["mono_perc", "n_type_topcon", "hjt", "ibc", "hpbc", "abc"]
    ] = None
    module_efficiency_pct: Optional[float] = Field(default=None, gt=0, le=100)


class InverterIn(_EquipmentIn):
    # All three DATABASE-mandatory. There is deliberately NOTHING
    # engine-mandatory beyond them: cost_model excludes an unpriced inverter
    # from the total with an explicit flag rather than treating it as $0, and
    # sizing still runs — making cost mandatory would be a rule this codebase
    # does not have.
    inverter_type: Literal["string", "hybrid", "microinverter"]
    phases: Literal["single", "three"]
    rated_ac_power_kw: float = Field(gt=0, le=1000)
    battery_ready: Optional[bool] = None
    max_efficiency_pct: Optional[float] = Field(default=None, gt=0, le=100)


class BatteryIn(_EquipmentIn):
    # usable_capacity_kwh is DATABASE-mandatory (and the engine skips the unit
    # without it too). cost_aud is ENGINE-mandatory — battery_specs returns
    # None when it is missing ("price cannot be assumed 0") — and the refusal
    # comes from running battery_specs, not from re-stating its rule here.
    usable_capacity_kwh: float = Field(gt=0, le=1000)
    nominal_capacity_kwh: Optional[float] = Field(default=None, gt=0, le=1000)
    chemistry: Optional[Literal["lfp", "nmc"]] = None
    coupling: Optional[Literal["ac", "dc", "hybrid_paired", "all_in_one"]] = None
    depth_of_discharge_pct: Optional[float] = Field(default=None, gt=0, le=100)
    round_trip_efficiency_pct: Optional[float] = Field(default=None, gt=0, le=100)
    max_continuous_charge_kw: Optional[float] = Field(default=None, gt=0, le=1000)
    max_continuous_discharge_kw: Optional[float] = Field(default=None, gt=0, le=1000)
    warranty_cycles: Optional[int] = Field(default=None, ge=1, le=100000)
    warranty_years: Optional[int] = Field(default=None, ge=1, le=50)


_BODY_MODELS: dict[str, type[_EquipmentIn]] = {
    "panels": PanelIn,
    "inverters": InverterIn,
    "batteries": BatteryIn,
}

_KIND_COLUMNS: dict[str, tuple[str, ...]] = {
    "panels": PANEL_COLUMNS,
    "inverters": INVERTER_COLUMNS,
    "batteries": BATTERY_COLUMNS,
}

# The engine-driving specs compared for duplicates: the *_COLUMNS minus
# identification and provenance.
_NON_SPEC_FIELDS = frozenset({"id", "brand", "model", "series", "origin", "verified"})


def _engine_validate(kind: str, row: dict) -> list[str]:
    """RUN the engine's own reader over the row exactly as it will be stored.

    Raises HTTPException 422 when the reader returns None (the LP would skip a
    battery entirely; a panel would silently become the DEFAULT catalogue panel
    — a wrong roof with no error). Returns the reader's flag list VERBATIM as
    engine_assumptions.

    The imports are LOCAL, deliberately: battery_optimiser imports pulp at
    module scope, and a module-level import here would let a broken or missing
    pulp take down this whole router INCLUDING the GET that prompt 1 shipped
    and prompt 3 depends on. Local imports limit the blast radius to this POST.
    """
    if kind == "batteries":
        try:
            import battery_optimiser  # noqa: PLC0415 — see docstring

            flags: list[str] = []
            specs = battery_optimiser.battery_specs(dict(row), flags)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — reader crashed: readability unknown
            sentry_sdk.capture_exception(exc)
            raise HTTPException(
                status_code=422,
                detail="This battery could not be checked against the sizing engine — nothing was saved.",
            ) from exc
        if specs is None:
            raise HTTPException(
                status_code=422,
                detail="The sizing engine cannot use this battery: "
                + ("; ".join(flags) if flags else "usable capacity or price is missing.")
                + " Nothing was saved.",
            )
        return flags
    if kind == "panels":
        try:
            import roof_geometry  # noqa: PLC0415 — symmetry with the battery path

            panel = roof_geometry._panel_from_row(dict(row))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            sentry_sdk.capture_exception(exc)
            raise HTTPException(
                status_code=422,
                detail="This panel could not be checked against the roof model — nothing was saved.",
            ) from exc
        if panel is None:
            raise HTTPException(
                status_code=422,
                detail="The roof model cannot use this panel: rated power, length and "
                "width must all be present, or every roof would silently fall back "
                "to the default catalogue panel. Nothing was saved.",
            )
        return []
    # inverters: no engine reader exists beyond cost_model's price lookup,
    # which is exercised by the caller-supplied id at sizing time. An empty
    # list with this stated reason is honest; a fabricated check would not be.
    return []


def _dup_num(value) -> Optional[float]:
    """A finite number or None — PostgREST returns numerics as STRINGS, so a
    raw comparison of 12.8 against \"12.8\" would report a difference on every
    field of every duplicate."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        try:
            f = float(value)
        except ValueError:
            return None
    else:
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _values_differ(existing, submitted) -> bool:
    """Coerced comparison. Null-on-both-sides is NOT a difference; numerics
    compare within a tolerance; everything else compares as-is."""
    if existing is None and submitted is None:
        return False
    a, b = _dup_num(existing), _dup_num(submitted)
    if a is not None and b is not None:
        return abs(a - b) > 1e-6
    return existing != submitted


def _find_duplicates(
    client, kind: str, row: dict, company_id: str, own_id: Optional[str], flags: list[str]
) -> list[dict]:
    """Visible rows (the SAME scoping expression the GET uses — never another
    company's) whose brand AND model match case-insensitively after trimming.

    DELIBERATE MISMATCH, not a bug: the database constraint is CASE-SENSITIVE
    ("sungrow SBR128" and "Sungrow SBR128" are two rows it accepts), while this
    comparison is case-INSENSITIVE and flags them as duplicates of each other.
    The comparison should catch MORE than the constraint refuses, never less.

    A failed scan appends "duplicate_check_unavailable" and returns [] — and an
    empty list PLUS that flag is NOT the same fact as an empty list alone;
    prompt 3 must not render them identically.
    """
    try:
        res = (
            client.table(kind)
            .select(",".join(_KIND_COLUMNS[kind]))
            .eq("status", "active")
            .or_(f"origin.eq.catalogue,owner_company_id.eq.{company_id}")
            .execute()
        )
        want_brand = str(row.get("brand", "")).strip().casefold()
        want_model = str(row.get("model", "")).strip().casefold()
        out: list[dict] = []
        for existing in res.data or []:
            if not isinstance(existing, dict):
                continue
            if existing.get("id") == own_id:
                continue  # the row just saved is not its own duplicate
            if (str(existing.get("brand", "")).strip().casefold() != want_brand
                    or str(existing.get("model", "")).strip().casefold() != want_model):
                continue
            differences = []
            for field in _KIND_COLUMNS[kind]:
                if field in _NON_SPEC_FIELDS:
                    continue
                if _values_differ(existing.get(field), row.get(field)):
                    differences.append({
                        "field": field,
                        "existing": existing.get(field),
                        "submitted": row.get(field),
                    })
            # A match with ZERO differences is still returned: "you already
            # have this exact unit" is a different message from "you have it
            # with different numbers".
            out.append({
                "id": existing.get("id"),
                "origin": existing.get("origin"),
                "brand": existing.get("brand"),
                "model": existing.get("model"),
                "series": existing.get("series"),
                "differences": differences,
            })
        return out
    except Exception as exc:  # noqa: BLE001
        sentry_sdk.capture_exception(exc)
        if "duplicate_check_unavailable" not in flags:
            flags.append("duplicate_check_unavailable")
        return []


@router.post("/api/equipment/{kind}")
async def create_equipment(
    kind: str,
    body: dict,
    caller: Caller = Depends(require_company),
) -> dict:
    """Save a private, unverified unit — validated by RUNNING the engine's own
    readers. The save is NEVER blocked by a duplicate (D24/D5: this codebase
    does not put walls in front of installers — a notice naming the differing
    numbers respects them more than a refusal, and they may well be right and
    the catalogue wrong); it saves and returns the comparison."""
    # An unknown kind is not a bad body — it is a path that does not exist.
    if kind not in EQUIPMENT_KINDS:
        raise HTTPException(status_code=404, detail="Unknown equipment kind")

    try:
        parsed = _BODY_MODELS[kind].model_validate(body if isinstance(body, dict) else {})
    except HTTPException:
        raise
    except Exception as exc:  # pydantic ValidationError — name the fields
        errors = getattr(exc, "errors", None)
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e.get('loc', []))}: {e.get('msg', '')}"
            for e in (errors() if callable(errors) else [])
        ) or "invalid body"
        raise HTTPException(status_code=422, detail=detail) from exc

    row = parsed.model_dump(exclude_none=True)

    # VALIDATION BY RUNNING THE ENGINE — before any insert. 422 refusals leave
    # the database untouched.
    engine_assumptions = _engine_validate(kind, row)

    # FIXED SERVER-SIDE, NEVER FROM THE REQUEST — pydantic already dropped any
    # smuggled copy of these silently; they are stamped here from the validated
    # caller and from nothing else.
    row["origin"] = "user_defined"
    row["owner_company_id"] = caller.company_id
    row["verified"] = False
    row["status"] = "active"
    row["promoted_from"] = None

    client = _svc()
    if client is None:
        # NOT a 200 with a fabricated id — a write endpoint that reports a
        # success it cannot demonstrate is the 3.6 failure mode.
        raise HTTPException(status_code=503, detail="The catalogue is briefly unavailable — nothing was saved. Try again.")

    try:
        res = client.table(kind).insert(row).execute()
        stored = (res.data or [None])[0]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # 23505 SPECIFICALLY: after the per-owner migration the only row this
        # caller can collide with is their own, so the message is safe to say.
        # Anything else stays a 500 — a save surfaces failure rather than
        # inventing a plausible explanation.
        if getattr(exc, "code", None) == "23505":
            raise HTTPException(
                status_code=409,
                detail="You have already added this unit — same brand, model and series. Edit the existing one instead of adding it again.",
            ) from exc
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=500, detail="The unit could not be saved.") from exc

    if not isinstance(stored, dict) or not stored.get("id"):
        # The insert reported success but returned nothing provable — report
        # failure rather than guessing the row.
        raise HTTPException(status_code=500, detail="The save could not be confirmed — check the catalogue before re-adding.")

    flags: list[str] = []
    duplicates = _find_duplicates(client, kind, row, caller.company_id, stored.get("id"), flags)

    return {
        "id": stored.get("id"),
        "kind": kind,
        "origin": "user_defined",
        "verified": False,
        # The engine's own flag list VERBATIM — never a re-worded copy. This is
        # the "every spec listed in assumptions" half of the 3.10 row's test,
        # enforced at the moment of entry.
        "engine_assumptions": engine_assumptions,
        "duplicates": duplicates,
        "flags": flags,
    }
