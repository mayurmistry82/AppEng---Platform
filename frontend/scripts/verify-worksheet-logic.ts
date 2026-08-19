/**
 * verify-worksheet-logic.ts — checklist 3.3 harness for lib/worksheet.ts.
 *
 * Run: node --test --experimental-strip-types frontend/scripts/verify-worksheet-logic.ts
 * (or from frontend/: node --test --experimental-strip-types scripts/verify-worksheet-logic.ts)
 *
 * Fixtures are in-memory objects only — no database, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PHASE_ORDER,
  RESULTS_BAR_DEFAULT_HEIGHT,
  RESULTS_BAR_MIN_HEIGHT,
  RESULTS_BAR_STRIP,
  PATH_RULES,
  SECTIONS,
  clampResultsBarHeight,
  groupSectionsByPhase,
  jobBarView,
  parseResultsBarPreference,
  pathRule,
  phaseStates,
  resultsBarCeiling,
  resultsBarCeilingIsSuspect,
  resultsBarDefaultCollapsed,
  resultsBarMaxHeight,
  EMPTY_PLANE_FORM_ROW,
  MULTI_DWELLING_CAPTION,
  PREFILL_FROM_LOOKUP_CAPTION,
  TILE_H,
  TILE_IMG_SCALE,
  TILE_W,
  FLAT_PROFILE_TOLERANCE,
  SURVEY_OPTIONS,
  WEIGHT_SUM_TOLERANCE,
  formatAnnualKwh,
  formatDailyKwh,
  peakHeadline,
  ADDRESS_LOCK_REASON,
  addressRoofView,
  jobEditView,
  billAddressCheck,
  billAddressNotice,
  billParseView,
  energyDataView,
  intervalUploadView,
  isFlatProfile,
  loadPreviewView,
  surveyComplete,
  surveyPayload,
  surveyView,
  demandStatusLine,
  intervalReadoutParts,
  tierFor,
  tierMismatchNotice,
  typedUsageError,
  usagePlausibilityNotice,
  azimuthLabel,
  EQUIPMENT_AUTO_CAPTION,
  EQUIPMENT_CATALOGUE_PROBLEM,
  EQUIPMENT_KINDS,
  EQUIPMENT_MISSING_NOTICE,
  EQUIPMENT_UNVERIFIED_NOTICE,
  SPEC_NOT_STATED,
  equipmentSaveNotices,
  equipmentSpecsView,
  OBJECTIVE_OPTIONS,
  VALID_OBJECTIVES,
  objectiveBudgetView,
  objectiveSaveNotices,
  SHOW_CI_TARIFF_ROWS,
  TARIFF_ADDRESS_LOCK_CAPTION,
  TARIFF_DEFAULTS_CAPTION,
  TARIFF_TOU_PROFILE_CAPTION,
  TARIFF_WINDOWS_UNREADABLE_NOTICE,
  isTariffTime,
  tariffBillMismatchNotice,
  tariffNetworkView,
  tariffSaveNotices,
  fitZoomForBuilding,
  metresPerPixel,
  panelRectangles,
  planeFormRowsFromView,
  projectWebMercator,
  roofDiagramView,
  tilePixel,
  worldSizePx,
  latestRoofGeometry,
  resultsBarView,
  roofEntryState,
  sectionStates,
  sectionsForPath,
  showsGoogleSolarAttribution,
  siteDetailsView,
  worksheetErrorCopy,
  type JobDetailLike,
  type WorksheetSectionSpec,
} from "../lib/worksheet.ts";
import type { ApiErrorKind } from "../lib/jobs.ts";
import { postFormData, postJson, requestJson } from "../lib/client-api.ts";
import * as worksheetModule from "../lib/worksheet.ts";

function unsafe<T>(v: unknown): T {
  return v as T;
}

const CHILD_KEYS = [
  "customer",
  "bills",
  "tariffs",
  "surveys",
  "load_profiles",
  "solar_resources",
  "sizing_results",
  "financial_results",
  "corrections",
  "interval_data",
  "actuals",
  "roof_geometry",
] as const;

/**
 * All children empty — exactly what the four real draft jobs return.
 *
 * PATH-LESS BY DEFAULT (3.3b): the path-filtering tests below pass an explicit
 * `path`, and every other test is about the unlock rule or the views, not about
 * paths — so the default takes the all-eleven branch and those assertions keep
 * the exact meaning they had before section filtering existed. Before 3.3b this
 * defaulted to `path: "A"`, which was inert; once "A" started hiding
 * battery-sizing it silently shortened the list under tests that index by
 * catalogue position.
 */
function emptyJob(overrides: Partial<JobDetailLike> = {}): JobDetailLike {
  const job: JobDetailLike = { status: "draft", path: null, path_label: null };
  for (const key of CHILD_KEYS) {
    (job as Record<string, unknown>)[key] = [];
  }
  return { ...job, ...overrides };
}

// a. Exactly 11 sections, unique ids, phase split 2/2/4/3
test("SECTIONS: 11 entries, unique ids, phases split 2/2/4/3", () => {
  assert.equal(SECTIONS.length, 11);
  assert.equal(new Set(SECTIONS.map((s) => s.id)).size, 11);
  const count = (phase: string) => SECTIONS.filter((s) => s.phase === phase).length;
  assert.equal(count("site"), 2);
  assert.equal(count("demand"), 2);
  assert.equal(count("optimise"), 4);
  assert.equal(count("resolve"), 3);
});

// b. Shading and Future loads are 4.x — not built here
test("SECTIONS: no Shading, no Future loads", () => {
  for (const s of SECTIONS) {
    const haystack = `${s.id} ${s.title}`.toLowerCase();
    assert.ok(!haystack.includes("shading"), s.id);
    assert.ok(!haystack.includes("future"), s.id);
  }
});

// c. Predicates are null-safe: {}, null children, non-array children
test("predicates: never throw, all false on {}, null children, junk children", () => {
  const nullChildren: Record<string, unknown> = {};
  const junkChildren: Record<string, unknown> = {};
  for (const key of CHILD_KEYS) {
    nullChildren[key] = null;
    junkChildren[key] = "not-an-array";
  }
  for (const fixture of [{}, nullChildren, junkChildren]) {
    for (const s of SECTIONS) {
      let result = true;
      assert.doesNotThrow(() => {
        result = s.complete(unsafe<JobDetailLike>(fixture));
      }, `${s.id} threw`);
      assert.equal(result, false, `${s.id} should be false on ${JSON.stringify(fixture).slice(0, 40)}`);
    }
  }
  // And the aggregate functions tolerate outright junk input.
  assert.doesNotThrow(() => sectionStates(null));
  assert.doesNotThrow(() => sectionStates("garbage"));
  assert.doesNotThrow(() => phaseStates(undefined));
  assert.doesNotThrow(() => jobBarView(42));
  assert.doesNotThrow(() => resultsBarView([]));
});

// d. Fresh job: section 1 active, 2-11 locked, phases current/pending/pending/pending
test("fresh job: section 1 active, rest locked, S current", () => {
  const states = sectionStates(emptyJob());
  assert.equal(states[0].state, "active");
  for (let i = 1; i < states.length; i++) {
    // D5 (2026-08-18): a NON-GATING section is "unlocked" rather than "locked"
    // even here, with the gating section above it still active — an optional
    // section must always be openable. site-details (D5) and, from 3.10,
    // equipment-specs (D24: Auto is a real answer, so it confirms rather than
    // requires, and it must not block a quote). Every OTHER section locks
    // exactly as before.
    const expected =
      states[i].id === "site-details" || states[i].id === "equipment-specs"
        ? "unlocked"
        : "locked";
    assert.equal(states[i].state, expected, states[i].id);
  }
  assert.deepEqual(phaseStates(emptyJob()), [
    "current",
    "pending",
    "pending",
    "pending",
  ]);
});

// e. roof_geometry populated -> 1 complete, 2 active
test("roof done: roof complete, Site details unlocked, Energy data active (D5)", () => {
  const job = emptyJob({ roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }] });
  const states = sectionStates(job);
  assert.equal(states[0].state, "complete");
  // D5: was "active" — the defect. An OPTIONAL section is never the thing to do
  // next, and never gates what follows.
  assert.equal(states[1].id, "site-details");
  assert.equal(states[1].state, "unlocked");
  assert.equal(states[2].id, "energy-data");
  assert.equal(states[2].state, "active");
  assert.equal(states[3].state, "locked");
});

// f. THE JUMPED-PASS CASE: section 1 incomplete but section 7 complete -> NOTHING locked
test("jumped pass: a later complete section unlocks everything", () => {
  const job = emptyJob({
    sizing_results: [{ solar_kw: 6.6, battery_kwh: null }], // section 7 complete
  });
  const states = sectionStates(job);
  assert.equal(states[0].state, "active", "first incomplete is active");
  assert.equal(states[6].state, "complete", "solar-sizing is complete");
  for (const s of states) {
    assert.notEqual(s.state, "locked", `${s.id} must not be locked`);
  }
  // The in-between incomplete sections are unlocked, not active, not complete.
  assert.equal(states[1].state, "unlocked");
  assert.equal(states[10].state, "unlocked");
});

// g. Everything true -> all complete, all phases done
test("all predicates true: 11 complete, phases all done", () => {
  const job = emptyJob({
    status: "sent", // summary-finish: past draft
    storeys: 1,
    roof_material: "tile",
    dwelling_type: "house",
    electrical_phase: "single",
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
    bills: [{ bill_id: "b1" }],
    tariffs: [{ tariff_id: "t1" }],
    sizing_results: [{ solar_kw: 6.6, battery_kwh: 12.8 }],
    financial_results: [{ payback_years: 4.2 }],
  });
  // equipment-specs / incentives are () => false by design (no columns exist
  // until 3.10 / 3.13b), so "all true" means: force those two true to test the
  // aggregate rule, not the schema. objective-budget left this list at 3.9 —
  // its predicate is real now, so the fixture satisfies it with a stored
  // objective instead of a patch.
  const patched = SECTIONS.map((s) =>
    ["equipment-specs", "incentives"].includes(s.id)
      ? { ...s, complete: () => true }
      : s,
  );
  const done = patched.map((s) => s.complete({ ...job, objective: "max_npv" }));
  assert.ok(done.every(Boolean), `not all predicates true: ${JSON.stringify(done)}`);
  // The two still-hardcoded ones really are always false against ANY job:
  for (const id of ["equipment-specs", "incentives"]) {
    const spec = SECTIONS.find((s) => s.id === id);
    assert.equal(spec?.complete(job), false, `${id} must be false until its row lands`);
  }
});

// h. jobBarView placeholders
test("jobBarView: empty customer and null path fall back to placeholders", () => {
  const noCustomer = jobBarView(emptyJob({ customer: [] }));
  assert.equal(noCustomer.address, "Address not recorded");
  const noPath = jobBarView(emptyJob({ path: null, path_label: null }));
  assert.equal(noPath.jobTypeLabel, "Job type not set");
  const full = jobBarView(
    emptyJob({
      customer: [{ property_address_full: "14 Frome St, Adelaide SA 5000" }],
      path: "A",
      path_label: "Solar only",
      accuracy_tier: null,
    }),
  );
  assert.equal(full.address, "14 Frome St, Adelaide SA 5000");
  assert.equal(full.jobTypeLabel, "Solar only (A)");
  assert.equal(full.tier, null);
});

// i. resultsBarView discriminant
test("resultsBarView: empty and all-null sizing_results are both unsized", () => {
  assert.deepEqual(resultsBarView(emptyJob({ sizing_results: [] })), {
    sized: false,
  });
  // Present but with null figures -> the not-yet-sized branch, never zeros.
  assert.deepEqual(
    resultsBarView(emptyJob({ sizing_results: [{ solar_kw: null, battery_kwh: null }] })),
    { sized: false },
  );
  const sized = resultsBarView(
    emptyJob({ sizing_results: [{ solar_kw: 6.6, battery_kwh: null }] }),
  );
  assert.equal(sized.sized, true);
});

// j. worksheetErrorCopy: distinct headings, 404 special, no tracker copy
test("worksheetErrorCopy: distinct headings incl. 404, no empty, no tracker copy", () => {
  const KINDS: ApiErrorKind[] = ["config", "auth", "network", "http", "parse"];
  const headings = KINDS.map((k) => worksheetErrorCopy(k, 500, "/api/job/x").heading);
  assert.equal(new Set(headings).size, KINDS.length, headings.join(" | "));

  const notFound = worksheetErrorCopy("http", 404, "/api/job/x");
  assert.equal(notFound.heading, "This job doesn't exist, or isn't yours");
  assert.ok(!headings.includes(notFound.heading), "404 heading distinct from all five");
  // The 404 copy must not imply WHICH of missing/foreign happened.
  assert.ok(notFound.body.toLowerCase().includes("identically"));

  for (const kind of KINDS) {
    const copy = worksheetErrorCopy(kind, 500, "/api/job/x");
    assert.ok(copy.heading.trim().length > 0, `${kind} heading empty`);
    assert.ok(copy.body.trim().length > 0, `${kind} body empty`);
    assert.ok(
      !`${copy.heading} ${copy.body}`.includes("Couldn't load jobs"),
      `${kind} must not reuse the tracker copy`,
    );
  }
  assert.ok(!`${notFound.heading} ${notFound.body}`.includes("Couldn't load jobs"));

  // Unrecognised kind -> the generic http branch, never an empty panel.
  const bogus = worksheetErrorCopy(unsafe<ApiErrorKind>("banana"), 500, "/api/job/x");
  assert.deepEqual(bogus, worksheetErrorCopy("http", 500, "/api/job/x"));
});

// ── Results-bar geometry + preference (3.3a) ─────────────────────────────────

// a. The D3 default: unsized starts numbers-only, sized starts expanded.
test("resultsBarDefaultCollapsed: true when unsized, false when sized", () => {
  assert.equal(resultsBarDefaultCollapsed({ sized: false }), true);
  assert.equal(
    resultsBarDefaultCollapsed({
      sized: true,
      solarKw: 6.6,
      batteryKwh: null,
      paybackYears: null,
      npv: null,
    }),
    false,
  );
});

// b. The ceiling, and its floor.
test("resultsBarMaxHeight: 900/140 -> 640; never below the floor, never negative", () => {
  assert.equal(resultsBarMaxHeight(900, 140), 640);
  // A 400px window with the bar already 300px down would leave -20px: the floor
  // is returned instead. (400/140 still leaves a real 140px, so a barTop that
  // actually drives the arithmetic negative is what tests the floor.)
  assert.equal(resultsBarMaxHeight(400, 300), RESULTS_BAR_MIN_HEIGHT);
  assert.equal(resultsBarMaxHeight(400, 140), 140);
  // Property: no input combination may produce less than the floor.
  for (const vh of [0, 1, 200, 400, 900, 2000, NaN, Infinity, -100]) {
    for (const top of [0, 140, 300, 5000, NaN, -50]) {
      const max = resultsBarMaxHeight(vh, top);
      assert.ok(
        Number.isFinite(max) && max >= RESULTS_BAR_MIN_HEIGHT,
        `vh=${vh} top=${top} -> ${max}`,
      );
    }
  }
});

// c. The strip is the whole point — assert the arithmetic directly.
test("clampResultsBarHeight: a huge desired returns the ceiling, strip preserved", () => {
  const viewport = 900;
  const barTop = 140;
  const clamped = clampResultsBarHeight(5000, viewport, barTop);
  assert.equal(clamped, resultsBarMaxHeight(viewport, barTop));
  // bar bottom + strip must still fit inside the window.
  assert.ok(
    barTop + clamped + RESULTS_BAR_STRIP <= viewport,
    `${barTop} + ${clamped} + ${RESULTS_BAR_STRIP} > ${viewport}`,
  );
  // ...for every plausible window, not just this one.
  for (const vh of [400, 700, 900, 1200, 1600]) {
    for (const top of [0, 80, 140, 260]) {
      const h = clampResultsBarHeight(99999, vh, top);
      assert.ok(
        top + h + RESULTS_BAR_STRIP <= vh || h === RESULTS_BAR_MIN_HEIGHT,
        `vh=${vh} top=${top} h=${h} leaves no strip`,
      );
    }
  }
  // A stored height below the floor is raised to it.
  assert.equal(clampResultsBarHeight(10, 900, 140), RESULTS_BAR_MIN_HEIGHT);
});

// d. Junk desired -> the default, never NaN.
test("clampResultsBarHeight: NaN / Infinity / null / undefined -> default", () => {
  for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
    const h = clampResultsBarHeight(bad, 900, 140);
    assert.equal(h, RESULTS_BAR_DEFAULT_HEIGHT, `${String(bad)} -> ${h}`);
    assert.ok(Number.isFinite(h) && h > 0);
  }
});

// e. Storage is user-writable — parse defensively.
test("parseResultsBarPreference: null for every malformed input", () => {
  const bad = [
    null,
    "",
    "not json",
    "[]",
    "3",
    '{"collapsed":"yes","height":200}',
    '{"height":200}',
    '{"collapsed":true}',
    '{"collapsed":true,"height":"tall"}',
    '{"collapsed":true,"height":null}',
  ];
  for (const raw of bad) {
    assert.equal(parseResultsBarPreference(raw), null, `accepted: ${String(raw)}`);
  }
  assert.deepEqual(parseResultsBarPreference('{"collapsed":true,"height":240}'), {
    collapsed: true,
    height: 240,
  });
  assert.doesNotThrow(() => parseResultsBarPreference('{"collapsed":false,"height":1e400}'));
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":1e400}'), null);
});

// f. The phase split survives grouping, and unknown phases do not vanish.
test("groupSectionsByPhase: 2/2/4/3, order kept, unknown phase kept", () => {
  const groups = groupSectionsByPhase(SECTIONS);
  assert.deepEqual(groups.map((g) => g.phase), [...PHASE_ORDER]);
  assert.deepEqual(groups.map((g) => g.sections.length), [2, 2, 4, 3]);
  assert.equal(
    groups.reduce((n, g) => n + g.sections.length, 0),
    SECTIONS.length,
  );
  assert.equal(groups[0].sections[0].id, "address-roof");
  assert.equal(groups[3].sections[2].id, "summary-finish");

  // An unrecognised phase joins the nearest known group rather than vanishing.
  const odd = groupSectionsByPhase([
    { id: "a", phase: "site" },
    { id: "b", phase: "wat" },
    { id: "c", phase: "resolve" },
  ]);
  assert.equal(odd.reduce((n, g) => n + g.sections.length, 0), 3);
  assert.deepEqual(odd[0].sections.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(odd[3].sections.map((s) => s.id), ["c"]);
  assert.doesNotThrow(() => groupSectionsByPhase([]));
});

// ── Per-path section rules (checklist 3.3b) ──────────────────────────────────

const ALL_ELEVEN = [
  "address-roof",
  "site-details",
  "energy-data",
  "tariff-network",
  "objective-budget",
  "equipment-specs",
  "solar-sizing",
  "battery-sizing",
  "results",
  "incentives",
  "summary-finish",
];

const ids = (sections: readonly { id: string }[]) => sections.map((s) => s.id);

// a. Each path's EXACT id list, by name and in order — length alone cannot
//    catch a wrong id being hidden.
test("sectionsForPath: path A hides battery-sizing only", () => {
  assert.deepEqual(
    ids(sectionsForPath("A")),
    ALL_ELEVEN.filter((id) => id !== "battery-sizing"),
  );
});

test("sectionsForPath: path B hides nothing", () => {
  assert.deepEqual(ids(sectionsForPath("B")), ALL_ELEVEN);
});

test("sectionsForPath: path C hides nothing — it KEEPS solar-sizing", () => {
  assert.deepEqual(ids(sectionsForPath("C")), ALL_ELEVEN);
});

test("sectionsForPath: path D hides nothing", () => {
  assert.deepEqual(ids(sectionsForPath("D")), ALL_ELEVEN);
});

test("sectionsForPath: path E hides solar-sizing only", () => {
  assert.deepEqual(
    ids(sectionsForPath("E")),
    ALL_ELEVEN.filter((id) => id !== "solar-sizing"),
  );
});

test("sectionsForPath: path F hides battery-sizing only", () => {
  assert.deepEqual(
    ids(sectionsForPath("F")),
    ALL_ELEVEN.filter((id) => id !== "battery-sizing"),
  );
});

// b. A typo in a `hidden` array would silently hide nothing — catch it.
test("PATH_RULES: every hidden id is a real section id", () => {
  const known = new Set(SECTIONS.map((s) => s.id));
  for (const [letter, rule] of Object.entries(PATH_RULES)) {
    for (const id of rule.hidden) {
      assert.ok(known.has(id), `path ${letter} hides unknown id ${JSON.stringify(id)}`);
    }
  }
});

// c. Exactly six paths, A-F, nothing else.
test("PATH_RULES: exactly six keys, A-F", () => {
  assert.deepEqual(Object.keys(PATH_RULES).sort(), ["A", "B", "C", "D", "E", "F"]);
});

// d. Junk paths show all eleven — never hide on an undetermined path.
test("sectionsForPath: junk paths return all eleven", () => {
  const junk = [null, undefined, "", "a", "G", "AB", 3, {}, [], true, "c"];
  for (const value of junk) {
    assert.deepEqual(
      ids(sectionsForPath(value)),
      ALL_ELEVEN,
      `junk path ${JSON.stringify(value)} filtered something`,
    );
    assert.equal(pathRule(value), null, `pathRule accepted ${JSON.stringify(value)}`);
  }
  assert.doesNotThrow(() => sectionsForPath(Symbol("x")));
});

// e. Path E: solar-sizing never appears, and the first step is still active.
test("sectionStates: path E omits solar-sizing, address-roof still active", () => {
  const states = sectionStates(emptyJob({ path: "E" }));
  assert.equal(states.length, 10);
  assert.ok(!states.some((s) => s.id === "solar-sizing"));
  assert.equal(states[0].id, "address-roof");
  assert.equal(states[0].state, "active");
});

// f. Paths A and F drop battery-sizing.
test("sectionStates: paths A and F omit battery-sizing", () => {
  for (const path of ["A", "F"]) {
    const states = sectionStates(emptyJob({ path }));
    assert.equal(states.length, 10, `path ${path}`);
    assert.ok(!states.some((s) => s.id === "battery-sizing"), `path ${path}`);
    assert.ok(states.some((s) => s.id === "solar-sizing"), `path ${path}`);
  }
});

// g. Path C keeps solar-sizing, pinned to the existing array.
test("sectionStates: path C KEEPS solar-sizing and pins it", () => {
  const states = sectionStates(emptyJob({ path: "C" }));
  assert.equal(states.length, 11);
  assert.ok(
    states.some((s) => s.id === "solar-sizing"),
    "path C must keep solar-sizing — it shows the array the battery is sized around",
  );
  assert.equal(PATH_RULES.C.solarMode, "pinned");
  assert.equal(PATH_RULES.C.batteryMode, "size");
  assert.equal(PATH_RULES.C.showsExistingArray, true);
});

// h. A phase must not wait on a hidden section.
//
// LIMITATION, MEASURED NOT ASSUMED (reported with 3.3b, narrowed at 3.9): the
// prompt asked for a fixture where all three of path E's Optimise sections are
// complete, so that Optimise reads "done". That fixture STILL cannot be built —
// Optimise contains `equipment-specs`, hardcoded `() => false` until 3.10, on
// every one of the six paths. objective-budget stopped being the blocker at
// 3.9 (its predicate reads jobs.objective now, and the movement test below
// exercises it); 3.10 is the row that closes this limitation for good.
//
// What IS asserted here, and does break: path E's Optimise composition (a wrong
// PATH_RULES entry fails it), that the done-rule works on the phases that CAN
// complete, and that the active section is the first incomplete VISIBLE one.
test("phaseStates: path E Optimise holds 3 sections, none of them solar-sizing", () => {
  const optimise = sectionsForPath("E").filter((s) => s.phase === "optimise");
  assert.deepEqual(optimise.map((s) => s.id), [
    "objective-budget",
    "equipment-specs",
    "battery-sizing",
  ]);

  const job = emptyJob({
    path: "E",
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
    storeys: 1,
    roof_material: "tile",
    dwelling_type: "house",
    electrical_phase: "single",
    bills: [{ bill_id: "b1" }],
    tariffs: [{ tariff_id: "t1" }],
  });
  const phases = phaseStates(job);
  // Site and Demand CAN complete, and do — the done-rule works.
  assert.deepEqual(phases.slice(0, 2), ["done", "done"]);
  // Optimise holds the active section, so it is current, never stuck pending.
  assert.equal(phases[2], "current");
  assert.equal(phases[3], "pending");

  // The active section is the first incomplete VISIBLE one — on path E that is
  // objective-budget, and solar-sizing takes no part in the ordering at all.
  const states = sectionStates(job);
  const active = states.filter((s) => s.state === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "objective-budget");
  assert.ok(!states.some((s) => s.id === "solar-sizing"));
});

// The empty-phase guard: `[].every()` is true, so without it a phase holding
// nothing would render a tick. Unreachable under the six rules, so this pins the
// precondition rather than the branch.
test("phaseStates: no path empties a phase, and none throws", () => {
  for (const path of ["A", "B", "C", "D", "E", "F", null]) {
    const counts = PHASE_ORDER.map(
      (phase) => sectionsForPath(path).filter((s) => s.phase === phase).length,
    );
    assert.ok(counts.every((n) => n > 0), `path ${String(path)} has an empty phase`);
    assert.doesNotThrow(() => phaseStates(emptyJob({ path })));
  }
});

// i. No path leaves a phase empty.
test("no path produces an empty phase", () => {
  for (const path of ["A", "B", "C", "D", "E", "F", null]) {
    for (const phase of PHASE_ORDER) {
      const count = sectionsForPath(path).filter((s) => s.phase === phase).length;
      assert.ok(count > 0, `path ${String(path)} leaves phase ${phase} empty`);
    }
    assert.ok(sectionsForPath(path).length > 0);
  }
});

// 6b. "Switching job type re-renders correctly" — the live half is DEFERRED TO
// 3.3c (nothing in the product can change a job's type until the editor
// exists). The pure half is asserted here: two paths yield two different lists.
test("two different paths yield two different section lists", () => {
  assert.notDeepEqual(ids(sectionsForPath("A")), ids(sectionsForPath("E")));
  assert.notDeepEqual(ids(sectionsForPath("A")), ids(sectionsForPath("B")));
  assert.notDeepEqual(
    ids(sectionStates(emptyJob({ path: "A" }))),
    ids(sectionStates(emptyJob({ path: "E" }))),
  );
});

// ── 503 error copy (auth membership-lookup fix, 2026-08-14) ──────────────────
//
// A 503 from /api/job/{id} now means the backend could not reach its database to
// check anything — NOT that the caller lacks access. Before the auth fix that
// case surfaced as 403 "Forbidden" and sent installers hunting a permissions
// problem that did not exist, so this copy must never point that way.
test("worksheetErrorCopy: 503 is distinct from 404 and from the generic http case", () => {
  const endpoint = "/api/job/x";
  const unavailable = worksheetErrorCopy("http", 503, endpoint);
  const notFound = worksheetErrorCopy("http", 404, endpoint);
  const generic = worksheetErrorCopy("http", 500, endpoint);

  assert.notEqual(unavailable.heading, notFound.heading);
  assert.notEqual(unavailable.heading, generic.heading);
  assert.notEqual(unavailable.body, notFound.body);
  assert.notEqual(unavailable.body, generic.body);
  assert.ok(unavailable.heading.trim().length > 0);
  assert.ok(unavailable.body.trim().length > 0);
});

test("worksheetErrorCopy: the 503 copy never blames access or the session", () => {
  const copy = worksheetErrorCopy("http", 503, "/api/job/x");
  const text = `${copy.heading} ${copy.body}`.toLowerCase();
  for (const banned of [
    "permission",
    "sign in",
    "signed out",
    "session",
    "forbidden",
  ]) {
    assert.ok(!text.includes(banned), `503 copy must not contain ${JSON.stringify(banned)}: ${text}`);
  }
  // It should say what actually happened and that it is transient.
  assert.ok(text.includes("temporar"), text);
});

test("worksheetErrorCopy: every other branch is unchanged by the 503 addition", () => {
  const endpoint = "/api/job/x";
  assert.equal(
    worksheetErrorCopy("http", 404, endpoint).heading,
    "This job doesn't exist, or isn't yours",
  );
  assert.equal(worksheetErrorCopy("http", 500, endpoint).heading, "Couldn't load this job");
  assert.ok(worksheetErrorCopy("auth", 401, endpoint).body.includes("sign in again"));
  assert.ok(worksheetErrorCopy("network", 0, endpoint).body.includes("port 8000"));
  // A 503 under a NON-http kind still takes that kind's own branch.
  assert.equal(
    worksheetErrorCopy("network", 503, endpoint).heading,
    worksheetErrorCopy("network", 0, endpoint).heading,
  );
});

// ── Address & roof (3.4-B) ───────────────────────────────────────────────────

const roofRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  created_at: "2026-08-14T01:00:00Z",
  found: true,
  source: "google_solar",
  manual_entry_required: false,
  low_confidence: false,
  needs_manual_confirmation: false,
  planes: [{ azimuth: 0, pitch: 22, area_m2: 50, usable_area_m2: 35, panel_count: 17, kwp: 7.48 }],
  ...over,
});

