import type { ApiErrorKind, PathLetter } from "@/lib/jobs";

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
  const firstIncomplete = done.indexOf(false);
  const anyLaterComplete =
    firstIncomplete !== -1 && done.slice(firstIncomplete + 1).some(Boolean);

  return visible.map((section, i) => {
    let state: WorksheetSectionUnlockState;
    if (done[i]) {
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
 * done  — every VISIBLE section in the phase is complete
 * current — the phase contains the active section
 * pending — otherwise
 *
 * 3.3b: counted over the visible list only, so a phase is never stuck pending
 * waiting on a section that is not on screen. On Path E, Optimise holds three
 * sections rather than four and completes when those three are done.
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
    if (sections.every((v) => v.state === "complete")) return "done";
    if (sections.some((v) => v.state === "active")) return "current";
    return "pending";
  });
  return [states[0], states[1], states[2], states[3]];
}

// ── Job bar ──────────────────────────────────────────────────────────────────

export interface JobBarView {
  address: string;
  statusRaw: string;
  jobTypeLabel: string;
  /** Passed straight through — AccuracyMeter renders non-1|2|3 as "not yet assessed" (C10). */
  tier: number | null;
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
    case "found":
      return {
        tone: "success",
        title: "Roof found",
        body: "Google's aerial imagery found this roof automatically.",
      };
    case "not_found":
      return {
        tone: "info",
        title: "No aerial photo out here",
        body: "The aerial imagery doesn't cover this area — that's normal for about one address in five. Entering the roof from plans is the accurate way to do it anyway.",
      };
    case "low_confidence":
      // Generic since 3.4-C: the new-build wording moved into its own cause, and
      // the specific reasons render as confidenceNotices below this one.
      return {
        tone: "caution",
        title: "Check this roof before you use it",
        body: "The lookup returned a result, but something about it does not look right. The details are below.",
      };
    case "manual":
      if (source === "manual_plans") {
        return {
          tone: "success",
          title: "Entered from plans",
          body: "Plans are the most accurate roof source we can get.",
        };
      }
      if (source === "manual_site_measure") {
        return {
          tone: "success",
          title: "Entered from a site measure",
          body: "Measured on site by the installer.",
        };
      }
      return {
        tone: "success",
        title: "Estimated",
        body: "A best estimate — refine it from plans when you can.",
      };
    default:
      return null;
  }
}


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
      title: "One of these faces is too steep to be a roof",
      body: `A roof face at ${degrees} is closer to a wall than a roof, and it is carrying panels in the table below. It is still shown so you can see it — check it against the plans before you rely on this.`,
    });
  }
  if (causes.delete("no_google_panel_layout")) {
    notices.push({
      tone: "caution",
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
      title: "This may be a newer build than the photo",
      body: "The aerial photo looks like it predates this house, so the roof found may not be the real one. Confirm against the plans.",
    });
  }
  // Anything left is a cause this build does not know about — say so, never hide it.
  for (const unknown of causes) {
    notices.push({
      tone: "caution",
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

  view.confidenceNotices = confidenceNotices(row);
  view.notice = roofStateNotice(view.state, source);
  if (view.imageryStale && view.state !== "manual") {
    const years = view.imageryAgeYears;
    view.staleNotice = {
      tone: "caution",
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
