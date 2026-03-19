"""
Financial model for solar + optional battery (Australia).

Inputs:
  - bill_data: output from `bill_parser.py`
  - sizing_data: output from `sizing_engine.py`
  - solar_data: output from `solar_irradiance.py`

Outputs:
  A dictionary of financial KPIs such as annual savings, payback, and NPV.
"""

from __future__ import annotations

import json
from typing import Any

from bill_parser import parse_bill
from sizing_engine import size_system
from solar_irradiance import fetch_pvgis_profile


# -----------------------------
# Assumptions / configuration
# -----------------------------

ELECTRICITY_PRICE_INFLATION_RATE = 0.03  # 3% per year
PANEL_DEGRADATION_RATE = 0.005  # 0.5% per year
SYSTEM_LIFETIME_YEARS = 25

# Battery replacement outflow at year 12 when battery is included.
BATTERY_REPLACEMENT_YEAR = 12
BATTERY_REPLACEMENT_COST_AUD = 8000.0

# Discount rate for NPV calculation.
# Not specified by the prompt; adjust later if you have a project-specific target.
DISCOUNT_RATE = 0.07


# -----------------------------
# Small helpers
# -----------------------------

def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _safe_float(x: Any) -> float | None:
    if _is_number(x):
        return float(x)
    return None


def estimate_annual_load_kwh(bill_data: dict[str, Any]) -> float:
    """
    Estimate annual household electricity consumption (kWh/year).

    We prefer daily_avg_kwh, otherwise compute from total_kwh / billing_period_days.
    """
    daily_avg_kwh = bill_data.get("daily_avg_kwh")
    if _is_number(daily_avg_kwh) and float(daily_avg_kwh) > 0:
        return float(daily_avg_kwh) * 365.0

    total_kwh = bill_data.get("total_kwh")
    billing_period_days = bill_data.get("billing_period_days")
    if (
        _is_number(total_kwh)
        and float(total_kwh) > 0
        and _is_number(billing_period_days)
        and float(billing_period_days) > 0
    ):
        daily = float(total_kwh) / float(billing_period_days)
        return daily * 365.0

    raise ValueError(
        "Could not estimate annual load from bill_data. Provide daily_avg_kwh or "
        "both total_kwh and billing_period_days."
    )