// (a) latestRoofGeometry — newest wins; unknown timestamps never win.
test("latestRoofGeometry: junk-safe, newest wins, dateless sorts oldest", () => {
  assert.equal(latestRoofGeometry(emptyJob()), null); // rows: []
  assert.equal(latestRoofGeometry({}), null); // key absent
  assert.equal(latestRoofGeometry(emptyJob({ roof_geometry: "junk" })), null);
  assert.equal(
    latestRoofGeometry(emptyJob({ roof_geometry: [1, "x", null] })),
    null,
  ); // rows that are not objects are dropped by arr()

  const a = roofRow({ created_at: "2026-08-01T00:00:00Z", tag: "a" });
  const b = roofRow({ created_at: "2026-08-14T00:00:00Z", tag: "b" });
  const c = roofRow({ created_at: "2026-08-07T00:00:00Z", tag: "c" });
  assert.equal(latestRoofGeometry(emptyJob({ roof_geometry: [a, b, c] }))?.tag, "b");
  assert.equal(latestRoofGeometry(emptyJob({ roof_geometry: [b, a, c] }))?.tag, "b");

  // A row with no created_at, or an unparseable one, must never beat a dated row —
  // even when it appears LATER in the array.
  const dateless = roofRow({ created_at: undefined, tag: "dateless" });
  delete dateless.created_at;
  const garbled = roofRow({ created_at: "not-a-date", tag: "garbled" });
  assert.equal(
    latestRoofGeometry(emptyJob({ roof_geometry: [a, dateless] }))?.tag,
    "a",
  );
  assert.equal(
    latestRoofGeometry(emptyJob({ roof_geometry: [a, garbled] }))?.tag,
    "a",
  );
  // Exactly one row — returned even if dateless (something must supersede nothing).
  assert.equal(
    latestRoofGeometry(emptyJob({ roof_geometry: [dateless] }))?.tag,
    "dateless",
  );
});

// (b) roofEntryState — all five, with manual beating low_confidence.
test("roofEntryState: five states, manual wins precedence", () => {
  assert.equal(roofEntryState(null), "none");
  assert.equal(roofEntryState("junk"), "none");
  assert.equal(roofEntryState(roofRow()), "found");
  assert.equal(roofEntryState(roofRow({ found: false })), "not_found");
  assert.equal(roofEntryState(roofRow({ manual_entry_required: true })), "not_found");
  assert.equal(roofEntryState(roofRow({ low_confidence: true })), "low_confidence");
  assert.equal(
    roofEntryState(roofRow({ needs_manual_confirmation: true })),
    "low_confidence",
  );
  assert.equal(roofEntryState(roofRow({ source: "manual_plans" })), "manual");
  // Precedence: a manual row that ALSO carries low_confidence resolves manual.
  assert.equal(
    roofEntryState(roofRow({ source: "manual_estimate", low_confidence: true })),
    "manual",
  );
});

// (c) azimuthLabel — the 16-point compass, normalised.
test("azimuthLabel: compass points, normalisation, junk", () => {
  assert.equal(azimuthLabel(0), "N");
  assert.equal(azimuthLabel(90), "E");
  assert.equal(azimuthLabel(180), "S");
  assert.equal(azimuthLabel(270), "W");
  assert.equal(azimuthLabel(45), "NE");
  assert.equal(azimuthLabel(337.5), "NNW");
  assert.equal(azimuthLabel(360), "N");
  assert.equal(azimuthLabel(-90), "W");
  assert.equal(azimuthLabel(720), "N");
  assert.equal(azimuthLabel(null), null);
  assert.equal(azimuthLabel(unsafe<number>("north")), null);
  assert.equal(azimuthLabel(NaN), null);
});

// (d) THE CHANGED PREDICATE — a persisted row alone no longer completes the section.
test("address-roof predicate: only a usable roof completes it", () => {
  const spec = SECTIONS.find((s) => s.id === "address-roof");
  assert.ok(spec);
  const complete = (rows: unknown) =>
    spec.complete(emptyJob({ roof_geometry: rows }));

  // A not-found row persisted by the backend (the Mount Gambier case).
  assert.equal(
    complete([roofRow({ found: false, manual_entry_required: true, planes: [] })]),
    false,
    "a regional NOT_FOUND row must not complete the section",
  );
  assert.equal(complete([roofRow({ planes: [] })]), false, "empty planes");
  assert.equal(
    complete([roofRow({ planes: [{ panel_count: 0 }, { panel_count: 0 }] })]),
    false,
    "all-zero panels",
  );
  assert.equal(
    complete([roofRow({ planes: [{ panel_count: 12 }] })]),
    true,
    "one plane with panels completes",
  );
  // An auto row WITH planes followed by a NEWER manual row with none: the newest
  // row is the record, so the section is NOT complete.
  const auto = roofRow({ created_at: "2026-08-10T00:00:00Z" });
  const manualEmpty = roofRow({
    created_at: "2026-08-14T02:00:00Z",
    source: "manual_estimate",
    planes: [],
  });
  assert.equal(complete([auto, manualEmpty]), false, "newer empty manual supersedes");
  assert.equal(complete([manualEmpty, auto]), false, "order in array is irrelevant");
});

// (e) The regression the old predicate would have caused.
test("not-found row: Address & roof stays ACTIVE, Site current, next locked", () => {
  const job = emptyJob({
    roof_geometry: [roofRow({ found: false, manual_entry_required: true, planes: [] })],
  });
  const states = sectionStates(job);
  assert.equal(states[0].id, "address-roof");
  assert.equal(states[0].state, "active", "must stay the active section");
  assert.equal(states[1].id, "site-details");
  // D5: was "locked". An optional section stays openable even when the gating
  // section above it is the active one — it just never becomes active itself.
  assert.equal(states[1].state, "unlocked", "Site details is optional — never locked");
  assert.equal(states[2].state, "locked", "the gating section below still locks");
  assert.deepEqual(phaseStates(job), ["current", "pending", "pending", "pending"]);
});

// (f) addressRoofView never throws.
test("addressRoofView: junk-safe, serialisable, correct states", () => {
  assert.doesNotThrow(() => addressRoofView(null));
  assert.doesNotThrow(() => addressRoofView("garbage"));
  assert.doesNotThrow(() => addressRoofView({}));
  assert.equal(addressRoofView(null).state, "none");
  assert.equal(addressRoofView({}).state, "none");
  const junkPlanes = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ planes: "not-a-list" })] }),
  );
  assert.equal(junkPlanes.state, "found");
  assert.deepEqual(junkPlanes.planes, []);
  assert.deepEqual(junkPlanes.totals, { panels: 0, kwp: 0 });

  const found = addressRoofView(emptyJob({ path: "A", roof_geometry: [roofRow()] }));
  assert.equal(found.state, "found");
  assert.equal(found.notice?.tone, "success");
  assert.equal(found.planes[0].azimuthLabel, "N");
  assert.equal(found.totals.panels, 17);
  assert.equal(found.solarMode, "optimise"); // 3.3b PATH_RULES, first consumer
  const nf = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ found: false, planes: [] })] }),
  );
  assert.equal(nf.notice?.tone, "info");
  const manual = addressRoofView(
    emptyJob({
      roof_geometry: [
        roofRow({ source: "manual_plans", reason: "Manual entry: from builder plans" }),
      ],
    }),
  );
  assert.equal(manual.state, "manual");
  assert.equal(manual.note, "from builder plans");
  assert.equal(manual.notice?.title, "Entered from plans");
  // No function values anywhere — the view crosses the server/client boundary.
  assert.doesNotThrow(() => JSON.stringify(found));
});

// ── Roof plausibility notices (3.4-C) ────────────────────────────────────────
// Causes are read from `flags`, not from `low_confidence_causes`: a row written
// before 3.4-C has flags but no such key, and the newest-row rule means such a
// row can still be the one on screen.

/** The real 14 Frome St row, as stored on 2026-08-14. */
const FROME_ROW = {
  created_at: "2026-08-14T05:00:00Z",
  found: true,
  source: "google_solar",
  low_confidence: true,
  needs_manual_confirmation: true,
  flags: [
    "google_panel_layout_absent",
    "plane_1_implausible_pitch",
    "imagery_7y_old",
    "low_confidence_no_google_panel_layout",
    "low_confidence_implausible_pitch",
    "low_confidence_result",
  ],
  planes: [
    { azimuth: 14.7, pitch: 76.4, area_m2: 2.3, usable_area_m2: 1.61, panel_count: 0, kwp: 0 },
    { azimuth: 173.1, pitch: 77, area_m2: 68.32, usable_area_m2: 47.82, panel_count: 23, kwp: 10.12 },
  ],
};

const viewFor = (row: unknown) =>
  addressRoofView(emptyJob({ roof_geometry: [row] }));

test("confidenceNotices: both causes render, in the stated order", () => {
  const view = viewFor(FROME_ROW);
  assert.equal(view.confidenceNotices.length, 2);
  assert.equal(
    view.confidenceNotices[0].title,
    "One of these faces is too steep to be a roof",
  );
  assert.equal(
    view.confidenceNotices[1].title,
    "Google could not fit any panels on this building",
  );
  for (const n of view.confidenceNotices) assert.equal(n.tone, "caution");
  // The pitch is DERIVED from planes (77, the face carrying panels — not 76.4).
  assert.ok(view.confidenceNotices[0].body.includes("77°"),
    view.confidenceNotices[0].body);
  // The generic state notice no longer hardcodes the new-build wording.
  assert.equal(view.notice?.title, "Check this roof before you use it");
  // And nothing was hidden: the planes and totals still render.
  assert.equal(view.planes.length, 2);
  assert.equal(view.totals.panels, 23);
  assert.equal(view.totals.kwp, 10.12);
});

test("confidenceNotices: a single cause renders exactly one notice", () => {
  const view = viewFor({
    ...FROME_ROW,
    flags: ["low_confidence_too_few_segments", "low_confidence_result"],
  });
  assert.equal(view.confidenceNotices.length, 1);
  assert.equal(view.confidenceNotices[0].title, "This may be a newer build than the photo");
});

test("confidenceNotices: too_few_segments and too_few_panels dedup to one notice", () => {
  const view = viewFor({
    ...FROME_ROW,
    flags: ["low_confidence_too_few_segments", "low_confidence_too_few_panels"],
  });
  assert.equal(view.confidenceNotices.length, 1);
});

test("confidenceNotices: an UNRECOGNISED cause renders a caution, never silence", () => {
  const view = viewFor({ ...FROME_ROW, flags: ["low_confidence_madeup"] });
  assert.equal(view.confidenceNotices.length, 1);
  assert.equal(view.confidenceNotices[0].title, "Something about this result looks wrong");
  assert.ok(view.confidenceNotices[0].body.includes("madeup"),
    view.confidenceNotices[0].body);
});

test("confidenceNotices: all four causes stack in order", () => {
  const view = viewFor({
    ...FROME_ROW,
    flags: [
      "low_confidence_too_few_segments",
      "low_confidence_madeup",
      "low_confidence_no_google_panel_layout",
      "low_confidence_implausible_pitch",
      "low_confidence_result",
    ],
  });
  assert.deepEqual(
    view.confidenceNotices.map((n) => n.title),
    [
      "One of these faces is too steep to be a roof",
      "Google could not fit any panels on this building",
      "This may be a newer build than the photo",
      "Something about this result looks wrong",
    ],
  );
});

test("confidenceNotices: junk-safe and empty when there are no causes", () => {
  assert.deepEqual(viewFor({ ...FROME_ROW, flags: [] }).confidenceNotices, []);
  const noFlags = { ...FROME_ROW };
  delete (noFlags as { flags?: unknown }).flags;
  assert.deepEqual(viewFor(noFlags).confidenceNotices, []);
  assert.deepEqual(
    viewFor({ ...FROME_ROW, flags: "not-an-array" }).confidenceNotices,
    [],
  );
  assert.deepEqual(
    viewFor({ ...FROME_ROW, flags: [1, null, {}] }).confidenceNotices,
    [],
  );
  // low_confidence_result ALONE is the summary flag, not a cause.
  assert.deepEqual(
    viewFor({ ...FROME_ROW, flags: ["low_confidence_result"] }).confidenceNotices,
    [],
  );
  assert.doesNotThrow(() => viewFor({ ...FROME_ROW, planes: "junk" }));
});

test("confidenceNotices: a PRE-3.4-C row renders none and does not throw", () => {
  // Exactly what was stored before this change: flags present, no cause entries.
  const preChange = {
    ...FROME_ROW,
    low_confidence: false,
    needs_manual_confirmation: false,
    flags: ["google_panel_layout_absent", "imagery_7y_old"],
  };
  const view = viewFor(preChange);
  assert.deepEqual(view.confidenceNotices, []);
  assert.equal(view.state, "found"); // low_confidence reads whatever was stored
  assert.equal(view.totals.panels, 23);
});

test("confidenceNotices: pitch falls back when no plane carries panels", () => {
  const view = viewFor({
    ...FROME_ROW,
    flags: ["low_confidence_implausible_pitch"],
    planes: [{ azimuth: 0, pitch: 77, area_m2: 2.3, panel_count: 0, kwp: 0 }],
  });
  assert.equal(view.confidenceNotices.length, 1);
  assert.ok(view.confidenceNotices[0].body.includes("that angle"),
    view.confidenceNotices[0].body);
});

// ── Manual-form pre-fill (3.4-D) ─────────────────────────────────────────────

const plane = (over: Record<string, unknown> = {}) => ({
  index: 0, label: null, azimuth: 0, azimuthLabel: "N", pitch: 22,
  areaM2: 50, usableAreaM2: 35, panelCount: 17, kwp: 7.48, ...over,
});

test("planeFormRowsFromView: exact compass points select that point", () => {
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const [row] = planeFormRowsFromView([plane({ azimuth: deg })]);
    assert.equal(row.direction, String(deg), `azimuth ${deg}`);
    assert.equal(row.exactDegrees, "", `azimuth ${deg} must not fill exactDegrees`);
  }
});

test("planeFormRowsFromView: an off-point azimuth uses Exact degrees", () => {
  const [row] = planeFormRowsFromView([plane({ azimuth: 173.1 })]);
  assert.equal(row.direction, "exact");
  assert.equal(row.exactDegrees, "173.1"); // 173.1 is NOT South
  const [r2] = planeFormRowsFromView([plane({ azimuth: 14.7 })]);
  assert.deepEqual([r2.direction, r2.exactDegrees], ["exact", "14.7"]);
});

test("planeFormRowsFromView: nulls become empty strings, never 'null'", () => {
  const [row] = planeFormRowsFromView([
    plane({ azimuth: null, pitch: null, areaM2: null, label: null }),
  ]);
  assert.deepEqual(row, EMPTY_PLANE_FORM_ROW);
  for (const value of Object.values(row)) assert.equal(typeof value, "string");
});

test("planeFormRowsFromView: a label is carried through", () => {
  const [row] = planeFormRowsFromView([plane({ label: "main north face" })]);
  assert.equal(row.label, "main north face");
});

test("planeFormRowsFromView: junk-safe", () => {
  assert.deepEqual(planeFormRowsFromView([]), []);
  assert.deepEqual(planeFormRowsFromView("not-an-array"), []);
  assert.deepEqual(planeFormRowsFromView(null), []);
  assert.deepEqual(planeFormRowsFromView(undefined), []);
  // A non-object entry is skipped; its neighbours still map.
  const rows = planeFormRowsFromView(["junk", plane({ azimuth: 90 }), null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "90");
  assert.doesNotThrow(() => planeFormRowsFromView([{}]));
  assert.deepEqual(planeFormRowsFromView([{}]), [EMPTY_PLANE_FORM_ROW]);
});

test("planeFormRowsFromView: the REAL 14 Frome St roof pre-fills for correction", () => {
  // Straight from the stored row: azimuths 14.7/173.1, pitches 76.4/77, areas 2.3/68.32.
  const rows = planeFormRowsFromView([
    plane({ index: 0, azimuth: 14.7, pitch: 76.4, areaM2: 2.3, panelCount: 0, kwp: 0 }),
    plane({ index: 1, azimuth: 173.1, pitch: 77, areaM2: 68.32, panelCount: 23, kwp: 10.12 }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    direction: "exact", exactDegrees: "14.7", pitch: "76.4", area: "2.3", label: "",
  });
  assert.deepEqual(rows[1], {
    direction: "exact", exactDegrees: "173.1", pitch: "77", area: "68.32", label: "",
  });
  // No rounding and no unit suffix — opening the form must not alter the data.
  assert.ok(!rows[1].pitch.includes("°"));
  assert.ok(!rows[1].area.includes("m"));
});

test("planeFormRowsFromView: feeds straight from a stored roof view", () => {
  // End to end: the view the section renders is the view the form pre-fills from.
  const view = addressRoofView(emptyJob({ roof_geometry: [FROME_ROW] }));
  const rows = planeFormRowsFromView(view.planes);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].pitch, "77");
  assert.equal(rows[1].exactDegrees, "173.1");
});

// ── Site details view (3.4b) ─────────────────────────────────────────────────
// D5 governs everything here: site-visit fields, optional, never gating.

test("siteDetailsView: a full job maps raw + text for all seven", () => {
  const view = siteDetailsView(emptyJob({
    storeys: 2, roof_material: "colorbond or metal", dwelling_type: "detached",
    year_built: 1995, bedrooms: 3, floor_area_m2: 180.5, electrical_phase: "single",
  }));
  assert.deepEqual(view.storeys, { raw: 2, text: "2" });
  assert.deepEqual(view.roofMaterial, { raw: "colorbond or metal", text: "colorbond or metal" });
  assert.deepEqual(view.yearBuilt, { raw: 1995, text: "1995" });
  assert.deepEqual(view.bedrooms, { raw: 3, text: "3" });
  assert.deepEqual(view.floorAreaM2, { raw: 180.5, text: "180.5" });
  assert.deepEqual(view.electricalPhase, { raw: "single", text: "single" });
  assert.equal(view.dwellingType, "detached");
  assert.doesNotThrow(() => JSON.stringify(view)); // crosses the boundary
});

test("siteDetailsView: empty / junk jobs yield a usable view, never a throw", () => {
  for (const input of [emptyJob(), null, "garbage", {}, 42]) {
    const view = siteDetailsView(input);
    assert.equal(view.storeys.raw, null, String(input));
    assert.equal(view.storeys.text, "");
    assert.equal(view.dwellingType, null);
    assert.equal(view.showsMultiDwellingCaution, false);
  }
});

test("siteDetailsView: the multi-dwelling caution fires ONLY for unit/townhouse", () => {
  const caution = (dwelling: unknown) =>
    siteDetailsView(emptyJob({ dwelling_type: unsafe<string>(dwelling) }))
      .showsMultiDwellingCaution;
  assert.equal(caution("unit"), true);
  assert.equal(caution("townhouse"), true);
  assert.equal(caution("detached"), false);
  assert.equal(caution("other"), false, "other means unknown, not multi-dwelling (F96)");
  assert.equal(caution(null), false, "absence is not a signal");
  assert.equal(caution("UNIT"), false, "the DB stores lowercase; do not invent a signal");
  assert.equal(caution(7), false);
});

