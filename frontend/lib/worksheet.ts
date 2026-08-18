import type { ApiErrorKind, JobIntent, PathLetter } from "@/lib/jobs";

/**
 * Worksheet shell logic (checklist 3.3) — PURE. No React, no JSX, no fetch,
 * no server-only imports (the type-only import above is erased at strip time).
 * Exercised by scripts/verify-worksheet-logic.ts under
 * `node --test --experimental-strip-types`, mirroring how lib/jobs.ts is
 * built and tested.
 *
 * Every function here tolerates ANY input shape: a missing child key, a null,
 * a non-array where an array belongs — nothing throws, predicates return
 * false, views fall back to their placeholder strings. GET /api/job/{id}
 * promises arrays for all twelve child keys, but this module does not bet the
 * page on that promise.
 */

// ── Input shape ──────────────────────────────────────────────────────────────

/**
 * The loosest useful view of GET /api/job/{id}: every jobs column plus twelve
 * child ARRAYS (including the singular-sounding `customer` — the address is
 * customer[0]?.property_address_full). All optional because predicates must
 * survive anything.
 */
export interface JobDetailLike {
  status?: string | null;
  path?: string | null;
  path_label?: string | null;
  accuracy_tier?: number | null;
  storeys?: number | null;
  roof_material?: string | null;
  dwelling_type?: string | null;
  electrical_phase?: string | null;
  year_built?: number | null;
  bedrooms?: number | null;
  floor_area_m2?: number | null;
  customer?: unknown;
  bills?: unknown;
  tariffs?: unknown;
  surveys?: unknown;
  load_profiles?: unknown;
  solar_resources?: unknown;
  sizing_results?: unknown;
  financial_results?: unknown;
  corrections?: unknown;
  interval_data?: unknown;
  actuals?: unknown;
  roof_geometry?: unknown;
}

/** A child key as a real array — [] for anything that is not an array. */
function arr(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null,
  );
}

function asObject(value: unknown): JobDetailLike {
  return typeof value === "object" && value !== null
    ? (value as JobDetailLike)
    : {};
}

// ── Sections ─────────────────────────────────────────────────────────────────

export type WorksheetPhase = "site" | "demand" | "optimise" | "resolve";

export interface WorksheetSectionSpec {
  id: string;
  title: string;
  phase: WorksheetPhase;
  /** Checklist row that fills this section — rendered as the body line. */
  builtAt: string;
  complete: (job: JobDetailLike) => boolean;
  /**
   * A section that does NOT gate the ones after it (D5). It takes no part in
   * choosing the active section: an incomplete non-gating section is
   * "unlocked", never "active", and never locks anything below it. It still
   * reports its own completeness honestly, and it still appears in its phase
   * group in order.
   *
   * ABSENT OR TRUE = GATES, deliberately: a section added later gates unless
   * someone says otherwise. A permissive default would silently un-gate a
   * future required section, which is the worse failure.
   */
  gates?: boolean;
}

/**
 * The eleven 3.3 sections, in render order. Decided with Mayur 2026-08-13:
 * "Shading assessment" (4.2) and "Future loads" (4.8/4.11) are NOT here — a
 * section that cannot open for the whole of Stage 3 would make the first pass
 * permanently incompletable. The 3.5 panel-layout diagram folds into
 * "Address & roof", matching the wireframe.
 */
export const SECTIONS: readonly WorksheetSectionSpec[] = [
  {
    id: "address-roof",
    title: "Address & roof",
    phase: "site",
    builtAt: "3.4",
    // 3.4-B: the backend persists a row on EVERY outcome, including a regional
    // NOT_FOUND with zero planes — so `length > 0` would tick this section
    // complete for a Mount Gambier address with no roof at all, advance the
    // phase rail and unlock Site details. Complete means: the NEWEST row (rows
    // are append-only; newest supersedes) actually carries a usable roof.
    complete: (job) => {
      const row = latestRoofGeometry(job);
      if (!row) return false;
      return arr(row.planes).some((p) => {
        const count = p.panel_count;
        return typeof count === "number" && Number.isFinite(count) && count > 0;
      });
    },
  },
  {
    id: "site-details",
    title: "Site details",
    phase: "site",
    builtAt: "3.4b",
    // D5: site-visit fields are "optional, never gating". The section's own
    // caption promises the same thing on screen ("None of this is needed to
    // size the job"). Before this flag it was the first incomplete section on
    // every real job — all four fields are NULL on all six — so it was the
    // active section and LOCKED the entire Demand phase behind a visit that
    // had not happened yet. The screen made a promise the unlock rule broke.
    gates: false,
    complete: (job) =>
      job.storeys != null &&
      job.roof_material != null &&
      job.dwelling_type != null &&
      job.electrical_phase != null,
  },
  {
    id: "energy-data",
    title: "Energy data",
    phase: "demand",
    builtAt: "3.6",
    complete: (job) =>
      arr(job.interval_data).length > 0 ||
      arr(job.bills).length > 0 ||
      arr(job.surveys).length > 0,
  },
  {
    id: "tariff-network",
    title: "Tariff & network",
    phase: "demand",
    builtAt: "3.8",
    complete: (job) => arr(job.tariffs).length > 0,
  },
  {
    id: "objective-budget",
    title: "Objective & budget",
    phase: "optimise",
    builtAt: "3.9",
    // ALWAYS FALSE — no objective/budget column exists yet; lands at 3.9.
    complete: () => false,
  },
  {
    id: "equipment-specs",
    title: "Equipment & specs",
    phase: "optimise",
    builtAt: "3.10",
    // ALWAYS FALSE — no equipment-selection column exists yet; lands at 3.10.
    complete: () => false,
  },
  {
    id: "solar-sizing",
    title: "Solar sizing",
    phase: "optimise",
    builtAt: "3.11",
    complete: (job) => arr(job.sizing_results).some((r) => r.solar_kw != null),
  },
  {
    id: "battery-sizing",
    title: "Battery sizing",
    phase: "optimise",
    builtAt: "3.12",
    complete: (job) =>
      arr(job.sizing_results).some((r) => r.battery_kwh != null),
  },
  {
    id: "results",
    title: "Results",
    phase: "resolve",
    builtAt: "3.13",
    complete: (job) => arr(job.financial_results).length > 0,
  },
  {
    id: "incentives",
    title: "Incentives",
    phase: "resolve",
    builtAt: "3.13b",
    // ALWAYS FALSE — no incentives column exists yet; lands at 3.13b.
    complete: () => false,
  },
  {
    id: "summary-finish",
    title: "Summary & finish",
    phase: "resolve",
    builtAt: "3.15",
    complete: (job) =>
      typeof job.status === "string" && job.status !== "" && job.status !== "draft",
  },
];

// ── Per-path section rules (checklist 3.3b) ──────────────────────────────────

/**
 * What a given six-path job does, beyond which sections it shows.
 *
 * `solarMode`, `batteryMode` and `showsExistingArray` HAVE NO CONSUMER YET AND
 * MUST NOT BE DELETED AS UNUSED. The sections they describe are built at 3.11
 * (solar sizing), 3.12 (battery sizing), 3.4 (address & roof) and 4.9. Without
 * them each of those rows would re-derive its behaviour from the path letter
 * and the six-path logic would end up reimplemented in eight places, drifting
 * apart silently. Later rows read these fields instead.
 */
export interface PathRule {
  /** Section ids removed from the catalogue for this path. */
  hidden: readonly string[];
  solarMode: "optimise" | "pinned" | "none";
  batteryMode: "size" | "none";
  showsExistingArray: boolean;
}

/**
 * The six paths, confirmed by Mayur 2026-08-14 against GAP-4 and the
 * flowchart's six engine nodes.
 *
 * PATH C IS THE ONE TO GET RIGHT — the hero path. It KEEPS solar-sizing even
 * though no solar is being sized: the section shows the array already on the
 * roof, because the battery sizing depends on it, and the flowchart node reads
 * "Solar kept or re-optimised". Hiding it would remove the only place an
 * installer can see the array the battery is sized around. Hence
 * solarMode "pinned" rather than "none".
 */
export const PATH_RULES: Record<PathLetter, PathRule> = {
  // A — Solar only, no existing solar
  A: {
    hidden: ["battery-sizing"],
    solarMode: "optimise",
    batteryMode: "none",
    showsExistingArray: false,
  },
  // B — Solar + battery, no existing solar
  B: {
    hidden: [],
    solarMode: "optimise",
    batteryMode: "size",
    showsExistingArray: false,
  },
  // C — Battery only, HAS solar. Keeps solar-sizing, pinned to what exists.
  C: {
    hidden: [],
    solarMode: "pinned",
    batteryMode: "size",
    showsExistingArray: true,
  },
  // D — Add solar + battery, HAS solar
  D: {
    hidden: [],
    solarMode: "optimise",
    batteryMode: "size",
    showsExistingArray: true,
  },
  // E — Battery only, no solar
  E: {
    hidden: ["solar-sizing"],
    solarMode: "none",
    batteryMode: "size",
    showsExistingArray: false,
  },
  // F — Expand solar only, HAS solar
  F: {
    hidden: ["battery-sizing"],
    solarMode: "optimise",
    batteryMode: "none",
    showsExistingArray: true,
  },
};

/**
 * The rule for a valid single-letter path, else null. Never throws.
 *
 * `jobs.path` is a Postgres GENERATED column and is the single source of
 * truth — this module reads it and never re-derives it. `derivePath` in
 * lib/jobs.ts exists to label the New Job modal BEFORE a job is created;
 * calling it here would create a second source of truth.
 */
export function pathRule(path: unknown): PathRule | null {
  if (typeof path !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(PATH_RULES, path)) return null;
  return PATH_RULES[path as PathLetter];
}

/**
 * The section catalogue minus the ids this path hides, order preserved.
 *
 * A NULL, MISSING OR UNRECOGNISED PATH SHOWS ALL ELEVEN. Never hide a section
 * because the path could not be determined: a missing step is invisible to the
 * installer, whereas an extra one is obvious. A job created before path
 * derivation existed is valid, not a fault.
 */
export function sectionsForPath(path: unknown): readonly WorksheetSectionSpec[] {
  const rule = pathRule(path);
  if (!rule || rule.hidden.length === 0) return SECTIONS;
  return SECTIONS.filter((section) => !rule.hidden.includes(section.id));
}

// ── Progressive unlock ───────────────────────────────────────────────────────

/**
 * "unlocked" is the fourth state the ui component's three cannot express: an
 * incomplete section past the demonstrated first pass — expandable, not the
 * active one, and NOT to be rendered as "complete" (that would lie about
 * progress). worksheet-body owns how it is drawn.
 */
export type WorksheetSectionUnlockState =
  | "locked"
  | "active"
  | "complete"
  | "unlocked";

export interface WorksheetSectionView extends WorksheetSectionSpec {
  state: WorksheetSectionUnlockState;
}

/**
 * THE PROGRESSIVE-UNLOCK RULE, stateless by design (no database column):
 * with done[i] = predicate results and firstIncomplete the first false index,
 *   - all true                  -> every section "complete"
 *   - otherwise done sections are "complete" and firstIncomplete is "active"
 *   - sections after firstIncomplete are "locked" ONLY IF nothing after
 *     firstIncomplete is complete; if any later section IS complete, the first
 *     pass has demonstrably been gone past, so nothing locks and the remaining
 *     incomplete sections are "unlocked" (expandable, not active).
 *
 * 3.3b: the rule runs over the sections VISIBLE for this job's path, resolved
 * first. A hidden section takes no part in the ordering at all — so the active
 * section is the first incomplete VISIBLE one, and the returned array contains
 * only visible sections.
 */
export function sectionStates(job: unknown): WorksheetSectionView[] {
  const detail = asObject(job);
  const visible = sectionsForPath(detail.path);
  const done = visible.map((section) => {
    try {
      return section.complete(detail) === true;
    } catch {
      return false;
    }
  });
  // D5: a NON-GATING section takes no part in the ordering, exactly as a hidden
  // section takes no part in it. `gates` absent means gating — today's
  // behaviour for the other ten sections.
  const gates = visible.map((section) => section.gates !== false);

  // The first incomplete GATING section, as an index into `visible`. -1 when
  // every gating section is complete. A non-gating section can never be it.
  let firstIncomplete = -1;
  for (let i = 0; i < visible.length; i++) {
    if (gates[i] && !done[i]) {
      firstIncomplete = i;
      break;
    }
  }
  // Also counted over GATING sections only: an OPTIONAL section being filled in
  // early must not by itself un-lock a first pass that has not been gone past.
  const anyLaterComplete =
    firstIncomplete !== -1 &&
    visible.some((_section, i) => i > firstIncomplete && gates[i] && done[i]);

  return visible.map((section, i) => {
    let state: WorksheetSectionUnlockState;
    if (!gates[i]) {
      // Honest about ITSELF and nothing else: "complete" only when actually
      // filled in — never inheriting the all-complete shortcut, which would
      // claim progress that has not happened. Never "active" (it is not what
      // to do next) and never "locked" (an installer who has the information
      // early must always be able to open it).
      state = done[i] ? "complete" : "unlocked";
    } else if (done[i]) {
      state = "complete";
    } else if (i === firstIncomplete) {
      state = "active";
    } else {
      state = anyLaterComplete ? "unlocked" : "locked";
    }
    return { ...section, state };
  });
}

// ── Phase rail ───────────────────────────────────────────────────────────────

export type PhaseNodeState = "pending" | "current" | "done";

export const PHASE_ORDER: readonly WorksheetPhase[] = [
  "site",
  "demand",
  "optimise",
  "resolve",
];

/**
 * Split sections into the four phase groups, in PHASE_ORDER, preserving each
 * group's internal order. A section whose `phase` is unrecognised does NOT
 * vanish: it joins the most recent known group (the first group if none has
 * been seen yet), so eleven sections in always means eleven sections out.
 */
export function groupSectionsByPhase<T extends { phase: string }>(
  sections: readonly T[],
): Array<{ phase: WorksheetPhase; sections: T[] }> {
  const groups = PHASE_ORDER.map((phase) => ({ phase, sections: [] as T[] }));
  let lastKnown = 0;
  for (const section of sections ?? []) {
    const index = PHASE_ORDER.indexOf(section?.phase as WorksheetPhase);
    if (index >= 0) lastKnown = index;
    groups[index >= 0 ? index : lastKnown].sections.push(section);
  }
  return groups;
}

/**
 * done  — every GATING visible section in the phase is complete
 * current — the phase contains the active section
 * pending — otherwise
 *
 * 3.3b: counted over the visible list only, so a phase is never stuck pending
 * waiting on a section that is not on screen. On Path E, Optimise holds three
 * sections rather than four and completes when those three are done.
 *
 * D5 (2026-08-18): counted over GATING sections, for the same reason and by the
 * same rule as sectionStates. Site holds Address & roof plus the OPTIONAL Site
 * details, which is empty on every real job — counting it here would leave the
 * Site node reading "pending", i.e. not-yet-started, permanently, while the
 * installer works in Demand below it. The optional section still shows no tick
 * of its own; what the phase tick means is that the phase's REQUIRED work is
 * done. A phase holding only optional sections falls back to counting them all,
 * so it cannot tick before anything has been filled in.
 *
 * An EMPTY phase reports pending, not done: `[].every(...)` is true, so without
 * this guard a phase with nothing in it would render a tick. Unreachable under
 * the six rules (asserted in the suite), guarded anyway.
 */
