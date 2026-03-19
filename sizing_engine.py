"""
Sizing engine for solar + battery (Australia).

This module:
- Estimates annual household electricity consumption from `bill_data`.
- Uses `solar_data` (PVGIS-derived production per kW installed).
- Computes a recommended solar size and (optionally) battery size within a budget.
"""

from __future__ import annotations

import json
from typing import Any

from bill_parser import parse_bill
from solar_irradiance import fetch_pvgis_profile


# -----------------------------
# Cost benchmarks ($/installed)
# -----------------------------

SOLAR_COST_PER_KW = 1100.0
BATTERY_COST_PER_KWH = 800.0


# -----------------------------
# Self-consumption assumptions
# -----------------------------

SELF_CONSUMPTION_RATIO_BY_OCCUPANCY = {
    "home_all_day": 0.6,
    "mixed": 0.45,
    "away_during_day": 0.3,
}


# -----------------------------
# Helpers: validation + estimates
# -----------------------------

def _require_present(d: dict[str, Any], key: str) -> Any:
    if key not in d:
        raise KeyError(f"Missing required field in input: {key}")
    return d[key]


def estimate_annual_load_kwh(bill_data: dict[str, Any]) -> float:
    """
    Estimate annual household consumption (kWh/year).

    Uses bill_data["daily_avg_kwh"] if present; otherwise falls back to:
    daily_avg_kwh = total_kwh / billing_period_days.
    """
    daily_avg_kwh = bill_data.get("daily_avg_kwh")
    if isinstance(daily_avg_kwh, (int, float)) and daily_avg_kwh > 0:
        return float(daily_avg_kwh) * 365.0

    total_kwh = bill_data.get("total_kwh")
    billing_period_days = bill_data.get("billing_period_days")
    if (
        isinstance(total_kwh, (int, float))
        and total_kwh > 0
        and isinstance(billing_period_days, (int, float))
        and billing_period_days > 0
    ):
        daily = float(total_kwh) / float(billing_period_days)
        return daily * 365.0

    raise ValueError(
        "Could not estimate annual load. Provide either daily_avg_kwh or "
        "(total_kwh and billing_period_days) in bill_data."
    )


def _coerce_occupancy_ratio(occupancy: str) -> float:
    if not isinstance(occupancy, str):
        raise TypeError("occupancy must be a string.")
    key = occupancy.strip()
    if key not in SELF_CONSUMPTION_RATIO_BY_OCCUPANCY:
        raise ValueError(
            f"Unknown occupancy '{occupancy}'. Expected one of: "
            f"{', '.join(SELF_CONSUMPTION_RATIO_BY_OCCUPANCY.keys())}"
        )
    return SELF_CONSUMPTION_RATIO_BY_OCCUPANCY[key]


# -----------------------------
# Main sizing heuristic
# -----------------------------