test("siteDetailsView: an out-of-list roof_material survives into the view", () => {
  // No DB constraint exists on roof_material, so a stored value outside the UI
  // list is possible — it must reach the view intact, never silently reset.
  const view = siteDetailsView(emptyJob({ roof_material: "thatched heritage" }));
  assert.deepEqual(view.roofMaterial, { raw: "thatched heritage", text: "thatched heritage" });
});

test("3.4b changes nothing about section state or completeness (D5)", () => {
  // A job with a usable roof row and NO site details.
  //
  // THIS CHECK ORIGINALLY ASSERTED THE DEFECT: it pinned Site details as the
  // ACTIVE section and the rail as ["current", ...] — the state 3.4b happened
  // to leave behind — while citing D5, which says these fields are "optional,
  // never gating". The pin was faithful to the code and wrong about the rule.
  // Corrected 2026-08-18: an optional section is unlocked, Energy data is the
  // active one, and the Site phase reads done because its GATING work is done.
  const job = emptyJob({
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
  });
  const states = sectionStates(job);
  assert.equal(states[0].id, "address-roof");
  assert.equal(states[0].state, "complete");
  assert.equal(states[1].id, "site-details");
  assert.equal(states[1].state, "unlocked");
  assert.equal(states[2].id, "energy-data");
  assert.equal(states[2].state, "active");
  assert.deepEqual(phaseStates(job), ["done", "current", "pending", "pending"]);

  // And filling every site field does not tick anything EXTRA beyond the four
  // fields the (unchanged) predicate has always read.
  const spec = SECTIONS.find((s) => s.id === "site-details");
  assert.ok(spec);
  assert.equal(
    spec.complete(emptyJob({ year_built: 1995, bedrooms: 3, floor_area_m2: 180 })),
    false,
    "the three NEW fields must not complete the section — the predicate is unchanged",
  );
  assert.equal(
    spec.complete(emptyJob({
      storeys: 1, roof_material: "tile", dwelling_type: "unit", electrical_phase: "single",
    })),
    true,
    "the original four fields still complete it exactly as before",
  );
});

// ── Results-bar ceiling trust (3.3a-fix2) ────────────────────────────────────
// The 2026-08-14 defect: a reload restores scroll position, a viewport-relative
// barTop reads large, the ceiling collapses to the floor, the bar is clamped to
// 96px, that height is persisted as though chosen, and the screen stays broken.

test("resultsBarCeilingIsSuspect: trusts a normal reading, distrusts a floor-level one", () => {
  assert.equal(resultsBarCeilingIsSuspect(1000, 0), false);
  assert.equal(resultsBarCeilingIsSuspect(1000, 800), true);
  // Exactly at the floor is suspect — no real device is that short.
  assert.equal(resultsBarCeilingIsSuspect(1000, 784), true, "1000-784-120 = 96");
  assert.equal(resultsBarCeilingIsSuspect(1000, 783), false, "1000-783-120 = 97");
});

test("resultsBarCeilingIsSuspect: junk and negative readings are suspect", () => {
  for (const [vh, top] of [
    [NaN, 0], [Infinity, 0], [-Infinity, 0], [1000, NaN], [1000, Infinity],
    [1000, -1], [1000, -500],
  ] as [number, number][]) {
    assert.equal(resultsBarCeilingIsSuspect(vh, top), true, `vh=${vh} top=${top}`);
  }
  assert.equal(resultsBarCeilingIsSuspect(unsafe<number>(null), 0), true);
  assert.equal(resultsBarCeilingIsSuspect(1000, unsafe<number>(null)), true);
  assert.equal(resultsBarCeilingIsSuspect(undefined, undefined), true);
  assert.doesNotThrow(() => resultsBarCeilingIsSuspect(unsafe<number>("tall"), 0));
});

// T2 — THE SCROLL-INDEPENDENCE PROOF. `barTop` is the scroll-DEPENDENT reading
// that caused the fault; the ceiling must ignore it entirely.
test("resultsBarCeiling: identical at scroll 0 and scroll 2000", () => {
  const viewportHeight = 1000;
  const containerTop = 140; // the scroll container does not move with its content
  const atTop = resultsBarCeiling({ viewportHeight, containerTop, barTop: 140 });
  const scrolled = resultsBarCeiling({ viewportHeight, containerTop, barTop: 2140 });
  assert.equal(atTop, scrolled, "the ceiling moved when only barTop changed");
  assert.equal(atTop, resultsBarMaxHeight(viewportHeight, containerTop));
  assert.equal(atTop, 740); // 1000 - 140 - 120

  // Sweep a whole scroll range — no barTop may influence the result.
  for (const barTop of [0, 140, 500, 2000, 12000, -50, NaN]) {
    assert.equal(
      resultsBarCeiling({ viewportHeight, containerTop, barTop }),
      740,
      `barTop ${barTop} changed the ceiling`,
    );
  }
});

test("resultsBarCeiling: null (suspect) when the container cannot be measured", () => {
  // No scrolling ancestor found, or SSR — never fall back to the scrolled value.
  assert.equal(resultsBarCeiling({ viewportHeight: 1000, containerTop: null, barTop: 140 }), null);
  assert.equal(
    resultsBarCeiling({ viewportHeight: 1000, containerTop: unsafe<number>(NaN), barTop: 140 }),
    null,
  );
  // A genuinely tiny window reads suspect rather than squashing the bar.
  assert.equal(resultsBarCeiling({ viewportHeight: 300, containerTop: 140, barTop: 140 }), null);
  // And a healthy reading still returns a real number.
  assert.equal(resultsBarCeiling({ viewportHeight: 900, containerTop: 140, barTop: 9999 }), 640);
});

test("parseResultsBarPreference: a floor-level stored height reads as NO preference", () => {
  // THE SELF-HEAL — a browser already carrying the squashed 96 recovers on load.
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":96}'), null);
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":95}'), null);
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":1}'), null);
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":0}'), null);
  assert.equal(parseResultsBarPreference('{"collapsed":false,"height":-40}'), null);
  // Just above the floor is still a real preference.
  assert.deepEqual(parseResultsBarPreference('{"collapsed":false,"height":97}'), {
    collapsed: false,
    height: 97,
  });
  assert.deepEqual(parseResultsBarPreference('{"collapsed":true,"height":320}'), {
    collapsed: true,
    height: 320,
  });
});

test("resultsBarMaxHeight and clampResultsBarHeight are UNCHANGED by 3.3a-fix2", () => {
  // Pinned byte-for-byte: this row changed neither, and other tests rely on them.
  assert.equal(resultsBarMaxHeight(900, 140), 640);
  assert.equal(resultsBarMaxHeight(400, 300), RESULTS_BAR_MIN_HEIGHT);
  assert.equal(resultsBarMaxHeight(400, 140), 140);
  assert.equal(clampResultsBarHeight(5000, 900, 140), 640);
  assert.equal(clampResultsBarHeight(10, 900, 140), RESULTS_BAR_MIN_HEIGHT);
  assert.equal(clampResultsBarHeight(NaN, 900, 140), RESULTS_BAR_DEFAULT_HEIGHT);
});

// ── §20.2 Solar Data retention (3.5b) ────────────────────────────────────────
// Expiry begins strictly AFTER 30 days; day 30 itself is not yet expired
// (matching backend/solar_retention.py's `> timedelta(days=30)`).

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

const googleRoof = (over: Record<string, unknown> = {}) =>
  roofRow({
    source: "google_solar",
    imagery_date: "2018-11-17",
    imagery_quality: "MEDIUM",
    imagery_stale: true,
    ...over,
  });

test("solar retention: a 31-day-old google row is expired and redacted in the view", () => {
  const view = addressRoofView(
    emptyJob({ roof_geometry: [googleRoof({ solar_data_captured_at: daysAgo(31) })] }),
  );
  assert.equal(view.solarDataExpired, true);
  assert.equal(view.imageryDate, null, "imagery date is deleted data");
  assert.equal(view.imageryQualityLabel, null, "imagery quality is deleted data");
  assert.equal(
    view.solarExpiredNotice?.title,
    "Google's roof data for this job has been deleted",
  );
  assert.equal(view.solarExpiredNotice?.tone, "caution");
  // OUR numbers survive untouched (roofRow's single-plane fixture: 17 / 7.48).
  assert.equal(view.planes.length, 1);
  assert.equal(view.totals.panels, 17);
  assert.equal(view.totals.kwp, 7.48);
  // imageryStale is deliberately untouched (the flag is ours).
  assert.equal(view.imageryStale, true);
});

test("solar retention: a 29-day-old google row is NOT expired", () => {
  const view = addressRoofView(
    emptyJob({ roof_geometry: [googleRoof({ solar_data_captured_at: daysAgo(29) })] }),
  );
  assert.equal(view.solarDataExpired, false);
  assert.equal(view.solarExpiredNotice, null);
  assert.equal(view.imageryDate, "2018-11-17");
});

test("solar retention: the 30-day boundary is NOT yet expired (backend's choice)", () => {
  // A hair under 30 full days — unambiguously inside the window.
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({ solar_data_captured_at: daysAgo(30) }),
      ],
    }),
  );
  // daysAgo(30) is exactly 30*24h ago; expiry requires STRICTLY more.
  assert.equal(view.solarDataExpired, false, "30 days is not yet expired");
});

test("solar retention: a manual row aged 400 days is never expired", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        roofRow({
          source: "manual_plans",
          created_at: daysAgo(400),
          solar_data_captured_at: null,
        }),
      ],
    }),
  );
  assert.equal(view.solarDataExpired, false);
  assert.equal(view.solarExpiredNotice, null);
});

test("solar retention: backend's solar_data_expired flag honoured even when recent", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({ solar_data_captured_at: daysAgo(1), solar_data_expired: true }),
      ],
    }),
  );
  assert.equal(view.solarDataExpired, true);
  assert.equal(view.imageryDate, null);
});

test("solar retention: the tombstone date alone expires the view", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({
          solar_data_captured_at: daysAgo(2),
          solar_data_expired_at: daysAgo(1),
        }),
      ],
    }),
  );
  assert.equal(view.solarDataExpired, true);
});

test("solar retention: captured_at NULL falls back to created_at", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [googleRoof({ created_at: daysAgo(31), solar_data_captured_at: null })],
    }),
  );
  assert.equal(view.solarDataExpired, true, "a NULL capture date never means immortal");
  assert.equal(view.solarDataCapturedAt, null);
});

test("showsGoogleSolarAttribution: google yes, manual no, not-found no", () => {
  const google = addressRoofView(emptyJob({ roof_geometry: [googleRoof()] }));
  assert.equal(showsGoogleSolarAttribution(google), true);
  const lowConf = addressRoofView(
    emptyJob({ roof_geometry: [googleRoof({ low_confidence: true })] }),
  );
  assert.equal(showsGoogleSolarAttribution(lowConf), true);
  const manual = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ source: "manual_plans" })] }),
  );
  assert.equal(showsGoogleSolarAttribution(manual), false,
    "a roof entered from plans must not be credited to Google");
  const notFound = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ found: false, source: null, planes: [] })] }),
  );
  assert.equal(showsGoogleSolarAttribution(notFound), false);
  assert.equal(showsGoogleSolarAttribution(addressRoofView(null)), false);
});

// ── Panel-layout diagram (3.5 prompt 2) ──────────────────────────────────────
//
// STEP 1 proves the projection against arithmetic computed independently HERE,
// not against the picture. STEP 2 is the segment-join trap: panels_raw carries
// GOOGLE'S segment numbering, planes[] can have skipped a malformed segment,
// so positional indexing attaches panels to the wrong roof face. STEP 3 is the
// named reasons — never a throw, never a bare [].

const DIAG_LAT = -34.9259;
const DIAG_LNG = 138.6472;
const gp = (latitude: number, longitude: number) => ({ latitude, longitude });

// Modelled on the live 53 Bishops Pl row (74f3d9e2): plane centers are copied
// VERBATIM into segment_bounding_boxes[].center (same source object in
// _normalise), which is what makes the exact-equality centre match sound.
const SEG_CENTRES = [gp(-34.9258666, 138.647133), gp(-34.9258745, 138.6472159)];
function diagramRoof(over: Record<string, unknown> = {}): Record<string, unknown> {
  return googleRoof({
    lat: DIAG_LAT,
    lng: DIAG_LNG,
    building_center: gp(-34.9258552, 138.6471519),
    building_bounding_box: {
      ne: gp(-34.9257983, 138.6472459),
      sw: gp(-34.925898, 138.6470736),
    },
    planes: [
      { azimuth: 0, pitch: 20, area_m2: 40, panel_count: 3, kwp: 1.32, center: SEG_CENTRES[0] },
      { azimuth: 90, pitch: 22, area_m2: 30, panel_count: 2, kwp: 0.88, center: SEG_CENTRES[1] },
    ],
    segment_bounding_boxes: [
      { segment_index: 0, center: SEG_CENTRES[0], boundingBox: null },
      { segment_index: 1, center: SEG_CENTRES[1], boundingBox: null },
    ],
    panels_raw: [
      { center: gp(-34.9258508, 138.6471713), orientation: "LANDSCAPE", segmentIndex: 0 },
      { center: gp(-34.92586, 138.6471885), orientation: "PORTRAIT", segmentIndex: 1 },
      { center: gp(-34.9258550, 138.6471900), orientation: "LANDSCAPE", segmentIndex: 1 },
    ],
    google_panel_width_m: 1.045,
    google_panel_height_m: 1.879,
    google_panel_capacity_w: 400,
    solar_data_captured_at: daysAgo(1),
    ...over,
  });
}

test("diagram: TILE_W/TILE_H are 640x360 and exactly 16:9 (aspect-video)", () => {
  // The overlay only aligns with the <img> because 640/360 === 16/9. Nothing
  // else protects that equality — this assertion is the guard the component
  // comment points at.
  assert.equal(TILE_W, 640);
  assert.equal(TILE_H, 360);
  assert.equal(TILE_W / TILE_H, 16 / 9);
});

test("diagram STEP 1: metresPerPixel matches the independent formula at zooms 19-21", () => {
  for (const zoom of [19, 20, 21]) {
    const independent =
      (156543.03392 * Math.cos((DIAG_LAT * Math.PI) / 180)) / 2 ** zoom;
    assert.equal(metresPerPixel(DIAG_LAT, zoom), independent, `zoom ${zoom}`);
  }
});

test("diagram STEP 1: the tile centre projects to exactly (320, 180)", () => {
  for (const zoom of [17, 19, 21]) {
    assert.deepEqual(
      tilePixel(DIAG_LAT, DIAG_LNG, DIAG_LAT, DIAG_LNG, zoom),
      { px: 320, py: 180 },
      `zoom ${zoom}`,
    );
  }
});

test("diagram STEP 1: one panel-width east lands width/mpp pixels east", () => {
  // Independent path: degrees of longitude per ground metre from the WGS84
  // equatorial circumference; expected pixel offset from metresPerPixel. The
  // two constants (156543.03392*256 vs 40075016.686) differ by ~5e-8
  // relative, hence the small tolerance rather than exact equality.
  const widthM = 1.045;
  const zoom = 21;
  const metresPerDegLng =
    (40075016.686 / 360) * Math.cos((DIAG_LAT * Math.PI) / 180);
  const dLng = widthM / metresPerDegLng;
  const p = tilePixel(DIAG_LAT, DIAG_LNG + dLng, DIAG_LAT, DIAG_LNG, zoom);
  const mpp = metresPerPixel(DIAG_LAT, zoom);
  assert.ok(p !== null && mpp !== null);
  const expected = 320 + widthM / mpp;
  assert.ok(
    Math.abs(p.px - expected) < 1e-4,
    `px ${p.px} vs expected ${expected}`,
  );
  assert.ok(Math.abs(p.py - 180) < 1e-9, `py moved: ${p.py}`);
});

test("diagram STEP 1: out-of-range and non-finite inputs return null, never NaN", () => {
  assert.equal(projectWebMercator(86, DIAG_LNG, 19), null, "lat 86");
  assert.equal(projectWebMercator(-85.1, DIAG_LNG, 19), null, "lat -85.1");
  assert.equal(projectWebMercator(NaN, DIAG_LNG, 19), null);
  assert.equal(projectWebMercator(DIAG_LAT, Infinity, 19), null);
  assert.equal(projectWebMercator(DIAG_LAT, DIAG_LNG, NaN), null);
  assert.equal(metresPerPixel(NaN, 19), null);
  assert.equal(metresPerPixel(90, 19), null, "cos(90°) would zero the scale");
  assert.equal(metresPerPixel(DIAG_LAT, Infinity), null);
  assert.equal(worldSizePx(NaN), null);
  assert.equal(tilePixel(NaN, DIAG_LNG, DIAG_LAT, DIAG_LNG, 19), null);
  assert.equal(tilePixel(DIAG_LAT, DIAG_LNG, 86, DIAG_LNG, 19), null, "bad centre");
});

test("diagram: fitZoomForBuilding — Bishops-sized box fits tight, huge box floors at 17, junk is null", () => {
  const centre = { lat: -34.9258552, lng: 138.6471519 };
  const bbox = {
    ne: gp(-34.9257983, 138.6472459),
    sw: gp(-34.925898, 138.6470736),
  };
  const zoom = fitZoomForBuilding(bbox, centre);
  assert.ok(zoom !== null && Number.isInteger(zoom) && zoom >= 17 && zoom <= 21);
  // At the chosen zoom every corner sits inside the 15%-padded frame…
  const corners = [
    [bbox.ne.latitude, bbox.ne.longitude],
    [bbox.ne.latitude, bbox.sw.longitude],
    [bbox.sw.latitude, bbox.ne.longitude],
    [bbox.sw.latitude, bbox.sw.longitude],
  ];
  for (const [lat, lng] of corners) {
    const p = tilePixel(lat, lng, centre.lat, centre.lng, zoom!);
    assert.ok(
      p !== null &&
        p.px >= 96 && p.px <= 544 &&
        p.py >= 54 && p.py <= 306,
      `corner outside padded frame at zoom ${zoom}: ${JSON.stringify(p)}`,
    );
  }
  // …and it is the LARGEST such zoom (21 caps the scale).
  if (zoom! < 21) {
    const above = corners.some(([lat, lng]) => {
      const p = tilePixel(lat, lng, centre.lat, centre.lng, zoom! + 1);
      return (
        p === null || p.px < 96 || p.px > 544 || p.py < 54 || p.py > 306
      );
    });
    assert.ok(above, `zoom ${zoom! + 1} would also have fitted`);
  }

  // A whole-street box cannot fit even at 17 — return the widest allowed, 17.
  const huge = { ne: gp(-34.92, 138.66), sw: gp(-34.93, 138.64) };
  assert.equal(fitZoomForBuilding(huge, centre), 17);

  assert.equal(fitZoomForBuilding(null, centre), null);
  assert.equal(fitZoomForBuilding({ ne: "junk" }, centre), null);
  assert.equal(
    fitZoomForBuilding({ ne: gp(1, 2), sw: gp(3, 4) }, { lat: NaN, lng: 0 }),
    null,
  );
});

test("diagram STEP 2: explicit segment_index resolves (no centres needed)", () => {
  const row = diagramRoof({
    planes: [
      { azimuth: 0, pitch: 20, segment_index: 0 },
      { azimuth: 90, pitch: 22, segment_index: 1 },
    ],
    segment_bounding_boxes: [],
  });
  const res = panelRectangles(row);
  assert.equal(res.reason, null);
  assert.equal(res.rects!.length, 3);
  assert.equal(res.rects![1].rotationDeg, 90, "panel on segment 1 takes plane 1's azimuth");
});

test("diagram STEP 2: the live shape — no segment_index, centres match the boxes", () => {
  const res = panelRectangles(diagramRoof());
  assert.equal(res.reason, null);
  assert.equal(res.rects!.length, 3);
  assert.equal(res.rects![0].rotationDeg, 0);
  assert.equal(res.rects![1].rotationDeg, 90);
  assert.equal(res.rects![1].segmentIndex, 1);
});

test("diagram STEP 2: a SKIPPED segment — centre match survives where positional indexing lies", () => {
  // Google segment 1 was malformed and skipped, so the plane at LIST position
  // 1 is GOOGLE segment 2. planes[segmentIndex] would hand segment-2 panels a
  // rotation of 0 (plane 0) or nothing at all — the diagram would look
  // entirely reasonable and be wrong.
  const c0 = gp(-34.9258666, 138.647133);
  const c2 = gp(-34.9258428, 138.6471632);
  const row = diagramRoof({
    planes: [
      { azimuth: 0, pitch: 20, center: c0 },
      { azimuth: 90, pitch: 22, center: c2 },
    ],
    segment_bounding_boxes: [
      { segment_index: 0, center: c0, boundingBox: null },
      { segment_index: 2, center: c2, boundingBox: null },
    ],
    panels_raw: [
      { center: gp(-34.925845, 138.64716), orientation: "LANDSCAPE", segmentIndex: 2 },
    ],
  });
  const res = panelRectangles(row);
  assert.equal(res.reason, null);
  assert.equal(res.rects!.length, 1);
  assert.equal(res.rects![0].segmentIndex, 2);
  assert.equal(
    res.rects![0].rotationDeg,
    90,
    "the segment-2 panel must take the SECOND plane's azimuth (centre match), not a positional guess",
  );
});

test("diagram STEP 2: unresolvable and ambiguous joins FAIL CLOSED — reason, never []", () => {
  // Neither path works: no segment_index, centre matches no box.
  const orphan = panelRectangles(
    diagramRoof({
      planes: [{ azimuth: 0, pitch: 20, center: gp(-34.999, 138.999) }],
      segment_bounding_boxes: [],
      panels_raw: [
        { center: gp(-34.9258508, 138.6471713), orientation: "LANDSCAPE", segmentIndex: 0 },
      ],
    }),
  );
  assert.equal(orphan.reason, "segment_join_failed");
  assert.equal(orphan.rects, null, "MUST be null, not an empty array");

  // Two planes claiming the same segment: not exactly one — ambiguous, closed.
  const ambiguous = panelRectangles(
    diagramRoof({
      planes: [
        { azimuth: 0, pitch: 20, segment_index: 0 },
        { azimuth: 180, pitch: 22, segment_index: 0 },
      ],
    }),
  );
  assert.equal(ambiguous.reason, "segment_join_failed");

  // A panel whose segmentIndex is junk.
  const junkIndex = panelRectangles(
    diagramRoof({
      panels_raw: [{ center: gp(-34.9258508, 138.6471713), segmentIndex: "two" }],
    }),
  );
  assert.equal(junkIndex.reason, "segment_join_failed");
});

test("diagram: orientation swaps which stored dimension is the long on-screen axis", () => {
  const res = panelRectangles(diagramRoof());
  assert.equal(res.reason, null);
  const landscape = res.rects![0];
  const portrait = res.rects![1];
  // Convention (stated in lib/worksheet.ts): heightPx is the up-slope axis.
  // PORTRAIT puts the 1.879 m side up-slope; LANDSCAPE puts it across.
  assert.ok(landscape.widthPx > landscape.heightPx, "LANDSCAPE: long side across");
  assert.ok(portrait.heightPx > portrait.widthPx, "PORTRAIT: long side up-slope");
  const ratio = 1.879 / 1.045;
  assert.ok(Math.abs(landscape.widthPx / landscape.heightPx - ratio) < 1e-9);
  assert.ok(Math.abs(portrait.heightPx / portrait.widthPx - ratio) < 1e-9);
  // And the drawn size is the GOOGLE panel at ground scale: width/mpp pixels.
  const mpp = metresPerPixel(-34.9258508, 21);
  if (roofDiagramView(emptyJob({ roof_geometry: [diagramRoof()] })).zoom === 21) {
    assert.ok(mpp !== null && Math.abs(landscape.widthPx - 1.879 / mpp) < 1e-6);
  }
});

