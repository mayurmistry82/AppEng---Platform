export type InputType = "customer" | "api" | "database" | "override";

export interface InputRow {
  type: InputType;
  label: string;
  detail?: string[];
}

export interface Stage {
  number: number;
  name: string;
  sublabel: string;
  theme: "amber" | "orange" | "blue";
  inputs: InputRow[];
  processing?: string[];
  noInputsNote?: string;
  output: string;
}

export const INPUT_BADGE_LABEL: Record<InputType, string> = {
  customer: "Customer Input",
  api: "API Call",
  database: "Internal Database",
  override: "Installer Override",
};

export const INPUT_BADGE_CLS: Record<InputType, string> = {
  customer: "bg-enrg-amber/15 text-enrg-amber border-enrg-amber/40",
  api: "bg-enrg-blue/10 text-enrg-blue border-enrg-blue/30",
  database: "bg-white/5 text-muted-foreground border-white/10",
  override: "bg-enrg-orange/10 text-enrg-orange border-enrg-orange/30",
};

export const THEME_CLS = {
  amber: {
    card: "border-l-enrg-amber bg-enrg-amber/[0.04] hover:bg-enrg-amber/[0.07]",
    heading: "text-enrg-amber",
    badge: "text-enrg-amber",
  },
  orange: {
    card: "border-l-enrg-orange bg-enrg-orange/[0.04] hover:bg-enrg-orange/[0.07]",
    heading: "text-enrg-orange",
    badge: "text-enrg-orange",
  },
  blue: {
    card: "border-l-enrg-blue bg-enrg-blue/[0.04] hover:bg-enrg-blue/[0.07]",
    heading: "text-enrg-blue",
    badge: "text-enrg-blue",
  },
} as const;

