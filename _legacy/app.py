"""
EnrgEngine — Solar + BESS Sizing Platform (Streamlit)

Accurate Solar + BESS sizing reports Australian installers can trust.

Run:
  streamlit run app.py
"""

from __future__ import annotations

import base64
import datetime as _dt
import io
import tempfile
import warnings
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

import bill_parser

# -----------------------------
# Brand palette
# -----------------------------
AMBER = "#FFB428"   # Primary — solar, highlights, bar charts
ORANGE = "#FF6B35"  # Secondary — CTAs, accents
BLUE = "#378ADD"    # Tertiary — battery, grid
DARK = "#090E1C"    # Page background
DARK2 = "#0F1628"   # Card / panel background
DARK3 = "#161E33"   # Nested card background
TEXT = "#F0F4FF"    # Primary text
MUTED = "rgba(240, 244, 255, 0.5)"
BORDER = "rgba(255, 255, 255, 0.08)"

# Logo extracted from ../ENRG-ENGINE-landing/index.html <nav> element.
# Falls back to SVG if missing.
try:
    _landing = (
        Path(__file__).parent.parent / "ENRG-ENGINE-landing" / "index.html"
    )
    import re as _re
    _html = _landing.read_text(encoding="utf-8")
    _m = _re.search(
        r'<nav[^>]*>.*?<img[^>]*src="(data:image/webp;base64,[^"]+)"',
        _html,
        _re.DOTALL,
    )
    LOGO_DATA_URI: str = _m.group(1) if _m else ""
except Exception:
    LOGO_DATA_URI = ""


# -----------------------------
# Formatting helpers (used by later prompts — keep)
# -----------------------------

def _fmt_money0(value: Any) -> str:
    """Format AUD amounts like $8,112."""
    try:
        if value is None:
            return "N/A"
        return f"${float(value):,.0f}"
    except Exception:
        return "N/A"


def _fmt_money_per_year(value: Any) -> str:
    v = _fmt_money0(value)
    return f"{v}/yr" if v != "N/A" else "N/A"


def _fmt_money_per_month(value: Any) -> str:
    v = _fmt_money0(value)
    return f"{v}/mo" if v != "N/A" else "N/A"


def _fmt_years_1(value: Any) -> str:
    """Format years like 4.1 yrs."""
    try:
        if value is None:
            return "N/A"
        return f"{float(value):.1f} yrs"
    except Exception:
        return "N/A"


def _fmt_years_word(value: Any) -> str:
    """Format years like 4.1 years (for table display)."""
    try:
        if value is None:
            return "N/A"
        return f"{float(value):.1f} years"
    except Exception:
        return "N/A"


def _fmt_pct_1(value: Any) -> str:
    """Format percent like 732.9%."""
    try:
        if value is None:
            return "N/A"
        return f"{float(value):.1f}%"
    except Exception:
        return "N/A"


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


# -----------------------------
# Internal display helpers
# -----------------------------

def _fmt_date_pretty(value: Any) -> str | None:
    """Render an ISO date (or best-effort date string) like '1 Jan 2025'."""
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d %b %Y", "%d %B %Y"):
        try:
            d = _dt.datetime.strptime(s, fmt).date()
            return f"{d.day} {d.strftime('%b %Y')}"
        except ValueError:
            continue
    return s