test("diagram STEP 3: every named reason, none throwing, none returning []", () => {
  const dims = panelRectangles(
    diagramRoof({
      google_panel_width_m: null,
      google_panel_height_m: null,
      google_panel_capacity_w: null,
    }),
  );
  assert.equal(dims.reason, "dimensions_not_stored");
  assert.equal(dims.rects, null);

  const expired = panelRectangles(
    diagramRoof({ solar_data_captured_at: daysAgo(31) }),
  );
  assert.equal(expired.reason, "solar_data_expired");

  const noPanels = panelRectangles(diagramRoof({ panels_raw: [] }));
  assert.equal(noPanels.reason, "no_panel_positions");

  const noCoords = panelRectangles(
    diagramRoof({ building_center: null, lat: null, lng: null }),
  );
  assert.equal(noCoords.reason, "no_coordinates");

  // Junk inputs: a reason, never a throw.
  assert.equal(panelRectangles(null).reason, "no_coordinates");
  assert.equal(panelRectangles("junk").reason, "no_coordinates");
  assert.equal(
    panelRectangles(diagramRoof({ panels_raw: "junk" })).reason,
    "no_panel_positions",
  );
});

test("diagram: roofDiagramView — drawable google row", () => {
  const view = roofDiagramView(emptyJob({ roof_geometry: [diagramRoof()] }));
  assert.equal(view.show, true);
  assert.equal(view.reason, null);
  assert.equal(view.tileLat, -34.9258552, "tile centred on building_center");
  assert.equal(view.tileLng, 138.6471519);
  assert.ok(view.zoom >= 17 && view.zoom <= 21 && Number.isInteger(view.zoom));
  assert.equal(view.rects.length, 3);
  assert.equal(view.panelCount, 3);
  assert.equal(view.panelWidthM, 1.045);
  assert.equal(view.panelHeightM, 1.879);
  assert.equal(view.panelCapacityW, 400);
  assert.ok(view.buildingBox !== null);
  const box = view.buildingBox!;
  assert.ok(box.width > 0 && box.height > 0);
  assert.ok(box.x >= 0 && box.x + box.width <= 640);
  assert.ok(box.y >= 0 && box.y + box.height <= 360);
  // Every drawn number is finite — a NaN in an SVG attribute renders nothing.
  for (const r of view.rects) {
    assert.ok(
      [r.cx, r.cy, r.widthPx, r.heightPx, r.rotationDeg].every(Number.isFinite),
    );
  }
});

test("diagram: roofDiagramView — dimensions_not_stored still shows the building box", () => {
  const view = roofDiagramView(
    emptyJob({
      roof_geometry: [
        diagramRoof({
          google_panel_width_m: null,
          google_panel_height_m: null,
          google_panel_capacity_w: null,
        }),
      ],
    }),
  );
  assert.equal(view.show, true);
  assert.equal(view.reason, "dimensions_not_stored");
  assert.deepEqual(view.rects, []);
  assert.ok(view.buildingBox !== null, "the measured extent still draws");
});

test("diagram: roofDiagramView hides for manual, not-found, expired, junk", () => {
  const manual = roofDiagramView(
    emptyJob({ roof_geometry: [diagramRoof({ source: "manual_plans" })] }),
  );
  assert.equal(manual.show, false, "a manual roof has no Google layout and no diagram");

  const notFound = roofDiagramView(
    emptyJob({
      roof_geometry: [diagramRoof({ found: false, source: null, planes: [] })],
    }),
  );
  assert.equal(notFound.show, false);

  const expired = roofDiagramView(
    emptyJob({
      roof_geometry: [diagramRoof({ solar_data_captured_at: daysAgo(31) })],
    }),
  );
  assert.equal(expired.show, false, "never draw a box from deleted data");
  const tombstoned = roofDiagramView(
    emptyJob({
      roof_geometry: [diagramRoof({ solar_data_expired_at: daysAgo(1) })],
    }),
  );
  assert.equal(tombstoned.show, false);

  assert.equal(roofDiagramView(null).show, false);
  assert.equal(roofDiagramView(emptyJob()).show, false);
  assert.equal(roofDiagramView({ roof_geometry: "junk" }).show, false);
});

test("diagram STEP 1: absolute projection matches an independently computed Mercator", () => {
  // The centre-lands-at-(320,180) check CANNOT catch a sign error in the y
  // formula: tilePixel subtracts two identical projections, so any monotonic
  // corruption cancels exactly. Only an ABSOLUTE assertion, against the
  // formula written out again here, can — this is the red-proof target.
  const zoom = 19;
  const size = 256 * 2 ** zoom;
  const latRad = (DIAG_LAT * Math.PI) / 180;
  const xExpected = ((DIAG_LNG + 180) / 360) * size;
  const yExpected =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    size;
  const p = projectWebMercator(DIAG_LAT, DIAG_LNG, zoom);
  assert.ok(p !== null);
  assert.equal(p.x, xExpected);
  assert.equal(p.y, yExpected);
  assert.equal(worldSizePx(zoom), size);
});

test("diagram: tile scale sharpens pixels only — viewBox and projection are scale-blind", () => {
  // scale=2 doubles pixel density at the SAME ground coverage. If scale ever
  // reached the geometry, the overlay would silently shift against the
  // sharper tile. Guarded two ways: the constants the viewBox is built from
  // stay 640x360, and NO projection function accepts a scale argument — the
  // arity assertions fail if anyone threads one through.
  assert.ok(Number.isInteger(TILE_IMG_SCALE) && TILE_IMG_SCALE >= 1 && TILE_IMG_SCALE <= 2);
  assert.equal(TILE_W, 640);
  assert.equal(TILE_H, 360);
  assert.equal(worldSizePx.length, 1, "worldSizePx(zoom) — no scale");
  assert.equal(projectWebMercator.length, 3, "projectWebMercator(lat,lng,zoom) — no scale");
  assert.equal(metresPerPixel.length, 2, "metresPerPixel(lat,zoom) — no scale");
  assert.equal(tilePixel.length, 5, "tilePixel(lat,lng,cLat,cLng,zoom) — no scale");
  assert.equal(fitZoomForBuilding.length, 2, "fitZoomForBuilding(bbox,centre) — no scale");
  assert.equal(panelRectangles.length, 1, "panelRectangles(row) — no scale");
  assert.equal(roofDiagramView.length, 1, "roofDiagramView(job) — no scale");
  // And the produced geometry carries no trace of the scale value: the same
  // fixture projects to the same rectangles whatever the request's pixel
  // density, because nothing here can even see it.
  const a = panelRectangles(diagramRoof());
  const b = panelRectangles(diagramRoof());
  assert.deepEqual(a, b);
  assert.equal(a.reason, null);
});

// ── Notice hierarchy (3.6 prompt 2, D25) + Energy data ───────────────────────
//
// D25: notices split on SPECIFICITY. `level` is REQUIRED on RoofNoticeView so
// every producer states it; these checks prove it structurally by CALLING the
// producers across their input space — a source grep would pass on a
// commented-out field.

const REAL_FLAGS = {
  annualised: "4 months of data (120 days) — annualised to a full year.",
  gaps: "3 day gap(s) within the period — filled with the average-day profile and excluded from coverage.",
  substituted:
    "97.5% of intervals are actual reads; the remainder are substituted/estimated (still used).",
  solar:
    "Solar export channel(s) B1 present — automatically excluded (load profile uses consumption only).",
  nmis: "Multiple NMIs in file (6001234567, 6007654321) — used 6001234567.",
  csv: "Generic CSV (long layout) — assumed to be consumption (import). If it contains solar export, remove that column before upload.",
};

function uploadResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    load: { accuracy_tier: 3, confidence_pct: 92 },
    metadata: {
      coverage_days: 372,
      resolution_minutes: 30,
      pct_actual: 99.8,
      period_start: "2025-01-01",
      period_end: "2026-01-07",
      nmi: "6001234567",
    },
    persisted: true,
    load_profile_saved: true,
    accuracy_tier_written: 3,
    flags: [],
    ...over,
  };
}

const intervalRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  created_at: "2026-08-17T01:00:00Z",
  nmi: "6001234567",
  source: "NEM12",
  period_start: "2025-01-01T00:00:00+00:00",
  period_end: "2026-01-07T00:00:00+00:00",
  ...over,
});

test("D25 check 1: every producer sets level, proven structurally", () => {
  const collected: unknown[] = [];
  const roofJobs = [
    emptyJob({ roof_geometry: [googleRoof()] }),
    emptyJob({ roof_geometry: [roofRow({ found: false, source: null, planes: [] })] }),
    emptyJob({
      roof_geometry: [
        googleRoof({
          low_confidence: true,
          imagery_stale: true,
          flags: [
            "low_confidence_implausible_pitch",
            "low_confidence_no_google_panel_layout",
            "low_confidence_too_few_segments",
            "low_confidence_never_seen_before_cause",
          ],
        }),
      ],
    }),
    emptyJob({ roof_geometry: [roofRow({ source: "manual_plans" })] }),
    emptyJob({ roof_geometry: [roofRow({ source: "manual_site_measure" })] }),
    emptyJob({ roof_geometry: [roofRow({ source: "manual_estimate" })] }),
    emptyJob({
      roof_geometry: [googleRoof({ solar_data_captured_at: daysAgo(31) })],
    }),
  ];
  for (const job of roofJobs) {
    const view = addressRoofView(job);
    collected.push(view.notice, view.staleNotice, view.solarExpiredNotice);
    collected.push(...view.confidenceNotices);
  }
  collected.push(MULTI_DWELLING_CAPTION, PREFILL_FROM_LOOKUP_CAPTION);
  collected.push(
    ...energyDataView(emptyJob({ interval_data: [intervalRow()] })).notices,
  );
  collected.push(
    ...intervalUploadView(
      uploadResponse({ flags: [...Object.values(REAL_FLAGS), "novel flag"] }),
    ).notices,
  );
  const present = collected.filter((n) => n !== null && n !== undefined);
  assert.ok(present.length >= 15, `only ${present.length} notices collected`);
  for (const n of present) {
    const level = (n as { level?: unknown }).level;
    assert.ok(
      level === "notice" || level === "caption",
      `missing/invalid level on ${JSON.stringify(n)}`,
    );
  }
});

test("D25 check 2: the roof reclassification, item by item", () => {
  const stale = addressRoofView(
    emptyJob({ roof_geometry: [googleRoof()] }),
  ).staleNotice;
  assert.equal(stale?.level, "caption", "stale imagery fires on 100% of jobs");
  assert.equal(stale?.icon, "clock", "an age fact carries the clock glyph");

  const conf = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({
          low_confidence: true,
          flags: [
            "low_confidence_implausible_pitch",
            "low_confidence_no_google_panel_layout",
            "low_confidence_too_few_panels",
            "low_confidence_unrecognised_thing",
          ],
        }),
      ],
    }),
  );
  assert.ok(conf.confidenceNotices.length === 4);
  for (const n of conf.confidenceNotices) {
    assert.equal(n.level, "notice", `${n.title} must stay a bordered notice`);
  }
  assert.equal(conf.notice?.level, "notice", "low_confidence state stays a notice");

  const notFound = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ found: false, source: null, planes: [] })] }),
  );
  assert.equal(notFound.notice?.level, "notice", "not_found CAN not fire — a finding");

  const expired = addressRoofView(
    emptyJob({ roof_geometry: [googleRoof({ solar_data_captured_at: daysAgo(31) })] }),
  );
  assert.equal(expired.solarExpiredNotice?.level, "notice");

  // The four success states are method facts — captions (agrees with D24).
  for (const source of ["manual_plans", "manual_site_measure", "manual_estimate"]) {
    const v = addressRoofView(emptyJob({ roof_geometry: [roofRow({ source })] }));
    assert.equal(v.notice?.level, "caption", `${source} tick goes quiet`);
  }
  const found = addressRoofView(emptyJob({ roof_geometry: [googleRoof()] }));
  assert.equal(found.notice?.level, "caption", "'Roof found' goes quiet");

  assert.equal(MULTI_DWELLING_CAPTION.level, "caption");
  assert.equal(PREFILL_FROM_LOOKUP_CAPTION.level, "caption");
});

test("D25 check 3: energyDataView is total and newest-wins", () => {
  assert.equal(energyDataView({}).state, "empty");
  assert.equal(energyDataView(null).state, "empty");
  assert.equal(energyDataView(emptyJob({ interval_data: "nope" })).state, "empty");

  const outOfOrder = energyDataView(
    emptyJob({
      interval_data: [
        intervalRow({ created_at: "2026-08-17T09:00:00Z", nmi: "NEWEST" }),
        intervalRow({ created_at: "2026-08-01T09:00:00Z", nmi: "OLDEST" }),
      ],
    }),
  );
  assert.equal(outOfOrder.nmi, "NEWEST", "newest by created_at wins, not array order");

  const noProfile = energyDataView(emptyJob({ interval_data: [intervalRow()] }));
  assert.equal(noProfile.state, "have_interval");
  assert.equal(noProfile.tier, null, "a file's presence NEVER implies Tier 3");
  assert.ok(
    noProfile.notices.some((n) => n.level === "notice"),
    "the missing profile is a visible finding",
  );

  const withProfile = energyDataView(
    emptyJob({
      interval_data: [intervalRow()],
      load_profiles: [{ job_id: "j", accuracy_tier: 3, confidence_pct: 92 }],
    }),
  );
  assert.equal(withProfile.tier, 3);
});

test("D25 check 4: intervalUploadView across every shape", () => {
  const good = intervalUploadView(uploadResponse());
  assert.equal(good.ok, true);
  assert.deepEqual(good.readoutParts, [
    "17,856 half-hours",
    "372 days",
    "0.2% filled",
    "Tier 3",
  ]);

  const failed = intervalUploadView({
    ok: false,
    error: "No consumption (E) channel found in this NEM12 file.",
    suggest_tier2_fallback: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "No consumption (E) channel found in this NEM12 file.");
  assert.deepEqual(failed.readoutParts, []);

  const noMeta = intervalUploadView({ ok: true, load: { accuracy_tier: 3 } });
  assert.deepEqual(noMeta.readoutParts, ["Tier 3"], "no metadata -> no invented figures");

  const noPct = intervalUploadView(
    uploadResponse({
      metadata: { coverage_days: 372, resolution_minutes: 30 },
    }),
  );
  assert.ok(
    !noPct.readoutParts.some((p) => p.includes("filled")),
    `missing pct_actual must OMIT the filled figure, got ${JSON.stringify(noPct.readoutParts)}`,
  );

  assert.equal(intervalUploadView(undefined).ok, false);
  assert.equal(intervalUploadView("junk").ok, false);
});

test("D25 check 5: the six real parser flags land on the decided side; unknown -> NOTICE", () => {
  const view = intervalUploadView(
    uploadResponse({ flags: [...Object.values(REAL_FLAGS), "a brand new flag"] }),
  );
  const byBody = (body: string) => view.notices.find((n) => n.body === body);
  assert.equal(byBody(REAL_FLAGS.annualised)?.level, "notice", "annualised: THIS file is short");
  assert.equal(byBody(REAL_FLAGS.gaps)?.level, "notice", "gaps: THIS file has gaps");
  assert.equal(byBody(REAL_FLAGS.nmis)?.level, "notice", "multiple NMIs: the F99 class");
  assert.equal(byBody(REAL_FLAGS.solar)?.level, "caption", "solar exclusion: method fact");
  assert.equal(byBody(REAL_FLAGS.csv)?.level, "caption", "generic CSV: method fact");
  // Item 0 (3.6 prompt 3): CORRECTED from "caption". The flag only fires when
  // THIS file has substituted reads — 100%-actual files produce no flag — so by
  // D25's question it is a finding. Prompt 2 classified it quiet in error.
  const substituted = byBody(REAL_FLAGS.substituted);
  assert.equal(substituted?.level, "notice", "substituted reads: a finding about THIS file");
  assert.equal(substituted?.tone, "caution");
  assert.ok(
    typeof substituted?.title === "string" && substituted.title.length > 0,
    "a notice needs a real title — the caption form had an empty one",
  );
  assert.equal(byBody("a brand new flag")?.level, "notice", "unknown NEVER defaults to quiet");
  // D25 ordering inside the returned array: findings before captions.
  const levels = view.notices.map((n) => n.level);
  assert.ok(
    levels.lastIndexOf("notice") < levels.indexOf("caption"),
    `findings must sort above captions: ${levels.join(",")}`,
  );
});

test("D25 check 6: the tier is an integer — 'tier_3' never becomes 3 (C10)", () => {
  const stringTier = intervalUploadView(
    uploadResponse({ load: { accuracy_tier: "tier_3" } }),
  );
  assert.equal(stringTier.tier, null);
  assert.ok(!stringTier.readoutParts.some((p) => p.startsWith("Tier")));
  const storedString = energyDataView(
    emptyJob({
      interval_data: [intervalRow()],
      load_profiles: [{ job_id: "j", accuracy_tier: "tier_3" }],
    }),
  );
  assert.equal(storedString.tier, null);
});

test("D25 check 7: postFormData sets NO Content-Type header", async () => {
  const original = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const form = new FormData();
    form.append("job_id", "j1");
    const result = await postFormData<{ ok: boolean }>("/api/interval/upload", form);
    assert.equal(result.ok, true);
    assert.ok(captured, "fetch was called");
    // No headers at all: the browser derives the multipart boundary itself.
    // Setting Content-Type by hand omits the boundary and the server silently
    // fails to parse the form.
    assert.equal(captured?.headers, undefined, "no headers object may be passed");
    assert.ok(captured?.body instanceof FormData, "the FormData is the body");
  } finally {
    globalThis.fetch = original;
  }
});

// ── D5: an OPTIONAL section must not gate the worksheet (2026-08-18) ─────────
//
// The defect these checks exist to catch: site-details' predicate requires four
// fields that are NULL on all six live jobs, so it was `firstIncomplete` on
// every job, became the ACTIVE section, and LOCKED the entire Demand phase —
// while its own on-screen caption promised "None of this is needed to size the
// job". A locked section renders no <summary>, so Energy data could not be
// opened by mouse OR keyboard on any real job.

/** The live shape: a usable roof, and all four site-detail fields NULL. */
function liveShapedJob(over: Partial<JobDetailLike> = {}): JobDetailLike {
  return emptyJob({
    roof_geometry: [
      {
        created_at: "2026-08-14T05:00:00Z",
        found: true,
        source: "google_solar",
        planes: [{ panel_count: 17, kwp: 7.48 }],
      },
    ],
    storeys: null,
    roof_material: null,
    dwelling_type: null,
    electrical_phase: null,
    ...over,
  });
}

const stateOf = (states: readonly { id: string; state: string }[], id: string) =>
  states.find((s) => s.id === id)?.state;

test("D5 check 1: THE REAL CASE — optional Site details does not lock Demand", () => {
  const states = sectionStates(liveShapedJob());
  assert.equal(stateOf(states, "address-roof"), "complete");
  assert.equal(stateOf(states, "site-details"), "unlocked");
  assert.equal(
    stateOf(states, "energy-data"),
    "active",
    "Energy data is what the installer should be on — this is the check that would have caught the defect",
  );
  assert.equal(stateOf(states, "tariff-network"), "locked");
});

test("D5 check 2: Site details is NEVER 'active', for any input", () => {
  const inputs: JobDetailLike[] = [
    emptyJob(),                                            // nothing at all
    liveShapedJob(),                                       // no fields
    liveShapedJob({ storeys: 1 }),                         // one field
    liveShapedJob({ storeys: 1, roof_material: "tile", dwelling_type: "unit" }), // three of four
    liveShapedJob({
      storeys: 1, roof_material: "tile", dwelling_type: "unit", electrical_phase: "single",
    }),                                                    // all four
  ];
  for (const job of inputs) {
    assert.notEqual(
      stateOf(sectionStates(job), "site-details"),
      "active",
      JSON.stringify({ storeys: job.storeys, phase: job.electrical_phase }),
    );
  }
});

test("D5 check 3: Site details is NEVER 'locked', for any input", () => {
  const inputs: JobDetailLike[] = [
    emptyJob(),                                  // Address & roof is the active one
    liveShapedJob(),
    emptyJob({ roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: false, planes: [] }] }),
    liveShapedJob({ storeys: 2 }),
  ];
  for (const job of inputs) {
    assert.notEqual(
      stateOf(sectionStates(job), "site-details"),
      "locked",
      "an optional section must always be openable",
    );
  }
});

test("D5 check 4: every GATING section keeps today's behaviour exactly", () => {
  // The PRE-CHANGE rule, reimplemented here as a reference, so "unchanged" is a
  // comparison and not an assertion of faith. This is deliberately the old
  // sequential logic verbatim.
  function referenceStates(job: unknown): { id: string; state: string }[] {
    const detail = (typeof job === "object" && job !== null ? job : {}) as JobDetailLike;
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
    return visible.map((section, i) => ({
      id: section.id,
      state: done[i]
        ? "complete"
        : i === firstIncomplete
          ? "active"
          : anyLaterComplete
            ? "unlocked"
            : "locked",
    }));
  }

  // The reference rule has NO concept of `gates`, so it can only be expected
  // to agree on the GATING sections — which is exactly what this test's title
  // claims and all it should ever have asserted. Comparing non-gating sections
  // against a gates-unaware reference asserts something false: it demands that
  // the flag have no effect on the very sections it exists to change. (This
  // read whole-catalogue while site-details was the only non-gating section
  // and it happened to be complete in this fixture; 3.10's equipment-specs
  // made the hidden assumption visible.)
  const gatingIds = new Set(
    SECTIONS.filter((s) => s.gates !== false).map((s) => s.id),
  );
  const onlyGating = (rows: { id: string; state: string }[]) =>
    rows.filter((r) => gatingIds.has(r.id));

  const filled = liveShapedJob({
    storeys: 1, roof_material: "tile", dwelling_type: "unit", electrical_phase: "single",
  });
  assert.deepEqual(
    onlyGating(sectionStates(filled).map((s) => ({ id: s.id, state: s.state }))),
    onlyGating(referenceStates(filled)),
    "on every GATING section, the new rule and the old rule agree exactly",
  );

  // With it EMPTY, the ONLY differences allowed are site-details itself and the
  // sections the defect was wrongly locking. Every gating section's state is
  // checked against a hand-derived expectation:
  //   address-roof complete -> the first incomplete GATING section is energy-data
  //   -> energy-data active, everything gating below it locked.
  const empty = liveShapedJob();
  assert.deepEqual(
    sectionStates(empty).map((s) => ({ id: s.id, state: s.state })),
    [
      { id: "address-roof", state: "complete" },
      { id: "site-details", state: "unlocked" },
      { id: "energy-data", state: "active" },
      { id: "tariff-network", state: "locked" },
      { id: "objective-budget", state: "locked" },
      // 3.10: non-gating, so unlocked rather than locked — openable early,
      // and it locks nothing beneath it.
      { id: "equipment-specs", state: "unlocked" },
      { id: "solar-sizing", state: "locked" },
      { id: "battery-sizing", state: "locked" },
      { id: "results", state: "locked" },
      { id: "incentives", state: "locked" },
      { id: "summary-finish", state: "locked" },
    ],
  );
  // ...and EXACTLY THREE sections differ from the old rule, all of them
  // accounted for: the optional section itself (active -> unlocked), the one
  // that should have been active all along (locked -> active), and 3.10's
  // second non-gating section (locked -> unlocked). Everything else was
  // already locked under both rules and stays locked, so the change is
  // narrower than it looks: the sections beneath are unlocked by DOING the
  // work, not by these flags. The reference rule above has no concept of
  // `gates`, which is exactly why it diverges on precisely the non-gating
  // sections and nowhere else.
  const before = referenceStates(empty);
  const after = sectionStates(empty).map((s) => ({ id: s.id, state: s.state }));
  const moved = after
    .filter((a, i) => a.state !== before[i].state)
    .map((a) => `${a.id}: ${before[after.indexOf(a)].state} -> ${a.state}`);
  assert.deepEqual(moved, [
    "site-details: active -> unlocked",
    "energy-data: locked -> active",
    "equipment-specs: locked -> unlocked",
  ]);
});

