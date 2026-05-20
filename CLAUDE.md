# CLAUDE.md — EnrgEngine Platform

> Read this file at the start of every session. It contains everything you need to
> understand the project, avoid breaking things, and build features correctly.

> ⚠️ MIGRATION IN PROGRESS — May 2026
>
> The platform is migrating from Streamlit to FastAPI + Next.js + Tailwind CSS + shadcn/ui.
> `app.py` is legacy code — do not add new features to it.
> Python modules (bill_parser.py, sizing_engine.py, financial_model.py, solar_irradiance.py,
> database.py, nem_data.py) are being retained as FastAPI endpoints — do not modify their
> function signatures or data contracts without explicit instruction.
> See docs/BUILD_SEQUENCE.md Phase 0 for the migration build order.

---

## What This Project Is

EnrgEngine is an **accurate, unbiased Solar + BESS sizing and financial justification tool**
for Australian solar installers. It is NOT a persuasion tool — it produces accurate numbers
specific to the customer's actual tariff, their postcode's network constraints, and the
mathematically optimal system size for their situation.

**Positioning in one line:** "Accurate Solar + BESS sizing reports your customers can trust."

**The workflow:**
```
Customer inquiry
      ↓
Installer uploads bill + enters site details
      ↓
EnrgEngine: bill parse → PVGIS irradiance → MILP sizing → financial model
      ↓
Interactive dashboard shows all results — installer verifies numbers live
      ↓
"Generate Report" → white-label PDF downloaded
```

**Build philosophy:** Dashboard-first. Every feature is built as a live display panel
on the Streamlit dashboard first. The installer (and developer) can see and verify all
data immediately. The PDF report is built last — it just renders data that is already
verified on the dashboard.

---

## How to Run Locally

The platform is migrating to FastAPI + Next.js. Until migration is complete, the legacy
Streamlit app can be run for reference only — do not build new features here.

```bash
# Legacy Streamlit (reference only)
pip install -r requirements.txt
streamlit run app.py  # runs at http://localhost:8501
```