export const STAGES: Stage[] = [
  {
    number: 1,
    name: "Load Characterisation",
    sublabel: "DATA INPUTS · CONSUMPTION BASELINE",
    theme: "amber",
    inputs: [
      {
        type: "customer",
        label: "Electricity bill upload",
        detail: [
          "PDF, JPG, or PNG — up to 4 bills for a full year of data",
          "Bill parser extracts: retailer, plan, tariff type, usage (kWh), daily average, billing period, feed-in tariff, supply charge, NMI, historical periods, and whether existing solar is present",
        ],
      },
      {
        type: "api",
        label: "Claude Vision API (Anthropic)",
        detail: [
          "Reads bill as an image — no manual data entry required",
          "Handles multi-page PDFs, handwritten notes, and non-standard layouts",
        ],
      },
      {
        type: "database",
        label: "AEMO national archetype database",
        detail: [
          "4 base load profiles: small household × away/home, large household × away/home",
          "Profile selected by household size + occupancy grid answer",
        ],
      },
      {
        type: "customer",
        label: "5-question load survey",
        detail: [
          "Household size (1 / 2 / 3–4 / 5+) — scales load baseline",
          "Hot water type (electric storage / gas / heat pump / solar HWS) — electric storage adds ~3 kWh/day overnight load block",
          "High-draw appliances (EV / pool pump / ducted A/C) — EV +7 kWh/day, pool +2.5 kWh/day, ducted A/C +4 kWh/day",
          "Daytime occupancy grid (7-day × 24-hour painted schedule) — sets solar self-consumption fraction precisely",
          "Tariff type (single rate / TOU / demand / not sure) — determines MILP dispatch strategy",
        ],
      },
    ],
    output:
      "Annual consumption (kWh) · Daily average (kWh/day) · 24-hr load profile weights (normalised to 24.0) · Accuracy tier (1 = 65%, 2 = 82%, 3 = 90–95%) · Tariff structure for MILP",
  },
  {
    number: 2,
    name: "Solar Resource Assessment",
    sublabel: "LOCATION DATA · TMY IRRADIANCE",
    theme: "amber",
    inputs: [
      {
        type: "customer",
        label: "Property address",
        detail: [
          "Entered once in Customer & Site — auto-populated from bill parse",
        ],
      },
      {
        type: "api",
        label: "Google Maps Geocoding API",
        detail: [
          "Converts street address → latitude / longitude for precise solar calculations",
          "Location timezone and DST offset derived from coordinates",
        ],
      },
      {
        type: "api",
        label: "Solcast TMY API",
        detail: [
          "Returns 8,760 hours of: GHI, DNI, DHI irradiance + ambient temperature for exact coordinates",
          "Australian-operated satellite + ML model — highest accuracy available for AU locations",
          "Cached by 500m grid cell: nearby addresses reuse existing data",
          "Phase 1 fallback: PVGIS (EU-operated, lower accuracy)",
        ],
      },
    ],
    output:
      "Full TMY dataset (8,760 hourly values) · Lat/lng · Peak sun hours (hrs/day) · Annual yield per kWp (kWh/kWp/year) · Timezone offset",
  },
  {
    number: 3,
    name: "Roof Geometry",
    sublabel: "PHYSICAL SITE · ROOF PLANES",
    theme: "orange",
    inputs: [
      {
        type: "api",
        label: "MetroMap Building Footprint API (preferred)",
        detail: [
          "7–10cm resolution aircraft imagery — significantly higher than satellite",
          "Returns per building: pitch (°), azimuth (°), eave height, max height, roof complexity, material, solar panel presence",
          "Coverage: Australian metro and major regional areas",
          "Imagery quality: HIGH — full confidence language shown",
        ],
      },
      {
        type: "api",
        label: "Google Solar API — buildingInsights (fallback)",
        detail: [
          "Used for rural or unserved addresses only",
          "0.25m satellite resolution — MEDIUM/BASE quality in most of AU",
          "Returns pitch, azimuth, usable area, annual sunshine per plane",
          "Quality tier displayed to installer: accuracy caveat shown for MEDIUM/BASE results",
          "Fallback for addresses outside MetroMap coverage",
        ],
      },
      {
        type: "override",
        label: "Installer-provided site measurements",
        detail: [
          "Installer uploads drone photos or site photos as evidence",
          "Manually enters: pitch (°), azimuth (°), usable area (m²) per roof plane",
          "Installer values override API values — flagged as site-survey source in all outputs",
          "Images stored against the job for audit trail",
        ],
      },
    ],
    output:
      "Roof planes list — each with: azimuth (°), pitch (°), usable area (m²), shading flag · Imagery quality tier · Input source (API / installer-provided / manual)",
  },
  {
    number: 4,
    name: "System Design",
    sublabel: "SPECIFICATIONS · CAPACITY ENVELOPE",
    theme: "orange",
    inputs: [
      {
        type: "database",
        label: "Panel database (internal)",
        detail: [
          "Top 10–15 AU residential panels: wattage (W), efficiency (%), temperature coefficient (%/°C), dimensions (m × m)",
          "Warranty degradation profile per panel tier",
        ],
      },
      {
        type: "database",
        label: "Inverter database (internal)",
        detail: [
          "Top inverters by AU market share: type (string / hybrid), efficiency curve, max DC input (kW)",
        ],
      },
      {
        type: "override",
        label: "Performance ratio components (each overrideable)",
        detail: [
          "Inverter efficiency: 97% default",
          "Cable losses: 2% default",
          "Soiling: 2% default",
          "Temperature derating: 3% default",
          "Overall PR: ~0.78 — product of above, never a hard-coded single ratio. Each component shown individually on the dashboard.",
          "DC:AC ratio: 1.2 default",
        ],
      },
    ],
    output:
      "Max panel count per plane · DC array envelope (kWp per plane) · Inverter size (kW) · Selected panel spec · Overall PR and components",
  },
  {
    number: 5,
    name: "Generation Simulation",
    sublabel: "HOURLY MODELLING · PRE-COMPUTED PROFILES",
    theme: "orange",
    inputs: [],
    noInputsNote: "No new data inputs — uses all outputs from Stages 1–4.",
    processing: [
      "For each roof plane, for each of 8,760 hours of the TMY year:",
      "Perez transposition model → converts GHI/DNI/DHI to plane-of-array irradiance for plane's specific azimuth + tilt",
      "Cell temperature model: T_cell = T_ambient + (NOCT − 20) × (irradiance ÷ 800)",
      "Temperature derating: applies panel temperature coefficient (−%/°C) to efficiency at each hour",
      "Performance ratio: inverter, cable, soiling losses applied",
      "Result: normalised profile = kWh generated per kWp installed per hour — one profile per roof plane",
      "Pre-computed once and stored. The MILP stage uses these directly — no re-simulation per iteration. This is what makes co-optimisation tractable.",
    ],
    output:
      "Per-plane normalised generation profile (8,760 values, kWh/kWp/hr) · System generation profile at any solar allocation · Annual yield estimate per plane",
  },
  {
    number: 6,
    name: "Co-Optimisation (MILP)",
    sublabel: "MATHEMATICAL OPTIMISATION · JOINT SOLAR + BATTERY",
    theme: "blue",
    inputs: [
      {
        type: "api",
        label: "Energy Made Easy API (Australian Energy Regulator)",
        detail: [
          "Live retail tariff rates for customer's retailer + state",
          "Flat rate (c/kWh), TOU peak/off-peak windows and rates, daily supply charge, feed-in tariff",
          "Covers all NEM states: SA, VIC, NSW, QLD, ACT, TAS",
          "WA uses a separate DEBS lookup path (not on NEM)",
        ],
      },
      {
        type: "database",
        label: "DNSP export limit table",
        detail: [
          "SA Power Networks: export limit by postcode — standard 5 kW, constrained zones 1.5 kW or 0 kW",
          "Applied per-hour as a hard constraint in the MILP",
          "Constrained zones increase battery value: curtailed solar is stored rather than lost",
        ],
      },
      {
        type: "customer",
        label: "Installer / customer inputs",
        detail: [
          "Objective function (user selects): Maximise 25-year NPV / Maximise self-sufficiency / Minimise payback / Custom blend",
          "Budget ceiling (optional) — MILP solution bounded by this",
        ],
      },
    ],
    processing: [
      "MILP decision variables solved simultaneously: solar capacity per roof plane (kWp), battery capacity (kWh), battery charge/discharge per hour, grid import/export per hour",
      "Constraints: solar ≤ roof capacity, export ≤ DNSP limit/hour, battery SoC within 10–90% DoD, charge/discharge ≤ C-rate, budget ≤ ceiling if set",
      "Objective: optimise selected function over 25-year system lifetime",
      "Result is provably optimal for the customer's specific situation — not a rule of thumb, not a days-of-autonomy estimate",
    ],
    output:
      "Optimal solar kWp (per plane + total) · Optimal battery kWh · Annual generation (kWh) · Self-consumption ratio (%) · Self-sufficiency ratio (%) · Annual grid import/export (kWh)",
  },
  {
    number: 7,
    name: "Financial Model",
    sublabel: "INVESTMENT ANALYSIS · 25-YEAR HORIZON",
    theme: "blue",
    inputs: [
      {
        type: "database",
        label: "STC zone and deeming table",
        detail: [
          "Zone rating by state: SA = zone 3, rating 1.382",
          "Deeming period: 2030 − install year (reduces each 1 January)",
          "Formula: STCs = system kW × deeming years × zone rating",
          "STC price: ~$36–38/certificate (installer-overrideable)",
        ],
      },
      {
        type: "database",
        label: "Federal battery rebate table",
        detail: [
          "Cheaper Home Batteries Program (from July 2025)",
          "30% rebate on eligible battery system cost",
          "Applied automatically when battery kWh > 0 and postcode eligible",
        ],
      },
      {
        type: "database",
        label: "SA market price index",
        detail: [
          "Default installed system costs by size (updated quarterly)",
          "Solar: 6.6 kW ~$6,000 / 10 kW ~$8,500 / 13.3 kW ~$10,500",
          "Battery add-on: 10 kWh ~$9,000 / 13.5 kWh ~$14,000",
          "Labelled clearly as indicative — installer replaces with actual quote",
        ],
      },
      {
        type: "override",
        label: "Installer-overrideable assumptions (all shown explicitly)",
        detail: [
          "System cost — pre-populated from market default; installer enters actual quote and model recalculates instantly",
          "Tariff escalation: 3%/year default",
          "Panel degradation: 0.5%/year",
          "Battery replacement: year 12 at $8,000 default",
          "Discount rate: 7% for NPV calculation",
        ],
      },
    ],
    output:
      "Annual bill saving (AUD) · Monthly saving · Simple payback (years) · 25-year NPV · IRR · Solar-only payback · Battery add-on payback · Combined payback · STC value · Battery rebate value · Net system cost after incentives",
  },
  {
    number: 8,
    name: "Report Output",
    sublabel: "WHITE-LABEL DELIVERABLE",
    theme: "blue",
    inputs: [
      {
        type: "customer",
        label: "Installer profile (saved once, auto-populated)",
        detail: [
          "Business name, logo, phone, email",
          "Stored in Supabase — pre-fills on every report",
        ],
      },
      {
        type: "customer",
        label: "Customer details (auto-populated from bill parse)",
        detail: [
          "Customer name, property address, NMI",
        ],
      },
    ],
    output:
      "White-label PDF — installer branding on every page, customer name on cover, no EnrgEngine branding visible · Sections: system recommendation, solar assessment, battery assessment, financial outcomes, NEM-specific data (DNSP / VPP / STC / rebate), transparent assumptions with every source listed",
  },
];