def size_system(
    bill_data: dict[str, Any],
    solar_data: dict[str, Any],
    budget: float,
    wants_battery: bool,
    occupancy: str,
) -> dict[str, Any]:
    """
    Recommend solar and optional battery sizes.

    Heuristic model (kept intentionally simple):
    - solar_kw is varied within budget feasibility.
    - annual_solar_generation_kwh = solar_kw * annual_kwh_per_kwp.
    - estimated daily solar self-consumed energy = daily_generation * self_ratio.
    - battery_kwh is sized to cover the daily remaining demand up to the
      daily surplus available above solar self-consumption.
    """
    # ---------
    # Validate inputs
    # ---------
    if not isinstance(budget, (int, float)) or budget < 0:
        raise ValueError("budget must be a non-negative number.")
    if not isinstance(wants_battery, bool):
        raise TypeError("wants_battery must be a boolean.")
    if not isinstance(bill_data, dict):
        raise TypeError("bill_data must be a dictionary.")
    if not isinstance(solar_data, dict):
        raise TypeError("solar_data must be a dictionary.")

    annual_kwh_per_kwp = solar_data.get("annual_kwh_per_kwp")
    if not isinstance(annual_kwh_per_kwp, (int, float)) or annual_kwh_per_kwp <= 0:
        raise ValueError("solar_data['annual_kwh_per_kwp'] must be present and > 0.")

    # Estimate annual load from the bill.
    annual_load_kwh = estimate_annual_load_kwh(bill_data)

    self_ratio = _coerce_occupancy_ratio(occupancy)

    # ---------
    # Search solar sizes within budget
    # ---------
    max_solar_kw = budget / SOLAR_COST_PER_KW if SOLAR_COST_PER_KW > 0 else 0.0
    if max_solar_kw <= 0:
        return {
            "solar_kw": 0.0,
            "battery_kwh": 0.0,
            "self_consumption_ratio": float(self_ratio),
            "system_cost": 0.0,
            "annual_solar_generation_kwh": 0.0,
            "within_budget": True,
        }

    # Discretize solar_kw for speed/simplicity.
    step_kw = 0.1
    best: dict[str, Any] | None = None

    daily_load = annual_load_kwh / 365.0

    solar_kw = 0.0
    while solar_kw <= max_solar_kw + 1e-9:
        annual_solar_generation_kwh = solar_kw * float(annual_kwh_per_kwp)
        daily_generation = annual_solar_generation_kwh / 365.0

        # Energy assumed to be self-consumed on-site (solar usage before battery shifting).
        daily_solar_self_consumed = max(0.0, daily_generation * self_ratio)

        # Remaining load after direct self-consumption.
        daily_unmet_by_direct_solar = max(0.0, daily_load - daily_solar_self_consumed)

        # Battery can only charge from solar surplus; approximate this as "generation over load".
        daily_surplus_for_storage = max(0.0, daily_generation - daily_load)

        if not wants_battery:
            battery_kwh = 0.0
        else:
            # Battery sized for (up to) one day's unmet load, but limited by available daily surplus.
            battery_kwh = min(daily_unmet_by_direct_solar, daily_surplus_for_storage)

        # Cost.
        system_cost = solar_kw * SOLAR_COST_PER_KW + battery_kwh * BATTERY_COST_PER_KWH
        within_budget = system_cost <= budget + 1e-6

        if within_budget:
            # Estimate how much load can be served by solar self-consumption + battery discharge.
            daily_served = min(daily_load, daily_solar_self_consumed + battery_kwh)
            annual_served = daily_served * 365.0

            # Estimate effective self-consumption as fraction of solar generation used on-site.
            if annual_solar_generation_kwh > 0:
                effective_self_ratio = min(1.0, annual_served / annual_solar_generation_kwh)
            else:
                effective_self_ratio = float(self_ratio)

            candidate = {
                "solar_kw": round(solar_kw, 3),
                "battery_kwh": round(battery_kwh, 3),
                "self_consumption_ratio": round(effective_self_ratio, 4),
                "system_cost": round(system_cost, 2),
                "annual_solar_generation_kwh": round(annual_solar_generation_kwh, 1),
                "within_budget": True,
                "_objective_annual_served_kwh": annual_served,
            }

            if best is None or candidate["_objective_annual_served_kwh"] > best[
                "_objective_annual_served_kwh"
            ]:
                best = candidate

        solar_kw += step_kw

    # If nothing fit the budget (should be rare), return the smallest safe option.
    if best is None:
        return {
            "solar_kw": 0.0,
            "battery_kwh": 0.0,
            "self_consumption_ratio": float(self_ratio),
            "system_cost": 0.0,
            "annual_solar_generation_kwh": 0.0,
            "within_budget": True,
        }

    # Remove internal objective key.
    best.pop("_objective_annual_served_kwh", None)
    best["within_budget"] = True
    return best


# -----------------------------
# Main test harness
# -----------------------------

def main() -> None:
    """
    Test sizing on the Kensington SA property.

    This will call:
    - `bill_parser.parse_bill()` which uses Claude Vision (needs ANTHROPIC_API_KEY)
    - `solar_irradiance.fetch_pvgis_profile()` which uses geopy + PVGIS (network required)
    """
    budget = 15000.0
    wants_battery = True
    occupancy = "mixed"

    # Keep the address in sync with `solar_irradiance.py`.
    address = "53 Bishops Place, Kensington SA 5068"
    bill_path = "test_bill.pdf"

    try:
        bill_data = parse_bill(bill_path)
        solar_data = fetch_pvgis_profile(address, peakpower_kwp=6.6)
        result = size_system(
            bill_data=bill_data,
            solar_data=solar_data,
            budget=budget,
            wants_battery=wants_battery,
            occupancy=occupancy,
        )
        print(json.dumps(result, indent=2))
    except Exception as exc:
        print(f"Failed to run sizing_engine test: {exc}")


if __name__ == "__main__":
    main()