New platform run instructions will replace this section once Phase 0 scaffolding is complete:
- FastAPI backend: `uvicorn main:app --reload` (target: http://localhost:8000)
- Next.js frontend: `npm run dev` (target: http://localhost:3000)

---

## Environment Variables

All secrets live in `.env` (FastAPI backend, local dev). Never use `st.secrets` — the
Streamlit layer is being removed. **Never hardcode API keys. Never commit .env to git.**

FastAPI backend access pattern:
```python
import os
from dotenv import load_dotenv
load_dotenv()
api_key = os.getenv("ANTHROPIC_API_KEY")
```

Next.js frontend secrets live in `.env.local` (prefixed `NEXT_PUBLIC_` for client-side,
unprefixed for server-side only). Never expose Supabase service keys to the client.

Required variables (backend `.env`):
```
ANTHROPIC_API_KEY=...          # Claude Vision for bill parsing — stay on Claude Vision, do NOT use Mistral
SUPABASE_URL=...               # Supabase project URL
SUPABASE_ANON_KEY=...          # Supabase anon/public key
GOOGLE_SOLAR_API_KEY=...       # Google Solar API — Phase 2
SOLCAST_API_KEY=...            # Solcast irradiance — Phase 2
SENTRY_DSN=...                 # Sentry error tracking — set up at migration start
```

Supabase connection:
```python
from supabase import create_client
url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_ANON_KEY")
supabase = create_client(url, key)
```

---

## File Structure

```
app.py                  # Streamlit UI — dashboard-first, single-page layout
bill_parser.py          # Claude Vision bill parsing → structured dict
sizing_engine.py        # Solar + battery sizing (heuristic Phase 1, MILP Phase 2)
financial_model.py      # Financial KPIs — payback, NPV, ROI, savings
solar_irradiance.py     # PVGIS API integration for solar production data
nem_data.py             # NEM-specific: DNSP limits, tariff library, STC, VPP (to build)
database.py             # Supabase persistence (replaces old Firebase version)
requirements.txt        # Python dependencies
.env                    # Local secrets (gitignored)
```

**Do not use or modify:**
- `report_generator.py` — PDF generation is Phase 3. Ignore this file entirely for now.
- `calculator.py` — Dead code. Delete from repo.

---

## Data Contracts — What Each Module Returns

### `bill_parser.parse_bill(file_path: str) → dict`
```python
{
    "billing_period_days": int | None,
    "billing_period_start": str | None,   # ISO date YYYY-MM-DD
    "billing_period_end": str | None,     # ISO date YYYY-MM-DD
    "total_kwh": float | None,
    "daily_avg_kwh": float | None,
    "tariff_rate": float | None,          # AUD per kWh (e.g. 0.32)
    "feed_in_tariff": float,              # AUD per kWh, defaults to 0.0
    "annual_spend": float | None,         # AUD, extrapolated
    "retailer": str | None,
    "plan_name": str | None,
    "historical_usage": list[dict],       # [{period_label, kwh, days}, ...]
    "has_solar": bool,                    # defaults to False
    "nmi": str | None,                   # National Metering Identifier (10-11 digits)
    "daily_supply_charge": float | None, # AUD per day (e.g. 1.12)
}
```
**Note:** `tariff_rate` is in AUD/kWh (NOT cents). If the bill shows cents, the parser
converts automatically. Always check for None before using.

### `solar_irradiance.fetch_pvgis_profile(address, peakpower_kwp=6.6) → dict`
```python
{
    "latitude": float,
    "longitude": float,
    "annual_kwh_per_kwp": float | None,   # kWh/year per kW installed
    "peak_sun_hours": float | None,       # avg daily peak sun hours
    "monthly_profile": list[float],       # 12 values, kWh/month for peakpower_kwp system
}
```
**Note:** `monthly_profile` is for a `peakpower_kwp`-sized system (default 6.6kW).
To scale to a different system size: `value * (solar_kw / 6.6)`. See `app.py →
_scaled_monthly_generation()`.

### `sizing_engine.size_system(bill_data, solar_data, budget, wants_battery, occupancy) → dict`
```python
{
    "solar_kw": float,
    "battery_kwh": float,
    "self_consumption_ratio": float,        # effective ratio (0..1)
    "assumed_self_consumption_ratio": float, # occupancy-based input assumption
    "occupancy": str,                        # "home_all_day" | "mixed" | "away_during_day"
    "system_cost": float,                    # AUD
    "annual_solar_generation_kwh": float,
    "within_budget": bool,
}
```
**Current state:** Simple heuristic model (not true MILP yet). `solar_kw` is stepped
in 0.1kW increments to maximise annual kWh served within budget. Battery is sized from
daily surplus. This is the primary module to upgrade — replace heuristic with MILP.

### `financial_model.calculate_financials(bill_data, sizing_data, solar_data) → dict`
```python
{
    "system_capex": float,
    "annual_solar_generation_kwh": float,
    "annual_self_consumption_kwh": float,
    "annual_export_kwh": float,
    "excess_export_kwh": float,
    "has_excess_generation": bool,
    "annual_savings": float,              # bill_reduction + export_revenue
    "annual_bill_reduction": float,       # grid import savings only
    "monthly_bill_reduction": float,
    "payback_years": float | None,
    "npv_25_year": float,
    "roi_percent": float | None,
    "current_annual_spend": float,
    "projected_annual_spend": float,      # clamped to 0 minimum
    "headline_insight": str,
}
```
**Known issue:** `projected_annual_spend` shows $0 when savings exceed current spend.
This is mathematically correct but misleading in the UI. Fix: show "Bill eliminated +
$X export income" instead of "$0 projected spend."

### `report_generator.generate_report(...) → str`
Returns the file path to the generated PDF. Alias for `generate_pdf_report()`.
Takes: `bill_data`, `solar_data`, `sizing_data`, `financial_data`, `customer_name`,
`property_address`.

### `database.save_report(report_data: dict) → str`
Saves to Supabase `reports` table. Returns the record ID. Adds `created_at`
automatically. If Supabase is unavailable, raises an exception — caller must catch.

---

## Current App Flow (app.py)

Single-page dashboard. No stages, no paywall, no sidebar.

**Tab layout:**
- Tab 1 "Installer Inputs" — all user inputs: installer profile (collapsible
  expander at top), customer name, property address, bill upload, occupancy,
  budget, wants_battery. Run Analysis button at the bottom.
- Tab 2 "Bill Data & Usage" — outputs only: bill data panel + usage history
  chart. Shown after analysis runs.
- Future tabs: all additional output panels added here as Phase 1 continues.

**Key functions:**
- `_set_global_styles()` — Google Fonts (Syne + DM Sans), brand CSS, Streamlit
  tab overrides, fixed nav bar HTML with base64 WebP logo extracted from
  `../ENRG-ENGINE-landing/index.html`
- `_merge_bill_data(bill_data_list)` — returns (primary_bill_data,
  combined_usage_periods, combined_stats). Uses each bill's own
  billing_period_start / end / total_kwh only — NOT historical_usage from bill
  visual charts (those are imprecise estimates, not meter reads)
- `_panel_bill_data(primary_bill_data, combined_stats)` — combined stats for
  usage fields; primary bill for tariff / retailer / NMI; annual spend breakdown
  showing energy component + supply component separately
- `_panel_usage_history_from_bill(combined_usage_periods)` — vertical Plotly
  bar chart, one bar per uploaded bill, amber bars, dark background
- `_input_form()` — Tab 1 layout: installer profile expander at top, then
  customer + bill inputs below
- `_render_results()` — Tab 2 layout
- `main()` — st.tabs(["Installer Inputs", "Bill Data & Usage"])

**Annual spend formula:**
```
energy_component  = daily_avg_kwh × tariff_rate × 365
supply_component  = daily_supply_charge × 365
annual_spend      = energy_component + supply_component
```
Both components stored separately in combined_stats as `annual_energy_component`
and `annual_supply_component` for display in the bill data panel.

---

## Brand & Design System

Apply these everywhere — Streamlit UI, matplotlib charts, reportlab PDF.
No exceptions. No matplotlib defaults visible in any output.

```python
AMBER  = "#FFB428"   # Primary accent — solar, positive outcomes, highlights
ORANGE = "#FF6B35"   # Secondary accent — CTAs, export, secondary data series
BLUE   = "#378ADD"   # Tertiary — battery, grid, neutral data series
DARK   = "#090E1C"   # Page background
DARK2  = "#0F1628"   # Card / panel background
DARK3  = "#161E33"   # Nested card background
TEXT   = "#F0F4FF"   # Primary text
MUTED  = "rgba(240, 244, 255, 0.5)"  # Secondary text
BORDER = "rgba(255, 255, 255, 0.08)" # Subtle borders
```

**Typography:**
- Headings / logo: Syne ExtraBold (Syne-ExtraBold.ttf)
- Body: DM Sans Regular / Medium
- In matplotlib/reportlab: embed font files or use closest available

**PDF report rules:**
- Installer logo top-left on every page (white-label)
- Installer name, company, phone, email in header
- Customer name on cover and header
- No "EnrgEngine", "AppEng", or "AppEng.ai" visible anywhere in the output
- White background for PDF (light theme) — not dark mode
- Brand colours on all charts, section headers, accent elements

---

## What's Already Branding Wrong (Fix These)

The existing code has OLD branding. When touching these files, fix:

| File | Old value | Replace with |
|------|-----------|--------------|
| `app.py` | `"AppEng.ai"` in header | `"EnrgEngine"` |
| `app.py` | `NAVY = "#1a1a2e"`, `ORANGE = "#FF6B35"` only | Full brand palette above |
| `report_generator.py` | `"AppEng.ai"` in footer | Remove — PDF is white-label, no engine branding |
| `report_generator.py` | `ACCENT_COLOR = "#FF6B35"`, `NAVY_COLOR = "#1a1a2e"` | Full palette above |
| `report_generator.py` | `ax.bar(..., color="#2E86AB")` | Use `AMBER` |
| `report_generator.py` | `support@appeng.ai` in footer | `info@enrgengine.com` |

---

## Rules Claude Code Must Always Follow

1. **Never hardcode API keys.** Use `os.getenv("KEY_NAME")` with `load_dotenv()` for
   local, and `st.secrets["KEY_NAME"]` for Streamlit Cloud paths.

2. **Never modify `calculator.py`.** It's a legacy file and is not used by the app.

3. **Never break the data contracts.** If you change what a function returns, update
   every caller. The pipeline is: `bill_parser` → `sizing_engine` → `financial_model`
   → `report_generator`. Each consumes the previous module's output dict directly.

4. **Always use Plotly for dashboard charts.** Matplotlib is for PDF only. Dashboard
   charts use `st.plotly_chart()` with brand colours. Never add matplotlib charts to
   the Streamlit UI.

5. **Never add a paywall or payment gate.** The old `"teaser"` stage simulated this.
   It is being removed. The new architecture gives installers full access immediately.

6. **Dashboard-first.** Every new feature must display its output on the dashboard
   before any PDF work begins. The PDF is built after the dashboard data is verified.

7. **Fail gracefully.** Supabase errors must not block the user flow — catch and warn,
   never crash. PVGIS timeouts must surface a user-friendly message, not a stack trace.

8. **All new Streamlit inputs → `st.session_state`.** Never store user inputs in local
   variables only — they won't survive a rerun.

9. **Do not touch `sizing_engine.py` unless the prompt explicitly says to.** It is the
   most complex module and changes cascade. Treat it as read-only unless scoped.

10. **When in doubt about scope, do less and flag it.** Add a `# TODO:` comment and
    tell Mayur what you skipped rather than guessing and introducing bugs.

---

## Feature Roadmap (Build Order)

Build in this order. Do not skip ahead. Each step depends on the previous.

### Phase 1 — Foundation (current priority)
| # | Feature | Files | Status |
|---|---------|-------|--------|
| 1 | Rebrand app.py to EnrgEngine | `app.py` | DONE |
| 2 | Bill parser dashboard panel | `app.py` | DONE |
| 3 | Installer profile inputs (UI + session state) | `app.py` | IN PROGRESS |
| 3b | Installer profile Supabase persistence | `app.py`, `database.py` | TODO |
| 4 | Customer + site inputs | `app.py` | TODO |
| 5 | PVGIS + solar irradiance panel | `app.py` | TODO |
| 6 | Sizing results panel | `app.py` | TODO |
| 7 | Financial model panel | `app.py` | TODO |
| 8 | DNSP export limit lookup | new `nem_data.py` | TODO |
| 9 | SA tariff library | new `nem_data.py` | TODO |
| 10 | STC calculation | new `nem_data.py` | TODO |

### Phase 2 — Accuracy upgrades
| # | Feature | Files |
|---|---------|-------|
| 11 | True MILP sizing (replace heuristic) | `sizing_engine.py` |
| 12 | Split solar / battery ROI | `financial_model.py` |
| 13 | TOU tariff dispatch modelling | `sizing_engine.py`, `nem_data.py` |
| 14 | Interval data upload | `app.py`, new `interval_data.py` |
| 15 | Google Solar API roof data | new `roof_data.py` |

### Phase 3 — Report
| # | Feature | Files |
|---|---------|-------|
| 16 | Rebrand PDF to EnrgEngine white-label | `report_generator.py` |
| 17 | Apply brand colours to all PDF charts | `report_generator.py` |
| 18 | Add installer branding to PDF | `report_generator.py` |
| 19 | Add VPP/REPS eligibility section to PDF | `report_generator.py`, `nem_data.py` |
| 20 | 25-year cash flow chart in PDF | `report_generator.py` |

### Phase 4 — Polish
| # | Feature |
|---|---------|
| 21 | Interactive Plotly sliders (system size sensitivity) |
| 22 | Month-by-month dispatch chart |
| 23 | Tariff comparison ("switch to X, save Y") |
| 24 | Equipment recommendation section |

---

## Testing Checklist (Run After Any Change)

- [ ] `streamlit run app.py` — app loads without errors
- [ ] Upload a test bill PDF → parsed data appears correctly
- [ ] Address lookup works → PVGIS data returns
- [ ] Sizing runs and displays sensible kW / kWh values
- [ ] Financial panel shows non-zero, non-negative values
- [ ] No "AppEng" or "AppEng.ai" text visible anywhere in UI
- [ ] No matplotlib default blue (#1f77b4) visible in any chart
- [ ] Supabase save succeeds (or warning shown gracefully on failure)

**Test addresses:**
- `53 Bishops Place, Kensington SA 5068` — existing test address, constrained DNSP zone
- `1 King William Street, Adelaide SA 5000` — CBD, standard export limit

**Test retailers:**
- AGL (TOU), Origin Energy (flat), Amber Electric (spot — edge case)

---

## Known Issues / Tech Debt

| Issue | File | Priority |
|-------|------|----------|
| `sizing_engine.py` uses heuristic, not true MILP | `sizing_engine.py` | Phase 2 |
| `projected_annual_spend` shows $0 misleadingly | `financial_model.py`, `app.py` | Phase 1 |
| PDF chart uses default matplotlib blue | `report_generator.py` | Phase 3 |
| Installer profile session-state only — no Supabase persistence yet | `database.py` | Phase 1 (Prompt 3b) |
| `calculator.py` is dead code, not connected | `calculator.py` | Ignore |
| Financial model blends solar+battery ROI | `financial_model.py` | Phase 2 |

---

## Deployment

**Platform frontend:** Next.js on Vercel — migration target
- `git push` to `main` → Vercel auto-deploys
- Environment variables set in Vercel project dashboard

**Platform backend:** FastAPI on Railway — migration target
- Deployed as a Python service
- Environment variables set in Railway project dashboard
- Do not push `.env` or any credentials file

**Landing page:** HTML/CSS/JS on Netlify — live, unchanged
- Repo: separate `ENRG-ENGINE-landing` git repo
- Auto-deploys from `main` on push

**Legacy (reference only):**
- Streamlit Cloud repo: `mayurmistry82/AppEng---Platform`
- URL: `appeng-platform.streamlit.app`
- Do not push new features to this deployment — it is being retired
