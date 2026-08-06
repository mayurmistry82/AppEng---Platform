export interface HistoricalUsagePeriod {
  period_label: string;
  kwh: number;
  days: number;
}

export interface TariffWindow {
  label: string;
  rate: number | null;
  start: string | null;
  end: string | null;
  days: string;
}

export interface TariffStructured {
  tariff_type: string;
  supply_charge: number | null;
  tou_windows: TariffWindow[];
  demand_charges: Record<string, unknown>[];
  controlled_load: Record<string, unknown>[];
  block_tiers: Record<string, unknown>[];
  fit_tiers: { rate: number | null; threshold_kwh: number | null }[];
}

export interface BillData {
  billing_period_days: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_kwh: number | null;
  daily_avg_kwh: number | null;
  tariff_rate: number | null;
  feed_in_tariff: number;
  annual_spend: number | null;
  retailer: string | null;
  plan_name: string | null;
  historical_usage: HistoricalUsagePeriod[];
  has_solar: boolean;
  nmi: string | null;
  daily_supply_charge: number | null;
  property_address: string | null;
  customer_name: string | null;
  // v2 parser additions (see docs/2026-06-05-ml-data-flywheel-plan.md §6).
  tariff_structured?: TariffStructured | null;
  parse_confidence?: Record<string, number> | null;
  field_provenance?: Record<string, string> | null;
  parser_version?: string | null;
  raw_file_path?: string | null;
}

export interface CombinedUsagePeriod {
  period_label: string;
  kwh: number | null;
  days: number | null;
}

export interface MergedBillData extends BillData {
  bill_count: number;
  combined_usage_periods: CombinedUsagePeriod[];
  period_covered_start: string | null;
  period_covered_end: string | null;
  total_days_covered: number | null;
}

export interface SolarData {
  latitude: number;
  longitude: number;
  annual_kwh_per_kwp: number | null;
  peak_sun_hours: number | null;
  monthly_profile: number[];
}

export async function fetchSolarData(
  address: string,
  system_kw: number,
): Promise<SolarData> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/solar/irradiance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, system_kw }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(body.detail ?? "Solar data fetch failed");
  }
  return res.json() as Promise<SolarData>;
}

export interface SizingData {
  solar_kw: number;
  battery_kwh: number;
  self_consumption_ratio: number;
  assumed_self_consumption_ratio: number;
  occupancy: string;
  system_cost: number;
  annual_solar_generation_kwh: number;
  within_budget: boolean;
}

export async function fetchSizingData(
  billData: MergedBillData,
  solarData: SolarData,
  budget: number,
  wantsBattery: boolean,
  occupancy: string,
): Promise<SizingData> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/sizing/size`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bill_data: billData,
      solar_data: solarData,
      budget,
      wants_battery: wantsBattery,
      occupancy,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(body.detail ?? "Sizing fetch failed");
  }
  return res.json() as Promise<SizingData>;
}

export interface DailyIrradianceData {
  daily_profile: number[]; // 365 values, kWh/day, Jan 1 – Dec 31 (2019)
  hourly_profile: number[]; // 8760 values, kWh/hour
}

export async function fetchDailySolarData(
  lat: number,
  lon: number,
  system_kw: number,
): Promise<DailyIrradianceData> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/solar/irradiance/daily`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, system_kw }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(body.detail ?? "Daily solar data fetch failed");
  }
  return res.json() as Promise<DailyIrradianceData>;
}

export type HouseholdSize = "1" | "2" | "3-4" | "5+";
export type HotWater =
  | "electric_storage"
  | "gas"
  | "heat_pump"
  | "solar_hws";
export type Appliance = "ev" | "pool_pump" | "ducted_ac";
export type SurveyOccupancy =
  | "always_home"
  | "away_weekdays"
  | "shift_work";
export type TariffType = "single_rate" | "tou" | "demand" | "not_sure";

export interface SurveyInputs {
  household_size: HouseholdSize;
  hot_water: HotWater;
  appliances: Appliance[];
  occupancy: SurveyOccupancy;
  tariff_type: TariffType;
  // 7 rows (0 = Mon, 6 = Sun) × 24 cols (0 = 00:00–01:00). 1 = home, 0 = away.
  occupancy_grid?: number[][];
}

export interface LoadAdjustment {
  description: string;
  kwh_delta: number;
}

export interface LoadCharacterisationData {
  annual_kwh: number;
  daily_avg_kwh: number;
  archetype_used: string;
  accuracy_tier: 1 | 2 | 3;
  confidence_pct: number;
  hourly_profile_weights: number[];
  adjustment_log: LoadAdjustment[];
  tariff_type_used: string;
  // Tier 3 (smart-meter interval) extras — present only when interval data is used.
  coverage_days?: number | null;
  pct_actual?: number | null;
  channels_used?: string[];
  annualised?: boolean | null;
}

export async function fetchLoadCharacterisation(
  billData: MergedBillData,
  survey: SurveyInputs,
): Promise<LoadCharacterisationData> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/load/characterise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annual_kwh: billData.total_kwh,
      daily_avg_kwh: billData.daily_avg_kwh,
      household_size: survey.household_size,
      hot_water: survey.hot_water,
      appliances: survey.appliances,
      occupancy: survey.occupancy,
      tariff_type: survey.tariff_type,
      occupancy_grid: survey.occupancy_grid,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(body.detail ?? "Load characterisation failed");
  }
  return res.json() as Promise<LoadCharacterisationData>;
}