test("D5 check 5: all gating complete + Site details empty -> unlocked, NOT complete", () => {
  const allDone = liveShapedJob({
    bills: [{ bill_id: "b1" }],
    tariffs: [{ tariff_id: "t1" }],
    sizing_results: [{ solar_kw: 6.6, battery_kwh: 10 }],
    financial_results: [{ payback_years: 7 }],
    status: "sized",
  });
  const states = sectionStates(allDone);
  assert.equal(
    stateOf(states, "site-details"),
    "unlocked",
    "it has NOT been filled in and must never inherit the all-complete shortcut",
  );
  assert.notEqual(stateOf(states, "site-details"), "complete");
});

test("D5 check 6: `gates` absent means GATING — the default is the safe one", () => {
  // A section that omits the field must still lock what follows. Asserted on a
  // local spec array so the real catalogue is untouched.
  const specs: WorksheetSectionSpec[] = [
    { id: "a", title: "A", phase: "site", builtAt: "x", complete: () => true },
    { id: "b", title: "B", phase: "site", builtAt: "x", complete: () => false }, // no `gates`
    { id: "c", title: "C", phase: "demand", builtAt: "x", complete: () => false },
  ];
  assert.equal(specs[1].gates, undefined, "the fixture really does omit the field");
  // Mirrors sectionStates' rule over this array: b gates (absent = true), so it
  // is first-incomplete -> active, and c locks behind it.
  const gates = specs.map((s) => s.gates !== false);
  assert.deepEqual(gates, [true, true, true]);
  // And the catalogue itself: exactly TWO sections are non-gating — D5's
  // site-details and, from 3.10, equipment-specs. Every other section must
  // still gate, which is what makes the permissive default safe.
  const nonGating = SECTIONS.filter((s) => s.gates === false).map((s) => s.id);
  assert.deepEqual(nonGating, ["site-details", "equipment-specs"]);
  for (const s of SECTIONS) {
    if (s.id !== "site-details" && s.id !== "equipment-specs") {
      assert.notEqual(s.gates, false, `${s.id} must keep gating`);
    }
  }
});

test("D5 check 7: junk inputs behave as before — no throw, shape unchanged", () => {
  for (const junk of [null, undefined, "x", 42, [], { path: "ZZZ" }]) {
    const states = sectionStates(junk);
    assert.ok(Array.isArray(states), `${String(junk)} returned a non-array`);
    assert.equal(states.length, 11, `${String(junk)} changed the visible count`);
    for (const s of states) {
      assert.ok(
        ["locked", "active", "complete", "unlocked"].includes(s.state),
        `${s.id} -> ${s.state}`,
      );
    }
    assert.doesNotThrow(() => phaseStates(junk));
  }
});

test("D5 check 8: the phase rail for the real case is coherent", () => {
  // Site's GATING work (the roof) is done, so the node ticks; the optional
  // section still shows no tick of its own. Demand holds the active section.
  // Before this fix the rail read ["current", "pending", ...] with Demand
  // unreachable; it must never regress to Site "pending" while Demand is
  // "current", which would read as a phase that was never started.
  assert.deepEqual(phaseStates(liveShapedJob()), ["done", "current", "pending", "pending"]);
  // A fresh job is unchanged: Site is where the work is.
  assert.deepEqual(phaseStates(emptyJob()), ["current", "pending", "pending", "pending"]);
  // Filling the optional fields changes no phase state.
  assert.deepEqual(
    phaseStates(
      liveShapedJob({
        storeys: 1, roof_material: "tile", dwelling_type: "unit", electrical_phase: "single",
      }),
    ),
    ["done", "current", "pending", "pending"],
  );
});

// ── Bill + survey + preview + tier step-down (3.6 prompt 3) ──────────────────

function billResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    parsed: {
      total_kwh: 8240,
      billing_period_days: 91,
      daily_avg_kwh: 90.5,
      retailer: "Origin Energy",
      property_address: "14 Frome St, Adelaide SA 5000, Australia",
      tariff_structured: { tariff_type: "tou" },
      parse_confidence: { total_kwh: 0.95, billing_period_days: 0.9 },
      ...((over.parsed as Record<string, unknown>) ?? {}),
    },
    raw_file_path: "bills/x.pdf",
    bill_id: "b1",
    persisted: true,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "parsed")),
  };
}

test("3.6/3 check 2: billAddressCheck is quiet unless there is positive evidence", () => {
  // a. formatting-only differences -> match
  assert.equal(
    billAddressCheck(
      "14 Frome St, Adelaide SA 5000, Australia",
      "14 FROME STREET ADELAIDE 5000",
    ),
    "match",
  );
  // b. different street number -> different_property
  assert.equal(
    billAddressCheck("16 Frome St, Adelaide SA 5000", "14 Frome St, Adelaide SA 5000"),
    "different_property",
  );
  // c. different postcode -> different_property
  assert.equal(
    billAddressCheck("14 Frome St, Adelaide SA 5000", "14 Frome St, Unley SA 5061"),
    "different_property",
  );
  // d. bill address null / empty / unparseable -> cannot_tell
  assert.equal(billAddressCheck(null, "14 Frome St, Adelaide SA 5000"), "cannot_tell");
  assert.equal(billAddressCheck("", "14 Frome St, Adelaide SA 5000"), "cannot_tell");
  assert.equal(
    billAddressCheck("the corner shop", "14 Frome St, Adelaide SA 5000"),
    "cannot_tell",
  );
  // e. job address missing a postcode -> cannot_tell
  assert.equal(
    billAddressCheck("14 Frome St, Adelaide SA 5000", "14 Frome St, Adelaide"),
    "cannot_tell",
  );
  // f. a unit number on one side only -> cannot_tell, NOT a mismatch
  assert.equal(
    billAddressCheck(
      "Unit 5/53 Bishops Pl, Kensington SA 5068",
      "53 Bishops Pl, Kensington SA 5068",
    ),
    "cannot_tell",
  );
  // g. a notice ONLY for different_property
  assert.notEqual(billAddressNotice("different_property"), null);
  assert.equal(billAddressNotice("match"), null);
  assert.equal(billAddressNotice("cannot_tell"), null);
  assert.equal(billAddressNotice("different_property")?.level, "notice");
});

test("3.6/3 check 3: parse_confidence absent -> ZERO notices; low -> named; high -> none", () => {
  const absent = billParseView(
    billResponse({ parsed: { parse_confidence: undefined } }),
  );
  assert.equal(
    absent.notices.filter((n) => n.title === "This bill was unclear").length,
    0,
    "absent is unknown — an unknown must not render as a failure",
  );
  const low = billParseView(
    billResponse({ parsed: { parse_confidence: { total_kwh: 0.3 } } }),
  );
  const lowNotices = low.notices.filter((n) => n.title === "This bill was unclear");
  assert.equal(lowNotices.length, 1);
  assert.ok(lowNotices[0].body.includes("total usage"), lowNotices[0].body);
  const high = billParseView(billResponse());
  assert.equal(
    high.notices.filter((n) => n.title === "This bill was unclear").length,
    0,
  );
  // The readout derives from what was parsed.
  assert.deepEqual(high.readoutParts, [
    "8,240 kWh over 91 days",
    "Origin Energy",
    "time of use",
  ]);
  // ok:false passes the backend's own error through; junk never throws.
  assert.equal(billParseView({ ok: false, error: "X" }).error, "X");
  assert.equal(billParseView(undefined).ok, false);
  assert.equal(billParseView("junk").ok, false);
});

test("3.6/3 check 4: THE FLAT PROFILE — flat flag true, peak NULL, never a window", () => {
  const flat = loadPreviewView(Array.from({ length: 24 }, () => 1.0));
  assert.equal(flat.ok, true);
  assert.equal(flat.flat, true);
  assert.equal(flat.peak, null, "a peak derived from a flat line is a fabrication");
  assert.ok(flat.ariaLabel.includes("no daily shape"), flat.ariaLabel);
});

test("3.6/3 check 5: a genuine evening peak returns the right window", () => {
  const weights = Array.from({ length: 24 }, () => 0.8);
  weights[18] = 2.5;
  weights[19] = 3.0;
  weights[20] = 2.5;
  const view = loadPreviewView(weights);
  assert.equal(view.flat, false);
  assert.ok(view.peak !== null);
  assert.equal(view.peak.startHour, 18);
  assert.equal(view.peak.endHour, 20);
  assert.equal(view.peak.label, "6pm to 9pm");
  assert.ok(view.ariaLabel.includes("6pm to 9pm"), view.ariaLabel);
});

test("3.6/3 check 6: isFlatProfile tolerance read from the module, not duplicated", () => {
  const exactly = Array.from({ length: 24 }, () => 1.0);
  assert.equal(isFlatProfile(exactly), true);
  // Within tolerance: spread strictly inside the module's own constant.
  const inside = exactly.map((w, i) => (i % 2 === 0 ? w + FLAT_PROFILE_TOLERANCE * 0.45 : w - FLAT_PROFILE_TOLERANCE * 0.45));
  assert.equal(isFlatProfile(inside), true, `spread ${FLAT_PROFILE_TOLERANCE * 0.9} must be flat`);
  // Just outside: spread just past it.
  const outside = exactly.map((w, i) => (i % 2 === 0 ? w + FLAT_PROFILE_TOLERANCE * 0.6 : w - FLAT_PROFILE_TOLERANCE * 0.6));
  assert.equal(isFlatProfile(outside), false, `spread ${FLAT_PROFILE_TOLERANCE * 1.2} must not be flat`);
});

test("3.6/3 check 7: malformed profiles render NOTHING, never throw", () => {
  const cases: unknown[] = [
    Array.from({ length: 23 }, () => 1),
    Array.from({ length: 25 }, () => 1),
    [...Array.from({ length: 23 }, () => 1), "x"],
    null,
    undefined,
    { hourly_profile_weights: "junk" },
    42,
  ];
  for (const bad of cases) {
    const view = loadPreviewView(bad);
    assert.equal(view.ok, false, JSON.stringify(bad)?.slice(0, 40));
    assert.deepEqual(view.bars, []);
    assert.equal(view.peak, null);
  }
  // And the object form works when valid.
  assert.equal(
    loadPreviewView({ hourly_profile_weights: Array.from({ length: 24 }, () => 1) }).ok,
    true,
  );
});

test("3.6/3 check 9: every NEW notice producer sets level, structurally", () => {
  const collected: unknown[] = [
    ...billParseView(
      billResponse({
        parsed: {
          parse_confidence: { total_kwh: 0.1, retailer: 0.2 },
          billing_period_days: 30,
        },
      }),
    ).notices,
    billAddressNotice("different_property"),
  ];
  const present = collected.filter((n) => n !== null && n !== undefined);
  assert.ok(present.length >= 4, `${present.length} collected`);
  for (const n of present) {
    const level = (n as { level?: unknown }).level;
    assert.ok(level === "notice" || level === "caption", JSON.stringify(n));
  }
  // The thin-period finding fires under the threshold and not over it.
  const thin = billParseView(billResponse({ parsed: { billing_period_days: 45 } }));
  assert.ok(thin.notices.some((n) => n.title === "A short billing period"));
  const fine = billParseView(billResponse({ parsed: { billing_period_days: 91 } }));
  assert.ok(!fine.notices.some((n) => n.title === "A short billing period"));
});

test("3.6/3 check 10: option values are routes/load.py's own strings, exactly", () => {
  assert.deepEqual([...SURVEY_OPTIONS.householdSize], ["1", "2", "3-4", "5+"]);
  assert.deepEqual(
    [...SURVEY_OPTIONS.occupancy],
    ["always_home", "away_weekdays", "shift_work"],
  );
  assert.deepEqual(
    [...SURVEY_OPTIONS.hotWater],
    ["electric_storage", "heat_pump", "gas", "solar_hws"],
  );
  assert.deepEqual([...SURVEY_OPTIONS.appliances], ["ev", "pool_pump", "ducted_ac"]);
  assert.deepEqual(
    [...SURVEY_OPTIONS.tariffType],
    ["single_rate", "tou", "demand", "not_sure"],
  );
  // The payload maps to the backend's snake_case field names verbatim.
  const payload = surveyPayload(
    {
      householdSize: "3-4",
      occupancy: "away_weekdays",
      hotWater: "heat_pump",
      appliances: ["ev"],
      tariffType: "tou",
    },
    { dailyAvgKwh: 12.5 },
  );
  assert.deepEqual(payload, {
    household_size: "3-4",
    occupancy: "away_weekdays",
    hot_water: "heat_pump",
    appliances: ["ev"],
    tariff_type: "tou",
    annual_kwh: null,
    daily_avg_kwh: 12.5,
  });
  assert.equal(
    surveyComplete({
      householdSize: "1", occupancy: "always_home", hotWater: "gas",
      appliances: [], tariffType: "not_sure",
    }),
    true,
    "an EMPTY appliance list is an answered 'none of these' (D26)",
  );
  // surveyView prefills from the stored row and never throws on junk.
  const prefill = surveyView(
    emptyJob({
      surveys: [
        { created_at: "2026-08-18T00:00:00Z", household_size: "2",
          occupancy_pattern: "shift_work", hot_water_type: "gas",
          has_ev: true, has_pool: false },
      ],
    }),
  );
  assert.equal(prefill.householdSize, "2");
  assert.deepEqual(prefill.appliances, ["ev"]);
  // D26: an untouched appliances control is NULL (unanswered), never a
  // fabricated empty answer — [] would silently complete the survey.
  assert.equal(surveyView(null).appliances, null);
});

// ── D26: the tier model the engine actually implements ───────────────────────
//
// ROUTE_TIERS mapped a ROUTE to a tier; that model does not exist in
// routes/load.py. These checks pin the real one: interval → 3; a usage figure
// is MANDATORY (none → 422, so NO tier); figure + all five answers → 2;
// figure alone → 1 with a flat profile.

const FULL_ANSWERS = {
  householdSize: "3-4",
  occupancy: "away_weekdays",
  hotWater: "heat_pump",
  appliances: ["ev"],
  tariffType: "tou",
};

test("D26 check 1: tierFor mirrors load.py's four branches, in order", () => {
  assert.equal(
    tierFor({
      hasIntervalProfile: true,
      usageKwh: null,
      usageSource: "interval",
      surveyComplete: false,
    }),
    3,
    "an interval profile short-circuits everything, even with nothing else",
  );
  assert.equal(
    tierFor({
      hasIntervalProfile: false,
      usageKwh: 8240,
      usageSource: "bill",
      surveyComplete: true,
    }),
    2,
  );
  assert.equal(
    tierFor({
      hasIntervalProfile: false,
      usageKwh: 8240,
      usageSource: "typed",
      surveyComplete: false,
    }),
    1,
  );
  assert.equal(
    tierFor({
      hasIntervalProfile: false,
      usageKwh: null,
      usageSource: null,
      surveyComplete: false,
    }),
    null,
    "no usage figure -> the engine answers 422 — NULL, never a Tier 1 floor",
  );
});

test("D26 check 2: THE APPLIANCES TRAP — [] completes, undefined does not", () => {
  // `appliances is not None` in load.py: an empty list IS an answer.
  const noneOfThese = { ...FULL_ANSWERS, appliances: [] };
  assert.equal(surveyComplete(noneOfThese), true);
  assert.equal(
    tierFor({
      hasIntervalProfile: false,
      usageKwh: 8240,
      usageSource: "bill",
      surveyComplete: surveyComplete(noneOfThese),
    }),
    2,
    "no EV and no pool must still reach Tier 2",
  );
  const untouched = { ...FULL_ANSWERS, appliances: null };
  assert.equal(surveyComplete(untouched), false);
  assert.equal(
    tierFor({
      hasIntervalProfile: false,
      usageKwh: 8240,
      usageSource: "bill",
      surveyComplete: surveyComplete(untouched),
    }),
    1,
  );
});

test("D26 check 3: surveyComplete false when any ONE of the five is missing", () => {
  assert.equal(surveyComplete(FULL_ANSWERS), true, "the positive control");
  const drops = [
    ["householdSize", { ...FULL_ANSWERS, householdSize: null }],
    ["occupancy", { ...FULL_ANSWERS, occupancy: null }],
    ["hotWater", { ...FULL_ANSWERS, hotWater: null }],
    ["tariffType", { ...FULL_ANSWERS, tariffType: null }],
    ["appliances", { ...FULL_ANSWERS, appliances: null }],
  ] as const;
  for (const [field, answers] of drops) {
    assert.equal(surveyComplete(answers), false, `${field} missing must fail`);
  }
});

test("D26 check 4: demandStatusLine states what we HAVE and what comes next", () => {
  const tier1 = demandStatusLine({
    hasIntervalProfile: false, usageKwh: 8240, usageSource: "bill", surveyComplete: false,
  });
  assert.equal(tier1.tier, 1);
  assert.ok(tier1.next !== null && tier1.next.includes("five questions"), tier1.next ?? "");

  const tier2 = demandStatusLine({
    hasIntervalProfile: false, usageKwh: 8240, usageSource: "bill", surveyComplete: true,
  });
  assert.equal(tier2.tier, 2);
  assert.ok(tier2.next !== null && tier2.next.toLowerCase().includes("smart-meter"), tier2.next ?? "");

  const tier3 = demandStatusLine({
    hasIntervalProfile: true, usageKwh: null, usageSource: "interval", surveyComplete: false,
  });
  assert.equal(tier3.tier, 3);
  assert.equal(tier3.next, null);

  const nothing = demandStatusLine({
    hasIntervalProfile: false, usageKwh: null, usageSource: null, surveyComplete: false,
  });
  assert.equal(nothing.tier, null);
  assert.ok(nothing.have.toLowerCase().includes("yearly total"), nothing.have);
});

test("D26 check 5: ROUTE_TIERS is GONE — a stale export is how the wrong model returns", () => {
  assert.ok(!("ROUTE_TIERS" in worksheetModule), "ROUTE_TIERS must not be exported");
  assert.ok(
    !("tierStepDownOptions" in worksheetModule),
    "tierStepDownOptions carried the same route→tier model and must be gone too",
  );
});

test("D26 check 6: a typed figure of 0, -1, NaN, Infinity or a string never makes a call", () => {
  for (const bad of [0, -1, NaN, Infinity, "8240"]) {
    const error = typedUsageError(bad);
    assert.ok(
      typeof error === "string" && error.length > 0,
      `${String(bad)} must produce an inline error and no call`,
    );
  }
  assert.equal(typedUsageError(8240), null, "a real positive number passes");
});

test("D26 check 7: the new producers set level explicitly, structurally", () => {
  const produced = [
    usagePlausibilityNotice(worksheetModule.ANNUAL_KWH_PLAUSIBLE_MAX + 1),
    usagePlausibilityNotice(worksheetModule.ANNUAL_KWH_PLAUSIBLE_MIN - 1),
    tierMismatchNotice(2, 1),
  ].filter((n) => n !== null);
  assert.equal(produced.length, 3);
  for (const n of produced) {
    assert.ok(n.level === "notice" || n.level === "caption", JSON.stringify(n));
  }
  // Inside the bounds, and for agreeing tiers: NOTHING — quiet by default.
  assert.equal(usagePlausibilityNotice(8240), null);
  assert.equal(tierMismatchNotice(2, 2), null);
  assert.equal(tierMismatchNotice(null, 1), null);
  assert.equal(tierMismatchNotice(2, null), null);
});

test("D26 check 8: predicted vs recorded — the RECORDED tier wins, loudly", () => {
  const notice = tierMismatchNotice(2, 1);
  assert.ok(notice !== null);
  assert.equal(notice.level, "notice");
  assert.ok(
    notice.body.includes("recorded Tier 1") &&
      notice.body.includes("the one that counts"),
    notice.body,
  );
});

// ── One readout for fresh and stored (3.6 follow-up) ─────────────────────────
//
// The defect: intervalUploadView built the readout from the RESPONSE and
// energyDataView from a ROW whose quality columns were never written — so the
// numbers appeared once and vanished on reload. Both now feed ONE builder.

test("readout check 6: the SAME file reads identically from response and from row", () => {
  // One set of file facts — deliberately WITH GAPS, so the period span (104
  // days) and the coverage (100 days) are different integers and a span-based
  // shortcut cannot masquerade as coverage.
  const facts = {
    coverage_days: 100,
    gap_days: 4,
    pct_actual: 97.5,
    resolution_minutes: 30,
    period_start: "2025-01-01",
    period_end: "2025-04-14",
  };
  const fromResponse = intervalUploadView(
    uploadResponse({
      metadata: {
        coverage_days: facts.coverage_days,
        gap_days: facts.gap_days,
        pct_actual: facts.pct_actual,
        resolution_minutes: facts.resolution_minutes,
        period_start: facts.period_start,
        period_end: facts.period_end,
      },
    }),
  ).readoutParts;
  const fromRow = energyDataView(
    emptyJob({
      interval_data: [
        intervalRow({
          coverage_days: facts.coverage_days,
          gap_days: facts.gap_days,
          pct_actual: facts.pct_actual,
          interval_minutes: facts.resolution_minutes,
          period_start: facts.period_start,
          period_end: facts.period_end,
        }),
      ],
      load_profiles: [{ job_id: "j", accuracy_tier: 3, confidence_pct: 92 }],
    }),
  ).readoutParts;
  assert.deepEqual(
    fromRow,
    fromResponse,
    "the stored row and the fresh response MUST produce identical readouts for the same file",
  );
  assert.deepEqual(fromResponse, [
    "4,800 half-hours",
    "100 days",
    "4 day gaps",
    "2.5% filled",
    "Tier 3",
  ]);
});

test("readout check 7: everything null -> empty array, nothing fabricated", () => {
  assert.deepEqual(
    intervalReadoutParts({
      coverageDays: null, gapDays: null, pctActual: null,
      intervalMinutes: null, tier: null,
    }),
    [],
  );
});

test("readout check 8: gaps — zero is silence, one is singular, four is plural", () => {
  const base = { coverageDays: 30, gapDays: 0, pctActual: null, intervalMinutes: null, tier: null };
  assert.ok(
    !intervalReadoutParts(base).some((p) => p.includes("gap")),
    "a zero gap count says nothing",
  );
  assert.ok(intervalReadoutParts({ ...base, gapDays: 1 }).includes("1 day gap"));
  assert.ok(intervalReadoutParts({ ...base, gapDays: 4 }).includes("4 day gaps"));
});

test("readout check 9: reads — 100 is 'all actual reads', 97.5 is '2.5% filled', null is neither", () => {
  const base = { coverageDays: null, gapDays: null, intervalMinutes: null, tier: null };
  assert.ok(
    intervalReadoutParts({ ...base, pctActual: 100 }).includes("all actual reads"),
  );
  assert.ok(
    intervalReadoutParts({ ...base, pctActual: 97.5 }).includes("2.5% filled"),
  );
  const neither = intervalReadoutParts({ ...base, pctActual: null });
  assert.ok(
    !neither.some((p) => p.includes("filled") || p.includes("actual reads")),
    "a missing pct_actual renders NOTHING — 0% would be a lie about measured data",
  );
});

test("readout check 10: the interval count derives, labels, and never invents", () => {
  const base = { gapDays: null, pctActual: null, tier: null };
  assert.ok(
    intervalReadoutParts({ ...base, coverageDays: 372, intervalMinutes: 30 })
      .includes("17,856 half-hours"),
  );
  const fifteen = intervalReadoutParts({ ...base, coverageDays: 10, intervalMinutes: 15 });
  assert.ok(fifteen.includes("960 readings"), fifteen.join("|"));
  assert.ok(!fifteen.some((p) => p.includes("half-hours")));
  const noRes = intervalReadoutParts({ ...base, coverageDays: 372, intervalMinutes: null });
  assert.ok(
    !noRes.some((p) => p.includes("half-hours") || p.includes("readings")),
    "no resolution -> no interval count; the day count still shows",
  );
  assert.ok(noRes.includes("372 days"));
});

test("readout check 11: energyDataView — full columns full readout, null columns tier only", () => {
  const full = energyDataView(
    emptyJob({
      interval_data: [
        intervalRow({
          coverage_days: 372, gap_days: 0, pct_actual: 100, interval_minutes: 30,
        }),
      ],
      load_profiles: [{ job_id: "j", accuracy_tier: 3 }],
    }),
  );
  assert.deepEqual(full.readoutParts, [
    "17,856 half-hours", "372 days", "all actual reads", "Tier 3",
  ]);
  // A pre-migration row: all four null -> only the tier, nothing fabricated.
  const bare = energyDataView(
    emptyJob({
      interval_data: [intervalRow()],
      load_profiles: [{ job_id: "j", accuracy_tier: 3 }],
    }),
  );
  assert.deepEqual(bare.readoutParts, ["Tier 3"]);
  assert.doesNotThrow(() => energyDataView(emptyJob({ interval_data: [intervalRow({ coverage_days: "junk" })] })));
});