def compute_financials(
    bill_data: dict[str, Any],
    sizing_data: dict[str, Any],
    solar_data: dict[str, Any],
) -> dict[str, Any]:
    """
    Compute financial metrics for the recommended solar + battery system.
    """
    # -----------------------------
    # Validate required fields
    # -----------------------------
    if not isinstance(bill_data, dict):
        raise TypeError("bill_data must be a dictionary.")
    if not isinstance(sizing_data, dict):
        raise TypeError("sizing_data must be a dictionary.")
    if not isinstance(solar_data, dict):
        raise TypeError("solar_data must be a dictionary.")

    system_capex = _safe_float(sizing_data.get("system_cost"))
    if system_capex is None:
        raise ValueError("sizing_data['system_cost'] is required.")

    annual_solar_generation_kwh = _safe_float(sizing_data.get("annual_solar_generation_kwh"))
    if annual_solar_generation_kwh is None:
        raise ValueError("sizing_data['annual_solar_generation_kwh'] is required.")

    self_consumption_ratio = _safe_float(sizing_data.get("self_consumption_ratio"))
    if self_consumption_ratio is None:
        raise ValueError("sizing_data['self_consumption_ratio'] is required.")
    # Clamp just in case (should be 0..1).
    self_consumption_ratio = max(0.0, min(1.0, self_consumption_ratio))

    tariff_rate = _safe_float(bill_data.get("tariff_rate"))  # AUD per kWh
    feed_in_tariff = _safe_float(bill_data.get("feed_in_tariff"))  # AUD per kWh
    if feed_in_tariff is None:
        feed_in_tariff = 0.0

    # -----------------------------
    # Current spend baseline
    # -----------------------------
    annual_load_kwh = estimate_annual_load_kwh(bill_data)

    if tariff_rate is not None:
        current_annual_spend = annual_load_kwh * tariff_rate
    else:
        # Fall back to parser-provided annual_spend if available.
        current_annual_spend = _safe_float(bill_data.get("annual_spend"))
        if current_annual_spend is None:
            raise ValueError(
                "bill_data must include tariff_rate or annual_spend to compute current spend."
            )

    annual_self_consumption_kwh = annual_solar_generation_kwh * self_consumption_ratio
    annual_export_kwh = max(0.0, annual_solar_generation_kwh - annual_self_consumption_kwh)
    excess_export_kwh = annual_export_kwh
    has_excess_generation = annual_solar_generation_kwh > annual_load_kwh

    # -----------------------------
    # Annual savings (Year 1, nominal)
    # -----------------------------
    if tariff_rate is None:
        # If tariff_rate missing, we can't estimate bill reduction; keep exports-only savings.
        annual_bill_reduction = 0.0
    else:
        annual_bill_reduction = annual_self_consumption_kwh * tariff_rate

    annual_export_revenue = annual_export_kwh * float(feed_in_tariff)
    annual_savings = annual_bill_reduction + annual_export_revenue

    monthly_bill_reduction = annual_bill_reduction / 12.0
    # Projected annual spend is the current annual spend minus annual savings.
    # If it goes negative, clamp to $0 and allow the report to show an export tip.
    projected_annual_spend_raw = current_annual_spend - annual_savings
    if projected_annual_spend_raw < 0:
        projected_annual_spend = 0.0
    else:
        projected_annual_spend = projected_annual_spend_raw

    # -----------------------------
    # Payback (simple)
    # -----------------------------
    # Use bill reduction only (not export revenue) to align with "bill payback" intuition.
    if annual_bill_reduction > 0 and system_capex > 0:
        payback_years = system_capex / annual_bill_reduction
    else:
        payback_years = None

    # -----------------------------
    # NPV over lifetime
    # -----------------------------
    npv = -system_capex  # year 0 outflow

    for year in range(1, SYSTEM_LIFETIME_YEARS + 1):
        # Degradation reduces generation over time.
        degradation_multiplier = (1.0 - PANEL_DEGRADATION_RATE) ** (year - 1)
        generation_kwh_year = annual_solar_generation_kwh * degradation_multiplier

        self_kwh_year = generation_kwh_year * self_consumption_ratio
        export_kwh_year = max(0.0, generation_kwh_year - self_kwh_year)

        # Inflate energy prices each year. Assume feed-in tariff follows the same inflation.
        price_multiplier = (1.0 + ELECTRICITY_PRICE_INFLATION_RATE) ** (year - 1)

        if tariff_rate is not None:
            bill_reduction_year = self_kwh_year * float(tariff_rate) * price_multiplier
        else:
            bill_reduction_year = 0.0

        export_revenue_year = export_kwh_year * float(feed_in_tariff) * price_multiplier
        annual_benefit_year = bill_reduction_year + export_revenue_year

        cashflow = annual_benefit_year

        # Battery replacement at year 12, if battery is included in sizing.
        battery_kwh = _safe_float(sizing_data.get("battery_kwh"))
        if (
            battery_kwh is not None
            and battery_kwh > 0
            and year == BATTERY_REPLACEMENT_YEAR
        ):
            cashflow -= BATTERY_REPLACEMENT_COST_AUD

        npv += cashflow / ((1.0 + DISCOUNT_RATE) ** year)

    npv_25_year = npv

    # ROI (use nominal total benefits, not discounted).
    # If you prefer ROI based on NPV, swap the formula to (npv / system_capex)*100.
    if system_capex > 0:
        total_nominal_benefits = 0.0
        for year in range(1, SYSTEM_LIFETIME_YEARS + 1):
            degradation_multiplier = (1.0 - PANEL_DEGRADATION_RATE) ** (year - 1)
            generation_kwh_year = annual_solar_generation_kwh * degradation_multiplier
            self_kwh_year = generation_kwh_year * self_consumption_ratio
            export_kwh_year = max(0.0, generation_kwh_year - self_kwh_year)

            price_multiplier = (1.0 + ELECTRICITY_PRICE_INFLATION_RATE) ** (year - 1)

            if tariff_rate is not None:
                bill_reduction_year = self_kwh_year * float(tariff_rate) * price_multiplier
            else:
                bill_reduction_year = 0.0

            export_revenue_year = export_kwh_year * float(feed_in_tariff) * price_multiplier
            total_nominal_benefits += bill_reduction_year + export_revenue_year

        roi_percent = (total_nominal_benefits - system_capex) / system_capex * 100.0
    else:
        roi_percent = None

    headline_insight = _build_headline(
        annual_bill_reduction=annual_bill_reduction,
        payback_years=payback_years,
    )

    return {
        "system_capex": system_capex,
        "annual_solar_generation_kwh": annual_solar_generation_kwh,
        "annual_self_consumption_kwh": annual_self_consumption_kwh,
        "annual_export_kwh": annual_export_kwh,
        "excess_export_kwh": excess_export_kwh,
        "has_excess_generation": has_excess_generation,
        "annual_savings": annual_savings,
        "annual_bill_reduction": annual_bill_reduction,
        "monthly_bill_reduction": monthly_bill_reduction,
        "payback_years": payback_years,
        "npv_25_year": npv_25_year,
        "roi_percent": roi_percent,
        "current_annual_spend": current_annual_spend,
        "projected_annual_spend": projected_annual_spend,
        "headline_insight": headline_insight,
    }


def _build_headline(*, annual_bill_reduction: float, payback_years: float | None) -> str:
    savings_txt = f"${annual_bill_reduction:,.0f}/year"
    if payback_years is None:
        return f"Your system saves {savings_txt}."
    return f"Your system saves {savings_txt} with {payback_years:.1f} year payback"


# -----------------------------
# Main test harness
# -----------------------------

def main() -> None:
    """
    Test end-to-end using:
      - bill_parser.py -> `test_bill.pdf`
      - solar_irradiance.py -> PVGIS for Kensington SA
      - sizing_engine.py -> recommended system sizes
    """
    budget = 15000.0
    wants_battery = True
    occupancy = "mixed"

    address = "53 Bishops Place, Kensington SA 5068"
    bill_path = "test_bill.pdf"

    try:
        bill_data = parse_bill(bill_path)
        solar_data = fetch_pvgis_profile(address, peakpower_kwp=6.6)
        sizing_data = size_system(
            bill_data=bill_data,
            solar_data=solar_data,
            budget=budget,
            wants_battery=wants_battery,
            occupancy=occupancy,
        )
        result = compute_financials(
            bill_data=bill_data, sizing_data=sizing_data, solar_data=solar_data
        )
        print(json.dumps(result, indent=2))
    except Exception as exc:
        print(f"Failed to run financial_model test: {exc}")


if __name__ == "__main__":
    main()

