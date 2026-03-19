"""
AppEng.ai — Solar & Battery Sizing Platform (Streamlit)

Run:
  streamlit run app.py
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

from bill_parser import parse_bill
from financial_model import calculate_financials
from report_generator import generate_report
from sizing_engine import size_system
from solar_irradiance import fetch_pvgis_profile


NAVY = "#1a1a2e"
ORANGE = "#FF6B35"


def _header() -> None:
    """Top banner."""
    st.markdown(
        f"""
        <div style="
          background:{NAVY};
          padding:18px 20px;
          border-radius:12px;
          margin-bottom: 16px;
        ">
          <div style="color:white; font-size:30px; font-weight:800; line-height:1.1;">
            AppEng.ai
          </div>
          <div style="color:white; opacity:0.92; margin-top:6px; font-size:13px;">
            Applications Engineering for the Energy Transition
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def _set_global_styles() -> None:
    """Streamlit CSS tweaks for navy/orange theme and clean layout."""
    st.markdown(
        f"""
        <style>
          .stButton>button {{
            background: {ORANGE};
            color: white;
            border: 0;
            border-radius: 10px;
            padding: 0.6rem 1.1rem;
            font-weight: 700;
          }}
          .stButton>button:hover {{
            background: #ff5a1f;
            color: white;
          }}
          .accent {{
            color: {ORANGE};
            font-weight: 700;
          }}
          .teaser-blur {{
            filter: blur(3px);
            opacity: 0.55;
            user-select: none;
            pointer-events: none;
          }}
          .box {{
            border: 2px solid {ORANGE};
            background: #ffe9e0;
            padding: 14px 16px;
            border-radius: 12px;
          }}
        </style>
        """,
        unsafe_allow_html=True,
    )


def _occupancy_key(label: str) -> str:
    mapping = {
        "Home all day": "home_all_day",
        "Mixed": "mixed",
        "Away during day": "away_during_day",
    }
    return mapping[label]


def _scaled_monthly_generation(
    monthly_profile: list[float], solar_kw: float, base_kwp: float = 6.6
) -> list[float]:
    if not monthly_profile:
        monthly_profile = [0.0] * 12
    scale = (solar_kw / base_kwp) if base_kwp > 0 else 1.0
    values = [float(v) * scale for v in monthly_profile[:12]]
    if len(values) < 12:
        values += [0.0] * (12 - len(values))
    return values


def _dispatch_strategy_text(occupancy: str, wants_battery: bool) -> str:
    occ_map = {
        "home_all_day": "Home all day",
        "mixed": "Mixed",
        "away_during_day": "Away during day",
    }
    occ = occ_map.get(occupancy, occupancy)
    if not wants_battery:
        return (
            f"Occupancy profile: {occ}. Solar is first used to meet daytime demand; "
            "any excess is exported to the grid."
        )
    return (
        f"Occupancy profile: {occ}. Solar is first used to meet daytime demand; "
        "excess solar charges the battery. In the evening / peak times, the battery "
        "discharges to reduce grid imports."
    )


def _run_pipeline(
    *,
    uploaded_bytes: bytes,
    uploaded_suffix: str,
    address: str,
    budget: float,
    wants_battery: bool,
    occupancy: str,
) -> dict[str, Any]:
    """Run bill → PVGIS → sizing → financials."""
    with tempfile.NamedTemporaryFile(suffix=uploaded_suffix, delete=False) as tmp:
        tmp.write(uploaded_bytes)
        bill_path = tmp.name

    try:
        bill_data = parse_bill(bill_path)
    finally:
        try:
            Path(bill_path).unlink(missing_ok=True)
        except Exception:
            pass

    solar_data = fetch_pvgis_profile(address, peakpower_kwp=6.6)
    sizing_data = size_system(
        bill_data=bill_data,
        solar_data=solar_data,
        budget=budget,
        wants_battery=wants_battery,
        occupancy=occupancy,
    )
    financial_data = calculate_financials(
        bill_data=bill_data, sizing_data=sizing_data, solar_data=solar_data
    )

    return {
        "bill_data": bill_data,
        "solar_data": solar_data,
        "sizing_data": sizing_data,
        "financial_data": financial_data,
    }