export function phaseStates(
  job: unknown,
): [PhaseNodeState, PhaseNodeState, PhaseNodeState, PhaseNodeState] {
  const views = sectionStates(job);
  const states = PHASE_ORDER.map((phase) => {
    const sections = views.filter((v) => v.phase === phase);
    if (sections.length === 0) return "pending";
    const gating = sections.filter((v) => v.gates !== false);
    const counted = gating.length > 0 ? gating : sections;
    if (counted.every((v) => v.state === "complete")) return "done";
    if (sections.some((v) => v.state === "active")) return "current";
    return "pending";
  });
  return [states[0], states[1], states[2], states[3]];
}

// ── Job bar ──────────────────────────────────────────────────────────────────

/**
 * The job-bar edit view (3.3c) — everything the edit dialog pre-fills, plus THE
 * ADDRESS LOCK RULE (F82). The rule lives HERE, pure and tested, never inside a
 * component: the address locks the moment ANY of the four tables that DERIVE
 * from it carries a row — roof_geometry, sizing_results, tariffs,
 * interval_data. Those four and no others: a bill or a survey does not follow
 * from the address. The lock follows the DERIVED ROWS, not the address string —
 * an unrecorded address with roof geometry still locks. The server enforces the
 * same rule with a 409; this view only decides what the dialog shows.
 */
export interface JobEditView {
  jobId: string;
  /** "" when not recorded. */
  address: string;
  /** "" when null. */
  customerName: string;
  hasExistingSolar: boolean | null;
  /** Strings because they feed <input>s: "" when null, never "null"/"0". */
  existingSolarKw: string;
  existingInverterKw: string;
  intent: JobIntent | null;
  addressLocked: boolean;
  /** The exact on-screen sentence when locked; NULL when not — never "". */
  addressLockReason: string | null;
}

export const ADDRESS_LOCK_REASON =
  "The address is locked because this job has already been measured against it. Roof geometry, irradiance, network and incentives all follow from it — a different address is a different job. Create a new job instead.";

const ADDRESS_LOCK_TABLES = [
  "roof_geometry",
  "sizing_results",
  "tariffs",
  "interval_data",
] as const;

function editStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function editKw(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function jobEditView(job: unknown): JobEditView {
  const detail = asObject(job);
  const record = detail as Record<string, unknown>;
  const customer = arr(detail.customer);
  const intentRaw = record.intent;
  const intent: JobIntent | null =
    intentRaw === "solar" || intentRaw === "battery" || intentRaw === "both"
      ? intentRaw
      : null;
  const addressLocked = ADDRESS_LOCK_TABLES.some(
    (table) => arr(record[table]).length > 0,
  );
  return {
    jobId: editStr(record.job_id),
    address: editStr(customer[0]?.property_address_full),
    customerName: editStr(customer[0]?.customer_name),
    hasExistingSolar:
      typeof record.has_existing_solar === "boolean"
        ? record.has_existing_solar
        : null,
    existingSolarKw: editKw(record.existing_solar_kw),
    existingInverterKw: editKw(record.existing_inverter_kw),
    intent,
    addressLocked,
    addressLockReason: addressLocked ? ADDRESS_LOCK_REASON : null,
  };
}

export interface JobBarView {
  address: string;
  statusRaw: string;
  jobTypeLabel: string;
  /** Passed straight through — AccuracyMeter renders non-1|2|3 as "not yet assessed" (C10). */
  tier: number | null;
  /** 3.3c — what the pencil's edit dialog opens with. */
  edit: JobEditView;
}

export function jobBarView(job: unknown): JobBarView {
  const detail = asObject(job);
  const customer = arr(detail.customer);
  const address = customer[0]?.property_address_full;
  const hasPath =
    typeof detail.path_label === "string" &&
    detail.path_label !== "" &&
    typeof detail.path === "string" &&
    detail.path !== "";
  return {
    address:
      typeof address === "string" && address.trim()
        ? address
        : "Address not recorded",
    statusRaw: typeof detail.status === "string" ? detail.status : "",
    jobTypeLabel: hasPath
      ? `${detail.path_label} (${detail.path})`
      : "Job type not set",
    tier: typeof detail.accuracy_tier === "number" ? detail.accuracy_tier : null,
    edit: jobEditView(job),
  };
}

// ── Results bar ──────────────────────────────────────────────────────────────

export type ResultsBarView =
  | { sized: false }
  | {
      sized: true;
      solarKw: number | null;
      batteryKwh: number | null;
      paybackYears: number | null;
      npv: number | null;
    };

/**
 * Discriminated on `sized` — the component branches on this, never on the
 * truthiness of a number. `sized: false` covers both an empty sizing_results
 * AND rows whose figures are all null (the fallback list's "present but with
 * null figures" case): either way there is nothing real to show.
 */
export function resultsBarView(job: unknown): ResultsBarView {
  const detail = asObject(job);
  const rows = arr(detail.sizing_results);
  const sized = rows.filter(
    (r) => r.solar_kw != null || r.battery_kwh != null,
  );
  if (sized.length === 0) return { sized: false };

  const latest = sized[sized.length - 1];
  const fin = arr(detail.financial_results);
  const latestFin = fin.length > 0 ? fin[fin.length - 1] : undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    sized: true,
    solarKw: num(latest.solar_kw),
    batteryKwh: num(latest.battery_kwh),
    paybackYears: num(latestFin?.payback_years),
    npv: num(latestFin?.npv_25_year),
  };
}

// ── Address & roof (3.4-B) ───────────────────────────────────────────────────

/**
 * The NEWEST roof_geometry row by created_at, or null. Rows are APPEND-ONLY and
 * the newest supersedes (3.4-A's module docstring) — that is what lets a manual
 * entry override an auto lookup while both survive for the ML flywheel.
 *
 * A row with no usable created_at sorts OLDEST and can never win a tie (strict
 * `>` against dated rows; the earliest of the dateless wins only when every row
 * is dateless). Tolerates the key absent, non-arrays and junk rows. Never throws.
 */
export function latestRoofGeometry(job: unknown): Record<string, unknown> | null {
  const rows = arr(asObject(job).roof_geometry);
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestTime = roofRowTime(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    const time = roofRowTime(rows[i]);
    if (time > bestTime) {
      best = rows[i];
      bestTime = time;
    }
  }
  return best;
}

function roofRowTime(row: Record<string, unknown>): number {
  const raw = row.created_at;
  if (typeof raw !== "string" || !raw) return -Infinity;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : -Infinity;
}

export type RoofEntryState =
  | "none"
  | "found"
  | "not_found"
  | "low_confidence"
  | "manual";

/**
 * Precedence, deliberately: manual beats everything (an installer's entry is
 * the record even if the row also carries a low-confidence marker), then
 * not-found, then low-confidence, then found.
 */
export function roofEntryState(row: unknown): RoofEntryState {
  if (typeof row !== "object" || row === null) return "none";
  const r = row as Record<string, unknown>;
  if (typeof r.source === "string" && r.source.startsWith("manual_")) return "manual";
  if (r.manual_entry_required === true || r.found !== true) return "not_found";
  if (r.low_confidence === true || r.needs_manual_confirmation === true) {
    return "low_confidence";
  }
  return "found";
}

/** Mirrors backend/roof_geometry.py IMPLAUSIBLE_PITCH_DEGREES — keep the two equal. */
const IMPLAUSIBLE_PITCH_DEGREES = 45;

/* Mirrors backend/solar_retention.py SOLAR_DATA_RETENTION_DAYS — keep equal. */
export const SOLAR_DATA_RETENTION_DAYS = 30;

const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/** Degrees → 16-point compass label. Normalises negatives and >360; null in, null out. */
export function azimuthLabel(deg: unknown): string | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return null;
  const normalised = ((deg % 360) + 360) % 360;
  return COMPASS_16[Math.round(normalised / 22.5) % 16];
}

export interface RoofPlaneView {
  index: number;
  label: string | null;
  azimuth: number | null;
  azimuthLabel: string | null;
  pitch: number | null;
  areaM2: number | null;
  usableAreaM2: number | null;
  panelCount: number | null;
  kwp: number | null;
}

export interface RoofNoticeView {
  tone: "info" | "success" | "caution" | "problem";
  title: string;
  body: string;
  /**
   * D25 (2026-08-17, closes F96): notices split on SPECIFICITY, not severity.
   * "notice"  — a FINDING about THIS job; keeps the bordered Notice.
   * "caption" — a FACT about how the tool works; renders as the quiet
   *             NoticeCaption (muted, no border, no fill), always BELOW the
   *             notices. The one question: could this ever NOT fire on a job
   *             like this one? No → caption. Yes → notice.
   * REQUIRED with no default so TypeScript forces every producer to state it —
   * a future notice cannot silently inherit a level. The classification lives
   * HERE, in the logic layer, never inside a component.
   */
  level: "notice" | "caption";
  /** Caption glyph only: Info for a method fact, Clock for an age/recency fact. */
  icon?: "info" | "clock";
}

export interface AddressRoofView {
  state: RoofEntryState;
  address: string;
  planes: RoofPlaneView[];
  totals: { panels: number; kwp: number };
  imageryDate: string | null;
  imageryQualityLabel: string | null;
  imageryStale: boolean;
  imageryAgeYears: number | null;
  sourceLabel: string | null;
  lat: number | null;
  lng: number | null;
  panelLabel: string | null;
  usabilityFactor: number | null;
  note: string | null;
  crossCheck: {
    jobState: string | null;
    jobPostcode: string | null;
    geocodedState: string | null;
    geocodedPostcode: string | null;
    mismatch: boolean;
  } | null;
  notice: RoofNoticeView | null;
  staleNotice: RoofNoticeView | null;
  /**
   * §20.2 (3.5b): the newest row's Google Solar Data is past its 30-day
   * retention. Deliberately an OR of three signals — the backend's redaction
   * flag, the sweep's tombstone, and a client-side age check — so the expired
   * state shows even if neither server mechanism has run. Never true for a
   * manual_* source. false, never null.
   */
  solarDataExpired: boolean;
  solarDataCapturedAt: string | null;
  /** The §20.2 caution, rendered in the same slot as the 3.4-C cautions. */
  solarExpiredNotice: RoofNoticeView | null;
  /** One caution per low-confidence cause (3.4-C). Empty array, never null. */
  confidenceNotices: RoofNoticeView[];
  /** From PATH_RULES via pathRule() — 3.3b's fields, first consumer. */
  solarMode: PathRule["solarMode"] | null;
  showsExistingArray: boolean;
}

function roofNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const SOURCE_LABELS: Record<string, string> = {
  google_solar: "Google Solar",
  manual_plans: "Entered from plans",
  manual_site_measure: "Entered from a site measure",
  manual_estimate: "Estimated",
};

const QUALITY_LABELS: Record<string, string> = {
  HIGH: "High-quality imagery",
  MEDIUM: "Medium-quality imagery",
  LOW: "Low-quality imagery",
};

function roofStateNotice(
  state: RoofEntryState,
  source: string | null,
): RoofNoticeView | null {
  switch (state) {
    // D25: the success ticks fire on EVERY job of their kind — method facts,
    // so captions. Agrees with D24 (the lookup is a prefill awaiting
    // confirmation) and 3.4c(a)'s planned rework of the tick.
    case "found":
      return {
        tone: "success",
        level: "caption",
        title: "Roof found",
        body: "Google's aerial imagery found this roof automatically.",
      };
    case "not_found":
      // Fires on roughly one address in five — it CAN not fire, so a finding.
      return {
        tone: "info",
        level: "notice",
        title: "No aerial photo out here",
        body: "The aerial imagery doesn't cover this area — that's normal for about one address in five. Entering the roof from plans is the accurate way to do it anyway.",
      };
    case "low_confidence":
      // Generic since 3.4-C: the new-build wording moved into its own cause, and
      // the specific reasons render as confidenceNotices below this one.
      return {
        tone: "caution",
        level: "notice",
        title: "Check this roof before you use it",
        body: "The lookup returned a result, but something about it does not look right. The details are below.",
      };
    case "manual":
      if (source === "manual_plans") {
        return {
          tone: "success",
          level: "caption",
          title: "Entered from plans",
          body: "Plans are the most accurate roof source we can get.",
        };
      }
      if (source === "manual_site_measure") {
        return {
          tone: "success",
          level: "caption",
          title: "Entered from a site measure",
          body: "Measured on site by the installer.",
        };
      }
      return {
        tone: "success",
        level: "caption",
        title: "Estimated",
        body: "A best estimate — refine it from plans when you can.",
      };
    default:
      return null;
  }
}

/**
 * D25 captions previously composed inside address-roof-section.tsx, moved here
 * because the classification must live in the logic layer. Wording unchanged
 * (3.4c owns wording). Both are method facts: the multi-dwelling caution is
 * true of the METHOD on every unit, and the pre-fill caution is true of every
 * pre-filled form.
 */
export const MULTI_DWELLING_CAPTION: RoofNoticeView = {
  tone: "caution",
  level: "caption",
  title: "The roof lookup may not be this dwelling",
  body: "Google returns the one building nearest the address. On a multi-dwelling site that may not be this one. Check the roof against the plans, and note that a shared roof usually needs body corporate approval.",
};

export const PREFILL_FROM_LOOKUP_CAPTION: RoofNoticeView = {
  tone: "caution",
  level: "caption",
  title: "These values came from the lookup",
  body: "They are Google's numbers, not yours. Change what is wrong, and only choose a source below that matches how you actually checked it.",
};


/**
 * The low-confidence cautions for a stored roof row (3.4-C), one per cause.
 *
 * Causes are read from the row's `flags` array, NOT from `low_confidence_causes`:
 * a row written before 3.4-C has flags but no such key, and the newest-row rule
 * means such a row can still be the one on screen. The displayed pitch is
 * likewise derived from `planes` rather than a stored `max_flagged_pitch`, for
 * the same reason.
 *
 * An UNRECOGNISED `low_confidence_*` flag still produces a visible caution —
 * never silence. A cause we cannot name is exactly the case an installer most
 * needs told about.
 */
function confidenceNotices(row: Record<string, unknown>): RoofNoticeView[] {
  const flags = Array.isArray(row.flags)
    ? row.flags.filter((f): f is string => typeof f === "string")
    : [];
  const causes = new Set(
    flags
      .filter((f) => f.startsWith("low_confidence_") && f !== "low_confidence_result")
      .map((f) => f.slice("low_confidence_".length)),
  );
  if (causes.size === 0) return [];

  // Steepest pitch among planes that actually carry panels — a steep face with no
  // panels contributes nothing and is not what the notice is about.
  let steepest: number | null = null;
  for (const plane of arr(row.planes)) {
    const pitch = plane.pitch;
    const count = plane.panel_count;
    if (
      typeof pitch === "number" &&
      Number.isFinite(pitch) &&
      pitch > IMPLAUSIBLE_PITCH_DEGREES &&
      typeof count === "number" &&
      count > 0 &&
      (steepest === null || pitch > steepest)
    ) {
      steepest = pitch;
    }
  }

  const notices: RoofNoticeView[] = [];
  if (causes.delete("implausible_pitch")) {
    const degrees = steepest !== null ? `${Math.round(steepest)}°` : "that angle";
    notices.push({
      tone: "caution",
      level: "notice",
      title: "One of these faces is too steep to be a roof",
      body: `A roof face at ${degrees} is closer to a wall than a roof, and it is carrying panels in the table below. It is still shown so you can see it — check it against the plans before you rely on this.`,
    });
  }
  if (causes.delete("no_google_panel_layout")) {
    notices.push({
      tone: "caution",
      level: "notice",
      title: "Google could not fit any panels on this building",
      body: "Its model placed none at all, so the panel count below was worked out from the roof area alone rather than from a real layout. Treat it as an upper bound and confirm against the plans.",
    });
  }
  // Both deletes must run — `||` would short-circuit and leave the second cause in
  // the set, where it would fall through to the unknown-cause branch below and
  // render a spurious second notice.
  const tooFewSegments = causes.delete("too_few_segments");
  const tooFewPanels = causes.delete("too_few_panels");
  if (tooFewSegments || tooFewPanels) {
    notices.push({
      tone: "caution",
      level: "notice",
      title: "This may be a newer build than the photo",
      body: "The aerial photo looks like it predates this house, so the roof found may not be the real one. Confirm against the plans.",
    });
  }
  // Anything left is a cause this build does not know about — say so, never hide it.
  for (const unknown of causes) {
    notices.push({
      tone: "caution",
      level: "notice",
      title: "Something about this result looks wrong",
      body: `The lookup flagged "${unknown}", which this version does not have wording for. Check the roof against the plans before relying on it.`,
    });
  }
  return notices;
}