test("readout check 12: negative and non-numeric values are MISSING, not zero", () => {
  const bads: [string, unknown][] = [
    ["coverage_days", -1], ["coverage_days", "372"],
    ["gap_days", -4], ["gap_days", NaN],
    ["pct_actual", -5], ["pct_actual", "97.5"],
    ["interval_minutes", -30], ["interval_minutes", Infinity],
  ];
  for (const [column, value] of bads) {
    const view = energyDataView(
      emptyJob({ interval_data: [intervalRow({ [column]: value })] }),
    );
    assert.deepEqual(
      view.readoutParts,
      view.tier !== null ? [`Tier ${view.tier}`] : [],
      `${column}=${String(value)} must read as missing`,
    );
  }
});

// ── 3.6b: the average day in real kWh, and the tier-aware flat case ─────────
//
// The arithmetic, verified in BOTH producers before anything was built on it:
// interval_parser._normalise_weights uses `f = 24.0 / total` and
// routes/load.py._normalise uses `factor = 24.0 / total`, so the weights sum to
// 24 and kwh[h] = weights[h] * daily_avg_kwh / 24 exactly. The parser rounds to
// 6dp, so a real file lands on 24.000001 — hence WEIGHT_SUM_TOLERANCE.

/**
 * The REAL average-day weights nem12-good.csv produces, copied from the
 * generator's printed output (and confirmed against the Python parser:
 * sum(w) = 24.000000, peak hour 19, daily average 15.069 kWh). This is what
 * ties the picture to the data.
 */
const SHAPED_WEIGHTS = [
  0.435, 0.404, 0.383, 0.38, 0.401, 0.468, 0.797, 1.206, 1.113, 0.761, 0.662,
  0.649, 0.695, 0.669, 0.708, 0.745, 0.887, 2.188, 2.44, 2.629, 2.259, 1.559,
  0.952, 0.611,
];
const SHAPED_DAILY_KWH = 15.069;

/** Weights that sum to exactly 24, scaled from an arbitrary shape. */
function weightsSummingTo24(shape: number[]): number[] {
  const total = shape.reduce((a, b) => a + b, 0);
  return shape.map((v) => (v * 24) / total);
}

test("3.6b check 1: the kWh reconstruction round-trips to the daily average", () => {
  const weights = weightsSummingTo24(SHAPED_WEIGHTS);
  const view = loadPreviewView(weights, SHAPED_DAILY_KWH, 3);
  assert.equal(view.unitsOk, true);
  assert.ok(view.kwhPerHour !== null);
  // FORWARD: each hour is weights[h] * daily / 24.
  for (let h = 0; h < 24; h++) {
    assert.ok(
      Math.abs(view.kwhPerHour[h] - (weights[h] * SHAPED_DAILY_KWH) / 24) < 1e-9,
      `hour ${h}`,
    );
  }
  // ROUND TRIP: the reconstructed hours sum back to the daily average. This is
  // the assertion that catches a dropped divide-by-24 — the obvious misreading.
  const sum = view.kwhPerHour.reduce((a, b) => a + b, 0);
  assert.ok(
    Math.abs(sum - SHAPED_DAILY_KWH) < 1e-6,
    `reconstructed day sums to ${sum}, expected ${SHAPED_DAILY_KWH}`,
  );
  assert.ok(view.maxKwh !== null && Math.abs(view.maxKwh - Math.max(...view.kwhPerHour)) < 1e-12);
});

test("3.6b check 2: weights summing to 23 or 25 -> unitsOk false, bars still drawn", () => {
  for (const target of [23, 25]) {
    const weights = weightsSummingTo24(SHAPED_WEIGHTS).map((w) => (w * target) / 24);
    const view = loadPreviewView(weights, SHAPED_DAILY_KWH, 3);
    assert.equal(view.ok, true, `sum ${target}: still drawable`);
    assert.equal(view.unitsOk, false, `sum ${target}: no axis`);
    assert.equal(view.kwhPerHour, null);
    assert.equal(view.maxKwh, null);
    assert.equal(view.bars.length, 24, "the unitless shape is still drawn");
  }
  // And just inside the tolerance still works.
  const nudged = weightsSummingTo24(SHAPED_WEIGHTS).map(
    (w, i) => (i === 0 ? w + WEIGHT_SUM_TOLERANCE * 0.5 : w),
  );
  assert.equal(loadPreviewView(nudged, SHAPED_DAILY_KWH, 3).unitsOk, true);
});

test("3.6b check 3: a bad daily average -> unitsOk false every time", () => {
  const weights = weightsSummingTo24(SHAPED_WEIGHTS);
  for (const bad of [null, undefined, 0, -5, "15.07", NaN, Infinity]) {
    const view = loadPreviewView(weights, bad, 3);
    assert.equal(view.unitsOk, false, `daily=${String(bad)}`);
    assert.equal(view.kwhPerHour, null, `daily=${String(bad)}`);
    assert.equal(view.ok, true, "the shape is still drawn");
  }
});

test("3.6b check 4: flatness and unit-validity are INDEPENDENT", () => {
  // A real Tier-1 profile with a real daily average: flat AND unit-valid.
  const view = loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 1);
  assert.equal(view.flat, true);
  assert.equal(view.unitsOk, true, "a flat profile still gets a real axis");
  assert.ok(view.kwhPerHour !== null);
  for (const kwh of view.kwhPerHour) {
    assert.ok(Math.abs(kwh - 0.5) < 1e-12, "every hour equal: 12 kWh / 24");
  }
  assert.equal(view.peak, null, "flat still names no peak");
});

test("3.6b check 5: the flat caption is TIER-AWARE (D27.3)", () => {
  const flat = Array.from({ length: 24 }, () => 1);
  const tier1 = loadPreviewView(flat, 12, 1);
  assert.equal(tier1.flatMessage?.level, "caption", "Tier 1 flat is a method fact");
  assert.ok(
    tier1.flatMessage.body.includes("national-average"),
    "the Tier-1 wording is correct and stays",
  );

  const tier3 = loadPreviewView(flat, 12, 3);
  assert.equal(tier3.flatMessage?.level, "notice", "flat MEASURED data is a finding");
  assert.equal(tier3.flatMessage.tone, "caution");
  assert.ok(
    !tier3.flatMessage.body.includes("national-average"),
    "measured data must NEVER be called a national-average estimate",
  );
  assert.ok(tier3.flatMessage.title.length > 0, "a notice needs a real title");

  const tier2 = loadPreviewView(flat, 12, 2);
  assert.deepEqual(
    tier2.flatMessage,
    tier3.flatMessage,
    "a flat Tier 2 is impossible by construction — treated as the Tier-3 case",
  );

  // A shaped profile raises no flat message at all.
  assert.equal(loadPreviewView(SHAPED_WEIGHTS, SHAPED_DAILY_KWH, 3).flatMessage, null);
});

test("3.6b check 6: energyDataView surfaces the two headline figures", () => {
  const full = energyDataView(
    emptyJob({
      interval_data: [intervalRow({ coverage_days: 372, interval_minutes: 30 })],
      load_profiles: [
        { job_id: "j", accuracy_tier: 3, annual_kwh: 5500, daily_avg_kwh: 15.069 },
      ],
    }),
  );
  assert.equal(full.annualKwh, 5500);
  assert.equal(full.dailyAvgKwh, 15.069);

  // No row at all -> both null.
  const none = energyDataView(emptyJob({ interval_data: [intervalRow()] }));
  assert.equal(none.annualKwh, null);
  assert.equal(none.dailyAvgKwh, null);

  // Non-numeric and negative read as MISSING, never zero.
  for (const bad of ["5500", -1, null]) {
    const view = energyDataView(
      emptyJob({
        load_profiles: [{ job_id: "j", annual_kwh: bad, daily_avg_kwh: bad }],
      }),
    );
    assert.equal(view.annualKwh, null, `annual_kwh=${String(bad)}`);
    assert.equal(view.dailyAvgKwh, null, `daily_avg_kwh=${String(bad)}`);
  }
});

test("3.6b check 7: the peak from the SHAPED fixture matches what the generator printed", () => {
  // The generator printed "peak window 5pm to 9pm" for nem12-good.csv, and the
  // Python parser put the maximum at hour 19. This ties the picture to the data.
  const view = loadPreviewView(SHAPED_WEIGHTS, SHAPED_DAILY_KWH, 3);
  assert.equal(view.flat, false, "the shaped fixture must NOT be flat");
  assert.ok(view.peak !== null);
  assert.equal(view.peak.startHour, 17);
  assert.equal(view.peak.endHour, 20);
  assert.equal(view.peak.label, "5pm to 9pm");
  assert.equal(peakHeadline(view.peak), "Evening peak");
  // The maximum really is the evening, not 3am.
  assert.equal(SHAPED_WEIGHTS.indexOf(Math.max(...SHAPED_WEIGHTS)), 19);
});

test("3.6b check 8: every new message sets level explicitly, over the input space", () => {
  const produced = [
    loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 1).flatMessage,
    loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 2).flatMessage,
    loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 3).flatMessage,
    loadPreviewView(Array.from({ length: 24 }, () => 1), 12, null).flatMessage,
    loadPreviewView(Array.from({ length: 24 }, () => 1)).flatMessage,
  ].filter((m) => m !== null);
  assert.equal(produced.length, 5);
  for (const m of produced) {
    assert.ok(m.level === "notice" || m.level === "caption", JSON.stringify(m));
    assert.ok(typeof m.body === "string" && m.body.length > 0);
  }
});

test("3.6b check 9: en-AU formatting, and a missing figure renders nothing", () => {
  assert.equal(formatAnnualKwh(5500), "5,500 kWh");
  assert.equal(formatAnnualKwh(12345.6), "12,346 kWh");
  assert.equal(formatDailyKwh(15.069), "15.1 kWh");
  assert.equal(formatDailyKwh(8), "8.0 kWh");
  for (const bad of [null, 0, -1, NaN, Infinity]) {
    assert.equal(formatAnnualKwh(bad), null, `annual ${String(bad)}`);
    assert.equal(formatDailyKwh(bad), null, `daily ${String(bad)}`);
  }
  assert.equal(peakHeadline(null), null);
  assert.equal(peakHeadline({ startHour: 7, endHour: 8, label: "7am to 9am" }), "Peak use");
});

test("3.6b: malformed profiles still degrade to absent, with the new fields null", () => {
  for (const bad of [Array.from({ length: 23 }, () => 1), null, undefined, "x", 42]) {
    const view = loadPreviewView(bad, 15, 3);
    assert.equal(view.ok, false);
    assert.equal(view.kwhPerHour, null);
    assert.equal(view.maxKwh, null);
    assert.equal(view.unitsOk, false);
    assert.equal(view.flatMessage, null);
  }
});

// ── The chart RENDERS its colour (3.6b fix) ─────────────────────────────────
//
// THE BUG THIS EXISTS TO CATCH: useChartTokens already returns usable colour
// strings ("hsl(210 70.9% 54.1%)"), and the strip wrapped them AGAIN, emitting
// fill="hsl(hsl(210 70.9% 54.1%))" — not a colour, so SVG painted the bars
// BLACK. It shipped because the contrast check measured the TOKEN VALUE, the
// colour we intended, and never the attribute that actually reached the DOM. A
// calculation on the intended colour is structurally incapable of detecting a
// colour that never arrives (the F47 shape).
//
// So these checks render the real component and read the real attributes. The
// harness uses typescript's transpiler and react-dom/server — BOTH already
// dependencies; no package was added for it.

const rendered = await (async () => {
  const { registerHooks } = await import("node:module");
  const ts = (await import("typescript")).default;
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const path = await import("node:path");

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const exts = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // The "@/..." alias plus extensionless relative imports — the two things
      // Node cannot resolve on its own but tsconfig/Next can.
      let target: string | null = null;
      if (specifier.startsWith("@/")) {
        target = path.join(root, specifier.slice(2));
      } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
        target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      }
      if (target !== null) {
        for (const ext of exts) {
          if (existsSync(target + ext) && !existsSync(target + ext + "/")) {
            return { url: pathToFileURL(target + ext).href, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
        const source = readFileSync(fileURLToPath(url), "utf8");
        const out = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            verbatimModuleSyntax: false,
          },
        });
        return { format: "module", source: out.outputText, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LoadPreviewStrip } = await import(
    "../components/worksheet/load-preview-strip.tsx"
  );
  return (view: unknown) =>
    renderToStaticMarkup(
      React.createElement(LoadPreviewStrip, { view } as never),
    );
})();

/** Every fill= / stroke= attribute value in a rendered markup string. */
function colourAttrs(markup: string): string[] {
  return [...markup.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * A value a browser would actually accept as a colour.
 *
 * `currentColor` and `none` are legitimate and appear on the lucide icons
 * inside the captions — the first version of this predicate rejected them and
 * failed the component for something correct. Which is itself worth noting:
 * the harness really is reading every attribute in the subtree, icons included.
 */
function isRenderableColour(value: string): boolean {
  if (value === "none" || value === "currentColor") return true;
  // hsl(...) with exactly ONE set of parentheses, or hsl(var(--name)).
  if (/^hsl\(var\(--[a-z0-9-]+\)\)$/.test(value)) return true;
  return /^hsl\([^()]*\)$/.test(value);
}

const SHAPED_VIEW = loadPreviewView(SHAPED_WEIGHTS, SHAPED_DAILY_KWH, 3);

test("colour check 1: the rendered markup contains NO 'hsl(hsl' — the whole bug", () => {
  const markup = rendered(SHAPED_VIEW);
  assert.ok(markup.includes("<rect"), "the chart actually rendered");
  assert.ok(
    !markup.includes("hsl(hsl"),
    `double-wrapped colour in the DOM: ${markup.match(/[a-z]+="hsl\(hsl[^"]*"/)?.[0]}`,
  );
});

test("colour check 2: every fill/stroke is a colour a browser would accept", () => {
  const attrs = colourAttrs(rendered(SHAPED_VIEW));
  assert.ok(attrs.length >= 25, `only ${attrs.length} colour attributes found`);
  for (const value of attrs) {
    assert.ok(value !== "" && value !== "undefined", `empty/undefined colour: "${value}"`);
    assert.ok(isRenderableColour(value), `not a renderable colour: "${value}"`);
  }
});

test("colour check 3: it holds in the flat, units-not-ok and no-peak states too", () => {
  const flatWeights = Array.from({ length: 24 }, () => 1);
  const states: [string, unknown][] = [
    ["flat tier 1", loadPreviewView(flatWeights, 12, 1)],
    ["flat tier 3", loadPreviewView(flatWeights, 12, 3)],
    ["units not ok", loadPreviewView(SHAPED_WEIGHTS, null, 3)],
    ["no peak (flat)", loadPreviewView(flatWeights, null, 1)],
  ];
  for (const [label, view] of states) {
    const markup = rendered(view);
    assert.ok(!markup.includes("hsl(hsl"), `${label}: double-wrapped colour`);
    for (const value of colourAttrs(markup)) {
      assert.ok(isRenderableColour(value), `${label}: bad colour "${value}"`);
    }
  }
});

test("colour check 4: the peak marker renders with a peak and not without one", () => {
  const withPeak = rendered(SHAPED_VIEW);
  assert.ok(SHAPED_VIEW.peak !== null, "the fixture has a peak");
  assert.ok(
    withPeak.includes("Peak use, 5pm to 9pm"),
    "the peak marker and its title must render",
  );
  const flat = loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 1);
  assert.equal(flat.peak, null);
  assert.ok(
    !rendered(flat).includes("Peak use,"),
    "no peak means no marker — never an invented one",
  );
});

test("colour check 5: no reduced fill-opacity survives on any bar", () => {
  const markup = rendered(SHAPED_VIEW);
  const opacities = [...markup.matchAll(/fill-opacity="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(
    opacities,
    [],
    `opacity cannot carry the peak distinction at an accessible contrast — found ${opacities.join(", ")}`,
  );
});

// ── 3.3c: the job-edit view and the address lock ─────────────────────────────
//
// The rule: the address locks the moment ANY of roof_geometry, sizing_results,
// tariffs or interval_data carries a row — those four DERIVE from the address.
// A bill or a survey does not, and does not lock it.

const EDIT_JOB_BASE = {
  job_id: "j-77",
  intent: "both",
  has_existing_solar: true,
  existing_solar_kw: 6.6,
  existing_inverter_kw: 5,
  customer: [{ customer_name: "J. Nguyen", property_address_full: "14 Frome St" }],
};

test("3.3c 2a-2b: each of the four derived tables locks the address, separately", () => {
  for (const table of [
    "roof_geometry",
    "sizing_results",
    "tariffs",
    "interval_data",
  ]) {
    const view = jobEditView(emptyJob({ ...EDIT_JOB_BASE, [table]: [{ id: 1 }] }));
    assert.equal(view.addressLocked, true, `${table} must lock`);
    assert.equal(
      view.addressLockReason,
      ADDRESS_LOCK_REASON,
      `${table}: the exact sentence`,
    );
  }
});

test("3.3c 2c: all four empty -> unlocked, reason NULL (null, not '')", () => {
  const view = jobEditView(emptyJob(EDIT_JOB_BASE));
  assert.equal(view.addressLocked, false);
  assert.strictEqual(view.addressLockReason, null);
});

test("3.3c 2d: bills and surveys do NOT lock the address", () => {
  const view = jobEditView(
    emptyJob({
      ...EDIT_JOB_BASE,
      bills: [{ bill_id: "b1" }],
      surveys: [{ survey_id: "s1" }],
    }),
  );
  assert.equal(
    view.addressLocked,
    false,
    "a bill does not follow from the address — adding it 'to be safe' breaks this",
  );
});

test("3.3c 2e: empty customer array -> '' strings; the lock follows DERIVED rows", () => {
  const view = jobEditView(
    emptyJob({ ...EDIT_JOB_BASE, customer: [], roof_geometry: [{ id: 1 }] }),
  );
  assert.equal(view.address, "");
  assert.equal(view.customerName, "");
  assert.equal(
    view.addressLocked,
    true,
    "an unrecorded address with roof geometry still locks — the rows decide",
  );
});

test("3.3c 2f: numeric fields arrive as input strings", () => {
  const view = jobEditView(emptyJob(EDIT_JOB_BASE));
  assert.strictEqual(view.existingSolarKw, "6.6");
  assert.strictEqual(view.existingInverterKw, "5");
  const NULL_KW_JOB = { status: "draft", job_id: "x", existing_solar_kw: null, existing_inverter_kw: null };
  const nulls = jobEditView(emptyJob(NULL_KW_JOB));
  assert.strictEqual(nulls.existingSolarKw, "");
  assert.strictEqual(nulls.existingInverterKw, "");
});

test("3.3c 2g: garbage in every position -> no throw, sane defaults", () => {
  const cases: unknown[] = [
    null,
    undefined,
    "x",
    42,
    { job_id: 9, intent: 7, has_existing_solar: "yes", existing_solar_kw: "6.6",
      customer: "not-an-array", roof_geometry: "nope", tariffs: 3 },
  ];
  for (const junk of cases) {
    const view = jobEditView(junk);
    assert.equal(typeof view.address, "string");
    assert.equal(typeof view.customerName, "string");
    assert.equal(view.intent, null);
    assert.equal(view.hasExistingSolar, null);
    assert.strictEqual(view.existingSolarKw, "");
    assert.equal(view.addressLocked, false);
    assert.strictEqual(view.addressLockReason, null);
  }
});

test("3.3c 2h: jobBarView's four existing fields are unchanged by the edit field", () => {
  const job = emptyJob({
    status: "sized",
    path: "B",
    path_label: "Solar + battery",
    accuracy_tier: 3,
    customer: [{ property_address_full: "14 Frome St, Adelaide SA 5000" }],
  });
  const view = jobBarView(job);
  assert.equal(view.address, "14 Frome St, Adelaide SA 5000");
  assert.equal(view.statusRaw, "sized");
  assert.equal(view.jobTypeLabel, "Solar + battery (B)");
  assert.equal(view.tier, 3);
  const empty = jobBarView(emptyJob());
  assert.equal(empty.address, "Address not recorded");
  assert.equal(empty.jobTypeLabel, "Job type not set");
  // And the new field is populated.
  assert.equal(view.edit.address, "14 Frome St, Adelaide SA 5000");
});

// ── Test 5: postJson is genuinely unchanged behind the delegation ────────────
// The F121 lesson — measure what ships. Both functions run against the same
// stubbed fetch and the RESULT OBJECTS are compared, not the source.

async function bothResults(
  respond: () => Response | Promise<Response>,
): Promise<[unknown, unknown]> {
  const original = globalThis.fetch;
  const make = (async () => respond()) as unknown as typeof fetch;
  try {
    globalThis.fetch = make;
    const a = await postJson("/x", { a: 1 });
    globalThis.fetch = make;
    const b = await requestJson("POST", "/x", { a: 1 });
    return [a, b];
  } finally {
    globalThis.fetch = original;
  }
}

test("3.3c test 5: postJson === requestJson('POST') across five response shapes", async () => {
  const shapes: [string, () => Response | Promise<Response>][] = [
    ["200 JSON", () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })],
    ["200 empty body", () => new Response("", { status: 200 })],
    ["401 HTML body", () => new Response("<html>login</html>", { status: 401 })],
    ["500 JSON detail", () =>
      new Response(JSON.stringify({ detail: "boom" }), { status: 500 })],
    ["fetch throws", () => { throw new TypeError("network down"); }],
  ];
  for (const [label, respond] of shapes) {
    const [a, b] = await bothResults(respond);
    assert.deepEqual(a, b, `${label}: the two results must be identical`);
  }
});

// ── 3.8: Tariff & network ────────────────────────────────────────────────────
// Every case runs against hand-built job objects. `tariffs` is 0 rows live, so
// the "has a stored tariff" branch is unreachable in the app today — a live
// check for it could not fail and would be evidence of nothing (the F39 class).

const EXPORT_DEFAULT_SA = {
  state: "SA",
  dnsp: "SA Power Networks",
  export_limit_kw: 5.0,
  is_default: false,
};
const FIT_DEFAULT_SA = {
  state: "SA",
  fit_aud_per_kwh: 0.05,
  is_fallback: true,
  source: "AER",
  scheme: "NEM (market-based)",
};
const BOTH_DEFAULTS = { exportLimit: EXPORT_DEFAULT_SA, fit: FIT_DEFAULT_SA };

function jobWithTariff(row: Record<string, unknown> | null) {
  return {
    site_state: "SA",
    site_postcode: "5000",
    site_dnsp: "SA Power Networks",
    tariffs: row ? [{ tariff_id: "t1", created_at: "2026-08-18T00:00:00Z", ...row }] : [],
  };
}

test("3.8 (a): no stored row — defaults prefill, and the import rate stays EMPTY", () => {
  const view = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS);
  assert.equal(view.state, "empty");
  assert.equal(view.exportLimitKw.text, "5");
  assert.equal(view.fitRate.text, "0.05");
  // There is deliberately no import-rate default: DEFAULT_IMPORT_RATE is an
  // engine fallback, and prefilling the form with it would present a guess as
  // an entered value (F78 in a new costume).
  assert.equal(view.importRate.text, "");
  assert.equal(view.supplyCharge.text, "");
  assert.equal(view.dnsp, "SA Power Networks");
  assert.equal(view.state_, "SA");
  assert.equal(view.postcode, "5000");
});

test("3.8 (b): the STORED import rate beats the default — precedence, per field", () => {
  const view = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.42 }),
    BOTH_DEFAULTS,
  );
  assert.equal(view.state, "stored");
  assert.equal(view.importRate.text, "0.42");
  assert.equal(view.importRate.raw, 0.42);
  assert.equal(view.tariffType, "flat");
});

