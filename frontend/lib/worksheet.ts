import type { ApiErrorKind } from "@/lib/jobs";

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
    complete: (job) => arr(job.roof_geometry).length > 0,
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
 */
export function sectionStates(job: unknown): WorksheetSectionView[] {
  const detail = asObject(job);
  const done = SECTIONS.map((section) => {
    try {
      return section.complete(detail) === true;
    } catch {
      return false;
    }
  });
  const firstIncomplete = done.indexOf(false);
  const anyLaterComplete =
    firstIncomplete !== -1 && done.slice(firstIncomplete + 1).some(Boolean);

  return SECTIONS.map((section, i) => {
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
 * done  — every section in the phase is complete
 * current — the phase contains the active section
 * pending — otherwise
 */
export function phaseStates(
  job: unknown,
): [PhaseNodeState, PhaseNodeState, PhaseNodeState, PhaseNodeState] {
  const views = sectionStates(job);
  const states = PHASE_ORDER.map((phase) => {
    const sections = views.filter((v) => v.phase === phase);
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
      return {
        heading: "Couldn't load this job",
        body: `${endpoint} responded with HTTP ${status}. The backend hit an error — try reloading, and check the backend logs if it persists.`,
      };
  }
}