/**
 * The serialisable view the Address & roof section renders — plain data only,
 * no functions, because it crosses the server/client boundary. Every field
 * degrades: a malformed row yields state "none" and a usable view, never a
 * throw. solarMode / showsExistingArray are READ from PATH_RULES (3.3b built
 * them for exactly this; behaviour is never re-derived from the path letter).
 */
export function addressRoofView(job: unknown): AddressRoofView {
  const detail = asObject(job);
  const rule = pathRule(detail.path);
  const view: AddressRoofView = {
    state: "none",
    address: jobBarView(job).address,
    planes: [],
    totals: { panels: 0, kwp: 0 },
    imageryDate: null,
    imageryQualityLabel: null,
    imageryStale: false,
    imageryAgeYears: null,
    sourceLabel: null,
    lat: null,
    lng: null,
    panelLabel: null,
    usabilityFactor: null,
    note: null,
    crossCheck: null,
    notice: null,
    staleNotice: null,
    solarDataExpired: false,
    solarDataCapturedAt: null,
    solarExpiredNotice: null,
    confidenceNotices: [],
    solarMode: rule ? rule.solarMode : null,
    showsExistingArray: rule ? rule.showsExistingArray : false,
  };

  const row = latestRoofGeometry(job);
  if (!row) return view;
  view.state = roofEntryState(row);
  if (view.state === "none") return view;

  const source = typeof row.source === "string" ? row.source : null;
  view.sourceLabel = source ? SOURCE_LABELS[source] ?? source : null;
  view.lat = roofNum(row.lat);
  view.lng = roofNum(row.lng);
  view.usabilityFactor = roofNum(row.usability_factor);

  let panels = 0;
  let kwp = 0;
  for (const [index, plane] of arr(row.planes).entries()) {
    const azimuth = roofNum(plane.azimuth);
    const planeView: RoofPlaneView = {
      index,
      label: typeof plane.label === "string" && plane.label ? plane.label : null,
      azimuth,
      azimuthLabel: azimuthLabel(azimuth),
      pitch: roofNum(plane.pitch),
      areaM2: roofNum(plane.area_m2),
      usableAreaM2: roofNum(plane.usable_area_m2),
      panelCount: roofNum(plane.panel_count),
      kwp: roofNum(plane.kwp),
    };
    panels += planeView.panelCount ?? 0;
    kwp += planeView.kwp ?? 0;
    view.planes.push(planeView);
  }
  view.totals = { panels, kwp: Math.round(kwp * 1000) / 1000 };

  const imageryDate = typeof row.imagery_date === "string" ? row.imagery_date : null;
  view.imageryDate = imageryDate;
  view.imageryStale = row.imagery_stale === true;
  if (imageryDate) {
    const time = new Date(imageryDate).getTime();
    if (Number.isFinite(time)) {
      view.imageryAgeYears = Math.max(
        0,
        Math.floor((Date.now() - time) / (365.25 * 24 * 3600 * 1000)),
      );
    }
  }
  const quality = typeof row.imagery_quality === "string" ? row.imagery_quality : null;
  view.imageryQualityLabel = quality ? QUALITY_LABELS[quality] ?? quality : null;

  const panel = row.selected_panel;
  if (typeof panel === "object" && panel !== null) {
    const p = panel as Record<string, unknown>;
    const bits = [p.brand, p.model].filter((b) => typeof b === "string" && b);
    const watts = roofNum(p.watts);
    view.panelLabel =
      bits.length || watts !== null
        ? `${bits.join(" ")}${watts !== null ? ` ${watts} W` : ""}`.trim()
        : null;
  }

  const reason = typeof row.reason === "string" ? row.reason : null;
  view.note = reason?.startsWith("Manual entry: ")
    ? reason.slice("Manual entry: ".length)
    : null;

  const cc = row.site_cross_check;
  if (typeof cc === "object" && cc !== null) {
    const c = cc as Record<string, unknown>;
    view.crossCheck = {
      jobState: typeof c.job_state === "string" ? c.job_state : null,
      jobPostcode: typeof c.job_postcode === "string" ? c.job_postcode : null,
      geocodedState: typeof c.geocoded_state === "string" ? c.geocoded_state : null,
      geocodedPostcode:
        typeof c.geocoded_postcode === "string" ? c.geocoded_postcode : null,
      mismatch: c.mismatch === true,
    };
  }

  // ── §20.2 retention (3.5b) ─────────────────────────────────────────────
  view.solarDataCapturedAt =
    typeof row.solar_data_captured_at === "string" ? row.solar_data_captured_at : null;
  if (source === "google_solar") {
    const backendSaidSo = row.solar_data_expired === true;
    const tombstoned = isParseableDate(row.solar_data_expired_at);
    const referenceRaw = view.solarDataCapturedAt ?? row.created_at;
    const reference =
      typeof referenceRaw === "string" ? new Date(referenceRaw).getTime() : NaN;
    const tooOld =
      Number.isFinite(reference) &&
      Date.now() - reference > SOLAR_DATA_RETENTION_DAYS * 24 * 3600 * 1000;
    view.solarDataExpired = backendSaidSo || tombstoned || tooOld;
  }
  if (view.solarDataExpired) {
    // The Google content is deleted (or due for deletion): the imagery
    // metadata goes; OUR numbers — planes, totals, panel, usability — stay
    // exactly as computed above. imageryStale, the confidence notices and the
    // cross-check are deliberately untouched.
    view.imageryDate = null;
    view.imageryQualityLabel = null;
    view.solarExpiredNotice = {
      tone: "caution",
      // A finding: the §20.2 expiry fires only when THIS job's data aged out.
      level: "notice",
      title: "Google's roof data for this job has been deleted",
      body: "Google only lets us keep the aerial roof data for 30 days. The roof sizes below are ours and are unchanged. Refresh to bring back the aerial view and the panel layout.",
    };
  }

  view.confidenceNotices = confidenceNotices(row);
  view.notice = roofStateNotice(view.state, source);
  if (view.imageryStale && view.state !== "manual") {
    const years = view.imageryAgeYears;
    view.staleNotice = {
      tone: "caution",
      // D25's founding case (F96): every located Australian building returns
      // imagery dated 2018-11-17, so this fires on 100% of jobs — a method
      // fact, quiet. Clock, because it is an age fact.
      level: "caption",
      icon: "clock",
      title: years !== null ? `The photo is ${years} years old` : "The photo is old",
      body: "Anything built or planted since then will not appear. Worth a check against the plans.",
    };
  }
  return view;
}



// ── Site details (3.4b) ──────────────────────────────────────────────────────

export type DwellingType = "detached" | "townhouse" | "unit" | "other";

export interface SiteFieldView<T> {
  raw: T | null;
  /** For a form input — "" when null, never the string "null". */
  text: string;
}

export interface SiteDetailsView {
  storeys: SiteFieldView<number>;
  roofMaterial: SiteFieldView<string>;
  dwellingTypeField: SiteFieldView<string>;
  yearBuilt: SiteFieldView<number>;
  bedrooms: SiteFieldView<number>;
  floorAreaM2: SiteFieldView<number>;
  electricalPhase: SiteFieldView<string>;
  /** The discriminant — null unless the stored value is one of the four. */
  dwellingType: DwellingType | null;
  /**
   * F99 — true ONLY for `unit` and `townhouse`. Never for `detached`; never for
   * `other` (other means unknown, and warning on unknown is how a warning becomes
   * noise, F96); never for null (absence is not a signal). The DB stores
   * lowercase, and this deliberately does NOT case-fold: an uppercase value is
   * not a value the schema can produce, and guessing at it would be inventing a
   * signal. ONE derivation — both the Site details and Address & roof sections
   * read this same field.
   */
  showsMultiDwellingCaution: boolean;
}

const DWELLING_TYPES: readonly DwellingType[] = [
  "detached",
  "townhouse",
  "unit",
  "other",
];

function siteNumField(value: unknown): SiteFieldView<number> {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : null;
  return { raw, text: raw !== null ? String(raw) : "" };
}

function siteStrField(value: unknown): SiteFieldView<string> {
  const raw = typeof value === "string" && value !== "" ? value : null;
  return { raw, text: raw ?? "" };
}

/**
 * The serialisable Site details view (3.4b). D5 governs this section: every
 * field is optional, none of it gates anything, and the completion predicate is
 * deliberately NOT derived from this view. Tolerates any input; never throws.
 */
export function siteDetailsView(job: unknown): SiteDetailsView {
  const detail = asObject(job);
  const dwellingField = siteStrField(detail.dwelling_type);
  const dwellingType = DWELLING_TYPES.find((t) => t === dwellingField.raw) ?? null;
  return {
    storeys: siteNumField(detail.storeys),
    roofMaterial: siteStrField(detail.roof_material),
    dwellingTypeField: dwellingField,
    yearBuilt: siteNumField(detail.year_built),
    bedrooms: siteNumField(detail.bedrooms),
    floorAreaM2: siteNumField(detail.floor_area_m2),
    electricalPhase: siteStrField(detail.electrical_phase),
    dwellingType,
    showsMultiDwellingCaution: dwellingType === "unit" || dwellingType === "townhouse",
  };
}

// ── Manual-form pre-fill (3.4-D) ─────────────────────────────────────────────

/**
 * One row of the manual roof form. ALL STRINGS — these populate form inputs, and
 * a number here would fight React's controlled-input contract. This is the ONLY
 * definition of the shape: the component imports it rather than declaring its
 * own, so the mapping below cannot drift from the form it feeds.
 */
export interface PlaneFormRow {
  direction: string;
  exactDegrees: string;
  pitch: string;
  area: string;
  label: string;
}

export const EMPTY_PLANE_FORM_ROW: PlaneFormRow = {
  direction: "",
  exactDegrees: "",
  pitch: "",
  area: "",
  label: "",
};

/** The eight compass values the form's select offers, as strings. */
const COMPASS_POINT_VALUES = ["0", "45", "90", "135", "180", "225", "270", "315"];

function formNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * Stored planes → pre-filled form rows, so correcting one wrong number is an edit
 * rather than a full re-entry.
 *
 * An azimuth that is EXACTLY one of the eight compass points selects that point;
 * anything else selects "Exact degrees" with the number shown (173.1 is not
 * South). Numbers are stringified verbatim — no rounding, no unit suffix — because
 * a pre-fill that quietly rounds would change the installer's data just by opening
 * the form.
 *
 * Never throws: a non-array, or an entry that is not an object, yields [] or is
 * skipped.
 */
export function planeFormRowsFromView(planes: unknown): PlaneFormRow[] {
  if (!Array.isArray(planes)) return [];
  const rows: PlaneFormRow[] = [];
  for (const plane of planes) {
    if (typeof plane !== "object" || plane === null) continue;
    const p = plane as Record<string, unknown>;
    const azimuth = p.azimuth;
    let direction = "";
    let exactDegrees = "";
    if (typeof azimuth === "number" && Number.isFinite(azimuth)) {
      const asString = String(azimuth);
      if (COMPASS_POINT_VALUES.includes(asString)) {
        direction = asString;
      } else {
        direction = "exact";
        exactDegrees = asString;
      }
    }
    rows.push({
      direction,
      exactDegrees,
      pitch: formNumber(p.pitch),
      area: formNumber(p.areaM2),
      label: typeof p.label === "string" ? p.label : "",
    });
  }
  return rows;
}

function isParseableDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value !== "" &&
    Number.isFinite(new Date(value).getTime())
  );
}

/**
 * §20.2 attribution (3.5b, F79): "Includes solar data from Google" renders ONLY
 * when the roof on screen actually contains Google Solar data. A roof entered
 * from plans is the installer's own measurement and must not be credited to
 * Google.
 *
 * "found"/"low_confidence" ⇔ source === "google_solar": those two states arise
 * only from a found google_solar row, a manual row always resolves "manual",
 * and a google lookup that found nothing stores source NULL (roof_geometry.py
 * _blank) so it resolves "not_found" — correctly uncredited, since it holds no
 * Solar data.
 */
export function showsGoogleSolarAttribution(view: AddressRoofView): boolean {
  return view.state === "found" || view.state === "low_confidence";
}

// ── Panel-layout diagram (3.5 prompt 2) ──────────────────────────────────────
//
// Draws GOOGLE'S indicative panel layout — panels_raw at Google's stored panel
// size — and the measured building's extent over the satellite tile, so an
// installer can LOOK and tell whether the lookup measured their building (F99:
// buildingInsights returns the ONE building nearest the coordinate and no
// number can catch a wrong-building result whose geometry is internally
// consistent). This is NOT the proposed system: the table above shows the
// catalogue-panel numbers, and the two must never be conflated or reconciled.
// The building shape is an axis-aligned bounding BOX — the extent of the area
// Google measured — never a roof outline.

/**
 * The tile the backend proxies is FIXED at 640x360 (routes/roof.py sets
 * `size=640x360`, not client-controlled), and the component's container is
 * `aspect-video` (16:9). 640/360 IS exactly 16:9, which is the only reason the
 * SVG overlay and the <img> align at any rendered width — that equality is
 * load-bearing and nothing else protects it, so it is asserted in
 * verify-worksheet-logic.ts. The overlay viewBox and every pixel computed
 * below derive from this pair.
 */
export const TILE_W = 640;
export const TILE_H = 360;
/**
 * Pixel-density multiplier for the DIAGRAM's tile request (Maps Static
 * `scale`). scale=2 returns twice the pixels at the SAME ground coverage —
 * a sharper photo, identical geography — so the viewBox stays 0 0 640 360 and
 * NO projection maths involves it: none of the functions below take a scale
 * argument (asserted in verify-worksheet-logic.ts, so a sharper tile can
 * never silently shift the overlay). Billing checked 2026-08-17: Static Maps
 * bills per map load; scale is not a billing dimension.
 */
export const TILE_IMG_SCALE = 2;
/** routes/roof.py's default zoom — used when there is no building box to fit. */
export const DEFAULT_TILE_ZOOM = 19;
/** The tile endpoint's own clamp — never request outside it. */
const TILE_ZOOM_MIN = 17;
const TILE_ZOOM_MAX = 21;
/** fitZoomForBuilding keeps at least this fraction of the frame clear on every side. */
const TILE_FIT_PADDING = 0.15;
/** Web Mercator breaks down past ±85°; nothing in Australia comes close. */
const MAX_MERCATOR_LAT = 85;
/** Ground metres per pixel at the equator at zoom 0, scale 1 (256px world). */
const EQUATOR_METRES_PER_PIXEL = 156543.03392;

