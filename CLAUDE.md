# CLAUDE.md — EnrgEngine Platform

> Read this file at the start of every session. It contains everything you need to
> understand the project, avoid breaking things, and build features correctly.

> ✅ MIGRATION COMPLETE — June 2026
>
> The platform has migrated from Streamlit to **FastAPI + Next.js 15 (App Router) +
> Tailwind CSS + shadcn/ui**. Phase 0 scaffolding is done; the dashboard is built as
> Next.js panels backed by FastAPI routes.
> `app.py` and `report_generator.py` are **legacy Streamlit-era code** — do not read them
> for current behaviour and do not add features to them. The live code is under `backend/`
> and `frontend/`.
> The retained Python modules (`bill_parser.py`, `sizing_engine.py`, `financial_model.py`,
> `solar_irradiance.py`, `database.py`, `capture.py`, `nem_data.py` when built) live under
> `backend/` and are wired as FastAPI routes — do not modify their function signatures or
> data contracts without explicit instruction.
>
> **Authoritative build status / roadmap:** `docs/PROGRESS.md` (what's built),
> `docs/features.md` (feature list + status), `docs/BUILD_SEQUENCE.md` (ordered prompts).
> This file is the stable project guide; those three are the live state.

---

## What This Project Is

EnrgEngine is an **accurate, unbiased Solar + BESS sizing and financial justification tool**
for Australian solar installers. It is NOT a persuasion tool — it produces accurate numbers
specific to the customer's actual tariff, their postcode's network constraints, and the
mathematically optimal system size for their situation.

**Positioning in one line:** "Accurate Solar + BESS sizing reports your customers can trust."

**The workflow:** *(address-anchored — full design in `docs/2026-06-12-workflow-IA-design.md`)*
```
Customer inquiry
      ↓
Installer enters the property address (→ roof geometry + PVGIS irradiance resolve)
      ↓
Adds usage (bill upload / interval CSV / load survey) + tariff + objective
      ↓
EnrgEngine: roof + per-plane generation → solar optimiser → battery LP → bottom-up cost
      ↓
Living-worksheet dashboard — installer verifies live + tunes inputs (A/B what-if)
      ↓
Save job  ·  "Generate Report" → white-label PDF
```

**Build philosophy:** API-first, then dashboard. Each feature is built as a FastAPI endpoint
returning a verified JSON response, then surfaced as a Next.js panel where the installer (and
developer) can see and verify all data immediately. The PDF report renders data already proven
correct on the dashboard.

---

## How to Run Locally

```bash
# Backend (FastAPI)
cd backend && uvicorn main:app --reload      # http://localhost:8000

# Frontend (Next.js 15)
cd frontend && npm run dev                   # http://localhost:3000
```

Legacy Streamlit (`app.py`) is retired — reference only, do not run for current behaviour.

---

## Environment Variables

Backend secrets live in `backend/.env` (local dev) and in the Railway dashboard (deploy).
Frontend secrets live in `frontend/.env.local`. **Never hardcode API keys. Never commit
`.env`. Never expose the Supabase service-role key to the client.**

FastAPI backend access pattern:
```python
import os
from dotenv import load_dotenv
load_dotenv()
api_key = os.getenv("ANTHROPIC_API_KEY")
```

**`backend/.env` is the only env file the backend reads.** `load_dotenv()` resolves from the
calling module's own directory, and every loader lives in `backend/`, so it always lands there
regardless of where uvicorn is launched from. Verified 2026-08-11 (**F40**). Do not add a second
`.env` higher up the tree — only the retired `_legacy/` scripts would ever resolve to one.

Required — the backend does not work without these five:
```
ANTHROPIC_API_KEY=...           # Claude Vision for bill parsing — stay on Claude Vision, do NOT use Mistral
SUPABASE_URL=...                # Supabase project URL
SUPABASE_ANON_KEY=...           # Supabase anon/public key
SUPABASE_SERVICE_ROLE_KEY=...   # Server-side only — PII writes + capture-table access (added D4). NEVER expose to client.
GOOGLE_MAPS_API_KEY=...         # Google Solar API — roof geometry. THIS name, not GOOGLE_SOLAR_API_KEY (roof_geometry.py reads GOOGLE_MAPS_API_KEY)
```

Optional — absent is fine, the code degrades deliberately:
```
SENTRY_DSN=...                  # Sentry error tracking; init is skipped silently when unset
SOLCAST_API_KEY=...             # NOT YET USED — Solcast irradiance is checklist 10.6, a Phase 2 upgrade
```

**Missing `SUPABASE_SERVICE_ROLE_KEY` fails loudly by design.** `auth.py` refuses to fall back to
the anon key — company lookups would silently return nothing and 403 everyone with no obvious
cause — so it logs an error and every identity-dependent request returns **503** until the key is
set. A 503 storm on a fresh machine means this key, not a broken endpoint.

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(client-side, prefixed). Server-side-only secrets stay unprefixed.

Supabase connection (backend; prefers the service-role key where available):
```python
from supabase import create_client
url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
supabase = create_client(url, key)
```

---

## File Structure

```
backend/
  main.py               # FastAPI app — CORS, route registration, health check
  routes/               # API endpoints (bill, solar, sizing, financial, load, job, report, nem)
  bill_parser.py        # Claude Vision bill parsing → structured dict (+ structured tariff, D2)
  sizing_engine.py      # Solar + battery sizing — MILP/optimiser (Phase 1 accuracy core; heuristic being replaced). See PROGRESS.md "Solar Sizing Rebuild"
  financial_model.py    # Financial KPIs — payback, NPV, ROI, savings
  solar_irradiance.py   # PVGIS API integration for solar production data
  nem_data.py           # NEM-specific: DNSP lookup + export limits + FiT defaults (built); STC / tariff library / VPP to come
  database.py           # Supabase persistence (reports, installer profiles)
  capture.py            # ML data-flywheel write layer (D1–D5) — best-effort, never raises
  requirements.txt      # Python dependencies
  .env                  # Local backend secrets (gitignored)

frontend/
  app/dashboard/        # inputs / outputs / report / workflow pages (App Router)
  components/panels/    # one component per dashboard panel
  components/           # NavTabs, RunAnalysisButton, JobAutoSave, etc.
  lib/store.ts          # Zustand in-session state (billData, customerInputs, solarData, sizingData, ...)
  lib/api.ts            # typed fetch client for all backend endpoints
  lib/plotly-theme.ts   # ENRG Plotly layout/config (amber/dark brand)
  .env.local            # Frontend secrets (gitignored)
```

**Legacy — do not use or modify:**
- `app.py` — legacy Streamlit UI. Superseded by `frontend/`. Reference only.
- `report_generator.py` — legacy. The live PDF is `backend/routes/report.py` (ReportLab).
- `calculator.py` — dead code, not connected.

---

## Data Contracts — What Each Module Returns

The retained Python modules keep their contracts. The pipeline is
`bill_parser` → `sizing_engine` → `financial_model` → report. Do not break a contract
without updating every caller.

### `bill_parser.parse_bill(file_path: str) → dict`
```python
{
    "billing_period_days": int | None,
    "billing_period_start": str | None,   # ISO date YYYY-MM-DD
    "billing_period_end": str | None,     # ISO date YYYY-MM-DD
    "total_kwh": float | None,
    "daily_avg_kwh": float | None,
    "tariff_rate": float | None,          # AUD per kWh (e.g. 0.32) — scalar, retained
    "feed_in_tariff": float,              # AUD per kWh, defaults to 0.0
    "annual_spend": float | None,         # AUD, extrapolated
    "retailer": str | None,
    "plan_name": str | None,
    "historical_usage": list[dict],       # [{period_label, kwh, days}, ...]
    "has_solar": bool,                    # defaults to False
    "nmi": str | None,                    # National Metering Identifier (10-11 digits)
    "daily_supply_charge": float | None,  # AUD per day (e.g. 1.12)
    # --- added in D2 (structured-tariff extension) ---
    "tariff_structured": dict,            # {tariff_type, supply_charge, tou_windows[], demand_charges[], controlled_load[], block_tiers[], fit_tiers[]} — never None
    "parse_confidence": dict,             # {field: 0.0-1.0}
    "field_provenance": dict,             # {field: "extracted" | "default"}
    "parser_version": str,                # e.g. "2026-06-10-structured-tariff-v2"
}
```
**Note:** `tariff_rate` is in AUD/kWh (NOT cents) and is retained unchanged for downstream
callers; `tariff_structured` is the richer object (TOU windows etc.). The bill upload route
also returns `raw_file_path` (private `bills` Storage bucket). Always check for None.

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
**Note:** `monthly_profile` is for a `peakpower_kwp`-sized system (default 6.6kW). To scale to
a different system size, multiply by `(solar_kw / 6.6)` (done in the Solar panel on the frontend).

### `sizing_engine.size_system(bill_data, solar_data, budget, wants_battery, occupancy) → dict`
```python
{
    "solar_kw": float,
    "battery_kwh": float,
    "self_consumption_ratio": float,         # effective ratio (0..1)
    "assumed_self_consumption_ratio": float, # occupancy-based input assumption
    "occupancy": str,                        # "home_all_day" | "mixed" | "away_during_day"
    "system_cost": float,                    # AUD
    "annual_solar_generation_kwh": float,
    "within_budget": bool,
}
```
**Current state:** Being rebuilt from the legacy heuristic to the accurate MILP/optimiser
pipeline as the **Phase 1 accuracy core** (see `docs/PROGRESS.md` "Solar Sizing Rebuild" and
`docs/2026-06-04-solar-sizing-build-plan.md`). **MILP is Phase 1, not Phase 2.** Do not treat
the heuristic as the target — the MILP pipeline is. Solar sized first, battery second.

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
Mathematically correct but misleading in the UI. Fix: show "Bill eliminated + $X export
income" instead of "$0 projected spend."

### `database.save_report(report_data: dict) → str`
Saves to Supabase `reports` table. Returns the record ID, adds `created_at`. If Supabase is
unavailable it raises — the caller must catch.

### `capture.py` (ML data-flywheel write layer — D1–D5)
`save_job`, `save_bill`, `save_tariff`, `save_survey`, `save_load_profile`,
`save_solar_resource`, `save_sizing_result`, `save_financial_result`, `save_correction`.
Each takes a dict, writes one row, returns a pk or `None`. **Best-effort: never raises** —
a failed capture never blocks the user flow. Strategy: `docs/2026-06-05-ml-data-flywheel-plan.md`.

---

## Current Architecture

Next.js dashboard backed by FastAPI routes; in-session state in a Zustand store; persisted
data in Supabase. Plotly.js for all charts. **Panel-by-panel detail (what each panel does,
which route it calls, known fixes) is maintained in `docs/PROGRESS.md` — read it for current
state.** High level:

- `frontend/app/dashboard/` — `inputs` (all input panels + Run Analysis), `outputs` (result
  panels), `report` (Report Builder), `workflow` (informational flowchart).
- `frontend/components/panels/` — one component per panel (Installer Profile, Bill, Customer &
  Site, Solar, Sizing, Load Profile/Survey, Financial, Network, Incentives).
- `frontend/lib/store.ts` — Zustand: `billData`, `customerInputs`, `solarData`, `sizingData`,
  load/survey results, `jobId`, `trainingConsent`, `pendingCorrections`, `assembleJobPayload()`.
- `backend/routes/` — one module per endpoint; each catches exceptions and returns a safe JSON
  error, never a traceback.

**Annual spend formula (business logic — unchanged):**
```
energy_component  = daily_avg_kwh × tariff_rate × 365
supply_component  = daily_supply_charge × 365
annual_spend      = energy_component + supply_component
```
Energy and supply components are stored/displayed separately in the bill data panel.

---

## Brand & Design System

Apply everywhere — Next.js UI, charts, ReportLab PDF. No exceptions. No Plotly/matplotlib
defaults visible in any output.

**`docs/DESIGN.md` is the source of truth for every design token.** The block below is a mirror
for Python code (ReportLab) that cannot read CSS variables. Do not edit it here — change
DESIGN.md, then mirror. Frontend code binds to semantic CSS tokens, never to these hexes.

```python
BLUE   = "#378ADD"   # PRIMARY action colour — buttons, links, focus ring, "sized" status
AMBER  = "#FFB428"   # Brand HIGHLIGHT only — active nav, accuracy meter, selected. Used sparingly.
ORANGE = "#FF6B35"   # WARNING colour + export / secondary data series
GREEN  = "#2EBD85"   # Success
RED    = "#E5484D"   # Error / destructive
DARK   = "#090E1C"   # Page background
DARK2  = "#111A2E"   # Card / panel surface
DARK3  = "#16203A"   # Popover / nested surface
TEXT   = "#EEF2F9"   # Primary text
MUTED  = "#6F7F9F"   # Secondary text, captions, chart axes
BORDER = "#283450"   # Card / input borders
```

Amber is NEVER the warning colour and NEVER the primary action colour — orange is the warning,
blue is the action. Light + dark modes both ship; the values above are the dark mode, see
DESIGN.md for light. The four-stop brand gradient is for brand moments only — never on buttons,
cards, or panels.

**Typography:**
- Brand display only (`hero-xl` / `hero` / `hero-sub`): Syne ExtraBold 800 (Syne-ExtraBold.ttf)
- Everything else — `display`, H1–H3, body, UI, labels, numbers: Inter (400/500/600/700/900)
- All numbers use tabular figures + slashed zero
- In ReportLab PDF: embed font files or use the closest available

**PDF report rules:**
- Installer logo top-left on every page (white-label)
- Installer name, company, phone, email in header
- Customer name on cover and header
- No "EnrgEngine", "AppEng", or "AppEng.ai" visible anywhere in the output
- White background for PDF (light theme) — not dark mode
- Brand colours on all charts, section headers, accent elements

> Branding is implemented in the live stack (`frontend/` + `backend/routes/report.py`). The old
> `app.py` / `report_generator.py` "AppEng.ai" branding is legacy and not used — ignore it
> unless explicitly asked to touch a legacy file (you shouldn't need to).

---

## Rules Claude Code Must Always Follow

1. **Never hardcode API keys.** Use `os.getenv("KEY_NAME")` with `load_dotenv()` (backend) and
   `process.env` (Next.js). Never expose the Supabase service-role key to the client.

2. **Never modify legacy files** (`app.py`, `report_generator.py`, `calculator.py`) — they are
   not part of the live stack.

3. **Never break the data contracts.** If you change what a function returns, update every
   caller. Pipeline: `bill_parser` → `sizing_engine` → `financial_model` → report.

4. **recharts is the chart standard** (PROGRESS decision #25, 2026-06-23). **Plotly is reserved
   for heavy technical charts only** — the 8,760-hour series and the 7×24 heatmap — with brand
   colours via `lib/plotly-theme.ts` (`react-plotly.js`, SSR disabled). ReportLab is for the
   PDF only.

5. **Never add a paywall or payment gate.** Installers get full access immediately. (Premium
   gating is a separate, later subscription concern — see OPEN_ITEMS.md.)

6. **API-first, dashboard-first.** Build the endpoint with a verified JSON response, surface it
   as a panel, verify on screen — before any PDF work.

7. **Fail gracefully.** Supabase errors must not block the user flow — catch and warn, never
   crash. External API timeouts (PVGIS, Google Solar, Energy Made Easy) must surface a
   user-friendly message, not a stack trace. Capture writes are best-effort and never block.

8. **All frontend in-session state → the Zustand store (`lib/store.ts`).** Never keep user
   inputs in component-local state only where they need to survive navigation.

9. **Do not touch `sizing_engine.py` unless the prompt explicitly says to.** It is the most
   complex module and changes cascade. Treat it as read-only unless scoped.

10. **When in doubt about scope, do less and flag it.** Add a `# TODO:` comment and tell Mayur
    what you skipped rather than guessing and introducing bugs.

---

## Feature Roadmap (Build Order)

> **Authoritative, live status is in `docs/PROGRESS.md`, `docs/features.md`, and
> `docs/BUILD_SEQUENCE.md`.** The summary below is orientation only — do not treat its phase
> labels or file columns as current (many features are now built as `backend/routes/*` +
> `frontend/components/panels/*`, not in `app.py`).

- **Phase 0 — Migration (DONE):** FastAPI + Next.js + Supabase Auth scaffold.
- **Phase 1 — Foundation & accuracy core (current):** dashboard panels (installer profile,
  bill, customer/site, solar, sizing, load, financial, network, incentives), `nem_data` (DNSP
  limits / tariff library / STC), the **Solar Sizing Rebuild** (heuristic → **MILP/optimiser —
  MILP is Phase 1**), and the ML data-capture layer (D1–D5, built). Pre-beta: PII hardening +
  consent (see OPEN_ITEMS.md).
- **Phase 2 — Accuracy upgrades:** split solar/battery ROI, TOU dispatch modelling, interval
  data upload, Solcast irradiance, Google Solar roof data.
- **Phase 3 — Report:** white-label PDF polish, brand charts, installer branding, VPP/REPS
  section, 25-year cash-flow chart.
- **Phase 4 — Polish:** interactive sliders, dispatch chart, tariff comparison, equipment
  section. Plus the AI-agents accuracy layer (built at end of Phase 1 after MILP — see
  `docs/2026-06-10-ai-agents-plan.md`).

---

## Testing Checklist (Run After Any Change)

- [ ] Backend starts: `cd backend && uvicorn main:app --reload` — no errors; `GET /api/health` OK
- [ ] Frontend starts: `cd frontend && npm run dev` — dashboard loads
- [ ] Upload a test bill PDF → parsed data appears correctly in the Bill panel
- [ ] Address lookup works → PVGIS data returns
- [ ] Sizing runs and displays sensible kW / kWh values
- [ ] Financial panel shows non-zero, non-negative values
- [ ] No "AppEng" or "AppEng.ai" text visible anywhere in the UI
- [ ] No Plotly/matplotlib default colours visible in any chart
- [ ] Supabase save succeeds (or warning shown gracefully on failure); capture never blocks

**Test addresses:**
- `53 Bishops Place, Kensington SA 5068` — existing test address, constrained DNSP zone
- `1 King William Street, Adelaide SA 5000` — CBD, standard export limit

**Test retailers:**
- AGL (TOU), Origin Energy (flat), Amber Electric (spot — edge case)

---

## Stage 1 additions (2026-08-06) — modules and tables that did not exist before

**New backend modules**
- `backend/auth.py` — **the security boundary.** `Caller` / `require_caller` / `require_company` / `require_owner`.
  Validates the Supabase JWT REMOTELY (`auth.get_user`); never decode or verify a JWT by hand anywhere in this repo.
  Fail-closed: Supabase unreachable → 503, never a Caller. Identity comes ONLY from the validated token plus the
  server-side `company_members` lookup — NEVER from the request body. 60s token cache.
- `backend/job_paths.py` — `derive_path(has_existing_solar, intent)` + `PATH_LABELS`. Pure, never raises.
  **`jobs.path` is a Postgres GENERATED column and is the source of truth** — never write to it; this helper only
  derives the value before insert / for display.

**WHERE MIGRATIONS LIVE:** Supabase migration `.sql` files are NOT in this repository. They are at
`../supabase/migrations/` — one level up, in the `enrgengine` workspace repo (which also holds `docs/`). This repo
holds application code only. When you write a migration, the file belongs there; commit it in that repo.

**New tables:** `companies`, `company_members` (owner|installer).
**New endpoints (all require auth):** `POST /api/job`, `GET /api/jobs`, `GET /api/job/{id}`, `PATCH /api/job/{id}/status`, `GET /api/auth/me`.

**RULES THAT NOW APPLY TO EVERY NEW ENDPOINT**
1. **The service-role key bypasses RLS.** Company-scoped policies give backend endpoints NO protection — every query
   must filter by `caller.company_id` in application code.
2. **Cross-company access returns 404, never 403.** A 403 confirms the record exists, which leaks information.
3. **Never trust identity from a payload.** `installer_id` / `company_id` in a request body are assertions; use the
   `Caller`.
4. **capture.py has a per-table column allowlist.** A new column not added to `_ALLOWED` is SILENTLY DROPPED on write.
5. **`origin`/`verified`/`owner_company_id` on equipment** — `source` means datasheet provenance, do not confuse them.

---

## Conventions Claude Code must not re-derive

- **`accuracy_tier` is stored as an INTEGER** (`1` / `2` / `3`), not the string `"tier_3"`. This was a deliberate
  E1 deviation to match the existing `load_profiles.accuracy_tier` integer column. Any UI reading the tier (the
  worksheet accuracy meter, the dashboard accuracy column, the tier-fallback flow) must read the integer.
- **Charts:** recharts is the standard; Plotly is reserved for heavy technical charts only (8,760-hour series,
  7x24 heatmap). Decided 2026-06-23 (PROGRESS decision #25).
- **Bill parser prompt** has an explicit JSON schema + unit rules but **no few-shot examples** — adding two
  worked examples from different retailers is still outstanding (OPEN_ITEMS "Bill parser — Claude Vision retained").
- **Cost model is bottom-up** (catalogue hardware + soft costs - STC - rebate). `pricing_benchmarks.json` and the
  flat $/kW approach are superseded — do not reintroduce them.
- **Landing-page signup MUST keep `Prefer: return=minimal`.** As of 2026-08-05 `anon` holds INSERT only on
  `registrations` / `questionnaire_responses` (SELECT/UPDATE/DELETE revoked). Switching to `return=representation`
  makes PostgREST read the row back, which `anon` cannot do — live signups would 401. Fix the header, never re-grant
  SELECT to anon on those tables.
- **`TRUNCATE` and `MAINTAIN` are NOT subject to RLS.** Enabling RLS does not protect against them; only revoking the
  privilege does. TRUNCATE was revoked 2026-08-05; MAINTAIN is still outstanding (see OPEN_ITEMS).
- **`rls_auto_enable()` / the `ensure_rls` event trigger are deliberate and correct** — they auto-enable RLS on every
  new table in `public`. EXECUTE is granted only to `postgres` and `search_path` is pinned. Do not remove them.
- **Current build sequence** = `docs/2026-08-05-master-build-checklist.md`. `BUILD_SEQUENCE.md`'s Wave 1/Wave 2
  frontend order predates the 2026-08-04 six-path + load-insight decisions.

---

## Known Issues / Tech Debt

| Issue | File | Priority |
|-------|------|----------|
| **Heuristic still live + still the only path the frontend calls** — `sizing_engine.py` is imported by `routes/sizing.py`, `POST /api/sizing/size` is registered in `main.py`, and `frontend/lib/api.ts` calls ONLY that endpoint (never `/api/sizing/optimise` or `/api/sizing/battery`). The accurate engine is API-only today. Verified in code 2026-08-05. Retirement = master checklist 3.16 | `sizing_engine.py`, `routes/sizing.py`, `frontend/lib/api.ts` | **Phase 1 — blocking** |
| `projected_annual_spend` shows $0 misleadingly | `financial_model.py`, Financial panel | Phase 1 |
| Financial model blends solar+battery ROI (needs split) | `financial_model.py` | Phase 2 |
| Pre-beta: signed URLs for raw-bill reads (bucket already private) | `routes/bill.py` | Pre-beta polish |
| Legacy `app.py` / `report_generator.py` / `calculator.py` not used | (legacy) | Ignore |

---

## Deployment

**Frontend:** Next.js on Vercel — `git push` to `main` auto-deploys; env vars in Vercel dashboard.

**Backend:** FastAPI on Railway — deployed as a Python service; env vars in Railway dashboard.
Do not push `.env` or any credentials file.

**Landing page:** HTML/CSS/JS on Netlify — separate `ENRG-ENGINE-landing` repo, auto-deploys on push.

**Legacy (retired):** Streamlit Cloud `mayurmistry82/AppEng---Platform` (`appeng-platform.streamlit.app`).
Do not push to it.
