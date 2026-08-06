import { create } from "zustand";
import type {
  CorrectionInput,
  IntervalMetadata,
  JobSavePayload,
  LoadCharacterisationData,
  MergedBillData,
  SizingData,
  SolarData,
  SurveyInputs,
} from "./api";
import { saveCorrection } from "./api";

export type Occupancy = "home_day" | "away_day" | "business";

/** A correction recorded before a job_id exists (flushed after the next save). */
export type QueuedCorrection = Omit<CorrectionInput, "job_id">;

// ── Payload-assembly helpers (de-identification happens here) ────────────────
const AU_STATE_RE = /\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/i;

function _siteFromAddress(addr: string): {
  postcode: string | null;
  state: string | null;
} {
  const pc = addr.match(/\b(\d{4})\b/);
  const st = addr.match(AU_STATE_RE);
  return { postcode: pc ? pc[1] : null, state: st ? st[1].toUpperCase() : null };
}

function _coarse(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !isFinite(v)) return null;
  return Math.round(v * 100) / 100; // ~1.1 km (town precision), not the exact address
}

function _gridHomeFraction(grid?: number[][]): number | null {
  if (!grid || grid.length === 0) return null;
  let count = 0;
  let total = 0;
  for (const row of grid) {
    for (const cell of row) {
      total += 1;
      if (cell === 1) count += 1;
    }
  }
  return total ? Math.round((count / total) * 1000) / 1000 : null;
}

function _sanitizeBillForJson(b: MergedBillData): Record<string, unknown> {
  // parsed_json lands in the non-PII bills table — strip PII and bulky redundant data.
  const clone = { ...b } as Record<string, unknown>;
  delete clone.property_address;
  delete clone.customer_name;
  delete clone.combined_usage_periods;
  return clone;
}

export interface CustomerInputs {
  customerName: string;
  propertyAddress: string;
  occupancy: Occupancy;
  budget: number | null;
  wantsBattery: boolean;
}

const DEFAULT_CUSTOMER_INPUTS: CustomerInputs = {
  customerName: "",
  propertyAddress: "",
  occupancy: "home_day",
  budget: null,
  wantsBattery: true,
};

interface DashboardState {
  // Set by BillPanel after successful parse
  billData: MergedBillData | null;
  setBillData: (data: MergedBillData | null) => void;

  // Set by CustomerSitePanel on save
  customerInputs: CustomerInputs;
  setCustomerInputs: (inputs: CustomerInputs) => void;

  // Set by SolarPanel after a successful /api/solar/irradiance call
  solarData: SolarData | null;
  setSolarData: (data: SolarData | null) => void;

  // Set by SizingPanel after a successful /api/sizing/size call
  sizingData: SizingData | null;
  setSizingData: (data: SizingData | null) => void;

  // Set by SurveyPanel on save
  surveyInputs: SurveyInputs | null;
  setSurveyInputs: (inputs: SurveyInputs | null) => void;

  // Set by LoadProfilePanel after a successful /api/load/characterise call
  loadData: LoadCharacterisationData | null;
  setLoadData: (data: LoadCharacterisationData | null) => void;

  // Set by IntervalDataPanel after a smart-meter upload (Tier 3 metadata)
  intervalData: IntervalMetadata | null;
  setIntervalData: (data: IntervalMetadata | null) => void;

  // Chart display mode — toggled by ChartModeToggle in the header
  chartMode: "dark" | "light";
  setChartMode: (mode: "dark" | "light") => void;

  // Sidebar collapsed/expanded — toggled by SidebarToggle in the header
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // ── Job capture (ML data flywheel) ──
  jobId: string | null;
  setJobId: (id: string | null) => void;
  // Installer attestation that the customer was given EnrgEngine's privacy notice.
  // Notice-based de-identified flywheel: an attested job enters training_export by
  // default (gated server-side by flywheel_config.flywheel_default_include). Default
  // false — set when the installer ticks the attestation. Replaces the old customer
  // consent checkbox.
  privacyNoticeGiven: boolean;
  setPrivacyNoticeGiven: (v: boolean) => void;
  // Corrections recorded before a job_id exists; flushed after the next save.
  pendingCorrections: QueuedCorrection[];
  // Assemble the full /api/job/save payload from the current slices (de-identified).
  assembleJobPayload: () => JobSavePayload;
  // Fire an installer override now (if job_id known) or queue it for later.
  recordCorrection: (c: QueuedCorrection) => void;
  flushPendingCorrections: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  billData: null,
  setBillData: (data) => set({ billData: data }),

  customerInputs: DEFAULT_CUSTOMER_INPUTS,
  setCustomerInputs: (inputs) => set({ customerInputs: inputs }),

  solarData: null,
  setSolarData: (data) => set({ solarData: data }),

  sizingData: null,
  setSizingData: (data) => set({ sizingData: data }),

  surveyInputs: null,
  setSurveyInputs: (inputs) => set({ surveyInputs: inputs }),

  loadData: null,
  setLoadData: (data) => set({ loadData: data }),

  intervalData: null,
  setIntervalData: (data) => set({ intervalData: data }),

  chartMode: "dark",
  setChartMode: (mode) => set({ chartMode: mode }),

  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  // ── Job capture ──
  jobId: null,
  setJobId: (id) => set({ jobId: id }),
  privacyNoticeGiven: false,
  setPrivacyNoticeGiven: (v) => set({ privacyNoticeGiven: v }),
  pendingCorrections: [],