/** World size in pixels at scale=1 (the tile endpoint sets no `scale`). */
export function worldSizePx(zoom: number): number | null {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  const size = 256 * 2 ** zoom;
  return Number.isFinite(size) ? size : null;
}

/**
 * Web Mercator projection to world pixels. Null — never NaN — on non-finite
 * input or a latitude outside ±85: a NaN that reaches an SVG attribute renders
 * nothing and reports nothing.
 */
export function projectWebMercator(
  lat: number,
  lng: number,
  zoom: number,
): { x: number; y: number } | null {
  const size = worldSizePx(zoom);
  if (size === null) return null;
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > MAX_MERCATOR_LAT) return null;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lng + 180) / 360) * size;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    size;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Ground metres per tile pixel at this latitude and zoom. Null on junk input. */
export function metresPerPixel(lat: number, zoom: number): number | null {
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > MAX_MERCATOR_LAT) return null;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  const mpp = (EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return Number.isFinite(mpp) && mpp > 0 ? mpp : null;
}

/**
 * Pixel position of a lat/lng ON THE TILE. The projection origin and the tile
 * centre MUST be the same point: the tile <img> is requested centred on
 * (centreLat, centreLng) and this maps that exact point to (320, 180) — if the
 * two ever differ, every drawn shape is offset by exactly that difference and
 * it looks like a rotation bug.
 */