def _page_customer_input() -> None:
    _header()
    st.subheader("Customer Input Form")

    col1, col2 = st.columns([1, 1])
    with col1:
        uploaded = st.file_uploader(
            "Upload your energy bill (PDF or image)",
            type=["pdf", "png", "jpg", "jpeg", "webp"],
        )
        address = st.text_input("Property address", value="")
        budget = st.number_input(
            "Budget (AUD)", min_value=0.0, value=15000.0, step=500.0
        )

    with col2:
        occ_label = st.radio(
            "Occupancy",
            options=["Home all day", "Mixed", "Away during day"],
            index=1,
            horizontal=False,
        )
        wants_battery = st.toggle("Include battery storage?", value=True)

        existing_solar = st.toggle("Existing solar?", value=False)
        existing_solar_kw = 0.0
        if existing_solar:
            existing_solar_kw = st.number_input(
                "Existing solar size (kW)",
                min_value=0.0,
                value=6.6,
                step=0.1,
            )

    submitted = st.button("Submit")

    if submitted:
        if uploaded is None:
            st.error("Please upload a bill (PDF or image).")
            return
        if not address.strip():
            st.error("Please enter a property address.")
            return

        occupancy = _occupancy_key(occ_label)
        st.session_state["occupancy"] = occupancy
        st.session_state["wants_battery"] = wants_battery
        st.session_state["budget"] = float(budget)
        st.session_state["property_address"] = address.strip()
        st.session_state["existing_solar"] = bool(existing_solar)
        st.session_state["existing_solar_kw"] = float(existing_solar_kw)

        with st.spinner("Analysing your energy profile..."):
            try:
                suffix = Path(uploaded.name).suffix.lower() or ".pdf"
                results = _run_pipeline(
                    uploaded_bytes=uploaded.getvalue(),
                    uploaded_suffix=suffix,
                    address=address.strip(),
                    budget=float(budget),
                    wants_battery=bool(wants_battery),
                    occupancy=occupancy,
                )
            except Exception as exc:
                st.error(f"Analysis failed: {exc}")
                return

        if existing_solar and existing_solar_kw > 0:
            results["sizing_data"]["existing_solar_kw"] = float(existing_solar_kw)

        st.session_state["results"] = results
        st.session_state["stage"] = "teaser"
        st.rerun()


def _page_teaser() -> None:
    _header()
    st.subheader("Teaser results (before payment)")

    results = st.session_state.get("results") or {}
    sizing = results.get("sizing_data") or {}
    financial = results.get("financial_data") or {}

    solar_kw = float(sizing.get("solar_kw") or 0.0)
    battery_kwh = float(sizing.get("battery_kwh") or 0.0)
    payback = financial.get("payback_years")
    annual_savings = float(financial.get("annual_savings") or 0.0)

    c1, c2, c3 = st.columns(3)
    with c1:
        st.metric("Recommended system", f"{solar_kw:.1f} kW + {battery_kwh:.1f} kWh")
    with c2:
        st.metric(
            "Payback period",
            f"{payback:.1f} yrs" if isinstance(payback, (int, float)) else "N/A",
        )
    with c3:
        st.metric("Annual savings", f"${annual_savings:,.0f}/yr")

    st.markdown("<div class='box'>", unsafe_allow_html=True)
    unlock = st.button("Unlock Full Report — $99 AUD")
    st.markdown("</div>", unsafe_allow_html=True)

    st.markdown("#### What you’ll unlock")
    st.markdown(
        """
        <div class="teaser-blur">
          <ul>
            <li>Full financial breakdown</li>
            <li>25-year projection</li>
            <li>Dispatch strategy</li>
            <li>Monthly generation chart</li>
          </ul>
        </div>
        """,
        unsafe_allow_html=True,
    )

    cols = st.columns([1, 1])
    with cols[0]:
        if st.button("Back to form"):
            st.session_state["stage"] = "input"
            st.rerun()
    with cols[1]:
        if unlock:
            st.session_state["stage"] = "full"
            st.session_state["paid"] = False
            st.rerun()