test("3.8 (c): a PARTIAL row falls back per field, never per row", () => {
  const view = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: null, export_limit_kw: 7.5 }),
    BOTH_DEFAULTS,
  );
  assert.equal(view.importRate.text, "");
  // The stored 7.5 wins over the 5.0 default...
  assert.equal(view.exportLimitKw.text, "7.5");
  // ...and the FiT the row does NOT carry still takes the default.
  assert.equal(view.fitRate.text, "0.05");
});

test("3.8 (d): both defaults null — every input empty, no source lines, no throw", () => {
  const view = tariffNetworkView(jobWithTariff(null), { exportLimit: null, fit: null });
  assert.equal(view.importRate.text, "");
  assert.equal(view.fitRate.text, "");
  assert.equal(view.exportLimitKw.text, "");
  assert.equal(view.supplyCharge.text, "");
  assert.equal(view.fitSourceLabel, null);
  assert.equal(view.exportSourceLabel, null);
});

test("3.8 (e): a TOU window CROSSING MIDNIGHT round-trips unchanged, order kept", () => {
  const view = tariffNetworkView(
    jobWithTariff({
      tariff_type: "tou",
      tou_windows: [
        { label: "peak", rate: 0.55, start: "18:00", end: "22:00", days: "all" },
        { label: "offpeak", rate: 0.22, start: "22:00", end: "06:00", days: "all" },
      ],
    }),
    BOTH_DEFAULTS,
  );
  assert.equal(view.tariffType, "tou");
  assert.equal(view.windows.length, 2);
  // Local clock time, verbatim — no rotation, no offset, no Date arithmetic.
  assert.deepEqual(view.windows[0], {
    label: "peak", rate: "0.55", start: "18:00", end: "22:00", days: "all",
  });
  assert.deepEqual(view.windows[1], {
    label: "offpeak", rate: "0.22", start: "22:00", end: "06:00", days: "all",
  });
});

test("3.8 (f): unreadable tou_windows are dropped with a notice, never a throw", () => {
  for (const bad of ["not an array", [null], [{}], [{ rate: 0.4 }], 42]) {
    const view = tariffNetworkView(
      jobWithTariff({ tariff_type: "tou", tou_windows: bad }),
      BOTH_DEFAULTS,
    );
    assert.equal(view.windows.length, 0, `${JSON.stringify(bad)} should drop every row`);
    assert.ok(
      view.notices.some((n) => n.title === TARIFF_WINDOWS_UNREADABLE_NOTICE.title),
      `${JSON.stringify(bad)} should carry the could-not-be-fully-read notice`,
    );
  }
  // A partially readable list keeps what it could read AND still warns.
  const partial = tariffNetworkView(
    jobWithTariff({
      tariff_type: "tou",
      tou_windows: [
        { label: "peak", rate: 0.55, start: "18:00", end: "22:00", days: "all" },
        { label: "offpeak", rate: 0.22 },
      ],
    }),
    BOTH_DEFAULTS,
  );
  assert.equal(partial.windows.length, 1);
  assert.ok(partial.notices.some((n) => n.title === TARIFF_WINDOWS_UNREADABLE_NOTICE.title));
  // tou_windows absent is NOT unreadable — a flat tariff simply has none.
  const flat = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.4 }),
    BOTH_DEFAULTS,
  );
  assert.equal(flat.windows.length, 0);
  assert.ok(!flat.notices.some((n) => n.title === TARIFF_WINDOWS_UNREADABLE_NOTICE.title));
});

test("3.8 (g): a stored label outside the list is KEPT, never silently reset", () => {
  const view = tariffNetworkView(
    jobWithTariff({
      tariff_type: "tou",
      tou_windows: [
        { label: "super-peak", rate: 0.9, start: "17:00", end: "20:00", days: "sundays" },
        { label: "offpeak", rate: 0.2, start: "20:00", end: "17:00", days: "all" },
      ],
    }),
    BOTH_DEFAULTS,
  );
  // The component turns these into an "(as stored)" option, exactly as
  // site-details-section does for a roof material outside its list.
  assert.equal(view.windows[0].label, "super-peak");
  assert.equal(view.windows[0].days, "sundays");
});

test("3.8 (h): D25 — every notice classified by LEVEL and exact TITLE", () => {
  const stored = tariffNetworkView(
    jobWithTariff({
      tariff_type: "tou",
      import_rate: 0.42,
      tou_windows: [{ label: "peak", rate: 0.5 }],
    }),
    BOTH_DEFAULTS,
  );
  const byTitle = new Map(stored.notices.map((n) => [n.title, n.level]));
  assert.equal(byTitle.get("Saving this locks the job's address"), "caption");
  assert.equal(
    byTitle.get("The feed-in tariff and export limit are documented defaults"),
    "caption",
  );
  assert.equal(byTitle.get("One rate profile, every day of the year"), "caption");
  assert.equal(byTitle.get("The stored tariff could not be fully read"), "notice");
  assert.equal(TARIFF_ADDRESS_LOCK_CAPTION.level, "caption");
  assert.equal(TARIFF_DEFAULTS_CAPTION.level, "caption");
  assert.equal(TARIFF_TOU_PROFILE_CAPTION.level, "caption");
  assert.equal(TARIFF_WINDOWS_UNREADABLE_NOTICE.level, "notice");

  // FINDINGS SORT ABOVE CAPTIONS in the array the component receives.
  const lastFinding = stored.notices.reduce(
    (acc, n, i) => (n.level === "notice" ? i : acc), -1);
  const firstCaption = stored.notices.findIndex((n) => n.level === "caption");
  assert.ok(lastFinding < firstCaption, "every finding must precede every caption");

  // The TOU caption fires ONLY for a time-of-use tariff.
  const flat = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.4 }), BOTH_DEFAULTS);
  assert.ok(!flat.notices.some((n) => n.title === TARIFF_TOU_PROFILE_CAPTION.title));
  // The address-lock caption fires BEFORE the first save as well as after.
  const empty = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS);
  assert.ok(empty.notices.some((n) => n.title === TARIFF_ADDRESS_LOCK_CAPTION.title));

  // The SAVE RESPONSE is classified by MEANING, not by array position: the
  // address-lock line is a caption even though it arrives in `warnings`
  // alongside findings. A saved:false NEVER reads as success.
  const failed = tariffSaveNotices({ ok: true, saved: false, warnings: [] });
  assert.equal(failed[0].title, "The tariff could not be saved");
  assert.equal(failed[0].level, "notice");
  const locked = tariffSaveNotices({
    ok: true, saved: true,
    warnings: ["This job's address is now locked — the tariff follows from it."],
  });
  assert.equal(locked.length, 1);
  assert.equal(locked[0].level, "caption");
  const mixed = tariffSaveNotices({
    ok: true, saved: true,
    warnings: ["This job's address is now locked — the tariff follows from it.",
               "The stored row could not be read back."],
  });
  assert.deepEqual(mixed.map((n) => n.level), ["caption", "notice"]);

  // The bill-comparison notice — a FINDING about this job. Unreachable in the
  // app today (bills is 0 rows), which is why it is asserted here directly.
  assert.equal(tariffBillMismatchNotice(0.42, 0.42), null);
  assert.equal(tariffBillMismatchNotice(0.42, null), null);
  const disagrees = tariffBillMismatchNotice(0.42, 0.30);
  assert.equal(disagrees?.level, "notice");
  assert.equal(disagrees?.title, "The saved tariff disagrees with this job's bill");
});

test("3.8 (i): SHOW_CI_TARIFF_ROWS drives the C&I rows in BOTH directions", () => {
  // The constant ships false — the rows are absent from the view, so the
  // component renders nothing at all rather than hiding markup with CSS.
  assert.equal(SHOW_CI_TARIFF_ROWS, false);
  const job = jobWithTariff({
    tariff_type: "flat",
    import_rate: 0.4,
    demand_charges: [{ rate: 12.5, threshold_kw: 30, negotiated_export_kw: 25 }],
  });
  const off = tariffNetworkView(job, BOTH_DEFAULTS, false);
  assert.equal(off.ci, null);
  const offDefault = tariffNetworkView(job, BOTH_DEFAULTS);
  assert.equal(offDefault.ci, null, "the default argument is the constant");

  // Driven TRUE, the fields exist and are correctly shaped — which is what
  // makes "present but hidden behind the flag" a fact rather than an intention.
  const on = tariffNetworkView(job, BOTH_DEFAULTS, true);
  assert.notEqual(on.ci, null);
  assert.equal(on.ci?.demandChargeRate.text, "12.5");
  assert.equal(on.ci?.demandChargeRate.raw, 12.5);
  assert.equal(on.ci?.demandThresholdKw.text, "30");
  assert.equal(on.ci?.negotiatedExportKw.text, "25");
  // With the flag on but nothing stored, the fields are present and empty.
  const onEmpty = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS, true);
  assert.equal(onEmpty.ci?.demandChargeRate.text, "");
  assert.equal(onEmpty.ci?.negotiatedExportKw.text, "");
});

test("3.8: the view is TOTAL — junk in, no throw, never the string 'undefined'", () => {
  const junk: unknown[] = [
    null, undefined, 42, "a job", [], {},
    { tariffs: "not an array" },
    { tariffs: [null] },
    { tariffs: [{ import_rate: "0.42" }] },
    { tariffs: [{ import_rate: {} }], site_state: 7 },
  ];
  for (const j of junk) {
    const view = tariffNetworkView(j, { exportLimit: null, fit: null });
    assert.ok(Array.isArray(view.windows));
    assert.ok(Array.isArray(view.notices));
    for (const text of [view.importRate.text, view.fitRate.text,
                        view.exportLimitKw.text, view.supplyCharge.text]) {
      assert.notEqual(text, "undefined");
      assert.notEqual(text, "null");
    }
  }
  // A numeric STRING from PostgREST is still a number.
  const asString = tariffNetworkView(
    { tariffs: [{ import_rate: "0.42", created_at: "2026-08-18T00:00:00Z" }] },
    { exportLimit: null, fit: null },
  );
  assert.equal(asString.importRate.text, "0.42");
  // And the save classifier tolerates any response shape.
  for (const r of [null, undefined, 42, "x", {}, { warnings: "no" }, { warnings: [1, 2] }]) {
    assert.ok(Array.isArray(tariffSaveNotices(r)));
  }
});