export function tilePixel(
  lat: number,
  lng: number,
  centreLat: number,
  centreLng: number,
  zoom: number,
): { px: number; py: number } | null {
  const p = projectWebMercator(lat, lng, zoom);
  const c = projectWebMercator(centreLat, centreLng, zoom);
  if (!p || !c) return null;
  const px = TILE_W / 2 + (p.x - c.x);
  const py = TILE_H / 2 + (p.y - c.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { px, py };
}

/** {latitude, longitude} (Google's shape) → {lat, lng}, or null. */
function latLngOf(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const lat = roofNum(v.latitude);
  const lng = roofNum(v.longitude);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * The LARGEST integer zoom (clamped to the endpoint's 17..21) at which the
 * building bounding box fits inside the 640x360 tile centred on `centre`, with
 * at least 15% of the frame clear on every side — so the measured building
 * fills the frame while the NEIGHBOURING buildings stay visible for
 * comparison. Neighbours are the point: this picture is a comparison, not a
 * portrait. Null when the box or centre cannot be read; if even the widest
 * allowed zoom cannot contain the box, returns that widest zoom (17).
 */
export function fitZoomForBuilding(
  bbox: unknown,
  centre: { lat: number; lng: number },
): number | null {
  if (typeof bbox !== "object" || bbox === null) return null;
  if (!latLngOf({ latitude: centre?.lat, longitude: centre?.lng })) return null;
  const b = bbox as Record<string, unknown>;
  const ne = latLngOf(b.ne);
  const sw = latLngOf(b.sw);
  if (!ne || !sw) return null;
  const corners = [
    [ne.lat, ne.lng],
    [ne.lat, sw.lng],
    [sw.lat, ne.lng],
    [sw.lat, sw.lng],
  ];
  const minX = TILE_W * TILE_FIT_PADDING;
  const maxX = TILE_W * (1 - TILE_FIT_PADDING);
  const minY = TILE_H * TILE_FIT_PADDING;
  const maxY = TILE_H * (1 - TILE_FIT_PADDING);
  for (let zoom = TILE_ZOOM_MAX; zoom >= TILE_ZOOM_MIN; zoom--) {
    let fits = true;
    for (const [lat, lng] of corners) {
      const p = tilePixel(lat, lng, centre.lat, centre.lng, zoom);
      if (!p || p.px < minX || p.px > maxX || p.py < minY || p.py > maxY) {
        fits = false;
        break;
      }
    }
    if (fits) return zoom;
  }
  return TILE_ZOOM_MIN;
}

/**
 * Why the panel rectangles cannot be drawn. NEVER an empty array instead: []
 * would render as "no panels on this roof", which is a claim, not a fallback.
 * `dimensions_not_stored` is the CORRECT state for rows captured before 3.5
 * prompt 1 — not an error.
 */
export type RoofDiagramReason =
  | "no_panel_positions"
  | "dimensions_not_stored"
  | "segment_join_failed"
  | "no_coordinates"
  | "solar_data_expired";

export interface PanelRect {
  cx: number;
  cy: number;
  widthPx: number;
  heightPx: number;
  rotationDeg: number;
  /** Google's segment index — lets the component vary styling per roof face. */
  segmentIndex: number;
}

export type PanelRectanglesResult =
  | { rects: PanelRect[]; reason: null }
  | { rects: null; reason: RoofDiagramReason };

/**
 * §20.2 — the same three-signal OR as addressRoofView's solarDataExpired
 * (backend redaction flag, sweep tombstone, client-side age check), kept
 * inline there because its 75-test suite pins that function. Google-sourced
 * rows only; a manual row is never expired.
 */
function rowSolarDataExpired(row: Record<string, unknown>): boolean {
  if (row.source !== "google_solar") return false;
  if (row.solar_data_expired === true) return true;
  if (isParseableDate(row.solar_data_expired_at)) return true;
  const referenceRaw =
    typeof row.solar_data_captured_at === "string"
      ? row.solar_data_captured_at
      : row.created_at;
  const reference =
    typeof referenceRaw === "string" ? new Date(referenceRaw).getTime() : NaN;
  return (
    Number.isFinite(reference) &&
    Date.now() - reference > SOLAR_DATA_RETENTION_DAYS * 24 * 3600 * 1000
  );
}

/** The tile centre + zoom for a row: building_center (falling back to the row's
 *  lat/lng) and the fitted zoom (falling back to the endpoint default). */
function diagramFrame(
  row: Record<string, unknown>,
): { lat: number; lng: number; zoom: number } | null {
  const centre =
    latLngOf(row.building_center) ??
    (roofNum(row.lat) !== null && roofNum(row.lng) !== null
      ? { lat: roofNum(row.lat) as number, lng: roofNum(row.lng) as number }
      : null);
  if (!centre) return null;
  const zoom =
    fitZoomForBuilding(row.building_bounding_box, centre) ?? DEFAULT_TILE_ZOOM;
  return { lat: centre.lat, lng: centre.lng, zoom };
}

/**
 * THE SEGMENT JOIN. Each stored panel carries `segmentIndex` in GOOGLE'S
 * segment numbering; planes[] was built by iterating Google's segments with a
 * `continue` past malformed ones, so `planes[segmentIndex]` is WRONG the
 * moment any segment was skipped — panels silently attach to the wrong roof
 * face with the wrong azimuth, and the diagram still looks reasonable.
 * Resolution order per plane:
 *   1. the explicit `segment_index` written by _normalise since 3.5 prompt 2;
 *   2. for older rows: the plane's `center` matched EXACTLY against
 *      segment_bounding_boxes[].center (same source object copied into both,
 *      verified 4/4 exact on the live row);
 *   3. otherwise the plane is unresolvable — any panel referencing it FAILS
 *      CLOSED (segment_join_failed), because a partly-wrong diagram is worse
 *      than no diagram.
 * The map holds a LIST per index so a duplicate claim (two planes resolving to
 * one segment) is detectable as ambiguity rather than silently last-wins.
 */
function planesBySegmentIndex(
  row: Record<string, unknown>,
): Map<number, Record<string, unknown>[]> {
  const map = new Map<number, Record<string, unknown>[]>();
  const boxes = arr(row.segment_bounding_boxes);
  for (const plane of arr(row.planes)) {
    let index: number | null = null;
    const explicit = plane.segment_index;
    if (typeof explicit === "number" && Number.isInteger(explicit) && explicit >= 0) {
      index = explicit;
    } else {
      const centre = latLngOf(plane.center);
      if (centre) {
        const matches: number[] = [];
        for (const box of boxes) {
          const boxCentre = latLngOf(box.center);
          const boxIndex = box.segment_index;
          if (
            boxCentre !== null &&
            boxCentre.lat === centre.lat &&
            boxCentre.lng === centre.lng &&
            typeof boxIndex === "number" &&
            Number.isInteger(boxIndex)
          ) {
            matches.push(boxIndex);
          }
        }
        if (matches.length === 1) index = matches[0];
      }
    }
    if (index !== null) {
      const list = map.get(index) ?? [];
      list.push(plane);
      map.set(index, list);
    }
  }
  return map;
}

/**
 * One rectangle per stored panel, in tile pixel space, or a named reason.
 *
 * ORIENTATION CONVENTION (an explicit assumption — no unit test can settle it;
 * it is settled by looking at the photo): Google's panelHeightMeters (1.879 m,
 * the long side) runs UP THE ROOF SLOPE in PORTRAIT and ACROSS the slope in
 * LANDSCAPE. So the un-rotated rectangle has heightPx along the screen's
 * vertical axis = the up-slope dimension: PORTRAIT maps panelHeightMeters to
 * heightPx, LANDSCAPE swaps the two. An unrecognised orientation string is
 * drawn as LANDSCAPE (Google's usual layout) rather than failing the diagram.
 *
 * ROTATION SIGN: Google's azimuth is degrees CLOCKWISE FROM NORTH (the
 * direction the face slopes down towards). On screen, north is up and SVG
 * rotation is also clockwise (positive angles turn the up-axis towards east,
 * because y increases downward). An un-rotated rectangle's up-slope axis
 * points north; rotating it clockwise by `azimuth` points that axis at the
 * face's compass bearing — the two conventions run the same way, so
 * rotationDeg = azimuth with NO sign flip.
 */
export function panelRectangles(row: unknown): PanelRectanglesResult {
  if (typeof row !== "object" || row === null) {
    return { rects: null, reason: "no_coordinates" };
  }
  const r = row as Record<string, unknown>;
  if (rowSolarDataExpired(r)) {
    return { rects: null, reason: "solar_data_expired" };
  }
  const frame = diagramFrame(r);
  if (!frame) return { rects: null, reason: "no_coordinates" };
  const panels = arr(r.panels_raw);
  if (!Array.isArray(r.panels_raw) || panels.length === 0) {
    return { rects: null, reason: "no_panel_positions" };
  }
  const widthM = roofNum(r.google_panel_width_m);
  const heightM = roofNum(r.google_panel_height_m);
  if (widthM === null || heightM === null || widthM <= 0 || heightM <= 0) {
    return { rects: null, reason: "dimensions_not_stored" };
  }
  const bySegment = planesBySegmentIndex(r);
  const rects: PanelRect[] = [];
  for (const panel of panels) {
    const segmentIndex = panel.segmentIndex;
    if (typeof segmentIndex !== "number" || !Number.isInteger(segmentIndex)) {
      return { rects: null, reason: "segment_join_failed" };
    }
    const candidates = bySegment.get(segmentIndex);
    if (!candidates || candidates.length !== 1) {
      return { rects: null, reason: "segment_join_failed" };
    }
    const plane = candidates[0];
    const centre = latLngOf(panel.center);
    if (!centre) return { rects: null, reason: "no_coordinates" };
    const pos = tilePixel(centre.lat, centre.lng, frame.lat, frame.lng, frame.zoom);
    const mpp = metresPerPixel(centre.lat, frame.zoom);
    if (!pos || mpp === null) return { rects: null, reason: "no_coordinates" };
    const portrait = panel.orientation === "PORTRAIT";
    const widthPx = (portrait ? widthM : heightM) / mpp;
    const heightPx = (portrait ? heightM : widthM) / mpp;
    const azimuth = roofNum(plane.azimuth);
    rects.push({
      cx: pos.px,
      cy: pos.py,
      widthPx,
      heightPx,
      rotationDeg: azimuth ?? 0,
      segmentIndex,
    });
  }
  return { rects, reason: null };
}

/**
 * Everything the diagram needs, serialisable (it crosses the server/client
 * boundary). `show: false` means render NOTHING diagram-related: no roof row,
 * a not-found row, a manual roof (no Google layout, no Google attribution),
 * or expired Solar Data (the existing expired notice stands, and a box must
 * not be drawn from deleted data). With `show: true`, either `rects` is
 * populated or `reason` names why not — and the building box renders whenever
 * it can be computed, so a failed panel join still shows the measured extent.
 */
export interface RoofDiagramView {
  show: boolean;
  /** Tile request centre — the SAME point the rectangles are projected against. */
  tileLat: number | null;
  tileLng: number | null;
  zoom: number;
  /** The extent of the area Google measured — an axis-aligned box, NOT an outline. */
  buildingBox: { x: number; y: number; width: number; height: number } | null;
  rects: PanelRect[];
  reason: RoofDiagramReason | null;
  /** Count of DRAWN rectangles — Google's layout, never the table's number. */
  panelCount: number;
  panelWidthM: number | null;
  panelHeightM: number | null;
  panelCapacityW: number | null;
}

const HIDDEN_DIAGRAM: RoofDiagramView = {
  show: false,
  tileLat: null,
  tileLng: null,
  zoom: DEFAULT_TILE_ZOOM,
  buildingBox: null,
  rects: [],
  reason: null,
  panelCount: 0,
  panelWidthM: null,
  panelHeightM: null,
  panelCapacityW: null,
};

export function roofDiagramView(job: unknown): RoofDiagramView {
  const row = latestRoofGeometry(job);
  if (!row) return HIDDEN_DIAGRAM;
  const state = roofEntryState(row);
  if (state !== "found" && state !== "low_confidence") return HIDDEN_DIAGRAM;
  if (rowSolarDataExpired(row)) return HIDDEN_DIAGRAM;

  const frame = diagramFrame(row);
  if (!frame) {
    return { ...HIDDEN_DIAGRAM, show: true, reason: "no_coordinates" };
  }

  let buildingBox: RoofDiagramView["buildingBox"] = null;
  const bbox =
    typeof row.building_bounding_box === "object" && row.building_bounding_box !== null
      ? (row.building_bounding_box as Record<string, unknown>)
      : null;
  const ne = bbox ? latLngOf(bbox.ne) : null;
  const sw = bbox ? latLngOf(bbox.sw) : null;
  if (ne && sw) {
    const a = tilePixel(ne.lat, ne.lng, frame.lat, frame.lng, frame.zoom);
    const b = tilePixel(sw.lat, sw.lng, frame.lat, frame.lng, frame.zoom);
    if (a && b) {
      buildingBox = {
        x: Math.min(a.px, b.px),
        y: Math.min(a.py, b.py),
        width: Math.abs(a.px - b.px),
        height: Math.abs(a.py - b.py),
      };
    }
  }

  const result = panelRectangles(row);
  return {
    show: true,
    tileLat: frame.lat,
    tileLng: frame.lng,
    zoom: frame.zoom,
    buildingBox,
    rects: result.reason === null ? result.rects : [],
    reason: result.reason,
    panelCount: result.reason === null ? result.rects.length : 0,
    panelWidthM: roofNum(row.google_panel_width_m),
    panelHeightM: roofNum(row.google_panel_height_m),
    panelCapacityW: roofNum(row.google_panel_capacity_w),
  };
}

// ── Results-bar geometry + preference (3.3a) ─────────────────────────────────
//
// The risky arithmetic lives here, unit-tested, rather than inline in the
// component. The component owns only the DOM measurement (getBoundingClientRect
// for barTop, window.innerHeight for the viewport) and passes numbers in.

/** Floor — the bar never collapses below a legible metrics row. */
export const RESULTS_BAR_MIN_HEIGHT = 96;

/**
 * The worksheet strip that must stay visible BENEATH the bar, always. Decided
 * with Mayur 2026-08-13: without it a full-height drag makes the page look
 * broken, with no sections in sight.
 */
export const RESULTS_BAR_STRIP = 120;

/** Height of an expanded bar before the user has ever dragged it. */
export const RESULTS_BAR_DEFAULT_HEIGHT = 320;

/** Preference key — versioned so a future shape change cannot mis-parse this one. */
export const RESULTS_BAR_STORAGE_KEY = "enrgengine.worksheet.results-bar.v1";

/**
 * Decision D3, first clause: an unsized job opens numbers-only, because during
 * first-pass data entry the chart is empty and the bar is frozen, so its height
 * is spent on every screen. A stored preference always wins over this.
 *
 * D3's third clause — auto-expand on the first completed run — is NOT built
 * here: nothing can produce a sizing result until 3.11/3.12, so the trigger has
 * nothing to fire on and could not be tested. Moved to 3.14 with Mayur.
 */
export function resultsBarDefaultCollapsed(view: ResultsBarView): boolean {
  return view?.sized !== true;
}

/**
 * The tallest the bar may be while still leaving RESULTS_BAR_STRIP of worksheet
 * visible. Never returns less than the floor, and never a negative number —
 * non-finite or absurd inputs degrade to the floor rather than throwing.
 */
export function resultsBarMaxHeight(
  viewportHeight: number,
  barTop: number,
): number {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  const top = Number.isFinite(barTop) && barTop > 0 ? barTop : 0;
  return Math.max(RESULTS_BAR_MIN_HEIGHT, vh - top - RESULTS_BAR_STRIP);
}

/**
 * "This measurement cannot be trusted" — NOT "the bar must be tiny" (3.3a-fix2).
 *
 * No device this product targets has a window too short to show a 96px bar plus a
 * 120px strip of worksheet. So a computed ceiling at or below the floor is
 * evidence of a BAD READING, not a real constraint — and acting on it is what
 * squashed the bar to a stripe on 2026-08-14: a reload restores scroll position,
 * a viewport-relative barTop reads large, the ceiling collapses to the floor, and
 * the caller clamps a perfectly good bar down to 96px.
 *
 * The caller consults this FIRST and skips the update entirely when it is true.
 * `resultsBarMaxHeight` itself is unchanged — its arithmetic was never wrong.
 *
 * Widened past `number` to accept null/undefined so a missing measurement is a
 * normal input, not a cast at every call site.
 */
export function resultsBarCeilingIsSuspect(
  viewportHeight: number | null | undefined,
  barTop: number | null | undefined,
): boolean {
  if (typeof viewportHeight !== "number" || !Number.isFinite(viewportHeight)) return true;
  if (typeof barTop !== "number" || !Number.isFinite(barTop)) return true;
  if (barTop < 0) return true;
  return !(viewportHeight - barTop - RESULTS_BAR_STRIP > RESULTS_BAR_MIN_HEIGHT);
}

/**
 * What the component measures. `containerTop` is the viewport top of the bar's
 * SCROLLING ANCESTOR, which does not move when its content scrolls; `barTop` is
 * the bar's own rect top, which does. `barTop` is carried here ONLY so the tests
 * can prove it has no influence — the ceiling must never depend on it, and that
 * dependency is exactly the bug this row fixes.
 */
export interface ResultsBarMetrics {
  viewportHeight: number;
  /** null when no scrolling ancestor could be identified — treated as suspect. */
  containerTop: number | null;
  barTop: number;
}

/**
 * The bar's height ceiling, or null when the measurement is suspect and the
 * caller must leave the height alone.
 *
 * SCROLL-INDEPENDENT BY CONSTRUCTION: it reads `containerTop` and never `barTop`.
 * Two metrics differing only in `barTop` must yield the same number — asserted in
 * verify-worksheet-logic.ts, and the assertion fails if anyone reintroduces the
 * scrolled value.
 */
export function resultsBarCeiling(metrics: ResultsBarMetrics): number | null {
  const { viewportHeight, containerTop } = metrics;
  if (typeof containerTop !== "number" || !Number.isFinite(containerTop)) return null;
  if (resultsBarCeilingIsSuspect(viewportHeight, containerTop)) return null;
  return resultsBarMaxHeight(viewportHeight, containerTop);
}

/**
 * `desired` clamped into [floor, ceiling]. A NaN / Infinity / null / undefined
 * desired falls back to the default height — never NaN, never 0, never
 * negative. This is what re-clamps a height saved on a large monitor when the
 * same preference is read back on a laptop.
 *
 * Widened past the prompt's `desired: number` to `number | null | undefined`
 * so the null/undefined cases are callable without a cast (test 1d).
 */
export function clampResultsBarHeight(
  desired: number | null | undefined,
  viewportHeight: number,
  barTop: number,
): number {
  const max = resultsBarMaxHeight(viewportHeight, barTop);
  const value =
    typeof desired === "number" && Number.isFinite(desired)
      ? desired
      : RESULTS_BAR_DEFAULT_HEIGHT;
  return Math.min(max, Math.max(RESULTS_BAR_MIN_HEIGHT, value));
}

export interface ResultsBarPreference {
  collapsed: boolean;
  height: number;
}

/**
 * Parse the stored preference DEFENSIVELY — storage is user-writable and may
 * hold anything, including a shape from a future version. Returns null on any
 * surprise and never throws; the caller then uses the D3 default.
 *
 * The height that comes back is NOT trusted: the caller re-clamps it against
 * the CURRENT window before applying it.
 */
export function parseResultsBarPreference(
  raw: string | null,
): ResultsBarPreference | null {
  if (typeof raw !== "string" || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.collapsed !== "boolean") return null;
  if (typeof record.height !== "number" || !Number.isFinite(record.height)) {
    return null;
  }
  // THE SELF-HEAL (3.3a-fix2). A stored height at or below the floor is read as
  // NO PREFERENCE, so the D3 default applies and a browser already carrying a
  // squashed 96 recovers on its own — no console, no support call.
  //
  // TRADE-OFF, accepted deliberately: a user who genuinely dragged the bar to
  // exactly the floor loses that preference on reload. A 96px bar is barely
  // legible anyway, and one lost preference is far cheaper than a permanently
  // broken screen with no way out through the UI.
  if (record.height <= RESULTS_BAR_MIN_HEIGHT) return null;
  return { collapsed: record.collapsed, height: record.height };
}

// ── Error copy ───────────────────────────────────────────────────────────────

export interface WorksheetErrorCopy {
  heading: string;
  body: string;
}

/**
 * Worksheet-specific error wording — deliberately NOT lib/jobs' errorPanelCopy,
 * whose copy is worded for the /jobs tracker and has no 404 branch (and whose
 * 25 passing tests pin it). Never contains "Couldn't load jobs".
 *
 * The 404 case: the backend returns the same 404 for a bad id, a deleted job
 * and another company's job, so the copy must not imply which. Existence never
 * leaks. The page renders the back-to-/jobs link alongside this copy.
 */
export function worksheetErrorCopy(
  kind: ApiErrorKind,
  status: number,
  endpoint: string,
): WorksheetErrorCopy {
  switch (kind) {
    case "config":
      return {
        heading: "The worksheet can't load — the app is misconfigured",
        body: `NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Set both in the deployment environment and redeploy.`,
      };
    case "auth":
      return {
        heading: "Couldn't load this job — you may be signed out",
        body: `${endpoint} responded with HTTP ${status}. Your session may have expired — sign in again.`,
      };
    case "network":
      return {
        heading: "Couldn't load this job — the backend is unreachable",
        body: `The request to ${endpoint} never reached the server. Check the backend is running on port 8000.`,
      };
    case "parse":
      return {
        heading: "Couldn't load this job — the response was unreadable",
        body: `${endpoint} returned a response the app could not read. Try reloading, and check the backend logs if it persists.`,
      };
    case "http":
    default:
      if (kind === "http" && status === 404) {
        return {
          heading: "This job doesn't exist, or isn't yours",
          body: "The server answers identically for a job that was never created and a job that belongs to another company, so this page can't tell you which happened. Head back to the job list to find the job you meant.",
        };
      }
      if (kind === "http" && status === 503) {
        // DELIBERATELY says nothing about permissions, signing in or the session:
        // a 503 here means the server could not reach its own database, so it
        // could not check anything about you. Before the 2026-08-14 auth fix a
        // transient lookup failure surfaced as 403 "Forbidden" and sent installers
        // hunting an access problem that did not exist. Do not reword this toward
        // authorisation.
        return {
          heading: "Couldn't load this job — the server is briefly unavailable",
          body: "The server could not reach its database for a moment. This is usually temporary — wait a few seconds and reload.",
        };
      }
      return {
        heading: "Couldn't load this job",
        body: `${endpoint} responded with HTTP ${status}. The backend hit an error — try reloading, and check the backend logs if it persists.`,
      };
  }
}

// ── Energy data (3.6 prompt 2) ───────────────────────────────────────────────
//
// The interval branch of the Energy data section: a pure view over the STORED
// rows (energyDataView) and a pure mapping of a FRESH upload response
// (intervalUploadView), both mirroring how addressRoofView is built — total,
// tolerant of any shape, never throwing. The notice-vs-caption classification
// for every flag lives HERE (D25), never in the component.

/** Newest row by created_at — the same append-only rule roof_geometry follows. */
function newestByCreatedAt(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestTime = roofRowTime(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    const time = roofRowTime(rows[i]);
    if (time > bestTime) {
      best = rows[i];
      bestTime = time;
    }
  }
  return best;
}

/**
 * The tier as an INTEGER or null — C10: `accuracy_tier` is stored as 1/2/3,
 * never the string "tier_3". A string never becomes a number here, and a
 * non-integer number is not a tier.
 */
function intTier(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function roofStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A quality number off a row or response: finite and non-negative, else MISSING
 *  — a negative or junk value must read as absent, never as zero. */
function qualityNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** A tier narrowed to the three real values, else null. */
function knownTier(value: unknown): 1 | 2 | 3 | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

export interface IntervalFacts {
  coverageDays: number | null;
  gapDays: number | null;
  pctActual: number | null;
  intervalMinutes: number | null;
  tier: 1 | 2 | 3 | null;
}

/**
 * THE ONE readout builder (3.6 follow-up). There were two — one over the
 * upload response, one over the stored row — and that duplication is exactly
 * why the readout could vanish on reload: the row path read columns that were
 * never written. Both callers now build an IntervalFacts and call this;
 * NEITHER formats a part itself, so the fresh and the stored readout cannot
 * disagree about the same file.
 *
 * Every part is DERIVED or OMITTED, never invented: a null renders as nothing,
 * not as 0 days or 0% filled. And coverageDays is the parser's count of dates
 * that CARRY DATA — never the period span, which overstates on gappy files.
 */
export function intervalReadoutParts(facts: IntervalFacts): string[] {
  const parts: string[] = [];
  if (
    facts.coverageDays !== null &&
    facts.intervalMinutes !== null &&
    facts.intervalMinutes > 0
  ) {
    const count = Math.round(facts.coverageDays * (1440 / facts.intervalMinutes));
    parts.push(
      `${count.toLocaleString("en-AU")} ${facts.intervalMinutes === 30 ? "half-hours" : "readings"}`,
    );
  }
  if (facts.coverageDays !== null) {
    parts.push(`${facts.coverageDays} days`);
  }
  // A zero gap count says NOTHING — silence is the correct rendering of no gaps.
  if (facts.gapDays !== null && facts.gapDays > 0) {
    parts.push(`${facts.gapDays} day gap${facts.gapDays === 1 ? "" : "s"}`);
  }
  if (facts.pctActual !== null && facts.pctActual <= 100) {
    if (facts.pctActual === 100) {
      parts.push("all actual reads");
    } else {
      const filled = Math.round((100 - facts.pctActual) * 10) / 10;
      parts.push(`${filled}% filled`);
    }
  }
  if (facts.tier !== null) {
    parts.push(`Tier ${facts.tier}`);
  }
  return parts;
}

export interface EnergyDataView {
  state: "empty" | "have_interval";
  /** From load_profiles ONLY — never inferred from the presence of a file. */
  tier: number | null;
  nmi: string | null;
  source: string | null;
  coverageDays: number | null;
  gapDays: number | null;
  pctActual: number | null;
  intervalMinutes: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** From intervalReadoutParts — the SAME function the fresh upload uses. */
  readoutParts: string[];
  notices: RoofNoticeView[];
  /** The job's address (raw, null when absent) — for the bill cross-check. */
  address: string | null;
  /** The stored profile's 24 weights when valid, for the preview strip. */
  profileWeights: number[] | null;
  /** 3.6b: how much this house uses — from load_profiles, the figures every
   *  downstream calculation depends on and which appeared nowhere on screen. */
  annualKwh: number | null;
  dailyAvgKwh: number | null;
  /** Pre-filled survey answers from the stored surveys row. */
  survey: SurveyAnswers;
}

/**
 * The stored-state view: the newest interval_data row (append-only, newest
 * wins) plus the job's single load_profiles row. A job with an interval row
 * but NO load_profiles row reports tier null — the profile write failed and
 * showing Tier 3 off the mere presence of a file would be a lie the section's
 * completeness predicate cannot catch.
 */
export function energyDataView(job: unknown): EnergyDataView {
  const detail = asObject(job);
  const view: EnergyDataView = {
    state: "empty",
    tier: null,
    nmi: null,
    source: null,
    coverageDays: null,
    gapDays: null,
    pctActual: null,
    intervalMinutes: null,
    periodStart: null,
    periodEnd: null,
    readoutParts: [],
    notices: [],
    address: null,
    profileWeights: null,
    annualKwh: null,
    dailyAvgKwh: null,
    survey: { ...EMPTY_SURVEY_ANSWERS },
  };
  view.survey = surveyView(detail);
  const customer = arr(detail.customer);
  const address = customer[0]?.property_address_full;
  view.address = typeof address === "string" && address.trim() ? address : null;
  const row = newestByCreatedAt(arr(detail.interval_data));
  const profile = newestByCreatedAt(arr(detail.load_profiles));
  view.tier = profile ? intTier(profile.accuracy_tier) : null;
  if (profile) {
    view.annualKwh = qualityNum(profile.annual_kwh);
    view.dailyAvgKwh = qualityNum(profile.daily_avg_kwh);
    const weights = profile.hourly_profile_weights;
    if (
      Array.isArray(weights) &&
      weights.length === 24 &&
      weights.every((w) => typeof w === "number" && Number.isFinite(w))
    ) {
      view.profileWeights = weights as number[];
    }
  }
  if (!row) return view;

  view.state = "have_interval";
  view.nmi = roofStr(row.nmi);
  view.source = roofStr(row.source);
  view.coverageDays = qualityNum(row.coverage_days);
  view.gapDays = qualityNum(row.gap_days);
  view.pctActual = qualityNum(row.pct_actual);
  view.intervalMinutes = qualityNum(row.interval_minutes);
  view.periodStart = roofStr(row.period_start);
  view.periodEnd = roofStr(row.period_end);
  view.readoutParts = intervalReadoutParts({
    coverageDays: view.coverageDays,
    gapDays: view.gapDays,
    pctActual: view.pctActual,
    intervalMinutes: view.intervalMinutes,
    tier: knownTier(view.tier),
  });
  if (view.tier === null) {
    // A finding about THIS job: the file is on record but its profile is not.
    view.notices.push({
      tone: "caution",
      level: "notice",
      title: "The usage profile wasn't recorded",
      body: "The meter file is on record but its load profile didn't save, so the job's accuracy tier is not set. Upload the file again to re-record it.",
    });
  }
  return view;
}

/**
 * D25 classification of one interval-parser flag string. Matching is on the
 * parser's own wording (interval_parser.py composes these strings), and an
 * UNRECOGNISED flag becomes a NOTICE — defaulting an unknown to quiet is the
 * one direction that loses information (the 3.4-C precedent).
 */
function classifyIntervalFlag(flag: string): RoofNoticeView {
  const f = flag.toLowerCase();
  // Findings about THIS file — bordered notices.
  if (f.includes("annualised to a full year")) {
    return { tone: "caution", level: "notice", title: "Less than a full year of data", body: flag };
  }
  if (f.includes("day gap")) {
    return { tone: "caution", level: "notice", title: "There are gaps in this file", body: flag };
  }
  if (f.includes("multiple nmis")) {
    // The parser CHOSE one meter — which home the data belongs to is exactly
    // the F99 class of mistake.
    return { tone: "caution", level: "notice", title: "More than one meter in this file", body: flag };
  }
  if (f.includes("not fully saved") || f.includes("could not be saved") || f.includes("tier not updated")) {
    return { tone: "caution", level: "notice", title: "Not fully saved", body: flag };
  }
  // Method facts — true of every file of their kind. Quiet captions.
  if (f.includes("solar export channel")) {
    return { tone: "info", level: "caption", title: "", body: flag };
  }
  if (f.includes("generic csv")) {
    return { tone: "info", level: "caption", title: "", body: flag };
  }
  if (f.includes("actual reads") && f.includes("substituted")) {
    // RECLASSIFIED 3.6 prompt 3 (Item 0): this flag only exists when THIS file
    // contains substituted/estimated reads — a NEM12 that is 100% actual
    // produces no flag at all, so by D25's own question it CAN not fire and is
    // a FINDING, not a method fact. Prompt 2 shipped it as a caption in error.
    return {
      tone: "caution",
      level: "notice",
      title: "Some readings are estimates, not measurements",
      body: flag,
    };
  }
  // Unrecognised → visible caution, never silence.
  return { tone: "caution", level: "notice", title: "Something to check in this file", body: flag };
}

export interface IntervalUploadView {
  ok: boolean;
  /** The backend's own error string on the ok:false branch, verbatim. */
  error: string | null;
  /**
   * The one-line readout as ordered plain parts, e.g.
   * ["17,856 half-hours", "372 days", "0.2% filled", "Tier 3"]. Every part is
   * DERIVED from the response — a figure the response does not carry is
   * OMITTED from the array, never rendered as 0.
   */
  readoutParts: string[];
  /** Classified flags — findings (level "notice") sorted before captions. */
  notices: RoofNoticeView[];
  tier: number | null;
  persisted: boolean | null;
  loadProfileSaved: boolean | null;
}

/**
 * Map a FRESH /api/interval/upload response — of any shape whatsoever,
 * including ok:false and undefined — into the readout and classified notices.
 * Never throws; never assumes `metadata` exists.
 */
export function intervalUploadView(response: unknown): IntervalUploadView {
  const view: IntervalUploadView = {
    ok: false,
    error: null,
    readoutParts: [],
    notices: [],
    tier: null,
    persisted: null,
    loadProfileSaved: null,
  };
  if (typeof response !== "object" || response === null) return view;
  const r = response as Record<string, unknown>;

  if (r.ok !== true) {
    view.error =
      typeof r.error === "string" && r.error
        ? r.error
        : "Could not read this file.";
    return view;
  }
  view.ok = true;
  view.persisted = typeof r.persisted === "boolean" ? r.persisted : null;
  view.loadProfileSaved =
    typeof r.load_profile_saved === "boolean" ? r.load_profile_saved : null;

  const metadata =
    typeof r.metadata === "object" && r.metadata !== null
      ? (r.metadata as Record<string, unknown>)
      : {};
  const load =
    typeof r.load === "object" && r.load !== null
      ? (r.load as Record<string, unknown>)
      : {};

  view.tier = intTier(load.accuracy_tier);
  // ONE readout builder for the fresh response and the stored row — neither
  // caller formats a part itself, so the two can never disagree about the
  // same file (a missing number is OMITTED there, never rendered as 0).
  view.readoutParts = intervalReadoutParts({
    coverageDays: qualityNum(metadata.coverage_days),
    gapDays: qualityNum(metadata.gap_days),
    pctActual: qualityNum(metadata.pct_actual),
    intervalMinutes: qualityNum(metadata.resolution_minutes),
    tier: knownTier(view.tier),
  });

  const flags = Array.isArray(r.flags)
    ? r.flags.filter((f): f is string => typeof f === "string" && f !== "")
    : [];
  const classified = flags.map(classifyIntervalFlag);
  // D25 ordering: every finding above every caption.
  view.notices = [
    ...classified.filter((n) => n.level === "notice"),
    ...classified.filter((n) => n.level === "caption"),
  ];
  return view;
}

// ── Bill + survey + preview + tier step-down (3.6 prompt 3) ──────────────────
//
// The remaining Demand routes, all pure and total. Notice-vs-caption for every
// producer is decided HERE (D25); the component renders what these decide.

/** Below this, a parsed bill field is flagged as low-confidence — a finding. */
export const BILL_CONFIDENCE_THRESHOLD = 0.6;
/** Under this many days, annualising a bill's totals is thin — a finding. */
export const BILL_THIN_PERIOD_DAYS = 60;

const BILL_FIELD_NAMES: Record<string, string> = {
  total_kwh: "the total usage",
  billing_period_days: "the billing period",
  daily_avg_kwh: "the daily average",
  tariff_rate: "the tariff rate",
  daily_supply_charge: "the daily supply charge",
  feed_in_tariff: "the feed-in tariff",
  retailer: "the retailer",
  plan_name: "the plan name",
  nmi: "the NMI",
  has_solar: "whether the home already has solar",
  tariff_structured: "the tariff structure",
};

const TARIFF_TYPE_LABELS: Record<string, string> = {
  single_rate: "single rate",
  tou: "time of use",
  demand: "demand tariff",
};

export interface BillParseView {
  ok: boolean;
  /** The backend's own error string on the ok:false branch, verbatim. */
  error: string | null;
  /** "8,240 kWh over 91 days · Origin Energy · time of use" — derived parts only. */
  readoutParts: string[];
  totalKwh: number | null;
  periodDays: number | null;
  dailyAvgKwh: number | null;
  tariffType: string | null;
  billAddress: string | null;
  /** Findings about THIS bill: low-confidence fields, a thin period. */
  notices: RoofNoticeView[];
  persisted: boolean | null;
  warning: string | null;
  /** The correction form's initial values — strings, for controlled inputs. */
  correction: { totalKwh: string; periodDays: string; dailyAvgKwh: string };
}

/**
 * Map a POST /api/job/{id}/bill response — any shape at all — into the readout,
 * the per-field low-confidence findings and the correction form's initial
 * values. `parse_confidence` ABSENT raises NO confidence notices: absent is
 * unknown, and an unknown must not render as a failure (the 3.4-A rule).
 */
export function billParseView(response: unknown): BillParseView {
  const view: BillParseView = {
    ok: false,
    error: null,
    readoutParts: [],
    totalKwh: null,
    periodDays: null,
    dailyAvgKwh: null,
    tariffType: null,
    billAddress: null,
    notices: [],
    persisted: null,
    warning: null,
    correction: { totalKwh: "", periodDays: "", dailyAvgKwh: "" },
  };
  if (typeof response !== "object" || response === null) return view;
  const r = response as Record<string, unknown>;
  if (r.ok !== true) {
    view.error =
      typeof r.error === "string" && r.error ? r.error : "Could not read this bill.";
    return view;
  }
  view.ok = true;
  view.persisted = typeof r.persisted === "boolean" ? r.persisted : null;
  view.warning = typeof r.warning === "string" && r.warning ? r.warning : null;

  const parsed =
    typeof r.parsed === "object" && r.parsed !== null
      ? (r.parsed as Record<string, unknown>)
      : {};
  view.totalKwh = roofNum(parsed.total_kwh);
  view.periodDays = roofNum(parsed.billing_period_days);
  view.dailyAvgKwh = roofNum(parsed.daily_avg_kwh);
  view.billAddress = roofStr(parsed.property_address);
  const structured =
    typeof parsed.tariff_structured === "object" && parsed.tariff_structured !== null
      ? (parsed.tariff_structured as Record<string, unknown>)
      : {};
  view.tariffType = roofStr(structured.tariff_type);

  if (view.totalKwh !== null && view.periodDays !== null) {
    view.readoutParts.push(
      `${Math.round(view.totalKwh).toLocaleString("en-AU")} kWh over ${view.periodDays} days`,
    );
  } else if (view.totalKwh !== null) {
    view.readoutParts.push(`${Math.round(view.totalKwh).toLocaleString("en-AU")} kWh`);
  }
  const retailer = roofStr(parsed.retailer);
  if (retailer) view.readoutParts.push(retailer);
  const tariffLabel = view.tariffType ? TARIFF_TYPE_LABELS[view.tariffType] : undefined;
  if (tariffLabel) view.readoutParts.push(tariffLabel);

  // Low-confidence findings — one per field the parser itself doubted.
  const confidence =
    typeof parsed.parse_confidence === "object" && parsed.parse_confidence !== null
      ? (parsed.parse_confidence as Record<string, unknown>)
      : null;
  if (confidence) {
    for (const [field, value] of Object.entries(confidence)) {
      if (typeof value === "number" && Number.isFinite(value) && value < BILL_CONFIDENCE_THRESHOLD) {
        view.notices.push({
          tone: "caution",
          level: "notice",
          title: "This bill was unclear",
          body: `The parser was not confident about ${BILL_FIELD_NAMES[field] ?? field} — check it against the bill before using these figures.`,
        });
      }
    }
  }
  if (view.periodDays !== null && view.periodDays < BILL_THIN_PERIOD_DAYS) {
    view.notices.push({
      tone: "caution",
      level: "notice",
      title: "A short billing period",
      body: `This bill covers ${view.periodDays} days — scaling that to a full year is thin. A longer bill or the smart-meter data would be firmer.`,
    });
  }

  view.correction = {
    totalKwh: view.totalKwh !== null ? String(view.totalKwh) : "",
    periodDays: view.periodDays !== null ? String(view.periodDays) : "",
    dailyAvgKwh: view.dailyAvgKwh !== null ? String(view.dailyAvgKwh) : "",
  };
  return view;
}

export type BillAddressCheck = "match" | "different_property" | "cannot_tell";

interface ParsedAddress {
  unit: string | null;
  streetNumber: string;
  postcode: string;
}

function parseAuAddress(value: unknown): ParsedAddress | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase().replace(/,?\s*australia\s*$/i, "").trim();
  if (!text) return null;
  // Postcode: the LAST standalone 4-digit group.
  const postcodes = [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)];
  if (postcodes.length === 0) return null;
  const postcodeMatch = postcodes[postcodes.length - 1];
  const postcode = postcodeMatch[1];
  const beforePostcode = text.slice(0, postcodeMatch.index);
  // Unit form: "unit 5/53", "u5/53" or "5/53" — the street number is AFTER the slash.
  const unitForm = beforePostcode.match(/(?:unit\s*|u\s*)?(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)/);
  if (unitForm) {
    return { unit: unitForm[1], streetNumber: unitForm[2], postcode };
  }
  const plain = beforePostcode.match(/(?<![\d/])(\d+[a-z]?)\b/);
  if (!plain) return null;
  return { unit: null, streetNumber: plain[1], postcode };
}

/**
 * THE SUPPLY-ADDRESS CROSS-CHECK — deliberately conservative, the same rule
 * 3.4-A applied to site_cross_check: an unchecked thing must never render as a
 * passed thing, and a check that fired on every bill would by D25's own rule
 * stop being a finding at all. "different_property" requires POSITIVE evidence:
 * a different street NUMBER or a different POSTCODE, both present and
 * parseable on BOTH sides. Formatting, abbreviations, case, "St" vs "Street",
 * a missing ", Australia" — and a unit number present on only one side — are
 * all "cannot_tell" and produce NOTHING.
 */
export function billAddressCheck(
  billAddress: unknown,
  jobAddress: unknown,
): BillAddressCheck {
  const bill = parseAuAddress(billAddress);
  const job = parseAuAddress(jobAddress);
  if (!bill || !job) return "cannot_tell";
  if (bill.postcode !== job.postcode) return "different_property";
  if (bill.streetNumber !== job.streetNumber) return "different_property";
  // Same street number and postcode. A unit on exactly one side — or two
  // different units — is NOT positive evidence of a different property; unit
  // formatting on bills is far too loose to convict on.
  if ((bill.unit === null) !== (job.unit === null)) return "cannot_tell";
  if (bill.unit !== null && job.unit !== null && bill.unit !== job.unit) {
    return "cannot_tell";
  }
  return "match";
}

/** The mismatch FINDING — produced ONLY on "different_property", never else. */
export function billAddressNotice(check: BillAddressCheck): RoofNoticeView | null {
  if (check !== "different_property") return null;
  return {
    tone: "caution",
    level: "notice",
    title: "This bill may be for a different property",
    body: "The supply address on the bill doesn't match this job's address — the street number or postcode differs. Check it is the right customer's bill before using the figures.",
  };
}

// ── Survey (route 3) ─────────────────────────────────────────────────────────

/**
 * The option VALUES routes/load.py actually accepts — read from that file,
 * never invented. A wrong string here silently falls back to a default
 * archetype server-side and the survey does nothing, visible nowhere.
 */
export const SURVEY_OPTIONS = {
  householdSize: ["1", "2", "3-4", "5+"],
  occupancy: ["always_home", "away_weekdays", "shift_work"],
  hotWater: ["electric_storage", "heat_pump", "gas", "solar_hws"],
  appliances: ["ev", "pool_pump", "ducted_ac"],
  tariffType: ["single_rate", "tou", "demand", "not_sure"],
} as const;

export interface SurveyAnswers {
  householdSize: string | null;
  occupancy: string | null;
  hotWater: string | null;
  /**
   * D26/load.py: `appliances is not None` is the fifth completeness test. An
   * EMPTY array is a real answer ("none of these") and completes the survey;
   * NULL is an untouched control and does not. Getting this backwards silently
   * costs every installer with no EV or pool a whole tier.
   */
  appliances: string[] | null;
  tariffType: string | null;
}

export const EMPTY_SURVEY_ANSWERS: SurveyAnswers = {
  householdSize: null,
  occupancy: null,
  hotWater: null,
  appliances: null,
  tariffType: null,
};

/**
 * Pre-fill from the job's stored surveys row (UNIQUE(job_id)). ducted_ac has no
 * stored column, so it cannot be recovered — an unanswered box, not a "no".
 * tariff_type is not stored on surveys at all.
 */
export function surveyView(job: unknown): SurveyAnswers {
  const row = newestByCreatedAt(arr(asObject(job).surveys));
  if (!row) return { ...EMPTY_SURVEY_ANSWERS };
  // has_ev / has_pool are booleans only when the appliances question was
  // actually answered; both null means it never was — so appliances stays
  // null (unanswered), never a fabricated empty answer.
  const answered =
    typeof row.has_ev === "boolean" || typeof row.has_pool === "boolean";
  const appliances: string[] = [];
  if (row.has_ev === true) appliances.push("ev");
  if (row.has_pool === true) appliances.push("pool_pump");
  return {
    householdSize: roofStr(row.household_size),
    occupancy: roofStr(row.occupancy_pattern),
    hotWater: roofStr(row.hot_water_type),
    appliances: answered ? appliances : null,
    tariffType: null,
  };
}

/**
 * ALL FIVE answered, mirroring load.py's `survey_complete` exactly:
 * household_size, hot_water, occupancy, tariff_type, and `appliances is not
 * None` — so an empty appliance list ("none of these") completes it and an
 * untouched (null) control does not.
 */
export function surveyComplete(answers: SurveyAnswers): boolean {
  return (
    answers.householdSize !== null &&
    answers.occupancy !== null &&
    answers.hotWater !== null &&
    answers.tariffType !== null &&
    answers.appliances !== null
  );
}

/**
 * The /api/job/{id}/demand body for a survey submission. The consumption
 * figures come from the bill (or interval data) — the five questions carry no
 * kWh, and routes/load.py 422s without one; the caller passes what it has.
 */
export function surveyPayload(
  answers: SurveyAnswers,
  figures: { annualKwh?: number | null; dailyAvgKwh?: number | null } = {},
): Record<string, unknown> {
  return {
    household_size: answers.householdSize,
    occupancy: answers.occupancy,
    hot_water: answers.hotWater,
    appliances: answers.appliances,
    tariff_type: answers.tariffType,
    annual_kwh: figures.annualKwh ?? null,
    daily_avg_kwh: figures.dailyAvgKwh ?? null,
  };
}

// ── Load preview strip ───────────────────────────────────────────────────────

/**
 * A profile whose weights vary by no more than this (max minus min, on the
 * mean-1.0 normalised weights) is FLAT. Named and exported so the threshold is
 * visible and testable, not buried in a comparison. Tier 1's profile is
 * literally [1.0] x 24; real archetypes swing by ~1.9.
 */
export const FLAT_PROFILE_TOLERANCE = 0.15;

export interface LoadPreviewView {
  ok: boolean;
  /** 24 heights normalised 0..1 for drawing. Empty when not drawable. */
  bars: number[];
  flat: boolean;
  /** Inclusive hour window, or NULL — always null on a flat profile. */
  peak: { startHour: number; endHour: number; label: string } | null;
  /** States the shape in words — the strip's aria-label. */
  ariaLabel: string;
  /**
   * 3.6b: the average day in real kWh, or null when the units assumption does
   * not hold. NEVER a fabricated axis — a plausible axis computed from a
   * broken assumption is worse than no axis.
   */
  kwhPerHour: number[] | null;
  maxKwh: number | null;
  /** false = draw the unitless shape, with NO axis and NO kWh figures. */
  unitsOk: boolean;
  /** The flat-profile line, TIER-AWARE (D27.3). Null when not flat. */
  flatMessage: RoofNoticeView | null;
}

/**
 * How far `sum(weights)` may sit from 24 and still be trusted for the kWh
 * reconstruction. Named and exported so the assumption is VISIBLE and testable
 * rather than buried in a comparison.
 *
 * THE ASSUMPTION, verified in both producers before this was built:
 * interval_parser._normalise_weights uses `f = 24.0 / total`, and
 * routes/load.py._normalise uses `factor = 24.0 / total`. So the weights sum to
 * 24 for all three tiers and
 *     kwh[h] = weights[h] * daily_avg_kwh / 24
 * is exact. The parser ROUNDS each weight to 6dp, so a real file lands on
 * 24.000001 — which is why this tolerance exists at all.
 */
export const WEIGHT_SUM_TOLERANCE = 0.01;

function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/**
 * The flat-profile message, TIER-AWARE (D27.3). At Tier 1 the profile IS a flat
 * national archetype, so the existing wording is right and it is a method fact
 * — a quiet caption. At Tier 3 a near-flat MEASURED profile is a FINDING: it
 * usually means the wrong channel or a synthetic file, and calling measured
 * data a "national-average estimate" would be false. A flat Tier 2 is
 * impossible by construction (a blended archetype is never flat), so if it
 * happens something is wrong and it is treated as the Tier-3 case.
 */
function flatMessageFor(tier: 1 | 2 | 3 | null): RoofNoticeView {
  if (tier === 1) {
    return {
      tone: "info",
      level: "caption",
      title: "",
      body: "No daily shape — this is a national-average estimate.",
    };
  }
  if (tier === 2 || tier === 3) {
    return {
      tone: "caution",
      level: "notice",
      title: "This meter data shows almost no daily variation",
      body: "A home's usage normally rises and falls across the day. A flat measured profile usually means the wrong channel was read, or the file is synthetic. Check the file before relying on it.",
    };
  }
  // Tier unknown: say what is true and claim nothing about where it came from.
  return {
    tone: "info",
    level: "caption",
    title: "",
    body: "No daily shape in this profile.",
  };
}

export function isFlatProfile(weights: readonly number[]): boolean {
  if (weights.length === 0) return true;
  let min = weights[0];
  let max = weights[0];
  for (const w of weights) {
    if (w < min) min = w;
    if (w > max) max = w;
  }
  return max - min <= FLAT_PROFILE_TOLERANCE;
}

/**
 * The 24-bar preview. Accepts the weights array itself or an object carrying
 * `hourly_profile_weights`, plus the profile's `daily_avg_kwh` and its tier.
 * A profile with the wrong length or a non-numeric entry renders NOTHING
 * (ok:false) — a malformed chart must degrade to absent, never to a misleading
 * picture.
 *
 * THE FLAT-PROFILE CASE: Tier 1's weights are [1.0] x 24, and a peak finder run
 * over that would print a confident, invented "peak" for a national-average
 * estimate. Flat -> peak is NULL and the words say there is no daily shape.
 * Flatness and unit-validity are INDEPENDENT: a flat Tier-1 profile with a real
 * daily average still gets a real kWh axis (every hour equal).
 */
export function loadPreviewView(
  profile: unknown,
  dailyAvgKwh?: unknown,
  tier?: unknown,
): LoadPreviewView {
  const none: LoadPreviewView = {
    ok: false, bars: [], flat: false, peak: null, ariaLabel: "",
    kwhPerHour: null, maxKwh: null, unitsOk: false, flatMessage: null,
  };
  const raw = Array.isArray(profile)
    ? profile
    : typeof profile === "object" && profile !== null
      ? (profile as Record<string, unknown>).hourly_profile_weights
      : null;
  if (!Array.isArray(raw) || raw.length !== 24) return none;
  const weights: number[] = [];
  for (const w of raw) {
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) return none;
    weights.push(w);
  }
  const max = Math.max(...weights);
  const bars = weights.map((w) => (max > 0 ? w / max : 0));
  const knownTier = tier === 1 || tier === 2 || tier === 3 ? tier : null;

  // THE UNITS ASSERTION — never assumed. Both the sum and the daily average
  // must hold up, or the chart falls back to the unitless shape with no axis.
  const daily =
    typeof dailyAvgKwh === "number" && Number.isFinite(dailyAvgKwh) && dailyAvgKwh > 0
      ? dailyAvgKwh
      : null;
  const sum = weights.reduce((a, b) => a + b, 0);
  const sumOk = Math.abs(sum - 24) <= WEIGHT_SUM_TOLERANCE;
  const unitsOk = daily !== null && sumOk;
  const kwhPerHour = unitsOk
    ? weights.map((w) => (w * (daily as number)) / 24)
    : null;
  const maxKwh = kwhPerHour !== null ? Math.max(...kwhPerHour) : null;

  const flat = isFlatProfile(weights);
  if (flat) {
    return {
      ok: true,
      bars,
      flat: true,
      peak: null,
      ariaLabel:
        "Average day across the year: no daily shape — usage is level through the day.",
      kwhPerHour,
      maxKwh,
      unitsOk,
      flatMessage: flatMessageFor(knownTier),
    };
  }
  // Peak: the contiguous run of hours around the maximum holding at least 80%
  // of it.
  const peakHour = weights.indexOf(max);
  const threshold = max * 0.8;
  let start = peakHour;
  while (start > 0 && weights[start - 1] >= threshold) start--;
  let end = peakHour;
  while (end < 23 && weights[end + 1] >= threshold) end++;
  const label = `${hourLabel(start)} to ${hourLabel(end + 1)}`;
  return {
    ok: true,
    bars,
    flat: false,
    peak: { startHour: start, endHour: end, label },
    ariaLabel: `Average day across the year: highest use ${label}.`,
    kwhPerHour,
    maxKwh,
    unitsOk,
    flatMessage: null,
  };
}

/** The peak window as a headline figure — "Evening peak" / "Peak use". */
export function peakHeadline(peak: LoadPreviewView["peak"]): string | null {
  if (!peak) return null;
  return peak.startHour >= 17 ? "Evening peak" : "Peak use";
}

/** en-AU formatting for the two headline figures. A missing figure is OMITTED. */
export function formatAnnualKwh(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value).toLocaleString("en-AU")} kWh`;
}

export function formatDailyKwh(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `${value.toLocaleString("en-AU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} kWh`;
}

// ── The tier model (D26 — the engine is the fact) ────────────────────────────
//
// ROUTE_TIERS is GONE, deliberately: it mapped a ROUTE to a tier, and that
// model does not exist. A bill and a survey are not two rungs on a ladder —
// they are two halves of the same rung. The bill (or a typed figure) supplies
// the yearly total and says nothing about when power is used; the five
// questions supply the shape and contain no kilowatt-hours.
//
// THE ONE PLACE the tier numbers and confidences live in this file. They are
// routes/load.py's values, mirrored — never invented here.
export const TIER_TABLE = {
  3: { confidence: 92, means: "A real total and a real shape, measured" },
  2: { confidence: 82, means: "A real total, and a shape from a matched archetype" },
  1: { confidence: 65, means: "A real total, and no daily shape" },
} as const;

export interface DemandInputs {
  hasIntervalProfile: boolean;
  /** From a parsed bill OR typed by the installer — a REAL number either way. */
  usageKwh: number | null;
  usageSource: "interval" | "bill" | "typed" | null;
  /** ALL FIVE, mirroring load.py's survey_complete. */
  surveyComplete: boolean;
}

/**
 * A MIRROR of routes/load.py's branching, in ITS order — do not reorder:
 *   1. `_valid_interval_profile(body.interval_profile)` → tier 3, 92%
 *   2. `annual_kwh is None and daily_avg_kwh is None` → HTTPException 422:
 *      a usage quantity is MANDATORY; NOTHING exists without one → null
 *   3. `survey_complete` (all five, `appliances is not None`) → tier 2, 82%
 *   4. otherwise → tier 1, 65%, and the profile is FLAT
 *
 * null = no profile is possible; the engine would answer 422. Never render a
 * tier for that state — a tier shown for a job with no profile is the exact
 * lie D26 exists to stop.
 */
export function tierFor(inputs: DemandInputs): 1 | 2 | 3 | null {
  if (inputs.hasIntervalProfile) return 3;
  if (inputs.usageKwh === null) return null;
  if (inputs.surveyComplete) return 2;
  return 1;
}

export interface DemandStatusLine {
  /** What we HAVE — never which control was clicked. */
  have: string;
  tier: 1 | 2 | 3 | null;
  /** What would raise the tier, or null at tier 3. */
  next: string | null;
}

/** The live line under the two halves — derived from the same predicate the
 *  engine uses, so the screen cannot promise a tier the engine will not record. */
export function demandStatusLine(inputs: DemandInputs): DemandStatusLine {
  const tier = tierFor(inputs);
  if (tier === 3) {
    return {
      have: "Smart-meter interval data — a measured total and a measured shape",
      tier,
      next: null,
    };
  }
  if (tier === 2) {
    return {
      have:
        inputs.usageSource === "typed"
          ? "Annual total entered by you, with the five questions answered"
          : "Annual total from the bill, with the five questions answered",
      tier,
      next: "A smart-meter interval file would make this Tier 3 — measured, not matched",
    };
  }
  if (tier === 1) {
    return {
      have:
        inputs.usageSource === "typed"
          ? "Annual total entered by you · no daily shape yet"
          : "Annual total from the bill · no daily shape yet",
      tier,
      next: "Answer the five questions and this becomes Tier 2",
    };
  }
  return {
    have: "We cannot work out a profile without a yearly total",
    tier: null,
    next: "Add a bill or type the annual usage to get started",
  };
}

/**
 * Deliberately WIDE plausibility bounds for a typed annual figure. There is no
 * authoritative consumption dataset in this repo to derive tight bounds from,
 * so these are stated as what they are: a sanity net, not an authority. An
 * Australian home averages roughly 4,000–7,000 kWh/yr; 300 allows a barely
 * used holiday unit, 60,000 a large all-electric home with two EVs and a heated
 * pool. Outside this we still SEND the figure (the installer may know something
 * we do not) — we just say it looks unusual.
 */
export const ANNUAL_KWH_PLAUSIBLE_MIN = 300;
export const ANNUAL_KWH_PLAUSIBLE_MAX = 60000;

/**
 * The inline validation for a TYPED annual figure. Returns the error string,
 * or null when the value is usable. Only a positive finite NUMBER passes —
 * a string, NaN or Infinity never reaches the backend.
 */
export function typedUsageError(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "Enter the yearly usage as a number of kilowatt-hours, greater than zero.";
  }
  return null;
}

