"""
NEM reference data — DNSP export limits and feed-in-tariff (FiT) defaults.

Parameterised lookup tables keyed by state / DNSP. This data is NEVER hard-coded into
the sizing logic: the optimiser reads the export limit to cap the value of exported
solar, and reads the FiT here only as a FALLBACK when the bill parser didn't capture a
feed-in tariff. A rule change (new DNSP limit, updated DEBS rate, new FiT) is a data edit
in this file — not a code change anywhere else.

Scope / limitations:
  - Export limits are the STANDARD SINGLE-PHASE values. Three-phase connections and
    DNSP-approved higher limits (some allow more on application) are a FUTURE EXTENSION —
    store them per state/DNSP here when added.
  - FiT values are conservative, documented FALLBACKS in AUD/kWh (matching
    bill_parser's `feed_in_tariff` units) — NOT live rates. Live NEM rates come from the
    Energy Made Easy API later. WA is NOT on the NEM: its FiT is the separate DEBS scheme.
  - All data lives in module-level dicts. No database, no external API. No function raises.

Postcode note: the special-purpose ranges 8000–8999 (VIC) and 9000–9999 (QLD) are PO box /
business-reply / large-volume-receiver allocations, not physical premises, so they are
intentionally treated as unmappable (→ safe default) for sizing purposes.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

# ── Defaults ──────────────────────────────────────────────────────────────────
DEFAULT_EXPORT_LIMIT_KW: float = 5.0
NATIONAL_FALLBACK_FIT: float = 0.05  # AUD/kWh — conservative national fallback

# ── DNSPs ─────────────────────────────────────────────────────────────────────
# Primary (representative) DNSP per state. VIC / NSW / QLD have several networks; we
# return the most common one. A postcode-level DNSP map is a future extension — the
# `postcode` / `dnsp` args below are accepted now for forward-compat.
PRIMARY_DNSP: dict[str, str] = {
    "SA": "SA Power Networks",
    "VIC": "Powercor",
    "NSW": "Ausgrid",
    "QLD": "Energex",
    "ACT": "Evoenergy",
    "TAS": "TasNetworks",
    "WA": "Western Power",
    "NT": "Power and Water Corporation",
}

# All DNSPs per state (reference; from the framework doc's export-limit table).
DNSPS_BY_STATE: dict[str, list[str]] = {
    "SA": ["SA Power Networks"],
    "VIC": ["Powercor", "CitiPower", "AusNet Services", "United Energy", "Jemena"],
    "NSW": ["Ausgrid", "Endeavour Energy", "Essential Energy"],
    "QLD": ["Energex", "Ergon Energy"],
    "ACT": ["Evoenergy"],
    "TAS": ["TasNetworks"],
    "WA": ["Western Power"],
    "NT": ["Power and Water Corporation"],
}

# ── Export limits (standard single-phase, kW) keyed by DNSP ───────────────────
# Editable per DNSP so a rule change is a data edit. All currently 5.0 kW
# (docs/2026-05-26-solar-sizing-framework.md "Export limits by state").
EXPORT_LIMIT_KW_BY_DNSP: dict[str, float] = {
    "SA Power Networks": 5.0,
    "Powercor": 5.0,
    "CitiPower": 5.0,
    "AusNet Services": 5.0,
    "United Energy": 5.0,
    "Jemena": 5.0,
    "Ausgrid": 5.0,
    "Endeavour Energy": 5.0,
    "Essential Energy": 5.0,
    "Energex": 5.0,
    "Ergon Energy": 5.0,
    "Evoenergy": 5.0,
    "TasNetworks": 5.0,
    "Western Power": 5.0,
    "Power and Water Corporation": 5.0,
}

# ── FiT fallbacks (AUD/kWh) — conservative documented defaults, NOT live rates ──
FIT_DEFAULTS: dict[str, dict] = {
    "SA": {
        "fit_aud_per_kwh": 0.05,
        "scheme": "NEM (market-based)",
        "source": "Indicative SA market FiT (~5–8c/kWh); conservative fallback",
        "last_updated": "2026-06",
    },
    "VIC": {
        "fit_aud_per_kwh": 0.045,
        "scheme": "NEM (ESC minimum + market)",
        "source": "Indicative VIC minimum FiT (ESC); conservative fallback",
        "last_updated": "2026-06",
    },
    "NSW": {
        "fit_aud_per_kwh": 0.05,
        "scheme": "NEM (market-based)",
        "source": "Indicative NSW market FiT (no guaranteed minimum); conservative fallback",
        "last_updated": "2026-06",
    },
    "QLD": {
        "fit_aud_per_kwh": 0.05,
        "scheme": "NEM (market-based; Ergon regulated in regional QLD)",
        "source": "Indicative QLD market FiT; conservative fallback",
        "last_updated": "2026-06",
    },
    "ACT": {
        "fit_aud_per_kwh": 0.06,
        "scheme": "NEM (market-based)",
        "source": "Indicative ACT market FiT; conservative fallback",
        "last_updated": "2026-06",
    },
    "TAS": {
        "fit_aud_per_kwh": 0.05,
        "scheme": "NEM (market-based)",
        "source": "Indicative TAS market FiT; conservative fallback",
        "last_updated": "2026-06",
    },
    "WA": {
        "fit_aud_per_kwh": 0.025,
        "scheme": "DEBS (WA Distributed Energy Buyback — NOT a NEM FiT)",
        "source": "WA DEBS indicative off-peak rate; set by WA govt, separate from the NEM",
        "last_updated": "2026-06",
        "note": "WA is not on the NEM. Its buyback is the DEBS scheme, not a NEM FiT.",
    },
    "NT": {
        "fit_aud_per_kwh": 0.05,
        "scheme": "Non-NEM (NT)",
        "source": "Indicative NT FiT; conservative fallback",
        "last_updated": "2026-06",
        "note": "The NT is not on the NEM.",
    },
}

# ── Postcode → state ranges (inclusive) ───────────────────────────────────────
# Standard AU residential allocations. 8000–8999 (VIC) and 9000–9999 (QLD) are
# deliberately omitted (special-purpose PO-box ranges → unmappable → safe default).
_POSTCODE_RANGES: list[tuple[int, int, str]] = [
    (200, 299, "ACT"),
    (800, 999, "NT"),
    (1000, 2599, "NSW"),
    (2600, 2618, "ACT"),
    (2619, 2899, "NSW"),
    (2900, 2920, "ACT"),
    (2921, 2999, "NSW"),
    (3000, 3999, "VIC"),
    (4000, 4999, "QLD"),
    (5000, 5999, "SA"),
    (6000, 6797, "WA"),
    (6800, 6999, "WA"),
    (7000, 7999, "TAS"),
]


# ── Functions ─────────────────────────────────────────────────────────────────
def postcode_to_state(postcode: Optional[str]) -> Optional[str]:
    """
    Map an Australian postcode to its state/territory abbreviation, or None if it can't
    be mapped. Accepts str or int; tolerates surrounding whitespace and 3-digit
    (leading-zero) forms like "0800". Non-numeric / empty / None / out-of-range → None.
    Never raises.
    """
    if postcode is None:
        return None
    s = str(postcode).strip()
    if not s.isdigit():
        return None
    n = int(s)
    for low, high, state in _POSTCODE_RANGES:
        if low <= n <= high:
            return state
    return None


def get_dnsp(state: Optional[str], postcode: Optional[str] = None) -> str:
    """
    Primary DNSP for a state (empty string if the state is unknown).

    VIC / NSW / QLD have multiple networks; this returns the representative primary one.
    `postcode` is accepted for forward-compatibility (a postcode-level DNSP map is a
    future extension) but is not yet used to disambiguate. Never raises.
    """
    if not state:
        return ""
    return PRIMARY_DNSP.get(state.strip().upper(), "")


def get_export_limit(
    state: Optional[str] = None,
    postcode: Optional[str] = None,
    dnsp: Optional[str] = None,
) -> dict:
    """
    Standard single-phase export limit (kW) for a connection.

    Resolution order: explicit `dnsp` > `state` (+ optional `postcode`) > postcode-derived
    state. Unknown / unmappable inputs return the 5.0 kW default with is_default=true.
    Never raises.

    Returns: {"state", "dnsp", "export_limit_kw", "is_default"}.

    NOTE: standard single-phase values only — three-phase / approved-higher limits are a
    future extension.
    """
    resolved_state = (state.strip().upper() if state else None) or None
    if resolved_state is None and postcode is not None:
        resolved_state = postcode_to_state(postcode)

    resolved_dnsp = dnsp or (get_dnsp(resolved_state, postcode) if resolved_state else "")
    resolved_dnsp = resolved_dnsp or None

    # Most specific: a known DNSP with a stored limit.
    if resolved_dnsp and resolved_dnsp in EXPORT_LIMIT_KW_BY_DNSP:
        return {
            "state": resolved_state,
            "dnsp": resolved_dnsp,
            "export_limit_kw": EXPORT_LIMIT_KW_BY_DNSP[resolved_dnsp],
            "is_default": False,
        }

    # Known state → known limit via its primary DNSP.
    if resolved_state and resolved_state in PRIMARY_DNSP:
        primary = PRIMARY_DNSP[resolved_state]
        return {
            "state": resolved_state,
            "dnsp": primary,
            "export_limit_kw": EXPORT_LIMIT_KW_BY_DNSP.get(
                primary, DEFAULT_EXPORT_LIMIT_KW
            ),
            "is_default": False,
        }

    # Unknown / unmappable → safe default.
    return {
        "state": resolved_state,
        "dnsp": resolved_dnsp,
        "export_limit_kw": DEFAULT_EXPORT_LIMIT_KW,
        "is_default": True,
    }


def get_default_fit(state: Optional[str]) -> dict:
    """
    Conservative FALLBACK feed-in tariff (AUD/kWh) for a state — NOT a live rate.

    The optimiser MUST prefer a bill-extracted `feed_in_tariff` when present; this is only
    used when the bill didn't carry one. `is_fallback` is always true. Unknown state →
    documented national fallback. WA returns the DEBS scheme (flagged, not a NEM FiT).
    Never raises.

    Returns: {"state", "fit_aud_per_kwh", "is_fallback", "source", "last_updated",
              "scheme", (optional) "note"}.
    """
    key = (state.strip().upper() if state else "") or ""
    entry = FIT_DEFAULTS.get(key)
    if entry is None:
        return {
            "state": key or None,
            "fit_aud_per_kwh": NATIONAL_FALLBACK_FIT,
            "is_fallback": True,
            "source": "National conservative fallback (state not recognised)",
            "last_updated": "2026-06",
            "scheme": "Unknown",
        }
    out = {
        "state": key,
        "fit_aud_per_kwh": entry["fit_aud_per_kwh"],
        "is_fallback": True,
        "source": entry["source"],
        "last_updated": entry["last_updated"],
        "scheme": entry["scheme"],
    }
    if "note" in entry:
        out["note"] = entry["note"]
    return out


# ── STC zone ratings + battery rebate (cost model A3) ─────────────────────────
# Authority: docs/2026-06-11-cost-model-pricing.md §3. SRES solar-credit zone ratings
# and the Cheaper Home Batteries capacity tiering. Additive — does not touch the
# export-limit / FiT functions above.

# Small-scale Technology Certificate zone rating by SRES zone.
STC_ZONE_RATING: dict[int, float] = {1: 1.622, 2: 1.536, 3: 1.382, 4: 1.185}

# State → SRES zone (state-level approximation; SA = Zone 3 = 1.382). Zones are
# technically allocated by postcode — a precise postcode→zone map is a future
# refinement; unknown states fall back to Zone 3 (the most populous).
STC_ZONE_BY_STATE: dict[str, int] = {
    "SA": 3,
    "NSW": 3,
    "ACT": 3,
    "QLD": 3,
    "WA": 3,
    "VIC": 4,
    "TAS": 4,
    "NT": 2,
}

# Cheaper Home Batteries rebate capacity tiering (per usable kWh band), capped at
# 50 kWh of input capacity. The dollar rebate = effective_kwh × battery_stc_per_kwh ×
# stc_price_net (those two params live in cost_assumptions, not here).
BATTERY_REBATE_TIERS: list[tuple[float, float, float]] = [
    (0.0, 14.0, 1.00),
    (14.0, 28.0, 0.60),
    (28.0, 50.0, 0.15),
]
BATTERY_REBATE_CAP_KWH: float = 50.0


def get_stc_zone_rating(
    state: Optional[str] = None, postcode: Optional[str] = None
) -> dict:
    """
    SRES solar STC zone rating for a location. Resolution: explicit `state` >
    postcode-derived state. Unknown / unmappable → Zone 3 default with is_default=true.
    Never raises.

    Returns: {"state", "zone", "zone_rating", "is_default"}.
    """
    resolved_state = (state.strip().upper() if state else None) or None
    if resolved_state is None and postcode is not None:
        resolved_state = postcode_to_state(postcode)

    zone = STC_ZONE_BY_STATE.get(resolved_state) if resolved_state else None
    is_default = zone is None
    if zone is None:
        zone = 3  # documented default (Zone 3)
    return {
        "state": resolved_state,
        "zone": zone,
        "zone_rating": STC_ZONE_RATING[zone],
        "is_default": is_default,
    }


def battery_rebate_effective_kwh(usable_kwh: Optional[float]) -> float:
    """
    Tier-weighted equivalent usable kWh for the Cheaper Home Batteries rebate:
    first 14 kWh @100%, 14–28 @60%, 28–50 @15%, capped at 50 kWh of input capacity.

    The dollar rebate = (this value) × battery_stc_per_kwh × stc_price_net. Returns 0.0
    for missing / non-positive / non-numeric input. Never raises.
    """
    try:
        kwh = float(usable_kwh)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if kwh <= 0:
        return 0.0
    kwh = min(kwh, BATTERY_REBATE_CAP_KWH)
    eff = 0.0
    for lo, hi, pct in BATTERY_REBATE_TIERS:
        if kwh <= lo:
            break
        band = min(kwh, hi) - lo
        if band > 0:
            eff += band * pct
    return round(eff, 4)



# ── Dated federal incentive schedules (3.13b prompt 1 — F224) ─────────────────
# The battery certificate factor and the solar deeming period are LEGISLATED,
# DATED schedules. The schedule here is the FACT; the copy in cost_assumptions
# is only a copy (D26 applied to policy — cost_model compares the two and
# flags a disagreement, but the arithmetic reads THIS table; 2R.1 deletes the
# second copy rather than gating both). Entries are (valid_from, valid_to,
# value, source, verified_on) with ISO dates, inclusive at BOTH ends, and
# cover ONLY the periods actually verified against the Clean Energy
# Regulator. Anything outside them resolves to UNKNOWN — never the nearest
# period, never an extrapolation. A guessed rate moves the error, not fixes
# it: an unknown rate is NOT quoted, it is reported as unknown.

CER_SOLAR_BATTERIES_URL: str = (
    "https://cer.gov.au/schemes/renewable-energy-target/"
    "small-scale-renewable-energy-scheme/small-scale-renewable-energy-systems/"
    "solar-batteries"
)
CER_STC_CALCULATOR_URL: str = (
    "https://cer.gov.au/schemes/renewable-energy-target/"
    "small-scale-renewable-energy-scheme/small-scale-technology-certificates/"
    "calculate-small-scale-technology-certificate-entitlements"
)

# Battery STC factor (certificates per usable kWh) — steps every SIX months
# in 2026: 8.4 for Jan–Apr, 6.8 for May–Dec. Verified 2026-08-25 against the
# CER solar-batteries page. 2027 is NOT listed: it has not been verified, so
# it must resolve to UNKNOWN, not to a guess.
BATTERY_STC_FACTOR_PERIODS: list[tuple[str, str, float, str, str]] = [
    ("2026-01-01", "2026-04-30", 8.4, CER_SOLAR_BATTERIES_URL, "2026-08-25"),
    ("2026-05-01", "2026-12-31", 6.8, CER_SOLAR_BATTERIES_URL, "2026-08-25"),
]

# Solar STC deeming period (years) by INSTALL YEAR: 5 years for a 2026
# install. 2027 falls to 4 years but is NOT listed for the same reason.
SOLAR_DEEMING_YEARS_PERIODS: list[tuple[str, str, int, str, str]] = [
    ("2026-01-01", "2026-12-31", 5, CER_STC_CALCULATOR_URL, "2026-08-25"),
]


def _resolve_schedule(periods: list[tuple], as_at: object, what: str) -> dict:
    """Resolve a dated schedule at `as_at`. Fixed shape, NEVER raises.

    A datetime is accepted and truncated to its date. Anything else that is
    not a date — None, a string, a number — resolves to UNKNOWN with a
    plain-English reason naming the last known period, as does any date
    outside every listed period. The nearest period is NEVER used and nothing
    is extrapolated.

    Returns: {"value": float|int|None, "is_known": bool, "valid_from":
    str|None, "valid_to": str|None, "source": str|None, "verified_on":
    str|None, "reason": str|None}.
    """
    if isinstance(as_at, datetime):
        as_at = as_at.date()
    unknown: dict = {
        "value": None, "is_known": False, "valid_from": None,
        "valid_to": None, "source": None, "verified_on": None, "reason": None,
    }
    if not periods:
        unknown["reason"] = f"No {what} periods are on record at all."
        return unknown
    last = periods[-1]
    if not isinstance(as_at, date):
        unknown["reason"] = (
            f"as_at is not a date ({type(as_at).__name__}), so the {what} "
            f"cannot be resolved; the last known period is {last[0]} to "
            f"{last[1]} at {last[2]}."
        )
        return unknown
    for valid_from, valid_to, value, source, verified_on in periods:
        try:
            if date.fromisoformat(valid_from) <= as_at <= date.fromisoformat(valid_to):
                return {
                    "value": value, "is_known": True, "valid_from": valid_from,
                    "valid_to": valid_to, "source": source,
                    "verified_on": verified_on, "reason": None,
                }
        except (TypeError, ValueError):  # a malformed period entry — skip it
            continue
    unknown["reason"] = (
        f"No {what} is on record for {as_at.isoformat()}; the last known "
        f"period is {last[0]} to {last[1]} at {last[2]}. The rate is not "
        f"extrapolated, and an unknown rate is not quoted."
    )
    return unknown


def get_battery_stc_factor(as_at: date) -> dict:
    """Battery STC factor (certificates per usable kWh) legislated at `as_at`.

    Resolved against BATTERY_STC_FACTOR_PERIODS only — is_known False with a
    plain-English reason outside every verified period. Never raises.
    """
    return _resolve_schedule(
        BATTERY_STC_FACTOR_PERIODS, as_at,
        "battery STC factor (certificates per kWh)")


def get_solar_deeming_years(as_at: date) -> dict:
    """Solar STC deeming period (years) for an install at `as_at`.

    Resolved against SOLAR_DEEMING_YEARS_PERIODS only — is_known False with a
    plain-English reason outside every verified period. Never raises.
    """
    return _resolve_schedule(
        SOLAR_DEEMING_YEARS_PERIODS, as_at,
        "solar STC deeming period (years)")


# ── Time base (3.7 Part A) ────────────────────────────────────────────────────
# Local STANDARD time offsets from UTC, by state. Daylight saving is NOT
# modelled anywhere in the sizing pipeline (see generation.py's convention
# docstring): meter and bill data are recorded against the local jurisdiction
# clock, and a declared uniform standard-time base is wrong by at most one hour
# for part of the year, versus nine and a half hours all year before 3.7.
STATE_UTC_OFFSET_HOURS: dict[str, float] = {
    "SA": 9.5,
    "NT": 9.5,
    "NSW": 10.0,
    "ACT": 10.0,
    "VIC": 10.0,
    "TAS": 10.0,
    "QLD": 10.0,
    "WA": 8.0,
}


def get_utc_offset_hours(state: Optional[str]) -> Optional[float]:
    """UTC offset for a state's LOCAL STANDARD time, or None when unknown.

    None for an unknown or None state — NEVER a default of 0 or 10: a silent
    default here reintroduces the UTC/local netting fault for every site whose
    state failed to derive (routes/job.py's _derive_site legitimately returns
    None rather than guessing). None must travel as None and surface as the
    `generation_time_base_unrotated` flag, so the degradation is visible."""
    if not isinstance(state, str):
        return None
    return STATE_UTC_OFFSET_HOURS.get(state.strip().upper())