  assembleJobPayload: () => {
    const s = get();
    const bill = s.billData;
    const survey = s.surveyInputs;
    const load = s.loadData;
    const solar = s.solarData;
    const sizing = s.sizingData;
    const interval = s.intervalData;
    const ci = s.customerInputs;

    const { postcode, state } = _siteFromAddress(ci.propertyAddress || "");

    const bills: Record<string, unknown>[] = bill
      ? [
          {
            raw_file_path: bill.raw_file_path ?? null,
            parsed_json: _sanitizeBillForJson(bill),
            parser_version: bill.parser_version ?? null,
            parse_confidence: bill.parse_confidence ?? null,
            billing_period_start: bill.billing_period_start,
            billing_period_end: bill.billing_period_end,
            billing_period_days: bill.billing_period_days,
            total_kwh: bill.total_kwh,
            daily_avg_kwh: bill.daily_avg_kwh,
            daily_supply_charge: bill.daily_supply_charge,
            retailer: bill.retailer,
            plan_name: bill.plan_name,
            nmi: bill.nmi,
            has_solar: bill.has_solar,
            feed_in_tariff: bill.feed_in_tariff,
          },
        ]
      : [];

    const ts = bill?.tariff_structured ?? null;
    const tariffs: Record<string, unknown>[] = ts
      ? [
          {
            tariff_type: ts.tariff_type,
            supply_charge: ts.supply_charge,
            fit_tiers: ts.fit_tiers,
            tou_windows: ts.tou_windows,
            demand_charges: ts.demand_charges,
            controlled_load: ts.controlled_load,
            block_tiers: ts.block_tiers,
          },
        ]
      : [];

    return {
      job_id: s.jobId,
      privacy_notice_given: s.privacyNoticeGiven,
      status: "complete",
      customer: {
        customer_name: ci.customerName || null,
        property_address_full: ci.propertyAddress || null,
      },
      site: {
        postcode,
        state,
        dnsp: null, // TODO: DNSP lookup is server-side (nem_data, not yet built)
        lat_coarse: _coarse(solar?.latitude),
        lon_coarse: _coarse(solar?.longitude),
      },
      accuracy_tier: load?.accuracy_tier ?? null,
      confidence_pct: load?.confidence_pct ?? null,
      engine_versions: { parser: bill?.parser_version ?? null },
      bills,
      tariffs,
      survey: survey
        ? {
            household_size: survey.household_size,
            occupancy_pattern: survey.occupancy,
            hot_water_type: survey.hot_water,
            has_ev: survey.appliances.includes("ev"),
            has_pool: survey.appliances.includes("pool_pump"),
            solar_export: bill?.has_solar ?? null,
            occupancy_grid: survey.occupancy_grid ?? null,
            daytime_home_frac: _gridHomeFraction(survey.occupancy_grid),
          }
        : null,
      load_profile: load
        ? {
            archetype_used: load.archetype_used,
            hourly_profile_weights: load.hourly_profile_weights,
            daily_avg_kwh: load.daily_avg_kwh,
            annual_kwh: load.annual_kwh,
            accuracy_tier: load.accuracy_tier,
            confidence_pct: load.confidence_pct,
            appliance_adjustments: load.adjustment_log,
            tariff_type_used: load.tariff_type_used,
          }
        : null,
      solar_resource: solar
        ? {
            lat: solar.latitude,
            lon: solar.longitude,
            annual_kwh_per_kwp: solar.annual_kwh_per_kwp,
            peak_sun_hours: solar.peak_sun_hours,
            monthly_profile: solar.monthly_profile,
            source: "pvgis",
          }
        : null,
      sizing_result: sizing
        ? {
            solar_kw: sizing.solar_kw,
            battery_kwh: sizing.battery_kwh,
            self_consumption_ratio: sizing.self_consumption_ratio,
            system_cost: sizing.system_cost,
            annual_solar_generation_kwh: sizing.annual_solar_generation_kwh,
            within_budget: sizing.within_budget,
          }
        : null,
      // No financialData slice exists in the current flow (the financial panel is a
      // placeholder). TODO: populate once a financial endpoint/panel is wired.
      financial_result: null,
      // Smart-meter interval back-link (E1). The raw file + parsed series are already in
      // Storage (uploaded at upload time); these refs let the server create/link the
      // durable interval_data row now that a job_id exists. Null when none was uploaded
      // (no empty rows). Idempotent server-side — safe to send on every save.
      interval: interval
        ? {
            nmi: interval.nmi ?? null,
            raw_file_path: interval.raw_file_path ?? null,
            parsed_series_ref: interval.parsed_series_ref ?? null,
            source: interval.source ?? null,
            resolution: interval.resolution_minutes
              ? `${interval.resolution_minutes} min`
              : null,
            period_start: interval.period_start ?? null,
            period_end: interval.period_end ?? null,
          }
        : null,
    };
  },

  recordCorrection: (c) => {
    const id = get().jobId;
    if (id) {
      // Fire-and-forget — correction failures are silent (logged only).
      saveCorrection({ ...c, job_id: id }).catch(() => {});
    } else {
      set((s) => ({ pendingCorrections: [...s.pendingCorrections, c] }));
    }
  },

  flushPendingCorrections: () => {
    const { jobId, pendingCorrections } = get();
    if (!jobId || pendingCorrections.length === 0) return;
    for (const c of pendingCorrections) {
      saveCorrection({ ...c, job_id: jobId }).catch(() => {});
    }
    set({ pendingCorrections: [] });
  },
}));