/** The implausible-figure FINDING — the call still goes ahead; this only speaks. */
export function usagePlausibilityNotice(kwh: number): RoofNoticeView | null {
  if (
    !Number.isFinite(kwh) ||
    (kwh >= ANNUAL_KWH_PLAUSIBLE_MIN && kwh <= ANNUAL_KWH_PLAUSIBLE_MAX)
  ) {
    return null;
  }
  return {
    tone: "caution",
    level: "notice",
    title: "That figure is outside what an Australian home usually uses",
    body: `${Math.round(kwh).toLocaleString("en-AU")} kWh a year is outside the ${ANNUAL_KWH_PLAUSIBLE_MIN.toLocaleString("en-AU")}–${ANNUAL_KWH_PLAUSIBLE_MAX.toLocaleString("en-AU")} range we sanity-check against. It will still be used — just check it is a yearly figure, not a quarterly one.`,
  };
}

/**
 * WHERE THE PREDICTED AND RECORDED TIERS DISAGREE, the RECORDED one is shown
 * and this notice says they differ — loudly, because that disagreement is the
 * exact bug D26 fixed, and assuming it can no longer happen is how it returns.
 */
export function tierMismatchNotice(
  predicted: number | null,
  recorded: number | null,
): RoofNoticeView | null {
  if (predicted === null || recorded === null || predicted === recorded) {
    return null;
  }
  return {
    tone: "caution",
    level: "notice",
    title: "The recorded tier differs from what this screen expected",
    body: `The engine recorded Tier ${recorded}, but from what is on screen this should be Tier ${predicted}. The recorded tier is the one that counts — report this mismatch.`,
  };
}