export interface GenerateReportPayload {
  selected_panels: string[];
  bill_data?: Record<string, unknown> | null;
  load_profile?: Record<string, unknown> | null;
  customer_name?: string;
  installer_name?: string;
  installer_company?: string;
}

export async function generateReport(
  payload: GenerateReportPayload,
): Promise<Blob> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/report/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Report generation failed");
  }
  return res.blob();
}

export async function parseBill(file: File): Promise<BillData> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiBase}/api/bill/parse`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(body.detail ?? "Parse failed");
  }
  return res.json() as Promise<BillData>;
}

// ── Job capture (ML data flywheel) ───────────────────────────────────────────
export interface JobCustomerPayload {
  customer_name?: string | null;
  property_address_full?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

export interface JobSitePayload {
  postcode?: string | null;
  state?: string | null;
  dnsp?: string | null;
  lat_coarse?: number | null;
  lon_coarse?: number | null;
}

export interface JobSavePayload {
  job_id?: string | null;
  installer_id?: string | null;
  // Installer attestation that the customer was given the privacy notice (notice-based
  // de-identified flywheel). Replaces the prior customer-facing training_consent flag.
  privacy_notice_given: boolean;
  status?: string;
  customer?: JobCustomerPayload | null;
  site?: JobSitePayload | null;
  accuracy_tier?: number | null;
  confidence_pct?: number | null;
  engine_versions?: Record<string, unknown> | null;
  bills: Record<string, unknown>[];
  tariffs: Record<string, unknown>[];
  survey?: Record<string, unknown> | null;
  load_profile?: Record<string, unknown> | null;
  solar_resource?: Record<string, unknown> | null;
  sizing_result?: Record<string, unknown> | null;
  financial_result?: Record<string, unknown> | null;
  // Smart-meter interval back-link (E1): Storage refs + metadata so the server can
  // create/link the interval_data row once the job_id is minted. Null if none uploaded.
  interval?: Record<string, unknown> | null;
}

export interface CorrectionInput {
  job_id: string;
  source_module: string;
  field_path: string;
  original_value: string | null;
  corrected_value: string | null;
  value_type: string;
}

/** Persist a complete job record. The route never errors fatally; resolves to {job_id}. */
export async function saveJob(
  payload: JobSavePayload,
): Promise<{ job_id: string | null }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/job/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Job save failed (${res.status})`);
  }
  return res.json() as Promise<{ job_id: string | null }>;
}

/** Record an installer override (gold label). Resolves to {correction_id}. */
export async function saveCorrection(
  input: CorrectionInput,
): Promise<{ correction_id: string | null }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const res = await fetch(`${apiBase}/api/job/correction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Correction save failed (${res.status})`);
  }
  return res.json() as Promise<{ correction_id: string | null }>;
}

// ── Smart-meter interval data (Tier 3) ───────────────────────────────────────
export interface IntervalMetadata {
  source: string | null;
  format: string | null;
  nmi: string | null;
  resolution_minutes: number | null;
  uom: string | null;
  period_start: string | null;
  period_end: string | null;
  coverage_days: number | null;
  gap_days: number | null;
  annualised: boolean | null;
  annual_kwh: number | null;
  daily_avg_kwh: number | null;
  pct_actual: number | null;
  channels_available: string[];
  channels_used: string[];
  channels_excluded: string[];
  multiple_nmis: boolean | null;
  average_day_kwh: number[];
  // Storage refs carried so the job-save flow can back-link the interval_data row once a
  // job_id exists (the upload may have had no job_id). Populated client-side from the
  // upload result; absent until then.
  raw_file_path?: string | null;
  parsed_series_ref?: string | null;
  persisted?: boolean;
}

export interface IntervalUploadResult {
  ok: boolean;
  error?: string;
  suggest_tier2_fallback?: boolean;
  load?: LoadCharacterisationData;
  metadata?: IntervalMetadata;
  persisted?: boolean;
  raw_file_path?: string | null;
  parsed_series_ref?: string | null;
  flags?: string[];
}

export async function uploadIntervalData(
  file: File,
  opts: {
    jobId?: string | null;
    installerId?: string | null;
    includeControlledLoad?: boolean;
  } = {},
): Promise<IntervalUploadResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const form = new FormData();
  form.append("file", file);
  if (opts.jobId) form.append("job_id", opts.jobId);
  if (opts.installerId) form.append("installer_id", opts.installerId);
  form.append("include_controlled_load", String(!!opts.includeControlledLoad));
  try {
    const res = await fetch(`${apiBase}/api/interval/upload`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Upload failed (${res.status}). Check the backend is running.`,
        suggest_tier2_fallback: true,
      };
    }
    return (await res.json()) as IntervalUploadResult;
  } catch {
    return {
      ok: false,
      error:
        "Could not reach the API. Make sure the backend is running on port 8000.",
      suggest_tier2_fallback: true,
    };
  }
}
