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
  // 3.9 — optimisation inputs, columns on jobs (nullable, no defaults).
  objective?: string | null;
  custom_weight?: number | null;
  budget_aud?: number | null;
  show_roi?: boolean | null;
  // 3.11 — the existing array's recorded size (a 3.3c job-bar field); read
  // by solarSizingView for the path-C keep-as-is option.
  existing_solar_kw?: number | null;
  // 3.10 — equipment constraints (NULL = Auto) and the confirmation flag.
  equipment_panel_id?: string | null;
  equipment_inverter_id?: string | null;
  equipment_battery_id?: string | null;
  equipment_confirmed?: boolean | null;
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

/**
 * THE CURRENT SIZING RESULT (3.11b prompt 1) — the newest `sizing_results` row
 * by created_at, or null when there are none. One definition for the whole
 * frontend: every reader of a sizing figure calls this, none re-derives it
 * (2R.1 — delete the second copy rather than gate two copies).
 *
 * WHY THIS EXISTS BEFORE IT IS NEEDED. `sizing_results` still carries
 * UNIQUE (job_id) and capture._write upserts on it, so there is exactly one row
 * per job today and `rows[rows.length - 1]` was accidentally correct. Prompt 2
 * drops that constraint; hydration (routes/job.py, `select("*")` with NO ORDER
 * BY) then returns two rows in unspecified physical order and a last-element
 * reader silently returns the OLDER run. The readers must be right BEFORE the
 * constraint goes, never after. Newest-of-one is the one, so today nothing moves.
 *
 * Tie semantics are inherited from `newestByCreatedAt` and deliberately NOT
 * redefined here: a row with an absent or unparseable created_at scores
 * -Infinity, the comparison is strict `>`, so among rows that all tie the FIRST
 * array element wins, and a dateless row can never beat a dated one. It is
 * never discarded — it still wins when it is the only row, which is the shape
 * the legacy /api/job/save row has.
 *
 * Total: never throws for any input — non-array, null, a string, an array of
 * nulls all yield null via the existing arr()/asObject() tolerance.
 */
export function currentSizingResult(job: unknown): Record<string, unknown> | null {
  return newestByCreatedAt(arr(asObject(job).sizing_results));
}

/**
 * THE CURRENT RUN'S FINANCIAL RESULT (3.13 prompt 3) — the newest
 * financial_results row whose sizing_result_id equals the CURRENT sizing
 * result's, or null.
 *
 * ONE DEFINITION, THREE READERS, deliberately: the Results section's
 * completeness predicate, its body (resultsView) and the results bar all ask
 * the same question about the same row — "does THIS run have its figures" —
 * and a section whose tick and whose body read different places is the fault
 * that hit twice in one day on 2026-08-20.
 *
 * NEVER the newest unmatched row: a financial row belonging to an older,
 * superseded run must yield null here — a missing number is honest, a
 * mismatched one is not (the exact pairing defect prompt 2 removed from the
 * jobs list). Total: never throws for any input.
 */
export function currentFinancialResult(job: unknown): Record<string, unknown> | null {
  const sizing = currentSizingResult(job);
  if (!sizing) return null;
  const sid = sizing.sizing_result_id;
  if (typeof sid !== "string" || !sid) return null;
  const matching = arr(asObject(job).financial_results).filter(
    (row) => row.sizing_result_id === sid,
  );
  return newestByCreatedAt(matching);
}

/**
 * THE JOB'S USABLE STORED LOAD PROFILE (2026-08-20) — the newest
 * `load_profiles` row when it carries a yearly figure the engine could size
 * on, else null.
 *
 * ONE DEFINITION, TWO READERS, deliberately: the Energy data section's
 * completeness predicate asks "can the engine get a load from this job", and
 * energyDataView asks "should the stored panel render". They are the same
 * question about the same row, and answering it twice is precisely how the
 * TICK and the BODY came to contradict each other — twice in one day, in
 * opposite directions.
 *
 * A FINITE FIGURE ABOVE ZERO is the rule, because that is what the engine
 * does: backend/routes/sizing.py::_resolve_load reads this row with
 * `order(created_at, desc).limit(1)` and treats `0` as no figure (`annual_kwh
 * or ...`). 0, negatives, NaN, Infinity and null are all "no figure".
 * verify_demand_contract.py's T13 pairs this against that resolver.
 *
 * Total: never throws for any input.
 */
export function storedLoadProfile(job: unknown): Record<string, unknown> | null {
  const profile = newestByCreatedAt(arr(asObject(job).load_profiles));
  if (!profile) return null;
  const annual = tariffNum(profile.annual_kwh);
  return annual !== null && annual > 0 ? profile : null;
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
    // COMPLETE MEANS "THE ENGINE COULD GET A LOAD FROM THIS JOB", and it
    // MIRRORS backend/routes/sizing.py::_resolve_load — the one resolver both
    // sizing endpoints use. verify_demand_contract.py's T13 runs this
    // predicate and that resolver over the same job shapes and asserts the two
    // ANSWERS ARE EQUAL, so they cannot drift apart again.
    //
    // WHAT THIS REPLACED, and why (found on screen 2026-08-20): the rule was
    // `interval_data | bills | surveys` being non-empty. A typed annual usage
    // figure writes a load_profiles row and — the five survey questions being
    // optional — NO surveys row, so the section stayed incomplete forever
    // while its own body rendered "Usage profile recorded — Tier 1 / 8,240
    // kWh". Every gating section after it stayed locked and the job could
    // never be worked. The body read load_profiles; the tick did not.
    //
    // BILLS AND SURVEYS ARE GONE ON PURPOSE: _resolve_load cannot read either
    // table, so a bill or survey that produced no profile has given the engine
    // nothing, and ticking there would promise a load that sizing would fail
    // to find. (Both tables were empty live when this changed, so no existing
    // tick was removed — derived, not assumed.)
    //
    // NEWEST-ROW, NOT `.some(...)`, ON BOTH TABLES: _resolve_load reads each
    // with `order(created_at, desc).limit(1)`, so an older row carrying a
    // series ref that the newest row lacks is NOT something the engine would
    // use. Same append-only rule as currentSizingResult.
    // THE PROFILE HALF OF THIS RULE IS NOW storedLoadProfile(), because
    // energyDataView needs the SAME answer to decide whether to render the
    // stored panel (2026-08-20, second fault). The DECISION is unchanged — the
    // extraction moved no logic and loosened nothing; it exists so there is one
    // definition rather than two kept in step, which is how these halves keep
    // drifting apart.
    complete: (job) => {
      if (storedLoadProfile(job) !== null) return true;
      // The interval branch stays because it is NOT redundant: a job can hold
      // an interval row with no load_profiles row when the profile write
      // failed (see energyDataView), and the engine still resolves a load from
      // the parsed series in that state.
      const interval = newestByCreatedAt(arr(job.interval_data));
      const ref = interval ? interval.parsed_series_ref : null;
      return typeof ref === "string" && ref !== "";
    },
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
    // 3.9 — complete when a KNOWN objective is stored. A budget is NOT
    // required: "no cap" is a real answer, and demanding a number would make
    // installers invent one. A stored string the engine does not recognise
    // does NOT complete it, deliberately — the engine would silently size for
    // max_npv instead, so the section's work is not done.
    complete: (job) =>
      typeof job.objective === "string" &&
      (VALID_OBJECTIVES as readonly string[]).includes(job.objective),
  },
  {
    id: "equipment-specs",
    title: "Equipment & specs",
    phase: "optimise",
    builtAt: "3.10",
    // 3.10 — complete when the installer has CONFIRMED, not when something is
    // pinned. Leaving every component on Auto is a legitimate and probably
    // common answer, so requiring a pin would make the commonest case
    // permanently incompletable. This is D24's shape: the machine proposes,
    // a human confirms. Strictly `=== true` — a truthy check would tick the
    // section on the string "true" arriving from anywhere.
    complete: (job) => job.equipment_confirmed === true,
    // D24: sizing is never blocked, and one unpressed button must not stop a
    // quote. Non-gating means this section is never "active" and never locks
    // anything after it — it reports only its own completeness.
    gates: false,
  },
  {
    id: "solar-sizing",
    title: "Solar sizing",
    phase: "optimise",
    builtAt: "3.11",
    // The CURRENT result carries a solar figure — not "some row ever did".
    // Under append-only, `.some(...)` can never un-tick, which is exactly how a
    // stale tick outlives the run that earned it.
    complete: (job) => {
      const row = currentSizingResult(job);
      return row !== null && row.solar_kw != null;
    },
  },
  {
    id: "battery-sizing",
    title: "Battery sizing",
    phase: "optimise",
    builtAt: "3.12",
    // THE HONEST UN-TICK, and it is deliberate (row 3.11b, answer 1, decided by
    // Mayur 2026-08-19). When a newer solar-only run supersedes a battery run,
    // the current recommendation genuinely contains no battery, so the section
    // un-ticks. The battery row still EXISTS — destruction is what prompt 2
    // ends. This is NOT "the newest row that happens to have a battery".
    complete: (job) => {
      const row = currentSizingResult(job);
      return row !== null && row.battery_kwh != null;
    },
  },
  {
    id: "results",
    title: "Results",
    phase: "resolve",
    builtAt: "3.13",
    // 3.13 prompt 3: complete means A FINANCIAL RESULT FOR THE CURRENT SIZING
    // RESULT — the rule 3.11b recorded and deliberately parked until
    // something wrote financial rows (prompt 2 does). "Any financial row
    // exists" would tick this section on a row belonging to an older,
    // superseded run. The predicate, the section body (resultsView) and the
    // results bar all read currentFinancialResult — one definition, never a
    // tick and a body reading different places (2026-08-20, twice).
    complete: (job) => currentFinancialResult(job) !== null,
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
      /** 3.13 prompt 4 (E): read from the SAME stored derivation the Results
          section uses (storedSelfSufficiencyPct) — the bar showed a dash
          eight lines above a section showing 84.1%, on one screen. */
      selfSufficiencyPct: number | null;
      /** The stored split (battery runs only): solar-only NPV and what the
          battery adds. null on a solar-only run or a pre-split row. */
      splitSolarNpv: number | null;
      splitBatteryNpv: number | null;
      /** 3.14 prompt 3 (F205): WHERE THE VALUE COMES FROM, decided here so
          the suite can assert it and the tile only renders a label. */
      valueOrigin: ResultsBarValueOrigin;
    };

/**
 * 3.14 prompt 3 (F205) — the fifth tile's three genuinely different answers.
 *
 * "all-solar" and "not-recorded" are NOT the same fact and must never be
 * collapsed into one dash: the first says this recommendation contains no
 * battery at all, the second says a battery run was stored before the split
 * existed and its parts cannot be stated. A battery that WAS evaluated and
 * added $0 is a third thing again — a real answer — and stays a "split" whose
 * battery half is zero, never "all-solar".
 */
export type ResultsBarValueOrigin =
  | { kind: "all-solar"; label: string }
  | { kind: "split"; label: string; solarNpv: number; batteryNpv: number }
  | { kind: "not-recorded"; label: string };

/** The words for a run with no battery in it at all. */
export const VALUE_ORIGIN_ALL_SOLAR_LABEL =
  "All solar — no battery in this run";
/** The words for a battery run stored before the split was recorded. */
export const VALUE_ORIGIN_NOT_RECORDED_LABEL =
  "This run did not record the split";

/**
 * THE DISCRIMINATION, from the stored row alone.
 *
 * The order is deliberate: a recorded split is the strongest evidence and
 * wins outright. Otherwise `battery_kwh == null` IS "no battery was in this
 * run" — the solar writer stores null rather than 0 for exactly this reason
 * (F134's shape) — while a battery run (0 or a number) with no readable split
 * is a run whose parts were never written down. Total: never throws.
 */
function resultsBarValueOrigin(
  sizing: Record<string, unknown>,
  split: Record<string, unknown>,
): ResultsBarValueOrigin {
  const solarNpv = tariffNum(asRecord(split.solar_only).npv_25yr);
  const batteryNpv = tariffNum(asRecord(split.battery_increment).incremental_npv);
  if (solarNpv !== null && batteryNpv !== null) {
    // The tile's CONTENT is unchanged from 3.13 — only its label moved.
    return {
      kind: "split",
      label: `${formatMoney(solarNpv)} + ${formatMoney(batteryNpv)}`,
      solarNpv,
      batteryNpv,
    };
  }
  if (sizing.battery_kwh == null) {
    return { kind: "all-solar", label: VALUE_ORIGIN_ALL_SOLAR_LABEL };
  }
  return { kind: "not-recorded", label: VALUE_ORIGIN_NOT_RECORDED_LABEL };
}

/**
 * Discriminated on `sized` — the component branches on this, never on the
 * truthiness of a number. `sized: false` covers both an empty sizing_results
 * AND rows whose figures are all null (the fallback list's "present but with
 * null figures" case): either way there is nothing real to show.
 */
export function resultsBarView(job: unknown): ResultsBarView {
  // The CURRENT result, never the last array element (3.11b prompt 1). The
  // discriminant itself is unchanged — it is simply evaluated against the
  // current row: no row at all, or a row whose figures are both null, is
  // `sized: false` and renders the unsized state, never "0 kW".
  const latest = currentSizingResult(job);
  if (latest === null) return { sized: false };
  if (latest.solar_kw == null && latest.battery_kwh == null) {
    return { sized: false };
  }

  // 3.13 prompt 3: THE MATCHING financial row, via the same helper the
  // Results section's tick and body use — never the newest unmatched one, so
  // the bar and the section can never disagree.
  const latestFin = currentFinancialResult(job);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const eo = asRecord(latest.evaluated_options);
  const split = asRecord(eo.split);
  return {
    sized: true,
    solarKw: num(latest.solar_kw),
    batteryKwh: num(latest.battery_kwh),
    paybackYears: num(latestFin?.payback_years),
    npv: num(latestFin?.npv_25_year),
    selfSufficiencyPct: storedSelfSufficiencyPct(latest, eo),
    splitSolarNpv: tariffNum(asRecord(split.solar_only).npv_25yr),
    splitBatteryNpv: tariffNum(asRecord(split.battery_increment).incremental_npv),
    valueOrigin: resultsBarValueOrigin(latest, split),
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

/**
 * 3.14 prompt 3 (D3, amended 2026-08-14) — THE PER-JOB AUTO-EXPAND MARKER.
 *
 * A SEPARATE key, deliberately: RESULTS_BAR_STORAGE_KEY holds one global
 * {collapsed, height} with no job id in it, and its parser carries a
 * deliberate self-heal. Widening that shape to carry a set of job ids would
 * put the self-heal and the marker in one parser, where a surprise in either
 * discards both.
 */
export const RESULTS_BAR_AUTOEXPAND_STORAGE_KEY =
  "enrgengine.worksheet.results-bar.autoexpanded.v1";

/** The most recent job ids kept. A marker set is a convenience, not a record:
    the oldest fall off rather than growing without bound. */
export const RESULTS_BAR_AUTOEXPAND_LIMIT = 200;

/**
 * Parse the marker set DEFENSIVELY — storage is user-writable and may hold
 * anything, including a shape from a future version. Any surprise yields an
 * EMPTY set (which simply means "this job has not auto-expanded yet"), and it
 * never throws. Non-string and empty entries are dropped, duplicates
 * collapsed; the manner parseResultsBarPreference set.
 */
export function parseAutoExpandedJobs(raw: string | null): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const value of parsed) {
    if (typeof value === "string" && value !== "" && !out.includes(value)) {
      out.push(value);
    }
  }
  return out.slice(-RESULTS_BAR_AUTOEXPAND_LIMIT);
}

/** The set with this job marked — moved to the end, never duplicated. */
export function rememberAutoExpandedJob(
  ids: readonly string[],
  jobId: string,
): string[] {
  const kept = ids.filter(
    (id) => typeof id === "string" && id !== "" && id !== jobId,
  );
  return [...kept, jobId].slice(-RESULTS_BAR_AUTOEXPAND_LIMIT);
}

/**
 * D3's third clause, ONCE ONLY: the bar opens itself on a job's first
 * completed run so the installer meets the chart, and never again. The stored
 * collapsed preference is overridden that ONE time; if the installer then
 * collapses the bar, the job is already marked and the preference wins
 * thereafter.
 *
 * An unsized job never auto-expands (there is nothing to reveal), and a
 * missing job id never does either — a marker with no id could never be
 * written, so it would open on every load.
 */
export function shouldAutoExpandResultsBar(
  view: ResultsBarView,
  jobId: string | null | undefined,
  autoExpanded: readonly string[],
): boolean {
  if (view?.sized !== true) return false;
  if (typeof jobId !== "string" || jobId === "") return false;
  return !autoExpanded.includes(jobId);
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
  /**
   * 2026-08-20: the job already holds a usage profile the engine could size on
   * — `storedLoadProfile(job) !== null`, the SAME rule the section's
   * completeness predicate uses.
   *
   * A SEPARATE BOOLEAN, NOT A THIRD `state` VALUE, on purpose: `state`
   * describes the INTERVAL FILE, and a job can hold an interval row with no
   * profile row (see below), so the two facts are orthogonal. Folding them
   * into one enum would make every existing `state` consumer answer a question
   * it was not asked.
   */
  hasStoredProfile: boolean;
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
    hasStoredProfile: false,
    survey: { ...EMPTY_SURVEY_ANSWERS },
  };
  view.survey = surveyView(detail);
  // The ONE rule, shared with the section's completeness predicate — see
  // storedLoadProfile. Never re-derived here.
  view.hasStoredProfile = storedLoadProfile(detail) !== null;
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

// ── Objective & budget (3.9) ─────────────────────────────────────────────────

/**
 * THE ENGINE'S FOUR OBJECTIVES — a plain literal, and THIS EXACT EXPORT NAME IS
 * LOAD-BEARING: backend/scripts/verify_objective_contract.py Test 7 imports it
 * by name over node and asserts set equality with solar_optimiser
 * .VALID_OBJECTIVES in BOTH directions. Do not rename it, compose it at
 * runtime, or import it from anywhere — a member added to either side alone
 * fails the two-sided gate. "backup" is deliberately absent until 4.5 teaches
 * the ENGINE the word (D29: a control that stores a choice and changes no
 * number was rejected outright).
 */
export const VALID_OBJECTIVES = [
  "max_npv",
  "max_self_sufficiency",
  "min_payback",
  "custom",
] as const;

/**
 * The on-screen labels, in display order. Plain English only — "max_npv" never
 * appears in the UI. The value set must EQUAL VALID_OBJECTIVES (asserted by
 * the suite in both directions), so a label added without an engine objective
 * fails a gate rather than a customer.
 */
export const OBJECTIVE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "min_payback", label: "Fastest payback" },
  { value: "max_npv", label: "Best 25-year return" },
  { value: "max_self_sufficiency", label: "Most self-sufficient" },
  { value: "custom", label: "Custom blend" },
];

/**
 * Client-side bounds, mirroring routes/job.py's Field() bounds EXACTLY
 * (custom_weight ge=0 le=1; budget_aud gt=0 le=500000). A courtesy that
 * catches a typo before a round trip — the backend remains the boundary that
 * actually enforces them.
 */
export const OBJECTIVE_BOUNDS = {
  customWeight: {
    min: 0,
    max: 1,
    message: "The blend must be between 0 and 1.",
  },
  budgetAud: {
    min: 0,
    minExclusive: true,
    max: 500000,
    message: "A budget cap must be more than $0. Leave it empty for no cap.",
  },
} as const;

export interface ObjectiveBudgetView {
  /** "stored" when any of the three columns holds a value. */
  state: "empty" | "stored";
  /** The RAW stored objective, even when the engine does not know it — never
      silently reset to a default. */
  objective: string | null;
  /** Is it one of VALID_OBJECTIVES — drives the caution notice and the
      "(as stored)" Select option. */
  objectiveIsKnown: boolean;
  customWeight: SiteFieldView<number>;
  budgetAud: SiteFieldView<number>;
  notices: RoofNoticeView[];
}

/** The one-sentence blend explainer — a CAPTION: a fact about how the tool
    works, true of every custom job (D25). */