// ── Tariff & network (3.8) ───────────────────────────────────────────────────

/**
 * The financial envelope: what power costs, what export earns, and how much the
 * network lets this house send back. A pure view over the STORED tariffs row
 * plus the two nem lookups, built the same way addressRoofView and
 * energyDataView are — total, tolerant of any shape, never throwing.
 *
 * PRECEDENCE, per field and never per row: the STORED value wins; with no
 * stored value the DEFAULT prefills the input; with neither the input is empty.
 * A stored value is NEVER overwritten by a default — that is what stops a saved
 * 7.5 kW export limit reverting to the network's 5.0 kW on the next page load.
 *
 * THE HOUR CONVENTION: window start and end are the SITE'S LOCAL CLOCK TIME as
 * "HH:MM", stored and displayed unchanged. No rotation, no offset, no timezone
 * conversion, and no Date object used for arithmetic on them anywhere in this
 * file. The engine's 24-hour rate vector is indexed by local clock hour;
 * generation is the only rotated series and that is backend (3.7). A window
 * crossing midnight (22:00 → 06:00) is valid and round-trips unchanged.
 *
 * The D25 notice/caption classification lives HERE, never in the component.
 */

/** GET /api/nem/export-limit, as the backend returns it. Every field unknown:
    this crosses a network boundary, so nothing about it is guaranteed. */