def _parse_date_any(value: Any) -> _dt.datetime | None:
    """Best-effort parse of a date/period string to a datetime, else None."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    for fmt in (
        "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d",
        "%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y",
        "%b %Y", "%B %Y", "%m/%Y", "%b %y", "%B %y",
    ):
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _plotly_dark_layout(fig: go.Figure, height: int) -> go.Figure:
    fig.update_layout(
        height=height,
        margin=dict(l=10, r=10, t=30, b=10),
        paper_bgcolor=DARK2,
        plot_bgcolor=DARK2,
        font=dict(color=TEXT),
        title_font=dict(color=TEXT),
        showlegend=False,
    )
    fig.update_xaxes(
        gridcolor=BORDER, zerolinecolor=BORDER, linecolor=BORDER,
        title_font=dict(color=TEXT), tickfont=dict(color=TEXT),
    )
    fig.update_yaxes(
        gridcolor=BORDER, zerolinecolor=BORDER, linecolor=BORDER,
        title_font=dict(color=TEXT), tickfont=dict(color=TEXT),
    )
    return fig


def _panel_open(title: str, source: str | None = None) -> None:
    badge = ""
    if source:
        badge = (
            f'<span style="color:{MUTED}; font-size:13px; font-weight:500;">'
            f"[source: {source}]</span>"
        )
    st.markdown(
        f"""
        <div style="
          background:{DARK2};
          border:1px solid {BORDER};
          border-radius:14px;
          padding:18px 22px;
          margin:14px 0 6px 0;
        ">
          <div style="display:flex; justify-content:space-between;
                      align-items:baseline; flex-wrap:wrap; gap:8px;
                      border-bottom:1px solid {BORDER}; padding-bottom:10px;
                      margin-bottom:12px;">
            {badge}
          </div>
        """,
        unsafe_allow_html=True,
    )


def _panel_close() -> None:
    st.markdown("</div>", unsafe_allow_html=True)


def _field_row(label: str, value: str) -> None:
    st.markdown(
        f"""
        <div style="display:flex; padding:6px 0; font-size:15px;">
          <span style="color:{MUTED}; width:200px; flex:0 0 200px;">{label}</span>
          <span style="color:{TEXT}; font-weight:600;">{value}</span>
        </div>
        """,
        unsafe_allow_html=True,
    )


def _panel_heading(text: str) -> None:
    """Syne ExtraBold panel heading — matches landing page H2 style."""
    st.markdown(
        f'<h2 style="font-family:\'Syne\',sans-serif;font-weight:800;'
        f'font-size:1.4rem;letter-spacing:-0.8px;line-height:1.2;'
        f'color:#EEF2FF;margin-bottom:1rem;">{text}</h2>',
        unsafe_allow_html=True,
    )


# -----------------------------
# Global styles (replaces _header)
# -----------------------------

def _set_global_styles() -> None:
    st.markdown(
        f"""
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500&display=swap');
          html, body, [class*="css"], .stMarkdown, .stTextInput, .stRadio,
          .stNumberInput, .stToggle, label, p, div {{
            font-family: 'DM Sans', sans-serif !important;
          }}
          .stApp {{
            background-color: #090E1C;
            background-image:
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
            background-size: 40px 40px;
          }}
          section[data-testid="stSidebar"] {{
            background:{DARK2};
            border-right:1px solid {BORDER};
          }}
          button[data-testid="baseButton-primary"] {{
            background: linear-gradient(135deg, #FFB428 0%, #FF6B35 100%) !important;
            color: #090E1C !important;
            border: 0 !important;
            border-radius: 8px !important;
            padding: 0.65rem 1.1rem !important;
            font-family: 'Syne', sans-serif !important;
            font-weight: 800 !important;
            font-size: 0.85rem !important;
            letter-spacing: 0.3px !important;
            width: 100% !important;
          }}
          button[data-testid="baseButton-primary"]:hover {{
            background: linear-gradient(135deg, #FF6B35 0%, #FFB428 100%) !important;
          }}
          button[data-testid="baseButton-secondary"] {{
            background: transparent !important;
            border: 1.5px solid #FFB428 !important;
            border-radius: 8px !important;
            color: #FFB428 !important;
            padding: 0.65rem 1.1rem !important;
            font-family: 'Syne', sans-serif !important;
            font-weight: 800 !important;
            font-size: 0.85rem !important;
            letter-spacing: 0.3px !important;
            width: 100% !important;
          }}
          button[data-testid="baseButton-secondary"]:hover {{
            background: rgba(255,180,40,0.08) !important;
          }}
          .accent {{
            color:{AMBER};
            font-weight:700;
          }}

          /* ── Tab bar ── */
          .stTabs [data-baseweb="tab-list"] {{
            border-bottom: 0.5px solid rgba(255,255,255,0.07);
            gap: 0;
            background: transparent;
          }}
          .stTabs [data-baseweb="tab"] {{
            font-family: 'DM Sans', sans-serif !important;
            font-weight: 500 !important;
            font-size: 12px !important;
            letter-spacing: 1.6px !important;
            text-transform: uppercase !important;
            color: rgba(238,242,255,0.45) !important;
            background: none !important;
            border: none !important;
            border-bottom: 2px solid transparent !important;
            padding: 0.85rem 1.5rem !important;
            margin-bottom: -1px;
            transition: color 0.2s, border-color 0.2s;
          }}
          .stTabs [data-baseweb="tab"]:hover {{
            color: rgba(238,242,255,0.75) !important;
          }}
          .stTabs [aria-selected="true"][data-baseweb="tab"] {{
            color: #FFB428 !important;
            border-bottom-color: #FFB428 !important;
            background: none !important;
          }}
          .stTabs [data-baseweb="tab-highlight"] {{
            display: none !important;
          }}

          /* ── Section divider ── */
          .enrg-section-divider {{
            border-top: 0.5px solid rgba(255,255,255,0.08);
            margin: 1.5rem 0 0 0;
          }}

          /* ── Input fields: frosted dark fill, rounded corners, amber focus ── */
          [data-testid="stTextInput"] > div,
          [data-testid="stNumberInput"] > div,
          [data-testid="stTextArea"] > div {{
            background-color: rgba(255,255,255,0.06) !important;
            border: 1px solid rgba(255,255,255,0.12) !important;
            border-radius: 8px !important;
            box-shadow: none !important;
          }}
          [data-testid="stTextInput"] input,
          [data-testid="stNumberInput"] input,
          [data-testid="stTextArea"] textarea {{
            background-color: transparent !important;
            color: #F0F4FF !important;
            -webkit-text-fill-color: #F0F4FF !important;
            border-radius: 8px !important;
            border: none !important;
            box-shadow: none !important;
          }}
          [data-testid="stTextInput"] input::placeholder,
          [data-testid="stNumberInput"] input::placeholder,
          [data-testid="stTextArea"] textarea::placeholder {{
            color: rgba(240,244,255,0.3) !important;
            -webkit-text-fill-color: rgba(240,244,255,0.3) !important;
          }}
          [data-testid="stTextInput"]:focus-within > div,
          [data-testid="stNumberInput"]:focus-within > div,
          [data-testid="stTextArea"]:focus-within > div {{
            border-color: #FFB428 !important;
            background-color: rgba(255,180,40,0.05) !important;
            box-shadow: none !important;
          }}
          [data-testid="stTextInput"] input:focus,
          [data-testid="stNumberInput"] input:focus,
          [data-testid="stTextArea"] textarea:focus {{
            outline: none !important;
            box-shadow: none !important;
          }}

          /* ── File uploader button ── */
          [data-testid="stFileUploaderDropzone"] button {{
            visibility: visible !important;
            background: linear-gradient(135deg, #FFB428 0%, #FF6B35 100%) !important;
            color: #090E1C !important;
            border: none !important;
            border-radius: 8px !important;
            font-family: 'Syne', sans-serif !important;
            font-weight: 800 !important;
            font-size: 0.85rem !important;
            padding: 0.5rem 1rem !important;
          }}

          /* ── Run Analysis — compact amber gradient ── */
          .run-btn > div > button {{
            background: linear-gradient(135deg, #FFB428 0%, #FF6B35 100%) !important;
            border: none !important;
            box-shadow: none !important;
            color: #090E1C !important;
            font-family: 'Syne', sans-serif !important;
            font-weight: 800 !important;
            font-size: 0.85rem !important;
            padding: 0.55rem 1.5rem !important;
            width: 100% !important;
            letter-spacing: 0.3px !important;
          }}
          .run-btn > div > button:hover {{
            background: linear-gradient(135deg, #FF6B35 0%, #FFB428 100%) !important;
          }}
        </style>
        """,
        unsafe_allow_html=True,
    )


def _render_header() -> None:
    logo_path = Path(__file__).parent / "Logo Transparent No Padding.svg"
    try:
        logo_b64 = base64.b64encode(logo_path.read_bytes()).decode()
        logo_img = (
            f'<img class="enrg-header-logo" '
            f'src="data:image/svg+xml;base64,{logo_b64}" />'
        )
    except Exception:
        # Fall back to PNG if SVG is missing
        try:
            png_path = Path(__file__).parent / "Transparent Logo.png"
            logo_b64 = base64.b64encode(png_path.read_bytes()).decode()
            logo_img = (
                f'<img class="enrg-header-logo" '
                f'src="data:image/png;base64,{logo_b64}" />'
            )
        except Exception:
            logo_img = ""

    st.markdown(
        f"""
        <style>
          .enrg-header-logo {{
            height: 70px !important;
            width: auto !important;
            display: block !important;
            flex-shrink: 0 !important;
          }}
        </style>
        <div style="
          display:flex;
          align-items:center;
          gap:20px;
          padding:1.2rem 0 1.4rem 0;
          border-bottom:0.5px solid rgba(255,255,255,0.07);
          margin-bottom:0.5rem;
        ">
          {logo_img}
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="
              font-family:'Syne',sans-serif;
              font-weight:800;
              font-size:32px;
              letter-spacing:-0.8px;
              color:#EEF2FF;
              line-height:1.1;
            ">ENRG ENGINE</span>
            <span style="
              font-family:'Syne',sans-serif;
              font-weight:700;
              font-size:17px;
              letter-spacing:-0.2px;
              line-height:1.3;
              background: linear-gradient(90deg,
                #FFB428 0%, #FFB428 22%,
                #FF6B35 29%, #FF6B35 57%,
                #378ADD 63%, #1A4A8C 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              background-clip: text;
            ">Accurate Solar + BESS sizing for Australian installers</span>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


# -----------------------------
# Input form (Tab 1)
# -----------------------------

def _section_heading(num: str, title: str, subtitle: str = "") -> None:
    """Landing page How It Works style — gradient number, Syne Bold title."""
    sub_html = (
        f'<p style="font-size:13px;color:rgba(240,244,255,0.5);'
        f'margin:0.3rem 0 0 0;font-weight:400;line-height:1.6;">{subtitle}</p>'
        if subtitle else ""
    )
    st.markdown(
        f"""
        <div style="
            border-top: 0.5px solid rgba(255,255,255,0.08);
            padding: 1.5rem 0 0.75rem 0;
            display: flex;
            flex-direction: column;
            gap: 0;
        ">
          <div style="display:flex;align-items:center;gap:1.5rem;">
            <span style="
                font-family:'Syne',sans-serif;
                font-weight:800;
                font-size:1rem;
                min-width:28px;
                background:linear-gradient(135deg,#FFB428,#FF6B35);
                -webkit-background-clip:text;
                -webkit-text-fill-color:transparent;
                background-clip:text;
            ">{num}</span>
            <span style="
                font-family:'Syne',sans-serif;
                font-weight:700;
                font-size:1.1rem;
                color:#EEF2FF;
            ">{title}</span>
          </div>
          {sub_html}
        </div>
        """,
        unsafe_allow_html=True,
    )



def _input_form() -> dict[str, Any]:

    # ── Section 1: Installer Profile ────────────────────────────────────────
    _section_heading(
        "01", "Installer Profile",
        "Your details appear on every PDF report. Fill in once — saved for this session.",
    )
    col_a, col_b = st.columns(2)
    with col_a:
        st.session_state["installer_name"] = st.text_input(
            "Your name",
            value=st.session_state.get("installer_name", ""),
            key="installer_name_input",
        )
        st.session_state["installer_phone"] = st.text_input(
            "Phone",
            value=st.session_state.get("installer_phone", ""),
            key="installer_phone_input",
        )
    with col_b:
        st.session_state["installer_company"] = st.text_input(
            "Company",
            value=st.session_state.get("installer_company", ""),
            key="installer_company_input",
        )
        st.session_state["installer_email"] = st.text_input(
            "Email",
            value=st.session_state.get("installer_email", ""),
            key="installer_email_input",
        )
    if st.button("Save Profile", key="save_installer_profile", type="primary"):
        st.session_state["installer_profile_saved"] = True
        st.success("Profile saved.")

    # ── Section 2: Customer & Site ───────────────────────────────────────────
    _section_heading("02", "Customer & Site")
    col1, col2 = st.columns(2)

    with col1:
        customer_name = st.text_input(
            "Customer name", value="", key="customer_name_input"
        )
        property_address = st.text_input(
            "Property address", value="", key="property_address_input"
        )
        postcode = st.text_input(
            "Postcode", value="", key="postcode_input"
        )
        st.markdown('<div style="height:0.5rem;"></div>', unsafe_allow_html=True)
        uploaded_files = st.file_uploader(
            "Upload electricity bills (PDF/image) or smart meter CSV",
            type=["pdf", "png", "jpg", "jpeg", "webp", "csv"],
            accept_multiple_files=True,
        )
        st.markdown('<div style="height:0.75rem;"></div>', unsafe_allow_html=True)
        st.markdown('<div class="run-btn">', unsafe_allow_html=True)
        submitted = st.button("Run Analysis", key="run_analysis", type="primary")
        st.markdown('</div>', unsafe_allow_html=True)

    with col2:
        budget = st.number_input(
            "Budget (AUD)", min_value=0.0, value=15000.0, step=500.0
        )
        st.markdown(
            '<p style="font-size:13px;color:rgba(240,244,255,0.6);'
            'margin:1rem 0 0.4rem 0;font-weight:500;'
            'letter-spacing:0.05em;text-transform:uppercase;">System type</p>',
            unsafe_allow_html=True,
        )
        if "system_type" not in st.session_state:
            st.session_state["system_type"] = "Solar + Battery"
        sys_cols = st.columns(3)
        for col, value in zip(sys_cols, ["Solar only", "Battery only", "Solar + Battery"]):
            with col:
                btn_type = "primary" if st.session_state["system_type"] == value else "secondary"
                if st.button(value, key=f"sys_{value}", type=btn_type, use_container_width=True):
                    st.session_state["system_type"] = value
                    st.rerun()
        system_type = st.session_state["system_type"]

        existing_solar_kw = 0.0
        if system_type == "Battery only":
            existing_solar_kw = st.number_input(
                "Existing system size (kW)",
                min_value=0.0, value=6.6, step=0.1,
                key="existing_solar_kw_input",
            )

        st.markdown('<div style="height:1rem;"></div>', unsafe_allow_html=True)
        st.markdown(
            '<p style="font-size:13px;color:rgba(240,244,255,0.6);'
            'margin:0 0 0.4rem 0;font-weight:500;'
            'letter-spacing:0.05em;text-transform:uppercase;">Occupancy</p>',
            unsafe_allow_html=True,
        )
        if "occupancy_card" not in st.session_state:
            st.session_state["occupancy_card"] = "Mixed"
        occ_cols = st.columns(3)
        for col, value in zip(occ_cols, ["Home all day", "Mixed", "Away during day"]):
            with col:
                btn_type = "primary" if st.session_state["occupancy_card"] == value else "secondary"
                if st.button(value, key=f"occ_{value}", type=btn_type, use_container_width=True):
                    st.session_state["occupancy_card"] = value
                    st.rerun()
        occ_label = st.session_state["occupancy_card"]

    wants_battery = system_type in ("Battery only", "Solar + Battery")
    existing_solar = system_type == "Battery only"
    occupancy = _occupancy_key(occ_label)

    return {
        "customer_name": customer_name.strip(),
        "property_address": property_address.strip(),
        "postcode": postcode.strip(),
        "occupancy": occupancy,
        "budget": float(budget),
        "wants_battery": bool(wants_battery),
        "existing_solar": bool(existing_solar),
        "existing_solar_kw": float(existing_solar_kw),
        "uploaded_files": uploaded_files or [],
        "submitted": bool(submitted),
    }


# -----------------------------
# PATH A — PDF / image bill
# -----------------------------

def _panel_bill_data(bill_data: dict, combined_stats: dict) -> None:
    # From the primary (most recent) bill.
    retailer = bill_data.get("retailer")
    plan_name = bill_data.get("plan_name")
    tariff_rate = bill_data.get("tariff_rate")
    feed_in = bill_data.get("feed_in_tariff")
    has_solar = bool(bill_data.get("has_solar"))
    nmi = bill_data.get("nmi")
    daily_supply = bill_data.get("daily_supply_charge")

    # Combined across all uploaded bills.
    c_days = combined_stats.get("billing_period_days")
    c_start = _fmt_date_pretty(combined_stats.get("billing_period_start"))
    c_end = _fmt_date_pretty(combined_stats.get("billing_period_end"))
    c_total = combined_stats.get("total_kwh")
    c_daily = combined_stats.get("daily_avg_kwh")
    c_annual = combined_stats.get("annual_spend")
    bill_count = combined_stats.get("bill_count") or 0

    source = f"{retailer} bill" if retailer else "Electricity bill"
    if c_end:
        source += f" — {c_end}"

    if tariff_rate is not None:
        tariff_txt = f"${float(tariff_rate):.2f} / kWh"
    else:
        tariff_txt = "Not found"

    if feed_in is not None:
        feed_txt = f"${float(feed_in):.2f} / kWh"
    else:
        feed_txt = "Not found"

    if c_days is not None and c_start and c_end:
        period_txt = f"{c_days} days ({c_start} - {c_end})"
    elif c_days is not None:
        period_txt = f"{c_days} days"
    else:
        period_txt = "Not found"

    total_txt = (
        f"{float(c_total):,.0f} kWh"
        if c_total not in (None, 0, 0.0)
        else ("0 kWh" if c_total == 0 else "Not found")
    )
    daily_txt = (
        f"{float(c_daily):.1f} kWh/day" if c_daily is not None else "Not found"
    )
    nmi_txt = nmi or "Not found"
    supply_txt = (
        f"${float(daily_supply):.2f} / day"
        if daily_supply is not None
        else "Not found"
    )

    e_comp = combined_stats.get("annual_energy_component")
    s_comp = combined_stats.get("annual_supply_component")
    annual_note = None
    if tariff_rate is None:
        annual_txt = "Not available"
    elif c_annual is not None:
        annual_txt = f"~${float(c_annual):,.0f} / year"
        if daily_supply is not None and e_comp is not None:
            annual_note = (
                f"(energy ~${float(e_comp):,.0f} "
                f"+ supply ~${float(s_comp or 0.0):,.0f})"
            )
        else:
            annual_note = (
                "(supply charge not found — estimate excludes daily supply)"
            )
    else:
        annual_txt = "Not found"

    _panel_heading("Bill Data")
    _panel_open("", source)
    if bill_count and c_start and c_end:
        st.markdown(
            f'<div style="color:{MUTED}; font-size:13px; margin:-4px 0 12px 0;">'
            f"Based on {bill_count} "
            f"bill{'s' if bill_count != 1 else ''} — {c_start} to {c_end}"
            f"</div>",
            unsafe_allow_html=True,
        )
    _field_row("Retailer:", retailer or "Not found")
    _field_row("Plan:", plan_name or "Not found")
    _field_row("NMI:", nmi_txt)
    _field_row("Tariff rate:", tariff_txt)
    _field_row("Feed-in tariff:", feed_txt)
    _field_row("Daily supply charge:", supply_txt)
    _field_row("Billing period:", period_txt)
    _field_row("Total usage:", total_txt)
    _field_row("Daily average:", daily_txt)
    _field_row("Annual spend:", annual_txt)
    if annual_note:
        st.markdown(
            f'<div style="color:{MUTED}; font-size:13px; '
            f'padding:0 0 4px 200px;">{annual_note}</div>',
            unsafe_allow_html=True,
        )
    _field_row("Existing solar:", "Yes" if has_solar else "No")
    _panel_close()


def _merge_bill_data(
    bill_data_list: list[dict],
) -> tuple[dict, list[dict], dict]:
    """Merge multiple parsed bills into primary dict + periods + stats.

    primary_bill_data: the most recently dated bill (highest
    billing_period_end). Falls back to the last item if no dates parse.

    combined_usage_periods: one entry per uploaded bill, using each bill's
    own billing period and precise meter-read total_kwh. Labels are
    formatted "Mon YY - Mon YY" from the ISO billing dates. historical_usage
    is intentionally NOT used here — those are imprecise visual estimates
    read off the bill's comparison chart. Deduplicated by label and sorted
    chronologically by the bill's ISO billing_period_start.

    combined_stats: aggregate stats across all bills — earliest start,
    latest end, span in days (date difference, not summed), summed
    total_kwh, daily average, estimated annual spend (using the primary
    bill's tariff), and bill count.
    """
    if not bill_data_list:
        return {}, [], {}

    primary = None
    best_end = None
    for b in bill_data_list:
        d = _parse_date_any(b.get("billing_period_end"))
        if d is not None and (best_end is None or d > best_end):
            best_end = d
            primary = b
    if primary is None:
        primary = bill_data_list[-1]

    # One entry per bill, from its own meter-read total_kwh.
    entries: list[tuple[_dt.datetime | None, int, dict]] = []
    for idx, b in enumerate(bill_data_list):
        total_kwh = b.get("total_kwh")
        if total_kwh is None:
            continue
        start_dt = _parse_date_any(b.get("billing_period_start"))
        end_dt = _parse_date_any(b.get("billing_period_end"))
        if start_dt is not None and end_dt is not None:
            label = (
                f"{start_dt.strftime('%b %y')} - {end_dt.strftime('%b %y')}"
            )
        else:
            label = "Unknown period"
        entries.append(
            (
                start_dt,
                idx,
                {
                    "period_label": label,
                    "kwh": total_kwh,
                    "days": b.get("billing_period_days"),
                },
            )
        )

    # Deduplicate by period_label (case-insensitive), keep first.
    seen: set = set()
    deduped: list[tuple[_dt.datetime | None, int, dict]] = []
    for start_dt, idx, e in entries:
        raw = e.get("period_label")
        key = raw.strip().lower() if isinstance(raw, str) else raw
        if key in seen:
            continue
        seen.add(key)
        deduped.append((start_dt, idx, e))

    # Sort chronologically by the bill's ISO billing_period_start; entries
    # without a parseable start date go last in original order.
    def _sort_key(item: tuple[_dt.datetime | None, int, dict]):
        start_dt, idx, _e = item
        if start_dt is None:
            return (1, _dt.datetime.max, idx)
        return (0, start_dt, idx)

    combined = [e for _, _, e in sorted(deduped, key=_sort_key)]

    # Combined stats across all bills.
    start_dts = [
        d
        for d in (
            _parse_date_any(b.get("billing_period_start"))
            for b in bill_data_list
        )
        if d is not None
    ]
    end_dts = [
        d
        for d in (
            _parse_date_any(b.get("billing_period_end"))
            for b in bill_data_list
        )
        if d is not None
    ]
    earliest = min(start_dts) if start_dts else None
    latest = max(end_dts) if end_dts else None

    total_kwh_sum = 0.0
    for b in bill_data_list:
        tk = b.get("total_kwh")
        if tk is not None:
            total_kwh_sum += float(tk)

    if earliest is not None and latest is not None:
        period_days = (latest - earliest).days
    else:
        period_days = None

    if period_days and period_days > 0:
        daily_avg = round(total_kwh_sum / period_days, 1)
    else:
        daily_avg = None

    tariff_rate = primary.get("tariff_rate")
    daily_supply = primary.get("daily_supply_charge")

    if tariff_rate is not None and daily_avg is not None:
        energy_component = daily_avg * float(tariff_rate) * 365
        supply_component = (
            float(daily_supply) * 365 if daily_supply else 0.0
        )
        annual_spend = energy_component + supply_component
    else:
        energy_component = None
        supply_component = None
        annual_spend = None

    combined_stats = {
        "billing_period_start": (
            earliest.strftime("%Y-%m-%d") if earliest is not None else None
        ),
        "billing_period_end": (
            latest.strftime("%Y-%m-%d") if latest is not None else None
        ),
        "billing_period_days": period_days,
        "total_kwh": total_kwh_sum,
        "daily_avg_kwh": daily_avg,
        "annual_spend": annual_spend,
        "annual_energy_component": energy_component,
        "annual_supply_component": supply_component,
        "bill_count": len(bill_data_list),
    }

    return primary, combined, combined_stats


def _panel_usage_history_from_bill(periods: list[dict]) -> None:
    rows = [
        p
        for p in (periods or [])
        if isinstance(p, dict) and p.get("kwh") is not None
    ]
    if not rows:
        return

    _panel_heading("Usage History (from bill)")
    _panel_open("")
    fig = go.Figure(
        data=[
            go.Bar(
                x=[p.get("period_label") for p in rows],
                y=[p.get("kwh") or 0 for p in rows],
                marker_color=AMBER,
                hovertemplate="%{x}<br>%{y:.0f} kWh<extra></extra>",
            )
        ]
    )
    fig.update_layout(
        height=350,
        plot_bgcolor=DARK2,
        paper_bgcolor=DARK2,
        font_color=TEXT,
        xaxis=dict(title="Billing period", tickangle=-30, gridcolor=BORDER),
        yaxis=dict(title="kWh consumed", gridcolor=BORDER),
        margin=dict(l=10, r=10, t=10, b=80),
        showlegend=False,
    )
    st.plotly_chart(fig, use_container_width=True)
    _panel_close()


# -----------------------------
# PATH B — CSV smart meter data
# -----------------------------

def _parse_csv_upload(uploaded_file) -> pd.DataFrame | None:
    """Parse a smart-meter CSV into a daily-aggregated DataFrame.

    Returns a DataFrame with columns ['date', 'kwh'] sorted by date, or None
    if the file cannot be interpreted.
    """
    try:
        raw = uploaded_file.getvalue()
        df = pd.read_csv(io.BytesIO(raw))
    except Exception:
        return None

    if df is None or df.empty or df.shape[1] < 2:
        return None

    dt_candidates = [
        "datetime", "date", "timestamp", "read date", "read_date",
        "interval_date", "interval date", "reading date",
    ]
    kwh_candidates = [
        "kwh", "consumption", "energy (kwh)", "general usage (kwh)",
        "usage", "import (kwh)", "value", "general supply (kwh)",
    ]

    lower_map = {str(c).strip().lower(): c for c in df.columns}

    def _try_datetime(series) -> pd.Series:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return pd.to_datetime(series, errors="coerce", dayfirst=True)

    # Step 1: detect datetime column.
    dt_col = None
    for name in dt_candidates:
        if name in lower_map:
            col = lower_map[name]
            parsed = _try_datetime(df[col])
            if parsed.notna().mean() >= 0.5:
                dt_col = col
                dt_series = parsed
                break
    if dt_col is None:
        for col in df.columns:
            parsed = _try_datetime(df[col])
            if parsed.notna().mean() >= 0.8:
                dt_col = col
                dt_series = parsed
                break
    if dt_col is None:
        return None

    # Step 2: detect kWh column.
    kwh_col = None
    for name in kwh_candidates:
        if name in lower_map and lower_map[name] != dt_col:
            kwh_col = lower_map[name]
            break
    if kwh_col is None:
        for col in df.columns:
            if col == dt_col:
                continue
            numeric = pd.to_numeric(df[col], errors="coerce")
            if numeric.notna().mean() >= 0.8:
                kwh_col = col
                break
    if kwh_col is None:
        return None

    work = pd.DataFrame(
        {
            "date": dt_series,
            "kwh": pd.to_numeric(df[kwh_col], errors="coerce"),
        }
    ).dropna()
    if work.empty:
        return None

    # Step 3: aggregate to daily totals (handles 30-min / hourly intervals).
    work["date"] = work["date"].dt.normalize()
    daily = (
        work.groupby("date", as_index=False)["kwh"].sum().sort_values("date")
    )
    if daily.empty:
        return None
    return daily.reset_index(drop=True)


def _panel_usage_data_from_csv(df: pd.DataFrame) -> None:
    start = df["date"].iloc[0]
    end = df["date"].iloc[-1]
    n_days = len(df)
    daily_avg = float(df["kwh"].mean())
    total = float(df["kwh"].sum())

    start_txt = f"{start.day} {start.strftime('%b %Y')}"
    end_txt = f"{end.day} {end.strftime('%b %Y')}"

    _panel_heading("Usage Data")
    _panel_open("", f"Smart meter CSV — {n_days} days")
    _field_row("Date range:", f"{start_txt} – {end_txt}")
    _field_row("Days of data:", f"{n_days} days")
    _field_row("Daily average:", f"{daily_avg:.1f} kWh/day")
    _field_row("Total consumption:", f"{total:,.0f} kWh")

    st.markdown(
        f'<div style="color:{MUTED}; font-size:13px; font-weight:700; '
        f'letter-spacing:0.1em; margin:14px 0 4px 0;">DAILY CONSUMPTION</div>',
        unsafe_allow_html=True,
    )
    fig = go.Figure(
        data=[
            go.Bar(
                x=df["date"],
                y=df["kwh"],
                marker_color=AMBER,
                hovertemplate="%{x|%-d %b %Y}: %{y:.1f} kWh<extra></extra>",
            )
        ]
    )
    fig.update_layout(xaxis_title="Date", yaxis_title="kWh/day")
    fig.update_xaxes(rangeslider=dict(visible=True), rangeslider_thickness=0.08)
    _plotly_dark_layout(fig, 350)
    st.plotly_chart(fig, use_container_width=True)
    _panel_close()


# -----------------------------
# Main
# -----------------------------

def _run_analysis(inputs: dict[str, Any]) -> None:
    """Process uploaded files and persist results to session_state.

    Shows warnings/errors and stops the script on invalid input. On
    success, shows a success message in the current (Tab 1) context.
    """
    files = inputs["uploaded_files"]
    if not files:
        st.warning("Please upload a bill or CSV first.")
        st.stop()
    if not inputs["property_address"]:
        st.warning("Please enter a property address.")
        st.stop()

    bill_files = [f for f in files if Path(f.name).suffix.lower() != ".csv"]
    csv_files = [f for f in files if Path(f.name).suffix.lower() == ".csv"]

    bill_data: dict | None = None
    interval_df: pd.DataFrame | None = None
    csv_daily_avg_kwh: float | None = None
    combined_usage_periods: list[dict] = []
    combined_stats: dict = {}
    upload_type: str | None = None

    if bill_files:
        if csv_files:
            st.warning(
                "Multiple file types detected — processing PDF bills "
                "only. Upload CSV separately for smart meter data."
            )
        parsed: list[dict] = []
        for f in bill_files:
            suffix = Path(f.name).suffix.lower()
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    suffix=suffix or ".pdf", delete=False
                ) as tmp:
                    tmp.write(f.getvalue())
                    tmp_path = tmp.name
                parsed.append(bill_parser.parse_bill(tmp_path))
            except Exception as exc:
                st.error(f"Could not read {f.name}: {exc}")
            finally:
                if tmp_path:
                    try:
                        Path(tmp_path).unlink(missing_ok=True)
                    except Exception:
                        pass
        if not parsed:
            st.stop()
        bill_data, combined_usage_periods, combined_stats = _merge_bill_data(
            parsed
        )
        upload_type = "pdf"
    elif csv_files:
        interval_df = _parse_csv_upload(csv_files[0])
        if interval_df is None:
            st.error(
                "⚠ Could not read this CSV. Expected columns: a date/time "
                "column and a kWh/consumption column. Try exporting your "
                "interval data from your retailer's app or portal."
            )
            st.stop()
        csv_daily_avg_kwh = float(interval_df["kwh"].mean())
        upload_type = "csv"

    st.session_state["customer_name"] = inputs["customer_name"]
    st.session_state["property_address"] = inputs["property_address"]
    st.session_state["postcode"] = inputs["postcode"]
    st.session_state["occupancy"] = inputs["occupancy"]
    st.session_state["budget"] = inputs["budget"]
    st.session_state["wants_battery"] = inputs["wants_battery"]
    st.session_state["existing_solar"] = inputs["existing_solar"]
    st.session_state["existing_solar_kw"] = inputs["existing_solar_kw"]
    st.session_state["upload_type"] = upload_type
    st.session_state["bill_data"] = bill_data
    st.session_state["interval_df"] = interval_df
    st.session_state["csv_daily_avg_kwh"] = csv_daily_avg_kwh
    st.session_state["combined_usage_periods"] = combined_usage_periods
    st.session_state["combined_stats"] = combined_stats

    st.success(
        "Analysis complete — view results in the Bill Data & Usage tab"
    )


def _render_results() -> None:
    upload_type = st.session_state.get("upload_type")
    bill_data = st.session_state.get("bill_data")

    if upload_type == "pdf":
        if not bill_data:
            st.info(
                "Upload your bills and click Run Analysis to see results."
            )
            return
        _panel_bill_data(
            bill_data, st.session_state.get("combined_stats") or {}
        )
        _panel_usage_history_from_bill(
            st.session_state.get("combined_usage_periods") or []
        )
    elif upload_type == "csv":
        df = st.session_state.get("interval_df")
        if df is not None:
            _panel_usage_data_from_csv(df)
        else:
            st.info(
                "Upload your bills and click Run Analysis to see results."
            )
    else:
        st.info("Upload your bills and click Run Analysis to see results.")


def main() -> None:
    st.set_page_config(page_title="EnrgEngine", layout="wide")
    _set_global_styles()
    _render_header()

    # Initialise installer profile session state keys.
    for key in ["installer_name", "installer_company", "installer_phone",
                "installer_email"]:
        if key not in st.session_state:
            st.session_state[key] = ""
    if "installer_profile_saved" not in st.session_state:
        st.session_state["installer_profile_saved"] = False

    tab1, tab2 = st.tabs(["Installer Inputs", "Bill Data & Usage"])

    with tab1:
        inputs = _input_form()
        if inputs["submitted"]:
            _run_analysis(inputs)

    with tab2:
        _render_results()


if __name__ == "__main__":
    main()