test("3.8: the HH:MM guard matches the backend's regex, including 24:00", () => {
  for (const good of ["00:00", "6:30", "06:00", "18:00", "23:59", "24:00"]) {
    assert.ok(isTariffTime(good), `${good} should be accepted`);
  }
  for (const bad of ["25:00", "18:60", "6pm", "", "18", "18:0", null, 18]) {
    assert.ok(!isTariffTime(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

// ── 3.8-2b: number inputs do not change themselves ───────────────────────────
// Rendered-attribute checks, on the same instrument as the chart-colour ones
// above (2N.1): assert what REACHES the element, never the source you intended.
// The module hooks are already registered by the harness above.
//
// WHAT THIS CAN AND CANNOT REACH: renderToStaticMarkup produces static HTML with
// no DOM and no events, so it CAN prove the class list and the step attribute
// that ship, and it CANNOT fire a wheel event. The wheel behaviour is proven
// here only by asserting the handler exists and is gated on type === "number"
// (test "the critical guard" below); the behaviour itself is MAYUR'S CHECK ON
// SCREEN, not this suite's. F109 — a check that cannot be rehearsed needs its
// mechanism written down, and this is that.

const renderInput = await (async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Input } = await import("../components/ui/input.tsx");
  return (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(Input, props as never));
})();

const INPUT_SOURCE = await (async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return readFileSync(path.join(root, "components/ui/input.tsx"), "utf8");
})();

/** The four rules that take the stepper arrows off, WebKit and Firefox both. */
const APPEARANCE_RULES = [
  "[&::-webkit-outer-spin-button]:appearance-none",
  "[&::-webkit-inner-spin-button]:appearance-none",
  "[&::-webkit-inner-spin-button]:m-0",
  "[appearance:textfield]",
];

/** The class attribute as the BROWSER sees it: renderToStaticMarkup escapes the
    `&` in an arbitrary-variant class to `&amp;`, and the HTML parser decodes it
    straight back. Comparing the undecoded form would fail on a working rule. */
function decodedMarkup(markup: string): string {
  return markup.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

test("3.8-2b (a): a number Input RENDERS all four stepper-hiding rules", () => {
  const markup = decodedMarkup(renderInput({ type: "number" }));
  for (const rule of APPEARANCE_RULES) {
    // Named individually so a failure says WHICH rule went missing.
    assert.ok(
      markup.includes(rule),
      `the rendered class string must carry ${rule} — got: ${markup}`,
    );
  }
});

test("3.8-2b (b): a TEXT Input still renders and keeps its base styling", () => {
  const markup = renderInput({ type: "text", placeholder: "Search jobs" });
  assert.ok(markup.includes('type="text"'));
  assert.ok(markup.includes("h-9"), "the 36px control height must survive");
  assert.ok(markup.includes("rounded-md"));
  assert.ok(markup.includes("border-input"));
  assert.ok(markup.includes("focus-visible:ring-ring"));
  assert.ok(markup.includes("placeholder:text-muted-foreground"));
  // The address box and the jobs filter go through this same component; the
  // wheel guard must never reach them. Proven from source in the guard test.
  assert.ok(markup.includes('placeholder="Search jobs"'));
});

test("3.8-2b (d): a caller's className still lands AFTER the base classes", () => {
  const markup = renderInput({ type: "number", className: "w-[130px]" });
  const base = markup.indexOf("flex h-9");
  const caller = markup.indexOf("w-[130px]");
  assert.ok(base !== -1 && caller !== -1, markup);
  assert.ok(caller > base, "the caller's class must come last so it can override");
});

// (c) THE ELEVEN SOURCE ELEMENTS, which render NINETEEN distinct fields — two
// helpers serve several fields each (site-details' numberField serves four,
// energy-data's correction row serves three). Every field named individually.
const STEP_TABLE: [string, string, string][] = [
  // [field, unit, step]
  ["Import rate", "$/kWh", "0.01"],
  ["Supply charge", "$/day", "0.01"],
  ["Feed-in tariff", "$/kWh", "0.01"],
  ["Export limit", "kW", "0.1"],
  ["TOU window rate", "$/kWh", "0.01"],
  ["C&I demand charge", "$/kVA", "0.01"],
  ["C&I demand threshold", "kW", "0.1"],
  ["C&I negotiated export", "kW", "0.1"],
  ["Storeys", "count", "1"],
  ["Year built", "year", "1"],
  ["Bedrooms", "count", "1"],
  ["Floor area", "m²", "1"],
  ["Bill correction — total kWh", "kWh", "1"],
  ["Bill correction — days", "days", "1"],
  ["Bill correction — daily average", "kWh/day", "0.1"],
  ["Typed annual usage", "kWh/yr", "1"],
  ["Roof plane exact degrees", "degrees", "0.1"],
  ["Roof plane pitch", "degrees", "1"],
  ["Roof plane area", "m²", "1"],
];

for (const [field, unit, step] of STEP_TABLE) {
  test(`3.8-2b (c): "${field}" (${unit}) ships step="${step}"`, () => {
    const markup = renderInput({ type: "number", inputMode: "decimal", step });
    assert.ok(
      markup.includes(`step="${step}"`),
      `${field} must reach the element with step="${step}" — got: ${markup}`,
    );
  });
}

test("3.8-2b (c): every call site passes the step its field's row claims", async () => {
  // The render above proves Input FORWARDS a step; this proves each call site
  // SUPPLIES the one in the table. Both halves are needed — neither alone shows
  // the right number reaching the right field.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  const tariff = read("components/worksheet/tariff-network-section.tsx");
  assert.ok(tariff.includes('"$/kWh",\n            "0.01",'), "Import rate → 0.01");
  assert.ok(tariff.includes('"$/day",\n            "0.01",'), "Supply charge (flat) → 0.01");
  assert.ok(tariff.includes('"$/day",\n              "0.01",'), "Supply charge (TOU) → 0.01");
  assert.ok(tariff.includes('"$/kWh",\n          "0.01",'), "Feed-in tariff → 0.01");
  assert.ok(tariff.includes('"kW",\n          "0.1",'), "Export limit → 0.1");
  assert.ok(tariff.includes('step="0.01"\n                    placeholder="e.g. 0.55"'),
    "TOU window rate → 0.01");
  assert.ok(tariff.includes('step="0.01"\n              placeholder="e.g. 12.50"'),
    "C&I demand charge → 0.01");
  assert.equal((tariff.match(/step="0\.1"/g) ?? []).length, 2,
    "C&I threshold and negotiated export → 0.1 each");

  const site = read("components/worksheet/site-details-section.tsx");
  assert.ok(site.includes('"storeys", "1"'), "Storeys → 1");
  assert.ok(site.includes('"yearBuilt", "1"'), "Year built → 1");
  assert.ok(site.includes('"bedrooms", "1"'), "Bedrooms → 1");
  assert.ok(site.includes('"floorAreaM2", "1"'), "Floor area → 1");
  assert.ok(site.includes("step={step}"), "the shared helper forwards its step");

  const energy = read("components/worksheet/energy-data-section.tsx");
  assert.ok(energy.includes('["totalKwh", "Total kWh", "1"]'), "Total kWh → 1");
  assert.ok(energy.includes('["periodDays", "Days", "1"]'), "Days → 1");
  assert.ok(energy.includes('["dailyAvgKwh", "Daily average kWh", "0.1"]'),
    "Daily average → 0.1");
  assert.ok(energy.includes('id="typed-annual"\n                  step="1"'),
    "Typed annual usage → 1");

  const roof = read("components/worksheet/address-roof-section.tsx");
  assert.ok(roof.includes('id={`plane-deg-${i}`}\n                step="0.1"'),
    "Roof plane exact degrees → 0.1");
  assert.ok(roof.includes('id={`plane-pitch-${i}`}\n              step="1"'),
    "Roof plane pitch → 1");
  assert.ok(roof.includes('id={`plane-area-${i}`}\n              step="1"'),
    "Roof plane area → 1");
  // The three pre-existing steps are LEFT ALONE.
  assert.ok(roof.includes('step="0.05"'), "the usability factor keeps its 0.05");
});

test("3.8-2b: THE CRITICAL GUARD — the wheel blur is gated on type === 'number'", () => {
  // With this condition gone, EVERY text field in the app loses focus on scroll,
  // including the address autocomplete — and nothing else in this suite would
  // notice. That is why it is asserted on its own.
  assert.ok(INPUT_SOURCE.includes("onWheel"), "the wheel handler must exist");
  assert.ok(
    INPUT_SOURCE.includes('if (type !== "number") return;'),
    "the blur MUST be gated on type === 'number' — text inputs must never blur on scroll",
  );
  assert.ok(INPUT_SOURCE.includes(".blur()"), "the handler must blur the field");
  // Blur, never preventDefault — stopping the page scrolling is the worse bug.
  assert.ok(
    !/event\.preventDefault\(\)/.test(INPUT_SOURCE),
    "the wheel handler must NOT preventDefault — the page must keep scrolling",
  );
  // The caller's handler is composed, not clobbered.
  assert.ok(INPUT_SOURCE.includes("onWheel?.(event)"), "a caller's onWheel must still run");
  assert.ok(
    INPUT_SOURCE.includes("if (event.defaultPrevented) return;"),
    "a caller that preventDefaults must be able to opt out",
  );
  // The arrow KEYS stay working — an accessibility affordance, deliberately not
  // blocked. Nothing may intercept keydown.
  assert.ok(!/onKeyDown/.test(INPUT_SOURCE), "the keyboard arrows must not be blocked");
});

// ── Type roles survive the class merge ───────────────────────────────────────
// THE FAULT: `cn` was twMerge(clsx(...)) with no configuration. tailwind-merge
// knows nothing about this project's fontSize keys, and its default text-color
// group accepts ANY text-* value — so `text-body` was filed as a COLOUR,
// collided with the real colour beside it, and the earlier class was dropped.
// The role always lost, because the role is always written first. Twelve
// correctly-written call sites rendered at the browser's 16px instead of their
// specified size, on every render, and the colour-token gate passed throughout
// because it reads token VALUES and never the class string that ships (F47).

// Loaded through the transpiling module hooks registered by the render harness
// above — lib/utils.ts is TypeScript and `cn` is the thing under test.
const utils = await import("../lib/utils.ts");
const cn = utils.cn;
const CN_ROLES: readonly string[] = utils.TYPE_ROLES;

// (c) THE ANTI-DRIFT CHECK reads the real config file at test time.
//
// HOW, and why not simply import it: tailwind.config.ts ends with
// `plugins: [require("tailwindcss-animate")]`, and `require` is not defined in
// ES module scope — importing it throws before any key can be read. So the file
// is PARSED with the TypeScript compiler (already a dependency, already used by
// the render harness above) and the fontSize keys are taken off the AST. That
// reads the config exactly as written and executes none of it.
const CONFIG_FONT_SIZES = await (async () => {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const file = path.join(root, "tailwind.config.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const keys: string[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "fontSize" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          keys.push(prop.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
})();

// (a) Every role, named individually — a failing role must say which it is.
for (const role of [
  "hero-xl", "hero", "hero-sub", "display", "h1", "h2", "h3",
  "body-lg", "body", "body-medium", "label", "button", "nav",
  "caption", "overline", "eyebrow", "metric-lg", "metric-sm",
]) {
  test(`type roles (a): cn("text-${role} text-foreground") keeps BOTH`, () => {
    const out = cn(`text-${role} text-foreground`).split(" ");
    assert.ok(
      out.includes(`text-${role}`),
      `text-${role} was dropped — it is being filed as a colour, not a size`,
    );
    assert.ok(out.includes("text-foreground"), "the colour must survive too");
  });
}

test("type roles (b): the REVERSE order also keeps both", () => {
  for (const role of CN_ROLES) {
    const out = cn(`text-foreground text-${role}`).split(" ");
    assert.ok(out.includes(`text-${role}`), `text-${role} dropped when written second`);
    assert.ok(out.includes("text-foreground"), `the colour dropped for text-${role}`);
  }
});

test("type roles (c): the merge list EQUALS tailwind.config.ts's fontSize keys", () => {
  // A role added to the config and not here would silently go back to rendering
  // at 16px. This is the check that stops that being possible.
  assert.equal(CONFIG_FONT_SIZES.length, 18, "the config's fontSize key count");
  assert.deepEqual(
    [...CN_ROLES].sort(),
    [...CONFIG_FONT_SIZES].sort(),
    "lib/utils.ts's TYPE_ROLES must be exactly tailwind.config.ts's fontSize keys",
  );
  for (const key of CONFIG_FONT_SIZES) {
    assert.ok(CN_ROLES.includes(key), `config role "${key}" is missing from TYPE_ROLES`);
  }
  for (const role of CN_ROLES) {
    assert.ok(CONFIG_FONT_SIZES.includes(role), `TYPE_ROLES has "${role}", the config does not`);
  }
});

test("type roles (d): GENUINE overrides still work, both groups", () => {
  // Two SIZES do conflict — the caller must still win.
  assert.equal(cn("text-body", "text-caption"), "text-caption");
  assert.equal(cn("text-h1", "text-h3"), "text-h3");
  // Two COLOURS still conflict exactly as before.
  assert.equal(cn("text-foreground", "text-muted-foreground"), "text-muted-foreground");
  // A size and a colour are now INDEPENDENT — overriding one leaves the other.
  assert.equal(cn("text-body text-foreground", "text-caption"), "text-foreground text-caption");
  assert.equal(
    cn("text-body text-foreground", "text-muted-foreground"),
    "text-body text-muted-foreground",
  );
  // Tailwind's own scale is untouched — this ADDED knowledge, it removed none.
  assert.equal(cn("text-sm", "text-lg"), "text-lg");
  assert.equal(cn("text-body", "text-[13px]"), "text-[13px]");
  assert.equal(cn("text-[13px]", "text-body"), "text-body");
  // A modified class lives in its own namespace and never collided anyway.
  assert.equal(
    cn("text-body focus:text-accent-foreground"),
    "text-body focus:text-accent-foreground",
  );
});

// (e) THE RENDERED ARTIFACT — the only evidence that counts, and the thing the
// token gate structurally cannot see. Assert on the string reaching the element.
const renderRole = await (async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Input } = await import("../components/ui/input.tsx");
  const { TableHead, TableCaption } = await import("../components/ui/table.tsx");
  const { StatusPill } = await import("../components/ui/status-pill.tsx");
  return {
    input: () => renderToStaticMarkup(React.createElement(Input, { type: "number" } as never)),
    tableHead: () => renderToStaticMarkup(React.createElement(TableHead, {} as never)),
    tableCaption: () => renderToStaticMarkup(React.createElement(TableCaption, {} as never)),
    statusPill: () =>
      renderToStaticMarkup(React.createElement(StatusPill, { status: "draft" } as never)),
  };
})();

/**
 * The rendered class attribute as a LIST of exact class names.
 *
 * Substring matching is not good enough here and the negative proof proved it:
 * input.tsx also carries `file:text-body`, so `markup.includes("text-body")`
 * stayed true with the bare role dropped, and the check passed while the thing
 * it guards was broken. Exact membership is the only assertion that moves.
 * `&amp;` is decoded because renderToStaticMarkup escapes the `&` in an
 * arbitrary-variant class and the HTML parser decodes it straight back.
 */
function renderedClasses(markup: string): string[] {
  const match = markup.match(/class="([^"]*)"/);
  if (!match) return [];
  return match[1].replace(/&amp;/g, "&").split(/\s+/).filter(Boolean);
}

test("type roles (e): the rendered Input carries text-body AND text-foreground", () => {
  const classes = renderedClasses(renderRole.input());
  assert.ok(classes.includes("text-body"), `text-body never reached the element: ${classes}`);
  assert.ok(classes.includes("text-foreground"), String(classes));
});

test("type roles (e): the rendered TableHead carries text-label AND its colour", () => {
  const classes = renderedClasses(renderRole.tableHead());
  assert.ok(classes.includes("text-label"), `text-label never reached the element: ${classes}`);
  assert.ok(classes.includes("text-muted-foreground"), String(classes));
});

test("type roles (e): the rendered TableCaption carries text-caption AND its colour", () => {
  const classes = renderedClasses(renderRole.tableCaption());
  assert.ok(classes.includes("text-caption"), `text-caption never reached: ${classes}`);
  assert.ok(classes.includes("text-muted-foreground"), String(classes));
});

test("type roles (e): StatusPill keeps text-caption beside a DYNAMIC colour", () => {
  // The hardest of the twelve: its colour arrives through a variable
  // (STATUS_STYLES[status].label), so no static scan of the source can see the
  // collision — only the rendered string can.
  const classes = renderedClasses(renderRole.statusPill());
  assert.ok(classes.includes("text-caption"), `text-caption never reached: ${classes}`);
  assert.ok(classes.includes("text-status-draft-foreground"), String(classes));
});

// ── 3.9: Objective & budget ──────────────────────────────────────────────────
// The three jobs columns are live (all NULL on every real job). Everything
// here runs against hand-built objects; the section's completeness finally has
// observable behaviour, which is what 1c below exercises.

const OBJ_SPEC = SECTIONS.find((s) => s.id === "objective-budget");

test("3.9 (1c): the active section MOVES when an objective lands — the newly observable behaviour", () => {
  // The path-E fixture from the phaseStates test: roof + site + bill + tariff,
  // no objective. objective-budget must be the active section...
  const base = emptyJob({
    path: "E",
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
    storeys: 1,
    roof_material: "tile",
    dwelling_type: "house",
    electrical_phase: "single",
    bills: [{ bill_id: "b1" }],
    tariffs: [{ tariff_id: "t1" }],
  });
  const before = sectionStates(base).filter((s) => s.state === "active");
  assert.equal(before.length, 1);
  assert.equal(before[0].id, "objective-budget");

  // ...and the SAME fixture plus a stored objective advances it. With the old
  // () => false predicate the section can never complete, the active section
  // never moves, and this second assertion fails — the exact thing that could
  // not be tested before 3.9.
  //
  // 3.10 RETARGET: it now advances PAST equipment-specs to battery-sizing,
  // because equipment-specs became non-gating (D24 — Auto is a real answer,
  // so it confirms rather than requires and must not block a quote), and a
  // non-gating section is never the active one. This assertion therefore
  // proves BOTH that the objective predicate fires AND that the non-gating
  // section is skipped in the ordering.
  const after = sectionStates({ ...base, objective: "max_npv" }).filter(
    (s) => s.state === "active",
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "battery-sizing");
  // ...and equipment-specs is openable rather than locked while that happens.
  const equip = sectionStates({ ...base, objective: "max_npv" })
    .find((s) => s.id === "equipment-specs");
  assert.equal(equip?.state, "unlocked");
});

test("3.9 (1d): complete() — true for each of the four, false for everything else", () => {
  for (const objective of VALID_OBJECTIVES) {
    assert.equal(OBJ_SPEC?.complete(emptyJob({ objective })), true,
      `${objective} must complete the section`);
  }
  for (const bad of ["", null, 7, undefined, "backup"] as const) {
    const job = bad === undefined ? emptyJob({}) : emptyJob({ objective: bad as never });
    assert.equal(OBJ_SPEC?.complete(job), false,
      `${String(bad)} must NOT complete the section`);
  }
  // "backup" is the case that fails the day someone adds it to the UI without
  // adding it to the engine — it is D29'd out until 4.5 does both in one change.
});

test("3.9 (1e): a budget alone does not complete; an objective alone does", () => {
  assert.equal(OBJ_SPEC?.complete(emptyJob({ budget_aud: 20000 })), false,
    "a budget with no objective is not a finished section");
  assert.equal(OBJ_SPEC?.complete(emptyJob({ objective: "min_payback" })), true,
    "no cap is a real answer — an objective with no budget completes");
});

test("3.9 (1f): OBJECTIVE_OPTIONS' value set equals VALID_OBJECTIVES, both directions", () => {
  const optionValues = new Set(OBJECTIVE_OPTIONS.map((o) => o.value));
  const engine = new Set<string>(VALID_OBJECTIVES);
  for (const v of engine) {
    assert.ok(optionValues.has(v), `engine objective ${v} has no on-screen option`);
  }
  for (const v of optionValues) {
    assert.ok(engine.has(v), `option ${v} names no engine objective`);
  }
  assert.equal(OBJECTIVE_OPTIONS.length, VALID_OBJECTIVES.length);
  // Plain English on screen — no engine identifier leaks into a label.
  for (const o of OBJECTIVE_OPTIONS) {
    assert.ok(!o.label.includes("_"), `label "${o.label}" reads as an identifier`);
  }
});

test("3.9 (1g): objectiveBudgetView across the stored shapes", () => {
  // Empty job — quiet: no notices, empty state, weight text shows the
  // engine's real default so the slider means what it says.
  const empty = objectiveBudgetView(emptyJob({}));
  assert.equal(empty.state, "empty");
  assert.equal(empty.objective, null);
  assert.equal(empty.objectiveIsKnown, false);
  assert.equal(empty.customWeight.text, "0.5");
  assert.equal(empty.budgetAud.text, "");
  assert.deepEqual(empty.notices, []);

  // Custom with a stored weight — the blend caption (a fact, not a finding).
  const custom = objectiveBudgetView(emptyJob({ objective: "custom", custom_weight: 0.25 }));
  assert.equal(custom.state, "stored");
  assert.equal(custom.objectiveIsKnown, true);
  assert.equal(custom.customWeight.raw, 0.25);
  assert.equal(custom.customWeight.text, "0.25");
  assert.equal(custom.notices.length, 1);
  assert.equal(custom.notices[0].level, "caption");

  // THE POSTGREST CASE: budget_aud arrives as the STRING "20000" — it must
  // read 20000, not empty. A view that only accepts typeof === "number"
  // silently shows an empty budget on a job that has one.
  const stringBudget = objectiveBudgetView(emptyJob({ budget_aud: "20000" as never }));
  assert.equal(stringBudget.budgetAud.raw, 20000);
  assert.equal(stringBudget.budgetAud.text, "20000");

  // A stored weight outside 0..1 is unreadable — text falls back to "0.5".
  const badWeight = objectiveBudgetView(emptyJob({ objective: "custom", custom_weight: 7 }));
  assert.equal(badWeight.customWeight.raw, null);
  assert.equal(badWeight.customWeight.text, "0.5");

  // A stored objective the engine does not know: kept raw, flagged once as a
  // caution NOTICE, and the section stays incomplete.
  const banana = objectiveBudgetView(emptyJob({ objective: "banana" }));
  assert.equal(banana.state, "stored");
  assert.equal(banana.objective, "banana");
  assert.equal(banana.objectiveIsKnown, false);
  assert.equal(banana.notices.length, 1);
  assert.equal(banana.notices[0].level, "notice");
  assert.equal(banana.notices[0].tone, "caution");
  assert.equal(OBJ_SPEC?.complete(emptyJob({ objective: "banana" })), false);
});

test("3.9 (1h): objectiveSaveNotices — the round-trip check compares COERCED values", () => {
  // THE COERCION CASE: sent the number 20000, PostgREST returns the string
  // "20000". A naive === comparison raises a problem notice on every single
  // save — so this assertion changes exactly when that fault is present.
  assert.deepEqual(
    objectiveSaveNotices({ budget_aud: 20000 }, { budget_aud: "20000" }),
    [],
  );
  // A row that actually disagrees IS a problem — one notice.
  const disagree = objectiveSaveNotices(
    { objective: "min_payback" },
    { objective: "max_npv" },
  );
  assert.equal(disagree.length, 1);
  assert.equal(disagree[0].tone, "problem");
  assert.equal(disagree[0].level, "notice");
  // A returned row MISSING a sent key is a disagreement, not a pass.
  const missing = objectiveSaveNotices({ objective: "max_npv" }, {});
  assert.equal(missing.length, 1);
  assert.equal(missing[0].tone, "problem");
  // A cleared budget round-trips: sent null, returned null — no notice.
  assert.deepEqual(
    objectiveSaveNotices({ budget_aud: null }, { budget_aud: null }),
    [],
  );
  // Keys NOT sent are not compared — a stale stored custom_weight is
  // deliberately left alone by the payload rules, never a false alarm.
  assert.deepEqual(
    objectiveSaveNotices({ objective: "max_npv" }, { objective: "max_npv", custom_weight: 0.3 }),
    [],
  );
});

test("3.9 (1i): every objective view function survives junk as the whole job", () => {
  for (const junk of [null, undefined, [], {}, "a job", 42]) {
    assert.doesNotThrow(() => objectiveBudgetView(junk));
    assert.doesNotThrow(() => objectiveSaveNotices(junk, junk));
    const view = objectiveBudgetView(junk);
    assert.equal(view.state, "empty");
    assert.notEqual(view.customWeight.text, "undefined");
    assert.notEqual(view.budgetAud.text, "undefined");
  }
});

// ── 3.10: Equipment & specs ──────────────────────────────────────────────────
// Before this task the section's predicate was () => false, so it could NEVER
// be complete and the Optimise phase could never read "done". That is the
// behaviour 4a exercises — it was structurally untestable an hour ago.

const EQUIP_SPEC = SECTIONS.find((s) => s.id === "equipment-specs");

const CAT_PANEL = {
  id: "p1", brand: "Jinko", model: "Tiger Neo", origin: "catalogue",
  rated_power_w: 440, module_efficiency_pct: 22.5, length_mm: 1762,
  width_mm: 1134, cost_aud: 130,
};
const CAT_INVERTER = {
  id: "i1", brand: "Fronius", model: "Primo", origin: "catalogue",
  inverter_type: "hybrid", phases: "single", rated_ac_power_kw: 5,
  max_efficiency_pct: 98.2, cost_aud: 1500,
};
const CAT_BATTERY = {
  id: "b1", brand: "Sungrow", model: "SBR128", origin: "catalogue",
  usable_capacity_kwh: 12.8, depth_of_discharge_pct: 100,
  round_trip_efficiency_pct: 96, max_continuous_charge_kw: 6.6,
  max_continuous_discharge_kw: 6.6, warranty_cycles: 6000,
  warranty_years: 10, cost_aud: 8000,
};
const FULL_CATALOGUE = {
  panels: [CAT_PANEL], inverters: [CAT_INVERTER], batteries: [CAT_BATTERY], flags: [],
};

test("3.10 (4a): the NEWLY OBSERVABLE behaviour — confirmed ticks the section, and Optimise can finally reach done", () => {
  // Non-gating, so an unconfirmed section is "unlocked" — never "active"
  // (it is not what to do next) and never "locked".
  const unconfirmed = sectionStates(emptyJob({ path: "A", equipment_confirmed: false }));
  const equipUnconfirmed = unconfirmed.find((s) => s.id === "equipment-specs");
  assert.equal(equipUnconfirmed?.state, "unlocked");
  assert.notEqual(equipUnconfirmed?.state, "active");
  assert.notEqual(equipUnconfirmed?.state, "locked");

  const confirmed = sectionStates(emptyJob({ path: "A", equipment_confirmed: true }));
  assert.equal(confirmed.find((s) => s.id === "equipment-specs")?.state, "complete");

  // ...and the whole Optimise phase can now read "done", which was
  // structurally impossible while the predicate was () => false.
  const optimiseIds = sectionsForPath("A")
    .filter((s) => s.phase === "optimise")
    .map((s) => s.id);
  const doneJob = emptyJob({
    path: "A",
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
    storeys: 1, roof_material: "tile", dwelling_type: "house", electrical_phase: "single",
    bills: [{ bill_id: "b1" }], tariffs: [{ tariff_id: "t1" }],
    objective: "max_npv",
    equipment_confirmed: true,
    sizing_results: [{ solar_kw: 6.6, battery_kwh: 13.5 }],
  });
  const states = sectionStates(doneJob);
  for (const id of optimiseIds) {
    assert.equal(states.find((s) => s.id === id)?.state, "complete",
      `${id} must be complete for Optimise to read done`);
  }
  assert.equal(phaseStates(doneJob)[2], "done");
});

test("3.10 (4b): complete() is true for boolean true ONLY — a truthy check would tick on the string \"true\"", () => {
  assert.equal(EQUIP_SPEC?.complete(emptyJob({ equipment_confirmed: true })), true);
  for (const bad of [false, null, 0, "", "true", {}] as const) {
    assert.equal(EQUIP_SPEC?.complete(emptyJob({ equipment_confirmed: bad as never })), false,
      `${JSON.stringify(bad)} must NOT complete the section`);
  }
  assert.equal(EQUIP_SPEC?.complete(emptyJob({})), false, "absent must not complete it");
});

test("3.10 (4c): gates is false on equipment-specs and site-details, and unchanged on every other section", () => {
  // The full map, both directions — an accidental change to ANY section fails here.
  const nonGating = new Set(
    SECTIONS.filter((s) => s.gates === false).map((s) => s.id),
  );
  assert.deepEqual([...nonGating].sort(), ["equipment-specs", "site-details"]);
  for (const section of SECTIONS) {
    const expected = section.id === "equipment-specs" || section.id === "site-details";
    assert.equal(section.gates === false, expected,
      `${section.id}: gates === false should be ${expected}`);
  }
});

test("3.10 (4d): equipmentSpecsView across the stored shapes", () => {
  // Nothing stored — three Autos, catalogue fine.
  const empty = equipmentSpecsView(emptyJob({}), FULL_CATALOGUE);
  assert.equal(empty.confirmed, false);
  assert.equal(empty.catalogueAvailable, true);
  assert.equal(empty.panels.selectedId, null);
  assert.equal(empty.panels.options.length, 1);
  assert.deepEqual(empty.batteries.specs, []);

  // One kind pinned.
  const onePinned = equipmentSpecsView(emptyJob({ equipment_battery_id: "b1" }), FULL_CATALOGUE);
  assert.equal(onePinned.batteries.selectedId, "b1");
  assert.equal(onePinned.batteries.inList, true);
  assert.equal(onePinned.batteries.selectedLabel, "Sungrow SBR128");
  assert.ok(onePinned.batteries.specs.length > 0);
  assert.equal(onePinned.panels.selectedId, null);

  // All three pinned.
  const allPinned = equipmentSpecsView(
    emptyJob({ equipment_panel_id: "p1", equipment_inverter_id: "i1", equipment_battery_id: "b1" }),
    FULL_CATALOGUE);
  for (const kind of EQUIPMENT_KINDS) {
    assert.equal(allPinned[kind].inList, true, `${kind} should be in list`);
    assert.ok(allPinned[kind].specs.length > 0, `${kind} should have specs`);
  }

  // A stored id absent from the catalogue — KEPT, marked, never reset.
  const missing = equipmentSpecsView(emptyJob({ equipment_panel_id: "gone-1" }), FULL_CATALOGUE);
  assert.equal(missing.panels.selectedId, "gone-1", "the stored id must survive");
  assert.equal(missing.panels.inList, false);
  assert.equal(missing.panels.selectedLabel, null);
  assert.ok(missing.notices.some((n) => n.title === EQUIPMENT_MISSING_NOTICE.title));

  // Catalogue missing entirely, and the unavailable flag — both read false.
  assert.equal(equipmentSpecsView(emptyJob({}), null).catalogueAvailable, false);
  assert.equal(
    equipmentSpecsView(emptyJob({}), { ...FULL_CATALOGUE, flags: ["equipment_catalogue_unavailable"] })
      .catalogueAvailable, false);

  // A user_defined unit chosen.
  const custom = equipmentSpecsView(
    emptyJob({ equipment_battery_id: "u1" }),
    { ...FULL_CATALOGUE, batteries: [{ ...CAT_BATTERY, id: "u1", origin: "user_defined" }] });
  assert.equal(custom.batteries.selectedIsUserDefined, true);
  assert.ok(custom.batteries.selectedLabel?.includes("your own, unverified"));

  // An empty kind list is a data gap, not an error.
  const noInverters = equipmentSpecsView(emptyJob({}), { ...FULL_CATALOGUE, inverters: [] });
  assert.equal(noInverters.inverters.emptyList, true);
  assert.equal(noInverters.panels.emptyList, false);
});

test("3.10 (4e): the spec rows NEVER state an engine default — guarding against a SECOND COPY of battery_optimiser's assumptions", () => {
  // Every defaultable spec null: the engine would assume 90% RTE, 0.5C,
  // 6000 cycles and full depth of discharge, and it says so in its OWN flags
  // where it runs. If someone later puts those numbers in this UI, they
  // appear in the rendered rows and this test fails.
  const bare = {
    id: "b9", brand: "Acme", model: "Bare", origin: "catalogue",
    usable_capacity_kwh: 10, cost_aud: 7000,
    depth_of_discharge_pct: null, round_trip_efficiency_pct: null,
    max_continuous_charge_kw: null, max_continuous_discharge_kw: null,
    warranty_cycles: null, warranty_years: null,
  };
  const view = equipmentSpecsView(
    emptyJob({ equipment_battery_id: "b9" }),
    { ...FULL_CATALOGUE, batteries: [bare], flags: [] });
  const rendered = view.batteries.specs.map((r) => `${r.label} ${r.value}`).join(" | ");
  assert.ok(rendered.includes(SPEC_NOT_STATED), rendered);
  for (const forbidden of ["90", "0.5", "6000", "100%"]) {
    assert.ok(!rendered.includes(forbidden),
      `the engine's default "${forbidden}" must not appear in the UI: ${rendered}`);
  }
  // The specs that ARE stored still show.
  assert.ok(rendered.includes("10 kWh"), rendered);
});

test("3.10 (4f): D25 classification — and an empty unconfirmed job is QUIET", () => {
  assert.equal(EQUIPMENT_AUTO_CAPTION.level, "caption");
  assert.equal(EQUIPMENT_UNVERIFIED_NOTICE.level, "notice");
  assert.equal(EQUIPMENT_UNVERIFIED_NOTICE.tone, "caution");
  assert.equal(EQUIPMENT_MISSING_NOTICE.level, "notice");
  assert.equal(EQUIPMENT_MISSING_NOTICE.tone, "caution");
  assert.equal(EQUIPMENT_CATALOGUE_PROBLEM.level, "notice");
  assert.equal(EQUIPMENT_CATALOGUE_PROBLEM.tone, "problem");

  // Three Autos, nothing confirmed: the Auto caption and NOTHING louder.
  const quiet = equipmentSpecsView(emptyJob({}), FULL_CATALOGUE);
  assert.equal(quiet.notices.length, 1);
  assert.equal(quiet.notices[0].level, "caption");
  assert.ok(!quiet.notices.some((n) => n.tone === "caution"), "no caution on an empty job");
  assert.ok(!quiet.notices.some((n) => n.tone === "problem"), "no problem on an empty job");

  // All three pinned to catalogue units: no Auto anywhere, so no Auto caption.
  const pinned = equipmentSpecsView(
    emptyJob({ equipment_panel_id: "p1", equipment_inverter_id: "i1", equipment_battery_id: "b1" }),
    FULL_CATALOGUE);
  assert.deepEqual(pinned.notices, []);
});

test("3.10 (4g): equipmentSaveNotices — the round-trip check", () => {
  // Agreement.
  assert.deepEqual(
    equipmentSaveNotices(
      { equipment_battery_id: "b1", equipment_confirmed: true },
      { equipment_battery_id: "b1", equipment_confirmed: true }),
    []);
  // A disagreeing id.
  const bad = equipmentSaveNotices(
    { equipment_battery_id: "b1" }, { equipment_battery_id: "b2" });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].tone, "problem");
  assert.ok(bad[0].body.includes("battery"), bad[0].body);
  // Confirmation sent true, returned false.
  const unconfirmed = equipmentSaveNotices(
    { equipment_confirmed: true }, { equipment_confirmed: false });
  assert.equal(unconfirmed.length, 1);
  assert.ok(unconfirmed[0].body.includes("confirmation"), unconfirmed[0].body);
  // null and "" are the SAME stored value, not a disagreement.
  assert.deepEqual(
    equipmentSaveNotices({ equipment_panel_id: null }, { equipment_panel_id: "" }), []);
  assert.deepEqual(
    equipmentSaveNotices({ equipment_panel_id: null }, { equipment_panel_id: null }), []);
  // Keys NOT sent are never compared.
  assert.deepEqual(
    equipmentSaveNotices({ equipment_confirmed: true },
                         { equipment_confirmed: true, equipment_panel_id: "p9" }), []);
});

test("3.10 (4h): every new export survives junk as the whole job AND as the whole catalogue", () => {
  for (const junk of [null, undefined, [], {}, "a job", 42]) {
    for (const cat of [null, undefined, [], {}, "a catalogue", 7]) {
      assert.doesNotThrow(() => equipmentSpecsView(junk, cat));
      const view = equipmentSpecsView(junk, cat);
      assert.equal(view.confirmed, false);
      assert.equal(view.catalogueAvailable, false);
      for (const kind of EQUIPMENT_KINDS) {
        assert.ok(Array.isArray(view[kind].options));
        assert.ok(Array.isArray(view[kind].specs));
      }
    }
    assert.doesNotThrow(() => equipmentSaveNotices(junk, junk));
    assert.ok(Array.isArray(equipmentSaveNotices(junk, junk)));
  }
  // Rows that are not objects are dropped, not rendered as undefined.
  const junkRows = equipmentSpecsView(emptyJob({}), { panels: [null, 1, "x"], flags: [] });
  assert.deepEqual(junkRows.panels.options, []);
});

test("3.10 (4i): EQUIPMENT_KINDS has exactly three members and matches the catalogue keys, both directions", () => {
  assert.equal(EQUIPMENT_KINDS.length, 3);
  const kinds = new Set<string>(EQUIPMENT_KINDS);
  const catalogueKeys = new Set(Object.keys(FULL_CATALOGUE).filter((k) => k !== "flags"));
  for (const k of kinds) assert.ok(catalogueKeys.has(k), `${k} missing from the catalogue shape`);
  for (const k of catalogueKeys) assert.ok(kinds.has(k), `${k} is not a declared kind`);
  // The view exposes exactly these three kind views.
  const view = equipmentSpecsView(emptyJob({}), FULL_CATALOGUE);
  for (const k of EQUIPMENT_KINDS) assert.equal(view[k].kind, k);
});