export interface ExportLimitDefault {
  state?: unknown;
  dnsp?: unknown;
  export_limit_kw?: unknown;
  is_default?: unknown;
}

/** GET /api/nem/fit, as the backend returns it. `note` is WA/NT only. */
export interface FitDefault {
  state?: unknown;
  fit_aud_per_kwh?: unknown;
  is_fallback?: unknown;
  source?: unknown;
  scheme?: unknown;
  last_updated?: unknown;
  note?: unknown;
}

export interface TariffDefaults {
  exportLimit: ExportLimitDefault | null;
  fit: FitDefault | null;
}

/**
 * One row of the TOU window form. ALL STRINGS, exactly like PlaneFormRow and
 * for the same reason: these populate controlled inputs. `label` and `days` are
 * the RAW stored strings — a value outside the accepted list is preserved so
 * the component can offer it as "(as stored)" rather than silently resetting it.
 */
export interface TariffWindowFormRow {
  label: string;
  rate: string;
  start: string;
  end: string;
  days: string;
}

export const EMPTY_TARIFF_WINDOW_ROW: TariffWindowFormRow = {
  label: "",
  rate: "",
  start: "",
  end: "",
  days: "all",
};

/**
 * C&I rows — "present but hidden behind the flag" (row 3.8; 10.5 un-hides them).
 * There is no `segment` column on `jobs` (42 columns, F84), so there is nothing
 * to store per job and no per-job flag: this is one module-level constant.
 *
 * THE TRAP THIS AVOIDS: a constant that is always false makes the code behind it
 * unreachable and untestable — a feature that only claims to exist (the F39
 * class). So tariffNetworkView takes the flag as an ARGUMENT defaulting to this
 * constant, and verify-worksheet-logic.ts drives it BOTH ways.
 */
export const SHOW_CI_TARIFF_ROWS = false;

export interface TariffCiView {
  /** $/kVA or $/kW of billed demand, from the stored demand_charges jsonb. */
  demandChargeRate: SiteFieldView<number>;
  /** The demand threshold the charge applies above, kW. */
  demandThresholdKw: SiteFieldView<number>;
  /** A separately negotiated export limit, kW — C&I sites are not on the
      standard residential limit. */
  negotiatedExportKw: SiteFieldView<number>;
}

export interface TariffNetworkView {
  /** "stored" means a tariffs row exists for this job. */
  state: "empty" | "stored";
  tariffType: "flat" | "tou" | null;
  importRate: SiteFieldView<number>;
  supplyCharge: SiteFieldView<number>;
  fitRate: SiteFieldView<number>;
  exportLimitKw: SiteFieldView<number>;
  windows: TariffWindowFormRow[];
  /** jobs.site_dnsp — READ ONLY on this screen. */
  dnsp: string | null;
  /** jobs.site_state. Named with the underscore because `state` above is the
      view's own discriminant. */
  state_: string | null;
  postcode: string | null;
  fitSourceLabel: string | null;
  exportSourceLabel: string | null;
  notices: RoofNoticeView[];
  /** Null unless the C&I flag is on — absent from the DOM, not hidden by CSS. */
  ci: TariffCiView | null;
}

/** The four window labels and three day values the backend accepts. */
export const TARIFF_WINDOW_LABELS = ["peak", "shoulder", "offpeak", "flat"] as const;
export const TARIFF_DAYS_VALUES = ["all", "weekday", "weekend"] as const;

/**
 * The client-side bounds. These MIRROR TariffSaveRequest's Field(ge=…, le=…)
 * exactly; they are a courtesy that catches a typo before a round trip, and the
 * backend remains the boundary that actually enforces them.
 */
export const TARIFF_BOUNDS = {
  importRate: { min: 0, max: 5, message: "The import rate must be between 0 and 5 $/kWh." },
  windowRate: { min: 0, max: 5, message: "A window rate must be between 0 and 5 $/kWh." },
  supplyCharge: { min: 0, max: 20, message: "The supply charge must be between 0 and 20 $/day." },
  fitRate: { min: 0, max: 5, message: "The feed-in tariff must be between 0 and 5 $/kWh." },
  exportLimitKw: { min: 0, max: 100, message: "The export limit must be between 0 and 100 kW." },
} as const;

/** The same shape the backend's regex accepts — routes/demand.py's _TIME_HHMM. */
export const TARIFF_TIME_PATTERN = /^([01]?\d|2[0-4]):[0-5]\d$/;

export function isTariffTime(value: unknown): boolean {
  return typeof value === "string" && TARIFF_TIME_PATTERN.test(value.trim());
}

/**
 * The job (or any nested blob) as a plain record. JobDetailLike deliberately
 * names only the keys the other views read, and jobs.site_dnsp / site_state /
 * site_postcode are not among them — widening that shared interface to reach
 * three fields would be a bigger change than this local accessor.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** A number, or a numeric string — PostgREST hands numerics back either way. */
function tariffNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function tariffField(value: number | null): SiteFieldView<number> {
  return { raw: value, text: value !== null ? String(value) : "" };
}

/**
 * Stored windows → form rows. A window missing its rate, start or end cannot
 * populate the form, so it is DROPPED and counted — the caller turns a non-zero
 * count into the could-not-be-fully-read notice. Never throws, never yields the
 * string "undefined".
 */
function tariffWindowRows(raw: unknown): {
  rows: TariffWindowFormRow[];
  dropped: number;
} {
  if (raw === null || raw === undefined) return { rows: [], dropped: 0 };
  // Anything that is not an array is itself unreadable — one dropped "row".
  if (!Array.isArray(raw)) return { rows: [], dropped: 1 };
  const rows: TariffWindowFormRow[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const w = entry as Record<string, unknown>;
    const rate = tariffNum(w.rate);
    const start = roofStr(w.start);
    const end = roofStr(w.end);
    if (rate === null || start === null || end === null) {
      dropped += 1;
      continue;
    }
    rows.push({
      label: roofStr(w.label) ?? "",
      rate: String(rate),
      // Verbatim — no parsing, no normalising, no Date. Local clock time.
      start,
      end,
      days: roofStr(w.days) ?? "all",
    });
  }
  return { rows, dropped };
}

/** Every notice this section can produce, as the titles the gate asserts. */
export const TARIFF_ADDRESS_LOCK_CAPTION: RoofNoticeView = {
  tone: "info",
  level: "caption",
  title: "Saving this locks the job's address",
  body: "Saving this locks the job's address, because the network and the tariff both follow from it.",
};

export const TARIFF_DEFAULTS_CAPTION: RoofNoticeView = {
  tone: "info",
  level: "caption",
  title: "The feed-in tariff and export limit are documented defaults",
  body: "The feed-in tariff and export limit start from conservative documented defaults, not live retail rates. Type over them with this customer's actual numbers when you have them.",
};

export const TARIFF_TOU_PROFILE_CAPTION: RoofNoticeView = {
  tone: "info",
  level: "caption",
  title: "One rate profile, every day of the year",
  body: "The model applies one 24-hour rate profile to every day of the year, so weekday and weekend windows are not modelled separately.",
};

export const TARIFF_WINDOWS_UNREADABLE_NOTICE: RoofNoticeView = {
  tone: "caution",
  level: "notice",
  title: "The stored tariff could not be fully read",
  body: "Some stored time-of-use windows were missing a rate or a time and are not shown. Re-enter them before saving, or the next save will drop them.",
};

/** The bill-comparison threshold, $/kWh. Below this the two numbers are the
    same number rounded differently; above it they are a real disagreement. */
export const TARIFF_BILL_TOLERANCE = 0.01;

export function tariffBillMismatchNotice(
  stored: number | null,
  billRate: number | null,
): RoofNoticeView | null {
  if (stored === null || billRate === null) return null;
  if (Math.abs(stored - billRate) <= TARIFF_BILL_TOLERANCE) return null;
  return {
    tone: "caution",
    level: "notice",
    title: "The saved tariff disagrees with this job's bill",
    body: `The saved import rate is $${stored}/kWh but the bill on this job reads $${billRate}/kWh. The saved rate is the one the engine uses — check which is right.`,
  };
}

function tariffFitLabel(
  fit: FitDefault | null,
  jobState: string | null,
  fromStored: boolean,
): string | null {
  if (fromStored) return "From the saved tariff.";
  if (!fit) return null;
  if (tariffNum(fit.fit_aud_per_kwh) === null) return null;
  const st = roofStr(fit.state) ?? jobState;
  const scheme = roofStr(fit.scheme) ?? roofStr(fit.source);
  const fallback = fit.is_fallback === true;
  const head = st ? `${st} default` : "Default";
  const parts = [scheme, fallback ? "a conservative fallback, not a live retail rate" : null]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(", ");
  const note = roofStr(fit.note);
  return `${head}${parts ? ` — ${parts}` : ""}.${note ? ` ${note}` : ""}`;
}

function tariffExportLabel(
  limit: ExportLimitDefault | null,
  fromStored: boolean,
): string | null {
  if (fromStored) return "From the saved tariff.";
  if (!limit) return null;
  if (tariffNum(limit.export_limit_kw) === null) return null;
  const dnsp = roofStr(limit.dnsp);
  if (limit.is_default === true) {
    return "A conservative default — this network's own published limit was not found.";
  }
  return dnsp
    ? `${dnsp} standard single-phase limit.`
    : "The standard single-phase limit for this network.";
}

/**
 * The C&I fields, read from the stored row's `demand_charges` jsonb — the only
 * place the schema can hold C&I terms today. They are PREFILL ONLY until 10.5:
 * TariffSaveRequest's seven fields do not carry them, so the save path leaves
 * them alone rather than silently dropping them.
 */
function tariffCiView(row: Record<string, unknown> | null): TariffCiView {
  const charges = row ? row.demand_charges : null;
  const first =
    Array.isArray(charges) && typeof charges[0] === "object" && charges[0] !== null
      ? (charges[0] as Record<string, unknown>)
      : {};
  return {
    demandChargeRate: tariffField(tariffNum(first.rate)),
    demandThresholdKw: tariffField(tariffNum(first.threshold_kw)),
    negotiatedExportKw: tariffField(tariffNum(first.negotiated_export_kw)),
  };
}

export function tariffNetworkView(
  job: unknown,
  defaults: TariffDefaults,
  showCiRows: boolean = SHOW_CI_TARIFF_ROWS,
): TariffNetworkView {
  const detail = asRecord(job);
  // 0 or 1 row now that job_id is unique, but read it as an array anyway —
  // every other view does, and a defensive read costs nothing.
  const row = newestByCreatedAt(arr(detail.tariffs));
  const exportDefault = defaults?.exportLimit ?? null;
  const fitDefault = defaults?.fit ?? null;

  const storedImport = tariffNum(row?.import_rate);
  const storedSupply = tariffNum(row?.supply_charge);
  const storedFit = tariffNum(row?.fit_aud_per_kwh);
  const storedExport = tariffNum(row?.export_limit_kw);

  // PER FIELD, never per row: a partial row must not blank what it does carry,
  // and must not blank the fields it does not.
  const fitValue = storedFit ?? tariffNum(fitDefault?.fit_aud_per_kwh);
  const exportValue = storedExport ?? tariffNum(exportDefault?.export_limit_kw);

  // There is deliberately NO import-rate default. DEFAULT_IMPORT_RATE is an
  // engine fallback for a job that never got one; prefilling an installer's
  // form with it would present a guess as an entered value (F78 in a new
  // costume). Empty until someone types the real number.
  const importValue = storedImport;

  const storedType = roofStr(row?.tariff_type);
  const tariffType =
    storedType === "flat" || storedType === "tou" ? storedType : null;

  const { rows: windows, dropped } = tariffWindowRows(row?.tou_windows);

  const notices: RoofNoticeView[] = [];
  if (dropped > 0) notices.push(TARIFF_WINDOWS_UNREADABLE_NOTICE);
  // Unreachable today — `bills` is 0 rows — but the classification is declared
  // so the branch is a fact rather than an intention.
  const bill = newestByCreatedAt(arr(detail.bills));
  const billRate = tariffNum(asRecord(bill?.parsed_json).tariff_rate);
  const mismatch = tariffBillMismatchNotice(storedImport, billRate);
  if (mismatch) notices.push(mismatch);
  // Always true of every job, so it can never NOT fire — a caption, and shown
  // BEFORE the first save as well as after.
  notices.push(TARIFF_ADDRESS_LOCK_CAPTION);
  notices.push(TARIFF_DEFAULTS_CAPTION);
  if (tariffType === "tou") notices.push(TARIFF_TOU_PROFILE_CAPTION);

  return {
    state: row ? "stored" : "empty",
    tariffType,
    importRate: tariffField(importValue),
    supplyCharge: tariffField(storedSupply),
    fitRate: tariffField(fitValue),
    exportLimitKw: tariffField(exportValue),
    windows,
    dnsp: roofStr(detail.site_dnsp),
    state_: roofStr(detail.site_state),
    postcode: roofStr(detail.site_postcode),
    fitSourceLabel: tariffFitLabel(fitDefault, roofStr(detail.site_state), storedFit !== null),
    exportSourceLabel: tariffExportLabel(exportDefault, storedExport !== null),
    notices,
    ci: showCiRows ? tariffCiView(row) : null,
  };
}

/**
 * The save response, classified by MEANING rather than by position in the
 * `warnings` array — the array mixes two different kinds of thing and rendering
 * it as a uniform list is the mistake this function exists to prevent.
 *
 * A `saved: false` response must NEVER read as success: the section's
 * completeness predicate reads the DATABASE, so a false success is the worst
 * outcome available here (the 3.6 lesson, and why the endpoint surfaces the
 * boolean at all).
 */
export function tariffSaveNotices(response: unknown): RoofNoticeView[] {
  const body = asRecord(response);
  const out: RoofNoticeView[] = [];
  if (body.saved === false) {
    out.push({
      tone: "problem",
      level: "notice",
      title: "The tariff could not be saved",
      body: "The engine accepted the numbers but the row did not reach the database, so this section is not complete. Try saving again.",
    });
  }
  for (const warning of asArrayOfStrings(body.warnings)) {
    // The address-lock line is a FACT that fires on every successful save — a
    // caption. Anything else the endpoint chose to warn about is a FINDING
    // about this attempt.
    const isLock = warning.toLowerCase().includes("address is now locked");
    if (isLock) {
      out.push({ ...TARIFF_ADDRESS_LOCK_CAPTION, body: warning });
    } else if (body.saved !== false) {
      out.push({
        tone: "caution",
        level: "notice",
        title: "Saved, with something to check",
        body: warning,
      });
    }
  }
  return out;
}

function asArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}