export const OBJECTIVE_BLEND_CAPTION: RoofNoticeView = {
  tone: "info",
  level: "caption",
  title: "How the blend works",
  body: "The blend weighs financial return against self-sufficiency: 1 is all financial return, 0 is all self-sufficiency.",
};

/**
 * A pure view over the job's three optimisation columns. Total, tolerant of
 * any input, never throws. The D25 classification lives HERE, never in the
 * component. An empty section raises NO notice — quiet, because "nothing
 * chosen yet" and "no cap" are legitimate answers, not warnings (F149).
 */
export function objectiveBudgetView(job: unknown): ObjectiveBudgetView {
  const detail = asRecord(job);
  const objective = roofStr(detail.objective);
  const objectiveIsKnown =
    objective !== null && (VALID_OBJECTIVES as readonly string[]).includes(objective);

  // PostgREST hands numerics back as a number OR a numeric string — tariffNum
  // takes both. A view that only accepted typeof === "number" would silently
  // show an empty budget on a job that has one.
  const weightRaw = tariffNum(detail.custom_weight);
  const weight = weightRaw !== null && weightRaw >= 0 && weightRaw <= 1 ? weightRaw : null;
  const budgetRaw = tariffNum(detail.budget_aud);
  const budget = budgetRaw !== null && budgetRaw > 0 ? budgetRaw : null;

  const notices: RoofNoticeView[] = [];
  if (objective !== null && !objectiveIsKnown) {
    // A finding about THIS job, and it matters: the engine will size for
    // maximum NPV and say so in its flags, which is not what the screen would
    // otherwise imply.
    notices.push({
      tone: "caution",
      level: "notice",
      title: "This objective is not one the engine knows",
      body: `The stored objective "${objective}" is not one the engine can size for, so it will size for the best 25-year return (its default) instead. Choose one of the listed objectives and save.`,
    });
  }
  if (objective === "custom" && objectiveIsKnown) {
    notices.push(OBJECTIVE_BLEND_CAPTION);
  }

  return {
    state: objective !== null || weight !== null || budget !== null ? "stored" : "empty",
    objective,
    objectiveIsKnown,
    // The slider shows what the engine will actually use — its documented
    // default 0.5 — rather than a misleading 0. Stored-but-unreadable (out of
    // 0..1, garbage) is treated as absent.
    customWeight: { raw: weight, text: weight !== null ? String(weight) : "0.5" },
    budgetAud: { raw: budget, text: budget !== null ? String(budget) : "" },
    notices,
  };
}

/**
 * THE ROUND-TRIP CHECK. PATCH /api/job/{id} returns the UPDATED JOB ROW, not a
 * { saved } envelope — there is no flag to read, and a silent write failure
 * would look identical to a success. So the check is: what was sent must be
 * what came back. COERCED values are compared, never raw ones — budget_aud
 * sent as the number 20000 comes back as the STRING "20000" from PostgREST,
 * and a naive === would raise a false alarm on every single save.
 *
 * Returns ONE "problem" notice naming every field that disagrees, or [].
 */
export function objectiveSaveNotices(sent: unknown, response: unknown): RoofNoticeView[] {
  const payload = asRecord(sent);
  const row = asRecord(response);
  const disagree: string[] = [];

  if (Object.prototype.hasOwnProperty.call(payload, "objective")) {
    const sentObj = typeof payload.objective === "string" ? payload.objective.trim() : null;
    const gotObj = typeof row.objective === "string" ? row.objective.trim() : null;
    if (sentObj !== gotObj) disagree.push("objective");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "custom_weight")) {
    if (tariffNum(payload.custom_weight) !== tariffNum(row.custom_weight)) {
      disagree.push("blend");
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "budget_aud")) {
    if (tariffNum(payload.budget_aud) !== tariffNum(row.budget_aud)) {
      disagree.push("budget cap");
    }
  }
  if (disagree.length === 0) return [];
  return [
    {
      tone: "problem",
      level: "notice",
      title: "The save did not take",
      body: `The job that came back does not carry what was sent (${disagree.join(", ")}). Nothing shown here is confirmed saved — try again.`,
    },
  ];
}

// ── Equipment & specs (3.10) ─────────────────────────────────────────────────

/**
 * The three kinds, one literal. Members must equal the kinds the backend
 * accepts (routes/equipment.py's EQUIPMENT_KINDS, which its own gate asserts
 * against the GET response); this export is what a later cross-language gate
 * can compare against.
 */
export const EQUIPMENT_KINDS = ["panels", "inverters", "batteries"] as const;

export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

/**
 * GET /api/equipment's response. Rows are typed LOOSELY and read through
 * coercers: this crosses a network boundary, so nothing about it is
 * guaranteed — the same rule every other view in this file follows for server
 * data.
 */
export interface EquipmentCatalogue {
  panels?: unknown;
  inverters?: unknown;
  batteries?: unknown;
  flags?: unknown;
}

/** One label/value pair under a dropdown. `value` is already formatted. */
export interface EquipmentSpecRow {
  label: string;
  value: string;
}

export interface EquipmentOption {
  id: string;
  /** "Brand Model", plus " · your own, unverified" for a user_defined unit. */
  label: string;
  isUserDefined: boolean;
}

export interface EquipmentKindView {
  kind: EquipmentKind;
  /** The RAW stored id — kept even when it is not in the list. */
  selectedId: string | null;
  /** Is the stored id among the options the company can see? */
  inList: boolean;
  /** The chosen unit's label, or null on Auto / not found. */
  selectedLabel: string | null;
  selectedIsUserDefined: boolean;
  options: EquipmentOption[];
  /** The engine-driving specs of the STORED choice; [] on Auto. */
  specs: EquipmentSpecRow[];
  /**
   * Specs for EVERY visible unit, by id — so the screen can show the specs of
   * whatever is selected right now, not only of what was last saved. Without
   * it the rows would blank the moment an installer changed a dropdown, which
   * is exactly when they most want to compare.
   */
  specsById: Record<string, EquipmentSpecRow[]>;
  /** True when the catalogue loaded but holds no units of this kind. */
  emptyList: boolean;
}

export interface EquipmentSpecsView {
  panels: EquipmentKindView;
  inverters: EquipmentKindView;
  batteries: EquipmentKindView;
  /** Strictly `job.equipment_confirmed === true`. */
  confirmed: boolean;
  /** False when the catalogue is missing, unparseable, or came back with the
      backend's own equipment_catalogue_unavailable flag. */
  catalogueAvailable: boolean;
  notices: RoofNoticeView[];
}

/** THE ON-SCREEN STATEMENT OF THE SCOPING RULE prompt 1 built into the engine:
    the automatic pickers are filtered to origin='catalogue', so an automatic
    recommendation can never reach another company's custom equipment. A
    caption, not a notice — it is always true of a job with anything on Auto,
    so it explains rather than warns (D25). */
export const EQUIPMENT_AUTO_CAPTION: RoofNoticeView = {
  tone: "info",
  level: "caption",
  title: "What Auto means",
  body: "Auto means EnrgEngine chooses from the shared catalogue. It never chooses another installer's custom equipment.",
};

export const EQUIPMENT_UNVERIFIED_NOTICE: RoofNoticeView = {
  tone: "caution",
  level: "notice",
  title: "A chosen unit's specs are unverified",
  body: "One of the units chosen here was entered by an installer and has not been checked against a datasheet. Every number the engine derives from it inherits that.",
};

export const EQUIPMENT_MISSING_NOTICE: RoofNoticeView = {
  tone: "caution",
  level: "notice",
  title: "A saved unit is not in the catalogue",
  body: "This job has equipment saved that is no longer in the list you can see, so its specs cannot be shown here. It is still what the engine will use until you change it.",
};

export const EQUIPMENT_CATALOGUE_PROBLEM: RoofNoticeView = {
  tone: "problem",
  level: "notice",
  title: "The equipment catalogue could not be loaded",
  body: "The list of panels, inverters and batteries did not load, so the choices below cannot be trusted. This section is read-only until it does — reload the page to try again.",
};

/** A number formatted for a spec row, or null when it cannot be read. */
function specNum(value: unknown, digits = 1): string | null {
  const n = tariffNum(value);
  if (n === null) return null;
  const rounded = Number(n.toFixed(digits));
  return String(rounded);
}

/**
 * THE MISSING-SPEC RULE, and it is deliberate: a null spec renders the words
 * "not stated" and NOTHING ELSE. It does NOT say what the engine will assume
 * in its place.
 *
 * The engine's documented defaults — 90% round-trip, 0.5C charge/discharge,
 * 6000 cycles, full depth of discharge — live in battery_optimiser.battery_specs,
 * which emits its own flag text naming each one it applies, and those flags
 * reach the installer where the engine actually runs. Restating them here
 * would be a second copy that drifts the first time either changes, with
 * nothing to notice: exactly the two-places-must-agree fault this row has
 * already hit twice. verify-worksheet-logic.ts asserts those numbers do not
 * appear in this output.
 */
export const SPEC_NOT_STATED = "not stated";

function specRow(label: string, formatted: string | null): EquipmentSpecRow {
  return { label, value: formatted ?? SPEC_NOT_STATED };
}

function panelSpecs(row: Record<string, unknown>): EquipmentSpecRow[] {
  const length = specNum(row.length_mm, 0);
  const width = specNum(row.width_mm, 0);
  return [
    specRow("Rated power", specNum(row.rated_power_w, 0) ? `${specNum(row.rated_power_w, 0)} W` : null),
    specRow("Module efficiency", specNum(row.module_efficiency_pct) ? `${specNum(row.module_efficiency_pct)}%` : null),
    specRow("Dimensions", length && width ? `${length} × ${width} mm` : null),
    specRow("Indicative cost", specNum(row.cost_aud, 2) ? `$${specNum(row.cost_aud, 2)}` : null),
  ];
}

function inverterSpecs(row: Record<string, unknown>): EquipmentSpecRow[] {
  return [
    specRow("Type", roofStr(row.inverter_type)),
    specRow("Phases", roofStr(row.phases)),
    specRow("Rated AC power", specNum(row.rated_ac_power_kw, 2) ? `${specNum(row.rated_ac_power_kw, 2)} kW` : null),
    specRow("Max efficiency", specNum(row.max_efficiency_pct) ? `${specNum(row.max_efficiency_pct)}%` : null),
    specRow("Indicative cost", specNum(row.cost_aud, 2) ? `$${specNum(row.cost_aud, 2)}` : null),
  ];
}

function batterySpecRows(row: Record<string, unknown>): EquipmentSpecRow[] {
  return [
    specRow("Usable capacity", specNum(row.usable_capacity_kwh, 2) ? `${specNum(row.usable_capacity_kwh, 2)} kWh` : null),
    specRow("Depth of discharge", specNum(row.depth_of_discharge_pct) ? `${specNum(row.depth_of_discharge_pct)}%` : null),
    specRow("Round-trip efficiency", specNum(row.round_trip_efficiency_pct) ? `${specNum(row.round_trip_efficiency_pct)}%` : null),
    specRow("Max continuous charge", specNum(row.max_continuous_charge_kw, 2) ? `${specNum(row.max_continuous_charge_kw, 2)} kW` : null),
    specRow("Max continuous discharge", specNum(row.max_continuous_discharge_kw, 2) ? `${specNum(row.max_continuous_discharge_kw, 2)} kW` : null),
    specRow("Warranty cycles", specNum(row.warranty_cycles, 0)),
    specRow("Warranty years", specNum(row.warranty_years, 0)),
    specRow("Indicative cost", specNum(row.cost_aud, 2) ? `$${specNum(row.cost_aud, 2)}` : null),
  ];
}

const _SPEC_BUILDERS: Record<EquipmentKind, (row: Record<string, unknown>) => EquipmentSpecRow[]> = {
  panels: panelSpecs,
  inverters: inverterSpecs,
  batteries: batterySpecRows,
};

const _JOB_ID_FIELD: Record<EquipmentKind, string> = {
  panels: "equipment_panel_id",
  inverters: "equipment_inverter_id",
  batteries: "equipment_battery_id",
};

function equipmentOption(row: Record<string, unknown>): EquipmentOption | null {
  const id = roofStr(row.id);
  if (id === null) return null;
  const brand = roofStr(row.brand) ?? "";
  const model = roofStr(row.model) ?? "";
  const name = `${brand} ${model}`.trim() || id;
  const isUserDefined = roofStr(row.origin) === "user_defined";
  return {
    id,
    // The unverified marker travels in the LABEL so it survives into a native
    // <option>, which cannot carry markup.
    label: isUserDefined ? `${name} · your own, unverified` : name,
    isUserDefined,
  };
}

function kindView(
  kind: EquipmentKind,
  job: Record<string, unknown>,
  catalogue: Record<string, unknown>,
  available: boolean,
): EquipmentKindView {
  const raw = catalogue[kind];
  // Sorted as the endpoint returned them — deliberately NOT re-sorted here.
  const rows = Array.isArray(raw)
    ? raw.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
  const options = rows
    .map(equipmentOption)
    .filter((o): o is EquipmentOption => o !== null);
  const selectedId = roofStr(job[_JOB_ID_FIELD[kind]]);
  const match = selectedId === null
    ? null
    : rows.find((r) => roofStr(r.id) === selectedId) ?? null;
  const option = selectedId === null
    ? null
    : options.find((o) => o.id === selectedId) ?? null;
  const specsById: Record<string, EquipmentSpecRow[]> = {};
  for (const row of rows) {
    const id = roofStr(row.id);
    if (id !== null) specsById[id] = _SPEC_BUILDERS[kind](row);
  }
  return {
    kind,
    selectedId,
    inList: option !== null,
    selectedLabel: option?.label ?? null,
    selectedIsUserDefined: option?.isUserDefined ?? false,
    options,
    specs: match ? _SPEC_BUILDERS[kind](match) : [],
    specsById,
    emptyList: available && options.length === 0,
  };
}

/**
 * A pure view over the job's four equipment columns and the catalogue. Total,
 * tolerant of any input, never throws.
 *
 * A STORED ID NOT IN THE VISIBLE LIST IS NEVER SILENTLY RESET — it is kept,
 * marked `inList: false`, and raises a notice, the same rule the objective
 * view follows for an unrecognised objective. Replacing it with null would
 * destroy a choice the engine is still honouring.
 *
 * The D25 classification lives HERE, never in the component.
 */
export function equipmentSpecsView(job: unknown, catalogue: unknown): EquipmentSpecsView {
  const detail = asRecord(job);
  const cat = asRecord(catalogue);
  const hasShape = EQUIPMENT_KINDS.some((k) => Array.isArray(cat[k]));
  const flags = Array.isArray(cat.flags) ? cat.flags : [];
  const available =
    hasShape && !flags.some((f) => f === "equipment_catalogue_unavailable");

  const panels = kindView("panels", detail, cat, available);
  const inverters = kindView("inverters", detail, cat, available);
  const batteries = kindView("batteries", detail, cat, available);
  const kinds = [panels, inverters, batteries];

  const notices: RoofNoticeView[] = [];
  if (!available) notices.push(EQUIPMENT_CATALOGUE_PROBLEM);
  if (available && kinds.some((k) => k.selectedId !== null && !k.inList)) {
    notices.push(EQUIPMENT_MISSING_NOTICE);
  }
  if (kinds.some((k) => k.selectedIsUserDefined)) {
    notices.push(EQUIPMENT_UNVERIFIED_NOTICE);
  }
  // Fires whenever ANY kind is on Auto — which is the common case, and is why
  // it is a caption: it can never NOT be true of a job in that state.
  if (kinds.some((k) => k.selectedId === null)) notices.push(EQUIPMENT_AUTO_CAPTION);

  return {
    panels,
    inverters,
    batteries,
    confirmed: detail.equipment_confirmed === true,
    catalogueAvailable: available,
    notices,
  };
}

/**
 * THE ROUND-TRIP CHECK, the same instrument objectiveSaveNotices is and for
 * the same reason: PATCH returns the updated row, not a { saved } envelope, so
 * there is no flag to read and a silent write failure looks identical to a
 * success. Only keys actually SENT are compared. Ids compare as trimmed
 * strings with null preserved (so null and "" are the same stored value, not a
 * disagreement); equipment_confirmed compares as a strict boolean.
 */
export function equipmentSaveNotices(sent: unknown, response: unknown): RoofNoticeView[] {
  const payload = asRecord(sent);
  const row = asRecord(response);
  const disagree: string[] = [];
  const idLabel: Record<string, string> = {
    equipment_panel_id: "panel",
    equipment_inverter_id: "inverter",
    equipment_battery_id: "battery",
  };
  for (const [field, label] of Object.entries(idLabel)) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (roofStr(payload[field]) !== roofStr(row[field])) disagree.push(label);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "equipment_confirmed")) {
    if ((payload.equipment_confirmed === true) !== (row.equipment_confirmed === true)) {
      disagree.push("confirmation");
    }
  }
  if (disagree.length === 0) return [];
  return [
    {
      tone: "problem",
      level: "notice",
      title: "The save did not take",
      body: `The job that came back does not carry what was sent (${disagree.join(", ")}). Nothing shown here is confirmed saved — try again.`,
    },
  ];
}

// ── Custom "Other / new" equipment (3.10 prompt 5) ───────────────────────────

/**
 * One form field of the custom-equipment drawer. `name` is THE EXACT backend
 * pydantic field name — it is the string that goes on the wire, and the
 * browser proxy forwards the body with no whitelist because the backend
 * models ARE the whitelist. pydantic DROPS unknown keys silently, so a field
 * named even slightly differently ("rte_pct") would produce a 201, a saved
 * unit, and a missing spec the engine then quietly defaults. The form and the
 * models are two places that must agree — verify_equipment_contract.py check 9
 * imports this table over node and asserts set equality with the models.
 */
export interface CustomFieldSpec {
  /** The exact backend model field name — load-bearing, on the wire. */
  name: string;
  label: string;
  type: "text" | "number" | "enum" | "boolean";
  /** Required ON THE FORM. Deliberately NOT pydantic's required-ness: the
      engine-mandatory fields (battery cost, panel dimensions) are Optional in
      pydantic on purpose — the refusal comes from RUNNING the engine reader —
      so the honest cross-check is "the backend refuses a body without this",
      which the gate performs by posting one. */
  required: boolean;
  unit?: string;
  /** Enum VALUES are the backend Literal members exactly; labels are UI-only. */
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: string;
}

/**
 * THIS EXPORT NAME IS LOAD-BEARING — verify_equipment_contract.py check 9 runs
 * it over node (both sides RUN, neither is parsed) and asserts set equality
 * with the backend models. Do not rename it, compose it at runtime, or build
 * it from another module: the same rule VALID_OBJECTIVES carries.
 *
 * The required sets are DERIVED, not chosen, and deliberately asymmetric:
 * a battery with no price is refused because the LP skips an unpriced unit; a
 * panel with no dimensions is refused because the roof reader would silently
 * fall back to the default panel; an inverter with no price is ACCEPTED
 * because the cost model excludes it with a flag and sizing still runs.
 */
