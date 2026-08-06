"""
Load characterisation endpoint.

Combines bill data (annual_kwh, daily_avg_kwh) with optional 5-question survey
inputs to produce an adjusted 24-hour load profile and an accuracy tier.

Tier 1 = AEMO archetype only (no survey), 65% confidence.
Tier 2 = survey-adjusted archetype, 82% confidence.
"""

from __future__ import annotations

from typing import Optional

import sentry_sdk
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


# TODO Phase 2: replace these hand-built profiles with real AEMO residential
# archetype data (load shape per household_size x occupancy).
_BASE_PROFILES: dict[str, list[float]] = {
    # 1–2 people, away weekdays
    "small_away": [
        0.3, 0.3, 0.3, 0.3, 0.3, 0.3,        # 0–5
        0.8,                                   # 6
        1.2,                                   # 7
        0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,  # 8–16
        0.9,                                   # 17
        1.8,                                   # 18
        2.2,                                   # 19
        2.0,                                   # 20
        1.8,                                   # 21
        1.2,                                   # 22
        0.6,                                   # 23
    ],
    # 1–2 people, always home / shift
    "small_home": [
        0.3, 0.3, 0.3, 0.3, 0.3, 0.3,        # 0–5
        0.9,                                   # 6
        1.3,                                   # 7
        1.1, 1.1, 1.1, 1.1,                   # 8–11
        1.2, 1.2,                              # 12–13
        0.9, 0.9, 0.9,                         # 14–16
        1.2,                                   # 17
        1.8,                                   # 18
        2.0,                                   # 19
        1.8,                                   # 20
        1.4,                                   # 21
        0.6, 0.6,                              # 22–23
    ],
    # 3–4 or 5+, away weekdays
    "large_away": [
        0.4, 0.4, 0.4, 0.4, 0.4, 0.4,        # 0–5
        1.0,                                   # 6
        1.4,                                   # 7
        0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,  # 8–16
        1.1,                                   # 17
        2.0,                                   # 18
        2.4,                                   # 19
        2.2,                                   # 20
        1.9,                                   # 21
        1.3,                                   # 22
        0.7,                                   # 23
    ],
    # 3–4 or 5+, always home / shift
    "large_home": [
        0.4, 0.4, 0.4, 0.4, 0.4, 0.4,        # 0–5
        1.0,                                   # 6
        1.5,                                   # 7
        1.3, 1.3, 1.3, 1.3,                   # 8–11
        1.4, 1.4,                              # 12–13
        1.1, 1.1, 1.1,                         # 14–16
        1.3,                                   # 17
        2.0,                                   # 18
        2.2,                                   # 19
        2.0,                                   # 20
        1.5,                                   # 21
        0.7, 0.7,                              # 22–23
    ],
}

# Flat 24-hour profile for the Tier 1 fallback when no survey is provided.
_FLAT_PROFILE: list[float] = [1.0] * 24


_HOUSEHOLD_LABEL = {
    "1": "1 person household",
    "2": "2 person household",
    "3-4": "3–4 person household",
    "5+": "5+ person household",
}

_OCCUPANCY_LABEL = {
    "always_home": "always home",
    "away_weekdays": "away weekdays",
    "shift_work": "shift work / irregular",
}

_TARIFF_LABEL = {
    "single_rate": "Single rate",
    "tou": "Time of use",
    "demand": "Demand tariff",
    "not_sure": "Single rate (default)",
}


def _normalise(profile: list[float]) -> list[float]:
    """Normalise so that sum(weights) == 24.0 (mean == 1.0)."""
    total = sum(profile)
    if total <= 0:
        return _FLAT_PROFILE[:]
    factor = 24.0 / total
    return [w * factor for w in profile]