def _page_full_report() -> None:
    _header()
    st.subheader("Full report (after payment)")

    if not st.session_state.get("paid", False):
        st.info("Stripe integration is skipped for now.")
        if st.button("Simulate Payment"):
            st.session_state["paid"] = True
            st.rerun()
        return

    results = st.session_state.get("results") or {}
    bill = results.get("bill_data") or {}
    solar = results.get("solar_data") or {}
    sizing = results.get("sizing_data") or {}
    financial = results.get("financial_data") or {}

    solar_kw = float(sizing.get("solar_kw") or 0.0)
    battery_kwh = float(sizing.get("battery_kwh") or 0.0)
    system_cost = float(sizing.get("system_cost") or 0.0)

    st.markdown("### Recommended system")
    a, b, c = st.columns(3)
    a.metric("Solar", f"{solar_kw:.1f} kW")
    b.metric("Battery", f"{battery_kwh:.1f} kWh")
    c.metric("Estimated cost", f"${system_cost:,.0f} AUD")

    st.markdown("### Financial summary")
    table = {
        "Upfront system cost (AUD)": financial.get("system_capex"),
        "Annual savings (AUD/yr)": financial.get("annual_savings"),
        "Monthly bill reduction (AUD/mo)": financial.get("monthly_bill_reduction"),
        "Payback (years)": financial.get("payback_years"),
        "25-year NPV (AUD)": financial.get("npv_25_year"),
        "ROI (%)": financial.get("roi_percent"),
        "Current annual spend (AUD)": financial.get("current_annual_spend"),
        "Projected annual spend (AUD)": financial.get("projected_annual_spend"),
    }
    st.table({k: [v] for k, v in table.items()})

    if bool(financial.get("has_excess_generation")):
        excess = float(financial.get("excess_export_kwh") or 0.0)
        st.warning(
            f"System generates {excess:,.0f} kWh more than current annual usage.\n\n"
            "Tip: Consider switching to a plan with a feed-in tariff to earn export income "
            "on excess generation."
        )

    st.markdown("### Monthly generation chart")
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    monthly = _scaled_monthly_generation(
        monthly_profile=list(solar.get("monthly_profile") or []),
        solar_kw=solar_kw,
        base_kwp=6.6,
    )
    fig = go.Figure(data=[go.Bar(x=months, y=monthly, marker_color=ORANGE)])
    fig.update_layout(
        height=380,
        margin=dict(l=10, r=10, t=30, b=10),
        title="Monthly Solar Generation (kWh)",
        xaxis_title="Month",
        yaxis_title="kWh",
    )
    st.plotly_chart(fig, use_container_width=True)

    st.markdown("### Dispatch strategy")
    st.write(
        _dispatch_strategy_text(
            st.session_state.get("occupancy", "mixed"),
            st.session_state.get("wants_battery", True),
        )
    )

    st.markdown("### Download PDF report")
    customer_name = st.text_input("Customer name", value="Kirti Mistry")
    property_address = st.session_state.get(
        "property_address", "53 Bishops Place, Kensington SA 5068"
    )

    if st.button("Generate PDF"):
        try:
            pdf_path = generate_report(
                bill_data=bill,
                solar_data=solar,
                sizing_data=sizing,
                financial_data=financial,
                customer_name=customer_name,
                property_address=property_address,
            )
            pdf_bytes = Path(pdf_path).read_bytes()
            st.download_button(
                "Download PDF",
                data=pdf_bytes,
                file_name=Path(pdf_path).name,
                mime="application/pdf",
            )
        except Exception as exc:
            st.error(f"PDF generation failed: {exc}")

    if st.button("Back to teaser"):
        st.session_state["stage"] = "teaser"
        st.rerun()


def main() -> None:
    st.set_page_config(page_title="AppEng.ai — Sizing Platform", layout="wide")
    _set_global_styles()

    if "stage" not in st.session_state:
        st.session_state["stage"] = "input"

    stage = st.session_state["stage"]
    if stage == "input":
        _page_customer_input()
    elif stage == "teaser":
        _page_teaser()
    else:
        _page_full_report()


if __name__ == "__main__":
    main()