export const CUSTOM_EQUIPMENT_FIELDS: Record<EquipmentKind, readonly CustomFieldSpec[]> = {
  panels: [
    { name: "brand", label: "Brand", type: "text", required: true },
    { name: "model", label: "Model", type: "text", required: true },
    { name: "series", label: "Series", type: "text", required: false },
    { name: "rated_power_w", label: "Rated power", type: "number", required: true, unit: "W", min: 0, max: 1000, step: "5" },
    { name: "length_mm", label: "Length", type: "number", required: true, unit: "mm", min: 0, max: 5000, step: "1" },
    { name: "width_mm", label: "Width", type: "number", required: true, unit: "mm", min: 0, max: 5000, step: "1" },
    {
      name: "cell_technology", label: "Cell technology", type: "enum", required: false,
      options: [
        { value: "mono_perc", label: "Mono PERC" },
        { value: "n_type_topcon", label: "N-type TOPCon" },
        { value: "hjt", label: "HJT" },
        { value: "ibc", label: "IBC" },
        { value: "hpbc", label: "HPBC" },
        { value: "abc", label: "ABC" },
      ],
    },
    { name: "module_efficiency_pct", label: "Module efficiency", type: "number", required: false, unit: "%", min: 0, max: 100, step: "0.1" },
    { name: "cost_aud", label: "Indicative cost", type: "number", required: false, unit: "$", min: 0, max: 1000000, step: "1" },
  ],
  inverters: [
    { name: "brand", label: "Brand", type: "text", required: true },
    { name: "model", label: "Model", type: "text", required: true },
    { name: "series", label: "Series", type: "text", required: false },
    {
      name: "inverter_type", label: "Inverter type", type: "enum", required: true,
      options: [
        { value: "string", label: "String" },
        { value: "hybrid", label: "Hybrid" },
        { value: "microinverter", label: "Microinverter" },
      ],
    },
    {
      name: "phases", label: "Phases", type: "enum", required: true,
      options: [
        { value: "single", label: "Single phase" },
        { value: "three", label: "Three phase" },
      ],
    },
    { name: "rated_ac_power_kw", label: "Rated AC power", type: "number", required: true, unit: "kW", min: 0, max: 1000, step: "0.1" },
    { name: "battery_ready", label: "Battery ready", type: "boolean", required: false },
    { name: "max_efficiency_pct", label: "Max efficiency", type: "number", required: false, unit: "%", min: 0, max: 100, step: "0.1" },
    { name: "cost_aud", label: "Indicative cost", type: "number", required: false, unit: "$", min: 0, max: 1000000, step: "1" },
  ],
  batteries: [
    { name: "brand", label: "Brand", type: "text", required: true },
    { name: "model", label: "Model", type: "text", required: true },
    { name: "series", label: "Series", type: "text", required: false },
    {
      name: "chemistry", label: "Chemistry", type: "enum", required: false,
      options: [
        { value: "lfp", label: "LFP" },
        { value: "nmc", label: "NMC" },
      ],
    },
    {
      name: "coupling", label: "Coupling", type: "enum", required: false,
      options: [
        { value: "ac", label: "AC coupled" },
        { value: "dc", label: "DC coupled" },
        { value: "hybrid_paired", label: "Hybrid-paired" },
        { value: "all_in_one", label: "All-in-one" },
      ],
    },
    { name: "usable_capacity_kwh", label: "Usable capacity", type: "number", required: true, unit: "kWh", min: 0, max: 1000, step: "0.1" },
    { name: "nominal_capacity_kwh", label: "Nominal capacity", type: "number", required: false, unit: "kWh", min: 0, max: 1000, step: "0.1" },
    { name: "cost_aud", label: "Indicative cost", type: "number", required: true, unit: "$", min: 0, max: 1000000, step: "1" },
    { name: "depth_of_discharge_pct", label: "Depth of discharge", type: "number", required: false, unit: "%", min: 0, max: 100, step: "1" },
    { name: "round_trip_efficiency_pct", label: "Round-trip efficiency", type: "number", required: false, unit: "%", min: 0, max: 100, step: "0.1" },
    { name: "max_continuous_charge_kw", label: "Max charge", type: "number", required: false, unit: "kW", min: 0, max: 1000, step: "0.1" },
    { name: "max_continuous_discharge_kw", label: "Max discharge", type: "number", required: false, unit: "kW", min: 0, max: 1000, step: "0.1" },
    { name: "warranty_cycles", label: "Warranty cycles", type: "number", required: false, min: 1, max: 100000, step: "100" },
    { name: "warranty_years", label: "Warranty years", type: "number", required: false, min: 1, max: 50, step: "1" },
  ],
};

/**
 * A successful create response → notices, classified HERE (D25), never in the
 * component. Pure, total, never throws.
 *
 * THE VERBATIM RULE: engine_assumptions are the engine's own sentences about
 * what it had to assume. They are joined, never re-worded, re-ordered or
 * summarised — a paraphrase here would drift from the engine's wording the
 * first time either changes, which is prompt 4's "no second copy of the
 * engine's defaults" rule one layer out.
 *
 * THREE DIFFERENT FACTS about duplicates, honoured separately:
 *   - the key ABSENT            → the check's outcome is unknown: say nothing.
 *   - present and EMPTY         → the check RAN and found nothing: a quiet
 *                                 caption, so "checked" is distinguishable
 *                                 from "unknown".
 *   - duplicate_check_unavailable flagged → the check DID NOT RUN: a caution
 *                                 notice. Never rendered as "no duplicates".
 */
export function customUnitNotices(response: unknown): RoofNoticeView[] {
  const body = asRecord(response);
  const out: RoofNoticeView[] = [];

  const assumptions = Array.isArray(body.engine_assumptions)
    ? body.engine_assumptions.filter((a): a is string => typeof a === "string" && a !== "")
    : [];
  if (assumptions.length > 0) {
    out.push({
      tone: "caution",
      level: "notice",
      title: "The engine filled some specs with its own assumptions",
      body: assumptions.join("\n"),
    });
  }

  const flags = Array.isArray(body.flags) ? body.flags : [];
  const checkUnavailable = flags.some((f) => f === "duplicate_check_unavailable");
  const hasDuplicatesKey = Object.prototype.hasOwnProperty.call(body, "duplicates");
  const duplicates = Array.isArray(body.duplicates) ? body.duplicates : [];

  if (checkUnavailable) {
    out.push({
      tone: "caution",
      level: "notice",
      title: "The duplicate check could not run",
      body: "The unit was saved, but it could not be compared against the units you can already see. That is not the same as no duplicates being found.",
    });
    return out;
  }
  if (!hasDuplicatesKey || !Array.isArray(body.duplicates)) return out;

  let exactMatch = false;
  for (const raw of duplicates) {
    const dup = asRecord(raw);
    const name = [roofStr(dup.brand), roofStr(dup.model)]
      .filter((p): p is string => p !== null)
      .join(" ") || "a unit";
    const differences = Array.isArray(dup.differences) ? dup.differences : [];
    if (differences.length === 0) {
      exactMatch = true;
      continue;
    }
    const lines = differences.map((d) => {
      const diff = asRecord(d);
      return `${String(diff.field ?? "a spec")}: on file ${diff.existing ?? "not stated"}, you entered ${diff.submitted ?? "not stated"}`;
    });
    out.push({
      tone: "caution",
      level: "notice",
      title: `You may already have ${name} — with different numbers`,
      body: lines.join("\n"),
    });
  }
  if (exactMatch) {
    out.push({
      tone: "info",
      level: "caption",
      title: "Already on file",
      body: "A unit with this brand and model, and the same numbers, is already in the list you can see.",
    });
  } else if (duplicates.length === 0) {
    out.push({
      tone: "info",
      level: "caption",
      title: "Checked against your catalogue",
      body: "No matching unit was found among the units you can see.",
    });
  }
  return out;
}

// ── Solar sizing (3.11) ──────────────────────────────────────────────────────

/**
 * THE REQUEST KEYS THE SECTION CAN EVER SEND — a literal, exported because
 * verify_sizing_request_contract.py runs it over node and asserts (a) every
 * key is a real OptimiseRequest field and (b) none of the stored-on-the-job
 * fields (objective, budget, equipment ids, tariff, load, installer_id) is
 * among them. Those are read server-side by the resolvers; sending them from
 * the browser would create a second source of truth for values 3.9/3.10 exist
 * to hold — the exact shape D29 rejected. If a figure looks wrong on screen,
 * the fix is in the stored value or the resolver, never a key added here.
 */
export const SOLAR_SIZING_REQUEST_KEYS = [
  "job_id",
  "constraints",
  // 3.14 prompt 6 (D37): the rail's re-cost declines persistence and the
  // throwaway comparison. Both are OptimiseRequest fields (prompts 2 and 5).
  "persist",
  "compare_to_unconstrained",
] as const;

/** One row of the options table, formatted for reading, not for arithmetic. */
export interface SolarOptionRow {
  label: string; // "6.2 kW", or "No system" for the empty reference row
  cost: string;
  payback: string;
  npv: string;
  selfSufficiency: string;
  chosen: boolean;
}

export interface SolarHeadline {
  solarKw: string;
  panelCount: string | null;
  annualGenerationKwh: string;
  systemCost: string;
  payback: string; // "no payback within the analysis period" when null
  npv: string;
  selfSufficiencyPct: string;
}

export interface SolarRunResult {
  ok: boolean;
  needsRoofInput: boolean;
  errorMessage: string | null;
  headline: SolarHeadline | null;
  options: SolarOptionRow[];
  /** The engine's own flag strings, VERBATIM (F161) — never paraphrased. */
  engineFlags: string[];
}

/**
 * 3.14 prompt 3 (F195/F206) — THE ONE SENTENCE for a run that did not record
 * which option it chose. Eight of the runs stored before 2026-08-21 carry no
 * chosen-option marker at all, and their chosen row CANNOT be identified: the
 * honest answer is to mark none and say so. Never inferred by matching
 * numbers (two options can tie on both), never backfilled.
 */
export const CHOSEN_NOT_RECORDED_NOTE =
  "This run did not record which option it chose, so none is marked.";

/**
 * THE STORED SOLAR RUN the section renders on a revisit (F206).
 *
 * `run` is a SolarRunResult — the SAME shape the button's reply produces — so
 * the section has ONE rendering path fed from two places rather than two
 * paths that must be kept in step.
 */
export interface StoredSolarRun {
  run: SolarRunResult;
  /** CHOSEN_NOT_RECORDED_NOTE when this run carries no marker, else null. */
  chosenNote: string | null;
  /** What this run did not record, in words, or null when it recorded it all. */
  notRecordedNote: string | null;
  /** 3.14 prompt 4 (F188): the tie sentence beneath the options table — THE
      SAME sentence the rail's chart caption shows, reached through the same
      solarCurveView -> flatOptionsNote derivation, never a second copy. */
  flatNote: string | null;
}

export interface SolarSizingView {
  /** From pathRule(job.path): "optimise" | "pinned" | "none" | null. */
  solarMode: PathRule["solarMode"] | null;
  existingSolarKw: number | null;
  /**
   * ONE boolean, derived here so no component re-derives the rule: pinnable
   * only when the path pins AND a finite positive size was actually recorded.
   * A pinned run without a number is not a pinned run — never invent a size.
   */
  canPin: boolean;
  /** The newest stored sizing row's solar_kw, for the revisit case. */
  storedSolarKw: number | null;
  alreadySized: boolean;
  /** 3.14 prompt 3 (F206): the WHOLE stored result, so a revisit renders the
      body rather than a one-line note. Non-null EXACTLY when alreadySized —
      both are `currentSizingResult` plus a readable solar_kw. */
  storedRun: StoredSolarRun | null;
  notices: RoofNoticeView[];
}

/**
 * The first source that actually CARRIES the key, and whether any did.
 *
 * The distinction matters for payback alone: formatYears(null) is the real
 * sentence "no payback within the analysis period", so a figure that was
 * never recorded must not travel through it — that would substitute a meaning
 * for an absence. `has: false` renders an em-dash and is named in
 * notRecordedNote instead.
 */
function pickStored(
  key: string,
  sources: Array<Record<string, unknown> | null>,
): { has: boolean; value: unknown } {
  for (const source of sources) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      return { has: true, value: source[key] };
    }
  }
  return { has: false, value: null };
}