def _select_base_profile(
    household_size: str, occupancy: str
) -> tuple[str, list[float], str]:
    """Return (profile_key, profile_weights, human_archetype_description)."""
    small = household_size in ("1", "2")
    away = occupancy == "away_weekdays"
    key = f"{'small' if small else 'large'}_{'away' if away else 'home'}"
    profile = _BASE_PROFILES[key][:]
    household_desc = _HOUSEHOLD_LABEL.get(household_size, household_size)
    occ_desc = _OCCUPANCY_LABEL.get(occupancy, occupancy)
    archetype = f"{household_desc}, {occ_desc}"
    return key, profile, archetype


class LoadCharacteriseRequest(BaseModel):
    annual_kwh: Optional[float] = None
    daily_avg_kwh: Optional[float] = None
    household_size: Optional[str] = None
    hot_water: Optional[str] = None
    appliances: Optional[list[str]] = None
    occupancy: Optional[str] = None
    tariff_type: Optional[str] = None
    # 7×24 matrix: [day][hour] where day 0=Mon..6=Sun, hour 0–23. 1=home, 0=away.
    occupancy_grid: Optional[list[list[int]]] = None
    # Tier 3 (E1): when a smart-meter interval profile exists for this job, it WINS over
    # the survey archetype. Shape (from /api/interval/upload): hourly_profile_weights[24],
    # annual_kwh, daily_avg_kwh, + optional coverage_days / pct_actual / channels_used.
    interval_profile: Optional[dict] = None


def _valid_interval_profile(p: Optional[dict]) -> bool:
    if not isinstance(p, dict):
        return False
    weights = p.get("hourly_profile_weights")
    return (
        isinstance(weights, list)
        and len(weights) == 24
        and (p.get("annual_kwh") is not None or p.get("daily_avg_kwh") is not None)
    )


def _valid_grid(grid: Optional[list[list[int]]]) -> bool:
    if grid is None or len(grid) != 7:
        return False
    return all(isinstance(row, list) and len(row) == 24 for row in grid)


def _blend_from_grid(
    household_size: str, grid: list[list[int]]
) -> tuple[list[float], str, float]:
    """Return (profile_weights, archetype, daytime_home_frac).

    Computes daytime_home_frac from Mon–Fri 09:00–16:59 cells (40 cells),
    then linearly blends the home/away archetypes for the matching size.
    """
    weekday_daytime_cells = [
        grid[day][hour] for day in range(5) for hour in range(9, 17)
    ]
    daytime_home_frac = sum(weekday_daytime_cells) / 40.0

    small = household_size in ("1", "2")
    prefix = "small" if small else "large"
    home_weights = _BASE_PROFILES[f"{prefix}_home"]
    away_weights = _BASE_PROFILES[f"{prefix}_away"]

    blended = [
        home_weights[i] * daytime_home_frac
        + away_weights[i] * (1.0 - daytime_home_frac)
        for i in range(24)
    ]
    pct = round(daytime_home_frac * 100)
    household_desc = _HOUSEHOLD_LABEL.get(household_size, household_size)
    archetype = f"{household_desc}, {pct}% home during day (custom schedule)"
    return _normalise(blended), archetype, daytime_home_frac


