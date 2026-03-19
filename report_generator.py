"""
PDF report generator for solar + battery sizing.

This module converts the outputs from:
  - bill_parser.py
  - solar_irradiance.py
  - sizing_engine.py
  - financial_model.py

into a professional PDF report using `reportlab`, with a matplotlib
bar chart embedded for monthly generation.
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
from dotenv import load_dotenv

load_dotenv()

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    Image as RLImage,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from bill_parser import parse_bill
from financial_model import compute_financials
from sizing_engine import size_system
from solar_irradiance import fetch_pvgis_profile


# -----------------------------
# Formatting helpers
# -----------------------------

ACCENT_COLOR = colors.HexColor("#FF6B35")
NAVY_COLOR = colors.HexColor("#1a1a2e")

def _sanitize_filename(s: str) -> str:
    # Remove characters that can break filenames on macOS/Windows.
    s = re.sub(r"[\\/:*?\"<>|]+", "_", s)
    s = s.strip()
    return s or "Customer"


def _safe_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _estimate_annual_usage_kwh(bill_data: dict[str, Any]) -> float | None:
    """
    Estimate annual usage kWh from bill_data.
    Mirrors the logic used in financial_model.
    """
    daily_avg = _safe_float(bill_data.get("daily_avg_kwh"))
    if daily_avg is not None and daily_avg > 0:
        return daily_avg * 365.0

    total_kwh = _safe_float(bill_data.get("total_kwh"))
    days = _safe_float(bill_data.get("billing_period_days"))
    if total_kwh is not None and days is not None and days > 0:
        return (total_kwh / days) * 365.0

    return None


def _closest_occupancy_label(self_consumption_ratio: Any) -> str:
    """
    Derive an occupancy label from the self-consumption ratio.
    Used for a human-friendly dispatch explanation.
    """
    try:
        r = float(self_consumption_ratio)
    except (TypeError, ValueError):
        return "mixed"

    ratios = {
        "home_all_day": 0.6,
        "mixed": 0.45,
        "away_during_day": 0.3,
    }
    return min(ratios.keys(), key=lambda k: abs(ratios[k] - r))


def _build_dispatch_strategy_text(
    self_consumption_ratio: Any,
    occupancy: str | None,
) -> str:
    ratio_map = {
        "home_all_day": "home_all_day (~60% self-consumption)",
        "mixed": "mixed (~45% self-consumption)",
        "away_during_day": "away_during_day (~30% self-consumption)",
    }

    if isinstance(occupancy, str) and occupancy.strip() in ratio_map:
        ratio_desc = ratio_map[occupancy.strip()]
    else:
        occupancy_label = _closest_occupancy_label(self_consumption_ratio)
        ratio_desc = ratio_map.get(
            occupancy_label, "mixed (~45% self-consumption)"
        )

    # Keep this brief but actionable.
    return (
        "Dispatch strategy (occupancy-aware):\n"
        f"- Usage profile: {ratio_desc}.\n"
        "- During daylight, solar is first used to meet household demand.\n"
        "- When generation exceeds on-site demand, the battery charges (if available).\n"
        "- When on-site demand exceeds solar, the battery discharges to cover the gap "
        "(up to its usable capacity), reducing grid imports."
    )


# -----------------------------
# Chart rendering
# -----------------------------

def _render_monthly_generation_chart(
    monthly_profile: list[float],
    solar_kw_recommended: float,
    base_kwp: float = 6.6,
) -> str:
    """
    Create a bar chart (PNG) and return the file path.

    PVGIS monthly_profile is produced for `base_kwp`; we scale it by:
      recommended solar / base_kwp
    """
    if not monthly_profile:
        # Still return a file so the report can render.
        monthly_profile = [0.0] * 12

    scale = 1.0
    if base_kwp > 0:
        scale = float(solar_kw_recommended) / float(base_kwp)

    months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ]
    values = [float(v) * scale for v in monthly_profile[:12]]
    if len(values) < 12:
        values += [0.0] * (12 - len(values))

    # Plot.
    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=150)
    ax.bar(months, values, color="#2E86AB")
    ax.set_title("Monthly Solar Generation (kWh)")
    ax.set_xlabel("Month")
    ax.set_ylabel("kWh")
    ax.grid(axis="y", linestyle="--", alpha=0.3)
    fig.tight_layout()

    # Save to a temp PNG so reportlab can embed it reliably.
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        fig.savefig(tmp.name, format="png")
    finally:
        plt.close(fig)

    return tmp.name


# -----------------------------
# Report generation
# -----------------------------

def generate_pdf_report(
    *,
    bill_data: dict[str, Any],
    solar_data: dict[str, Any],
    sizing_data: dict[str, Any],
    financial_data: dict[str, Any],
    customer_name: str,
    property_address: str,
) -> str:
    """
    Generate a PDF report and return the saved file path.
    """
    if not isinstance(customer_name, str) or not customer_name.strip():
        raise ValueError("customer_name must be a non-empty string.")
    if not isinstance(property_address, str) or not property_address.strip():
        raise ValueError("property_address must be a non-empty string.")

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleStyle",
        parent=styles["Title"],
        fontSize=18,
        leading=22,
        spaceAfter=10,
    )
    section_style = ParagraphStyle(
        "SectionStyle",
        parent=styles["Heading2"],
        textColor=ACCENT_COLOR,
        spaceBefore=10,
        spaceAfter=6,
    )
    header_title_style = ParagraphStyle(
        "HeaderTitleStyle",
        parent=styles["Title"],
        fontSize=26,
        leading=28,
        textColor=colors.white,
        alignment=0,  # left
        spaceAfter=2,
    )
    header_tagline_style = ParagraphStyle(
        "HeaderTaglineStyle",
        parent=styles["BodyText"],
        fontSize=10,
        leading=12,
        textColor=colors.white,
        spaceAfter=6,
    )
    header_property_style = ParagraphStyle(
        "HeaderPropertyStyle",
        parent=styles["BodyText"],
        fontSize=10,
        leading=12,
        textColor=colors.white,
    )

    footer_title_style = ParagraphStyle(
        "FooterTitleStyle",
        parent=styles["Heading3"],
        fontSize=12,
        leading=14,
        textColor=NAVY_COLOR,
        alignment=0,  # left
        spaceAfter=4,
    )

    small_style = ParagraphStyle(
        "SmallStyle",
        parent=styles["BodyText"],
        fontSize=10,
        leading=13,
    )

    annual_usage_kwh = _estimate_annual_usage_kwh(bill_data)
    daily_avg_kwh = _safe_float(bill_data.get("daily_avg_kwh"))
    tariff_rate = _safe_float(bill_data.get("tariff_rate"))

    solar_kw = _safe_float(sizing_data.get("solar_kw")) or 0.0
    battery_kwh = _safe_float(sizing_data.get("battery_kwh")) or 0.0
    system_cost = _safe_float(sizing_data.get("system_cost")) or 0.0

    headline_insight = financial_data.get("headline_insight") or "Estimate unavailable."
    annual_savings = _safe_float(financial_data.get("annual_savings")) or 0.0
    annual_bill_reduction = _safe_float(financial_data.get("annual_bill_reduction")) or 0.0
    monthly_bill_reduction = _safe_float(financial_data.get("monthly_bill_reduction")) or 0.0
    payback_years = financial_data.get("payback_years")
    npv_25_year = _safe_float(financial_data.get("npv_25_year"))
    roi_percent = financial_data.get("roi_percent")
    current_annual_spend = _safe_float(financial_data.get("current_annual_spend"))
    projected_annual_spend = _safe_float(financial_data.get("projected_annual_spend"))
    has_excess_generation = bool(financial_data.get("has_excess_generation"))
    excess_export_kwh = _safe_float(financial_data.get("excess_export_kwh")) or 0.0

    base_kwp = 6.6  # must match solar_irradiance.py default used in the pipeline

    # Monthly generation chart.
    chart_path = None
    try:
        monthly_profile = solar_data.get("monthly_profile") or []
        chart_path = _render_monthly_generation_chart(
            monthly_profile=monthly_profile,
            solar_kw_recommended=solar_kw,
            base_kwp=base_kwp,
        )

        # Output PDF filename.
        safe_name = _sanitize_filename(customer_name)
        output_filename = f"AppEng_Report_{safe_name}.pdf"
        output_path = str(Path.cwd() / output_filename)

        # Create PDF.
        doc = SimpleDocTemplate(output_path, pagesize=A4)
        story: list[Any] = []

        # -----------------------------
        # Header
        # -----------------------------
        header_banner = Table(
            [
                [Paragraph("AppEng.ai", header_title_style)],
                [
                    Paragraph(
                        "Applications Engineering for the Energy Transition",
                        header_tagline_style,
                    )
                ],
                [
                    Paragraph(
                        f"Property Address: {property_address}",
                        header_property_style,
                    )
                ],
            ],
            colWidths=[16.5 * cm],
        )
        header_banner.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), NAVY_COLOR),
                    ("BOX", (0, 0), (-1, -1), 0, NAVY_COLOR),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 12),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                    ("TOPPADDING", (0, 0), (-1, -1), 14),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
                ]
            )
        )
        story.append(header_banner)
        story.append(Spacer(1, 14))

        # -----------------------------
        # Headline insight box
        # -----------------------------
        story.append(Paragraph("Key Savings Summary", section_style))
        headline_table = Table(
            [
                [
                    Paragraph(
                        f"<font size=16><b>{headline_insight}</b></font>",
                        styles["BodyText"],
                    )
                ]
            ],
            colWidths=[16.5 * cm],
        )
        headline_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFE9E0")),
                    ("BOX", (0, 0), (-1, -1), 2.0, ACCENT_COLOR),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 12),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                    ("TOPPADDING", (0, 0), (-1, -1), 10),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ]
            )
        )
        story.append(headline_table)
        story.append(Spacer(1, 14))

        # -----------------------------
        # Energy profile section
        # -----------------------------
        story.append(Paragraph("Energy Profile", section_style))
        story.append(
            Paragraph(
                f"<b>Current annual usage:</b> {annual_usage_kwh:.0f} kWh/year"
                if annual_usage_kwh is not None
                else "<b>Current annual usage:</b> N/A",
                small_style,
            )
        )
        story.append(
            Paragraph(
                f"<b>Daily average:</b> {daily_avg_kwh:.2f} kWh/day"
                if daily_avg_kwh is not None
                else "<b>Daily average:</b> N/A",
                small_style,
            )
        )
        story.append(
            Paragraph(
                f"<b>Tariff rate:</b> {tariff_rate:.3f} AUD/kWh"
                if tariff_rate is not None
                else "<b>Tariff rate:</b> N/A",
                small_style,
            )
        )
        story.append(Spacer(1, 10))

        # -----------------------------
        # Recommended system section
        # -----------------------------
        story.append(Paragraph("Recommended System", section_style))
        story.append(
            Paragraph(
                f"<b>Solar size:</b> {solar_kw:.2f} kW<br/>"
                f"<b>Battery size:</b> {battery_kwh:.2f} kWh<br/>"
                f"<b>Estimated system cost:</b> ${system_cost:,.0f} AUD",
                small_style,
            )
        )
        story.append(Spacer(1, 12))

        # -----------------------------
        # Financial summary table
        # -----------------------------
        story.append(Paragraph("Financial Summary", section_style))
        payback_txt = (
            f"{payback_years:.1f} years" if isinstance(payback_years, (int, float)) else "N/A"
        )
        npv_txt = f"${npv_25_year:,.0f}" if npv_25_year is not None else "N/A"
        roi_txt = f"{float(roi_percent):.1f}%" if isinstance(roi_percent, (int, float)) else "N/A"
        financial_table_data = [
            ["Upfront system cost", f"${system_cost:,.0f}"],
            ["Annual savings", f"${annual_savings:,.0f}/year"],
            ["Monthly bill reduction", f"${monthly_bill_reduction:,.0f}/month"],
            ["Payback period", payback_txt],
            ["25-year NPV", npv_txt],
            ["ROI", roi_txt],
        ]

        financial_table = Table(financial_table_data, colWidths=[8.5 * cm, 8.0 * cm])
        financial_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F8F5")),
                    ("TEXTCOLOR", (0, 0), (-1, -1), colors.black),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#BDC3C7")),
                    ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#FDFEFE")]),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.append(financial_table)
        story.append(Spacer(1, 12))

        # -----------------------------
        # Monthly generation chart
        # -----------------------------
        story.append(Paragraph("Monthly Generation", section_style))
        if chart_path and os.path.exists(chart_path):
            story.append(RLImage(chart_path, width=16.5 * cm, height=7.0 * cm))
        else:
            story.append(Paragraph("Monthly generation chart unavailable.", small_style))
        story.append(Spacer(1, 12))

        # -----------------------------
        # Dispatch strategy section
        # -----------------------------
        story.append(Paragraph("Dispatch Strategy", section_style))
        dispatch_text = _build_dispatch_strategy_text(
            sizing_data.get("self_consumption_ratio"),
            sizing_data.get("occupancy"),
        )
        # reportlab Paragraph doesn't support plain newlines well; convert to <br/>
        dispatch_html = dispatch_text.replace("\n", "<br/>")
        story.append(Paragraph(dispatch_html, small_style))
        story.append(Spacer(1, 10))

        # -----------------------------
        # Extra small note: projected spend
        # -----------------------------
        if current_annual_spend is not None and projected_annual_spend is not None:
            story.append(
                Paragraph(
                    f"<b>Projected annual spend:</b> ${projected_annual_spend:,.0f} AUD "
                    f"(from ${current_annual_spend:,.0f})",
                    small_style,
                )
            )
            if has_excess_generation:
                story.append(
                    Paragraph(
                        f"System generates {excess_export_kwh:,.0f} kWh more than current annual usage.",
                        small_style,
                    )
                )
                story.append(
                    Paragraph(
                        "Tip: Consider switching to a plan with a feed-in tariff to earn "
                        "export income on excess generation.",
                        small_style,
                    )
                )

        story.append(Spacer(1, 18))

        # -----------------------------
        # Footer (static text)
        # -----------------------------
        story.append(Paragraph("AppEng.ai", footer_title_style))
        story.append(
            Paragraph(
                f"Contact: <font color='{ACCENT_COLOR}'><b>support@appeng.ai</b></font><br/>"
                "Disclaimer: This report is an estimation tool only. "
                "Actual bills and solar performance may vary due to tariff structures, "
                "weather, system orientation, and regulatory changes.",
                small_style,
            )
        )

        # Build the PDF.
        doc.build(story)

        return output_path
    finally:
        # Clean up temp chart file.
        if chart_path and os.path.exists(chart_path):
            try:
                os.remove(chart_path)
            except OSError:
                # Not fatal; leave it if it cannot be removed.
                pass


def generate_report(
    *,
    bill_data: dict[str, Any],
    solar_data: dict[str, Any],
    sizing_data: dict[str, Any],
    financial_data: dict[str, Any],
    customer_name: str,
    property_address: str,
) -> str:
    """
    Backwards-compatible alias for generate_pdf_report().

    The Streamlit app uses this name for the download button.
    """
    return generate_pdf_report(
        bill_data=bill_data,
        solar_data=solar_data,
        sizing_data=sizing_data,
        financial_data=financial_data,
        customer_name=customer_name,
        property_address=property_address,
    )


# -----------------------------
# End-to-end pipeline test
# -----------------------------

def main() -> None:
    """
    Run the full pipeline for Kensington SA and generate a report.

    Note: this requires network access for geocoding + PVGIS, and Claude if
    `test_bill.pdf` is not pre-processed.
    """
    customer_name = "Kirti Mistry"
    property_address = "53 Bishops Place, Kensington SA 5068"

    budget = 15000.0
    wants_battery = True
    occupancy = "mixed"

    try:
        # 1) Parse the bill (PDF)
        bill_data = parse_bill("test_bill.pdf")

        # 2) Fetch solar profile for the property address
        solar_data = fetch_pvgis_profile(property_address)

        # 3) Size system within budget
        sizing_data = size_system(
            bill_data=bill_data,
            solar_data=solar_data,
            budget=budget,
            wants_battery=wants_battery,
            occupancy=occupancy,
        )

        # 4) Compute financials (year 1..25)
        financial_data = compute_financials(
            bill_data=bill_data, sizing_data=sizing_data, solar_data=solar_data
        )

        # 5) Generate report
        pdf_path = generate_pdf_report(
            bill_data=bill_data,
            solar_data=solar_data,
            sizing_data=sizing_data,
            financial_data=financial_data,
            customer_name=customer_name,
            property_address=property_address,
        )
        print(pdf_path)
    except Exception as exc:
        # In dev environments, Claude auth / network access may be unavailable.
        # For styling verification, fall back to synthetic data and still
        # generate a PDF so the report layout changes can be confirmed.
        print(f"Failed to generate report: {exc}")

        try:
            bill_data = {
                # Provide daily_avg_kwh so the sizing + financial model can run.
                "daily_avg_kwh": 12.0,
                "tariff_rate": 0.32,  # AUD/kWh
                "feed_in_tariff": 0.08,  # AUD/kWh
            }
            # PVGIS-style synthetic values for monthly generation.
            solar_data = {
                "annual_kwh_per_kwp": 1650.0,
                "peak_sun_hours": 4.6,
                "monthly_profile": [
                    120.0,
                    105.0,
                    95.0,
                    85.0,
                    75.0,
                    65.0,
                    70.0,
                    85.0,
                    95.0,
                    110.0,
                    120.0,
                    130.0,
                ],
            }

            sizing_data = size_system(
                bill_data=bill_data,
                solar_data=solar_data,
                budget=budget,
                wants_battery=wants_battery,
                occupancy=occupancy,
            )
            financial_data = compute_financials(
                bill_data=bill_data, sizing_data=sizing_data, solar_data=solar_data
            )
            pdf_path = generate_pdf_report(
                bill_data=bill_data,
                solar_data=solar_data,
                sizing_data=sizing_data,
                financial_data=financial_data,
                customer_name=customer_name,
                property_address=property_address,
            )
            print(pdf_path)
        except Exception as fallback_exc:
            print(f"Failed to generate fallback report: {fallback_exc}")


if __name__ == "__main__":
    main()