/** "a, b and c" — for naming what a run did not record. */
function joinPhrases(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The chosen index of a stored options list, or null. NEVER a number match. */
function storedChosenIndex(
  container: Record<string, unknown>,
  points: unknown[],
): number | null {
  const idx = container.chosen_index;
  return typeof idx === "number" &&
    Number.isInteger(idx) &&
    idx >= 0 &&
    idx < points.length
    ? idx
    : null;
}

/**
 * THE STORED SOLAR RUN, built from what is already on the job (F206).
 *
 * WHICH CURVE: a run_kind 'solar' row stores its score curve at the top level
 * of evaluated_options; a run_kind 'solar_battery' row's top-level points are
 * BATTERY candidates and its solar curve sits under solar_options (3.14
 * prompt 2, F202). Reading the wrong one would put battery rows in a solar
 * table, so the run kind picks the container — never a guess at the shape.
 *
 * WHICH COST: on a battery run the row's system_cost is the WHOLE system's,
 * so the solar-only figures come from evaluated_options.split.solar_only —
 * the parts 3.13 prompt 3 stored for exactly this purpose. Nothing here is
 * recomputed and nothing is borrowed from another run: the financial row is
 * reached through currentFinancialResult, which matches by sizing_result_id.
 */
function storedSolarRun(job: unknown): StoredSolarRun | null {
  const sizing = currentSizingResult(job);
  if (sizing === null) return null;
  const solarKw = tariffNum(sizing.solar_kw);
  if (solarKw === null) return null; // agrees with alreadySized by construction

  const eo = asRecord(sizing.evaluated_options);
  const isBattery = sizing.run_kind === "solar_battery";
  const curve = isBattery ? asRecord(eo.solar_options) : eo;
  const points = Array.isArray(curve.points) ? curve.points : [];
  const chosenIndex = storedChosenIndex(curve, points);
  const chosen = chosenIndex !== null ? asRecord(points[chosenIndex]) : null;
  const solarOnly = isBattery
    ? asRecord(asRecord(eo.split).solar_only)
    : null;
  const chosenSolar = isBattery ? asRecord(eo.chosen_solar) : null;
  const fin = isBattery ? null : currentFinancialResult(job);

  const panels = pickStored("panel_count", [chosen, chosenSolar]);
  const panelsNum = tariffNum(panels.value);
  const cost = pickStored("system_cost", [
    isBattery ? solarOnly : (sizing as Record<string, unknown>),
  ]);
  const costNum = tariffNum(cost.value);
  const gen = tariffNum(sizing.annual_solar_generation_kwh);
  const payback = pickStored("simple_payback_years", [chosen, solarOnly]);
  const paybackFin = payback.has
    ? payback
    : pickStored("payback_years", [fin]);
  const npv = pickStored("npv_25yr", [chosen, solarOnly]);
  const npvFin = npv.has ? npv : pickStored("npv_25_year", [fin]);
  const npvNum = tariffNum(npvFin.value);
  // Self-sufficiency: for a solar run this IS storedSelfSufficiencyPct, the
  // derivation resultsView and the results bar already share; for a battery
  // run that helper answers for the WHOLE system, so the solar half comes
  // from this run's own solar curve point.
  const selfNum = isBattery
    ? tariffNum(pickStored("self_sufficiency_pct", [chosen]).value)
    : storedSelfSufficiencyPct(sizing, eo);

  const headline: SolarHeadline = {
    solarKw: fmtKw(solarKw),
    panelCount: panelsNum !== null ? `${Math.round(panelsNum)} panels` : null,
    annualGenerationKwh:
      gen !== null ? `${Math.round(gen).toLocaleString("en-AU")} kWh` : "—",
    systemCost: costNum !== null ? fmtAud(costNum) : "—",
    payback: paybackFin.has ? fmtYears(paybackFin.value) : "—",
    npv: npvNum !== null ? fmtAud(npvNum) : "—",
    selfSufficiencyPct: selfNum !== null ? fmtPct(selfNum) : "—",
  };

  const options: SolarOptionRow[] = [];
  for (let i = 0; i < points.length; i++) {
    const row = asRecord(points[i]);
    const kw = tariffNum(row.solar_kw);
    if (kw === null) continue;
    const rowCost = tariffNum(row.system_cost);
    const rowNpv = tariffNum(row.npv_25yr);
    const rowSelf = tariffNum(row.self_sufficiency_pct);
    options.push({
      label: kw > 0 ? fmtKw(kw) : "No system",
      cost: rowCost !== null ? fmtAud(rowCost) : "—",
      payback: fmtYears(row.simple_payback_years),
      npv: rowNpv !== null ? fmtAud(rowNpv) : "—",
      selfSufficiency: rowSelf !== null ? fmtPct(rowSelf) : "—",
      // ONLY the recorded marker. Never a capacity/cost match (F195).
      chosen: chosenIndex === i,
    });
  }

  const missing: string[] = [];
  if (options.length === 0) missing.push("the options it compared");
  if (panelsNum === null) missing.push("the panel count");
  if (!paybackFin.has) missing.push("the payback");
  if (npvNum === null) missing.push("the 25-year NPV");
  if (selfNum === null) missing.push("the self-sufficiency");

  return {
    run: {
      ok: true,
      needsRoofInput: false,
      errorMessage: null,
      headline,
      options,
      // Engine flags are not stored on a sizing row — a stored run has none
      // to show, and inventing any would be a second source (F161).
      engineFlags: [],
    },
    chosenNote:
      options.length > 0 && chosenIndex === null ? CHOSEN_NOT_RECORDED_NOTE : null,
    notRecordedNote:
      missing.length > 0
        ? `This run did not record ${joinPhrases(missing)}.`
        : null,
    // F188: the SAME sentence the chart caption carries — one rule, one
    // wording, two places on one screen.
    flatNote: solarCurveView(job).flatNote,
  };
}

const NO_PAYBACK = "no payback within the analysis period";

/** kW to the single decimal the inputs justify; no two-decimal kW. */
// ── THE ONE SET OF RESULT FORMATTERS (3.13 prompt 4, step C) ─────────────────
// Decided here, once: kW, kWh, years and percent at the precision actually
// STORED, trailing zeros trimmed (`${n}` on a JSON-parsed numeric is exactly
// that — 9.24 renders "9.24", 9.2 renders "9.2", 9 renders "9"); money to
// whole dollars in headline tiles (formatMoney) and to cents in the itemised
// breakdown (formatMoneyCents). The results BAR, the worksheet SECTION and
// the results TAB all import these same functions — the same run rendering
// as "9.24 kW" in one place and "9.2 kW" eight lines below it is the
// regression this block exists to end. A second formatter anywhere is that
// regression back.

export function formatKw(value: unknown): string {
  const n = tariffNum(value);
  return n === null ? "—" : `${n} kW`;
}

export function formatKwh(value: unknown): string {
  const n = tariffNum(value);
  return n === null ? "—" : `${n} kWh`;
}

export function formatYears(value: unknown): string {
  const n = tariffNum(value);
  if (n === null) return NO_PAYBACK;
  return `${n} yr`;
}

export function formatPct(value: unknown): string {
  const n = tariffNum(value);
  return n === null ? "—" : `${n}%`;
}

/** Whole dollars — headline tiles. Negative keeps its sign; the eliminated-
    bill framing (projectedSpendView) is where a negative spend becomes a
    positive export income instead. */
export function formatMoney(value: unknown): string {
  const n = tariffNum(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString("en-AU")}`;
}

/** Cents — the itemised cost breakdown, where the lines must sum to net. */
export function formatMoneyCents(value: unknown): string {
  const n = tariffNum(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// The pre-existing private names delegate to the shared set, so every view
// that already used them inherits the one decision.
function fmtKw(value: number): string {
  return formatKw(value);
}

function fmtAud(value: number): string {
  return formatMoney(value);
}

function fmtYears(value: unknown): string {
  return formatYears(value);
}

function fmtPct(value: number): string {
  return formatPct(value);
}

export const SOLAR_EXISTING_UNRECORDED_NOTICE: RoofNoticeView = {
  tone: "caution",
  level: "notice",
  title: "The existing array's size was never recorded",
  body: "This job has solar on the roof, but its size was not recorded, so the array cannot be kept as-is by number. Re-optimise will size fresh; the existing size can be added in the job details.",
};

/**
 * The section's stored-state view. Total, never throws; the D25 classification
 * lives HERE (the unrecorded-array caution is a FINDING about this job — a
 * comparable path-C job with the size recorded would not raise it).
 */
export function solarSizingView(job: unknown): SolarSizingView {
  const detail = asRecord(job);
  const rule = pathRule(detail.path);
  const solarMode = rule ? rule.solarMode : null;
  const existingRaw = tariffNum(detail.existing_solar_kw);
  const existingSolarKw = existingRaw !== null && existingRaw > 0 ? existingRaw : null;
  const canPin = solarMode === "pinned" && existingSolarKw !== null;

  // "Already sized" means the CURRENT result carries a solar figure — not that
  // some row ever did (3.11b prompt 1). Same rule as the solar-sizing section
  // predicate, and it must agree with it.
  const latest = currentSizingResult(job);
  const storedSolarKw = latest ? tariffNum(latest.solar_kw) : null;

  const notices: RoofNoticeView[] = [];
  if (solarMode === "pinned" && existingSolarKw === null) {
    notices.push(SOLAR_EXISTING_UNRECORDED_NOTICE);
  }
  return {
    solarMode,
    existingSolarKw,
    canPin,
    storedSolarKw,
    alreadySized: storedSolarKw !== null,
    storedRun: storedSolarRun(job),
    notices,
  };
}

/**
 * One SIZING response → notices, for either endpoint (3.12).
 *
 * ONE FUNCTION, TWO CALLERS, NOT A COPY. The battery response carries the SAME
 * roof_confidence object and the same method fact is true of it — both runs
 * read the objective, tariff, load and equipment already stored on the job. A
 * copied D25 classification is exactly what D25 says must not exist, so the
 * body lives here once and `solarRunNotices` / `batteryRunNotices` are named
 * doors onto it rather than two implementations kept in step (2R.1).
 */
export function sizingRunNotices(response: unknown): RoofNoticeView[] {
  const body = asRecord(response);
  const out: RoofNoticeView[] = [];

  // A FLAGGED ROOF: a comparable job with a clean roof raises nothing here, so
  // this is a FINDING about THIS job -> level "notice". Absent roof_confidence
  // (an older build's response) raises nothing — absent is not clean.
  const rc = asRecord(body.roof_confidence);
  if (rc.roof_low_confidence === true) {
    const reason = typeof rc.roof_reason === "string" && rc.roof_reason
      ? rc.roof_reason
      : "The roof measurement was flagged for checking.";
    out.push({
      tone: "caution",
      level: "notice",
      title: "Sized from a roof that was flagged for checking",
      // The roof's own words (F161), then the consequence, plainly. The doubt
      // travels; it does not stop the work (D24, F93).
      body: `${reason}\nThese numbers are only as good as that roof — check it before quoting.`,
    });
  }

  // THE METHOD FACT: every sizing this engine produces uses the stored
  // objective, tariff and equipment — true of ANY comparable job, so it is a
  // CAPTION, not a warning.
  out.push({
    tone: "info",
    level: "caption",
    title: "What this run used",
    body: "Sized with the objective, tariff, load and equipment already saved on this job. Change those in their sections and run again.",
  });
  return out;
}

/**
 * The solar section's door onto sizingRunNotices. Kept exported and unchanged
 * in behaviour so nothing that already calls it breaks (3.12).
 */
export function solarRunNotices(response: unknown): RoofNoticeView[] {
  return sizingRunNotices(response);
}

/** The battery section's door onto the same one function (3.12). */
export function batteryRunNotices(response: unknown): RoofNoticeView[] {
  return sizingRunNotices(response);
}

/**
 * One optimiser response → the figures an installer reads. Every formatter is
 * here so the suite asserts the exact strings that reach the screen. Total.
 */
export function solarRunResult(response: unknown): SolarRunResult {
  const body = asRecord(response);
  const errorMessage =
    typeof body.error === "string" && body.error ? body.error : null;
  const needsRoofInput = body.needs_roof_input === true;
  const opt = asRecord(body.optimal);
  const solarKw = tariffNum(opt.solar_kw);

  const ok = !errorMessage && !needsRoofInput && solarKw !== null;
  let headline: SolarHeadline | null = null;
  if (ok && solarKw !== null) {
    const panels = tariffNum(opt.panel_count);
    const gen = tariffNum(opt.annual_generation_kwh);
    const cost = tariffNum(opt.system_cost);
    const npv = tariffNum(opt.npv_25yr);
    const self = tariffNum(opt.self_sufficiency_pct);
    headline = {
      solarKw: fmtKw(solarKw),
      panelCount: panels !== null ? `${Math.round(panels)} panels` : null,
      annualGenerationKwh: gen !== null ? `${Math.round(gen).toLocaleString("en-AU")} kWh` : "—",
      systemCost: cost !== null ? fmtAud(cost) : "—",
      payback: fmtYears(opt.simple_payback_years),
      npv: npv !== null ? fmtAud(npv) : "—",
      selfSufficiencyPct: self !== null ? fmtPct(self) : "—",
    };
  }

  const options: SolarOptionRow[] = [];
  const curve = Array.isArray(body.score_curve) ? body.score_curve : [];
  for (const raw of curve) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const kw = tariffNum(row.solar_kw);
    if (kw === null) continue;
    const cost = tariffNum(row.system_cost);
    const npv = tariffNum(row.npv_25yr);
    const self = tariffNum(row.self_sufficiency_pct);
    options.push({
      // The empty reference row is LABELLED, never shown as 0 kW.
      label: kw > 0 ? fmtKw(kw) : "No system",
      cost: cost !== null ? fmtAud(cost) : "—",
      payback: fmtYears(row.simple_payback_years),
      npv: npv !== null ? fmtAud(npv) : "—",
      selfSufficiency: self !== null ? fmtPct(self) : "—",
      chosen: solarKw !== null && kw === solarKw,
    });
  }

  const engineFlags = Array.isArray(body.flags)
    ? body.flags.filter((f): f is string => typeof f === "string" && f !== "")
    : [];

  return { ok, needsRoofInput, errorMessage, headline, options, engineFlags };
}

// ── Battery sizing (checklist 3.12) ──────────────────────────────────────────

/**
 * THE WHOLE REQUEST BODY the Battery sizing screen may send. Same restraint as
 * SOLAR_SIZING_REQUEST_KEYS and the same reason: nothing stored on the job
 * travels from the browser — not the objective, not the budget, not the
 * equipment ids, not the tariff, not the battery ids, not installer_id. Those
 * are read server-side by the resolvers, and sending them would be a second
 * source of truth for values 3.9/3.10 exist to hold (D29). The two-sided gate
 * verify_sizing_request_contract.py holds this mechanically, against
 * BatteryRequest.model_fields.
 */
export const BATTERY_SIZING_REQUEST_KEYS = [
  "job_id",
  "constraints",
  // 3.14 prompt 6 (D37): see SOLAR_SIZING_REQUEST_KEYS.
  "persist",
  "compare_to_unconstrained",
] as const;

/** One row of the battery options table — for reading, not for arithmetic. */
export interface BatteryOptionRow {
  /** "13.5 kWh", or "No battery" for the baseline — NEVER "0 kWh". */
  label: string;
  model: string;
  /** The WHOLE system: solar plus this battery's incremental cost. */
  systemCost: string;
  payback: string;
  npv: string;
  selfSufficiency: string;
  chosen: boolean;
}

export interface BatteryHeadline {
  model: string;
  usableKwh: string;
  /** The battery's INCREMENTAL net cost — not the whole system's. */
  batteryCost: string;
  systemCost: string;
  payback: string;
  npv: string;
  selfSufficiencyPct: string;
}

export interface BatteryChosenSolar {
  solarKw: string;
  annualGenerationKwh: string;
  systemCostSolarOnly: string;
}

export interface BatteryRunResult {
  ok: boolean;
  needsRoofInput: boolean;
  errorMessage: string | null;
  headline: BatteryHeadline | null;
  /** The solar THIS run chose — it re-runs the solar step itself (D33). */
  chosenSolar: BatteryChosenSolar | null;
  options: BatteryOptionRow[];
  /** True when the engine recommends no battery — a legitimate outcome. */
  noBattery: boolean;
  /** The engine's own sentence, VERBATIM (F161), or null. Never reworded. */
  notEconomicReason: string | null;
  /** The engine's own flag strings, VERBATIM (F161) — never paraphrased. */
  engineFlags: string[];
  /** 3.13 prompt 3 (H/F184): the RETURNED within_budget flag, verbatim —
      derived by the engine from the same system_cost its budget filter
      tests, never recomputed on screen (D29, 2R.1). null when absent. */
  withinBudget: boolean | null;
}

/**
 * THE STORED BATTERY RUN the section renders on a revisit (F206). `run` is a
 * BatteryRunResult — the SAME shape the button's reply produces — so the
 * section keeps ONE rendering path fed from two places.
 */
export interface StoredBatteryRun {
  run: BatteryRunResult;
  /** CHOSEN_NOT_RECORDED_NOTE when this run carries no marker, else null. */
  chosenNote: string | null;
  /** What this run did not record, in words, or null. */
  notRecordedNote: string | null;
}

export interface BatterySizingView {
  /** From pathRule(job.path): "size" | "none" | null. */
  batteryMode: PathRule["batteryMode"] | null;
  /** The CURRENT stored result's battery_kwh, for the revisit case. */
  storedBatteryKwh: number | null;
  alreadySized: boolean;
  /** 3.14 prompt 3 (F206): the WHOLE stored result. Non-null EXACTLY when
      alreadySized — both are `currentSizingResult` plus a readable
      battery_kwh, which is what keeps this section's tick, its predicate and
      its body from ever disagreeing. */
  storedRun: StoredBatteryRun | null;
  /** 3.13 prompt 3 (H/F184): whether the JOB has a budget at all. A job with
      no cap has nothing to be within, so the run's within_budget flag renders
      only when this is true — a badge on an uncapped job is noise. */
  hasBudget: boolean;
  notices: RoofNoticeView[];
}

/** kWh to the single decimal the inputs justify. */
function fmtKwh(value: number): string {
  return formatKwh(value);
}

/**
 * The section's stored-state view. Total, never throws.
 *
 * `alreadySized` READS THE CURRENT RESULT, never `.some(...)` over every row,
 * and it agrees with the battery-sizing predicate in SECTIONS by construction:
 * both are `currentSizingResult(job)` plus a non-null battery_kwh. That is the
 * honest un-tick from 3.11b — when a newer solar-only run supersedes a battery
 * run, the current recommendation contains no battery, so both go false
 * together. Two rules for one idea is what 2R.1 forbids.
 */
/**
 * THE STORED BATTERY RUN, built from what is already on the job (F206).
 *
 * THE INCREMENTAL FIGURES ARE NOT ON THE FINANCIAL ROW. That row holds the
 * WHOLE system's payback and NPV; this section shows what the BATTERY adds.
 * So they come from the chosen candidate, else from
 * evaluated_options.split.battery_increment — the parts 3.13 prompt 3 stored.
 * Reading the financial row here would put a whole-system number under a
 * label that says incremental, which is the class of quiet mismatch this
 * codebase keeps deleting.
 */
function storedBatteryRun(job: unknown): StoredBatteryRun | null {
  const sizing = currentSizingResult(job);
  if (sizing === null) return null;
  const usableKwh = tariffNum(sizing.battery_kwh);
  if (usableKwh === null) return null; // agrees with alreadySized

  const eo = asRecord(sizing.evaluated_options);
  const points = Array.isArray(eo.points) ? eo.points : [];
  const chosenIndex = storedChosenIndex(eo, points);
  const chosen = chosenIndex !== null ? asRecord(points[chosenIndex]) : null;
  const split = asRecord(eo.split);
  const increment = asRecord(split.battery_increment);
  const solarOnly = asRecord(split.solar_only);
  const noBattery = usableKwh === 0;

  const model = pickStored("model", [chosen]);
  const battCost = tariffNum(
    pickStored("battery_cost", [chosen, increment]).value,
  );
  const sysCost = tariffNum(sizing.system_cost);
  const payback = pickStored("incremental_payback_years", [chosen, increment]);
  const npvNum = tariffNum(
    pickStored("incremental_npv", [chosen, increment]).value,
  );
  // The SAME derivation resultsView and the results bar use, so the bar's
  // figure and the section's can never disagree on one screen.
  const selfNum = storedSelfSufficiencyPct(sizing, eo);

  const headline: BatteryHeadline = {
    model:
      typeof model.value === "string" && model.value ? model.value : "—",
    usableKwh: usableKwh > 0 ? fmtKwh(usableKwh) : "No battery",
    batteryCost: battCost !== null ? fmtAud(battCost) : "—",
    systemCost: sysCost !== null ? fmtAud(sysCost) : "—",
    payback: payback.has ? fmtYears(payback.value) : "—",
    npv: npvNum !== null ? fmtAud(npvNum) : "—",
    selfSufficiencyPct: selfNum !== null ? fmtPct(selfNum) : "—",
  };

  // The solar THIS run chose — its layout is stored under chosen_solar, its
  // solar-only cost under split.solar_only, and the generation on the row.
  const cs = asRecord(eo.chosen_solar);
  const csKw = tariffNum(pickStored("solar_kw", [cs, sizing]).value);
  let chosenSolar: BatteryChosenSolar | null = null;
  if (csKw !== null) {
    const csGen = tariffNum(sizing.annual_solar_generation_kwh);
    const csCost = tariffNum(pickStored("system_cost", [solarOnly]).value);
    chosenSolar = {
      solarKw: fmtKw(csKw),
      annualGenerationKwh:
        csGen !== null ? `${Math.round(csGen).toLocaleString("en-AU")} kWh` : "—",
      systemCostSolarOnly: csCost !== null ? fmtAud(csCost) : "—",
    };
  }

  const options: BatteryOptionRow[] = [];
  for (let i = 0; i < points.length; i++) {
    const row = asRecord(points[i]);
    const kwh = tariffNum(row.usable_kwh);
    if (kwh === null) continue;
    const rowCost = tariffNum(row.system_cost);
    const rowNpv = tariffNum(row.incremental_npv);
    const rowSelf = tariffNum(row.self_sufficiency_pct);
    options.push({
      label: kwh > 0 ? fmtKwh(kwh) : "No battery",
      model: typeof row.model === "string" && row.model ? row.model : "—",
      systemCost: rowCost !== null ? fmtAud(rowCost) : "—",
      payback: fmtYears(row.incremental_payback_years),
      npv: rowNpv !== null ? fmtAud(rowNpv) : "—",
      selfSufficiency: rowSelf !== null ? fmtPct(rowSelf) : "—",
      // ONLY the recorded marker — never a capacity-and-cost match (F195).
      chosen: chosenIndex === i,
    });
  }

  const missing: string[] = [];
  if (options.length === 0) missing.push("the options it compared");
  if (!noBattery && model.value === undefined) missing.push("which battery it chose");
  if (battCost === null && !noBattery) missing.push("the battery's added cost");
  if (!payback.has) missing.push("the incremental payback");
  if (npvNum === null) missing.push("the incremental NPV");
  if (selfNum === null) missing.push("the self-sufficiency");
  // not_economic_reason is NOT a stored column — a stored no-battery run can
  // say THAT no battery was recommended but never the engine's own why.
  if (noBattery) missing.push("why no battery was recommended");

  return {
    run: {
      ok: true,
      needsRoofInput: false,
      errorMessage: null,
      headline,
      chosenSolar,
      options,
      noBattery,
      // Never stored; the section renders the heading alone rather than a
      // reworded stand-in (F161).
      notEconomicReason: null,
      engineFlags: [],
      // The row stores the engine's own flag — read, never recomputed.
      withinBudget:
        typeof sizing.within_budget === "boolean" ? sizing.within_budget : null,
    },
    chosenNote:
      options.length > 0 && chosenIndex === null ? CHOSEN_NOT_RECORDED_NOTE : null,
    notRecordedNote:
      missing.length > 0
        ? `This run did not record ${joinPhrases(missing)}.`
        : null,
  };
}

export function batterySizingView(job: unknown): BatterySizingView {
  const detail = asRecord(job);
  const rule = pathRule(detail.path);
  const latest = currentSizingResult(job);
  const storedBatteryKwh = latest ? tariffNum(latest.battery_kwh) : null;
  return {
    batteryMode: rule ? rule.batteryMode : null,
    storedBatteryKwh,
    alreadySized: storedBatteryKwh !== null,
    storedRun: storedBatteryRun(job),
    // 3.13 prompt 3 (H): the same coerced read objectiveBudgetView uses — a
    // stored cap that parses to a positive number is a budget; anything else
    // is "no cap".
    hasBudget: (tariffNum(detail.budget_aud) ?? 0) > 0,
    // No D25 finding is available from stored state alone: whether a battery
    // is worth it is the ENGINE's answer, carried in not_economic_reason after
    // a run — never guessed here from the path.
    notices: [],
  };
}

/**
 * One battery-endpoint response → the figures an installer reads. Every
 * formatter is here so the suite asserts the exact strings that reach the
 * screen. Total: null, a string, an array of nulls all yield an empty view.
 *
 * A 200 IS NOT AUTOMATICALLY A RESULT — this branches on the BODY exactly as
 * solarRunResult does: needs_roof_input is not an error, and `error` can
 * arrive with a 200.
 *
 * THE NO-BATTERY BASELINE carries a deliberately smaller key set and NO
 * battery_id, NO annual_discharge_kwh, NO round_trip_efficiency and NO
 * depth_of_discharge. Every absent key renders "—", never "undefined", "null",
 * "0" or "NaN", and the row is LABELLED "No battery" rather than shown as
 * "0 kWh". Its absent battery_id IS the no-choice option — never invent one.
 *
 * THERE IS DELIBERATELY NO BUDGET BADGE. The response carries no
 * within_budget field (the endpoint computes it inside the writer, which only
 * runs when a job_id is present), and deriving one here would be a second
 * copy of a rule the engine already owns (2R.1). The budget cause is carried
 * honestly in not_economic_reason. Results presentation is 3.13.
 */
export function batteryRunResult(response: unknown): BatteryRunResult {
  const body = asRecord(response);
  const errorMessage =
    typeof body.error === "string" && body.error ? body.error : null;
  const needsRoofInput = body.needs_roof_input === true;
  const opt = asRecord(body.optimal_battery);
  const usableKwh = tariffNum(opt.usable_kwh);

  const ok = !errorMessage && !needsRoofInput && usableKwh !== null;
  const noBattery = ok && usableKwh === 0;

  let headline: BatteryHeadline | null = null;
  if (ok && usableKwh !== null) {
    const battCost = tariffNum(opt.battery_cost);
    const sysCost = tariffNum(opt.system_cost);
    const npv = tariffNum(opt.incremental_npv);
    const self = tariffNum(opt.self_sufficiency_pct);
    headline = {
      model: typeof opt.model === "string" && opt.model ? opt.model : "—",
      usableKwh: usableKwh > 0 ? fmtKwh(usableKwh) : "No battery",
      batteryCost: battCost !== null ? fmtAud(battCost) : "—",
      systemCost: sysCost !== null ? fmtAud(sysCost) : "—",
      payback: fmtYears(opt.incremental_payback_years),
      npv: npv !== null ? fmtAud(npv) : "—",
      selfSufficiencyPct: self !== null ? fmtPct(self) : "—",
    };
  }

  let chosenSolar: BatteryChosenSolar | null = null;
  if (ok) {
    const cs = asRecord(body.chosen_solar);
    const kw = tariffNum(cs.solar_kw);
    if (kw !== null) {
      const gen = tariffNum(cs.annual_generation_kwh);
      const cost = tariffNum(cs.system_cost_solar_only);
      chosenSolar = {
        solarKw: fmtKw(kw),
        annualGenerationKwh:
          gen !== null ? `${Math.round(gen).toLocaleString("en-AU")} kWh` : "—",
        systemCostSolarOnly: cost !== null ? fmtAud(cost) : "—",
      };
    }
  }

  const options: BatteryOptionRow[] = [];
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  for (const raw of candidates) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const kwh = tariffNum(row.usable_kwh);
    if (kwh === null) continue;
    const sysCost = tariffNum(row.system_cost);
    const npv = tariffNum(row.incremental_npv);
    const self = tariffNum(row.self_sufficiency_pct);
    options.push({
      // The no-battery baseline is LABELLED, never shown as "0 kWh".
      label: kwh > 0 ? fmtKwh(kwh) : "No battery",
      model: typeof row.model === "string" && row.model ? row.model : "—",
      systemCost: sysCost !== null ? fmtAud(sysCost) : "—",
      payback: fmtYears(row.incremental_payback_years),
      npv: npv !== null ? fmtAud(npv) : "—",
      selfSufficiency: self !== null ? fmtPct(self) : "—",
      chosen: usableKwh !== null && kwh === usableKwh,
    });
  }

  const notEconomicReason =
    typeof body.not_economic_reason === "string" && body.not_economic_reason
      ? body.not_economic_reason
      : null;

  const engineFlags = Array.isArray(body.flags)
    ? body.flags.filter((f): f is string => typeof f === "string" && f !== "")
    : [];

  return {
    ok,
    needsRoofInput,
    errorMessage,
    headline,
    chosenSolar,
    options,
    noBattery,
    notEconomicReason,
    engineFlags,
    withinBudget:
      typeof body.within_budget === "boolean" ? body.within_budget : null,
  };
}

// ── Run progress (checklist 3.13 prompt 2b) ──────────────────────────────────

/**
 * The live elapsed label the RunProgress indicator ticks: "0s", "47s",
 * "1m 04s", "2m 31s". Seconds are zero-padded only when minutes are shown.
 *
 * Total: never throws for ANY input — negative, NaN, Infinity and non-numbers
 * all yield "0s". It lives in lib, not the component, so the node suite can
 * test it; the component holds no formatting logic.
 */
export function elapsedLabel(ms: number): string {
  const totalSeconds =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? Math.floor(ms / 1000)
      : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// ── Results section (checklist 3.13 prompt 3) ────────────────────────────────

/**
 * Self-sufficiency as the STORED run recorded it, never recomputed. A solar
 * run names its winning point by chosen_index; a battery run's chosen
 * candidate is identified by the row's own stored figures (usable_kwh +
 * system_cost) — an ambiguous match yields null, never a guess. ONE
 * derivation, two readers (resultsView and resultsBarView).
 */
function storedSelfSufficiencyPct(
  sizing: Record<string, unknown>,
  eo: Record<string, unknown>,
): number | null {
  const runKind = typeof sizing.run_kind === "string" ? sizing.run_kind : null;
  if (runKind === "solar_battery") {
    const points = Array.isArray(eo.points) ? eo.points : [];
    const rowKwh = tariffNum(sizing.battery_kwh);
    const rowCost = tariffNum(sizing.system_cost);
    const matches = points
      .map((p) => asRecord(p))
      .filter(
        (p) =>
          rowKwh !== null &&
          rowCost !== null &&
          tariffNum(p.usable_kwh) === rowKwh &&
          tariffNum(p.system_cost) === rowCost,
      );
    return matches.length === 1
      ? tariffNum(matches[0].self_sufficiency_pct)
      : null;
  }
  if (
    typeof eo.chosen_index === "number" &&
    Number.isInteger(eo.chosen_index) &&
    Array.isArray(eo.points)
  ) {
    return tariffNum(asRecord(eo.points[eo.chosen_index]).self_sufficiency_pct);
  }
  return null;
}

export interface ResultsHeadline {
  solarKw: string;
  /** null on a solar-only run (no battery was sized — different fact from
      "No battery", which is the engine's answer on a battery run). */
  battery: string | null;
  systemCost: string;
  annualSavings: string;
  payback: string;
  npv: string;
  currentSpend: string;
  selfSufficiency: string | null;
}

export interface ResultsView {
  /**
   * "unsized"            — no current sizing result. Say so; never "0 kW".
   * "awaiting-financial" — a run exists but ITS financial row does not.
   *                        Never fall back to an unmatched row (the pairing
   *                        defect prompt 2 removed must not reappear here).
   * "ready"              — the current run and its matching financial row.
   * ready ⇔ currentFinancialResult(job) !== null BY CONSTRUCTION, so the
   * section's tick and its body can never disagree.
   */
  state: "unsized" | "awaiting-financial" | "ready";
  headline: ResultsHeadline | null;
  /** 3.13 prompt 4b (C): the projected annual spend through THE ONE
      bill-eliminated derivation (projectedSpendView) — the same object the
      tab renders, so the two surfaces cannot disagree. */
  projected: ProjectedSpendView | null;
  /** THE ROOF'S DOUBT (F93), read from the SIZING ROW — the run was built on
      the roof as it stood at the time, never the job's newest roof. */
  roofNotices: RoofNoticeView[];
  /** THE PANELS' DIRECTION (F168): plain statements of fact, one per plane.
      null when the layout could not be honestly derived — see layoutNote. */
  layoutLines: string[] | null;
  /** The honest line shown when layoutLines is null. */
  layoutNote: string | null;
  /** For the Results tab (prompt 4); not rendered by the section. */
  dispatchResolution: string | null;
  runKind: string | null;
}

/**
 * resultsView (3.13 prompt 3) — the Results section's one source: the CURRENT
 * sizing result and ITS financial row, the roof doubt stored ON that run, and
 * the chosen panel layout joined BY roof_geometry_id — never newest-first.
 * Total: never throws; junk yields nulls and the section renders what it has.
 * Nothing is invented and no figure is shown without the doubt that belongs
 * to it.
 */
export function resultsView(job: unknown): ResultsView {
  const sizing = currentSizingResult(job);
  const fin = currentFinancialResult(job);
  const state: ResultsView["state"] =
    fin !== null ? "ready" : sizing !== null ? "awaiting-financial" : "unsized";
  if (sizing === null) {
    return {
      state: "unsized",
      headline: null,
      projected: null,
      roofNotices: [],
      layoutLines: null,
      layoutNote: null,
      dispatchResolution: null,
      runKind: null,
    };
  }

  const runKind = typeof sizing.run_kind === "string" ? sizing.run_kind : null;
  const eo = asRecord(sizing.evaluated_options);

  // ── The roof's doubt, from the sizing row (F93). null is NOT clean —
  // 3.11 preserved the null/false distinction deliberately.
  const roofNotices: RoofNoticeView[] = [];
  const low = sizing.roof_low_confidence;
  const needs = sizing.roof_needs_manual_confirmation;
  const reason =
    typeof sizing.roof_reason === "string" && sizing.roof_reason
      ? sizing.roof_reason
      : null;
  if (low === true) {
    roofNotices.push({
      tone: "caution",
      level: "notice",
      title: "Sized on a roof that was flagged for checking",
      body:
        reason ??
        "The roof measurement was flagged before this run and was used as it stood, so this result is only as good as that roof.",
    });
  } else if (low !== false) {
    roofNotices.push({
      tone: "info",
      level: "notice",
      title: "The roof state was not recorded for this run",
      body: "This run did not record the roof's confidence, which is a different fact from a clean roof.",
    });
  }
  if (needs === true) {
    roofNotices.push({
      tone: "caution",
      level: "notice",
      title: "The roof needs manual confirmation",
      body: reason ?? "The roof model asked for a manual check before this run.",
    });
  }

  // ── The panels' direction (F168): join the roof BY ID, never newest.
  const rgid =
    typeof sizing.roof_geometry_id === "string" && sizing.roof_geometry_id
      ? sizing.roof_geometry_id
      : null;
  const roofRow = rgid
    ? (arr(asObject(job).roof_geometry).find(
        (r) => r.roof_geometry_id === rgid,
      ) ?? null)
    : null;

  // The chosen point: a battery run stores the chosen solar layout in
  // evaluated_options.chosen_solar; a solar run names its winning point by
  // chosen_index into points.
  let chosenLayout: Record<string, unknown> | null = null;
  const chosenSolar = asRecord(eo.chosen_solar);
  if (Array.isArray(chosenSolar.plane_indices)) {
    chosenLayout = chosenSolar;
  } else if (
    typeof eo.chosen_index === "number" &&
    Number.isInteger(eo.chosen_index) &&
    Array.isArray(eo.points)
  ) {
    const point = eo.points[eo.chosen_index];
    const p = asRecord(point);
    if (Array.isArray(p.plane_indices)) chosenLayout = p;
  }

  let layoutLines: string[] | null = null;
  let layoutNote: string | null = null;
  if (!rgid || !roofRow) {
    layoutNote =
      "The roof this run was sized on could not be matched to a stored roof, so which planes the panels sit on cannot be stated.";
  } else if (
    !chosenLayout ||
    !Array.isArray(chosenLayout.plane_indices) ||
    !Array.isArray(chosenLayout.panels_per_plane)
  ) {
    layoutNote =
      "This run did not record which planes its panels sit on, so the direction cannot be stated.";
  } else {
    const planes = Array.isArray(roofRow.planes) ? roofRow.planes : null;
    if (!planes) {
      layoutNote =
        "The roof this run was sized on holds no readable planes, so the direction cannot be stated.";
    } else {
      const lines: string[] = [];
      let broken = false;
      for (const rawIdx of chosenLayout.plane_indices) {
        if (
          typeof rawIdx !== "number" ||
          !Number.isInteger(rawIdx) ||
          rawIdx < 0 ||
          rawIdx >= planes.length
        ) {
          broken = true;
          break;
        }
        const plane = asRecord(planes[rawIdx]);
        const count = chosenLayout.panels_per_plane[rawIdx];
        if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
          // A named plane carrying no panels in this config is skipped, not
          // invented into a sentence.
          continue;
        }
        const compass = azimuthLabel(tariffNum(plane.azimuth));
        const pitch = tariffNum(plane.pitch);
        // 3.13 prompt 4 (F, found on screen): four planes rendered as two
        // pairs sharing a description ("… the WNW-facing plane" twice), so
        // four faces read as two. Each line now leads with the plane's own
        // identity — its index in the SAME order the roof section's table
        // lists them, plus the stored label when the roof carries one — and
        // keeps direction and pitch as the distinguishing facts of record.
        const storedLabel =
          typeof plane.label === "string" && plane.label
            ? ` (${plane.label})`
            : "";
        const direction = compass
          ? `${compass}-facing`
          : "direction not recorded";
        const pitchPart = pitch !== null ? `, pitch ${pitch}°` : "";
        lines.push(
          `Plane ${rawIdx + 1}${storedLabel} — ${count} panel${count === 1 ? "" : "s"}, ${direction}${pitchPart}`,
        );
      }
      if (broken || lines.length === 0) {
        layoutNote =
          "This run's stored layout does not match the roof it names, so the direction cannot be stated.";
      } else {
        layoutLines = lines;
      }
    }
  }

  // ── Self-sufficiency: read from the stored run, never recomputed —
  // ONE derivation (storedSelfSufficiencyPct), shared with resultsBarView.
  const selfSufficiency = storedSelfSufficiencyPct(sizing, eo);

  let headline: ResultsHeadline | null = null;
  if (fin !== null) {
    const solarKw = tariffNum(sizing.solar_kw);
    const batteryKwh = tariffNum(sizing.battery_kwh);
    const money = (v: unknown): string => {
      const n = tariffNum(v);
      return n !== null ? fmtAud(n) : "—";
    };
    headline = {
      solarKw: solarKw !== null ? fmtKw(solarKw) : "—",
      battery:
        batteryKwh === null
          ? null
          : batteryKwh > 0
            ? fmtKwh(batteryKwh)
            : "No battery",
      systemCost: money(fin.system_capex),
      annualSavings: money(fin.annual_savings),
      payback: fmtYears(fin.payback_years),
      npv: money(fin.npv_25_year),
      currentSpend: money(fin.current_annual_spend),
      selfSufficiency: selfSufficiency !== null ? fmtPct(selfSufficiency) : null,
    };
  }

  return {
    state,
    headline,
    projected: fin !== null ? projectedSpendView(fin.projected_annual_spend) : null,
    roofNotices,
    layoutLines,
    layoutNote,
    dispatchResolution:
      typeof eo.dispatch_resolution === "string" && eo.dispatch_resolution
        ? eo.dispatch_resolution
        : null,
    runKind,
  };
}

// ── The Results tab (checklist 3.13 prompt 4) ────────────────────────────────

/**
 * THE BILL-ELIMINATED FRAMING (UT-9): a projected annual spend at or below
 * zero never renders as "$0" or a negative dollar figure — the bill is
 * eliminated, and the amount below zero is stated as a POSITIVE export
 * income. exportIncome is null at exactly zero (nothing to state).
 */
export type ProjectedSpendView =
  | { kind: "spend"; label: string }
  | { kind: "eliminated"; exportIncome: string | null };

export function projectedSpendView(value: unknown): ProjectedSpendView | null {
  const n = tariffNum(value);
  if (n === null) return null;
  if (n <= 0) {
    return {
      kind: "eliminated",
      exportIncome: n < 0 ? formatMoney(Math.abs(n)) : null,
    };
  }
  return { kind: "spend", label: formatMoney(n) };
}

export interface ResultsSplitColumn {
  savings: string;
  npv: string;
  payback: string;
  cost: string;
}

export interface ResultsCostLine {
  item: string;
  detail: string;
  /** formatMoneyCents, or the literal "installer to confirm" for a null
      amount — NEVER $0: an unpriced line is a different fact from a free one. */
  amount: string;
  confirmed: boolean;
}

export interface ResultsCostView {
  lines: ResultsCostLine[];
  net: string;
  /** True when every line is priced AND the lines sum to net within a cent.
      False means the disagreement is SHOWN (sumOfLines beside net), never
      silently resolved — cost lines summing to net is the row's acceptance,
      so a mismatch is a finding. */
  sumAgrees: boolean;
  /** Rendered beside net when sumAgrees is false and every line is priced. */
  sumOfLines: string | null;
  allPriced: boolean;
  flags: string[];
}

export interface ResultsAssumptionRow {
  label: string;
  value: string;
  source: string | null;
}

export interface ResultsTabView {
  state: "unsized" | "awaiting-financial" | "ready";
  headline: ResultsHeadline | null;
  projected: ProjectedSpendView | null;
  roofNotices: RoofNoticeView[];
  layoutLines: string[] | null;
  layoutNote: string | null;
  dispatchResolution: string | null;
  runKind: string | null;
  /** 3.13 prompt 4b: the score curve's data — rendered only by the tab. */
  curve: ScoreCurveView;
  /** 3.13 prompt 4c (D34): the ROI toggle, stored on the job. Strictly
      boolean-true; anything else is off — off is the safe state. */
  showRoi: boolean;
  /** ALWAYS all three, smallest first; null values render as unavailable. */
  roi: [RoiFigure, RoiFigure, RoiFigure];
  split: {
    solar: ResultsSplitColumn;
    battery: ResultsSplitColumn;
    whole: ResultsSplitColumn;
  } | null;
  splitNote: string | null;
  cost: ResultsCostView | null;
  costNote: string | null;
  assumptions: ResultsAssumptionRow[] | null;
  assumptionsNote: string | null;
}

/** Plain-English labels for the known assumption keys, with the block's own
    provenance keys paired as sources. Unknown keys still render — every
    figure traces to an assumption, so nothing stored is hidden. */
function assumptionRows(
  ra: Record<string, unknown>,
  panelDetail: string | null = null,
): ResultsAssumptionRow[] {
  const rows: ResultsAssumptionRow[] = [];
  const used = new Set<string>();
  const take = (key: string): unknown => {
    used.add(key);
    return ra[key];
  };
  const str = (v: unknown): string =>
    v === null || v === undefined
      ? "not recorded"
      : typeof v === "string"
        ? v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v);

  // Provenance keys consumed as SOURCES, not rows of their own. 3.13 prompt
  // 4b: each value carries its OWN source key; the old single tariff_source
  // remains as the fallback so rows stored BEFORE the change render what they
  // recorded — history is not rewritten and not hidden.
  const legacySource =
    "tariff_source" in ra ? str(take("tariff_source")) : null;
  const own = (key: string): string | null => {
    if (key in ra) {
      const v = take(key);
      if (typeof v === "string" && v) return v;
    }
    return legacySource;
  };
  const importRateSource = own("import_rate_source");
  const rate24Source = own("rate_24_source");
  const tariffTypeSource = own("tariff_type_source");
  const fitOwnSource = own("fit_source");
  const supplySource = str(take("supply_charge_source"));
  const fitFallback = take("fit_is_fallback") === true;
  const exportMeta = asRecord(take("export_limit_source"));
  const exportSource =
    typeof exportMeta.source === "string"
      ? exportMeta.source
      : typeof exportMeta.dnsp === "string"
        ? exportMeta.dnsp
        : exportMeta.is_default === true
          ? "default"
          : null;

  const importRate = take("import_rate");
  if (importRate !== undefined) {
    rows.push({
      label: "Import rate",
      value: `${formatMoneyCents(importRate)}/kWh`,
      source: importRateSource,
    });
  }
  const rates24 = take("import_rates_24");
  if (Array.isArray(rates24) && rates24.length > 0) {
    const nums = rates24
      .map((v) => tariffNum(v))
      .filter((v): v is number => v !== null);
    rows.push({
      label: "Hourly import rates",
      value:
        nums.length > 0
          ? `${rates24.length} hourly rates, ${formatMoneyCents(Math.min(...nums))}–${formatMoneyCents(Math.max(...nums))}/kWh`
          : "unreadable",
      source: rate24Source,
    });
  } else {
    used.add("import_rates_24");
  }
  if ("tariff_type" in ra) {
    // Plain words, never the raw database token (3.13-4b step B).
    const rawType = take("tariff_type");
    const typeWords: Record<string, string> = {
      tou: "time of use",
      flat: "flat rate",
      demand: "demand",
      block: "block",
    };
    rows.push({
      label: "Tariff type",
      value:
        typeof rawType === "string" && rawType in typeWords
          ? typeWords[rawType]
          : str(rawType),
      source: tariffTypeSource,
    });
  }
  // The separate "Time-of-use pricing: yes" row was REDUNDANT with the
  // tariff type — two rows stating one fact is how a panel starts
  // disagreeing with itself. Consumed, not rendered.
  used.add("is_tou");
  if ("fit" in ra) {
    rows.push({
      label: "Feed-in tariff",
      value: `${formatMoneyCents(take("fit"))}/kWh`,
      source:
        fitOwnSource ?? (fitFallback ? "default (state scheme)" : legacySource),
    });
  }
  if ("supply_charge_annual" in ra) {
    const sc = take("supply_charge_annual");
    rows.push({
      label: "Daily supply charge (annualised)",
      value: sc === null ? "not stated" : `${formatMoney(sc)}/yr`,
      source: supplySource,
    });
  }
  if ("export_limit_kw" in ra) {
    rows.push({ label: "Export limit", value: formatKw(take("export_limit_kw")), source: exportSource });
  }
  if ("resolution" in ra) {
    rows.push({
      label: "Battery dispatch",
      value:
        take("resolution") === "full_year"
          ? "all 365 real days (full year)"
          : str(ra.resolution),
      source: null,
    });
  }
  if ("performance_ratio_non_temp" in ra) {
    rows.push({ label: "Performance ratio (non-temperature)", value: str(take("performance_ratio_non_temp")), source: null });
  }
  if ("temperature_derating_applied" in ra) {
    rows.push({
      label: "Temperature derating",
      value: take("temperature_derating_applied") === true ? "applied here" : "already in the PVGIS profile",
      source: null,
    });
  }
  if ("discount_rate" in ra) {
    rows.push({ label: "Discount rate", value: str(take("discount_rate")), source: null });
  }
  if ("analysis_years" in ra) {
    rows.push({ label: "Analysis period", value: `${str(take("analysis_years"))} years`, source: null });
  }
  if ("degradation_annual_pct" in ra) {
    rows.push({ label: "Panel degradation", value: `${str(take("degradation_annual_pct"))}%/yr`, source: null });
  }
  if ("tariff_escalation_pct" in ra) {
    rows.push({ label: "Tariff escalation", value: `${str(take("tariff_escalation_pct"))}%/yr`, source: null });
  }
  const panel = take("panel");
  if (panel !== undefined) {
    const p = asRecord(panel);
    const watts = tariffNum(p.watts);
    rows.push({
      label: "Panel",
      // 3.13-4b step B: the SAME description the cost table gives the panel —
      // brand, model and wattage — one description of one object; wattage
      // alone only when no cost line carries the fuller name.
      value:
        panelDetail ?? (watts !== null ? `${watts} W` : str(panel)),
      source: null,
    });
  }
  if ("total_load_kwh" in ra) {
    rows.push({ label: "Annual load", value: `${str(take("total_load_kwh"))} kWh`, source: null });
  }
  if ("custom_weight" in ra) {
    const w = take("custom_weight");
    if (w !== null) rows.push({ label: "Custom objective blend", value: str(w), source: null });
  }
  const constraints = take("constraints_applied");
  const conRec = asRecord(constraints);
  const activeCons = Object.entries(conRec).filter(([, v]) => v != null);
  rows.push({
    label: "Constraints applied",
    value:
      activeCons.length === 0
        ? "none"
        : activeCons.map(([k, v]) => `${k}: ${str(v)}`).join(", "),
    source: null,
  });
  if ("engine_version" in ra) {
    rows.push({ label: "Engine", value: str(take("engine_version")), source: null });
  }
  used.add("cache_hits");
  used.add("cache_misses");
  used.add("n_configs_evaluated");

  // Anything the block carries that this list does not know still renders —
  // every stored assumption traces, none is hidden.
  for (const [key, value] of Object.entries(ra)) {
    if (!used.has(key)) rows.push({ label: key, value: str(value), source: null });
  }
  return rows;
}

/**
 * resultsTabView (3.13 prompt 4) — everything the Results tab renders, from
 * the CURRENT sizing result and its matching financial row via the same two
 * helpers the section and the bar use. Total: never throws; every stored gap
 * is an honest sentence, never an empty table or a zero.
 */
export function resultsTabView(job: unknown): ResultsTabView {
  const base = resultsView(job);
  const sizing = currentSizingResult(job);
  const fin = currentFinancialResult(job);
  const eo = asRecord(sizing?.evaluated_options);

  // ── The split ROI ──
  let split: ResultsTabView["split"] = null;
  let splitNote: string | null = null;
  if (base.state === "ready") {
    const s = asRecord(eo.split);
    const so = asRecord(s.solar_only);
    const bi = asRecord(s.battery_increment);
    if (base.runKind === "solar") {
      splitNote =
        "This is a solar-only run — there is no battery half to split out.";
    } else if (Object.keys(so).length === 0 || Object.keys(bi).length === 0) {
      splitNote =
        "This run was stored before the split was recorded, so the solar and battery halves cannot be shown separately.";
    } else {
      split = {
        solar: {
          savings: formatMoney(so.annual_savings),
          npv: formatMoney(so.npv_25yr),
          payback: formatYears(so.simple_payback_years),
          cost: formatMoney(so.system_cost),
        },
        battery: {
          savings: formatMoney(bi.annual_savings_vs_solar_only),
          npv: formatMoney(bi.incremental_npv),
          payback: formatYears(bi.incremental_payback_years),
          cost: formatMoney(bi.battery_cost),
        },
        whole: {
          savings: formatMoney(fin?.annual_savings),
          npv: formatMoney(fin?.npv_25_year),
          payback: formatYears(fin?.payback_years),
          cost: formatMoney(fin?.system_capex),
        },
      };
    }
  }

  // ── The itemised cost ──
  let cost: ResultsCostView | null = null;
  let costNote: string | null = null;
  if (base.state === "ready") {
    const bd = asRecord(eo.chosen_cost_breakdown);
    const rawLines = Array.isArray(bd.line_items) ? bd.line_items : null;
    const net = tariffNum(bd.net_cost);
    if (!rawLines || net === null) {
      costNote =
        "The itemised cost was not recorded for this run — re-run the sizing to capture it.";
    } else {
      const lines: ResultsCostLine[] = [];
      let sum = 0;
      let allPriced = true;
      for (const raw of rawLines) {
        const li = asRecord(raw);
        const amount = tariffNum(li.amount_aud);
        if (amount === null) allPriced = false;
        else sum += amount;
        lines.push({
          item: typeof li.item === "string" ? li.item : "—",
          detail: typeof li.detail === "string" ? li.detail : "",
          amount: amount === null ? "installer to confirm" : formatMoneyCents(amount),
          confirmed: amount !== null,
        });
      }
      const sumAgrees = !allPriced || Math.abs(sum - net) <= 0.01;
      cost = {
        lines,
        net: formatMoneyCents(net),
        sumAgrees,
        sumOfLines: !sumAgrees ? formatMoneyCents(sum) : null,
        allPriced,
        flags: Array.isArray(bd.flags)
          ? bd.flags.filter((f): f is string => typeof f === "string")
          : [],
      };
    }
  }

  // ── The assumptions ──
  let assumptions: ResultsAssumptionRow[] | null = null;
  let assumptionsNote: string | null = null;
  if (base.state !== "unsized") {
    const ra = sizing?.run_assumptions;
    if (typeof ra === "object" && ra !== null && !Array.isArray(ra)) {
      const panelsLine = cost?.lines.find((l) => l.item === "Panels") ?? null;
      const panelDetail = panelsLine?.detail
        ? panelsLine.detail.replace(/^\d+\s*×\s*/, "")
        : null;
      assumptions = assumptionRows(ra as Record<string, unknown>, panelDetail);
    } else {
      assumptionsNote =
        "The assumptions were not recorded for this run — runs made before 3.13 prompt 4 did not store them. Re-run the sizing to capture them.";
    }
  }

  return {
    state: base.state,
    headline: base.headline,
    // The SAME object resultsView built via the ONE derivation (U3).
    projected: base.projected,
    roofNotices: base.roofNotices,
    layoutLines: base.layoutLines,
    layoutNote: base.layoutNote,
    dispatchResolution: base.dispatchResolution,
    runKind: base.runKind,
    curve: scoreCurveView(job),
    showRoi: asObject(job).show_roi === true,
    roi: roiFigures(fin),
    split,
    splitNote,
    cost,
    costNote,
    assumptions,
    assumptionsNote,
  };
}

// ── The option comparison chart (3.13 prompt 4b, rebuilt as bars at 4d) ──────
//
// WHY BARS AND NOT A LINE (found on screen 2026-08-21): the battery options
// are DISCRETE PRODUCTS, not points on a continuum. The live fixture holds two
// different batteries at 12.8 kWh — a Sungrow SBR128 at +$2,344 and a BYD HVS
// at +$670 — so a connecting line joined two unrelated products and implied
// that value varies smoothly with capacity. There is no 13.1 kWh battery to
// buy. The solar options are the same shape: discrete cumulative roof
// configurations, ordered by size, not samples of a curve.

/** One evaluated option, as a bar. */
export interface ScoreCurveBar {
  /** Stable react key — the product id or the size. */
  key: string;
  /** THE PRODUCT, primary. Capacity alone cannot tell two products apart. */
  label: string;
  /** Capacity, beneath the product name. */
  subLabel: string | null;
  /** Set when the product name was not recorded — never a made-up label. */
  labelNote: string | null;
  value: number;
  valueLabel: string;
  chosen: boolean;
  /** The do-nothing option: rendered as the reference line, never as a bar. */
  isBaseline: boolean;
}

export interface ScoreCurveView {
  /** Never contains the baseline. null = no chart; `note` says why. */
  bars: ScoreCurveBar[] | null;
  /** The do-nothing option — the line every bar is read against. */
  baseline: ScoreCurveBar | null;
  baselineNote: string | null;
  note: string | null;
  /** What the value axis is showing — always the run's OWN objective metric. */
  valueLabel: string;
  unit: AxisUnit;
  objectiveLabel: string | null;
  /**
   * True ONLY when the measure is a delta against doing nothing, so zero is a
   * real centre and bars sit either side of it. False for durations and
   * percentages, where zero is an origin and not a centre — read from the
   * run's stored objective, never assumed to be NPV.
   */
  zeroCentred: boolean;
  /** Round axis intervals, or null when there is no chart. */
  ticks: number[] | null;
  chosenNote: string | null;
  flatNote: string | null;
}

export type AxisUnit = "aud" | "years" | "pct" | "score";

/**
 * An axis tick, at a precision a person reads. `3202.2155` on an axis is not a
 * number anyone reads: money is whole dollars with separators, abbreviated
 * DECIMAL-FREE above ten thousand ($12k, $1M). Junk yields an empty label
 * rather than a fabricated one. Never returns a decimal point.
 */
export function formatAxisTick(value: unknown, unit: AxisUnit = "aud"): string {
  const n = tariffNum(value);
  if (n === null) return "";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (unit === "years") return `${sign}${Math.round(abs)}`;
  if (unit === "pct") return `${sign}${Math.round(abs)}%`;
  // A blended score is 0..1; shown out of 100 so the axis carries whole
  // numbers a person reads, rather than 0.85 (a decimal) or 0·85 (a fudge).
  if (unit === "score") return `${sign}${Math.round(abs * 100)}`;
  if (abs >= 1_000_000) return `${sign}$${Math.round(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs).toLocaleString("en-AU")}`;
}

/**
 * Round axis intervals spanning the data — the 1 / 2 / 2.5 / 5 / 10 ladder, so
 * ticks land on numbers a person recognises and the domain is snapped outward
 * to them (recharts' own ticks land on values like 3202.2155). `includeZero`
 * forces the base into range for a delta measure.
 */
export function niceAxisTicks(
  min: number,
  max: number,
  includeZero = true,
  target = 5,
): number[] {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const scaled = raw / magnitude;
  const step =
    (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) *
    magnitude;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Guard the loop against a degenerate step; 200 is far more ticks than any
  // axis renders, so hitting it means the inputs were junk.
  for (let t = start, i = 0; t <= end + step / 1000 && i < 200; t += step, i++) {
    // Re-round each tick: floating point turns 0.1 steps into 0.30000000004.
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

interface ObjectiveMetric {
  label: string;
  solarKey: string;
  batteryKey: string;
  valueLabelSolar: string;
  valueLabelBattery: string;
  unit: AxisUnit;
  lowerIsBetter: boolean;
  /** Is zero a real CENTRE for this measure, or merely an origin? */
  zeroIsCentre: boolean;
}

const OBJECTIVE_METRICS: Record<string, ObjectiveMetric> = {
  max_npv: {
    label: "maximum NPV",
    solarKey: "npv_25yr",
    batteryKey: "incremental_npv",
    valueLabelSolar: "25-year NPV",
    valueLabelBattery: "Extra 25-year NPV vs no battery",
    unit: "aud",
    lowerIsBetter: false,
    // A delta against doing nothing: negative is meaningful, so zero centres.
    zeroIsCentre: true,
  },
  min_payback: {
    label: "shortest payback",
    solarKey: "simple_payback_years",
    batteryKey: "incremental_payback_years",
    valueLabelSolar: "Payback (years)",
    valueLabelBattery: "Payback on the extra spend (years)",
    unit: "years",
    lowerIsBetter: true,
    // A duration. Zero is its origin, not a centre — doing nothing has no
    // payback at all, so there is no zero line to read bars against.
    zeroIsCentre: false,
  },
  max_self_sufficiency: {
    label: "maximum self-sufficiency",
    solarKey: "self_sufficiency_pct",
    batteryKey: "self_sufficiency_pct",
    valueLabelSolar: "Self-sufficiency (%)",
    valueLabelBattery: "Self-sufficiency (%)",
    unit: "pct",
    lowerIsBetter: false,
    // An absolute share. Doing nothing already scores a real number, and the
    // reference line sits THERE, not at zero.
    zeroIsCentre: false,
  },
  custom: {
    label: "the custom blend",
    solarKey: "score",
    batteryKey: "score",
    valueLabelSolar: "Blended score",
    valueLabelBattery: "Blended score",
    unit: "score",
    lowerIsBetter: false,
    zeroIsCentre: false,
  },
};

/**
 * scoreCurveView (4b, rebuilt 4d) — the bars, derived HERE so the suite can
 * test them rather than reading them off a rendered chart. Total: never
 * throws; empty, single-option or junk data yields bars: null plus an honest
 * note, never an empty axis.
 */
/** The no-chart shape, with the one honest line that says why. */
function noCurve(note: string): ScoreCurveView {
  return {
    bars: null,
    baseline: null,
    baselineNote: null,
    note,
    valueLabel: "",
    unit: "aud",
    objectiveLabel: null,
    zeroCentred: false,
    ticks: null,
    chosenNote: null,
    flatNote: null,
  };
}

/**
 * 3.14 prompt 4 (2R.1) — THE ONE OPTION-SET BUILDER, over an options OBJECT.
 *
 * Both entry points below hand it a `{dimension_keys, points, chosen_index}`
 * object and the sizing row it came from: `scoreCurveView` passes the run's
 * own evaluated_options (unchanged in every respect), and `solarCurveView`
 * passes the ARRAY-SIZE options — which on a battery run live under
 * evaluated_options.solar_options (3.14 prompt 2). One implementation, two
 * doors; a second copy of this dispatch is what 2R.1 forbids.
 */
function curveFromOptions(
  options: Record<string, unknown>,
  sizing: Record<string, unknown>,
): ScoreCurveView {
  const dims = Array.isArray(options.dimension_keys)
    ? options.dimension_keys
    : null;
  const rawPoints = Array.isArray(options.points) ? options.points : null;
  if (!dims || !rawPoints) {
    return noCurve("The evaluated options were not recorded for this run.");
  }
  const isSolar = dims.length === 1 && dims[0] === "solar_kw";
  const isBattery = dims.length === 1 && dims[0] === "battery_id";
  if (!isSolar && !isBattery) {
    return noCurve(
      "The evaluated options were not recorded in a shape this chart knows.",
    );
  }
  const objective =
    typeof sizing.objective_used === "string" ? sizing.objective_used : null;
  const metric = objective ? OBJECTIVE_METRICS[objective] : undefined;
  if (!metric) {
    // An objective the code does not recognise: the values still draw, plainly
    // labelled, and NEVER with the zero-centred NPV treatment applied blind.
    const fallback = buildBars(rawPoints, isSolar, {
      label: null,
      solarKey: "score",
      batteryKey: "score",
      valueLabel: "Score the run was judged on",
      unit: "score",
      lowerIsBetter: false,
      zeroIsCentre: false,
    }, sizing, options);
    return fallback.bars
      ? fallback
      : noCurve("The objective this run was scored on was not recorded.");
  }
  return buildBars(rawPoints, isSolar, {
    label: metric.label,
    solarKey: metric.solarKey,
    batteryKey: metric.batteryKey,
    valueLabel: isSolar ? metric.valueLabelSolar : metric.valueLabelBattery,
    unit: metric.unit,
    lowerIsBetter: metric.lowerIsBetter,
    zeroIsCentre: metric.zeroIsCentre,
  }, sizing, options);
}

export function scoreCurveView(job: unknown): ScoreCurveView {
  const sizing = currentSizingResult(job);
  if (!sizing) return noCurve("This job has not been sized yet.");
  return curveFromOptions(asRecord(sizing.evaluated_options), sizing);
}

/** What the rail says when a run predates the stored array-size curve. */
export const SOLAR_CURVE_NOT_RECORDED =
  "This run did not record the array sizes it compared, so there is no curve to draw.";
/** ...and when it DID record the set, and the set was empty. */
export const SOLAR_CURVE_NO_OPTIONS =
  "This run recorded no array sizes to compare.";

/**
 * 3.14 prompt 4 — THE VALUE-VERSUS-SIZE CURVE, on BOTH kinds of run.
 *
 * A solar run's array-size options are its own top-level evaluated_options; a
 * battery run's are under solar_options, kept since 3.14 prompt 2 (F202). Both
 * go through curveFromOptions, so the rail and the Results tab draw with one
 * implementation.
 *
 * THE TWO SILENCES ARE KEPT APART: a run stored before the curve was kept says
 * it did not RECORD the options, while a run that recorded an empty set says
 * there were NONE. Never inferred from the other run, never backfilled.
 */
export function solarCurveView(job: unknown): ScoreCurveView {
  const sizing = currentSizingResult(job);
  if (!sizing) return noCurve("This job has not been sized yet.");
  const eo = asRecord(sizing.evaluated_options);
  const options =
    sizing.run_kind === "solar_battery" ? asRecord(eo.solar_options) : eo;
  if (!Array.isArray(options.points)) return noCurve(SOLAR_CURVE_NOT_RECORDED);
  if (options.points.length === 0) return noCurve(SOLAR_CURVE_NO_OPTIONS);
  // A kW curve or nothing: battery candidates under a kW axis would be a
  // plausible-looking chart of the wrong thing.
  const dims = Array.isArray(options.dimension_keys)
    ? options.dimension_keys
    : null;
  if (!dims || dims.length !== 1 || dims[0] !== "solar_kw") {
    return noCurve(SOLAR_CURVE_NOT_RECORDED);
  }
  return curveFromOptions(options, sizing);
}

/**
 * F188 — THE TIE SENTENCE, derived once and rendered in two places (the chart
 * caption and the Solar sizing options table). A second copy of this wording
 * anywhere is the drift this project deletes.
 *
 * On the first real time-of-use job the top three array sizes returned
 * $17,068.33, $17,062.34 and $17,039.91 — $28 apart across an array a quarter
 * larger — and one was marked "chosen" on a $6 margin with nothing on screen
 * saying the runner-up was within a rounding error.
 *
 * THE RULE: rank by the run's OWN measure, take the top three, and speak when
 * their spread is under one percent of the best value. FEWER THAN THREE
 * OPTIONS SAYS NOTHING — a tie claim needs a top three to compare. A best
 * value of zero says nothing either: every spread is infinite against zero.
 */
export const FLAT_OPTIONS_RATIO = 0.01;

export function flatOptionsNote(
  values: readonly number[],
  unit: AxisUnit,
  lowerIsBetter: boolean,
): string | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length < 3) return null;
  const ranked = [...finite].sort((a, b) => (lowerIsBetter ? a - b : b - a));
  const top = ranked.slice(0, 3);
  const spread = Math.max(...top) - Math.min(...top);
  const best = Math.abs(ranked[0]);
  if (best <= 0 || spread / best >= FLAT_OPTIONS_RATIO) return null;
  return (
    `The top options sit within ${formatAxisTick(spread, unit)} of ` +
    "each other — the choice among them is fine margin, not a cliff."
  );
}

function buildBars(
  rawPoints: unknown[],
  isSolar: boolean,
  spec: {
    label: string | null;
    solarKey: string;
    batteryKey: string;
    valueLabel: string;
    unit: AxisUnit;
    lowerIsBetter: boolean;
    zeroIsCentre: boolean;
  },
  sizing: Record<string, unknown>,
  eo: Record<string, unknown>,
): ScoreCurveView {
  const sizeKey = isSolar ? "solar_kw" : "usable_kwh";
  const valueKey = isSolar ? spec.solarKey : spec.batteryKey;

  const entries = rawPoints
    .map((p, index) => ({ raw: asRecord(p), index }))
    .map(({ raw, index }) => ({
      raw,
      index,
      size: tariffNum(raw[sizeKey]),
      value: tariffNum(raw[valueKey]),
    }))
    .filter((e) => e.size !== null)
    .sort((a, b) => (a.size as number) - (b.size as number));

  // THE BASELINE: doing nothing. Its size is zero by construction.
  const baselineEntry = entries.find((e) => e.size === 0) ?? null;
  const optionEntries = entries.filter((e) => e !== baselineEntry);

  const priced = optionEntries.filter((e) => e.value !== null);
  if (priced.length === 0) {
    return {
      bars: null,
      baseline: null,
      baselineNote: null,
      note:
        optionEntries.length === 0
          ? "The evaluated options were not recorded for this run."
          : "This run recorded no value for the measure it was scored on.",
      valueLabel: spec.valueLabel,
      unit: spec.unit,
      objectiveLabel: spec.label,
      zeroCentred: false,
      ticks: null,
      chosenNote: null,
      flatNote: null,
    };
  }

  // ── The chosen option ──
  let chosenIndex: number | null = null;
  let chosenNote: string | null = null;
  if (isSolar) {
    const idx = eo.chosen_index;
    if (typeof idx === "number" && Number.isInteger(idx) && rawPoints[idx]) {
      const chosenRaw = asRecord(rawPoints[idx]);
      const hit = priced.find((e) => e.raw === chosenRaw);
      chosenIndex = hit ? hit.index : null;
    }
    if (chosenIndex === null) {
      chosenNote =
        "This run did not record which option it chose, so none is marked.";
    }
  } else {
    const rowKwh = tariffNum(sizing.battery_kwh);
    const rowCost = tariffNum(sizing.system_cost);
    const matches = priced.filter(
      (e) =>
        rowKwh !== null &&
        rowCost !== null &&
        tariffNum(e.raw.usable_kwh) === rowKwh &&
        tariffNum(e.raw.system_cost) === rowCost,
    );
    if (matches.length === 1) {
      chosenIndex = matches[0].index;
    } else {
      chosenNote =
        matches.length > 1
          ? "Two options tie on capacity and cost, so no single chosen option can be marked."
          : "This run's chosen option could not be matched to an evaluated option, so none is marked.";
    }
  }

  const toBar = (
    e: { raw: Record<string, unknown>; index: number; size: number | null; value: number | null },
    isBaseline: boolean,
  ): ScoreCurveBar => {
    const model = typeof e.raw.model === "string" ? e.raw.model.trim() : "";
    const sizeLabel = isSolar
      ? formatKw(e.size)
      : formatKwh(e.size);
    // The PRODUCT identifies the bar; capacity is the second line. Where no
    // product name was recorded the capacity carries the bar and says so —
    // never an invented name.
    const named = !isSolar && model !== "" && model.toLowerCase() !== "no battery";
    // THE BASELINE IS NAMED FOR WHAT IT IS. "0 kWh" as the label on the
    // reference line tells a reader nothing; "No battery" is the option they
    // are actually comparing against. The engine's own word is used when it
    // recorded one.
    const baselineLabel = isSolar ? "No solar" : model !== "" ? model : "No battery";
    return {
      key: `${e.index}`,
      label: isBaseline ? baselineLabel : named ? model : sizeLabel,
      subLabel: named ? sizeLabel : null,
      labelNote:
        !isSolar && !named && !isBaseline
          ? "the product was not recorded for this option"
          : null,
      value: e.value ?? 0,
      valueLabel: formatAxisTick(e.value, spec.unit),
      chosen: chosenIndex !== null && e.index === chosenIndex,
      isBaseline,
    };
  };

  const bars = priced.map((e) => toBar(e, false));
  // THE CATEGORY AXIS KEYS BARS BY THEIR LABEL, and the tooltip shows that
  // same string, so two options must never share one. Product names are
  // unique in the catalogue; two options with NO product name at the same
  // capacity would otherwise collapse into one category. Numbering them is
  // honest — they are genuinely different options — where merging is not.
  const labelCounts = new Map<string, number>();
  for (const bar of bars) {
    const n = (labelCounts.get(bar.label) ?? 0) + 1;
    labelCounts.set(bar.label, n);
    if (n > 1) bar.label = `${bar.label} (${n})`;
  }
  const baseline = baselineEntry ? toBar(baselineEntry, true) : null;
  const baselineValue = baselineEntry?.value ?? null;

  // WHERE THE REFERENCE LINE SITS, and whether zero is a centre — from the
  // measure, never assumed. A delta measure centres on zero (the baseline is
  // zero by construction). An absolute measure references the baseline's own
  // value, and a measure the baseline cannot have (a payback for doing
  // nothing) has no reference line at all.
  const zeroCentred = spec.zeroIsCentre && baselineValue === 0;
  let baselineNote: string | null = null;
  if (baseline && baselineValue === null) {
    baselineNote = isSolar
      ? "Doing nothing has no payback, so there is no line to read these against."
      : "Doing nothing has no payback, so there is no line to read these against.";
  } else if (baseline && !zeroCentred && baselineValue !== null) {
    baselineNote = `The line is ${baseline.label} — ${formatAxisTick(baselineValue, spec.unit)}.`;
  }

  const values = bars.map((b) => b.value);
  const lo = Math.min(...values, zeroCentred ? 0 : Math.min(...values));
  const hi = Math.max(...values, zeroCentred ? 0 : Math.max(...values));
  const ticks = niceAxisTicks(
    baselineValue !== null && !zeroCentred ? Math.min(lo, baselineValue) : lo,
    baselineValue !== null && !zeroCentred ? Math.max(hi, baselineValue) : hi,
    zeroCentred,
  );

  // BE HONEST ABOUT FLATNESS (F188) — ONE derivation, used by the chart and
  // by the Solar sizing options table.
  const flatNote = flatOptionsNote(
    bars.map((b) => b.value),
    spec.unit,
    spec.lowerIsBetter,
  );

  return {
    bars,
    baseline,
    baselineNote,
    note: null,
    valueLabel: spec.valueLabel,
    unit: spec.unit,
    objectiveLabel: spec.label,
    zeroCentred,
    ticks,
    chosenNote,
    flatNote,
  };
}


// ── The chart's own space requirement (3.13 prompt 4e) ──────────────────────
//
// THE FAULT THIS EXISTS TO FIX, found on screen 2026-08-21: the category axis
// carried a HARDCODED 172px, so "Sigenergy SigenStor Sigen Battery 8.0"
// rendered as "gy SigenStor Sigen Battery 8.0" and "BYD Battery-Box Premium
// HVS 12.8" as "attery-Box Premium HVS 12.8" — silently sliced by the axis
// edge, with the reference label clipped at the top of the plot area.
//
// A chart dispatches its own size from an effect, so no static render emits a
// laid-out SVG and NO TEST CAN SEE A CLIPPED LABEL. The answer is not a better
// guess at a margin: it is to make the requirement a FUNCTION OF THE LABELS,
// computed here, where the suite can assert on it. A longer product name next
// month widens the axis without anyone touching the component.

export const SCORE_CURVE_AXIS = {
  /** The product line, matching the tick's own fontSize. */
  fontSize: 12,
  /** The capacity line beneath it. */
  subFontSize: 11,
  /**
   * Average glyph width as a fraction of font size. Inter's mixed-case
   * average sits near 0.55; 0.58 is deliberately generous, because the cost
   * of over-reserving is a little white space and the cost of
   * under-reserving is the sliced label this replaces.
   */
  charWidth: 0.58,
  /** Gap between the tick text and the plot area. */
  gap: 12,
  minWidth: 96,
  /**
   * The Results tab is max-w-5xl (1024px) less its px-8 padding. The chart is
   * responsive, so this is the width the CAP is reasoned against — callers
   * that know better may pass their own.
   */
  assumedChartWidth: 960,
  /** No axis may eat more than this share of the chart. */
  maxFraction: 0.42,
  /** Line height for the reference-line label above the plot area. */
  referenceLineHeight: 1.7,
  /** Top margin when there is no reference label to clear. */
  minTopSpace: 8,
} as const;

export interface ScoreCurveAxisSpace {
  /** Pixels the category axis needs for its labels. Never zero or negative. */
  axisWidth: number;
  /** Pixels above the plot area so the reference label is never clipped. */
  topSpace: number;
  /** Characters the product line may show before it must be truncated. */
  maxChars: number;
}

/** One label pair — the product line and the capacity line beneath it. */
export interface ScoreCurveLabelled {
  label: string;
  subLabel?: string | null;
}

/**
 * The space the axis needs, DERIVED FROM THE LABELS THEMSELVES. Pure and
 * total: junk in yields the floor, never a zero, negative or NaN width.
 */
export function scoreCurveAxisSpace(
  bars: readonly ScoreCurveLabelled[] | null | undefined,
  baselineLabel?: string | null,
  chartWidth: number = SCORE_CURVE_AXIS.assumedChartWidth,
): ScoreCurveAxisSpace {
  const {
    fontSize, subFontSize, charWidth, gap, minWidth, maxFraction,
    referenceLineHeight, minTopSpace, assumedChartWidth,
  } = SCORE_CURVE_AXIS;
  const usableWidth =
    typeof chartWidth === "number" && Number.isFinite(chartWidth) && chartWidth > 0
      ? chartWidth
      : assumedChartWidth;
  const cap = Math.max(minWidth, Math.floor(usableWidth * maxFraction));

  const rows = Array.isArray(bars) ? bars : [];
  let widest = 0;
  for (const row of rows) {
    const label = typeof row?.label === "string" ? row.label.trim() : "";
    const sub = typeof row?.subLabel === "string" ? row.subLabel.trim() : "";
    widest = Math.max(
      widest,
      label.length * fontSize * charWidth,
      sub.length * subFontSize * charWidth,
    );
  }

  const axisWidth = Math.min(cap, Math.max(minWidth, Math.ceil(widest) + gap));
  // What FITS at the cap — the truncation budget. Never below 4, so a
  // truncated label always has a character or two before its ellipsis.
  const maxChars = Math.max(
    4,
    Math.floor((cap - gap) / (fontSize * charWidth)),
  );
  const hasBaselineLabel =
    typeof baselineLabel === "string" && baselineLabel.trim() !== "";
  const topSpace = hasBaselineLabel
    ? Math.ceil(subFontSize * referenceLineHeight)
    : minTopSpace;

  return { axisWidth, topSpace, maxChars };
}

/**
 * A label trimmed to fit, ending in a real ellipsis. A label that says "…" is
 * honest about being shortened; one silently sliced by an overflow is not,
 * and that is the fault 4e fixes. The FULL string still reaches the tooltip.
 */
export function truncateLabel(label: unknown, maxChars: number): string {
  const text = typeof label === "string" ? label : "";
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars >= 2
      ? Math.floor(maxChars)
      : 2;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}\u2026`;
}

// ── The return-on-investment toggle (checklist 3.13 prompt 4c, D34) ─────────

/**
 * THE THREE EXPLANATIONS, ONE STRING EACH, EXPORTED — the Results tab shows
 * them in a HoverHelp and 8.1 prints the SAME words beneath each figure in
 * the customer report, because nobody hovers over a PDF. Two separate strings
 * would drift within a month, and the report is the artifact that leaves the
 * building. Each says what the figure means AND what it ignores.
 */
export const ROI_EXPLANATIONS = {
  annual:
    "This year's savings divided by the system's net cost. It ignores panel " +
    "degradation and rising prices — every later year is assumed to look " +
    "like this one.",
  discounted:
    "The 25-year net present value divided by the net cost. Future dollars " +
    "are counted as worth less than today's — this is the figure the " +
    "sizing itself optimises.",
  total:
    "Every year's real savings added up with no discounting, minus the net " +
    "cost, divided by the net cost. It is the largest of the three and says " +
    "the least — a longer analysis period inflates it without the system " +
    "being any better.",
} as const;

export interface RoiFigure {
  key: "annual" | "discounted" | "total";
  label: string;
  /** null = unavailable — capex missing/zero/negative, or the input figure
      null. NEVER a division by zero, an infinity, or a guessed stand-in
      (annual_savings x 25 is the figure D34 rejected). */
  value: string | null;
  explanation: string;
}

/**
 * The three D34 figures, ALWAYS all three, in this order — annual,
 * discounted, total: smallest first, so the page does not open on its
 * biggest number. There is deliberately NO parameter to select a subset:
 * every installer would pick the biggest, and the platform must not build
 * that lever.
 */
export function roiFigures(
  fin: Record<string, unknown> | null,
): [RoiFigure, RoiFigure, RoiFigure] {
  const capex = fin ? tariffNum(fin.system_capex) : null;
  const usable = capex !== null && capex > 0;
  const pct = (numerator: number | null): string | null =>
    usable && numerator !== null
      ? formatPct(Math.round((numerator / (capex as number)) * 100))
      : null;
  const savings = fin ? tariffNum(fin.annual_savings) : null;
  const npv = fin ? tariffNum(fin.npv_25_year) : null;
  const undiscounted = fin ? tariffNum(fin.undiscounted_savings_25yr) : null;
  return [
    {
      key: "annual",
      label: "Annual return on cost",
      value: pct(savings),
      explanation: ROI_EXPLANATIONS.annual,
    },
    {
      key: "discounted",
      label: "Discounted return",
      value: pct(npv),
      explanation: ROI_EXPLANATIONS.discounted,
    },
    {
      key: "total",
      label: "Total 25-year return",
      value:
        usable && undiscounted !== null
          ? formatPct(
              Math.round(
                ((undiscounted - (capex as number)) / (capex as number)) * 100,
              ),
            )
          : null,
      explanation: ROI_EXPLANATIONS.total,
    },
  ];
}


// ── The live results rail (checklist 3.14 prompt 6, D37) ─────────────────────
//
// THE RAIL ANSWERS "WHAT DID THAT CHANGE DO". Two paths, two different kinds
// of thing, and the rail never confuses them:
//
//   INSTANT — an objective or budget-cap save. The stored run evaluated every
//   option and stored each one's own 25-year value, payback, self-sufficiency
//   and cost, so re-ranking against a new objective or re-filtering against a
//   new cap is arithmetic over data already on the job. Exact, no request.
//
//   A RE-COST — a save that changes the physics (roof, site, load, tariff).
//   The endpoint is asked for THIS system under the new inputs: persist
//   false, compare_to_unconstrained false, constraints pinning the stored
//   run's own array and battery. Full-year resolution (D35), ~9 s (prompt 5).
//
// THE RAIL NEVER RE-SEARCHES. It never asks whether a different system is
// better — the Size buttons do that. Nothing it computes is saved, so the
// LABEL on screen is the only thing that can say where a figure came from.
// Everything below is pure, so the suite asserts on every state; the
// component only renders.

/** What kind of change a section announced when it saved. */
export type SizingInputChangeKind =
  /** The engine's objective, blend weight or budget cap — INSTANT. */
  | "objective-budget"
  /** Anything the engine re-costs from scratch: roof, site, load, tariff. */
  | "physics";

export interface SizingInputChange {
  kind: SizingInputChangeKind;
  /** Which section announced it — for the label, never for logic. */
  section: string;
  /** The objective the save left stored (objective-budget only). */
  objective?: string | null;
  /** The blend weight, for a custom objective (objective-budget only). */
  customWeight?: number | null;
  /** The cap the save left stored; null = no cap (objective-budget only). */
  budgetAud?: number | null;
  /** Monotonic, so a second identical save still announces. */
  seq: number;
}

/** What a SECTION announces on a persisted save — the body adds `section`
    and `seq`. A section that is unsure whether the engine reads what it
    saved stays silent: the rail then shows the stored run, honestly labelled. */
export type SizingInputSave = Omit<SizingInputChange, "seq" | "section">;

/** The five tiles, as numbers — null where the run does not carry one. */
export interface RailFigures {
  solarKw: number | null;
  batteryKwh: number | null;
  paybackYears: number | null;
  npv: number | null;
  selfSufficiencyPct: number | null;
  /** "whole-system" is the figure the bar always showed; "solar-only" is
      what a re-rank can honestly state once the array has moved. */
  basis: "whole-system" | "solar-only";
}

export interface RailDelta {
  label: string;
  before: string;
  after: string;
  /** "+$1,204" / "−0.3 yr" / "no change" — the change between them. */
  change: string;
  direction: "up" | "down" | "none";
}

/** Where the new figures came from — the ONLY carrier, since nothing is saved. */
export interface RailProvenance {
  engineMode: string | null;
  /** The battery response's own word ("full_year"); null on a solar-only
      run, which performs no dispatch (F191). */
  resolution: string | null;
  label: string;
}

export const RAIL_NOT_SAVED = "Not saved — press Size to commit.";

/**
 * THE BASELINE the rail recomputes against — the STORED run, read once from
 * the job into a serialisable shape the client component can hold.
 */
export interface RailBaseline {
  /** The current sizing row's id: a new row means a new baseline, and any
      client-side recompute belongs to the old one and is dropped. */
  sizingResultId: string | null;
  runKind: "solar" | "solar_battery" | null;
  figures: RailFigures;
  /** The stored solar-only parts (split.solar_only on a battery run, the
      chosen point on a solar run) — what a moved-array re-rank compares. */
  solarOnly: { npv: number | null; paybackYears: number | null;
               annualSavings: number | null; selfSufficiencyPct: number | null;
               systemCost: number | null };
  chosen: {
    solarKw: number | null;
    planeIndices: number[] | null;
    panelsPerPlane: number[] | null;
    batteryId: string | null;
    batteryKwh: number | null;
    batteryModel: string | null;
  };
  /** The stored ARRAY-SIZE options (solar_options on a battery run). */
  solarPoints: Record<string, unknown>[] | null;
  solarChosenIndex: number | null;
  /** The stored BATTERY candidates (battery runs only). */
  batteryPoints: Record<string, unknown>[] | null;
  batteryChosenIndex: number | null;
  objective: string | null;
  budgetAud: number | null;
  /** The endpoint that produced the run — the one a re-cost asks. */
  endpoint: "/api/sizing/battery" | "/api/sizing/optimise" | null;
}

function railIndex(container: Record<string, unknown>, points: unknown[]): number | null {
  const idx = container.chosen_index;
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < points.length
    ? idx
    : null;
}

export function railBaselineView(job: unknown): RailBaseline {
  const bar = resultsBarView(job);
  const sizing = currentSizingResult(job);
  const eo = asRecord(sizing?.evaluated_options);
  const runKind =
    sizing?.run_kind === "solar" || sizing?.run_kind === "solar_battery"
      ? sizing.run_kind
      : null;
  const isBattery = runKind === "solar_battery";
  const solarContainer = isBattery ? asRecord(eo.solar_options) : eo;
  const solarPoints = Array.isArray(solarContainer.points)
    ? solarContainer.points.map((p) => asRecord(p))
    : null;
  const solarChosenIndex = solarPoints ? railIndex(solarContainer, solarPoints) : null;
  const batteryPoints = isBattery && Array.isArray(eo.points)
    ? eo.points.map((p) => asRecord(p))
    : null;
  const batteryChosenIndex = batteryPoints ? railIndex(eo, batteryPoints) : null;
  const chosenBattery = batteryPoints && batteryChosenIndex !== null
    ? batteryPoints[batteryChosenIndex]
    : null;
  const chosenSolarPoint = solarPoints && solarChosenIndex !== null
    ? solarPoints[solarChosenIndex]
    : null;
  const cs = isBattery ? asRecord(eo.chosen_solar) : chosenSolarPoint ?? {};
  const so = isBattery
    ? asRecord(asRecord(eo.split).solar_only)
    : chosenSolarPoint ?? {};
  const detail = asObject(job);
  return {
    sizingResultId:
      typeof sizing?.sizing_result_id === "string" ? sizing.sizing_result_id : null,
    runKind,
    figures: bar.sized
      ? {
          solarKw: bar.solarKw,
          batteryKwh: bar.batteryKwh,
          paybackYears: bar.paybackYears,
          npv: bar.npv,
          selfSufficiencyPct: bar.selfSufficiencyPct,
          basis: "whole-system",
        }
      : { solarKw: null, batteryKwh: null, paybackYears: null, npv: null,
          selfSufficiencyPct: null, basis: "whole-system" },
    solarOnly: {
      npv: tariffNum(so.npv_25yr),
      paybackYears: tariffNum(so.simple_payback_years),
      annualSavings: tariffNum(so.annual_savings),
      selfSufficiencyPct: tariffNum(chosenSolarPoint?.self_sufficiency_pct),
      systemCost: tariffNum(so.system_cost),
    },
    chosen: {
      solarKw: tariffNum(sizing?.solar_kw),
      planeIndices: Array.isArray(cs.plane_indices)
        ? cs.plane_indices.filter((i): i is number => typeof i === "number")
        : null,
      panelsPerPlane: Array.isArray(cs.panels_per_plane)
        ? cs.panels_per_plane.filter((i): i is number => typeof i === "number")
        : null,
      batteryId:
        typeof chosenBattery?.battery_id === "string" ? chosenBattery.battery_id : null,
      batteryKwh: tariffNum(sizing?.battery_kwh),
      batteryModel:
        typeof chosenBattery?.model === "string" ? chosenBattery.model : null,
    },
    solarPoints,
    solarChosenIndex,
    batteryPoints,
    batteryChosenIndex,
    objective:
      typeof detail.objective === "string" && detail.objective ? detail.objective : null,
    budgetAud: (() => {
      const b = tariffNum(detail.budget_aud);
      return b !== null && b > 0 ? b : null;
    })(),
    endpoint:
      runKind === "solar_battery"
        ? "/api/sizing/battery"
        : runKind === "solar"
          ? "/api/sizing/optimise"
          : null,
  };
}

/**
 * THE REQUEST BUILDER — pure, so the suite can hold its key set against the
 * declared constants. Pins the STORED run's own system: the array by kW
 * (fix_solar_kwp) and the battery by id; a stored no-battery outcome pins
 * force_no_battery rather than inventing an id. Returns null when there is
 * nothing to pin — the rail then says so rather than searching.
 */
export function railRecostRequest(
  baseline: RailBaseline,
  jobId: string,
): Record<string, unknown> | null {
  if (baseline.endpoint === null || baseline.chosen.solarKw === null) return null;
  const constraints: Record<string, unknown> = {
    fix_solar_kwp: baseline.chosen.solarKw,
  };
  if (baseline.runKind === "solar_battery") {
    if (baseline.chosen.batteryId) {
      constraints.battery_ids = [baseline.chosen.batteryId];
    } else if (baseline.chosen.batteryKwh === 0) {
      constraints.force_no_battery = true;
    } else {
      return null; // a battery run with no identifiable battery cannot be pinned
    }
  }
  return {
    job_id: jobId,
    constraints,
    persist: false,
    compare_to_unconstrained: false,
  };
}

/** The declared key set for the endpoint a baseline would call. */
export function railRequestKeysFor(baseline: RailBaseline): readonly string[] {
  return baseline.runKind === "solar_battery"
    ? BATTERY_SIZING_REQUEST_KEYS
    : SOLAR_SIZING_REQUEST_KEYS;
}

// ── The state the bar renders ───────────────────────────────────────────────

export type RailState =
  /** The stored run's figures, labelled as stored. */
  | { kind: "stored" }
  /** Re-ranked INSTANTLY from the stored options — no request was made. */
  | {
      kind: "reranked";
      trigger: SizingInputChange;
      before: RailFigures;
      after: RailFigures;
      deltas: RailDelta[];
      arrayMoved: boolean;
      batteryStale: boolean;
      note: string;
      notSaved: string;
    }
  /** The instant path could not answer — and says why, rather than
      re-costing and calling it instant. */
  | { kind: "rerank-unavailable"; trigger: SizingInputChange; reason: string }
  /** A re-cost is in flight — the RunProgress indicator, reused. */
  | { kind: "recosting"; trigger: SizingInputChange; startedAt: number }
  /** A re-cost answered: before, after, the change, and its provenance. */
  | {
      kind: "recosted";
      trigger: SizingInputChange;
      before: RailFigures;
      after: RailFigures;
      deltas: RailDelta[];
      provenance: RailProvenance;
      notSaved: string;
    }
  /** A re-cost did not complete — the stored figures stand, and it says so. */
  | { kind: "failed"; trigger: SizingInputChange; reason: string; canRetry: boolean };

export const RAIL_STATE_KINDS = [
  "stored", "reranked", "rerank-unavailable", "recosting", "recosted", "failed",
] as const;

function railChange(
  label: string,
  before: number | null,
  after: number | null,
  fmt: (v: unknown) => string,
  unit: "aud" | "years" | "pct" | "kw" | "kwh",
): RailDelta {
  const none: RailDelta = {
    label, before: fmt(before), after: fmt(after), change: "no change", direction: "none",
  };
  if (before === null || after === null) {
    return { ...none, change: before === after ? "no change" : "—" };
  }
  const diff = Math.round((after - before) * 100) / 100;
  if (diff === 0) return none;
  const sign = diff > 0 ? "+" : "−";
  const abs = Math.abs(diff);
  const body =
    unit === "aud" ? `$${Math.round(abs).toLocaleString("en-AU")}`
    : unit === "years" ? `${abs} yr`
    : unit === "pct" ? `${abs} pts`
    : unit === "kw" ? `${abs} kW`
    : `${abs} kWh`;
  return {
    label, before: fmt(before), after: fmt(after),
    change: `${sign}${body}`, direction: diff > 0 ? "up" : "down",
  };
}

export function railDeltas(before: RailFigures, after: RailFigures): RailDelta[] {
  return [
    railChange("Solar", before.solarKw, after.solarKw, formatKw, "kw"),
    railChange("Battery", before.batteryKwh, after.batteryKwh, formatKwh, "kwh"),
    railChange("Payback", before.paybackYears, after.paybackYears, formatYears, "years"),
    railChange("NPV", before.npv, after.npv, formatMoney, "aud"),
    railChange("Self-sufficiency", before.selfSufficiencyPct, after.selfSufficiencyPct, formatPct, "pct"),
  ];
}

// ── The instant path ────────────────────────────────────────────────────────

/** The engine's own ranking rule for the ARRAY options (solar_optimiser):
    max_npv → npv_25yr; min_payback → shortest payback, no payback worst;
    max_self_sufficiency → self_sufficiency_pct. A custom blend was scored
    with the OLD weight and cannot be re-ranked here. */
function solarScore(point: Record<string, unknown>, objective: string): number | null {
  if (objective === "max_npv") return tariffNum(point.npv_25yr);
  if (objective === "max_self_sufficiency") return tariffNum(point.self_sufficiency_pct);
  if (objective === "min_payback") {
    const pb = tariffNum(point.simple_payback_years);
    return pb === null ? -1e18 : -pb;
  }
  return null;
}

/** The engine's own rule for the BATTERY candidates (battery_optimiser),
    over a pool already filtered by the cap. */
function pickBattery(
  pool: Record<string, unknown>[],
  objective: string,
  noBattery: Record<string, unknown>,
): Record<string, unknown> | null {
  if (pool.length === 0) return null;
  if (objective === "max_npv") {
    return pool.reduce((best, c) =>
      (tariffNum(c.incremental_npv) ?? -Infinity) > (tariffNum(best.incremental_npv) ?? -Infinity) ? c : best);
  }
  if (objective === "max_self_sufficiency") {
    return pool.reduce((best, c) =>
      (tariffNum(c.self_sufficiency_pct) ?? -Infinity) > (tariffNum(best.self_sufficiency_pct) ?? -Infinity) ? c : best);
  }
  if (objective === "min_payback") {
    const viable = pool.filter(
      (c) => (tariffNum(c.usable_kwh) ?? 0) > 0
        && (tariffNum(c.incremental_npv) ?? 0) > 0
        && tariffNum(c.incremental_payback_years) !== null,
    );
    if (viable.length === 0) return noBattery;
    return viable.reduce((best, c) =>
      (tariffNum(c.incremental_payback_years) as number) < (tariffNum(best.incremental_payback_years) as number) ? c : best);
  }
  return null;
}

/**
 * RE-RANK from the stored options — no request, no solving (D37 clauses 1-3).
 *
 * THE CAVEAT THAT KEEPS IT HONEST: sizing is SEQUENTIAL. The objective chose
 * the array first and the battery was solved around THAT array. So:
 *   - the array does not move: the battery candidates are comparable, and
 *     a new cap or objective may pick a different one — exact, stored;
 *   - the array MOVES: the new array's own stored SOLAR-ONLY figures are
 *     shown (exact), and the battery figures are marked as belonging to the
 *     previous array, needing a full Size. They are never re-ranked.
 */
export function railRerank(
  baseline: RailBaseline,
  change: SizingInputChange,
): RailState {
  const objective = change.objective ?? baseline.objective ?? "max_npv";
  const budget =
    change.budgetAud === undefined ? baseline.budgetAud : change.budgetAud;
  const unavailable = (reason: string): RailState =>
    ({ kind: "rerank-unavailable", trigger: change, reason });
  if (!baseline.solarPoints || baseline.solarPoints.length === 0) {
    return unavailable(
      "This run did not record the options it compared, so the change cannot be answered from stored data — press Size to run it.",
    );
  }
  if (objective === "custom") {
    return unavailable(
      "A custom blend scores the options with its weight, which the stored run used a different value for — press Size to run it.",
    );
  }
  if (!VALID_OBJECTIVES.includes(objective as (typeof VALID_OBJECTIVES)[number])) {
    return unavailable(`The objective ${JSON.stringify(objective)} is not one the engine ranks by.`);
  }
  const real = baseline.solarPoints.filter((p) => (tariffNum(p.solar_kw) ?? 0) > 0);
  const inBudget = budget === null
    ? real
    : real.filter((p) => (tariffNum(p.system_cost) ?? Infinity) <= budget);
  if (inBudget.length === 0) {
    return unavailable(
      "No stored array fits the new budget cap; the engine's answer under it needs a full Size.",
    );
  }
  let top: Record<string, unknown> | null = null;
  let topScore = -Infinity;
  for (const p of inBudget) {
    const s = solarScore(p, objective);
    if (s !== null && s > topScore) { top = p; topScore = s; }
  }
  if (!top) {
    return unavailable("The stored options carry no value for that objective.");
  }
  const topKw = tariffNum(top.solar_kw);
  const sameKw = topKw !== null && topKw === baseline.chosen.solarKw;
  const sameLayout =
    !Array.isArray(top.panels_per_plane) || baseline.chosen.panelsPerPlane === null
      ? sameKw
      : JSON.stringify(top.panels_per_plane) === JSON.stringify(baseline.chosen.panelsPerPlane);
  const arrayMoved = !(sameKw && sameLayout);
  const before = baseline.figures;
  const notSaved = RAIL_NOT_SAVED;

  if (arrayMoved) {
    // The new array's OWN stored figures — solar only, exactly as stored.
    const solarBefore: RailFigures = {
      solarKw: baseline.chosen.solarKw,
      batteryKwh: null,
      paybackYears: baseline.solarOnly.paybackYears,
      npv: baseline.solarOnly.npv,
      selfSufficiencyPct: baseline.solarOnly.selfSufficiencyPct,
      basis: "solar-only",
    };
    const after: RailFigures = {
      solarKw: topKw,
      batteryKwh: null,
      paybackYears: tariffNum(top.simple_payback_years),
      npv: tariffNum(top.npv_25yr),
      selfSufficiencyPct: tariffNum(top.self_sufficiency_pct),
      basis: "solar-only",
    };
    const isBattery = baseline.runKind === "solar_battery";
    return {
      kind: "reranked",
      trigger: change,
      before: solarBefore,
      after,
      deltas: railDeltas(solarBefore, after),
      arrayMoved: true,
      batteryStale: isBattery,
      note: isBattery
        ? `Under this objective the top array is ${formatKw(topKw)} rather than ${formatKw(baseline.chosen.solarKw)}. Its solar figures are the run's own, exact; the battery figures still belong to the ${formatKw(baseline.chosen.solarKw)} array and need a full Size to resolve.`
        : `Under this objective the top array is ${formatKw(topKw)} rather than ${formatKw(baseline.chosen.solarKw)} — the run's own stored figures for it.`,
      notSaved,
    };
  }

  // The array stands. On a battery run the candidates are comparable — re-filter
  // and re-rank them; on a solar run nothing moves at all.
  if (baseline.runKind !== "solar_battery" || !baseline.batteryPoints) {
    return {
      kind: "reranked", trigger: change, before, after: before,
      deltas: railDeltas(before, before), arrayMoved: false, batteryStale: false,
      note: "That change moves nothing — the stored run is still the answer.",
      notSaved,
    };
  }
  const noBattery = baseline.batteryPoints.find((c) => tariffNum(c.usable_kwh) === 0) ?? null;
  const pool0 = budget === null
    ? baseline.batteryPoints
    : baseline.batteryPoints.filter((c) => (tariffNum(c.system_cost) ?? Infinity) <= budget);
  const pool = pool0.length > 0 ? pool0 : noBattery ? [noBattery] : [];
  const pick = noBattery ? pickBattery(pool, objective, noBattery) : null;
  if (!pick) {
    return unavailable("The stored battery candidates cannot be re-ranked for that objective.");
  }
  const pickId = typeof pick.battery_id === "string" ? pick.battery_id : null;
  const sameBattery =
    pickId === baseline.chosen.batteryId
    && tariffNum(pick.usable_kwh) === baseline.chosen.batteryKwh;
  if (sameBattery) {
    return {
      kind: "reranked", trigger: change, before, after: before,
      deltas: railDeltas(before, before), arrayMoved: false, batteryStale: false,
      note: "That change moves nothing — the stored run is still the answer.",
      notSaved,
    };
  }
  // A different battery, solved around the SAME array: compose the whole
  // exactly as the route does (solar part + increment), from stored parts.
  const incSav = tariffNum(pick.annual_savings_vs_solar_only);
  const incNpv = tariffNum(pick.incremental_npv);
  const wholeSav = baseline.solarOnly.annualSavings !== null && incSav !== null
    ? Math.round((baseline.solarOnly.annualSavings + incSav) * 100) / 100 : null;
  const wholeNpv = baseline.solarOnly.npv !== null && incNpv !== null
    ? Math.round((baseline.solarOnly.npv + incNpv) * 100) / 100 : null;
  const cost = tariffNum(pick.system_cost);
  const after: RailFigures = {
    solarKw: baseline.chosen.solarKw,
    batteryKwh: tariffNum(pick.usable_kwh),
    paybackYears: cost !== null && wholeSav !== null && wholeSav > 0
      ? Math.round((cost / wholeSav) * 100) / 100 : null,
    npv: wholeNpv,
    selfSufficiencyPct: tariffNum(pick.self_sufficiency_pct),
    basis: "whole-system",
  };
  const model = typeof pick.model === "string" ? pick.model : "a different battery";
  return {
    kind: "reranked", trigger: change, before, after,
    deltas: railDeltas(before, after), arrayMoved: false, batteryStale: false,
    note: `Under this change the top battery is ${model} (${formatKwh(after.batteryKwh)}) around the same ${formatKw(baseline.chosen.solarKw)} array — the run's own stored figures for it.`,
    notSaved,
  };
}

// ── The re-cost path ────────────────────────────────────────────────────────

export const RAIL_DECLINE_FLAG = "unconstrained_comparison_not_run_by_request";

/**
 * A re-cost RESPONSE → the rail state. Trusts nothing it cannot check:
 *   - an error body, or no figures → failed, with the engine's own words;
 *   - the decline flag present AND constraint deltas present → contradictory,
 *     failed, trust neither;
 *   - the answer is not the pinned system (a different array, a different or
 *     missing battery) → failed: the engine substituted, which a re-cost must
 *     never present as its own answer;
 *   - otherwise: before/after, the change, and WHERE the figures came from.
 */
export function railRecostState(
  baseline: RailBaseline,
  change: SizingInputChange,
  response: unknown,
): RailState {
  const body = asRecord(response);
  const failed = (reason: string): RailState =>
    ({ kind: "failed", trigger: change, reason, canRetry: true });
  if (typeof body.error === "string" && body.error) return failed(body.error);
  if (body.needs_roof_input === true) {
    return failed("The engine has no usable roof to re-cost on.");
  }
  const flags = Array.isArray(body.flags) ? body.flags.map(String) : [];
  const declined = flags.includes(RAIL_DECLINE_FLAG);
  if (declined && body.constraint_deltas != null) {
    return failed(
      "The engine reported both that the comparison was declined and a comparison result — contradictory, so neither is shown.",
    );
  }
  if (!declined) {
    return failed("The engine did not confirm it skipped the comparison run, so this answer is not shown as a re-cost.");
  }
  if (flags.some((f) => f.includes("not in the active catalogue"))) {
    return failed("The stored battery is no longer in the catalogue, so this system cannot be re-costed as it stands.");
  }
  const isBattery = baseline.runKind === "solar_battery";
  let after: RailFigures;
  let answeredKw: number | null;
  if (isBattery) {
    const opt = asRecord(body.optimal_battery);
    const cs = asRecord(body.chosen_solar);
    const so = asRecord(body.solar_options);
    const pts = Array.isArray(so.points) ? so.points.map((p) => asRecord(p)) : [];
    const ci = railIndex(so, pts);
    const sp = ci !== null ? pts[ci] : {};
    answeredKw = tariffNum(cs.solar_kw);
    const kwh = tariffNum(opt.usable_kwh);
    const battId = typeof opt.battery_id === "string" ? opt.battery_id : null;
    if (answeredKw === null || kwh === null) return failed("The engine returned no figures.");
    if (battId !== baseline.chosen.batteryId || kwh !== baseline.chosen.batteryKwh) {
      return failed("The engine answered with a different battery from the stored run's, so this is not a re-cost of the stored system.");
    }
    const incSav = tariffNum(opt.annual_savings_vs_solar_only);
    const incNpv = tariffNum(opt.incremental_npv);
    const solSav = tariffNum(sp.annual_savings);
    const solNpv = tariffNum(sp.npv_25yr);
    const wholeSav = solSav !== null && incSav !== null
      ? Math.round((solSav + incSav) * 100) / 100 : null;
    const cost = tariffNum(opt.system_cost);
    after = {
      solarKw: answeredKw,
      batteryKwh: kwh,
      paybackYears: cost !== null && wholeSav !== null && wholeSav > 0
        ? Math.round((cost / wholeSav) * 100) / 100 : null,
      npv: solNpv !== null && incNpv !== null
        ? Math.round((solNpv + incNpv) * 100) / 100 : null,
      selfSufficiencyPct: tariffNum(opt.self_sufficiency_pct),
      basis: "whole-system",
    };
  } else {
    const opt = asRecord(body.optimal);
    answeredKw = tariffNum(opt.solar_kw);
    if (answeredKw === null) return failed("The engine returned no figures.");
    after = {
      solarKw: answeredKw,
      batteryKwh: null,
      paybackYears: tariffNum(opt.simple_payback_years),
      npv: tariffNum(opt.npv_25yr),
      selfSufficiencyPct: tariffNum(opt.self_sufficiency_pct),
      basis: "whole-system",
    };
  }
  if (answeredKw !== baseline.chosen.solarKw) {
    return failed("The engine answered with a different array from the stored run's, so this is not a re-cost of the stored system.");
  }
  const engineMode = typeof body.engine_mode === "string" ? body.engine_mode : null;
  const resolution = typeof body.resolution === "string" ? body.resolution : null;
  if (engineMode === null) {
    return failed("The engine did not say which engine produced these figures, so they are not shown.");
  }
  if (isBattery && resolution === null) {
    return failed("The engine did not say which dispatch resolution produced these figures, so they are not shown.");
  }
  return {
    kind: "recosted",
    trigger: change,
    before: baseline.figures,
    after,
    deltas: railDeltas(baseline.figures, after),
    provenance: railProvenance(engineMode, resolution, isBattery),
    notSaved: RAIL_NOT_SAVED,
  };
}

export function railProvenance(
  engineMode: string | null,
  resolution: string | null,
  isBattery: boolean,
): RailProvenance {
  const engine = engineMode === "sequential" ? "the sequential engine" : `engine "${engineMode}"`;
  const dispatch = !isBattery
    ? "no battery dispatch (solar only)"
    : resolution === "full_year"
      ? "full-year dispatch, all 365 days"
      : `dispatch resolution "${resolution}"`;
  return {
    engineMode,
    resolution,
    label: `Re-costed by ${engine}, ${dispatch}. ${RAIL_NOT_SAVED}`,
  };
}

/** What a failed, timed-out or expired re-cost leaves on screen. */
export function railFailedState(change: SizingInputChange, reason: string): RailState {
  return { kind: "failed", trigger: change, reason, canRetry: true };
}

/** The one line beneath the tiles, per state — derived here so the suite
    can assert that every recomputed state says "not saved" and the stored
    state never does. */
export function railStatusLine(state: RailState): string | null {
  switch (state.kind) {
    case "stored":
      return null;
    case "reranked":
      return `${state.note} Re-ranked from the run's stored options — no new solve. ${state.notSaved}`;
    case "rerank-unavailable":
      return `${state.reason} Nothing here is saved.`;
    case "recosting":
      return "Re-costing the stored system under the new inputs — full-year dispatch, nothing is saved.";
    case "recosted":
      return state.provenance.label;
    case "failed":
      return `The recompute did not complete — ${state.reason} The stored run's figures are shown.${state.canRetry ? " Try again." : ""}`;
  }
}

/** The figures a tile shows under a state — stored, or the after figures. */
export function railFiguresFor(state: RailState, stored: RailFigures): RailFigures {
  if (state.kind === "reranked" || state.kind === "recosted") return state.after;
  return stored;
}