@router.post("/api/load/characterise")
async def characterise_load(body: LoadCharacteriseRequest):
    try:
        # ── Tier 3 — real smart-meter interval profile wins over the survey archetype.
        # Additive branch: when no interval_profile is supplied, the survey/bill paths
        # below run exactly as before.
        if _valid_interval_profile(body.interval_profile):
            ip = body.interval_profile or {}
            annual_i = ip.get("annual_kwh")
            daily_i = ip.get("daily_avg_kwh")
            if daily_i is None and annual_i is not None:
                daily_i = annual_i / 365.0
            if annual_i is None and daily_i is not None:
                annual_i = daily_i * 365.0
            return {
                "annual_kwh": annual_i,
                "daily_avg_kwh": daily_i,
                "archetype_used": "Smart-meter interval data (Tier 3 — actual usage)",
                "accuracy_tier": 3,
                "confidence_pct": int(ip.get("confidence_pct") or 92),
                "hourly_profile_weights": ip["hourly_profile_weights"],
                "adjustment_log": [],
                "tariff_type_used": _TARIFF_LABEL.get(
                    body.tariff_type or "not_sure", "From smart-meter data"
                ),
                "coverage_days": ip.get("coverage_days"),
                "pct_actual": ip.get("pct_actual"),
                "channels_used": ip.get("channels_used"),
                "annualised": ip.get("annualised"),
            }

        if body.annual_kwh is None and body.daily_avg_kwh is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Annual consumption could not be determined from the bill. "
                    "Please check the uploaded bill."
                ),
            )

        # Derive daily_avg_kwh / annual_kwh if one is missing.
        daily_avg = body.daily_avg_kwh
        annual = body.annual_kwh
        if daily_avg is None and annual is not None:
            daily_avg = annual / 365.0
        if annual is None and daily_avg is not None:
            annual = daily_avg * 365.0

        if daily_avg is None or daily_avg <= 0:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Annual consumption could not be determined from the bill. "
                    "Please check the uploaded bill."
                ),
            )

        survey_complete = all(
            [
                body.household_size,
                body.hot_water,
                body.occupancy,
                body.tariff_type,
                body.appliances is not None,
            ]
        )

        adjustment_log: list[dict] = []

        if survey_complete:
            household_size = body.household_size or "3-4"
            occupancy = body.occupancy or "away_weekdays"
            if _valid_grid(body.occupancy_grid):
                profile_weights, archetype, _ = _blend_from_grid(
                    household_size, body.occupancy_grid  # type: ignore[arg-type]
                )
            else:
                _, base_weights, archetype = _select_base_profile(
                    household_size, occupancy
                )
                profile_weights = _normalise(base_weights)

            appliances = body.appliances or []
            if "ev" in appliances:
                adjustment_log.append(
                    {
                        "description": "EV added: evening charging assumed",
                        "kwh_delta": 7.0,
                    }
                )
            if "pool_pump" in appliances:
                adjustment_log.append(
                    {
                        "description": "Pool pump added",
                        "kwh_delta": 2.5,
                    }
                )
            if "ducted_ac" in appliances:
                adjustment_log.append(
                    {
                        "description": "Ducted A/C added (summer peak assumed)",
                        "kwh_delta": 4.0,
                    }
                )

            hot_water = body.hot_water
            if hot_water == "electric_storage":
                adjustment_log.append(
                    {
                        "description": "Electric storage HWS (overnight load)",
                        "kwh_delta": 3.0,
                    }
                )
            elif hot_water == "heat_pump":
                adjustment_log.append(
                    {
                        "description": "Heat pump HWS",
                        "kwh_delta": 1.2,
                    }
                )
            # gas and solar_hws → no delta, no entry

            total_delta = sum(item["kwh_delta"] for item in adjustment_log)
            adjusted_daily = daily_avg + total_delta
            adjusted_annual = adjusted_daily * 365.0

            tariff_type_used = _TARIFF_LABEL.get(
                body.tariff_type or "not_sure", "Single rate (default)"
            )

            return {
                "annual_kwh": adjusted_annual,
                "daily_avg_kwh": adjusted_daily,
                "archetype_used": archetype,
                "accuracy_tier": 2,
                "confidence_pct": 82,
                "hourly_profile_weights": profile_weights,
                "adjustment_log": adjustment_log,
                "tariff_type_used": tariff_type_used,
            }

        # Tier 1 — no survey provided. Use a flat archetype.
        profile_weights = _normalise(_FLAT_PROFILE[:])
        tariff_type_used = (
            _TARIFF_LABEL.get(body.tariff_type, "Single rate (default)")
            if body.tariff_type
            else "Single rate (default)"
        )
        return {
            "annual_kwh": annual,
            "daily_avg_kwh": daily_avg,
            "archetype_used": "National average (Tier 1 estimate)",
            "accuracy_tier": 1,
            "confidence_pct": 65,
            "hourly_profile_weights": profile_weights,
            "adjustment_log": [],
            "tariff_type_used": tariff_type_used,
        }

    except HTTPException:
        raise
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not calculate load profile. "
                "Please check your inputs and try again."
            ),
        )
