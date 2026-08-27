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
  CHOSEN_NOT_RECORDED_NOTE,
  RAIL_DECLINE_FLAG,
  RAIL_SELF_SUFFICIENCY_NOT_RECORDED,
  RAIL_SPLIT_CURRENT_ONLY,
  legacySelfSufficiencyByMatch,
  storedSelfSufficiencyPct,
  parseRunHistory,
  railCompareView,
  railComparability,
  railHistoryMeta,
  railDeltas,
  railHistoryNotice,
  railNotRecordedNote,
  railRunLabel,
  type RailFigures,
  type RailDelta,
  railPickerState,
  railRerankedCurve,
  rankSolarPoints,
  type RailHistoryRun,
  type RailRunMeta,
  RAIL_NOT_SAVED,
  RAIL_STATE_KINDS,
  railBaselineView,
  railFailedState,
  railRecostRequest,
  railRecostState,
  railRequestKeysFor,
  railRerank,
  railStatusLine,
  type RailState,
  type SizingInputChange,
  FLAT_OPTIONS_RATIO,
  SOLAR_CURVE_NOT_RECORDED,
  SOLAR_CURVE_NO_OPTIONS,
  flatOptionsNote,
  solarCurveView,
  RESULTS_BAR_AUTOEXPAND_LIMIT,
  RESULTS_BAR_AUTOEXPAND_STORAGE_KEY,
  RESULTS_BAR_DEFAULT_HEIGHT,
  RESULTS_BAR_MIN_HEIGHT,
  RESULTS_BAR_STRIP,
  VALUE_ORIGIN_ALL_SOLAR_LABEL,
  VALUE_ORIGIN_NOT_RECORDED_LABEL,
  parseAutoExpandedJobs,
  rememberAutoExpandedJob,
  shouldAutoExpandResultsBar,
  PATH_RULES,
  SECTIONS,
  clampResultsBarHeight,
  currentSizingResult,
  storedLoadProfile,
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
  EMPTY_SURVEY_ANSWERS,
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
  ROOF_CONFIRM_FAILED_NOTICE,
  ROOF_NOT_SAVED_NOTICE,
  roofActionErrorNotice,
  roofDiagramCaptionLines,
  roofOmittedPlanesNotice,
  roofStateMismatchNotice,
  CUSTOM_EQUIPMENT_FIELDS,
  EQUIPMENT_AUTO_CAPTION,
  EQUIPMENT_CATALOGUE_PROBLEM,
  EQUIPMENT_KINDS,
  EQUIPMENT_MISSING_NOTICE,
  EQUIPMENT_UNVERIFIED_NOTICE,
  SPEC_NOT_STATED,
  customUnitNotices,
  SOLAR_EXISTING_UNRECORDED_NOTICE,
  SOLAR_SIZING_REQUEST_KEYS,
  solarRunNotices,
  solarRunResult,
  solarSizingView,
  BATTERY_SIZING_REQUEST_KEYS,
  batteryRunNotices,
  batteryRunResult,
  currentFinancialResult,
  formatKw,
  formatKwh,
  formatMoney,
  formatMoneyCents,
  formatPct,
  formatYears,
  projectedSpendView,
  roiFigures,
  ROI_EXPLANATIONS,
  scoreCurveView,
  scoreCurveAxisSpace,
  truncateLabel,
  SCORE_CURVE_AXIS,
  formatAxisTick,
  niceAxisTicks,
  resultsTabView,
  elapsedLabel,
  batterySizingView,
  sizingRunNotices,
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
  tariffFlatSaveConfirmation,
  tariffNetworkView,
  tariffSaveNotices,
  ASSUMPTION_SOURCE_WORDS,
  isUnconstrained,
  PREFILLED_TARIFF_FIELDS,
  SAVABLE_TARIFF_FIELDS,
  tariffFieldSources,
  tariffFormFromView,
  type TariffFormState,
  type TariffNetworkView,
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
  resultsView,
  storedIncentives,
  incentivesView,
  isMultiDwellingAddress,
  roofEntryState,
  sectionStates,
  sectionsForPath,
  showsGoogleSolarAttribution,
  siteDetailsView,
  worksheetErrorCopy,
  type AddressRoofView,
  type JobDetailLike,
  type ResultsBarView,
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
    // section must always be openable. site-details (D5); from 3.10,
    // equipment-specs (D24: Auto is a real answer, so it confirms rather than
    // requires, and it must not block a quote); and from 3.13b, incentives
    // (nothing in it is the installer's to fill in, so it must not block
    // Summary & finish). Every OTHER section locks exactly as before.
    const expected =
      states[i].id === "site-details" ||
      states[i].id === "equipment-specs" ||
      states[i].id === "incentives"
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
    // A parsed bill writes a load_profiles row; Energy data now ticks on the
    // LOAD the engine could use, not on the bill row's mere existence
    // (2026-08-20). Without this the fixture describes a job that can never be
    // sized, which was never what these tests were about.
    load_profiles: [{ annual_kwh: 5500, created_at: "2026-08-01T00:00:00Z" }],
    tariffs: [{ tariff_id: "t1" }],
    // 3.13 prompt 3: the Results predicate now demands the financial row for
    // THE CURRENT sizing result, so the all-complete fixture links them.
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6, battery_kwh: 12.8 }],
    financial_results: [{ sizing_result_id: "s1", payback_years: 4.2 }],
  });
  // 3.13b: NO predicate is hardcoded any more — equipment-specs has been real
  // since 3.10 (equipment_confirmed) and incentives is real now (the current
  // run's stored breakdown carries an incentive line), so "all true" is a job
  // that genuinely satisfies all eleven, with nothing patched. The
  // patch-and-force mechanism died with the last hardcoded predicate.
  const satisfied = {
    ...job,
    objective: "max_npv",
    equipment_confirmed: true,
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 6.6, battery_kwh: 12.8,
      evaluated_options: {
        chosen_cost_breakdown: {
          net_cost: 10000,
          line_items: [{ item: "STCs (solar)", detail: "", amount_aud: -2331 }],
        },
      },
    }],
  };
  const done = SECTIONS.map((s) => s.complete(satisfied));
  assert.ok(done.every(Boolean), `not all predicates true: ${JSON.stringify(done)}`);
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
      selfSufficiencyPct: null,
      splitSolarNpv: null,
      splitBatteryNpv: null,
      valueOrigin: { kind: "all-solar", label: VALUE_ORIGIN_ALL_SOLAR_LABEL },
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
    // A parsed bill writes a load_profiles row; Energy data now ticks on the
    // LOAD the engine could use, not on the bill row's mere existence
    // (2026-08-20). Without this the fixture describes a job that can never be
    // sized, which was never what these tests were about.
    load_profiles: [{ annual_kwh: 5500, created_at: "2026-08-01T00:00:00Z" }],
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
  // 3.4c-4 (D24): the found state reads as a PREFILL now — info, not a success tick.
  assert.equal(found.notice?.tone, "info");
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

// ── Per-face provenance + reconciliation (3.4c prompt 2, F231/F168/F94) ─────
// Fixtures shaped from the LIVE rows, read 2026-08-25.

/** a57e13f1's newest roof (e34f61dc): ours [3,8,2,8,2,3] vs Google [null,8,null,8,2,3]. */
const A57_ROW = {
  created_at: "2026-08-20T01:00:00Z",
  found: true,
  source: "google_solar",
  google_max_array_panels_count: 21,
  planes: [
    { azimuth: 300.4, pitch: 23.1, area_m2: 11.1, usable_area_m2: 7.8, panel_count: 3, kwp: 1.32, google_panel_count: null },
    { azimuth: 113.5, pitch: 5.6, area_m2: 27.1, usable_area_m2: 19.0, panel_count: 8, kwp: 3.52, google_panel_count: 8 },
    { azimuth: 131.3, pitch: 27.5, area_m2: 7.2, usable_area_m2: 5.04, panel_count: 2, kwp: 0.88, google_panel_count: null },
    { azimuth: 302.2, pitch: 29.2, area_m2: 24.7, usable_area_m2: 17.28, panel_count: 8, kwp: 3.52, google_panel_count: 8 },
    { azimuth: 120.2, pitch: 29.3, area_m2: 10.7, usable_area_m2: 7.5, panel_count: 2, kwp: 0.88, google_panel_count: 2 },
    { azimuth: 51.0, pitch: 8.2, area_m2: 14.5, usable_area_m2: 10.12, panel_count: 3, kwp: 1.32, google_panel_count: 3 },
  ],
};

/** 670c80db's newest roof (74f3d9e2): ours 27 vs Google 28, all four faces assessed. */
const BISHOPS_ROW = {
  created_at: "2026-08-17T01:00:00Z",
  found: true,
  source: "google_solar",
  google_max_array_panels_count: 28,
  planes: [
    { azimuth: 211.5, pitch: 39.3, area_m2: 38.41, usable_area_m2: 26.89, panel_count: 13, kwp: 5.72, google_panel_count: 14 },
    { azimuth: 134.8, pitch: 25.9, area_m2: 12.64, usable_area_m2: 8.85, panel_count: 3, kwp: 1.32, google_panel_count: 3 },
    { azimuth: 31.7, pitch: 21.9, area_m2: 30.3, usable_area_m2: 21.21, panel_count: 9, kwp: 3.96, google_panel_count: 9 },
    { azimuth: 27.8, pitch: 34.9, area_m2: 11.92, usable_area_m2: 8.34, panel_count: 2, kwp: 0.88, google_panel_count: 2 },
  ],
};

test("D48 (5): a57e13f1 — the marker appears on the two unassessed faces and NO others", () => {
  // WAS "F231 (a): assessed faces agree…". The reconciliation it asserted is
  // deleted by D48; what survives is the per-face provenance, which D48 turns
  // from a label on every face into a marker on the exception (F257: on an
  // assessed face our count is min(area, google), a CEILING — so
  // "from Google's panel layout" was misleading as well as noisy).
  const view = viewFor(A57_ROW);
  assert.deepEqual(
    view.planes.map((p) => p.countSource),
    ["roof_area", "google_layout", "roof_area", "google_layout", "google_layout", "google_layout"],
  );
  assert.deepEqual(
    view.planes.map((p) => p.googlePanelCount),
    [null, 8, null, 8, 2, 3],
  );
  assert.deepEqual(
    view.planes.map((p) => p.countSourceLabel),
    [
      "estimated from area alone", null,
      "estimated from area alone", null, null, null,
    ],
  );
  // Exactly two markers, exactly on the faces with no google_panel_count.
  const marked = view.planes.filter((p) => p.countSourceLabel !== null);
  assert.equal(marked.length, 2);
  assert.ok(marked.every((p) => p.googlePanelCount === null));
});


test("F231 (c) 456e0242 (the Frome row): no layout at all — every face reads roof_area", () => {
  const view = viewFor(FROME_ROW);
  assert.deepEqual(view.planes.map((p) => p.countSource), ["roof_area", "roof_area"]);
  // D48: the marker is short, and every face carries it because Google
  // assessed none of them. (The reconciliation this test also asserted is
  // deleted with the feature.)
  for (const p of view.planes) {
    assert.equal(p.countSourceLabel, "estimated from area alone");
  }
});

test("F231: the MEASURED zero — google_panel_count 0 is google_layout, never roof_area", () => {
  // A falsy check instead of a null check flips exactly this case, and it is
  // the difference between "Google looked and nothing fits" and "nobody looked".
  const view = viewFor(
    roofRow({
      planes: [
        { azimuth: 10, pitch: 20, area_m2: 10, usable_area_m2: 7, panel_count: 0, kwp: 0, google_panel_count: 0 },
        { azimuth: 200, pitch: 20, area_m2: 30, usable_area_m2: 21, panel_count: 9, kwp: 3.96, google_panel_count: null },
      ],
    }),
  );
  assert.equal(view.planes[0].countSource, "google_layout");
  // D48: an assessed face carries NO marker — mark the exception, not the rule.
  assert.equal(view.planes[0].countSourceLabel, null);
  assert.equal(view.planes[1].countSource, "roof_area");
  // An unusable google_panel_count is not a number Google gave us — roof_area.
  const junk = viewFor(
    roofRow({ planes: [{ azimuth: 10, pitch: 20, panel_count: 3, google_panel_count: unsafe<number>("3") }] }),
  );
  assert.equal(junk.planes[0].countSource, "roof_area");
});



test("F168: orientationLabel — direction and pitch in plain words, degrading to each alone", () => {
  const view = viewFor(
    roofRow({
      planes: [
        { azimuth: 158, pitch: 23.4, panel_count: 5, kwp: 2.2 },
        { azimuth: null, pitch: 20, panel_count: 2, kwp: 0.88 },
        { azimuth: 0, panel_count: 2, kwp: 0.88 },
        { panel_count: 1, kwp: 0.44 },
      ],
    }),
  );
  // D47 (was "faces south-south-east, 23 degree pitch"): the pitch left this
  // label because the table's own Pitch column sits immediately alongside it.
  assert.equal(view.planes[0].orientationLabel, "faces south-south-east");
  assert.ok(
    !/pitch/i.test(view.planes[0].orientationLabel),
    "a known azimuth must not restate the pitch",
  );
  // THE FALLBACK STAYS: with no azimuth this label is the only place the pitch
  // appears in words, so change 1 cannot be implemented by deleting it here.
  assert.equal(view.planes[1].orientationLabel, "20 degree pitch");
  assert.equal(view.planes[2].orientationLabel, "faces north");
  assert.equal(view.planes[3].orientationLabel, null);
});



test("F94: rounded strings emitted beside the raw numbers, which stay unrounded", () => {
  const frome = viewFor(FROME_ROW);
  // roof_area face: area coarser still — said as approximate, whole metres.
  assert.equal(frome.planes[1].usableAreaM2Label, "about 48 m²");
  assert.equal(frome.planes[1].areaM2Label, "about 68 m²");
  assert.equal(frome.planes[1].usableAreaM2, 47.82); // raw, untouched
  assert.equal(frome.planes[1].kwpLabel, "10.1 kW"); // one decimal, never two
  assert.equal(frome.planes[1].kwp, 10.12); // raw, untouched
  assert.equal(frome.totalKwpLabel, "10.1 kW");
  assert.equal(frome.totals.kwp, 10.12); // raw total, untouched
  const a57 = viewFor(A57_ROW);
  // google_layout face: whole metres, no "about".
  assert.equal(a57.planes[1].usableAreaM2Label, "19 m²");
  assert.equal(a57.planes[1].kwpLabel, "3.5 kW");
  assert.equal(a57.totalKwpLabel, "11.4 kW"); // 11.44 raw
  assert.equal(a57.totals.kwp, 11.44);
});

test("3.4c prompt 2: totality — junk in, fields out, nothing invented, nothing thrown", () => {
  assert.equal(addressRoofView(null).totalKwpLabel, null);
  const junkPlanes = viewFor(roofRow({ planes: "not-a-list" }));
  assert.deepEqual(junkPlanes.planes, []);
  assert.deepEqual(junkPlanes.totals, { panels: 0, kwp: 0 });
  const bare = viewFor(roofRow({ planes: [{}] }));
  assert.equal(bare.planes[0].countSource, "roof_area");
  assert.equal(bare.planes[0].orientationLabel, null);
  assert.equal(bare.planes[0].areaM2Label, null);
  assert.equal(bare.planes[0].kwpLabel, null);
  assert.doesNotThrow(() => JSON.stringify(viewFor(A57_ROW)));
});

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
  // D48: the subject is Google's model, never the photograph. The advice is
  // unchanged, and is asserted for substance in the D48 (4) test below.
  assert.equal(view.confidenceNotices[0].title, "This may be a newer build than Google's model");
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
      "This may be a newer build than Google's model",
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

// ── 3.18 prompt 3 (D44): a hand-entered roof says WHEN it was entered ───────

test("3.18-3 (A): the three manual captions carry the entry date", () => {
  const captionFor = (over: Record<string, unknown>) =>
    addressRoofView(emptyJob({ roof_geometry: [roofRow(over)] })).notice;

  // roofRow's created_at is 2026-08-14T01:00:00Z. Rows are APPEND-ONLY and a
  // manual entry writes a new row, so created_at IS the entry moment.
  const plans = captionFor({ source: "manual_plans" });
  assert.equal(plans?.title, "Entered from plans");
  assert.match(plans?.body ?? "", /Entered on 14 August 2026\.$/);
  assert.match(plans?.body ?? "", /^Plans are the most accurate roof source we can get\./);

  const measure = captionFor({ source: "manual_site_measure" });
  assert.equal(measure?.title, "Entered from a site measure");
  assert.match(measure?.body ?? "", /Entered on 14 August 2026\.$/);

  const estimate = captionFor({ source: "manual_estimate" });
  assert.equal(estimate?.title, "Estimated");
  assert.match(estimate?.body ?? "", /Entered on 14 August 2026\.$/);
});

test("3.18-3 (A): a missing or unparseable date renders NO date, never 'undefined'", () => {
  // THE SPECIFIC WAY THIS FAILS: a date pipeline that stringifies whatever it
  // was given puts "undefined" or "Invalid Date" in front of an installer.
  const bases = ["manual_plans", "manual_site_measure", "manual_estimate"];
  const badDates: unknown[] = [
    undefined, null, "", "   ", "not a date", 42, {}, [], "2026-13-45T99:99:99Z",
  ];
  for (const source of bases) {
    for (const created_at of badDates) {
      const notice = addressRoofView(
        emptyJob({ roof_geometry: [roofRow({ source, created_at })] }),
      ).notice;
      const body = notice?.body ?? "";
      assert.ok(body.length > 0, `${source}/${JSON.stringify(created_at)}: body renders`);
      assert.ok(!body.includes("undefined"),
        `${source}/${JSON.stringify(created_at)}: "undefined" reached the caption: ${body}`);
      assert.ok(!body.includes("Invalid Date"),
        `${source}/${JSON.stringify(created_at)}: "Invalid Date" reached the caption: ${body}`);
      assert.ok(!body.includes("Entered on"),
        `${source}/${JSON.stringify(created_at)}: no date means no date clause: ${body}`);
      assert.ok(!body.includes("NaN"), `${source}: NaN reached the caption: ${body}`);
    }
  }
});

test("3.18-3 (A): 'Estimated' no longer reads as success; plans and site measure still do", () => {
  const toneFor = (source: string) =>
    addressRoofView(emptyJob({ roof_geometry: [roofRow({ source })] })).notice?.tone;
  // A best estimate whose own body says "refine it from plans when you can"
  // reading as SUCCESS is the unearned confidence D47 exists to stop.
  assert.equal(toneFor("manual_estimate"), "info");
  // ...and it is not a caution either: the estimate is a deliberate choice, and
  // a caution on every estimated roof is noise that kills cautions (F96).
  assert.notEqual(toneFor("manual_estimate"), "caution");
  assert.equal(toneFor("manual_plans"), "success", "plans ARE good news");
  assert.equal(toneFor("manual_site_measure"), "success", "a site measure IS good news");
});

test("3.18-3 (A): sourceLabel is GONE — the field, the map, and every reference", async () => {
  // It was computed and never shown: 3 hits repo-wide, all inside worksheet.ts,
  // zero in components — the same shape as the caution that was built and never
  // rendered. Where two places must agree, removing one beats gating both.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const lib = readFileSync(path.join(root, "lib/worksheet.ts"), "utf8");
  const roof = readFileSync(
    path.join(root, "components/worksheet/address-roof-section.tsx"), "utf8");
  assert.equal((lib.match(/sourceLabel/g) ?? []).length, 0,
    "sourceLabel must not survive anywhere in the logic layer");
  assert.equal((lib.match(/SOURCE_LABELS/g) ?? []).length, 0,
    "its map had no other user, so it goes with it");
  assert.equal((roof.match(/sourceLabel/g) ?? []).length, 0);
  // The view still serialises and still carries the caption that says the same
  // words with MORE context — nothing was lost by the deletion.
  const view = addressRoofView(
    emptyJob({ roof_geometry: [roofRow({ source: "manual_plans" })] }));
  assert.doesNotThrow(() => JSON.stringify(view));
  assert.equal(view.notice?.title, "Entered from plans");
});

// ── 3.18 prompt 3 (F260): the address wakes the sleeping caution ────────────

/** The fixture table, printed with its verdicts so the decisions are visible
    rather than buried in assertions. */
const ADDRESS_FIXTURES: { address: unknown; multi: boolean; why: string }[] = [
  // The live job that proved the guard was asleep.
  { address: "unit 5/53 Bishops Pl, Kensington SA 5068, Australia", multi: true,
    why: "unit token + slash — the live a57e13f1 address" },
  { address: "Unit 5/53 Bishops Pl", multi: true, why: "capitalised token" },
  { address: "5/53 Bishops Pl", multi: true, why: "the AU unit/street separator alone" },
  { address: "Flat 2, 14 Frome St", multi: true, why: "flat token, no slash" },
  { address: "Apartment 301/2 X St", multi: true, why: "apartment token + slash" },
  { address: "Apt 3 12 Y Rd", multi: true, why: "apt token, no slash" },
  { address: "U 7/9 Z Ave", multi: true, why: "bare U + number, and a slash" },
  { address: "Villa 4/22 W Cr", multi: true, why: "villa token + slash" },
  { address: "Lot 3/5 V St", multi: true,
    why: "fires on the SLASH, not on 'lot' — see the not-caught list" },
  { address: "1/2 Mile Rd", multi: true,
    why: "DECIDED: fires. '1/2' is the unit separator; AU roads are not named "
       + "with fractions, and a missed unit is the fault being fixed" },
  { address: "  UNIT 12/8 Smith St  ", multi: true, why: "case and padding" },
  { address: "u5/53 Bishops Pl", multi: true, why: "no space after the token" },
  // Not multi-dwelling.
  { address: "53 Bishops Pl, Kensington SA 5068, Australia", multi: false,
    why: "plain street address — the neighbouring live job" },
  { address: "14 Frome St, Adelaide SA 5000", multi: false, why: "plain" },
  { address: "8 King William Rd, Wayville SA 5034", multi: false, why: "plain" },
  { address: "12 Flat Rock Rd, Stirling SA 5152", multi: false,
    why: "a token NOT followed by a number is a street name — the reason every "
       + "token requires a trailing digit" },
  { address: "3 Unity St, Adelaide SA 5000", multi: false, why: "'Unity' is not 'unit'" },
  { address: "9 Villa Ave, Brighton SA 5048", multi: false, why: "villa as a street name" },
  { address: "Lot 3 Smith Rd, Mount Barker SA 5251", multi: false,
    why: "DECIDED: not caught — a lot is an unregistered parcel, usually detached" },
  { address: "12A Smith St, Norwood SA 5067", multi: false,
    why: "DECIDED: not caught — a subdivided block is usually its own title/roof" },
  { address: "Level 3, 100 King William St, Adelaide SA 5000", multi: false,
    why: "DECIDED: not caught — commercial tenancy, not a dwelling" },
  { address: "Shop 4, 22 Rundle Mall, Adelaide SA 5000", multi: false,
    why: "DECIDED: not caught — commercial" },
  // Neither way: never throw, never fire.
  { address: "", multi: false, why: "empty" },
  { address: "   ", multi: false, why: "whitespace" },
  { address: null, multi: false, why: "null" },
  { address: undefined, multi: false, why: "undefined" },
  { address: 12345, multi: false, why: "non-string" },
  { address: {}, multi: false, why: "non-string object" },
  { address: ["5/53 Bishops Pl"], multi: false, why: "non-string array" },
];

test("3.18-3 (B): the address parser, fixture by fixture", () => {
  console.log(`        ${"verdict".padEnd(9)} address`);
  for (const f of ADDRESS_FIXTURES) {
    const got = isMultiDwellingAddress(f.address);
    console.log(`        ${(got ? "MULTI" : "single").padEnd(9)} ${JSON.stringify(f.address)}  — ${f.why}`);
    assert.equal(got, f.multi, `${JSON.stringify(f.address)}: ${f.why}`);
  }
});

test("3.18-3 (B): a TYPED value always wins, in both directions", () => {
  const withAddress = (address: unknown, dwelling?: unknown) =>
    siteDetailsView(emptyJob({
      customer: unsafe<JobDetailLike["customer"]>([{ property_address_full: address }]),
      ...(dwelling === undefined ? {} : { dwelling_type: unsafe<string>(dwelling) }),
    }));
  const UNIT = "unit 5/53 Bishops Pl, Kensington SA 5068, Australia";
  const PLAIN = "53 Bishops Pl, Kensington SA 5068, Australia";

  // Nothing typed: the address decides — the whole point of F260.
  assert.equal(withAddress(UNIT).showsMultiDwellingCaution, true,
    "the sleeping caution now wakes on the address alone");
  assert.equal(withAddress(PLAIN).showsMultiDwellingCaution, false);

  // A typed value ALWAYS wins, including a typed detached that SILENCES it.
  assert.equal(withAddress(UNIT, "detached").showsMultiDwellingCaution, false,
    "a typed detached at a unit address silences the caution");
  assert.equal(withAddress(UNIT, "other").showsMultiDwellingCaution, false,
    "other means unknown (F96), and it is still a typed answer");
  assert.equal(withAddress(PLAIN, "unit").showsMultiDwellingCaution, true,
    "a typed unit at a plain street address fires it");
  assert.equal(withAddress(PLAIN, "townhouse").showsMultiDwellingCaution, true);
  assert.equal(withAddress(UNIT, "unit").showsMultiDwellingCaution, true);

  // THE CASE MOST LIKELY TO BE GOT WRONG: a stored value outside the four is
  // not something this view can interpret, so it is NOT the typed confirmation
  // and does not itself fire — the address decides, exactly as if empty. The
  // prompt admits both readings; this one is chosen because the alternative
  // hands back a way for the guard to sleep (store any junk, caution off),
  // which is the fault being fixed. Reported to the inbox.
  assert.equal(withAddress(PLAIN, "duplex").showsMultiDwellingCaution, false,
    "an unrecognised value never fires the caution by itself");
  assert.equal(withAddress(UNIT, "duplex").showsMultiDwellingCaution, true,
    "...and it does not count as the typed confirmation either");
  assert.equal(withAddress(UNIT, "UNIT").showsMultiDwellingCaution, true,
    "the DB stores lowercase; an uppercase value is not a value it can produce");
  assert.equal(withAddress(PLAIN, "UNIT").showsMultiDwellingCaution, false);
});

test("3.18-3 (B): the form line appears ONLY when the address is what is firing", () => {
  const noteFor = (address: unknown, dwelling?: unknown) =>
    siteDetailsView(emptyJob({
      customer: unsafe<JobDetailLike["customer"]>([{ property_address_full: address }]),
      ...(dwelling === undefined ? {} : { dwelling_type: unsafe<string>(dwelling) }),
    })).dwellingTypeDerivedNote;
  const UNIT = "unit 5/53 Bishops Pl";
  const PLAIN = "53 Bishops Pl";

  const note = noteFor(UNIT);
  assert.ok(note, "derived-and-firing shows the line");
  // It explains a FORM FIELD; it must NOT restate the caution, which doubts
  // the ROOF and lives on the roof section (the 3.4c item (d) fault).
  assert.ok(!note!.includes("may not be this dwelling"));
  assert.ok(!/body corporate|Google/i.test(note!),
    "no word of the caution's own argument appears here");
  assert.ok(note!.length < 120, "one SHORT line");

  assert.equal(noteFor(PLAIN), null, "nothing derived, nothing to explain");
  assert.equal(noteFor(UNIT, "unit"), null,
    "typed: the value is the installer's, not the address's");
  assert.equal(noteFor(UNIT, "detached"), null);
  assert.equal(noteFor(UNIT, "duplex"), null,
    "an unrecognised stored value is still a value someone put there");
  assert.equal(noteFor(null), null);
});

test("3.18-3 (B): siteDetailsView stays total, and NOTHING is written", () => {
  const junk: unknown[] = [
    null, undefined, 42, "job", [], {},
    { customer: "not an array" },
    { customer: [null] },
    { customer: [{ property_address_full: 7 }] },
    { customer: [{}], dwelling_type: 9 },
    { customer: [{ property_address_full: "5/53 X St" }], dwelling_type: [] },
  ];
  for (const j of junk) {
    const view = siteDetailsView(j);
    assert.equal(typeof view.showsMultiDwellingCaution, "boolean");
    assert.ok(view.dwellingTypeDerivedNote === null
      || typeof view.dwellingTypeDerivedNote === "string");
    // The derivation NEVER becomes a stored-looking value: the form field is
    // still empty, because a derived value written as though it were typed is
    // the precise defect this row exists to stop.
    assert.equal(view.dwellingTypeField.text, "",
      "the derivation must never prefill the field itself");
    assert.equal(view.dwellingType, null);
  }
  // ...and on the real firing shape too: caution on, field still empty.
  const derived = siteDetailsView(emptyJob({
    customer: unsafe<JobDetailLike["customer"]>([
      { property_address_full: "unit 5/53 Bishops Pl" }]),
  }));
  assert.equal(derived.showsMultiDwellingCaution, true);
  assert.equal(derived.dwellingTypeField.text, "", "no prefill, ever");
  assert.equal(derived.dwellingType, null, "the discriminant stays honest");
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

// The frontend helper reads Date.now() itself, so a test cannot pin the clock
// and cannot honestly assert the EXACT 30-day boundary. That boundary is
// asserted deterministically by backend/scripts/verify_solar_retention.py,
// which freezes its clock. These two assert the behaviour a minute either side
// of it — what a test with a live clock can legitimately claim.
test("solar retention: a minute inside 30 days is NOT yet expired", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({ solar_data_captured_at: daysAgo(30 - 1 / 1440) }),
      ],
    }),
  );
  assert.equal(view.solarDataExpired, false, "a minute inside 30 days is not expired");
});

test("solar retention: a minute past 30 days IS expired", () => {
  const view = addressRoofView(
    emptyJob({
      roof_geometry: [
        googleRoof({ solar_data_captured_at: daysAgo(30 + 1 / 1440) }),
      ],
    }),
  );
  assert.equal(view.solarDataExpired, true, "a minute past 30 days is expired");
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
    // D48: view.staleNotice is deleted — nothing dates the photograph.
    collected.push(view.notice, view.solarExpiredNotice);
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
  // D48 (was: the stale-imagery caption's level and clock glyph). That notice
  // is DELETED — its subject was never the photograph, and nothing dates the
  // photograph (F247, F256). The rest of the reclassification is unchanged.

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
      // 3.13b: non-gating (decided by Mayur 2026-08-25), so unlocked rather
      // than locked — openable early, and it locks nothing beneath it.
      { id: "incentives", state: "unlocked" },
      { id: "summary-finish", state: "locked" },
    ],
  );
  // ...and EXACTLY FOUR sections differ from the old rule, all of them
  // accounted for: the optional section itself (active -> unlocked), the one
  // that should have been active all along (locked -> active), and the two
  // later non-gating sections (locked -> unlocked): 3.10's equipment-specs
  // and 3.13b's incentives. Everything else was already locked under both
  // rules and stays locked, so the change is narrower than it looks: the
  // sections beneath are unlocked by DOING the work, not by these flags. The
  // reference rule above has no concept of `gates`, which is exactly why it
  // diverges on precisely the non-gating sections and nowhere else.
  const before = referenceStates(empty);
  const after = sectionStates(empty).map((s) => ({ id: s.id, state: s.state }));
  const moved = after
    .filter((a, i) => a.state !== before[i].state)
    .map((a) => `${a.id}: ${before[after.indexOf(a)].state} -> ${a.state}`);
  assert.deepEqual(moved, [
    "site-details: active -> unlocked",
    "energy-data: locked -> active",
    "equipment-specs: locked -> unlocked",
    "incentives: locked -> unlocked",
  ]);
});

test("D5 check 5: all gating complete + Site details empty -> unlocked, NOT complete", () => {
  const allDone = liveShapedJob({
    bills: [{ bill_id: "b1" }],
    // A parsed bill writes a load_profiles row; Energy data now ticks on the
    // LOAD the engine could use, not on the bill row's mere existence
    // (2026-08-20). Without this the fixture describes a job that can never be
    // sized, which was never what these tests were about.
    load_profiles: [{ annual_kwh: 5500, created_at: "2026-08-01T00:00:00Z" }],
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
  // And the catalogue itself: exactly THREE sections are non-gating — D5's
  // site-details, 3.10's equipment-specs and 3.13b's incentives. Every other
  // section must still gate, which is what makes the permissive default safe.
  const nonGating = SECTIONS.filter((s) => s.gates === false).map((s) => s.id);
  assert.deepEqual(nonGating, ["site-details", "equipment-specs", "incentives"]);
  for (const s of SECTIONS) {
    if (!["site-details", "equipment-specs", "incentives"].includes(s.id)) {
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

// ── 3.18: provenance of prefilled values — the client derivation ─────────────
// tariffFieldSources is pure and browser-free by design (D25/F128): every case
// below drives it over in-memory fixtures exactly as the component drives it
// at save time. The backend's carry-forward half lives in
// verify_tariff_provenance.py; the two field lists are set-compared across the
// language gap there too.

test("3.18: fieldOrigin — one entry per savable field, always, with its cause", () => {
  // Empty job with both defaults: the two lookup prefills and the form's own
  // flat literal read "lookup_default"; the never-prefilled fields read "none".
  const empty = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS);
  assert.deepEqual(
    Object.keys(empty.fieldOrigin).sort(),
    [...SAVABLE_TARIFF_FIELDS].sort(),
    "one entry for EVERY savable field, no more, no fewer",
  );
  assert.equal(empty.fieldOrigin.fit_aud_per_kwh, "lookup_default");
  assert.equal(empty.fieldOrigin.export_limit_kw, "lookup_default");
  assert.equal(empty.fieldOrigin.tariff_type, "lookup_default");
  assert.equal(empty.fieldOrigin.import_rate, "none");
  assert.equal(empty.fieldOrigin.supply_charge, "none");
  assert.equal(empty.fieldOrigin.tou_windows, "none");

  // A stored row wins per field; the fields it does not carry keep their own
  // answer (the 3.8 (c) per-field rule, now visible as provenance).
  const partial = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.42, export_limit_kw: 7.5 }),
    BOTH_DEFAULTS,
  );
  assert.equal(partial.fieldOrigin.tariff_type, "stored");
  assert.equal(partial.fieldOrigin.import_rate, "stored");
  assert.equal(partial.fieldOrigin.export_limit_kw, "stored");
  assert.equal(partial.fieldOrigin.fit_aud_per_kwh, "lookup_default");
  assert.equal(partial.fieldOrigin.supply_charge, "none");

  // No defaults at all: absence carries its cause — "none", never a label.
  const bare = tariffNetworkView(jobWithTariff(null), { exportLimit: null, fit: null });
  assert.equal(bare.fieldOrigin.fit_aud_per_kwh, "none");
  assert.equal(bare.fieldOrigin.export_limit_kw, "none");

  // Stored TOU windows are "stored"; a row whose windows were all unreadable
  // has nothing to display, so the origin honestly reads "none".
  const tou = tariffNetworkView(
    jobWithTariff({
      tariff_type: "tou",
      tou_windows: [
        { label: "peak", rate: 0.55, start: "18:00", end: "22:00", days: "all" },
        { label: "offpeak", rate: 0.22, start: "22:00", end: "06:00", days: "all" },
      ],
    }),
    BOTH_DEFAULTS,
  );
  assert.equal(tou.fieldOrigin.tou_windows, "stored");
  const unreadable = tariffNetworkView(
    jobWithTariff({ tariff_type: "tou", tou_windows: [{ rate: 0.4 }] }),
    BOTH_DEFAULTS,
  );
  assert.equal(unreadable.fieldOrigin.tou_windows, "none");
});

test("3.18: the caption and the origin map cannot disagree — same fact, both places", () => {
  // Both are computed from the ONE fromStored fact inside tariffNetworkView;
  // this asserts the composed result, not the intention (2N.1).
  const fixtures = [
    jobWithTariff(null),
    jobWithTariff({ tariff_type: "flat", import_rate: 0.42 }),
    jobWithTariff({ tariff_type: "flat", fit_aud_per_kwh: 0.06 }),
    jobWithTariff({ tariff_type: "flat", export_limit_kw: 7.5 }),
    jobWithTariff({ tariff_type: "flat", fit_aud_per_kwh: 0.06, export_limit_kw: 7.5 }),
  ];
  for (const job of fixtures) {
    const view = tariffNetworkView(job, BOTH_DEFAULTS);
    assert.equal(
      view.fitSourceLabel === "From the saved tariff.",
      view.fieldOrigin.fit_aud_per_kwh === "stored",
      "fit caption vs fit origin",
    );
    assert.equal(
      view.exportSourceLabel === "From the saved tariff.",
      view.fieldOrigin.export_limit_kw === "stored",
      "export caption vs export origin",
    );
  }
});

test("3.18 (a): THE F196 CASE — only the import rate typed, the rest accepted defaults", () => {
  const view = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS);
  const form: TariffFormState = { ...tariffFormFromView(view), importRate: "0.42" };
  // deepEqual, not per-key reads: the ABSENT keys (supply_charge empty,
  // tou_windows null on a flat save) are as much the assertion as the present
  // ones. tariff_type is accepted_default because the form's own `?? "flat"`
  // literal prefilled the radio and the person never touched it.
  assert.deepEqual(tariffFieldSources(view, form), {
    tariff_type: "accepted_default",
    import_rate: "typed",
    fit_aud_per_kwh: "accepted_default",
    export_limit_kw: "accepted_default",
  });
});

test("3.18 (b): changing the feed-in tariff makes it typed — 0.08 over the 0.05 default", () => {
  const view = tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS);
  const form: TariffFormState = { ...tariffFormFromView(view), fitRate: "0.08" };
  const sources = tariffFieldSources(view, form);
  assert.equal(sources.fit_aud_per_kwh, "typed");
  // The untouched default beside it still reads accepted_default — per field,
  // never per form.
  assert.equal(sources.export_limit_kw, "accepted_default");
});

test("3.18 (c): stored row, only the supply charge touched — stored fields carry NO key", () => {
  const view = tariffNetworkView(
    jobWithTariff({
      tariff_type: "flat", import_rate: 0.42,
      fit_aud_per_kwh: 0.05, export_limit_kw: 5.0,
    }),
    BOTH_DEFAULTS,
  );
  const form: TariffFormState = { ...tariffFormFromView(view), supplyCharge: "1.10" };
  // The stored fields are omitted ON PURPOSE: the endpoint carries their
  // stored labels forward, and the client cannot know the history. Sending
  // "typed" for them here is the exact defect this row exists to end.
  assert.deepEqual(tariffFieldSources(view, form), { supply_charge: "typed" });
});

test("3.18 (d): no defaults anywhere — a lookup field is never an accepted default", () => {
  const view = tariffNetworkView(jobWithTariff(null), { exportLimit: null, fit: null });
  const typedInto: TariffFormState = {
    ...tariffFormFromView(view), importRate: "0.42", fitRate: "0.08",
  };
  const sources = tariffFieldSources(view, typedInto);
  assert.equal(sources.import_rate, "typed");
  assert.equal(sources.fit_aud_per_kwh, "typed");
  for (const field of ["import_rate", "supply_charge", "tou_windows",
                       "fit_aud_per_kwh", "export_limit_kw"]) {
    assert.notEqual(sources[field], "accepted_default",
      `${field}: there was no default to accept`);
  }
  // tariff_type is the ONE deliberate exception: its prefill is the form's
  // own `?? "flat"` literal, not a TariffDefault, so an untouched radio is a
  // genuinely accepted default even when TariffDefaults are both null.
  const untouched = tariffFieldSources(view, tariffFormFromView(view));
  assert.deepEqual(untouched, { tariff_type: "accepted_default" });
});

test("3.18: a TOU save nulls the import rate, so its box text carries no provenance", () => {
  // The payload sends import_rate: null when the tariff is TOU — a leftover
  // number in the hidden flat box must not be labelled anything (rule C4).
  const view = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.42 }),
    BOTH_DEFAULTS,
  );
  const form: TariffFormState = {
    ...tariffFormFromView(view),
    tariffType: "tou",
    windows: [
      { label: "peak", rate: "0.5", start: "07:00", end: "21:00", days: "all" },
      { label: "offpeak", rate: "0.2", start: "21:00", end: "07:00", days: "all" },
    ],
  };
  const sources = tariffFieldSources(view, form);
  assert.ok(!("import_rate" in sources), "nulled by the payload -> no key");
  assert.equal(sources.tariff_type, "typed");
  assert.equal(sources.tou_windows, "typed");
});

test("3.18 (e): junk in — nulls, numbers, missing view fields — an object, never a throw", () => {
  const junkViews: unknown[] = [
    null, undefined, 42, "a view", [], {},
    { fieldOrigin: "not a map" },
    { importRate: 7, windows: "x" },
    { tariffType: "tou" },
  ];
  const junkForms: unknown[] = [
    null, undefined, 42, "a form", [], {},
    { windows: 9 },
    { importRate: { nested: true } },
    { tariffType: "tou", windows: [null, 42] },
  ];
  for (const v of junkViews) {
    for (const f of junkForms) {
      const out = tariffFieldSources(
        v as unknown as TariffNetworkView,
        f as unknown as TariffFormState,
      );
      assert.ok(out !== null && typeof out === "object" && !Array.isArray(out));
      for (const label of Object.values(out)) {
        assert.ok(label === "typed" || label === "accepted_default",
          `only vocabulary labels ever appear, got ${JSON.stringify(label)}`);
      }
    }
  }
  // tariffFormFromView is total too — the component seeds state through it.
  for (const v of junkViews) {
    const formed = tariffFormFromView(v as unknown as TariffNetworkView);
    assert.ok(formed.tariffType === "flat" || formed.tariffType === "tou");
    assert.ok(Array.isArray(formed.windows));
  }
});

// ── 3.18 prompt 4 (Part B): a person agrees to the deletion ─────────────────

const STORED_TOU_JOB = jobWithTariff({
  tariff_type: "tou",
  tou_windows: [
    { label: "peak", rate: 0.55, start: "17:00", end: "21:00", days: "all" },
    { label: "offpeak", rate: 0.2, start: "21:00", end: "07:00", days: "all" },
    { label: "shoulder", rate: 0.35, start: "07:00", end: "17:00", days: "all" },
  ],
});

test("3.18-4: storedWindowCount counts the RAW stored list, not the readable rows", () => {
  assert.equal(tariffNetworkView(STORED_TOU_JOB, BOTH_DEFAULTS).storedWindowCount, 3);
  // An unreadable entry still counts — a flat save deletes the whole column,
  // readable or not, so the count on screen must match the database.
  const partial = tariffNetworkView(
    jobWithTariff({ tariff_type: "tou", tou_windows: [
      { label: "peak", rate: 0.55, start: "17:00", end: "21:00", days: "all" },
      { label: "offpeak", rate: 0.2 }, // unreadable: no times — dropped from the FORM
    ] }),
    BOTH_DEFAULTS,
  );
  assert.equal(partial.windows.length, 1, "the form shows only the readable row");
  assert.equal(partial.storedWindowCount, 2, "the count says what the save deletes");
  assert.equal(tariffNetworkView(jobWithTariff({ tariff_type: "flat", import_rate: 0.4 }),
    BOTH_DEFAULTS).storedWindowCount, 0);
  assert.equal(tariffNetworkView(jobWithTariff({ tariff_type: "flat", tou_windows: [] }),
    BOTH_DEFAULTS).storedWindowCount, 0, "an empty list is not a deletion");
  assert.equal(tariffNetworkView(jobWithTariff({ tariff_type: "flat", tou_windows: "junk" }),
    BOTH_DEFAULTS).storedWindowCount, 0, "unreadable/not-a-list: no dialog, save as today");
  assert.equal(tariffNetworkView(jobWithTariff(null), BOTH_DEFAULTS).storedWindowCount, 0);
});

test("3.18-4: the confirmation is offered WHEN AND ONLY WHEN the save is flat and windows exist", () => {
  const view = tariffNetworkView(STORED_TOU_JOB, BOTH_DEFAULTS);
  // The live shape: a TOU job switched to Flat. WHY THIS MOVES: before this
  // prompt the save proceeded straight to the network and nulled the column.
  const flatForm = { ...tariffFormFromView(view), tariffType: "flat" as const };
  const confirmation = tariffFlatSaveConfirmation(view, flatForm);
  assert.ok(confirmation, "a flat save over 3 stored windows must be confirmed");
  assert.match(confirmation!.body, /\b3\b/, "the count is stated");
  assert.match(confirmation!.body, /time-of-use windows/);

  // Saving it as TOU deletes nothing — the windows travel with the save.
  assert.equal(tariffFlatSaveConfirmation(view, tariffFormFromView(view)), null);
  // A flat job with no stored windows: nothing to confirm.
  const flatView = tariffNetworkView(
    jobWithTariff({ tariff_type: "flat", import_rate: 0.4 }), BOTH_DEFAULTS);
  assert.equal(tariffFlatSaveConfirmation(flatView, tariffFormFromView(flatView)), null);
  // Empty list and junk list: not a deletion / malformed must never block.
  for (const tou_windows of [[], "junk", 42, {}]) {
    const v = tariffNetworkView(
      jobWithTariff({ tariff_type: "flat", import_rate: 0.4, tou_windows }),
      BOTH_DEFAULTS);
    assert.equal(tariffFlatSaveConfirmation(v, { ...tariffFormFromView(v), tariffType: "flat" }),
      null, `${JSON.stringify(tou_windows)} must not raise the dialog`);
  }
  // One window: the count and the grammar follow.
  const one = tariffNetworkView(
    jobWithTariff({ tariff_type: "tou", tou_windows: [
      { label: "peak", rate: 0.55, start: "17:00", end: "21:00", days: "all" }] }),
    BOTH_DEFAULTS);
  const oneConfirm = tariffFlatSaveConfirmation(
    one, { ...tariffFormFromView(one), tariffType: "flat" });
  assert.match(oneConfirm!.body, /\b1 time-of-use window\b/);
});

test("3.18-4: the wording states fact and count, and instructs the reader in nothing", () => {
  const view = tariffNetworkView(STORED_TOU_JOB, BOTH_DEFAULTS);
  const c = tariffFlatSaveConfirmation(
    view, { ...tariffFormFromView(view), tariffType: "flat" })!;
  for (const text of [c.title, c.body]) {
    assert.ok(!/are you sure/i.test(text), `"are you sure" is banned: ${text}`);
    assert.ok(!text.includes("?"), `no questions — state the fact: ${text}`);
    assert.ok(!/\byou\b|\byour\b/i.test(text),
      `no second-person instruction (D47): ${text}`);
  }
  assert.ok(c.confirmLabel.length > 0 && c.cancelLabel.length > 0);
  assert.notEqual(c.confirmLabel, c.cancelLabel);
});

test("3.18-4: junk input never throws and never volunteers a dialog", () => {
  const junkViews: unknown[] = [null, undefined, 42, "view", [], {},
    { storedWindowCount: "three" }, { storedWindowCount: -1 },
    { storedWindowCount: Number.NaN }];
  const junkForms: unknown[] = [null, undefined, 42, "form", [], {},
    { tariffType: "tou" }, { tariffType: 9 }];
  for (const v of junkViews) {
    for (const f of junkForms) {
      const out = tariffFlatSaveConfirmation(
        v as Parameters<typeof tariffFlatSaveConfirmation>[0],
        f as Parameters<typeof tariffFlatSaveConfirmation>[1]);
      assert.equal(out, null, `${JSON.stringify(v)} + ${JSON.stringify(f)}`);
    }
  }
});

test("3.18-4: FAIL CLOSED — the save cannot reach the network unconfirmed", async () => {
  // Proven on the component SOURCE, the same instrument as the one-place
  // caution check: within save(), the confirmation guard sits BEFORE the one
  // and only requestJson call, returns without writing, and the save button
  // cannot smuggle a truthy MouseEvent in as the confirmation flag.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = readFileSync(
    path.join(root, "components/worksheet/tariff-network-section.tsx"), "utf8");

  const guardAt = src.indexOf("tariffFlatSaveConfirmation(view, form)");
  const networkAt = src.indexOf("requestJson<");
  assert.ok(guardAt > 0 && networkAt > 0);
  assert.ok(guardAt < networkAt, "the guard sits before the network call");
  assert.equal((src.match(/requestJson</g) ?? []).length, 1,
    "exactly ONE network call site, so the guard cannot be routed around");
  assert.match(src.slice(guardAt, networkAt),
    /if \(confirmation !== null && !removalConfirmed\) \{\s*setConfirmRemoval\(confirmation\);\s*return;/,
    "the unconfirmed path sets the dialog and RETURNS — nothing written");
  assert.ok(!src.includes("onClick={save}"),
    "the bare handler would pass the MouseEvent as removalConfirmed");
  assert.ok(src.includes("() => void save()"),
    "the save button calls save() with no arguments");
  // The dialog's confirm is the ONLY caller that passes true.
  assert.equal((src.match(/save\(true\)/g) ?? []).length, 1);
  // ...and it renders the logic layer's words, composing none of its own.
  assert.ok(src.includes("{confirmRemoval?.title}"));
  assert.ok(src.includes("{confirmRemoval?.body}"));
});

test("3.18: the prefilled list is a subset of the savable list, both non-empty", () => {
  // The cross-language equality with routes/demand.py lives in
  // verify_tariff_provenance.py; this is the client-side sanity half.
  const savable = new Set<string>(SAVABLE_TARIFF_FIELDS);
  assert.ok(savable.size > 0 && PREFILLED_TARIFF_FIELDS.length > 0);
  for (const field of PREFILLED_TARIFF_FIELDS) {
    assert.ok(savable.has(field), `${field} must be savable to be prefilled`);
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
    // A parsed bill writes a load_profiles row; Energy data now ticks on the
    // LOAD the engine could use, not on the bill row's mere existence
    // (2026-08-20). Without this the fixture describes a job that can never be
    // sized, which was never what these tests were about.
    load_profiles: [{ annual_kwh: 5500, created_at: "2026-08-01T00:00:00Z" }],
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

test("3.10 (4c): gates is false on equipment-specs, site-details and (3.13b) incentives, and unchanged on every other section", () => {
  // The full map, both directions — an accidental change to ANY section fails here.
  const nonGating = new Set(
    SECTIONS.filter((s) => s.gates === false).map((s) => s.id),
  );
  assert.deepEqual([...nonGating].sort(), ["equipment-specs", "incentives", "site-details"]);
  for (const section of SECTIONS) {
    const expected =
      section.id === "equipment-specs" ||
      section.id === "site-details" ||
      section.id === "incentives";
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

// ── 3.10 prompt 5: the "Other / new" drawer's field table and notices ────────

test("3.10 (5a): CUSTOM_EQUIPMENT_FIELDS — three kinds, complete rows, no duplicate names", () => {
  const kinds = Object.keys(CUSTOM_EQUIPMENT_FIELDS).sort();
  assert.deepEqual(kinds, ["batteries", "inverters", "panels"]);
  for (const kind of EQUIPMENT_KINDS) {
    const fields = CUSTOM_EQUIPMENT_FIELDS[kind];
    assert.ok(fields.length > 0, `${kind} has fields`);
    const names = fields.map((f) => f.name);
    assert.equal(new Set(names).size, names.length,
      `${kind}: duplicate field names would double-write on the wire`);
    for (const f of fields) {
      assert.ok(f.name.length > 0 && f.label.length > 0, `${kind}.${f.name}`);
      if (f.type === "enum") {
        assert.ok((f.options ?? []).length > 0, `${kind}.${f.name} enum needs options`);
        for (const o of f.options ?? []) {
          assert.ok(o.value.length > 0 && o.label.length > 0, `${kind}.${f.name} option`);
        }
      }
    }
  }
});

test("3.10 (5b): customUnitNotices across the response shapes", () => {
  // Assumptions only.
  const withAssumptions = customUnitNotices({
    id: "x", engine_assumptions: ["Acme AX1: warranty cycles missing — assumed 6000 cycles for replacement modelling."],
    duplicates: [], flags: [],
  });
  assert.ok(withAssumptions.some((n) => n.tone === "caution" && n.level === "notice"));

  // Duplicates with differences → one caution PER duplicate, naming both numbers.
  const withDiffs = customUnitNotices({
    id: "x", engine_assumptions: [], flags: [],
    duplicates: [{
      id: "cat-1", origin: "catalogue", brand: "Sungrow", model: "SBR128",
      differences: [{ field: "usable_capacity_kwh", existing: 12.8, submitted: 13.5 }],
    }],
  });
  const diffNotice = withDiffs.find((n) => n.level === "notice");
  assert.ok(diffNotice, String(withDiffs));
  assert.ok(diffNotice!.title.includes("Sungrow SBR128"), diffNotice!.title);
  assert.ok(diffNotice!.body.includes("12.8") && diffNotice!.body.includes("13.5"), diffNotice!.body);

  // A duplicate with NO differences → one quiet info caption.
  const exact = customUnitNotices({
    id: "x", engine_assumptions: [], flags: [],
    duplicates: [{ id: "cat-1", brand: "Sungrow", model: "SBR128", differences: [] }],
  });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].level, "caption");
  assert.equal(exact[0].tone, "info");

  // Junk as the whole response.
  for (const junk of [null, undefined, "x", 42, [], {}]) {
    assert.doesNotThrow(() => customUnitNotices(junk));
    assert.ok(Array.isArray(customUnitNotices(junk)));
  }
});

test("3.10 (5c): THE VERBATIM RULE — the engine's sentence survives byte-for-byte", () => {
  // Any re-wording, re-ordering or summarising changes the string and this
  // fails: prompt 4's "no second copy of the engine's words" one layer out.
  const sentence = "Acme AX1: round-trip efficiency missing — assumed 90%.";
  const notices = customUnitNotices({
    id: "x", engine_assumptions: [sentence], duplicates: [], flags: [],
  });
  const assumption = notices.find((n) => n.level === "notice");
  assert.ok(assumption, "an assumptions notice must exist");
  assert.ok(assumption!.body.includes(sentence),
    `the body must contain the engine's sentence exactly: ${assumption!.body}`);
});

test("3.10 (5d): absent, empty, and check-unavailable duplicates are THREE different outputs", () => {
  const absent = customUnitNotices({ id: "x", engine_assumptions: [], flags: [] });
  const empty = customUnitNotices({ id: "x", engine_assumptions: [], flags: [], duplicates: [] });
  const unavailable = customUnitNotices({
    id: "x", engine_assumptions: [], flags: ["duplicate_check_unavailable"], duplicates: [],
  });
  // Absent: the outcome is unknown — silence.
  assert.deepEqual(absent, []);
  // Present-and-empty: the check RAN — a quiet caption says so.
  assert.equal(empty.length, 1);
  assert.equal(empty[0].level, "caption");
  // Unavailable: the check DID NOT RUN — a caution notice, never "no duplicates".
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].level, "notice");
  assert.equal(unavailable[0].tone, "caution");
  // All three differ from each other.
  assert.notDeepEqual(absent, empty);
  assert.notDeepEqual(empty, unavailable);
  assert.notDeepEqual(absent, unavailable);
});

test("3.10 (5e): the required sets are the DERIVED ones — and inverters do NOT require a cost", () => {
  // A "tidied" uniform rule changes one of these sets and fails here. The
  // asymmetry is the backend's: no battery price → the LP skips the unit; no
  // panel dimensions → the roof reader falls back to the default panel; no
  // inverter price → the cost model excludes it WITH A FLAG and sizing runs.
  const required = (kind: (typeof EQUIPMENT_KINDS)[number]) =>
    CUSTOM_EQUIPMENT_FIELDS[kind].filter((f) => f.required).map((f) => f.name).sort();
  assert.deepEqual(required("panels"),
    ["brand", "length_mm", "model", "rated_power_w", "width_mm"]);
  assert.deepEqual(required("inverters"),
    ["brand", "inverter_type", "model", "phases", "rated_ac_power_kw"]);
  assert.deepEqual(required("batteries"),
    ["brand", "cost_aud", "model", "usable_capacity_kwh"]);
  const inverterCost = CUSTOM_EQUIPMENT_FIELDS.inverters.find((f) => f.name === "cost_aud");
  assert.ok(inverterCost, "inverters still OFFER a cost field");
  assert.equal(inverterCost!.required, false, "an unpriced inverter is accepted — do not tidy this");
});

// ── 3.11: Solar sizing ───────────────────────────────────────────────────────

test("3.11: solarSizingView across the six paths — solarMode from PATH_RULES, never re-derived", () => {
  const modes: Record<string, string | null> = {};
  for (const path of ["A", "B", "C", "D", "E", "F"]) {
    modes[path] = solarSizingView(emptyJob({ path })).solarMode;
  }
  assert.deepEqual(modes, {
    A: "optimise", B: "optimise", C: "pinned",
    D: "optimise", E: "none", F: "optimise",
  });
  // An unknown or missing path degrades to null, never a throw.
  assert.equal(solarSizingView(emptyJob({ path: null })).solarMode, null);
  assert.equal(solarSizingView(emptyJob({ path: "Z" })).solarMode, null);
});

test("3.11: canPin is true ONLY for pinned mode + a finite positive recorded size", () => {
  assert.equal(
    solarSizingView(emptyJob({ path: "C", existing_solar_kw: 6.6 })).canPin, true);
  // Never invent a size: null, a string, zero, negative, NaN all refuse.
  for (const bad of [null, "6.6kw", 0, -3, NaN] as const) {
    const view = solarSizingView(emptyJob({ path: "C", existing_solar_kw: bad as never }));
    assert.equal(view.canPin, false, `existing_solar_kw=${String(bad)} must not pin`);
  }
  // A recorded size on a NON-pinned path does not pin either.
  assert.equal(
    solarSizingView(emptyJob({ path: "A", existing_solar_kw: 6.6 })).canPin, false);
  // The unrecorded-array caution fires ONLY on the pinned-path-no-number case —
  // a finding about THIS job (D25), absent on a comparable job with the number.
  const unrecorded = solarSizingView(emptyJob({ path: "C" }));
  assert.deepEqual(unrecorded.notices.map((n) => n.title),
    [SOLAR_EXISTING_UNRECORDED_NOTICE.title]);
  assert.equal(SOLAR_EXISTING_UNRECORDED_NOTICE.level, "notice");
  assert.deepEqual(
    solarSizingView(emptyJob({ path: "C", existing_solar_kw: 6.6 })).notices, []);
});

test("3.11: solarRunNotices — flagged roof is a NOTICE, the method fact a CAPTION (levels read, not counted)", () => {
  const flagged = solarRunNotices({
    roof_confidence: {
      roof_low_confidence: true,
      roof_reason: "a roof face at 77° is too steep to be a roof",
    },
  });
  const roofNotice = flagged.find((n) => n.level === "notice");
  assert.ok(roofNotice, "a flagged roof must produce a level:notice");
  assert.equal(roofNotice!.tone, "caution");
  assert.ok(roofNotice!.body.includes("too steep to be a roof"),
    "the roof's own words travel verbatim");
  const caption = flagged.find((n) => n.level === "caption");
  assert.ok(caption, "the method fact is a level:caption");

  // A clean roof: caption only, no notice.
  const clean = solarRunNotices({ roof_confidence: { roof_low_confidence: false } });
  assert.ok(!clean.some((n) => n.level === "notice"));
  // roof_confidence ABSENT (older build): no roof notice — absent is not clean.
  const absent = solarRunNotices({});
  assert.ok(!absent.some((n) => n.level === "notice"));
  // Junk never throws.
  for (const junk of [null, undefined, "x", 42, []]) {
    assert.doesNotThrow(() => solarRunNotices(junk));
  }
});

test("3.11: solarRunResult — null payback reads as words, never a dash or 0", () => {
  const r = solarRunResult({
    optimal: {
      solar_kw: 10.12, panel_count: 23, annual_generation_kwh: 2975.4,
      system_cost: 6946, simple_payback_years: null, npv_25yr: 2831.59,
      self_sufficiency_pct: 30.45,
    },
    score_curve: [], flags: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.headline?.payback, "no payback within the analysis period");
  assert.equal(r.headline?.solarKw, "10.12 kW"); // stored precision, trimmed (3.13-4C)
  assert.equal(r.headline?.systemCost, "$6,946");      // whole dollars, no cents
  // 30.45 is stored as the double 30.4499…, so one decimal is 30.4 — the
  // formatter reports what the number actually is, not decimal-string folklore.
  assert.equal(r.headline?.selfSufficiencyPct, "30.45%");
  // Empty curve: options hidden entirely, headline kept.
  assert.deepEqual(r.options, []);
});

test("3.11: solarRunResult — one-row curve renders, empty row labelled, chosen marked", () => {
  const r = solarRunResult({
    optimal: { solar_kw: 10.12, system_cost: 6946, npv_25yr: 2831.59,
               simple_payback_years: 4.4, self_sufficiency_pct: 30.45,
               annual_generation_kwh: 2975.4 },
    score_curve: [
      { solar_kw: 0, system_cost: 0, npv_25yr: 0, simple_payback_years: null,
        self_sufficiency_pct: 0 },
      { solar_kw: 10.12, system_cost: 6946, npv_25yr: 2831.59,
        simple_payback_years: 4.4, self_sufficiency_pct: 30.45 },
    ],
    flags: ["roof_flagged_before_sizing — the roof measurement was flagged"],
  });
  assert.equal(r.options.length, 2);
  assert.equal(r.options[0].label, "No system");   // labelled, never "0 kW"
  assert.equal(r.options[0].chosen, false);
  assert.equal(r.options[1].label, "10.12 kW");
  assert.equal(r.options[1].chosen, true);
  // The engine's flags travel VERBATIM.
  assert.deepEqual(r.engineFlags,
    ["roof_flagged_before_sizing — the roof measurement was flagged"]);
});

test("3.11: solarRunResult — needs_roof_input and error are BODY branches, not res.ok", () => {
  const roofless = solarRunResult({ needs_roof_input: true, flags: ["no_roof_geometry_for_job"] });
  assert.equal(roofless.ok, false);
  assert.equal(roofless.needsRoofInput, true);
  assert.equal(roofless.errorMessage, null);
  assert.equal(roofless.headline, null);
  const errored = solarRunResult({ error: "invalid objective 'banana'", flags: [] });
  assert.equal(errored.ok, false);
  assert.equal(errored.errorMessage, "invalid objective 'banana'");
  // Junk: a usable empty result, never a throw.
  for (const junk of [null, undefined, "x", 42, [], {}]) {
    const out = solarRunResult(junk);
    assert.equal(out.ok, false);
    assert.equal(out.headline, null);
    assert.ok(Array.isArray(out.options));
  }
});

test("3.11: the predicates — solar_kw ticks Solar sizing, battery_kwh:null leaves Battery incomplete", () => {
  const solarOnly = emptyJob({
    sizing_results: [{ solar_kw: 10.12, battery_kwh: null }],
  });
  const solar = SECTIONS.find((s) => s.id === "solar-sizing");
  const battery = SECTIONS.find((s) => s.id === "battery-sizing");
  assert.equal(solar?.complete(solarOnly), true);
  assert.equal(battery?.complete(solarOnly), false,
    "prompt 1's battery_kwh:null is what keeps Battery sizing honest");
  // And the old defect's shape would have broken it: battery_kwh 0 ticks it.
  const withZero = emptyJob({ sizing_results: [{ solar_kw: 10.12, battery_kwh: 0 }] });
  assert.equal(battery?.complete(withZero), true,
    "0 is not null — exactly why the writer must send null");
});

test("3.11: SOLAR_SIZING_REQUEST_KEYS — the D29 restraint, held locally too", () => {
  // 3.14 prompt 6 (D37): the rail's re-cost declines persistence and the
  // throwaway comparison, so the constant gained those two fields. Both are
  // real OptimiseRequest fields (prompts 2 and 5); the builder test below
  // holds the rail's body to EXACTLY this set.
  assert.deepEqual([...SOLAR_SIZING_REQUEST_KEYS].sort(),
    ["compare_to_unconstrained", "constraints", "job_id", "persist"]);
  for (const forbidden of ["objective", "custom_weight", "budget",
                           "equipment_panel_id", "equipment_inverter_id",
                           "equipment_battery_id", "installer_id"]) {
    assert.ok(!(SOLAR_SIZING_REQUEST_KEYS as readonly string[]).includes(forbidden),
      `${forbidden} is stored on the job and must never travel from the browser`);
  }
});

// ── 3.11b prompt 1 — the readers are newest-aware BEFORE the constraint drops ─
//
// Today `sizing_results` still carries UNIQUE (job_id) and capture._write
// upserts on it, so every fixture in this file above is single-row and
// `rows[rows.length - 1]` was accidentally correct. Prompt 2 drops that
// constraint and hydration (routes/job.py, select("*") with NO ORDER BY) will
// return two rows in unspecified physical order.
//
// IN EVERY TWO-ROW FIXTURE BELOW THE ARRAY ORDER IS DELIBERATELY THE REVERSE OF
// THE created_at ORDER — the OLDER row is placed LAST. That is what makes these
// assertions able to move: a surviving last-element reader returns the last
// element, which is the older row, and reports the older run's figures; the
// newest-by-created_at rule returns the first. The two answers differ by
// construction, so these cannot pass by accident.

const NEWER_SOLAR_ONLY = {
  created_at: "2026-08-19T05:00:00Z",
  solar_kw: 10.12,
  battery_kwh: null,
};
const OLDER_WITH_BATTERY = {
  created_at: "2026-08-19T04:00:00Z",
  solar_kw: 6.6,
  battery_kwh: 13.5,
};

function completeOf(id: string, job: JobDetailLike): boolean | undefined {
  return SECTIONS.find((s) => s.id === id)?.complete(job);
}

test("3.11b: two sizing rows, newest FIRST in the array — the newest run wins", () => {
  const job = emptyJob({
    sizing_results: [NEWER_SOLAR_ONLY, OLDER_WITH_BATTERY],
  });
  assert.deepEqual(resultsBarView(job), {
    sized: true,
    solarKw: 10.12,
    batteryKwh: null,
    paybackYears: null,
    npv: null,
    selfSufficiencyPct: null,
    splitSolarNpv: null,
    splitBatteryNpv: null,
    // A run with NO battery in it at all — words, never a bare dash (F205).
    valueOrigin: { kind: "all-solar", label: VALUE_ORIGIN_ALL_SOLAR_LABEL },
  });
  assert.equal(completeOf("solar-sizing", job), true);
  // THE HONEST UN-TICK — row 3.11b, answer 1, decided by Mayur 2026-08-19. A
  // newer solar-only run supersedes the battery run, so the CURRENT
  // recommendation contains no battery and the section is not complete. The
  // battery row still exists; it is simply no longer the recommendation.
  assert.equal(completeOf("battery-sizing", job), false,
    "a superseded battery run must not keep Battery sizing ticked");
  const view = solarSizingView(job);
  assert.equal(view.storedSolarKw, 10.12);
  assert.equal(view.alreadySized, true);
});

test("3.11b: the same two rows with the BATTERY run newest — battery ticks", () => {
  const job = emptyJob({
    sizing_results: [OLDER_WITH_BATTERY, NEWER_SOLAR_ONLY].map((r, i) =>
      // Swap the timestamps, keep the array order: the battery row is newest.
      i === 0
        ? { ...r, created_at: "2026-08-19T06:00:00Z" }
        : { ...r, created_at: "2026-08-19T05:00:00Z" },
    ),
  });
  const bar = resultsBarView(job);
  assert.equal(bar.sized, true);
  assert.equal(bar.sized && bar.batteryKwh, 13.5);
  assert.equal(bar.sized && bar.solarKw, 6.6);
  assert.equal(completeOf("battery-sizing", job), true);
  assert.equal(completeOf("solar-sizing", job), true);
  assert.equal(solarSizingView(job).storedSolarKw, 6.6);
});

test("3.13-3C: two financial rows — the bar reads the row MATCHING the current sizing result", () => {
  // RESTATED at 3.13 prompt 3 (was "newest wins"): the bar now reads
  // currentFinancialResult, so it is the MATCHING row that wins — here the
  // OLDER financial row, because the newest financial row belongs to a
  // different (superseded) run. The old rule would have shown 4.2/31000.
  const sid = (NEWER_SOLAR_ONLY as Record<string, unknown>).sizing_result_id;
  const currentSid = typeof sid === "string" && sid ? sid : "s-current";
  const job = emptyJob({
    sizing_results: [{ ...NEWER_SOLAR_ONLY, sizing_result_id: currentSid }],
    financial_results: [
      { created_at: "2026-08-19T05:00:00Z", sizing_result_id: "s-older",
        payback_years: 4.2, npv_25_year: 31000 },
      { created_at: "2026-08-19T04:00:00Z", sizing_result_id: currentSid,
        payback_years: 9.9, npv_25_year: 12000 },
    ],
  });
  const bar = resultsBarView(job);
  assert.equal(bar.sized && bar.paybackYears, 9.9,
    "the newest financial row belongs to another run and must not win");
  assert.equal(bar.sized && bar.npv, 12000);
});

test("3.11b: three sizing rows in scrambled order — the newest wins regardless of position", () => {
  const a = { created_at: "2026-08-19T01:00:00Z", solar_kw: 3.3, battery_kwh: null };
  const b = { created_at: "2026-08-19T09:00:00Z", solar_kw: 13.2, battery_kwh: 5 };
  const c = { created_at: "2026-08-19T05:00:00Z", solar_kw: 6.6, battery_kwh: null };
  for (const order of [[a, b, c], [c, a, b], [b, c, a], [a, c, b]]) {
    const job = emptyJob({ sizing_results: order });
    assert.equal(currentSizingResult(job)?.solar_kw, 13.2,
      `order ${order.map((r) => r.solar_kw).join(",")}`);
    const bar = resultsBarView(job);
    assert.equal(bar.sized && bar.solarKw, 13.2);
    assert.equal(bar.sized && bar.batteryKwh, 5);
    assert.equal(solarSizingView(job).storedSolarKw, 13.2);
  }
});

// The tie and degenerate rules, pinned so they are deliberate rather than
// whatever newestByCreatedAt happens to do this week.
test("3.11b: ties and missing timestamps — dateless sorts oldest, first element wins a full tie", () => {
  // Neither row dated: both score -Infinity, the comparison is strict `>`, so
  // the FIRST array element wins. Every pre-3.11b fixture in this file is this
  // shape with one row, which is why none of them moved.
  const bothDateless = emptyJob({
    sizing_results: [{ solar_kw: 10.12 }, { solar_kw: 6.6 }],
  });
  assert.equal(currentSizingResult(bothDateless)?.solar_kw, 10.12);

  // One dated, one not — the timestamped row wins from EITHER position.
  const dated = { created_at: "2026-08-19T05:00:00Z", solar_kw: 10.12 };
  for (const order of [[dated, { solar_kw: 6.6 }], [{ solar_kw: 6.6 }, dated]]) {
    assert.equal(
      currentSizingResult(emptyJob({ sizing_results: order }))?.solar_kw,
      10.12,
    );
  }

  // Unparseable / empty / null created_at sorts oldest and never throws.
  for (const junk of ["", "not-a-date", null, 12345, {}]) {
    const job = emptyJob({
      sizing_results: [{ created_at: junk, solar_kw: 6.6 }, dated],
    });
    assert.doesNotThrow(() => currentSizingResult(job));
    assert.equal(currentSizingResult(job)?.solar_kw, 10.12, String(junk));
  }

  // A dateless row is never DISCARDED — it wins when it is the only row, which
  // is exactly the legacy /api/job/save row's shape.
  assert.equal(
    currentSizingResult(emptyJob({ sizing_results: [{ solar_kw: 6.6 }] }))?.solar_kw,
    6.6,
  );
});

test("3.11b: currentSizingResult is total — junk in, null out, never a throw", () => {
  for (const junk of [null, undefined, 42, "rows", [], {}, { sizing_results: null },
                      { sizing_results: "nope" }, { sizing_results: [null, null] }]) {
    assert.doesNotThrow(() => currentSizingResult(junk));
    assert.equal(currentSizingResult(junk), null, JSON.stringify(junk) ?? "undefined");
  }
  // ...and the readers built on it stay in the unsized state.
  const noRows = emptyJob({ sizing_results: [] });
  assert.deepEqual(resultsBarView(noRows), { sized: false });
  assert.equal(completeOf("solar-sizing", noRows), false);
  assert.equal(completeOf("battery-sizing", noRows), false);
  assert.equal(solarSizingView(noRows).alreadySized, false);
  assert.equal(solarSizingView(noRows).storedSolarKw, null);
});

test("3.11b: a current row with both figures null is UNSIZED, never '0 kW'", () => {
  // And the older row DOES carry figures — proving the discriminant is read off
  // the current row, not off "any row that ever had a number".
  const job = emptyJob({
    sizing_results: [
      { created_at: "2026-08-19T05:00:00Z", solar_kw: null, battery_kwh: null },
      { created_at: "2026-08-19T04:00:00Z", solar_kw: 6.6, battery_kwh: 13.5 },
    ],
  });
  assert.deepEqual(resultsBarView(job), { sized: false });
  assert.equal(completeOf("solar-sizing", job), false);
  assert.equal(completeOf("battery-sizing", job), false);
  assert.equal(solarSizingView(job).alreadySized, false);
});

test("3.11b: the section predicate and solarSizingView agree on the same current row", () => {
  // Reader 1 and reader 4 are the same rule; a job where they disagreed would
  // tick the rail while the section said "not sized yet".
  for (const rows of [
    [NEWER_SOLAR_ONLY, OLDER_WITH_BATTERY],
    [OLDER_WITH_BATTERY, NEWER_SOLAR_ONLY],
    [{ created_at: "2026-08-19T05:00:00Z", solar_kw: null, battery_kwh: 9 }],
    [],
  ]) {
    const job = emptyJob({ sizing_results: rows });
    assert.equal(
      completeOf("solar-sizing", job),
      solarSizingView(job).alreadySized,
      JSON.stringify(rows),
    );
  }
});

test("3.13-3C: the Results section rule IS the linkage now — a financial result for THE CURRENT sizing result", () => {
  // RESTATED at 3.13 prompt 3: the 3.11b test in this spot pinned "existence
  // only" and said, in its own comment, that the correct rule was linkage and
  // would land when something wrote financials. Something does (prompt 2), so
  // the recorded omission is closed: an UNLINKED financial row no longer
  // ticks the section.
  const unlinked = emptyJob({
    sizing_results: [{ ...NEWER_SOLAR_ONLY, sizing_result_id: "s-current" }],
    financial_results: [{ created_at: "2026-08-19T04:00:00Z", payback_years: 9.9 }],
  });
  assert.equal(completeOf("results", unlinked), false,
    "a financial row with no sizing_result_id belongs to no run and must not tick");
  const linked = emptyJob({
    sizing_results: [{ ...NEWER_SOLAR_ONLY, sizing_result_id: "s-current" }],
    financial_results: [{ created_at: "2026-08-19T04:00:00Z",
      sizing_result_id: "s-current", payback_years: 9.9 }],
  });
  assert.equal(completeOf("results", linked), true);
  assert.equal(completeOf("results", emptyJob()), false);
});

// ── 3.12: Battery sizing ─────────────────────────────────────────────────────

/** A full battery response, shaped exactly as routes/sizing.py returns one. */
const BATTERY_RESPONSE = {
  optimal_battery: {
    battery_id: "b1", model: "Sungrow SBH200", usable_kwh: 20,
    annual_savings_vs_solar_only: 2000, self_sufficiency_pct: 72.35,
    cycles_per_year: 180, peak_import_reduction_kw: 3.2,
    battery_cost: 9571.84, incremental_payback_years: 4.79,
    incremental_npv: 87561.15, grid_cost: 400, annual_import_kwh: 3800,
    annual_export_kwh: 900, annual_discharge_kwh: 3600, replacement_year: null,
    round_trip_efficiency: 0.96, depth_of_discharge: 1, system_cost: 16819.84,
  },
  chosen_solar: {
    solar_kw: 10.56, annual_generation_kwh: 17176.1,
    system_cost_solar_only: 7248, plane_indices: [0],
  },
  candidates: [
    {
      // THE BASELINE — no battery_id, no annual_discharge_kwh, no
      // round_trip_efficiency, no depth_of_discharge. All four absent.
      usable_kwh: 0, model: "No battery", annual_savings_vs_solar_only: 0,
      self_sufficiency_pct: 41.2, cycles_per_year: 0,
      peak_import_reduction_kw: 0, battery_cost: 0,
      incremental_payback_years: null, incremental_npv: 0, grid_cost: 2400,
      annual_import_kwh: 6100, annual_export_kwh: 4200, replacement_year: null,
      system_cost: 7248,
    },
    {
      battery_id: "b1", model: "Sungrow SBH200", usable_kwh: 20,
      self_sufficiency_pct: 72.35, battery_cost: 9571.84,
      incremental_payback_years: 4.79, incremental_npv: 87561.15,
      system_cost: 16819.84,
    },
  ],
  not_economic_reason: null,
  flags: ["Sungrow SBH200: warranty cycles missing — assumed 6000 cycles for replacement modelling."],
};

test("3.12: batterySizingView across the six paths — batteryMode from PATH_RULES, never re-derived", () => {
  const modes: Record<string, string | null> = {};
  for (const path of ["A", "B", "C", "D", "E", "F"]) {
    modes[path] = batterySizingView(emptyJob({ path })).batteryMode;
  }
  assert.deepEqual(modes, {
    A: "none", B: "size", C: "size", D: "size", E: "size", F: "none",
  });
  // A and F HIDE the section entirely — the view still answers, the section
  // list is what omits it (sectionsForPath), and the two must agree.
  for (const hidden of ["A", "F"]) {
    assert.ok(
      !sectionsForPath(hidden).some((s) => s.id === "battery-sizing"),
      `path ${hidden} must not show Battery sizing`,
    );
  }
  for (const shown of ["B", "C", "D", "E"]) {
    assert.ok(
      sectionsForPath(shown).some((s) => s.id === "battery-sizing"),
      `path ${shown} must show Battery sizing`,
    );
  }
  // An unknown or missing path degrades to null AND still SHOWS the section —
  // never hide a step because the path could not be determined.
  assert.equal(batterySizingView(emptyJob({ path: null })).batteryMode, null);
  assert.equal(batterySizingView(emptyJob({ path: "Z" })).batteryMode, null);
  for (const unknown of [null, "Z"]) {
    assert.ok(
      sectionsForPath(unknown).some((s) => s.id === "battery-sizing"),
      `an unknown path (${String(unknown)}) must still show Battery sizing`,
    );
  }
  // Total for any input.
  for (const junk of [null, undefined, "x", 42, [], {}]) {
    assert.doesNotThrow(() => batterySizingView(junk));
    assert.equal(batterySizingView(junk).alreadySized, false);
  }
});

test("3.12: batterySizingView agrees with the SECTIONS predicate on the SAME job", () => {
  // One rule, two readers. If these ever disagree, one of them re-derived it.
  const jobs: JobDetailLike[] = [
    emptyJob(),
    emptyJob({ sizing_results: [{ solar_kw: 10.12, battery_kwh: null }] }),
    emptyJob({ sizing_results: [{ solar_kw: 10.12, battery_kwh: 13.5 }] }),
    emptyJob({ sizing_results: [{ solar_kw: 10.12, battery_kwh: 0 }] }),
  ];
  for (const job of jobs) {
    assert.equal(
      batterySizingView(job).alreadySized,
      completeOf("battery-sizing", job),
      JSON.stringify(job.sizing_results),
    );
  }
  // battery_kwh 0 is a REAL answer ("no battery was worth it"), not absence.
  const zero = emptyJob({ sizing_results: [{ solar_kw: 10.12, battery_kwh: 0 }] });
  assert.equal(batterySizingView(zero).storedBatteryKwh, 0);
  assert.equal(batterySizingView(zero).alreadySized, true);
});

test("3.12: the honest un-tick — array order REVERSED, a battery run superseded by solar-only", () => {
  // Array order is deliberately the REVERSE of created_at: the older,
  // battery-bearing row is LAST. A last-element reader would report 13.5 kWh
  // stored and tick the section; the newest-by-created_at rule reports neither.
  const job = emptyJob({
    sizing_results: [NEWER_SOLAR_ONLY, OLDER_WITH_BATTERY],
  });
  const view = batterySizingView(job);
  assert.equal(view.storedBatteryKwh, null,
    "the superseded battery run is not the current recommendation");
  assert.equal(view.alreadySized, false);
  assert.equal(completeOf("battery-sizing", job), false);
  // The mirror case: the same two rows with the battery run newest.
  const battNewest = emptyJob({
    sizing_results: [
      { ...OLDER_WITH_BATTERY, created_at: "2026-08-19T06:00:00Z" },
      { ...NEWER_SOLAR_ONLY, created_at: "2026-08-19T05:00:00Z" },
    ],
  });
  assert.equal(batterySizingView(battNewest).storedBatteryKwh, 13.5);
  assert.equal(batterySizingView(battNewest).alreadySized, true);
  assert.equal(completeOf("battery-sizing", battNewest), true);
});

test("3.12: batteryRunResult — a full result, whole-system cost from the candidate's own key", () => {
  const r = batteryRunResult(BATTERY_RESPONSE);
  assert.equal(r.ok, true);
  assert.equal(r.noBattery, false);
  assert.equal(r.headline?.model, "Sungrow SBH200");
  assert.equal(r.headline?.usableKwh, "20 kWh");
  assert.equal(r.headline?.batteryCost, "$9,572");       // incremental, whole dollars
  assert.equal(r.headline?.systemCost, "$16,820");        // the WHOLE system
  assert.equal(r.headline?.payback, "4.79 yr"); // stored precision (3.13-4C)
  assert.equal(r.headline?.npv, "$87,561");
  assert.equal(r.headline?.selfSufficiencyPct, "72.35%");  // 72.35 is 72.349…
  // The solar THIS run chose travels too — the endpoint sizes both halves.
  assert.equal(r.chosenSolar?.solarKw, "10.56 kW");
  assert.equal(r.chosenSolar?.annualGenerationKwh, "17,176 kWh");
  assert.equal(r.chosenSolar?.systemCostSolarOnly, "$7,248");
  // Options: baseline LABELLED, chosen marked, whole-system costs shown.
  assert.equal(r.options.length, 2);
  assert.equal(r.options[0].label, "No battery");
  assert.equal(r.options[0].chosen, false);
  assert.equal(r.options[0].systemCost, "$7,248");
  assert.equal(r.options[1].label, "20 kWh");
  assert.equal(r.options[1].chosen, true);
  assert.equal(r.options[1].systemCost, "$16,820");
  // The engine's flags travel VERBATIM.
  assert.deepEqual(r.engineFlags, BATTERY_RESPONSE.flags);
  assert.equal(r.notEconomicReason, null,
    "a reason that is always present is not a signal");
});

test("3.12: batteryRunResult — no battery is a RESULT, and its reason is byte-for-byte the engine's", () => {
  // The exact sentence prompt 1 put in the engine. Any rewording here would be
  // the second copy F161 exists to prevent.
  const REASON =
    "every battery took the whole-system cost over the $12,033.92 budget " +
    "(the cheapest solar-plus-battery system available was $12,774.77) — " +
    "solar-only is recommended under this cap.";
  const r = batteryRunResult({
    ...BATTERY_RESPONSE,
    optimal_battery: BATTERY_RESPONSE.candidates[0],
    not_economic_reason: REASON,
  });
  assert.equal(r.ok, true, "no battery is a RESULT, never an error");
  assert.equal(r.noBattery, true);
  assert.equal(r.errorMessage, null, "not an error");
  assert.equal(r.notEconomicReason, REASON, "verbatim — never paraphrased");
  // The headline still exists and LABELS the outcome, never "0 kWh".
  assert.equal(r.headline?.usableKwh, "No battery");
  assert.equal(r.headline?.model, "No battery");
});

test("3.12: the baseline's four absent keys render as '—', never undefined/null/0/NaN", () => {
  // A candidates list containing ONLY the baseline — the case where every
  // absent key is the only thing on screen.
  const r = batteryRunResult({
    optimal_battery: BATTERY_RESPONSE.candidates[0],
    chosen_solar: BATTERY_RESPONSE.chosen_solar,
    candidates: [BATTERY_RESPONSE.candidates[0]],
    not_economic_reason: "no battery beats solar-only on NPV — battery not economic for this job.",
    flags: [],
  });
  assert.equal(r.options.length, 1);
  const only = r.options[0];
  assert.equal(only.label, "No battery");
  assert.equal(only.model, "No battery");
  assert.equal(only.payback, "no payback within the analysis period");
  // Nothing anywhere in the rendered row may read as a raw JS absence.
  for (const value of Object.values(only)) {
    if (typeof value !== "string") continue;
    for (const bad of ["undefined", "null", "NaN"]) {
      assert.ok(!value.includes(bad), `"${value}" leaked ${bad}`);
    }
  }
  // A candidate with the four keys genuinely missing AND no numbers at all:
  // every figure falls back to the dash, never to a fabricated zero.
  const bare = batteryRunResult({
    optimal_battery: { usable_kwh: 0, model: "No battery" },
    candidates: [{ usable_kwh: 0, model: "No battery" }],
    flags: [],
  });
  assert.equal(bare.options[0].systemCost, "—");
  assert.equal(bare.options[0].npv, "—");
  assert.equal(bare.options[0].selfSufficiency, "—");
  assert.equal(bare.headline?.batteryCost, "—");
  assert.equal(bare.headline?.systemCost, "—");
});

test("3.12: batteryRunResult — needs_roof_input and error are BODY branches, not res.ok", () => {
  // After change 1 the battery endpoint answers needs_roof_input, NOT
  // needs_solar_result: it re-runs the solar step itself, so it can never need
  // a stored solar result (D33).
  const roofless = batteryRunResult({
    needs_roof_input: true, flags: ["no_roof_geometry"],
    error: null,
  });
  assert.equal(roofless.ok, false);
  assert.equal(roofless.needsRoofInput, true);
  assert.equal(roofless.errorMessage, null);
  assert.equal(roofless.headline, null);
  assert.deepEqual(roofless.engineFlags, ["no_roof_geometry"]);
  // A 200 CARRYING error.
  const errored = batteryRunResult({
    error: "Internal error in the battery optimiser.",
    flags: ["internal_error"],
  });
  assert.equal(errored.ok, false);
  assert.equal(errored.errorMessage, "Internal error in the battery optimiser.");
  assert.equal(errored.headline, null);
  assert.equal(errored.noBattery, false, "an error is not a no-battery recommendation");
});

test("3.12: batteryRunResult — total for junk, including a candidates list of nulls", () => {
  for (const junk of [null, undefined, "x", 42, [], {}]) {
    const out = batteryRunResult(junk);
    assert.equal(out.ok, false);
    assert.equal(out.headline, null);
    assert.equal(out.chosenSolar, null);
    assert.ok(Array.isArray(out.options));
    assert.deepEqual(out.options, []);
    assert.equal(out.notEconomicReason, null);
  }
  // A candidates array containing nulls and junk: the readable rows survive,
  // the unreadable ones are skipped, nothing throws.
  const mixed = batteryRunResult({
    optimal_battery: BATTERY_RESPONSE.optimal_battery,
    chosen_solar: BATTERY_RESPONSE.chosen_solar,
    candidates: [null, "nonsense", 42, BATTERY_RESPONSE.candidates[0], undefined,
                 { model: "no usable_kwh here" }],
    flags: null,
  });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.options.length, 1, "only the one readable candidate");
  assert.equal(mixed.options[0].label, "No battery");
  assert.deepEqual(mixed.engineFlags, [], "a non-array flags field yields none");
});

test("3.12: the notices are ONE function with two doors, not a copy", () => {
  // Same input, same output, byte for byte — a copied D25 classification is
  // exactly what D25 says must not exist.
  const response = {
    roof_confidence: {
      roof_low_confidence: true,
      roof_reason: "a roof face at 77° is too steep to be a roof",
    },
  };
  assert.deepEqual(batteryRunNotices(response), solarRunNotices(response));
  assert.deepEqual(batteryRunNotices(response), sizingRunNotices(response));
  const roofNotice = batteryRunNotices(response).find((n) => n.level === "notice");
  assert.ok(roofNotice, "a flagged roof must produce a level:notice here too");
  assert.ok(roofNotice!.body.includes("too steep to be a roof"));
  // Junk never throws through either door.
  for (const junk of [null, undefined, "x", 42, []]) {
    assert.doesNotThrow(() => batteryRunNotices(junk));
    assert.deepEqual(batteryRunNotices(junk), solarRunNotices(junk));
  }
});

test("3.12: BATTERY_SIZING_REQUEST_KEYS — the D29 restraint, held locally too", () => {
  // 3.14 prompt 6 (D37): see SOLAR_SIZING_REQUEST_KEYS above.
  assert.deepEqual([...BATTERY_SIZING_REQUEST_KEYS].sort(),
    ["compare_to_unconstrained", "constraints", "job_id", "persist"]);
  // The solar list plus the two this endpoint additionally accepts and which
  // are ALSO stored on the job: the battery ids (3.10) and the tariff (3.8).
  for (const forbidden of ["objective", "custom_weight", "budget",
                           "equipment_panel_id", "equipment_inverter_id",
                           "equipment_battery_id", "installer_id",
                           "battery_ids", "tou_windows", "import_rates_24"]) {
    assert.ok(!(BATTERY_SIZING_REQUEST_KEYS as readonly string[]).includes(forbidden),
      `${forbidden} is stored on the job and must never travel from the browser`);
  }
});

test("3.13-3H: within_budget is CARRIED from the response verbatim, never derived", () => {
  // RESTATED at 3.13 prompt 3 (was "the response has none"): 3.13 prompt 1
  // made the endpoint RETURN within_budget, derived from the same system_cost
  // its own budget filter tests, and step H renders it. The 2R.1 rule is
  // unchanged in substance — the browser still never COMPUTES the flag; it
  // carries the engine's answer or reports null. A response without the key
  // yields null, never an invented boolean.
  const r = batteryRunResult(BATTERY_RESPONSE);
  assert.equal(r.withinBudget, null, "absent flag -> null, never invented");
  const withFlag = batteryRunResult({
    ...(BATTERY_RESPONSE as Record<string, unknown>),
    within_budget: false,
  });
  assert.equal(withFlag.withinBudget, false, "the engine's false carries as false");
  const withTrue = batteryRunResult({
    ...(BATTERY_RESPONSE as Record<string, unknown>),
    within_budget: true,
  });
  assert.equal(withTrue.withinBudget, true, "the engine's true carries as true");
  assert.ok(!("budget" in r));
  for (const key of Object.keys(r.headline ?? {})) {
    assert.ok(!key.toLowerCase().includes("budget"), key);
  }
});

// ── 2026-08-20: the Energy data tick vs the engine's load resolver ───────────
//
// FOUND ON SCREEN: the section ticked on `interval_data | bills | surveys`
// being non-empty, while the engine resolves a load from
// interval_data.parsed_series_ref or the load_profiles row. A typed annual
// figure writes a load_profiles row and — the survey being optional — no
// surveys row, so the section stayed incomplete forever and every gating
// section after it stayed LOCKED. The section BODY read load_profiles; the
// TICK did not. These shapes are the same seven the backend gate
// (verify_demand_contract.py T13) pairs against the real _resolve_load, plus
// the newest-row case (h) that a `.some(...)` rule would get wrong.

const WEIGHTS_24 = Array.from({ length: 24 }, () => 1);

function energyComplete(job: JobDetailLike): boolean | undefined {
  return completeOf("energy-data", job);
}

test("2026-08-20: the seven paired shapes — the tick means 'the engine could get a load'", () => {
  // (a) a typed annual figure ALONE ticks. THE REPORTED FAULT: this was false.
  assert.equal(
    energyComplete(emptyJob({
      load_profiles: [{ annual_kwh: 8240, hourly_profile_weights: WEIGHTS_24,
                        accuracy_tier: 1, created_at: "2026-08-20T00:00:00Z" }],
    })),
    true,
    "a typed usage figure is a load the engine can size on — this is the fault",
  );
  // (b) annual_kwh null — the engine answers missing_load, so no tick.
  assert.equal(
    energyComplete(emptyJob({
      load_profiles: [{ annual_kwh: null, hourly_profile_weights: WEIGHTS_24,
                        accuracy_tier: 1, created_at: "2026-08-20T00:00:00Z" }],
    })),
    false,
  );
  // (c) annual_kwh 0 — the engine's `0 or ...` treats it as no figure too.
  assert.equal(
    energyComplete(emptyJob({
      load_profiles: [{ annual_kwh: 0, hourly_profile_weights: WEIGHTS_24,
                        accuracy_tier: 1, created_at: "2026-08-20T00:00:00Z" }],
    })),
    false,
    "0 kWh is not a load — ticking here would promise what sizing cannot find",
  );
  // (d) an interval series with NO profile row — the profile write failed, and
  // the engine still resolves a load from the parsed series. NOT redundant.
  assert.equal(
    energyComplete(emptyJob({
      interval_data: [{ parsed_series_ref: "bills/interval/tok.series.json",
                        created_at: "2026-08-20T00:00:00Z" }],
    })),
    true,
  );
  // (e) nothing at all.
  assert.equal(energyComplete(emptyJob()), false);
  // (f) and (g): a bill or a survey that produced NO profile has given the
  // engine nothing — _resolve_load cannot read either table.
  assert.equal(
    energyComplete(emptyJob({ bills: [{ bill_id: "b1" }] })), false,
    "a bill that produced no profile is not a load",
  );
  assert.equal(
    energyComplete(emptyJob({ surveys: [{ survey_id: "s1" }] })), false,
    "a survey that produced no profile is not a load",
  );
});

test("2026-08-20: NEWEST row, not `.some(...)` — a superseded series ref does not tick", () => {
  // _resolve_load reads interval_data with order(created_at, desc).limit(1),
  // so a ref on a superseded row is not one the engine would use. Array order
  // is the REVERSE of created_at, so a last-element reader cannot pass here by
  // accident either.
  const job = emptyJob({
    interval_data: [
      { parsed_series_ref: null, created_at: "2026-08-20T02:00:00Z" },
      { parsed_series_ref: "bills/interval/old.series.json",
        created_at: "2026-08-20T01:00:00Z" },
    ],
  });
  assert.equal(energyComplete(job), false);
  // The mirror: the NEWEST row carrying the ref does tick, same array order.
  const newestHasRef = emptyJob({
    interval_data: [
      { parsed_series_ref: "bills/interval/new.series.json",
        created_at: "2026-08-20T02:00:00Z" },
      { parsed_series_ref: null, created_at: "2026-08-20T01:00:00Z" },
    ],
  });
  assert.equal(energyComplete(newestHasRef), true);
  // Same rule on load_profiles: the newest row's figure is the one that counts.
  const supersededFigure = emptyJob({
    load_profiles: [
      { annual_kwh: null, created_at: "2026-08-20T02:00:00Z" },
      { annual_kwh: 8240, created_at: "2026-08-20T01:00:00Z" },
    ],
  });
  // Two rows, array order the reverse of created_at — the newest carries no
  // figure, so the engine has none and the section must not tick.
  assert.equal(energyComplete(supersededFigure), false,
    "the newest profile carries no figure, so the engine has none");
});

test("2026-08-20: the predicate is TOTAL — hostile shapes yield false, never a throw", () => {
  // A numeric STRING is legitimate PostgREST output and must be accepted.
  assert.equal(
    energyComplete(emptyJob({
      load_profiles: [{ annual_kwh: "8240", created_at: "2026-08-20T00:00:00Z" }],
    })),
    true,
    'PostgREST hands numerics back as strings — "8240" is a real figure',
  );
  // Everything that is not a finite positive number is not a figure.
  for (const bad of [null, undefined, 0, -3, NaN, Infinity, -Infinity, "",
                     "eight thousand", true, {}, []]) {
    const job = emptyJob({
      load_profiles: [{ annual_kwh: bad as never, created_at: "2026-08-20T00:00:00Z" }],
    });
    assert.doesNotThrow(() => energyComplete(job), `annual_kwh=${String(bad)}`);
    assert.equal(energyComplete(job), false, `annual_kwh=${String(bad)} must not tick`);
  }
  // A ref that is not a non-empty string is not a series.
  for (const bad of [null, undefined, "", 42, true, {}, []]) {
    const job = emptyJob({
      interval_data: [{ parsed_series_ref: bad as never, created_at: "2026-08-20T00:00:00Z" }],
    });
    assert.doesNotThrow(() => energyComplete(job));
    assert.equal(energyComplete(job), false, `parsed_series_ref=${String(bad)}`);
  }
  // Whole-job junk: missing keys, wrong types, arrays of nulls.
  const spec = SECTIONS.find((s) => s.id === "energy-data");
  assert.ok(spec);
  for (const junk of [{}, { load_profiles: null }, { load_profiles: "rows" },
                      { load_profiles: [null, undefined, 42, "x"] },
                      { interval_data: [null] },
                      { load_profiles: [null], interval_data: "x" }]) {
    assert.doesNotThrow(() => spec!.complete(unsafe<JobDetailLike>(junk)),
      JSON.stringify(junk));
    assert.equal(spec!.complete(unsafe<JobDetailLike>(junk)), false, JSON.stringify(junk));
  }
  // sectionStates keeps its own try/catch — belt and braces, both must hold.
  for (const junk of [null, undefined, "garbage", 42, []]) {
    assert.doesNotThrow(() => sectionStates(junk));
  }
});

test("2026-08-20: THE USER-VISIBLE FAULT — a typed figure unlocks the sections after Energy data", () => {
  // This is the assertion the whole change exists for. Before the fix, Energy
  // data was "active" on this job and every gating section after it was
  // "locked", so the job could never be worked.
  const job = emptyJob({
    path: "B",
    load_profiles: [{ annual_kwh: 8240, hourly_profile_weights: WEIGHTS_24,
                      accuracy_tier: 1, created_at: "2026-08-20T00:00:00Z" }],
    roof_geometry: [{ created_at: "2026-08-20T00:00:00Z",
                      planes: [{ panel_count: 12 }] }],
  });
  const states = new Map(sectionStates(job).map((s) => [s.id, s.state]));
  assert.equal(states.get("energy-data"), "complete",
    "the typed figure completes Energy data");
  // Tariff & network is the next gating section and becomes ACTIVE — it was
  // "locked" before the fix.
  assert.equal(states.get("tariff-network"), "active",
    "the next gating section must now be reachable");
  // And NOTHING after it is locked-out by Energy data any more. Every section
  // beyond the new active one is either locked for its OWN reason or unlocked;
  // what must not happen is Energy data itself holding the gate.
  assert.notEqual(states.get("energy-data"), "active");
  assert.notEqual(states.get("energy-data"), "locked");

  // THE CONTROL: the same job with the figure removed still locks, so this
  // test is not passing because everything unlocks unconditionally.
  const noFigure = emptyJob({
    path: "B",
    roof_geometry: [{ created_at: "2026-08-20T00:00:00Z",
                      planes: [{ panel_count: 12 }] }],
  });
  const lockedStates = new Map(sectionStates(noFigure).map((s) => [s.id, s.state]));
  assert.equal(lockedStates.get("energy-data"), "active");
  assert.equal(lockedStates.get("tariff-network"), "locked",
    "without a load the gate must still hold — otherwise the test proves nothing");
});

test("2026-08-20: the section BODY and the section TICK now read the same table", () => {
  // The contradiction that was on screen: energyDataView reported the figure
  // while the predicate reported incomplete. One job, both readers, agreeing.
  const job = emptyJob({
    load_profiles: [{ annual_kwh: 8240, daily_avg_kwh: 22.6,
                      hourly_profile_weights: WEIGHTS_24, accuracy_tier: 1,
                      created_at: "2026-08-20T00:00:00Z" }],
  });
  const view = energyDataView(job);
  assert.equal(view.annualKwh, 8240, "the body reads the figure");
  assert.equal(view.tier, 1);
  assert.equal(energyComplete(job), true,
    "and the tick agrees — the screen no longer contradicts itself");
});

// ── 2026-08-20 (second fault): the stored profile must render on REVISIT ─────
//
// FOUND ON SCREEN: `recorded` is set ONLY from the /api/load/characterise
// response and never seeded from `view`, so on any reload the panel vanished
// and the empty form came back reading "We cannot work out a profile without a
// yearly total" — on a job whose load_profiles row exists and whose section
// tick was correctly TRUE. The BODY and the TICK disagreed, in the opposite
// direction to the fault fixed earlier the same day. Nobody saw it because the
// section could never tick until today, so no one ever reloaded a job past it.
//
// THESE CHECKS RENDER THE REAL COMPONENT and read the real markup. A check that
// reads the props it passed in cannot see a fault that happens on the way to
// the screen (the F47 shape the LoadPreviewStrip harness above exists for).

const renderEnergySection = await (async () => {
  const { registerHooks } = await import("node:module");
  const ts = (await import("typescript")).default;
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const path = await import("node:path");

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const exts = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];
  // next/navigation's useRouter throws outside an app-router context. The stub
  // is served from memory — no file is added to the repo for it — and it is
  // INERT: refresh() does nothing, which is correct here because these checks
  // never click anything.
  const NAV_STUB = "file:///__verify__/next-navigation.js";

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/navigation") {
        return { url: NAV_STUB, shortCircuit: true };
      }
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
      if (url === NAV_STUB) {
        return {
          format: "module",
          shortCircuit: true,
          source:
            "export function useRouter(){return{refresh(){},push(){},replace(){}," +
            "back(){},forward(){},prefetch(){}};}\n" +
            "export function usePathname(){return '/';}\n" +
            "export function useSearchParams(){return new URLSearchParams();}\n",
        };
      }
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
  const { EnergyDataSection } = await import(
    "../components/worksheet/energy-data-section.tsx"
  );
  return (view: unknown) =>
    renderToStaticMarkup(
      React.createElement(EnergyDataSection, { view, jobId: "job-1" } as never),
    );
})();

/** A view as energyDataView builds one; overrides applied on top. */
function energyView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

/** The view for a job whose typed figure is stored — job a57e13f1's real shape. */
function storedProfileView(overrides: Record<string, unknown> = {}) {
  return energyView({
    tier: 1,
    annualKwh: 8240,
    dailyAvgKwh: 22.6,
    profileWeights: WEIGHTS_24,
    hasStoredProfile: true,
    ...overrides,
  });
}

/** Text as a reader sees it: tags stripped, entities decoded, spaces collapsed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NO_YEARLY_TOTAL = "We cannot work out a profile without a yearly total";

test("2026-08-20 (2nd): a STORED profile renders on revisit — no fresh save in this session", () => {
  const text = visibleText(renderEnergySection(storedProfileView()));
  // THE FAULT: today the panel is absent and the empty form claims the figure
  // is missing, on a job whose row exists and whose tick is TRUE.
  assert.ok(
    !text.includes(NO_YEARLY_TOTAL),
    `the section must not claim the yearly total is missing when it is stored — got: ${text.slice(0, 400)}`,
  );
  // The figures the row actually carries DO reach the screen.
  assert.ok(text.includes("8,240"), `the stored annual figure must render — got: ${text.slice(0, 400)}`);
  assert.ok(text.includes("Tier 1"), `the stored tier must render — got: ${text.slice(0, 400)}`);
});

test("2026-08-20 (2nd): THE PROVENANCE PROOF — a stored profile renders NO call-only sentence", () => {
  // Seven of DemandRecorded's eleven fields are facts about the SAVE CALL, not
  // about the row. The row knows none of them, so none of their sentences may
  // appear. Read from the RENDERED STRING: a check that reads its own input
  // cannot see a fault that happens on the way to the screen.
  const text = visibleText(renderEnergySection(storedProfileView()));
  const callOnly: [string, string][] = [
    ["typed-source note", "entered by the installer"],
    ["typed-source note (status line)", "entered by you"],
    ["bill-source note", "A bill gives us twelve months of totals"],
    ["bill-source note (status line)", "from the bill"],
    ["corrected note", "Figures you corrected"],
    ["survey-not-saved warning", "The survey answers did not save"],
    ["not-fully-saved warning", "Not fully saved"],
    // tierMismatchNotice compares `predicted` against `tier` — both call-only.
    ["tier-mismatch notice", "we expected"],
    ["tier-mismatch notice (alt)", "Tier recorded"],
  ];
  for (const [label, needle] of callOnly) {
    assert.ok(
      !text.toLowerCase().includes(needle.toLowerCase()),
      `${label} must not appear for a stored profile — the row cannot know it. Found "${needle}" in: ${text.slice(0, 500)}`,
    );
  }
  // The CONTROL: the tier-1 "no daily shape" caption is a fact about the ROW
  // (tier 1 IS stored), so it is allowed — this proves the assertion above is
  // not passing merely because nothing at all rendered.
  assert.ok(text.includes("8,240"), "something really did render");
});

test("2026-08-20 (2nd): tier null with a real figure is a REAL STATE — figures render, 'Tier null' never does", () => {
  // energyDataView's own comment: showing a tier off the mere presence of a
  // file would be a lie. A row can carry a figure and no tier.
  const text = visibleText(renderEnergySection(storedProfileView({ tier: null })));
  assert.ok(text.includes("8,240"), "the figure still renders");
  assert.ok(text.includes("tier not recorded"), `expected the not-recorded wording — got: ${text.slice(0, 300)}`);
  assert.ok(!text.includes("Tier null"), "never print 'Tier null'");
  assert.ok(!text.includes("Tier undefined"), "never print 'Tier undefined'");
  assert.ok(!text.includes(NO_YEARLY_TOTAL));
});

test("2026-08-20 (2nd): no usable figure — 0, negative, NaN, Infinity, null — is NOT a stored profile", () => {
  // hasStoredProfile comes from storedLoadProfile, so these are the same
  // values the section predicate refuses. The empty form is CORRECT here.
  for (const bad of [0, -3, NaN, Infinity, -Infinity, null]) {
    const view = storedProfileView({ annualKwh: bad, hasStoredProfile: false });
    const text = visibleText(renderEnergySection(view));
    assert.ok(
      text.includes(NO_YEARLY_TOTAL),
      `annualKwh=${String(bad)} is no figure — the empty form must still say so`,
    );
    assert.ok(!text.includes("Usage profile on this job"),
      `annualKwh=${String(bad)} must not render the stored panel`);
  }
  // And the shared rule agrees, at source: this is the SAME function the
  // predicate calls, so the two cannot disagree.
  for (const bad of [0, -3, NaN, Infinity, null, "", "eight thousand", true, {}]) {
    assert.equal(
      storedLoadProfile({ load_profiles: [{ annual_kwh: bad as never,
                                            created_at: "2026-08-20T00:00:00Z" }] }),
      null,
      `annual_kwh=${String(bad)}`,
    );
  }
  // A numeric string IS a figure — PostgREST hands numerics back that way.
  assert.notEqual(
    storedLoadProfile({ load_profiles: [{ annual_kwh: "8240",
                                          created_at: "2026-08-20T00:00:00Z" }] }),
    null,
  );
});

test("2026-08-20 (2nd): profileWeights null or wrong-length — figures render, NO chart", () => {
  for (const weights of [null, [], [1, 2, 3], Array.from({ length: 25 }, () => 1)]) {
    const text = visibleText(renderEnergySection(storedProfileView({ profileWeights: weights })));
    assert.ok(text.includes("8,240"),
      `weights=${JSON.stringify(weights)?.slice(0, 20)}: the figures must still render`);
    assert.ok(!text.includes(NO_YEARLY_TOTAL));
  }
  // The valid case really does draw the strip, so the assertions above are
  // about absence of a chart, not absence of a chart everywhere.
  const good = renderEnergySection(storedProfileView({ profileWeights: WEIGHTS_24 }));
  assert.ok(good.includes('role="img"'),
    "24 valid weights must draw the preview strip (the strip is the only role=img svg)");
  const none = renderEnergySection(storedProfileView({ profileWeights: null }));
  assert.ok(!none.includes('role="img"'),
    "no weights must draw no strip — never a fabricated chart");
});

test("2026-08-20 (2nd): interval stored with NO profile — the existing behaviour is untouched", () => {
  // The orthogonality that made a separate boolean necessary: `state` is about
  // the FILE, hasStoredProfile about the PROFILE.
  const view = energyView({
    state: "have_interval",
    hasStoredProfile: false,
    readoutParts: ["360 days", "98% actual"],
    nmi: "6123456789",
  });
  const text = visibleText(renderEnergySection(view));
  assert.ok(text.includes("Smart-meter data — read and checked"),
    `the interval read must still render — got: ${text.slice(0, 300)}`);
  assert.ok(!text.includes("Usage profile on this job"),
    "no profile row means no stored-profile panel");
  // And energyDataView itself still reports the two facts separately.
  const built = energyDataView({
    interval_data: [{ parsed_series_ref: "bills/interval/x.json",
                      created_at: "2026-08-20T00:00:00Z" }],
  });
  assert.equal(built.state, "have_interval");
  assert.equal(built.hasStoredProfile, false, "a file is not a profile");
});

test("2026-08-20 (2nd): both stored — the interval branch renders, the stored panel does not duplicate it", () => {
  const view = energyView({
    state: "have_interval",
    hasStoredProfile: true,
    tier: 3,
    annualKwh: 5500,
    dailyAvgKwh: 15.1,
    profileWeights: WEIGHTS_24,
    readoutParts: ["360 days", "98% actual"],
  });
  const text = visibleText(renderEnergySection(view));
  assert.ok(text.includes("Smart-meter data — read and checked"));
  // The interval block ALREADY renders view.annualKwh — a second panel would
  // print the same figures twice.
  assert.ok(!text.includes("Usage profile on this job"),
    "the interval branch owns this case; never render both");
  assert.ok(text.includes("5,500"), "the figures reach the screen via the interval block");
});

test("2026-08-20 (2nd): neither stored — the empty form is CORRECT and unchanged", () => {
  const text = visibleText(renderEnergySection(energyView()));
  assert.ok(text.includes(NO_YEARLY_TOTAL),
    "with no profile and no file the original wording is right");
  assert.ok(text.includes("Record this profile"),
    "and the button still reads Record, not Replace");
  assert.ok(!text.includes("Usage profile on this job"));
});

test("2026-08-20 (2nd): the inputs stay reachable, and the button says Replace when one is stored", () => {
  const text = visibleText(renderEnergySection(storedProfileView()));
  // A stored profile must never hide or disable the ways in.
  assert.ok(text.includes("Drop a NEM12 or interval CSV here"), "upload zone stays");
  assert.ok(text.includes("Annual usage (kWh)"), "the typed-usage box stays");
  assert.ok(text.includes("How much, per year"), "half 1 stays");
  assert.ok(text.includes("When it uses it") || text.includes("when it uses it"),
    "half 2 stays");
  assert.ok(text.includes("Replace this profile"),
    "re-recording keeps working, and the label says what it does");
  assert.ok(!text.includes("Record this profile"),
    "'Record' would describe a job with nothing stored");
});

test("2026-08-20 (2nd): storedLoadProfile is TOTAL and reads the NEWEST row", () => {
  for (const junk of [null, undefined, "x", 42, [], {}, { load_profiles: null },
                      { load_profiles: "rows" }, { load_profiles: [null, 42] }]) {
    assert.doesNotThrow(() => storedLoadProfile(junk), JSON.stringify(junk));
    assert.equal(storedLoadProfile(junk), null, JSON.stringify(junk));
  }
  // Array order the REVERSE of created_at: a last-element reader would return
  // the older row and report a figure the engine would not use.
  const superseded = storedLoadProfile({
    load_profiles: [
      { annual_kwh: null, created_at: "2026-08-20T02:00:00Z" },
      { annual_kwh: 8240, created_at: "2026-08-20T01:00:00Z" },
    ],
  });
  assert.equal(superseded, null, "the newest row carries no figure");
  const current = storedLoadProfile({
    load_profiles: [
      { annual_kwh: 8240, created_at: "2026-08-20T02:00:00Z" },
      { annual_kwh: null, created_at: "2026-08-20T01:00:00Z" },
    ],
  });
  assert.equal(current?.annual_kwh, 8240);
});

test("2026-08-20 (2nd): ONE RULE — the predicate and energyDataView cannot disagree", () => {
  // Both call storedLoadProfile, so this holds by construction; the test is
  // here because it stopped holding twice today when they did not.
  const shapes: Record<string, unknown>[] = [
    { load_profiles: [{ annual_kwh: 8240, created_at: "2026-08-20T00:00:00Z" }] },
    { load_profiles: [{ annual_kwh: 0, created_at: "2026-08-20T00:00:00Z" }] },
    { load_profiles: [{ annual_kwh: null, created_at: "2026-08-20T00:00:00Z" }] },
    { load_profiles: [] },
    {},
  ];
  for (const shape of shapes) {
    const job = emptyJob(shape as Partial<JobDetailLike>);
    assert.equal(
      energyDataView(job).hasStoredProfile,
      storedLoadProfile(job) !== null,
      `view vs rule: ${JSON.stringify(shape)}`,
    );
    // The predicate agrees too, on every shape where the interval branch is
    // not in play (these all have no interval rows).
    assert.equal(
      completeOf("energy-data", job),
      storedLoadProfile(job) !== null,
      `predicate vs rule: ${JSON.stringify(shape)}`,
    );
  }
});

// ── elapsedLabel (checklist 3.13 prompt 2b) ──────────────────────────────────

test("elapsedLabel: the documented shape — seconds bare, minutes zero-pad the seconds", () => {
  assert.equal(elapsedLabel(0), "0s");
  assert.equal(elapsedLabel(999), "0s"); // floor, not round — a second is a second only once it has elapsed
  assert.equal(elapsedLabel(1000), "1s");
  assert.equal(elapsedLabel(47_000), "47s");
  assert.equal(elapsedLabel(59_000), "59s");
  assert.equal(elapsedLabel(60_000), "1m 00s");
  assert.equal(elapsedLabel(61_000), "1m 01s");
  assert.equal(elapsedLabel(64_000), "1m 04s");
  assert.equal(elapsedLabel(151_000), "2m 31s");
  assert.equal(elapsedLabel(3_599_000), "59m 59s");
  assert.equal(elapsedLabel(3_600_000), "60m 00s");
});

test("elapsedLabel: total — junk never throws, everything junk is '0s'", () => {
  assert.equal(elapsedLabel(-1), "0s");
  assert.equal(elapsedLabel(-999_999), "0s");
  assert.equal(elapsedLabel(Number.NaN), "0s");
  assert.equal(elapsedLabel(Number.POSITIVE_INFINITY), "0s");
  assert.equal(elapsedLabel(Number.NEGATIVE_INFINITY), "0s");
  assert.equal(elapsedLabel(null as unknown as number), "0s");
  assert.equal(elapsedLabel(undefined as unknown as number), "0s");
  assert.equal(elapsedLabel("47" as unknown as number), "0s");
});

// ── 3.13 prompt 3: the Results section (R1-R4) ───────────────────────────────

test("R1: currentFinancialResult picks the MATCHING row; unmatched-only yields null", () => {
  const sizing = { sizing_result_id: "s2", created_at: "2026-08-02T00:00:00Z", solar_kw: 9.9 };
  // Array DELIBERATELY ordered the reverse of created_at — position must not win.
  const fins = [
    { sizing_result_id: "s2", created_at: "2026-08-03T00:00:00Z", payback_years: 3.3 },
    { sizing_result_id: "s2", created_at: "2026-08-05T00:00:00Z", payback_years: 2.2 },
    { sizing_result_id: "s1", created_at: "2026-08-06T00:00:00Z", payback_years: 9.9 },
  ];
  const job = emptyJob({ sizing_results: [sizing], financial_results: fins });
  const row = currentFinancialResult(job);
  assert.equal(row?.payback_years, 2.2,
    "the NEWEST row among those matching s2 — never the newest overall (9.9 is s1's)");

  // THE NULL CASE, the one that matters: the only financial row belongs to an
  // OLDER sizing result — null, never a fallback to the unmatched row.
  const orphanOnly = emptyJob({
    sizing_results: [sizing],
    financial_results: [
      { sizing_result_id: "s1", created_at: "2026-08-06T00:00:00Z", payback_years: 9.9 },
    ],
  });
  assert.equal(currentFinancialResult(orphanOnly), null,
    "a financial row for a superseded run must yield NULL — a missing number is honest, a mismatched one is not");

  // Total.
  for (const junk of [null, undefined, 42, "x", {}, { financial_results: "nope" }]) {
    assert.doesNotThrow(() => currentFinancialResult(junk));
  }
});

test("R2: the Results predicate and resultsView agree on EVERY fixture — run both, compare", () => {
  const spec = SECTIONS.find((s) => s.id === "results");
  assert.ok(spec);
  const fixtures: unknown[] = [
    emptyJob(),
    emptyJob({ sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6 }] }),
    emptyJob({
      sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6 }],
      financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    }),
    emptyJob({
      sizing_results: [{ sizing_result_id: "s2", solar_kw: 6.6 }],
      financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    }),
    emptyJob({ financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }] }),
    emptyJob({ sizing_results: "junk", financial_results: "junk" }),
  ];
  for (const [i, job] of fixtures.entries()) {
    const tick = spec!.complete(job as never);
    const body = resultsView(job);
    assert.equal(tick, body.state === "ready",
      `fixture ${i}: tick says ${tick} but the body renders ${body.state} — a section whose tick and body disagree is the 2026-08-20 fault`);
  }
});

test("R3: resultsView joins the roof BY ID — the newest roof row must NOT win", () => {
  const job = emptyJob({
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 6.6, run_kind: "solar",
      roof_geometry_id: "roof-OLD", roof_low_confidence: false,
      evaluated_options: {
        dimension_keys: ["solar_kw"],
        points: [
          { solar_kw: 0, plane_indices: [], panels_per_plane: [] },
          { solar_kw: 6.6, plane_indices: [0], panels_per_plane: [15] },
        ],
        chosen_index: 1,
      },
    }],
    financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    roof_geometry: [
      // NEWEST first, and it is NOT the roof the run names: its plane faces
      // south. If the code took the newest, the direction would read S.
      { roof_geometry_id: "roof-NEW", created_at: "2026-08-10T00:00:00Z",
        planes: [{ azimuth: 180, pitch: 30, panel_count: 15 }] },
      { roof_geometry_id: "roof-OLD", created_at: "2026-08-01T00:00:00Z",
        planes: [{ azimuth: 0, pitch: 22, panel_count: 15 }] },
    ],
  });
  const view = resultsView(job);
  assert.equal(view.state, "ready");
  assert.ok(view.layoutLines, `layout missing: ${view.layoutNote}`);
  assert.match(view.layoutLines![0], /N-facing/,
    "the direction must come from roof-OLD (azimuth 0 = N), the row the run NAMES");
  assert.doesNotMatch(view.layoutLines![0], /S-facing/,
    "S would mean the newest roof won — the exact fault this check exists to catch");
});

test("R4: resultsView is total — junk yields nulls, honest notes, no invented figures", () => {
  // Junk evaluated_options.
  const junkEo = emptyJob({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6,
      roof_geometry_id: "r1", evaluated_options: "garbage" }],
    financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    roof_geometry: [{ roof_geometry_id: "r1", planes: [{ azimuth: 0 }] }],
  });
  const v1 = resultsView(junkEo);
  assert.equal(v1.state, "ready");
  assert.equal(v1.layoutLines, null);
  assert.ok(v1.layoutNote, "the omitted direction carries an honest line");

  // Missing roof row for the named id.
  const noRoof = emptyJob({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6,
      roof_geometry_id: "r-gone",
      evaluated_options: { points: [{ plane_indices: [0], panels_per_plane: [5], solar_kw: 6.6 }], chosen_index: 0 } }],
    financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    roof_geometry: [{ roof_geometry_id: "r-other", planes: [] }],
  });
  const v2 = resultsView(noRoof);
  assert.equal(v2.layoutLines, null);
  assert.match(v2.layoutNote ?? "", /could not be matched/);

  // roof_low_confidence null is NOT clean — the not-recorded notice renders.
  assert.ok(
    resultsView(noRoof).roofNotices.some((n) => /not recorded/.test(n.title)),
    "null roof state must say 'not recorded', never pass as clean",
  );
  // ...and false IS clean — no roof notice at all.
  const clean = emptyJob({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6,
      roof_low_confidence: false }],
    financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
  });
  assert.equal(resultsView(clean).roofNotices.length, 0);

  // A sizing row with no financial row: awaiting, headline null.
  const awaiting = emptyJob({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6 }],
  });
  const v3 = resultsView(awaiting);
  assert.equal(v3.state, "awaiting-financial");
  assert.equal(v3.headline, null);

  // Non-array planes.
  const badPlanes = emptyJob({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 6.6,
      roof_geometry_id: "r1",
      evaluated_options: { points: [{ plane_indices: [0], panels_per_plane: [5], solar_kw: 6.6 }], chosen_index: 0 } }],
    financial_results: [{ sizing_result_id: "s1", annual_savings: 1800 }],
    roof_geometry: [{ roof_geometry_id: "r1", planes: "not-an-array" }],
  });
  const v4 = resultsView(badPlanes);
  assert.equal(v4.layoutLines, null);
  assert.ok(v4.layoutNote);

  // Total, and the unsized state never shows a zero.
  for (const junk of [null, undefined, 0, "x", [], {}]) {
    assert.doesNotThrow(() => resultsView(junk));
    assert.equal(resultsView(junk).state, "unsized");
    assert.equal(resultsView(junk).headline, null);
  }
});

// ── 3.13 prompt 4: the tab, the formatters, the framing (T1-T5) ──────────────

test("T1: ONE formatter set — bar, section and tab produce the SAME string for the same input", () => {
  // The regression this pins: the same run rendered "9.24 kW" in the bar and
  // "9.2 kW" in the section on one screen. Every surface imports the ONE
  // exported function, so equality here IS equality everywhere; a second
  // formatter on any surface has no way to pass this.
  const inputs: unknown[] = [9.24, 9.8, 9.0, 0, null, Number.NaN, Number.POSITIVE_INFINITY, "junk"];
  const expectedKw = ["9.24 kW", "9.8 kW", "9 kW", "0 kW", "—", "—", "—", "—"];
  for (const [i, v] of inputs.entries()) {
    assert.equal(formatKw(v), expectedKw[i], `formatKw(${String(v)})`);
    // The three surfaces do not own formatters; they call these very
    // functions, so same-input-same-output is guaranteed by identity:
    assert.equal(formatKw(v), formatKw(v));
    assert.equal(formatKwh(v), formatKwh(v));
  }
  assert.equal(formatKwh(9.83), "9.83 kWh");
  assert.equal(formatYears(4.41), "4.41 yr");
  assert.equal(formatYears(4.5), "4.5 yr");
  assert.equal(formatPct(84.12), "84.12%");
  assert.equal(formatMoney(11868.77), "$11,869");
  assert.equal(formatMoneyCents(11868.77), "$11,868.77");
  assert.equal(formatMoney(null), "—");
  // The stored run's own numbers, through the view layer, use the same set:
  // resultsView's headline and resultsTabView's headline are the same object.
  const job = {
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 9.24, battery_kwh: 9.83, run_kind: "solar_battery" }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 11868.77 }],
  };
  const section = resultsView(job);
  const tab = resultsTabView(job);
  assert.equal(section.headline?.solarKw, "9.24 kW");
  assert.deepEqual(tab.headline, section.headline,
    "the tab renders the section's own headline object — no second derivation");
});

test("T2: the eliminated-bill framing — zero, negative, positive", () => {
  const zero = projectedSpendView(0);
  assert.equal(zero?.kind, "eliminated");
  assert.equal(zero?.kind === "eliminated" ? zero.exportIncome : "x", null,
    "exactly zero: eliminated, nothing to state as income");
  const negative = projectedSpendView(-412.5);
  assert.equal(negative?.kind, "eliminated");
  const income = negative?.kind === "eliminated" ? negative.exportIncome : null;
  assert.equal(income, "$413", "the amount below zero as a POSITIVE figure");
  assert.ok(income && !income.includes("-"), "never a minus sign");
  const positive = projectedSpendView(1190.35);
  assert.equal(positive?.kind, "spend");
  assert.equal(positive?.kind === "spend" ? positive.label : null, "$1,190");
  assert.equal(projectedSpendView(null), null);
  assert.doesNotThrow(() => projectedSpendView(Number.NaN));
});

test("T3: no split, no breakdown, NULL run_assumptions — honest gaps, headline still renders", () => {
  const job = {
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24, battery_kwh: 9.83,
      run_kind: "solar_battery", run_assumptions: null,
      evaluated_options: { dimension_keys: ["battery_id"], points: [] },
    }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 11868.77,
      annual_savings: 2689.6, projected_annual_spend: 337.32 }],
  };
  const tab = resultsTabView(job);
  assert.equal(tab.state, "ready");
  assert.equal(tab.headline?.systemCost, "$11,869", "headline renders");
  assert.equal(tab.split, null);
  assert.match(tab.splitNote ?? "", /stored before the split was recorded/);
  assert.equal(tab.cost, null);
  assert.match(tab.costNote ?? "", /not recorded/);
  assert.equal(tab.assumptions, null);
  assert.match(tab.assumptionsNote ?? "", /not recorded/,
    "NULL assumptions is an honest gap, never an empty table");
});

test("T4: cost lines that do not sum to net — the disagreement is SURFACED", () => {
  const job = {
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24, run_kind: "solar",
      evaluated_options: {
        chosen_cost_breakdown: {
          net_cost: 6342.0,
          line_items: [
            { item: "Panels", detail: "", amount_aud: 3000.0 },
            { item: "Solar install", detail: "", amount_aud: 2000.0 },
          ],
          flags: [],
        },
      },
    }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 6342.0 }],
  };
  const tab = resultsTabView(job);
  assert.ok(tab.cost);
  assert.equal(tab.cost!.sumAgrees, false, "5000 != 6342 must be surfaced");
  assert.equal(tab.cost!.sumOfLines, "$5,000.00", "both figures shown, neither preferred");
  assert.equal(tab.cost!.net, "$6,342.00");
  // ...and a NULL amount reads as unconfirmed, never $0, and never breaks the
  // sum check (an unpriced line makes the sum unverifiable, not wrong).
  const withNull = resultsTabView({
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24, run_kind: "solar",
      evaluated_options: {
        chosen_cost_breakdown: {
          net_cost: 6342.0,
          line_items: [{ item: "Inverter", detail: "", amount_aud: null }],
          flags: ["inverter not priced"],
        },
      },
    }],
    financial_results: [{ sizing_result_id: "s1" }],
  });
  assert.equal(withNull.cost!.lines[0].amount, "installer to confirm");
  assert.equal(withNull.cost!.allPriced, false);
  assert.equal(withNull.cost!.sumAgrees, true, "unverifiable is not a disagreement");
  assert.deepEqual(withNull.cost!.flags, ["inverter not priced"], "breakdown flags verbatim");
});

test("T5: totals — junk jsonb, non-array line_items, null financial row", () => {
  for (const junk of [null, undefined, 42, "x", [], {},
    { sizing_results: "junk" },
    { sizing_results: [{ sizing_result_id: "s1", evaluated_options: { chosen_cost_breakdown: { line_items: "nope", net_cost: 1 } } }],
      financial_results: [{ sizing_result_id: "s1" }] },
    { sizing_results: [{ sizing_result_id: "s1", run_assumptions: [1, 2] }],
      financial_results: [{ sizing_result_id: "s1" }] },
  ]) {
    assert.doesNotThrow(() => resultsTabView(junk));
  }
  const badLines = resultsTabView({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 1,
      evaluated_options: { chosen_cost_breakdown: { line_items: "nope", net_cost: 1 } } }],
    financial_results: [{ sizing_result_id: "s1" }],
  });
  assert.equal(badLines.cost, null);
  assert.ok(badLines.costNote);
  const noFin = resultsTabView({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 1 }],
  });
  assert.equal(noFin.state, "awaiting-financial");
  assert.equal(noFin.headline, null);
  assert.equal(noFin.projected, null);
});

// ── 3.13 prompt 4b: per-field provenance, the one framing, the curve (U1-U4) ─

test("U1: each assumption row carries its OWN source — installer rates beside a default fit", () => {
  const job = {
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24, run_kind: "solar_battery",
      run_assumptions: {
        import_rates_24: [0.2, 0.55], rate_24_source: "installer",
        import_rate: 0.4, import_rate_source: "default",
        tariff_type: "tou", tariff_type_source: "installer",
        fit: 0.04, fit_source: "default", fit_is_fallback: true,
        supply_charge_annual: 383.25, supply_charge_source: "installer",
      },
    }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 1 }],
  };
  const rows = resultsTabView(job).assumptions ?? [];
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  // 3.18 prompt 2: sources render as WORDS now, through
  // ASSUMPTION_SOURCE_WORDS — the historical "installer" token gets the
  // unrecorded wording, because that is all it ever actually established.
  assert.equal(
    byLabel.get("Hourly import rates")?.source,
    ASSUMPTION_SOURCE_WORDS.installer,
    "the stored windows must never read as a default",
  );
  assert.equal(byLabel.get("Import rate")?.source, ASSUMPTION_SOURCE_WORDS.default,
    "the scalar genuinely defaulted — the two answer different questions");
  assert.equal(byLabel.get("Tariff type")?.source, ASSUMPTION_SOURCE_WORDS.installer);
  assert.equal(byLabel.get("Feed-in tariff")?.source, "the state feed-in scheme's default",
    "a default fit stays a default BESIDE installer rates — and is NAMED, not generic");
  // A pre-4b stored row renders what it recorded via the legacy fallback.
  const legacy = resultsTabView({
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 1,
      run_assumptions: { import_rate: 0.38, tariff_source: "bill" } }],
    financial_results: [{ sizing_result_id: "s1" }],
  }).assumptions ?? [];
  assert.equal(legacy.find((r) => r.label === "Import rate")?.source,
    ASSUMPTION_SOURCE_WORDS.bill,
    "history is rendered as recorded, not rewritten and not hidden");
});

test("U2: the tariff type is plain words and the duplicate TOU row is gone", () => {
  const job = {
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24,
      run_assumptions: { tariff_type: "tou", tariff_type_source: "installer",
        is_tou: true },
    }],
    financial_results: [{ sizing_result_id: "s1" }],
  };
  const rows = resultsTabView(job).assumptions ?? [];
  const type = rows.find((r) => r.label === "Tariff type");
  assert.equal(type?.value, "time of use", "never the raw database token 'tou'");
  assert.ok(!rows.some((r) => /time-of-use pricing/i.test(r.label)),
    "two rows stating one fact is how a panel disagrees with itself");
  assert.ok(!rows.some((r) => r.value === "tou"),
    "the raw token must not appear anywhere");
});

test("U3: the bill-eliminated derivation is THE SAME function on both surfaces", () => {
  for (const spend of [0, -412.5, 1190.35, null]) {
    const job = {
      sizing_results: [{ sizing_result_id: "s1", solar_kw: 9.24 }],
      financial_results: [{ sizing_result_id: "s1",
        projected_annual_spend: spend }],
    };
    const section = resultsView(job).projected;
    const tab = resultsTabView(job).projected;
    assert.deepEqual(section, tab,
      `projected spend ${spend}: the section and the tab must render the same framing`);
    assert.deepEqual(section, projectedSpendView(spend),
      "and both ARE projectedSpendView's own answer — one derivation");
  }
});

// ── 3.18 prompt 2: the panel says where each value came from, in words ───────

function assumptionJob(ra: Record<string, unknown>) {
  return {
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 9.24,
      run_assumptions: ra }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 1 }],
  };
}

function rowsFor(ra: Record<string, unknown>) {
  return resultsTabView(assumptionJob(ra)).assumptions ?? [];
}

test("3.18 (view): every token, old and new, maps to words — and a default never reads as a decision", () => {
  // The full vocabulary renders words, not tokens.
  for (const [token, words] of Object.entries(ASSUMPTION_SOURCE_WORDS)) {
    const rows = rowsFor({ import_rate: 0.4, import_rate_source: token });
    assert.equal(rows.find((r) => r.label === "Import rate")?.source, words,
      `token ${token} must render its words`);
  }
  // The three installer_* forms make three DIFFERENT claims — and only
  // "typed" claims entry. The accepted-default wording says the opposite.
  assert.notEqual(ASSUMPTION_SOURCE_WORDS.installer_typed,
    ASSUMPTION_SOURCE_WORDS.installer_accepted_default);
  assert.match(ASSUMPTION_SOURCE_WORDS.installer_accepted_default, /not chosen/,
    "an accepted default must SAY it was not chosen");
  assert.match(ASSUMPTION_SOURCE_WORDS.installer_unrecorded, /not recorded/,
    "unrecorded must say so, shortly, and stop (D47)");
  // The historical token establishes only what unrecorded establishes.
  assert.equal(ASSUMPTION_SOURCE_WORDS.installer,
    ASSUMPTION_SOURCE_WORDS.installer_unrecorded);
  // An unknown token renders VERBATIM rather than dropping the row — every
  // stored assumption traces; none is hidden.
  const odd = rowsFor({ import_rate: 0.4, import_rate_source: "from_a_comet" });
  assert.equal(odd.find((r) => r.label === "Import rate")?.source, "from_a_comet");
});

test("3.18 (view): the export row reads export_meta.source and NOTHING else", () => {
  // dnsp_standard names the network — detail, used only AFTER the token
  // decided the source.
  const dnsp = rowsFor({ export_limit_kw: 5,
    export_limit_source: { source: "dnsp_standard", dnsp: "SA Power Networks",
      state: "SA", export_limit_kw: 5, is_default: false } });
  assert.equal(dnsp.find((r) => r.label === "Export limit")?.source,
    "SA Power Networks's standard published limit");
  // The conservative fallback says what it is and why.
  const def = rowsFor({ export_limit_kw: 5,
    export_limit_source: { source: "default", export_limit_kw: 5, is_default: true } });
  assert.match(def.find((r) => r.label === "Export limit")?.source ?? "",
    /conservative default/);
  // THE DELETED GUESS: a meta with dnsp and is_default but NO source token
  // must NOT invent one from the shape — the legacy lookup meta renders no
  // source rather than a guess.
  const shapeOnly = rowsFor({ export_limit_kw: 5,
    export_limit_source: { dnsp: "SA Power Networks", is_default: true,
      export_limit_kw: 5 } });
  assert.equal(shapeOnly.find((r) => r.label === "Export limit")?.source, null,
    "presence of dnsp/is_default is a SHAPE, not a source");
  // A given-branch token still words correctly.
  const typed = rowsFor({ export_limit_kw: 5,
    export_limit_source: { source: "installer_typed", export_limit_kw: 5 } });
  assert.equal(typed.find((r) => r.label === "Export limit")?.source,
    ASSUMPTION_SOURCE_WORDS.installer_typed);
});

test("3.18 (view): the hourly-rates row says both things on ONE line", () => {
  const gapped = rowsFor({
    import_rates_24: [0.2, 0.55], rate_24_source: "installer_typed",
    rate_24_gap_filled_hours: 4,
  });
  const line = gapped.find((r) => r.label === "Hourly import rates");
  assert.equal(line?.source,
    `${ASSUMPTION_SOURCE_WORDS.installer_typed}; 4 of the 24 hours had no window and took the flat-rate default`,
    "one line credits the windows AND counts the defaulted hours");
  // Zero gaps adds nothing — full coverage says nothing extra (D47).
  const full = rowsFor({
    import_rates_24: [0.2, 0.55], rate_24_source: "installer_typed",
    rate_24_gap_filled_hours: 0,
  });
  assert.equal(full.find((r) => r.label === "Hourly import rates")?.source,
    ASSUMPTION_SOURCE_WORDS.installer_typed);
  // A run stored before the count existed renders exactly as before.
  const old = rowsFor({
    import_rates_24: [0.2, 0.55], rate_24_source: "installer",
  });
  assert.equal(old.find((r) => r.label === "Hourly import rates")?.source,
    ASSUMPTION_SOURCE_WORDS.installer);
  // The two new machine keys never render as raw token rows.
  const machine = rowsFor({
    import_rate: 0.4, rate_24_gap_filled_hours: 0,
    tariff_provenance_state: "recorded",
  });
  assert.ok(!machine.some((r) => r.label === "rate_24_gap_filled_hours"
    || r.label === "tariff_provenance_state"),
    "consumed as facts, not rendered as rows");
});

// ── 3.18 prompt 2b: the Constraints applied row ─────────────────────────────
// The defect: since 3.14b constraints_applied ALWAYS carries the two pin-record
// dicts (all-null when nothing is pinned, F191), the old filter tested only
// whether the top-level value was non-null, so "none" was unreachable on every
// run and a genuine pin reached the installer as raw JSON.

/** The EXACT shape stored on the live 670c80db run, as read from the database
    on 2026-08-27 — the case the panel got wrong on screen. */
const LIVE_UNPINNED_CONSTRAINTS = {
  equipment_pin_source: { panel: null, battery: null, inverter: null },
  equipment_pin_unavailable: { panel: null, battery: null, inverter: null },
};

/** Every fixture both languages are compared over, so the frontend half and
    verify_results_contract.py's cross-language check drive the same set. */
const CONSTRAINT_FIXTURES: { name: string; value: unknown; unconstrained: boolean }[] = [
  { name: "the live all-null shape", value: LIVE_UNPINNED_CONSTRAINTS, unconstrained: true },
  { name: "solar writer, nothing set", value: {
      panel_id: null, inverter_id: null, fix_solar_kwp: null, fix_panel_count: null,
      ...LIVE_UNPINNED_CONSTRAINTS }, unconstrained: true },
  { name: "a pinned panel from the job", value: {
      ...LIVE_UNPINNED_CONSTRAINTS,
      equipment_pin_source: { panel: "job", battery: null, inverter: null },
    }, unconstrained: false },
  { name: "a pinned battery from the request", value: {
      ...LIVE_UNPINNED_CONSTRAINTS,
      equipment_pin_source: { panel: null, battery: "request", inverter: null },
    }, unconstrained: false },
  { name: "an unavailable pinned panel", value: {
      ...LIVE_UNPINNED_CONSTRAINTS,
      equipment_pin_unavailable: { panel: "pan-123", battery: null, inverter: null },
    }, unconstrained: false },
  { name: "a size key set", value: {
      panel_id: null, fix_solar_kwp: 6.6, ...LIVE_UNPINNED_CONSTRAINTS },
    unconstrained: false },
  { name: "a product key set", value: {
      panel_id: "pan-abc", inverter_id: null, ...LIVE_UNPINNED_CONSTRAINTS },
    unconstrained: false },
  { name: "force_no_battery true", value: {
      force_no_battery: true, ...LIVE_UNPINNED_CONSTRAINTS }, unconstrained: false },
  { name: "force_no_battery false is NOT a constraint", value: {
      force_no_battery: false, ...LIVE_UNPINNED_CONSTRAINTS }, unconstrained: true },
  { name: "a size key of 0 (Python: 0 == False, so unconstrained)", value: {
      fix_panel_count: 0, ...LIVE_UNPINNED_CONSTRAINTS }, unconstrained: true },
  { name: "an empty dict (pre-3.14b)", value: {}, unconstrained: true },
  { name: "null", value: null, unconstrained: true },
  { name: "a non-dict string", value: "everything", unconstrained: false },
  { name: "a non-dict number", value: 42, unconstrained: false },
  { name: "an empty string (falsy in Python)", value: "", unconstrained: true },
  { name: "an empty array (falsy in Python)", value: [], unconstrained: true },
  { name: "a non-empty array", value: ["fix_solar_kwp"], unconstrained: false },
  { name: "a pin key that is not a dict (Python skips it)", value: {
      equipment_pin_source: "job" }, unconstrained: true },
  { name: "a pin key that is an array (not a dict in Python)", value: {
      equipment_pin_source: ["job"] }, unconstrained: true },
  { name: "an unknown key set", value: {
      fix_wombat_count: 3, ...LIVE_UNPINNED_CONSTRAINTS }, unconstrained: false },
];

function constraintRow(constraints: unknown): string {
  const rows = rowsFor({ constraints_applied: constraints });
  const row = rows.find((r) => r.label === "Constraints applied");
  assert.ok(row, "the Constraints applied row must always render");
  return row!.value;
}

test("3.18-2b: the LIVE stored shape reads 'none' — the case seen on screen", () => {
  // Since 3.14b this printed two raw JSON blobs of nulls and claimed they were
  // applied. WHY IT MOVES: the old filter kept any non-null top-level value,
  // and a dict of nulls is not null.
  assert.equal(isUnconstrained(LIVE_UNPINNED_CONSTRAINTS), true);
  assert.equal(constraintRow(LIVE_UNPINNED_CONSTRAINTS), "none");
  // ...and a genuine pin does NOT read none, and carries no brace.
  const pinned = constraintRow({
    ...LIVE_UNPINNED_CONSTRAINTS,
    equipment_pin_source: { panel: "job", battery: null, inverter: null },
  });
  assert.notEqual(pinned, "none");
  assert.equal(pinned, "panel pinned on the job");
});

test("3.18-2b: the predicate agrees with the reference rule on every fixture", () => {
  // The Python half of this comparison lives in verify_results_contract.py and
  // runs BOTH implementations over these same shapes.
  for (const f of CONSTRAINT_FIXTURES) {
    assert.equal(isUnconstrained(f.value), f.unconstrained,
      `${f.name}: isUnconstrained(${JSON.stringify(f.value)})`);
  }
});

test("3.18-2b: NO JSON reaches the string — no brace, no quote, on any fixture", () => {
  // A test that only checked the unconstrained case would not have caught the
  // constrained half, which is where the blob actually appeared.
  for (const f of CONSTRAINT_FIXTURES) {
    const value = constraintRow(f.value);
    assert.ok(!value.includes("{"), `${f.name}: a brace reached the panel: ${value}`);
    assert.ok(!value.includes("\""), `${f.name}: a quote reached the panel: ${value}`);
    assert.ok(value.length > 0, `${f.name}: the row is never blank`);
    assert.equal(value === "none", f.unconstrained,
      `${f.name}: "none" iff unconstrained`);
  }
});

test("3.18-2b: what IS set reads as plain words, never a raw key name", () => {
  assert.equal(constraintRow({ ...LIVE_UNPINNED_CONSTRAINTS,
    equipment_pin_source: { panel: null, battery: "request", inverter: null } }),
    "battery pinned in this request");
  assert.equal(constraintRow({ ...LIVE_UNPINNED_CONSTRAINTS,
    equipment_pin_unavailable: { panel: "pan-123", battery: null, inverter: null } }),
    "the pinned panel pan-123 could not be used");
  assert.equal(constraintRow({ fix_solar_kwp: 6.6, ...LIVE_UNPINNED_CONSTRAINTS }),
    "solar size fixed at 6.6 kW");
  assert.equal(constraintRow({ panel_id: "pan-abc", ...LIVE_UNPINNED_CONSTRAINTS }),
    "panel fixed to pan-abc");
  assert.equal(constraintRow({ force_no_battery: true, ...LIVE_UNPINNED_CONSTRAINTS }),
    "battery excluded");
  assert.equal(constraintRow({ battery_ids: ["bat-1", "bat-2"], ...LIVE_UNPINNED_CONSTRAINTS }),
    "battery choice limited to bat-1, bat-2");
  // Several at once read as one sentence, in stored order.
  assert.equal(constraintRow({
    panel_id: "pan-abc", fix_panel_count: 24,
    equipment_pin_source: { panel: "job", battery: null, inverter: null },
    equipment_pin_unavailable: { panel: null, battery: "bat-9", inverter: null },
  }), "panel fixed to pan-abc, panel count fixed at 24 panels, panel pinned on the job, "
    + "the pinned battery bat-9 could not be used");
  // An unrecognised key still renders — nothing stored is hidden — with its
  // underscores opened out rather than as a raw token.
  assert.equal(constraintRow({ fix_wombat_count: 3, ...LIVE_UNPINNED_CONSTRAINTS }),
    "fix wombat count: 3");
  // An unexpected pin value renders verbatim rather than being dropped.
  assert.equal(constraintRow({
    equipment_pin_source: { panel: "elsewhere", battery: null, inverter: null } }),
    "panel pinned (elsewhere)");
});

test("3.18-2b: the row renders on any stored run — junk never throws", () => {
  const junk: unknown[] = [
    null, undefined, 0, false, true, 42, -1, "", "everything", [], ["a", "b"],
    {}, { equipment_pin_source: null }, { equipment_pin_source: 7 },
    { equipment_pin_source: { panel: { nested: true } } },
    { equipment_pin_unavailable: { panel: ["a"] } },
    { fix_solar_kwp: { deep: { deeper: 1 } } },
    { weird: [1, 2, 3] },
  ];
  for (const j of junk) {
    const value = constraintRow(j);
    assert.equal(typeof value, "string", `${JSON.stringify(j)} must render a string`);
    assert.ok(value.length > 0);
    assert.ok(!value.includes("{"), `brace from ${JSON.stringify(j)}: ${value}`);
    assert.ok(!value.includes("\""), `quote from ${JSON.stringify(j)}: ${value}`);
    assert.equal(typeof isUnconstrained(j), "boolean");
  }
});

test("3.18 (view): junk input never throws and never invents a claim", () => {
  const junkMetas: unknown[] = [null, 42, "a string", [], { source: 7 },
    { source: { nested: true } }, { dnsp: 9, is_default: "yes" }];
  for (const meta of junkMetas) {
    const rows = rowsFor({ export_limit_kw: 5, export_limit_source: meta });
    const row = rows.find((r) => r.label === "Export limit");
    assert.ok(row, "the export row always renders");
    assert.ok(row!.source === null || typeof row!.source === "string");
  }
  for (const gaps of [null, "four", -1, {}, true]) {
    const rows = rowsFor({ import_rates_24: [0.2], rate_24_source: "bill",
      rate_24_gap_filled_hours: gaps });
    const line = rows.find((r) => r.label === "Hourly import rates");
    // Unreadable or non-positive counts add nothing; the source words stay.
    assert.equal(line?.source, ASSUMPTION_SOURCE_WORDS.bill,
      `gap junk ${JSON.stringify(gaps)} must not corrupt the line`);
  }
});
// ── 3.13 prompt 4d: BARS, not a line (4d-V1 … 4d-V6) ────────────────────────
//
// RESTATED from 4b's U4/U4b, which pinned the LINE shape this prompt deletes.
// The fault, found on screen 2026-08-21 and reproduced from the live stored
// run: two different batteries sit at 12.8 kWh with very different answers, so
// a connecting line joined two unrelated products.

/** The live fixture's own battery payload shape, values as stored. */
const REAL_BATTERY_JOB = {
  sizing_results: [{
    sizing_result_id: "s1", run_kind: "solar_battery", objective_used: "max_npv",
    battery_kwh: 9.83, system_cost: 11868.77,
    evaluated_options: {
      dimension_keys: ["battery_id"],
      points: [
        { model: "No battery", usable_kwh: 0, incremental_npv: 0, system_cost: 6342 },
        { model: "Sigenergy SigenStor Sigen Battery 8.0", usable_kwh: 7.8,
          incremental_npv: 1212.94, system_cost: 12869 },
        { model: "GoodWe Lynx Home F", usable_kwh: 9.83,
          incremental_npv: 2867.22, system_cost: 11868.77 },
        // TWO PRODUCTS AT 12.8 kWh — the pair the line joined.
        { model: "Sungrow SBR128", usable_kwh: 12.8,
          incremental_npv: 2344.42, system_cost: 14842 },
        { model: "BYD Battery-Box Premium HVS 12.8", usable_kwh: 12.8,
          incremental_npv: 669.83, system_cost: 16342 },
        { model: "Tesla Powerwall 3", usable_kwh: 13.5,
          incremental_npv: -3832.69, system_cost: 19842 },
        { model: "Sungrow SBH200", usable_kwh: 20,
          incremental_npv: 2673.93, system_cost: 16819.84 },
      ],
    },
  }],
  financial_results: [{ sizing_result_id: "s1", system_capex: 11868.77 }],
};

test("4d-V1: the axis formatter — round, readable, and never a decimal point", () => {
  const cases: [unknown, string][] = [
    [3202.2155, "$3,202"],
    [-4167.6855, "-$4,168"],
    [0, "$0"],
    [999, "$999"],
    [1000, "$1,000"],
    [12345, "$12k"],
    [1234567, "$1M"],
    [null, ""],
    [Number.NaN, ""],
    [Number.POSITIVE_INFINITY, ""],
  ];
  for (const [input, expected] of cases) {
    const out = formatAxisTick(input, "aud");
    assert.equal(out, expected, `formatAxisTick(${String(input)})`);
    assert.ok(!out.includes("."),
      `an axis tick must never carry a decimal point: ${out}`);
  }
  // The other units are whole too.
  assert.equal(formatAxisTick(3.45, "years"), "3");
  assert.equal(formatAxisTick(84.12, "pct"), "84%");
  for (const u of ["years", "pct"] as const) {
    assert.ok(!formatAxisTick(1234.5678, u).includes("."));
  }
  // THE ROUND INTERVAL, on the fixture's own realistic range: the battery NPVs
  // run -3832.69 … +2867.22, so the ladder picks 2000 and the domain snaps
  // outward to it, with zero present because the measure is a delta.
  const ticks = niceAxisTicks(-3832.69, 2867.22, true);
  assert.deepEqual(ticks, [-4000, -2000, 0, 2000, 4000],
    "round intervals, not recharts' 3202.2155");
  assert.ok(ticks.includes(0), "the delta measure's base is on the axis");
  for (const t of ticks) {
    assert.ok(!formatAxisTick(t, "aud").includes("."), String(t));
  }
});

test("4d-V2: two products at the SAME capacity are two distinct bars, neither dropped nor merged", () => {
  const view = scoreCurveView(REAL_BATTERY_JOB);
  assert.ok(view.bars, `no bars: ${view.note}`);
  const at128 = view.bars!.filter((b) => b.subLabel === "12.8 kWh");
  assert.equal(at128.length, 2,
    "both 12.8 kWh products must survive — merging them is the fault the line hid");
  assert.notEqual(at128[0].label, at128[1].label, "distinct product labels");
  assert.deepEqual(
    at128.map((b) => b.label).sort(),
    ["BYD Battery-Box Premium HVS 12.8", "Sungrow SBR128"],
  );
  assert.notEqual(at128[0].value, at128[1].value,
    "their values genuinely differ — 2344.42 vs 669.83");
  assert.notEqual(at128[0].key, at128[1].key, "distinct react keys");
  // THE PRODUCT identifies the bar; capacity is the second line.
  const goodwe = view.bars!.find((b) => b.label === "GoodWe Lynx Home F");
  assert.equal(goodwe?.subLabel, "9.83 kWh");
  // Ordered by size so the progression still reads.
  const sizes = view.bars!.map((b) => Number((b.subLabel ?? "0").replace(" kWh", "")));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), "ordered by size");
});

test("4d-V3: the no-battery option is the BASELINE, flagged, and never emitted as a bar", () => {
  const view = scoreCurveView(REAL_BATTERY_JOB);
  assert.ok(view.baseline, "the do-nothing option is carried as the baseline");
  assert.equal(view.baseline!.isBaseline, true);
  assert.equal(view.baseline!.label, "No battery",
    "the reference line is named for the option, not \"0 kWh\"");
  assert.equal(view.baseline!.value, 0, "zero by construction on a delta measure");
  assert.equal(view.bars!.length, 6, "seven stored points, six bars — the baseline is not one");
  assert.ok(view.bars!.every((b) => !b.isBaseline),
    "no bar carries the baseline flag");
  assert.ok(view.bars!.every((b) => b.value !== 0 || b.label !== "No battery"),
    "a zero-height bar would be invisible and say nothing");
});

test("4d-V4: the chosen flag — resolved for solar by chosen_index, NOTHING on a battery tie", () => {
  const solar = scoreCurveView({
    sizing_results: [{
      sizing_result_id: "s1", run_kind: "solar", objective_used: "max_npv",
      evaluated_options: {
        dimension_keys: ["solar_kw"],
        chosen_index: 4,
        points: [
          { solar_kw: 0, npv_25yr: 0 },
          { solar_kw: 1.32, npv_25yr: 8397.6 },
          { solar_kw: 4.84, npv_25yr: 14500.09 },
          { solar_kw: 8.36, npv_25yr: 16925.06 },
          { solar_kw: 9.24, npv_25yr: 17068.33, panel_count: 21 },
          { solar_kw: 10.12, npv_25yr: 17039.91 },
        ],
      },
    }],
    financial_results: [{ sizing_result_id: "s1" }],
  });
  const chosenSolar = solar.bars!.filter((b) => b.chosen);
  assert.equal(chosenSolar.length, 1, "exactly one chosen bar");
  assert.equal(chosenSolar[0].label, "9.24 kW");
  assert.equal(solar.chosenNote, null);
  // A DELIBERATE TIE on capacity AND cost: mark none, and say why.
  const tie = JSON.parse(JSON.stringify(REAL_BATTERY_JOB));
  tie.sizing_results[0].evaluated_options.points.push({
    model: "Impostor 9.83", usable_kwh: 9.83, incremental_npv: 999,
    system_cost: 11868.77,
  });
  const tied = scoreCurveView(tie);
  assert.ok(tied.bars!.every((b) => !b.chosen), "a tie marks NOTHING rather than guessing");
  assert.match(tied.chosenNote ?? "", /tie/);
  // The live solar rows carry NO chosen_index at all (they predate 3.13-1) —
  // that must resolve to no emphasis and an honest line, not a wrong bar.
  const noIndex = scoreCurveView({
    sizing_results: [{
      sizing_result_id: "s1", run_kind: "solar", objective_used: "max_npv",
      evaluated_options: {
        dimension_keys: ["solar_kw"],
        points: [
          { solar_kw: 0, npv_25yr: 0 },
          { solar_kw: 9.24, npv_25yr: 17068.33 },
          { solar_kw: 10.12, npv_25yr: 17039.91 },
        ],
      },
    }],
  });
  assert.ok(noIndex.bars!.every((b) => !b.chosen));
  assert.match(noIndex.chosenNote ?? "", /did not record which option/);
});

test("4d-V5: the base comes from the OBJECTIVE — max_npv centres on zero, min_payback does not", () => {
  const npv = scoreCurveView(REAL_BATTERY_JOB);
  assert.equal(npv.zeroCentred, true,
    "a delta against doing nothing: zero is a real centre and bars sit either side");
  assert.ok(npv.bars!.some((b) => b.value < 0), "the Tesla is genuinely negative");
  assert.equal(npv.unit, "aud");
  assert.match(npv.valueLabel, /NPV/);

  // THE SAME POINTS, scored on payback: zero is NOT a centre. This assertion
  // fails the moment the code hardcodes the NPV treatment.
  const payback = JSON.parse(JSON.stringify(REAL_BATTERY_JOB));
  payback.sizing_results[0].objective_used = "min_payback";
  for (const [i, p] of payback.sizing_results[0].evaluated_options.points.entries()) {
    p.incremental_payback_years = i === 0 ? null : 6 + i;
  }
  const pb = scoreCurveView(payback);
  assert.equal(pb.zeroCentred, false,
    "a duration has an origin, not a centre — doing nothing has no payback at all");
  assert.equal(pb.unit, "years");
  assert.match(pb.valueLabel, /years/);
  assert.match(pb.baselineNote ?? "", /no payback/,
    "and the missing reference is stated, not silently drawn at zero");

  // Self-sufficiency: the baseline has a REAL non-zero value, so the line sits
  // there and zero is not the centre.
  const ss = JSON.parse(JSON.stringify(REAL_BATTERY_JOB));
  ss.sizing_results[0].objective_used = "max_self_sufficiency";
  for (const [i, p] of ss.sizing_results[0].evaluated_options.points.entries()) {
    p.self_sufficiency_pct = i === 0 ? 44.61 : 70 + i;
  }
  const sv = scoreCurveView(ss);
  assert.equal(sv.zeroCentred, false);
  assert.equal(sv.unit, "pct");
  assert.equal(sv.baseline!.value, 44.61);
  assert.match(sv.baselineNote ?? "", /45%/,
    "the line is labelled with what doing nothing already achieves");

  // An objective the code does not know: plainly labelled, NEVER zero-centred.
  const unknown = JSON.parse(JSON.stringify(REAL_BATTERY_JOB));
  unknown.sizing_results[0].objective_used = "banana";
  for (const p of unknown.sizing_results[0].evaluated_options.points) p.score = 1;
  const uv = scoreCurveView(unknown);
  assert.equal(uv.zeroCentred, false, "never silently treated as NPV");
});

test("4d-V6: totals — empty points, one option, junk, a missing objective", () => {
  const shell = (evaluated: unknown, objective: unknown = "max_npv") => ({
    sizing_results: [{ sizing_result_id: "s1", run_kind: "solar_battery",
      objective_used: objective, evaluated_options: evaluated }],
    financial_results: [{ sizing_result_id: "s1" }],
  });
  for (const evaluated of [
    undefined,
    { dimension_keys: ["battery_id"], points: [] },
    // Only the baseline: no options to compare.
    { dimension_keys: ["battery_id"], points: [{ model: "No battery", usable_kwh: 0, incremental_npv: 0 }] },
    { dimension_keys: ["battery_id"], points: "junk" },
    { points: [{ usable_kwh: 1, incremental_npv: 1 }] },
    { dimension_keys: ["something_else"], points: [{ x: 1 }] },
  ]) {
    const v = scoreCurveView(shell(evaluated));
    assert.equal(v.bars, null, `expected no chart for ${JSON.stringify(evaluated)}`);
    assert.ok(v.note, "an honest line, never an empty axis");
    assert.equal(v.ticks, null);
  }
  // A missing objective still draws, plainly labelled — never nothing, never NPV.
  const noObjective = scoreCurveView(shell({
    dimension_keys: ["battery_id"],
    points: [
      { model: "No battery", usable_kwh: 0, score: 0 },
      { model: "A", usable_kwh: 10, score: 0.4 },
      { model: "B", usable_kwh: 12, score: 0.9 },
    ],
  }, null));
  assert.ok(noObjective.bars, "values still draw");
  assert.equal(noObjective.zeroCentred, false);
  // A point with no product name: capacity carries it, and it SAYS so.
  const unnamed = scoreCurveView(shell({
    dimension_keys: ["battery_id"],
    points: [
      { model: "No battery", usable_kwh: 0, incremental_npv: 0 },
      { usable_kwh: 10, incremental_npv: 500 },
      { model: "", usable_kwh: 12, incremental_npv: 900 },
    ],
  }));
  assert.equal(unnamed.bars!.length, 2);
  assert.deepEqual(unnamed.bars!.map((b) => b.label), ["10 kWh", "12 kWh"]);
  assert.ok(unnamed.bars!.every((b) => b.labelNote !== null),
    "an unnamed product says so — never a made-up label");
  for (const junk of [null, undefined, 0, "x", [], {}]) {
    assert.doesNotThrow(() => scoreCurveView(junk));
    assert.equal(scoreCurveView(junk).bars, null);
  }
});

test("4d-V7: NO LINE MARK REMAINS in the chart component — a chart that joins the dots is the fault", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/results/score-curve.tsx"),
    "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["<Line", "LineChart", "ReferenceDot", "recharts-line"]) {
    assert.ok(!code.includes(forbidden),
      `the component still carries ${forbidden} — the bars must not be joined`);
  }
  assert.ok(code.includes("<Bar"), "bars are the mark");
  assert.ok(code.includes("<ReferenceLine"), "the baseline is a reference line");
  assert.ok(code.includes("<Cell"), "per-bar emphasis");
});


// ── 3.13-4b test 5: THE CHART IS MEASURED ON WHAT IT RENDERS ─────────────────
//
// The August all-black chart passed its check because the check measured the
// TOKEN, not what the browser rendered — `hsl(hsl(...))` is invalid and SVG
// silently falls back to black. Recharts v3 dispatches its chart size in a
// useEffect (node_modules/recharts/es6/context/chartLayoutContext.js), so NO
// static render of the full chart can ever emit the SVG — that is a recharts
// limitation, not a choice. The honest achievable measurement, in two halves
// that together cover the whole colour path:
//   (1) a real SVG rendered through the REAL useChartDefaults hook chain
//       (chart-tokens -> wrap -> chart-container defaults -> attribute) —
//       the exact strings recharts passes through verbatim as attributes;
//   (2) a source-level lock on the last hop: score-curve.tsx contains no
//       hsl( literal at all, so it CANNOT wrap what the hook hands it.

// ── Test harness: mount a real .tsx component (3.13-4b, shared at 4d) ────────
//
// Node cannot strip JSX, so the component is transpiled with the project's own
// `typescript` package and loaded with a tiny CommonJS shim. ONE definition,
// two readers — the bar-fill colour probe and the switch checks — because a
// second copy of a harness drifts exactly like a second copy of anything else.
async function loadFrontendModule(rel: string): Promise<Record<string, unknown>> {
  const [{ default: ts }, nodeModule, fs, path] = await Promise.all([
    import("typescript"),
    import("node:module"),
    import("node:fs"),
    import("node:path"),
  ]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const projectRequire = nodeModule.createRequire(path.join(FRONTEND, "package.json"));
  const cache = new Map<string, Record<string, unknown>>();
  const resolveTs = (base: string): string => {
    for (const ext of ["", ".ts", ".tsx"]) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`cannot resolve ${base}`);
  };
  const loadTs = (file: string): Record<string, unknown> => {
    const full = path.resolve(file);
    const hit = cache.get(full);
    if (hit) return hit;
    const js = ts.transpileModule(fs.readFileSync(full, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    const req = (spec: string): unknown => {
      if (spec === "next-themes") {
        // Third-party theme hook only — outside a provider it reports no theme
        // either way; the tokens hook then serves its SSR fallback, which is
        // the app's own first-render path. The COLOUR path under test is ours.
        return { useTheme: () => ({ resolvedTheme: "dark" }) };
      }
      if (spec.startsWith("@/")) return loadTs(resolveTs(path.join(FRONTEND, spec.slice(2))));
      if (spec.startsWith(".")) return loadTs(resolveTs(path.resolve(path.dirname(full), spec)));
      return projectRequire(spec);
    };
    cache.set(full, mod.exports);
    new Function("require", "module", "exports", js)(req, mod, mod.exports);
    return mod.exports;
  };
  return loadTs(resolveTs(path.join(FRONTEND, rel)));
}

test("4d-V9: the Switch — role, aria-checked, keyboard, and disabled while saving", async () => {
  const [React, ReactDOMServer, fs, path] = await Promise.all([
    import("react"),
    import("react-dom/server"),
    import("node:fs"),
    import("node:path"),
  ]);
  const mod = await loadFrontendModule("components/ui/switch.tsx");
  const Switch = mod.Switch as (props: Record<string, unknown>) => {
    type: unknown;
    props: Record<string, unknown>;
  };

  // (a) THE ANNOUNCEMENT, on the rendered markup. The control this replaces
  // was an <input type="checkbox" role="switch">, which already announced
  // correctly — this proves that did NOT regress.
  const off = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Switch as never, {
      checked: false, onChange: () => {}, label: "Show return on investment",
    } as never),
  );
  assert.match(off, /role="switch"/);
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /aria-label="Show return on investment"/);
  assert.match(off, /type="button"/,
    "a native button is what gives Space AND Enter for free");
  // The ATTRIBUTE, not the substring — the className legitimately carries
  // Tailwind's `disabled:` variants.
  assert.ok(!/disabled=""/.test(off), "not disabled unless asked");
  const on = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Switch as never, {
      checked: true, onChange: () => {}, label: "x",
    } as never),
  );
  assert.match(on, /aria-checked="true"/);

  // (b) DISABLED WHILE SAVING — the rendered attribute, not the prop.
  const saving = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Switch as never, {
      checked: false, onChange: () => {}, label: "x", disabled: true,
    } as never),
  );
  assert.match(saving, /disabled=""/);

  // (c) THE TOGGLE ITSELF: call the very handler the button carries. Both
  // Space and Enter fire a native button's click, so this IS the code path
  // both keys take — asserted by invoking it, not by trusting it.
  const seen: boolean[] = [];
  const el = Switch({ checked: false, onChange: (n: boolean) => seen.push(n), label: "x" });
  assert.equal(el.type, "button", "the element is a native button");
  (el.props.onClick as () => void)();
  const elOn = Switch({ checked: true, onChange: (n: boolean) => seen.push(n), label: "x" });
  (elOn.props.onClick as () => void)();
  assert.deepEqual(seen, [true, false], "off toggles on, on toggles off");

  // (d) NOTHING INTERCEPTS THE KEYS. An onKeyDown handling Space/Enter would
  // double-fire against the native button (Enter on keydown, Space on keyup),
  // so its ABSENCE is what keeps both keys working exactly once.
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/ui/switch.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("onKeyDown"),
    "no key handler may intercept the native button's Space/Enter");
  assert.ok(code.includes("motion-reduce:transition-none"),
    "the slide stops under motion-reduce — the state is carried by position and fill");
  assert.ok(code.includes("focus-visible:shadow-focus-ring"),
    "the project's focus ring, not a reimplementation");
  assert.ok(!/hsl\(|#[0-9a-fA-F]{3,8}\b/.test(code),
    "existing tokens only — no colour added");

  // (e) THE TAB USES IT, and no checkbox remains.
  const tab = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/results/results-tab.tsx"), "utf8");
  assert.ok(tab.includes("<Switch"), "the tab renders the standard Switch");
  assert.ok(!tab.includes('type="checkbox"'), "the checkbox is gone");
  assert.ok(tab.includes("disabled={saving}"), "disabled while the save is in flight");
});

test("4d-V8: the emphasised and recessive bar fills land in a real SVG as exactly one hsl(...) each", async () => {
  const [{ default: ts }, nodeModule, fs, path, React, ReactDOMServer] =
    await Promise.all([
      import("typescript"),
      import("node:module"),
      import("node:fs"),
      import("node:path"),
      import("react"),
      import("react-dom/server"),
    ]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const projectRequire = nodeModule.createRequire(
    path.join(FRONTEND, "package.json"),
  );
  const cache = new Map<string, Record<string, unknown>>();
  const resolveTs = (base: string): string => {
    for (const ext of ["", ".ts", ".tsx"]) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    throw new Error(`cannot resolve ${base}`);
  };
  const loadTs = (file: string): Record<string, unknown> => {
    const full = path.resolve(file);
    const hit = cache.get(full);
    if (hit) return hit;
    const js = ts.transpileModule(fs.readFileSync(full, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    const req = (spec: string): unknown => {
      if (spec === "next-themes") {
        // Third-party theme hook only — outside a provider it reports no
        // theme either way; the tokens hook then serves its SSR fallback,
        // which is the app's own first-render path. The COLOUR path under
        // test is entirely ours.
        return { useTheme: () => ({ resolvedTheme: "dark" }) };
      }
      if (spec.startsWith("@/")) {
        return loadTs(resolveTs(path.join(FRONTEND, spec.slice(2))));
      }
      if (spec.startsWith(".")) {
        return loadTs(resolveTs(path.resolve(path.dirname(full), spec)));
      }
      return projectRequire(spec);
    };
    cache.set(full, mod.exports);
    new Function("require", "module", "exports", js)(req, mod, mod.exports);
    return mod.exports;
  };

  // (1) The REAL hook chain, transpiled from the real .tsx, feeding a real
  // rendered SVG — the same strings recharts passes through as attributes.
  const container = loadTs(
    path.join(FRONTEND, "components/charts/chart-container.tsx"),
  );
  const useChartDefaults = container.useChartDefaults as () => {
    series: string[];
    tokens: Record<string, string>;
    byRole: Record<string, string>;
  };
  // The EMPHASIS PAIR, through the real hook chain, rendered as the very
  // `fill` attributes the bars carry. recharts v3 dispatches its chart size
  // from a useEffect, so no static render of the chart itself emits the SVG —
  // this renders the same expressions the Cells use, and the source lock
  // below proves the component passes them through untouched.
  function Probe(): unknown {
    const d = useChartDefaults();
    return React.createElement(
      "svg",
      null,
      // the chosen bar, then a recessive one — the two roles 4d added
      React.createElement("rect", { fill: d.byRole.chosenEmphasis }),
      React.createElement("rect", { fill: d.byRole.alternative }),
      React.createElement("path", { stroke: d.tokens["chart-baseline"] }),
      React.createElement("path", { stroke: d.tokens["chart-axis"] }),
    );
  }
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Probe as never),
  );
  assert.ok(html.includes("<svg"), html.slice(0, 120));
  const fills = html.match(/fill="[^"]*"/g) ?? [];
  const strokes = html.match(/stroke="[^"]*"/g) ?? [];
  assert.equal(fills.length, 2, `expected the two bar fills: ${fills}`);
  assert.notEqual(fills[0], fills[1],
    "emphasis and recessive must actually differ on screen");
  for (const attr of [...fills, ...strokes]) {
    const count = (attr.match(/hsl\(/g) ?? []).length;
    assert.equal(count, 1,
      `RENDERED attribute must contain exactly one hsl( — got ${attr} (hsl(hsl( renders BLACK)`);
  }
  assert.ok(!html.includes("hsl(hsl("), "double-wrap landed in the SVG");

  // (2) The last hop cannot wrap: score-curve.tsx passes the hook's strings
  // verbatim and contains no hsl( literal with which to wrap them.
  const curveSrc = fs.readFileSync(
    path.join(FRONTEND, "components/results/score-curve.tsx"),
    "utf8",
  );
  const curveCode = curveSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!curveCode.includes("hsl("),
    "score-curve.tsx CODE must not contain an hsl( literal — the tokens arrive already wrapped (the docstring may name the fault; the code may not)");
  assert.ok(
    curveCode.includes("bar.chosen ? d.byRole.chosenEmphasis : d.byRole.alternative"),
    "the Cell fill IS the hook's role string, verbatim — nothing wraps it");
});

// ── 3.13 prompt 4c: the D34 ROI figures (V1-V3) ──────────────────────────────

test("V1: roiFigures — always ALL THREE, smallest-first order, no divisions by zero", () => {
  const healthy = roiFigures({
    system_capex: 11868.77, annual_savings: 2689.6,
    npv_25_year: 19935.55, undiscounted_savings_25yr: 71234.5,
  });
  assert.equal(healthy.length, 3, "no code path can produce fewer than three");
  assert.deepEqual(healthy.map((f) => f.key), ["annual", "discounted", "total"],
    "the ORDER is annual, discounted, total — the page must not open on its biggest number");
  assert.equal(healthy[0].value, "23%");
  assert.equal(healthy[1].value, "168%");
  assert.equal(healthy[2].value, "500%");
  // capex zero / null / negative: all three unavailable, nothing thrown.
  for (const capex of [0, null, -5, "junk"]) {
    const out = roiFigures({ system_capex: capex, annual_savings: 1000,
      npv_25_year: 1000, undiscounted_savings_25yr: 1000 });
    assert.equal(out.length, 3);
    assert.ok(out.every((f) => f.value === null),
      `capex ${capex}: every figure must be unavailable`);
    assert.ok(out.every((f) => !`${f.value}`.includes("Infinity")));
  }
  // null NPV: the other two still render; null undiscounted (the three rows
  // already stored): the total is unavailable and NEVER savings x 25.
  const noUnd = roiFigures({ system_capex: 10000, annual_savings: 2000,
    npv_25_year: 15000, undiscounted_savings_25yr: null });
  assert.equal(noUnd[0].value, "20%");
  assert.equal(noUnd[1].value, "150%");
  assert.equal(noUnd[2].value, null,
    "null undiscounted -> unavailable, never annual_savings x 25 (the figure D34 rejected)");
  assert.equal(roiFigures(null).every((f) => f.value === null), true);
});

test("V2: the toggle state — off unless the job says boolean true; view carries all three", () => {
  const base = {
    sizing_results: [{ sizing_result_id: "s1", solar_kw: 9.24 }],
    financial_results: [{ sizing_result_id: "s1", system_capex: 10000,
      annual_savings: 2000, npv_25_year: 15000,
      undiscounted_savings_25yr: 60000 }],
  };
  assert.equal(resultsTabView({ ...base, show_roi: true }).showRoi, true);
  // Anything that is not boolean true is OFF — off is the safe state; the
  // string "true"/"false" trap equipment_confirmed documents.
  for (const junk of [false, undefined, null, "true", "false", 1]) {
    assert.equal(resultsTabView({ ...base, show_roi: junk }).showRoi, false,
      `show_roi ${JSON.stringify(junk)} must be OFF`);
  }
  const view = resultsTabView({ ...base, show_roi: true });
  assert.equal(view.roi.length, 3);
  assert.deepEqual(view.roi.map((f) => f.key), ["annual", "discounted", "total"]);
});

test("V3: the explanation strings are lib's own, and the component declares none", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  // The strings exist, exported, one per figure, and the figures carry them.
  assert.ok(ROI_EXPLANATIONS.annual.includes("ignores panel degradation"));
  assert.ok(ROI_EXPLANATIONS.discounted.includes("worth less than today's"));
  assert.ok(ROI_EXPLANATIONS.total.includes("says the least"));
  const figs = roiFigures({ system_capex: 1, annual_savings: 1,
    npv_25_year: 1, undiscounted_savings_25yr: 2 });
  assert.equal(figs[0].explanation, ROI_EXPLANATIONS.annual);
  assert.equal(figs[1].explanation, ROI_EXPLANATIONS.discounted);
  assert.equal(figs[2].explanation, ROI_EXPLANATIONS.total);
  // The component imports nothing of the sort and declares no second copy —
  // it renders figure.explanation, which IS the lib string (8.1 prints the
  // same words; two copies would drift within a month).
  const tabSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/results/results-tab.tsx"),
    "utf8");
  assert.ok(tabSrc.includes("{figure.explanation}"),
    "the component renders the lib string carried on the figure");
  for (const fragment of ["ignores panel degradation", "worth less than today's", "says the least"]) {
    assert.ok(!tabSrc.includes(fragment),
      `the component must not declare its own copy of: ${fragment}`);
  }
  // OFF renders nothing and ON renders the fixed triple through ONE map —
  // no per-figure conditional, no slice, no filter on view.roi.
  assert.ok(tabSrc.includes("view.showRoi ? ("),
    "the whole panel is behind the toggle");
  assert.equal((tabSrc.match(/view\.roi/g) ?? []).length, 1,
    "view.roi is consumed exactly once — by the one map");
  assert.ok(tabSrc.includes("view.roi.map("), "one map over the fixed triple");
  assert.ok(!/view\.roi\.(slice|filter|find)\(/.test(tabSrc),
    "no code path can render a subset of the three");
});

// ── 3.13 prompt 4e: the chart's space is DERIVED, not guessed (4e-W1 … W4) ──
//
// The fault: a hardcoded 172px axis sliced two real product names on screen.
// No static render emits a laid-out SVG, so a clipped label is invisible to
// this suite — the one computable thing is the REQUIREMENT, asserted here.

/** The two labels that were actually clipped, verbatim from the live run. */
const CLIPPED_LABELS = [
  { label: "Sigenergy SigenStor Sigen Battery 8.0", subLabel: "7.8 kWh" },
  { label: "BYD Battery-Box Premium HVS 12.8", subLabel: "12.8 kWh" },
  { label: "GoodWe Lynx Home F", subLabel: "9.83 kWh" },
  { label: "Tesla Powerwall 3", subLabel: "13.5 kWh" },
];

test("4e-W1: the axis width is a FUNCTION OF THE LABELS — a hardcoded width cannot pass this", () => {
  const long = scoreCurveAxisSpace(CLIPPED_LABELS, "No battery");
  const short = scoreCurveAxisSpace(
    [{ label: "7.8 kWh", subLabel: null }, { label: "20 kWh", subLabel: null }],
    "No battery",
  );
  assert.ok(long.axisWidth > short.axisWidth,
    `the real clipped labels must need MORE room than short ones: ${long.axisWidth} vs ${short.axisWidth}`);
  // The width the fault shipped with. The longest real label is 37 characters
  // at 12px — it cannot fit in 172px, which is exactly why it was sliced.
  assert.ok(long.axisWidth > 172,
    `172px is what clipped "Sigenergy SigenStor Sigen Battery 8.0": got ${long.axisWidth}`);
  // Growing a name grows the axis, with nobody touching the component.
  const longer = scoreCurveAxisSpace(
    [...CLIPPED_LABELS, { label: "A Much Longer Product Name Than Any Of These", subLabel: "30 kWh" }],
    "No battery",
  );
  assert.ok(longer.axisWidth > long.axisWidth,
    `a longer name must widen the axis: ${longer.axisWidth} vs ${long.axisWidth}`);
  // And the capacity line counts too — it is drawn in the same column.
  const wideSub = scoreCurveAxisSpace(
    [{ label: "A", subLabel: "1234567890 1234567890 1234567890 kWh" }], null);
  assert.ok(wideSub.axisWidth > scoreCurveAxisSpace([{ label: "A", subLabel: "1 kWh" }], null).axisWidth,
    "the second line is measured, not ignored");
});

test("4e-W2: beyond the cap a label is truncated with an ellipsis, and the full text survives for the tooltip", () => {
  const monster = "X".repeat(400);
  const space = scoreCurveAxisSpace([{ label: monster, subLabel: "9 kWh" }], null);
  assert.ok(space.axisWidth <= Math.floor(SCORE_CURVE_AXIS.assumedChartWidth * SCORE_CURVE_AXIS.maxFraction),
    `the axis must never eat more than its share: ${space.axisWidth}`);
  const shown = truncateLabel(monster, space.maxChars);
  assert.ok(shown.length < monster.length, "it is shortened");
  assert.ok(shown.endsWith("…"), `an ellipsis says so: ${shown.slice(-6)}`);
  assert.equal(shown.length, space.maxChars, "trimmed to exactly the budget");
  // THE FULL NAME IS STILL THE CATEGORY VALUE, which is what the tooltip
  // renders — the component looks its bar up by the full label and truncates
  // only for drawing.
  const view = scoreCurveView({
    sizing_results: [{
      sizing_result_id: "s1", run_kind: "solar_battery", objective_used: "max_npv",
      battery_kwh: 10, system_cost: 1,
      evaluated_options: {
        dimension_keys: ["battery_id"],
        points: [
          { model: "No battery", usable_kwh: 0, incremental_npv: 0 },
          { model: monster, usable_kwh: 10, incremental_npv: 500, system_cost: 1 },
        ],
      },
    }],
    financial_results: [{ sizing_result_id: "s1" }],
  });
  assert.equal(view.bars![0].label, monster,
    "the view keeps the FULL name — truncation is a drawing concern, not a data one");
  // A short label is never touched.
  assert.equal(truncateLabel("GoodWe Lynx Home F", 40), "GoodWe Lynx Home F");
});

test("4e-W3: totals — empty, single, whitespace-only, and non-string labels never yield a bad width", () => {
  const cases: Parameters<typeof scoreCurveAxisSpace>[0][] = [
    [],
    null,
    undefined,
    [{ label: "One only", subLabel: null }],
    [{ label: "   ", subLabel: "   " }],
    [{ label: "" }],
    // Non-strings arriving from junk jsonb.
    [{ label: 42 as unknown as string, subLabel: {} as unknown as string }],
    [{ label: null as unknown as string }],
  ];
  for (const bars of cases) {
    const space = scoreCurveAxisSpace(bars, "No battery");
    assert.ok(Number.isFinite(space.axisWidth) && space.axisWidth > 0,
      `width must be a positive number, got ${space.axisWidth} for ${JSON.stringify(bars)}`);
    assert.ok(space.axisWidth >= SCORE_CURVE_AXIS.minWidth, "never below the floor");
    assert.ok(Number.isFinite(space.topSpace) && space.topSpace > 0);
    assert.ok(Number.isInteger(space.maxChars) && space.maxChars >= 4);
    assert.doesNotThrow(() => truncateLabel(undefined, space.maxChars));
  }
  // A silly chart width cannot produce a silly axis.
  for (const width of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const space = scoreCurveAxisSpace(CLIPPED_LABELS, "No battery", width);
    assert.ok(space.axisWidth > 0 && Number.isFinite(space.axisWidth), String(width));
  }
  // truncateLabel with a nonsense budget still returns a string.
  for (const n of [0, -5, Number.NaN, 1]) {
    assert.equal(typeof truncateLabel("abcdef", n), "string");
  }
});

test("4e-W4: the reference label gets top space whenever there is one to clear", () => {
  const withLabel = scoreCurveAxisSpace(CLIPPED_LABELS, "No battery");
  const without = scoreCurveAxisSpace(CLIPPED_LABELS, null);
  assert.ok(withLabel.topSpace > 0, "the 'No battery' label was clipped at the top before 4e");
  assert.ok(withLabel.topSpace > without.topSpace,
    `a reference label needs MORE top room than none: ${withLabel.topSpace} vs ${without.topSpace}`);
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(scoreCurveAxisSpace(CLIPPED_LABELS, empty).topSpace, without.topSpace,
      "an empty label is no label");
  }
  // The live run's own baseline label is a real one.
  assert.ok(scoreCurveAxisSpace(CLIPPED_LABELS, "No solar").topSpace > 0);
});

test("4e-W5: the component consumes the derived space — no hardcoded axis width or top margin", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/results/score-curve.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("scoreCurveAxisSpace("), "the width comes from lib");
  assert.ok(code.includes("width={space.axisWidth}"), "the axis takes the derived width");
  assert.ok(code.includes("top: space.topSpace"), "the margin takes the derived top space");
  assert.ok(!/width=\{\d+\}/.test(code), "no hardcoded axis width may remain");
  assert.ok(code.includes("truncateLabel(bar.label, maxChars)"),
    "the tick truncates for drawing only");
  assert.ok(code.includes('dataKey="label"'),
    "the category value is the FULL label, so the tooltip shows the whole name");
  // The 4d correction must not regress: the axis title still sits below the
  // ticks, and the bottom margin still has room for both.
  assert.ok(code.includes('position: "insideBottom"') && code.includes("offset: -18"),
    "the axis title stays clear of the tick labels");
  assert.ok(code.includes("bottom: 28"), "the bottom margin still holds both");
});

// ── 3.13 prompt 4f: the chart and the table hover with ONE token (4f-X1…X4) ──
//
// The fault: table.tsx hovers a row with `hover:bg-accent`; the chart named no
// hover colour at all, so recharts painted its own default and the hovered bar
// went near-white. Two surfaces on one page, one choosing a token and the
// other choosing nothing.

/**
 * The token NAME each surface actually resolves, read from each source. Names,
 * never values: in dark mode `--accent` and `--chart-grid` happen to be the
 * same triplet, so a value comparison would pass by coincidence while the two
 * surfaces still named different things.
 */
async function hoverTokenNames(): Promise<{ table: string | null; chart: string | null }> {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const tableSrc = fs.readFileSync(path.join(FRONTEND, "components/ui/table.tsx"), "utf8");
  const chartTokensSrc = fs.readFileSync(path.join(FRONTEND, "lib/chart-tokens.ts"), "utf8");
  // The table's row hover, from the class it ships.
  const tableHit = /hover:bg-([a-z0-9-]+)/.exec(tableSrc);
  // The role the chart's hover band reads, from the helper that defines it.
  // The role may be wrapped (4g applies an alpha to it); what is compared is
  // still the TOKEN NAME it reads, never the resulting value.
  const chartHit = /hoverSurface:[^,\n]*tokens\["([a-z0-9-]+)"\]/.exec(chartTokensSrc);
  return { table: tableHit?.[1] ?? null, chart: chartHit?.[1] ?? null };
}

test("4f-X1: the chart's hover band and the table's row hover are THE SAME NAMED TOKEN", async () => {
  const { table, chart } = await hoverTokenNames();
  console.log(`        table.tsx hover:bg-${table}  ·  chart hoverSurface -> tokens["${chart}"]`);
  assert.ok(table, "could not read the table's hover token — the reference side must be readable");
  assert.ok(chart, "could not read the chart's hover role");
  assert.equal(chart, table,
    `the chart hovers with "${chart}" while the table hovers with "${table}" — ` +
    "two surfaces on one page must not choose differently");
});

test("4f/4g-X2: the hover band RENDERED — exactly one hsl(, and TRANSLUCENT so the gridlines survive", async () => {
  const [React, ReactDOMServer] = await Promise.all([
    import("react"), import("react-dom/server"),
  ]);
  const container = await loadFrontendModule("components/charts/chart-container.tsx");
  const useChartDefaults = container.useChartDefaults as () => {
    byRole: Record<string, string>;
  };
  function Probe(): unknown {
    const d = useChartDefaults();
    // The very expression the chart hands to the cursor.
    return React.createElement(
      "svg", null,
      React.createElement("rect", { fill: d.byRole.hoverSurface }),
    );
  }
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Probe as never));
  const fill = (html.match(/fill="[^"]*"/g) ?? [])[0] ?? "";
  console.log(`        rendered hover band: ${fill}`);
  assert.ok(fill.includes("hsl("), `no colour landed: ${html}`);
  assert.equal((fill.match(/hsl\(/g) ?? []).length, 1,
    `hsl(hsl( renders BLACK — got ${fill}`);
  assert.ok(!html.includes("hsl(hsl("), "double-wrap landed in the SVG");

  // 4g — THE FINISH, and this is the assertion that would have caught the
  // opaque band before Mayur did. In dark mode `--accent` and `--chart-grid`
  // are the SAME triplet, so a SOLID band does not sit behind the gridlines,
  // it absorbs them. A chart cursor must be a translucent wash.
  const alphaHit = /hsl\([^)]*\/\s*([0-9.]+)\s*\)/.exec(fill);
  assert.ok(alphaHit, `the hover band must carry an alpha component: ${fill}`);
  const alpha = Number(alphaHit![1]);
  console.log(`        hover band alpha: ${alpha}`);
  assert.ok(Number.isFinite(alpha), `unreadable alpha: ${alphaHit![1]}`);
  assert.ok(alpha > 0,
    `an alpha of 0 is an invisible band: ${fill}`);
  assert.ok(alpha < 1,
    `an OPAQUE band erases the gridlines it is supposed to sit behind — ` +
    `dark-mode accent and chart-grid are the same triplet: ${fill}`);
});

test("4f-X3: the CHOSEN bar keeps its amber when hovered — only the band behind it changes", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "../components/results/score-curve.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The bar is never repainted on hover: activeBar is explicitly off, so the
  // resting fill IS the hovered fill. Without this, recharts may substitute an
  // active shape and the amber would not survive.
  assert.ok(/activeBar=\{false\}/.test(code),
    "activeBar={false} is what guarantees the mark keeps its own fill on hover");
  // And there is exactly ONE fill expression for the bars, so resting and
  // hovered are the same string by construction rather than by coincidence.
  const cellFills = code.match(/fill=\{bar\.chosen \? d\.byRole\.chosenEmphasis : d\.byRole\.alternative\}/g) ?? [];
  assert.equal(cellFills.length, 1, "one fill expression for the bars");
  assert.ok(!/activeBar=\{\{/.test(code), "no alternative hovered fill may be declared");
  // The band is a fill on the CURSOR, which recharts draws beneath the bars.
  assert.ok(/cursor=\{\{ fill: d\.byRole\.hoverSurface \}\}/.test(code),
    "the hover colour is the cursor band, not a repaint of the mark");
});

test("4f-X4: the hover token resolves in BOTH modes — no mode-specific value is introduced", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const { chart } = await hoverTokenNames();
  const globals = fs.readFileSync(path.join(FRONTEND, "app/globals.css"), "utf8");
  // The same variable is emitted under :root and under .dark — which is what
  // lets one token serve both surfaces in both modes, exactly as the table
  // already proves.
  const declarations = globals.match(new RegExp(`--${chart}:\\s*[^;]+;`, "g")) ?? [];
  console.log(`        --${chart} declared ${declarations.length}x: ${declarations.join("  ")}`);
  assert.ok(declarations.length >= 2,
    `--${chart} must be emitted in both modes, found ${declarations.length}`);
  // The chart helper reads it live and falls back to the DARK value, matching
  // every other token it carries — no separate light/dark branch in the chart.
  const tokensSrc = fs.readFileSync(path.join(FRONTEND, "lib/chart-tokens.ts"), "utf8");
  assert.ok(tokensSrc.includes(`read("${chart}")`),
    "the live value is read from the DOM, so the mode is whatever the page is in");
  assert.ok(new RegExp(`"${chart}":\\s*wrap\\(`).test(tokensSrc),
    "the fallback is wrapped exactly once, like every other role");
});


// ── 3.14 prompt 3 — the stored run REACHES THE SCREEN (F206), the fifth
// tile's three answers (F205), and D3's once-only auto-expand ───────────────

/**
 * A realistic stored SOLAR run — the shape routes/sizing.py's solar writer
 * persists: the row's own figures plus evaluated_options carrying the score
 * curve and the chosen marker.
 */
const SOLAR_CURVE_POINTS = [
  { solar_kw: 0, system_cost: 0, npv_25yr: 0, simple_payback_years: null,
    self_sufficiency_pct: 0, panel_count: 0, plane_indices: [], panels_per_plane: [] },
  { solar_kw: 9.24, system_cost: 7248, npv_25yr: 17068.33, simple_payback_years: 4.2,
    self_sufficiency_pct: 84.1, panel_count: 21, plane_indices: [0], panels_per_plane: [21] },
  { solar_kw: 10.12, system_cost: 7810, npv_25yr: 17039.91, simple_payback_years: 4.4,
    self_sufficiency_pct: 85.3, panel_count: 23, plane_indices: [0], panels_per_plane: [23] },
];

const STORED_SOLAR_RUN = {
  sizing_result_id: "s-solar",
  created_at: "2026-08-21T01:00:00Z",
  run_kind: "solar",
  solar_kw: 9.24,
  battery_kwh: null,
  system_cost: 7248,
  annual_solar_generation_kwh: 13820.4,
  within_budget: true,
  evaluated_options: {
    dimension_keys: ["solar_kw"],
    chosen_index: 1,
    points: SOLAR_CURVE_POINTS,
    dispatch_resolution: null,
  },
};

/** A realistic stored BATTERY run, carrying 3.14 prompt 2's chosen_index and
    solar_options as well as 3.13 prompt 3's split. */
const STORED_BATTERY_RUN = {
  sizing_result_id: "s-batt",
  created_at: "2026-08-21T02:00:00Z",
  run_kind: "solar_battery",
  solar_kw: 9.24,
  battery_kwh: 9.83,
  system_cost: 11868.77,
  annual_solar_generation_kwh: 13820.4,
  within_budget: false,
  evaluated_options: {
    dimension_keys: ["battery_id"],
    chosen_index: 1,
    points: [
      { usable_kwh: 0, model: "No battery", system_cost: 7248, battery_cost: 0,
        incremental_npv: 0, incremental_payback_years: null, self_sufficiency_pct: 30.45 },
      { battery_id: "b1", usable_kwh: 9.83, model: "GoodWe Lynx Home F",
        system_cost: 11868.77, battery_cost: 4620.77, incremental_npv: 2867.22,
        incremental_payback_years: 8.6, self_sufficiency_pct: 84.1 },
      { battery_id: "b2", usable_kwh: 13.5, model: "Tesla Powerwall",
        system_cost: 16000, battery_cost: 8752, incremental_npv: -900,
        incremental_payback_years: null, self_sufficiency_pct: 90.2 },
    ],
    chosen_solar: { solar_kw: 9.24, panel_count: 21, plane_indices: [0], panels_per_plane: [21] },
    solar_options: { dimension_keys: ["solar_kw"], chosen_index: 1, points: SOLAR_CURVE_POINTS },
    split: {
      solar_only: { annual_savings: 1800, npv_25yr: 17068.33,
                    simple_payback_years: 4.2, system_cost: 7248 },
      battery_increment: { annual_savings_vs_solar_only: 300, incremental_npv: 2867.22,
                           incremental_payback_years: 8.6, battery_cost: 4620.77 },
    },
    dispatch_resolution: "full_year",
  },
};

// 3a. THE F206 REGRESSION: a stored run and NO fresh reply renders the whole
// body. Every field the solar section's renderResult displays is asserted.
test("3.14-3 F206: a STORED solar run with no response carries the whole body", () => {
  const view = solarSizingView(emptyJob({ sizing_results: [STORED_SOLAR_RUN] }));
  assert.equal(view.alreadySized, true);
  const stored = view.storedRun;
  assert.ok(stored, "the stored run reaches the section — this is F206");
  // The reply's own shape, so the section has ONE rendering path.
  assert.equal(stored.run.ok, true);
  assert.equal(stored.run.needsRoofInput, false);
  assert.equal(stored.run.errorMessage, null);
  // Every headline field renderResult reads.
  assert.deepEqual(stored.run.headline, {
    solarKw: "9.24 kW",
    panelCount: "21 panels",
    annualGenerationKwh: "13,820 kWh",
    systemCost: "$7,248",
    payback: "4.2 yr",
    npv: "$17,068",
    selfSufficiencyPct: "84.1%",
  });
  // The options table, every column, with the winner marked from the marker.
  assert.equal(stored.run.options.length, 3);
  assert.deepEqual(stored.run.options[1], {
    label: "9.24 kW",
    cost: "$7,248",
    payback: "4.2 yr",
    npv: "$17,068",
    selfSufficiency: "84.1%",
    chosen: true,
  });
  assert.equal(stored.run.options[0].label, "No system",
    "the empty reference row is labelled, never 0 kW");
  assert.equal(stored.run.options.filter((o) => o.chosen).length, 1,
    "exactly one chosen row");
  assert.equal(stored.chosenNote, null, "a marked run says nothing about markers");
  assert.equal(stored.notRecordedNote, null, "this run recorded everything shown");
});

// 3b. The SAME for the battery section — and the solar section on a battery
// run reads that run's SOLAR half, never its battery candidates.
test("3.14-3 F206: a STORED battery run carries the whole body, both sections", () => {
  const job = emptyJob({ sizing_results: [STORED_BATTERY_RUN] });
  const battery = batterySizingView(job).storedRun;
  assert.ok(battery, "the battery section renders from the stored run");
  assert.deepEqual(battery.run.headline, {
    model: "GoodWe Lynx Home F",
    usableKwh: "9.83 kWh",
    batteryCost: "$4,621",
    systemCost: "$11,869",
    payback: "8.6 yr",
    npv: "$2,867",
    selfSufficiencyPct: "84.1%",
  });
  assert.equal(battery.run.noBattery, false);
  assert.deepEqual(battery.run.chosenSolar, {
    solarKw: "9.24 kW",
    annualGenerationKwh: "13,820 kWh",
    systemCostSolarOnly: "$7,248",
  });
  assert.equal(battery.run.options.length, 3);
  assert.deepEqual(battery.run.options[1], {
    label: "9.83 kWh",
    model: "GoodWe Lynx Home F",
    systemCost: "$11,869",
    payback: "8.6 yr",
    npv: "$2,867",
    selfSufficiency: "84.1%",
    chosen: true,
  });
  assert.equal(battery.run.options[0].label, "No battery",
    "the baseline is labelled, never 0 kWh");
  // The engine's own within_budget flag, READ from the row, never recomputed.
  assert.equal(battery.run.withinBudget, false);
  assert.equal(battery.chosenNote, null);

  // The SOLAR section on the same run: the solar curve, the solar-only cost —
  // not the battery candidates and not the whole-system cost.
  const solar = solarSizingView(job).storedRun;
  assert.ok(solar, "the solar section renders from a battery run too");
  assert.equal(solar.run.headline?.solarKw, "9.24 kW");
  assert.equal(solar.run.headline?.systemCost, "$7,248",
    "the SOLAR-ONLY cost from split.solar_only — never the row's whole-system $11,869");
  assert.equal(solar.run.headline?.panelCount, "21 panels");
  assert.equal(solar.run.headline?.selfSufficiencyPct, "84.1%");
  assert.equal(solar.run.options.length, 3);
  assert.deepEqual(solar.run.options.map((o) => o.label),
    ["No system", "9.24 kW", "10.12 kW"],
    "the SOLAR curve's rows — a battery candidate in this table would be the bug");
  assert.equal(solar.run.options[1].chosen, true);
});

// 3c. THE PAIR (2U.4): storedRun is non-null EXACTLY when alreadySized.
test("3.14-3: storedRun and alreadySized agree by construction, both sections", () => {
  const cases: JobDetailLike[] = [
    emptyJob({ sizing_results: [] }),
    emptyJob({ sizing_results: [STORED_SOLAR_RUN] }),
    emptyJob({ sizing_results: [STORED_BATTERY_RUN] }),
    emptyJob({ sizing_results: [{ solar_kw: null, battery_kwh: null }] }),
    emptyJob({ sizing_results: [{ solar_kw: 6.6, battery_kwh: 0 }] }),
    emptyJob(unsafe<Partial<JobDetailLike>>({ sizing_results: "nonsense" })),
  ];
  for (const job of cases) {
    const s = solarSizingView(job);
    assert.equal(s.storedRun !== null, s.alreadySized, "solar pair");
    const b = batterySizingView(job);
    assert.equal(b.storedRun !== null, b.alreadySized, "battery pair");
  }
  // Junk of every shape: total, never throws.
  for (const junk of [null, undefined, 42, "x", [], {}, { sizing_results: [null] }]) {
    assert.doesNotThrow(() => solarSizingView(junk));
    assert.doesNotThrow(() => batterySizingView(junk));
  }
});

// 3d. THE HONEST DEGRADATION (F195): a pre-marker run marks NOTHING and says so.
test("3.14-3 F195: a pre-marker stored run marks no chosen option and says so", () => {
  const preMarker = JSON.parse(JSON.stringify(STORED_SOLAR_RUN));
  delete preMarker.evaluated_options.chosen_index;
  const stored = solarSizingView(emptyJob({ sizing_results: [preMarker] })).storedRun;
  assert.ok(stored);
  // EVERY option still renders — the run's comparison is not hidden.
  assert.equal(stored.run.options.length, 3);
  assert.ok(stored.run.options.every((o) => !o.chosen),
    "not one row is flagged chosen — never inferred by matching numbers");
  assert.equal(stored.chosenNote, CHOSEN_NOT_RECORDED_NOTE);
  assert.match(stored.chosenNote ?? "", /did not record which option/);
  // And what else it could not state is named plainly, never substituted.
  assert.equal(stored.run.headline?.panelCount, null);
  assert.equal(stored.run.headline?.selfSufficiencyPct, "—");
  assert.match(stored.notRecordedNote ?? "", /panel count/);
  assert.match(stored.notRecordedNote ?? "", /self-sufficiency/);
  // A NEVER-RECORDED payback is an em-dash, NOT "no payback within the
  // analysis period" — that sentence is a MEANING and would be a substitution.
  assert.equal(stored.run.headline?.payback, "—");
  assert.match(stored.notRecordedNote ?? "", /the payback/);

  // The battery side degrades the same way.
  const preMarkerBattery = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  delete preMarkerBattery.evaluated_options.chosen_index;
  const b = batterySizingView(emptyJob({ sizing_results: [preMarkerBattery] })).storedRun;
  assert.ok(b);
  assert.equal(b.run.options.length, 3);
  assert.ok(b.run.options.every((o) => !o.chosen));
  assert.equal(b.chosenNote, CHOSEN_NOT_RECORDED_NOTE);
  // The stored SPLIT still supplies the incremental figures, so the headline
  // does not collapse just because the marker is missing.
  assert.equal(b.run.headline?.npv, "$2,867");
  assert.equal(b.run.headline?.payback, "8.6 yr");
  assert.equal(b.run.headline?.model, "—", "no marker, so no model is claimed");
});

// 3e. A no-battery stored run: the outcome shows, the engine's reason does not
// exist in storage and is named as not recorded rather than reworded.
test("3.14-3: a stored NO-BATTERY run says so, and admits the reason is unrecorded", () => {
  const none = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  none.battery_kwh = 0;
  none.system_cost = 7248;
  none.evaluated_options.chosen_index = 0;
  const stored = batterySizingView(emptyJob({ sizing_results: [none] })).storedRun;
  assert.ok(stored);
  assert.equal(stored.run.noBattery, true);
  assert.equal(stored.run.headline?.usableKwh, "No battery", "never \"0 kWh\"");
  assert.equal(stored.run.notEconomicReason, null,
    "not a stored column — the heading alone, never a reworded stand-in");
  assert.match(stored.notRecordedNote ?? "", /why no battery was recommended/);
});

// ── F205: the fifth tile's three answers, one test each ─────────────────────

const VALUE_ORIGIN_SOLAR_ONLY = emptyJob({
  sizing_results: [STORED_SOLAR_RUN],
});
const VALUE_ORIGIN_SPLIT = emptyJob({ sizing_results: [STORED_BATTERY_RUN] });
const VALUE_ORIGIN_PRE_SPLIT = emptyJob({
  sizing_results: [{
    sizing_result_id: "s-old", run_kind: "solar_battery",
    solar_kw: 6.6, battery_kwh: 13.5, system_cost: 20000,
    evaluated_options: { dimension_keys: ["battery_id"], points: [] },
  }],
});

test("3.14-3 F205 (i): a run with no battery in it says ALL SOLAR, in words", () => {
  const view = resultsBarView(VALUE_ORIGIN_SOLAR_ONLY);
  assert.equal(view.sized, true);
  assert.equal(view.valueOrigin.kind, "all-solar");
  assert.equal(view.valueOrigin.label, VALUE_ORIGIN_ALL_SOLAR_LABEL);
  // The point of F205: NOT a bare dash. An em-dash used as punctuation inside
  // a sentence is fine; a tile whose whole content is "—" is the defect.
  assert.notEqual(view.valueOrigin.label.trim(), "—");
  assert.ok(/[a-z]{3}/i.test(view.valueOrigin.label), "it says something in words");
  assert.match(view.valueOrigin.label, /solar/i);
});

test("3.14-3 F205 (ii): a recorded split shows both parts, content unchanged", () => {
  const view = resultsBarView(VALUE_ORIGIN_SPLIT);
  assert.equal(view.sized, true);
  assert.equal(view.valueOrigin.kind, "split");
  // 3.13's CONTENT, untouched — only the tile's LABEL moved.
  assert.equal(view.valueOrigin.label, "$17,068 + $2,867");
  assert.equal(
    view.valueOrigin.kind === "split" ? view.valueOrigin.solarNpv : null, 17068.33);
  assert.equal(
    view.valueOrigin.kind === "split" ? view.valueOrigin.batteryNpv : null, 2867.22);
});

test("3.14-3 F205 (iii): a battery run stored before the split says NOT RECORDED", () => {
  const view = resultsBarView(VALUE_ORIGIN_PRE_SPLIT);
  assert.equal(view.sized, true);
  assert.equal(view.valueOrigin.kind, "not-recorded");
  assert.equal(view.valueOrigin.label, VALUE_ORIGIN_NOT_RECORDED_LABEL);
  assert.notEqual(view.valueOrigin.label.trim(), "—");
  assert.ok(/[a-z]{3}/i.test(view.valueOrigin.label), "it says something in words");
  assert.match(view.valueOrigin.label, /not record/i);
});

test("3.14-3 F205: the three answers are three DIFFERENT outcomes, and a $0 "
  + "battery is NOT collapsed into all-solar", () => {
  const kinds = [VALUE_ORIGIN_SOLAR_ONLY, VALUE_ORIGIN_SPLIT, VALUE_ORIGIN_PRE_SPLIT]
    .map((job) => {
      const v = resultsBarView(job);
      return v.sized ? v.valueOrigin.kind : "unsized";
    });
  assert.deepEqual(kinds, ["all-solar", "split", "not-recorded"]);
  assert.equal(new Set(kinds).size, 3, "merge any two and this test is testing nothing");
  const labels = [VALUE_ORIGIN_SOLAR_ONLY, VALUE_ORIGIN_SPLIT, VALUE_ORIGIN_PRE_SPLIT]
    .map((job) => {
      const v = resultsBarView(job);
      return v.sized ? v.valueOrigin.label : "unsized";
    });
  console.log(`        all solar    : ${labels[0]}`);
  console.log(`        a split      : ${labels[1]}`);
  console.log(`        not recorded : ${labels[2]}`);
  assert.equal(new Set(labels).size, 3, "three answers, three different words");

  // THE DISTINCTION THAT MATTERS: a battery WAS evaluated and added $0. That
  // is a real answer and stays a split — never "no battery in this run".
  const zeroAdds = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  zeroAdds.battery_kwh = 0;
  zeroAdds.evaluated_options.split.battery_increment.incremental_npv = 0;
  const zeroView = resultsBarView(emptyJob({ sizing_results: [zeroAdds] }));
  assert.equal(zeroView.sized, true);
  assert.equal(zeroView.valueOrigin.kind, "split",
    "a battery considered and worth $0 is an ANSWER, not an absence");
  assert.equal(zeroView.valueOrigin.label, "$17,068 + $0");
  assert.notEqual(zeroView.valueOrigin.label, VALUE_ORIGIN_ALL_SOLAR_LABEL);
});

// ── D3's auto-expand, once per job ──────────────────────────────────────────

const SIZED_VIEW = resultsBarView(VALUE_ORIGIN_SPLIT);

test("3.14-3 D3: a sized job with no marker auto-expands ONCE, then never again", () => {
  assert.equal(SIZED_VIEW.sized, true);
  // First visit: no marker -> it opens itself.
  assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, "job-1", []), true);
  // The marker written by that visit.
  const marked = rememberAutoExpandedJob([], "job-1");
  assert.deepEqual(marked, ["job-1"]);
  // Second visit: the preference wins, whatever it says.
  assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, "job-1", marked), false);
  // A DIFFERENT job still gets its own first-result moment.
  assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, "job-2", marked), true);
  // Marking twice never duplicates and never re-opens.
  const twice = rememberAutoExpandedJob(marked, "job-1");
  assert.deepEqual(twice, ["job-1"]);
  assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, "job-1", twice), false);
});

test("3.14-3 D3: an UNSIZED job never auto-expands, and neither does a missing id", () => {
  assert.equal(shouldAutoExpandResultsBar({ sized: false }, "job-1", []), false,
    "nothing to reveal, so nothing opens");
  for (const id of [null, undefined, ""]) {
    assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, id, []), false,
      "an id that cannot be marked would open on EVERY load");
  }
  // Total for junk views, exactly as resultsBarDefaultCollapsed is.
  for (const junk of [null, undefined, 42, "x", {}]) {
    assert.doesNotThrow(() =>
      shouldAutoExpandResultsBar(unsafe<ResultsBarView>(junk), "j", []));
    assert.equal(shouldAutoExpandResultsBar(unsafe<ResultsBarView>(junk), "j", []), false);
  }
});

test("3.14-3 D3: junk in EITHER storage key cannot throw and cannot auto-expand twice", () => {
  const JUNK = ["", "not json", "null", "42", '"a string"', "{}", '{"collapsed":true}',
    "[]", "[1,2,3]", '[null]', '[{"job":"x"}]', '["", ""]', "[[]]"];
  for (const raw of JUNK) {
    assert.doesNotThrow(() => parseAutoExpandedJobs(raw), raw);
    const ids = parseAutoExpandedJobs(raw);
    assert.ok(Array.isArray(ids), raw);
    assert.ok(ids.every((id) => typeof id === "string" && id !== ""), raw);
  }
  assert.doesNotThrow(() => parseAutoExpandedJobs(null));
  assert.deepEqual(parseAutoExpandedJobs(null), []);
  // Junk in the PREFERENCE key is unchanged and still self-heals to no
  // preference — the two keys are parsed independently, which is why the
  // marker got its own key rather than widening that shape.
  for (const raw of JUNK) {
    assert.doesNotThrow(() => parseResultsBarPreference(raw), raw);
  }
  assert.equal(parseResultsBarPreference('{"collapsed":true,"height":96}'), null);
  // Duplicates collapse; a real id inside junk still survives.
  assert.deepEqual(parseAutoExpandedJobs('["a","a","b",7,null,""]'), ["a", "b"]);
  // The set is bounded — a marker set is a convenience, not a record.
  const many = Array.from({ length: RESULTS_BAR_AUTOEXPAND_LIMIT + 50 }, (_, i) => `j${i}`);
  const capped = parseAutoExpandedJobs(JSON.stringify(many));
  assert.equal(capped.length, RESULTS_BAR_AUTOEXPAND_LIMIT);
  assert.equal(capped[capped.length - 1], `j${many.length - 1}`, "the NEWEST are kept");
  const grown = rememberAutoExpandedJob(capped, "brand-new");
  assert.equal(grown.length, RESULTS_BAR_AUTOEXPAND_LIMIT);
  assert.equal(grown[grown.length - 1], "brand-new");
  assert.equal(shouldAutoExpandResultsBar(SIZED_VIEW, "brand-new", grown), false);
  // The key is versioned and is NOT the preference key.
  assert.match(RESULTS_BAR_AUTOEXPAND_STORAGE_KEY, /\.v\d+$/);
  assert.notEqual(RESULTS_BAR_AUTOEXPAND_STORAGE_KEY, "enrgengine.worksheet.results-bar.v1");
});

test("3.14-3 D3: the component writes the MARKER on auto-expand and never the "
  + "preference — which is what lets a later collapse stick", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const bar = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/results-bar.tsx"), "utf8");
  // The auto-expand block: collapse is overridden and the MARKER key written.
  const block = bar.slice(bar.indexOf("shouldAutoExpandResultsBar("));
  const end = block.indexOf("// A suspect measurement");
  const autoExpand = block.slice(0, end > 0 ? end : 800);
  assert.ok(autoExpand.includes("setCollapsed(false)"),
    "the bar opens itself in place — the same state the Chart toggle sets");
  assert.ok(autoExpand.includes("RESULTS_BAR_AUTOEXPAND_STORAGE_KEY"),
    "the job is marked, so it can never open itself twice");
  assert.ok(!autoExpand.includes("persist("),
    "the one-time override must NOT rewrite the preference, or a later "
    + "collapse would be fighting a value this wrote");
  // A collapse afterwards DOES persist — through the existing toggle.
  assert.ok(/function toggleCollapsed\(\)[\s\S]{0,220}persist\(\{ collapsed: next/.test(bar),
    "toggleCollapsed persists the user's choice, so it wins from then on");
  // Not a dialog, not an overlay (D3's amendment, clause 1).
  assert.ok(!/Dialog|Modal|role="dialog"/.test(bar), "no dialog, no overlay");
  // Every storage touch is wrapped.
  const touches = (bar.match(/window\.localStorage\./g) ?? []).length;
  const tries = (bar.match(/try \{/g) ?? []).length;
  assert.ok(touches >= 3, `expected reads and writes, found ${touches}`);
  assert.ok(tries >= touches - 1,
    `every storage touch is wrapped: ${touches} touches, ${tries} try blocks`);
  // The job id reaches the bar — without it nothing can auto-expand. Since
  // 3.14 prompt 6 the BODY hosts the bar: the page hands the body the id and
  // the body hands it on.
  const page = fs.readFileSync(
    path.join(FRONTEND, "app/(app)/jobs/[id]/worksheet/page.tsx"), "utf8");
  assert.match(page, /<WorksheetBody[\s\S]*jobId=\{id\}/);
  const bodySrc = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/worksheet-body.tsx"), "utf8");
  assert.match(bodySrc, /<ResultsBar[\s\S]*?jobId=\{jobId\}/);
});

test("3.14-3: both sizing sections render the STORED run through the SAME "
  + "renderResult the reply uses — one path, two sources", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  for (const [file, guard] of [
    ["components/worksheet/solar-sizing-section.tsx", "!result && !keptResult && view.storedRun"],
    ["components/worksheet/battery-sizing-section.tsx", "!result && view.storedRun"],
  ] as const) {
    const src = fs.readFileSync(path.join(FRONTEND, file), "utf8");
    assert.ok(src.includes(guard), `${file}: the stored body shows only with no fresh reply`);
    assert.ok(src.includes("renderResult(view.storedRun.run"),
      `${file}: ONE rendering path — the stored run goes through renderResult`);
    assert.ok(src.includes("view.storedRun.chosenNote"),
      `${file}: the no-marker sentence reaches the screen`);
    assert.ok(src.includes("view.storedRun.notRecordedNote"),
      `${file}: what the run did not record reaches the screen`);
    // Exactly one renderResult definition: a second would be two paths.
    assert.equal((src.match(/function renderResult\(/g) ?? []).length, 1, file);
  }
});


// ── 3.14 prompt 4 — the value-versus-size curve in the rail (F188) ───────────

/**
 * The SHAPE of run d79e9974's stored solar_options: seven array sizes and the
 * 25-year value each returned. This is the run F188 was raised from — the top
 * three within $28 of each other while one was marked chosen on a $6 margin.
 */
const D79_SOLAR_POINTS = [
  { solar_kw: 0.0, npv_25yr: 0, system_cost: 0, simple_payback_years: null, self_sufficiency_pct: 0 },
  { solar_kw: 1.32, npv_25yr: 8397.60, system_cost: 2100, simple_payback_years: 2.4, self_sufficiency_pct: 18.2 },
  { solar_kw: 4.84, npv_25yr: 14500.09, system_cost: 4900, simple_payback_years: 3.6, self_sufficiency_pct: 42.7 },
  { solar_kw: 8.36, npv_25yr: 16925.06, system_cost: 6800, simple_payback_years: 4.1, self_sufficiency_pct: 61.3 },
  { solar_kw: 9.24, npv_25yr: 17068.33, system_cost: 7248, simple_payback_years: 4.2, self_sufficiency_pct: 64.9 },
  { solar_kw: 10.12, npv_25yr: 17039.91, system_cost: 7810, simple_payback_years: 4.4, self_sufficiency_pct: 68.1 },
  { solar_kw: 11.44, npv_25yr: 17062.34, system_cost: 8600, simple_payback_years: 4.6, self_sufficiency_pct: 72.4 },
];

const D79_OPTIONS = {
  dimension_keys: ["solar_kw"],
  chosen_index: 4,
  points: D79_SOLAR_POINTS,
};

/** The same options as a run_kind 'solar' row stores them: at the top level. */
const D79_AS_SOLAR_RUN = {
  sizing_results: [{
    sizing_result_id: "s-d79-solar", run_kind: "solar", objective_used: "max_npv",
    solar_kw: 9.24, battery_kwh: null, system_cost: 7248,
    annual_solar_generation_kwh: 13820.4,
    evaluated_options: D79_OPTIONS,
  }],
  financial_results: [{ sizing_result_id: "s-d79-solar" }],
};

/** ...and as a run_kind 'solar_battery' row stores them: under solar_options. */
const D79_AS_BATTERY_RUN = {
  sizing_results: [{
    sizing_result_id: "s-d79-batt", run_kind: "solar_battery", objective_used: "max_npv",
    solar_kw: 9.24, battery_kwh: 9.83, system_cost: 11868.77,
    annual_solar_generation_kwh: 13820.4,
    evaluated_options: {
      dimension_keys: ["battery_id"],
      chosen_index: 1,
      points: [
        { usable_kwh: 0, model: "No battery", system_cost: 7248, incremental_npv: 0 },
        { battery_id: "b1", usable_kwh: 9.83, model: "GoodWe Lynx Home F",
          system_cost: 11868.77, incremental_npv: 2867.22 },
      ],
      solar_options: D79_OPTIONS,
      split: {
        solar_only: { npv_25yr: 17068.33, simple_payback_years: 4.2, system_cost: 7248 },
        battery_increment: { incremental_npv: 2867.22, incremental_payback_years: 8.6,
                             battery_cost: 4620.77 },
      },
    },
  }],
  financial_results: [{ sizing_result_id: "s-d79-batt" }],
};

// 4-A. The new entry point on BOTH run kinds, reaching ONE builder.
test("3.14-4: solarCurveView draws array sizes on BOTH run kinds — a battery "
  + "run reads solar_options, a solar run reads its own options", () => {
  const fromSolar = solarCurveView(D79_AS_SOLAR_RUN);
  const fromBattery = solarCurveView(D79_AS_BATTERY_RUN);
  // Both are a curve over kW: six real options plus the do-nothing line.
  for (const [label, view] of [["solar run", fromSolar], ["battery run", fromBattery]] as const) {
    assert.ok(view.bars, `${label}: a curve was built`);
    assert.equal(view.bars!.length, 6, `${label}: six options, the baseline is not a bar`);
    assert.deepEqual(view.bars!.map((b) => b.label),
      ["1.32 kW", "4.84 kW", "8.36 kW", "9.24 kW", "10.12 kW", "11.44 kW"],
      `${label}: labelled in kW — battery products here would be the bug`);
    assert.equal(view.baseline?.label, "No solar", `${label}: the do-nothing line`);
    assert.equal(view.unit, "aud");
    assert.equal(view.bars!.filter((b) => b.chosen).length, 1, `${label}: one chosen`);
    assert.equal(view.bars!.find((b) => b.chosen)?.label, "9.24 kW");
  }
  // THE SAME BUILDER: identical options through two doors, identical view.
  assert.deepEqual(fromBattery, fromSolar,
    "one implementation — two entry points, not two builders");
  // And the battery run's OWN chart is still the battery products, untouched.
  const batteryOwn = scoreCurveView(D79_AS_BATTERY_RUN);
  assert.deepEqual(batteryOwn.bars!.map((b) => b.label), ["GoodWe Lynx Home F"]);
  assert.notDeepEqual(batteryOwn.bars, fromBattery.bars,
    "the Results tab's chart and the rail's are different questions");
});

// 4-B. The two silences, kept apart.
test("3.14-4: a run stored before the curve says it did not RECORD the options "
  + "— distinguishable from a run that recorded NONE", () => {
  const preCurve = JSON.parse(JSON.stringify(D79_AS_BATTERY_RUN));
  delete preCurve.sizing_results[0].evaluated_options.solar_options;
  const missing = solarCurveView(preCurve);
  assert.equal(missing.bars, null, "no chart");
  assert.equal(missing.ticks, null, "no axes");
  assert.equal(missing.note, SOLAR_CURVE_NOT_RECORDED);
  assert.match(missing.note ?? "", /did not record/);

  const emptySet = JSON.parse(JSON.stringify(D79_AS_BATTERY_RUN));
  emptySet.sizing_results[0].evaluated_options.solar_options =
    { dimension_keys: ["solar_kw"], points: [] };
  const none = solarCurveView(emptySet);
  assert.equal(none.bars, null);
  assert.equal(none.note, SOLAR_CURVE_NO_OPTIONS);
  assert.notEqual(none.note, missing.note,
    "\"not recorded\" and \"there were none\" are two different facts");
  console.log(`        not recorded : ${missing.note}`);
  console.log(`        no options   : ${none.note}`);

  // A battery run whose solar_options somehow carries BATTERY dimensions is
  // not drawn under a kW axis — a plausible chart of the wrong thing.
  const wrongDims = JSON.parse(JSON.stringify(D79_AS_BATTERY_RUN));
  wrongDims.sizing_results[0].evaluated_options.solar_options =
    { dimension_keys: ["battery_id"], points: [{ usable_kwh: 10, incremental_npv: 1 }] };
  assert.equal(solarCurveView(wrongDims).bars, null);
  assert.equal(solarCurveView(wrongDims).note, SOLAR_CURVE_NOT_RECORDED);

  // A run with options but NO chosen marker: every bar drawn, none marked.
  const noMarker = JSON.parse(JSON.stringify(D79_AS_SOLAR_RUN));
  delete noMarker.sizing_results[0].evaluated_options.chosen_index;
  const drawn = solarCurveView(noMarker);
  assert.equal(drawn.bars!.length, 6, "every option still drawn");
  assert.ok(drawn.bars!.every((b) => !b.chosen), "none marked");
  assert.match(drawn.chosenNote ?? "", /did not record which option/);

  // Total for junk, exactly as scoreCurveView is.
  for (const junk of [null, undefined, 0, "x", [], {}, { sizing_results: [null] }]) {
    assert.doesNotThrow(() => solarCurveView(junk));
    assert.equal(solarCurveView(junk).bars, null);
    assert.ok(solarCurveView(junk).note, "an honest line, never an empty axis");
  }
});

// 4-C. F188 ON THE REAL SHAPE — the note fires, and the arithmetic is DERIVED
// here rather than taken on trust.
test("3.14-4 F188: the tie sentence fires on run d79e9974's shape, and the "
  + "SAME sentence reaches the Solar sizing options table", () => {
  const view = solarCurveView(D79_AS_SOLAR_RUN);
  assert.ok(view.bars);
  // Derived, not asserted from the prompt: rank by the run's own measure.
  const ranked = [...view.bars!.map((b) => b.value)].sort((a, b) => b - a);
  const top3 = ranked.slice(0, 3);
  const spread = Math.max(...top3) - Math.min(...top3);
  const best = Math.abs(ranked[0]);
  const ratio = spread / best;
  console.log(`        top three     : ${top3.join(", ")}`);
  console.log(`        spread        : ${spread}`);
  console.log(`        best          : ${best}`);
  console.log(`        ratio         : ${ratio}  (threshold ${FLAT_OPTIONS_RATIO})`);
  assert.ok(ratio < FLAT_OPTIONS_RATIO,
    `the top three ARE within the threshold: ${ratio} < ${FLAT_OPTIONS_RATIO}`);
  assert.ok(view.flatNote, "so the sentence must be produced");
  console.log(`        flat note     : ${view.flatNote}`);
  assert.match(view.flatNote ?? "", /fine margin, not a cliff/);

  // (b) THE SAME SENTENCE, in the Solar sizing options table — one rule, one
  // wording, two places. A second copy of the words is the drift this deletes.
  const section = solarSizingView({
    ...D79_AS_SOLAR_RUN,
    status: "draft", path: null, path_label: null,
  });
  assert.ok(section.storedRun);
  assert.equal(section.storedRun!.flatNote, view.flatNote,
    "the table's sentence IS the chart's sentence, character for character");
  // ...and it travels on a battery run's solar table too.
  const batterySection = solarSizingView({
    ...D79_AS_BATTERY_RUN,
    status: "draft", path: null, path_label: null,
  });
  assert.equal(batterySection.storedRun!.flatNote, view.flatNote);
});

// 4-D. THE NEGATIVE CASE — options genuinely far apart say NOTHING.
test("3.14-4 F188: a curve whose top three are far apart produces NO tie "
  + "sentence, and fewer than three options never claims a tie", () => {
  const spread = JSON.parse(JSON.stringify(D79_AS_SOLAR_RUN));
  spread.sizing_results[0].evaluated_options.points = [
    { solar_kw: 0, npv_25yr: 0 },
    { solar_kw: 3, npv_25yr: 5000 },
    { solar_kw: 6, npv_25yr: 10000 },
    { solar_kw: 9, npv_25yr: 20000 },
  ];
  const view = solarCurveView(spread);
  const ranked = [...view.bars!.map((b) => b.value)].sort((a, b) => b - a);
  const top3 = ranked.slice(0, 3);
  const gap = Math.max(...top3) - Math.min(...top3);
  const ratio = gap / Math.abs(ranked[0]);
  console.log(`        far-apart top three: ${top3.join(", ")}  ratio ${ratio}`);
  assert.ok(ratio >= FLAT_OPTIONS_RATIO, "the premise: these are genuinely far apart");
  assert.equal(view.flatNote, null, "no tie sentence — there is no tie");

  // The function itself, directly: fewer than three options never speaks.
  assert.equal(flatOptionsNote([17068.33, 17062.34], "aud", false), null,
    "a tie claim needs a top three to compare");
  assert.equal(flatOptionsNote([17068.33], "aud", false), null);
  assert.equal(flatOptionsNote([], "aud", false), null);
  // A best of zero says nothing either — every spread is infinite against it.
  assert.equal(flatOptionsNote([0, 0, 0], "aud", false), null);
  // And it fires on the real three.
  assert.ok(flatOptionsNote([17068.33, 17062.34, 17039.91], "aud", false));
  // lowerIsBetter ranks the OTHER way — three paybacks a hair apart tie too.
  assert.ok(flatOptionsNote([4.2, 4.201, 4.202, 9.0], "years", true));
  assert.equal(flatOptionsNote([4.2, 6.0, 9.0], "years", true), null);
  // Junk never throws and never invents a sentence.
  for (const junk of [[NaN, NaN, NaN], [Infinity, 1, 2], [1, 2]]) {
    assert.doesNotThrow(() => flatOptionsNote(junk, "aud", false));
  }
});

// 4-E. The chart reaches the rail on demand, and every ScoreCurve prop the
// rail passes is OPTIONAL so the Results tab renders identically.
test("3.14-4: the rail imports the SAME ScoreCurve through next/dynamic with "
  + "ssr:false, and adds only OPTIONAL props", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const bar = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/results-bar.tsx"), "utf8");
  // The SAME component the Results tab uses — not a second chart.
  assert.match(bar, /import\("@\/components\/results\/score-curve"\)/);
  assert.match(bar, /dynamic<ScoreCurveProps>\(/);
  assert.match(bar, /ssr:\s*false/);
  // recharts must NOT be imported statically anywhere in the worksheet route.
  assert.ok(!/from "recharts"/.test(bar), "no static recharts in the rail");
  // A failed chunk degrades to a sentence rather than throwing.
  assert.match(bar, /\.catch\(\(\) => CurveUnavailable\)/);
  assert.match(bar, /loading: \(\) => <CurveLoading \/>/);

  // Every prop the rail passes is optional on ScoreCurve.
  const curve = fs.readFileSync(
    path.join(FRONTEND, "components/results/score-curve.tsx"), "utf8");
  const props = curve.slice(curve.indexOf("export interface ScoreCurveProps"));
  const body = props.slice(0, props.indexOf("\n}"));
  for (const optional of ["rowHeight?:", "maxPlotHeight?:"]) {
    assert.ok(body.includes(optional), `${optional} must be optional`);
  }
  assert.ok(body.includes("view: ScoreCurveView"), "view stays required");
  // The Results tab is untouched and still passes ONLY view.
  const tab = fs.readFileSync(
    path.join(FRONTEND, "components/results/results-tab.tsx"), "utf8");
  assert.match(tab, /<ScoreCurve view=\{view\.curve\} \/>/);
  assert.ok(!tab.includes("rowHeight") && !tab.includes("maxPlotHeight"),
    "the Results tab passes no new prop, so it renders exactly as before");
  // The page hands the rail the curve — since 3.14 prompt 6 via the body,
  // which hosts the bar.
  const page = fs.readFileSync(
    path.join(FRONTEND, "app/(app)/jobs/[id]/worksheet/page.tsx"), "utf8");
  assert.match(page, /curve: solarCurveView\(job\)/);
  const bodySrc = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/worksheet-body.tsx"), "utf8");
  assert.match(bodySrc, /curve=\{resultsBar\.curve\}/);
});


// ── 3.14 prompt 6 — the live rail (D37) ─────────────────────────────────────
//
// Every rail state is derived in lib; these tests hold the union, the
// request builder, the instant path's sequential-sizing caveat, the failed
// path, and the not-saved labelling — with NO request ever made on the
// instant path (a fetch counter proves it).

/** A stored battery run in the shape prompts 2-5 persist, as a full job. */
const RAIL_JOB = {
  status: "draft", path: "B", path_label: "Solar + battery",
  objective: "max_npv", budget_aud: null,
  sizing_results: [STORED_BATTERY_RUN],
  financial_results: [{
    sizing_result_id: "s-batt", system_capex: 11868.77, annual_savings: 2136.56,
    payback_years: 5.55, npv_25_year: 19935.55,
  }],
};
const RAIL_BASELINE = railBaselineView(RAIL_JOB);
const CHANGE = (over: Partial<SizingInputChange> = {}): SizingInputChange => ({
  kind: "objective-budget", section: "objective-budget", seq: 1, ...over,
});

async function withFetchCounter<T>(fn: () => T): Promise<{ value: T; fetches: number }> {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  let fetches = 0;
  g.fetch = ((...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return original ? original(...args) : Promise.reject(new Error("no fetch"));
  }) as typeof fetch;
  try {
    return { value: fn(), fetches };
  } finally {
    g.fetch = original;
  }
}

// 6-A. THE REQUEST BUILDER: exactly the declared keys, pinned to the stored run.
test("3.14-6: the re-cost request carries EXACTLY the declared keys, persist false, "
  + "compare_to_unconstrained false, pinned to the stored run's own system", () => {
  const body = railRecostRequest(RAIL_BASELINE, "job-1");
  assert.ok(body, "a stored battery run can be pinned");
  const sent = new Set(Object.keys(body));
  const declared = new Set(railRequestKeysFor(RAIL_BASELINE));
  console.log(`        builder keys : ${[...sent].sort().join(", ")}`);
  console.log(`        constant     : ${[...declared].sort().join(", ")}`);
  assert.deepEqual([...sent].sort(), [...declared].sort(),
    "the key set IS the constant — both directions");
  for (const k of sent) assert.ok(declared.has(k), `${k} not declared`);
  for (const k of declared) assert.ok(sent.has(k), `${k} declared but not sent`);
  assert.equal(body.persist, false);
  assert.equal(body.compare_to_unconstrained, false);
  assert.equal(body.job_id, "job-1");
  // Pinned values equal the stored run's — both directions.
  const c = body.constraints as Record<string, unknown>;
  assert.equal(c.fix_solar_kwp, STORED_BATTERY_RUN.solar_kw);
  assert.equal(STORED_BATTERY_RUN.solar_kw, c.fix_solar_kwp);
  const chosen = STORED_BATTERY_RUN.evaluated_options.points[STORED_BATTERY_RUN.evaluated_options.chosen_index];
  assert.deepEqual(c.battery_ids, [chosen.battery_id]);
  assert.equal(chosen.battery_id, (c.battery_ids as string[])[0]);
  assert.ok(!("force_no_battery" in c), "a real battery is pinned by id, not by force_no_battery");
  // The solar-run shape pins the array only, against ITS constant.
  const solarBase = railBaselineView({ ...RAIL_JOB, sizing_results: [STORED_SOLAR_RUN] });
  const solarBody = railRecostRequest(solarBase, "job-1");
  assert.ok(solarBody);
  assert.deepEqual(Object.keys(solarBody).sort(), [...railRequestKeysFor(solarBase)].sort());
  assert.deepEqual(solarBody.constraints, { fix_solar_kwp: STORED_SOLAR_RUN.solar_kw });
  assert.equal(solarBase.endpoint, "/api/sizing/optimise");
  assert.equal(RAIL_BASELINE.endpoint, "/api/sizing/battery");
  // A stored NO-BATTERY outcome pins force_no_battery, never an invented id.
  const none = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  none.battery_kwh = 0; none.evaluated_options.chosen_index = 0;
  const noneBody = railRecostRequest(railBaselineView({ ...RAIL_JOB, sizing_results: [none] }), "j");
  assert.deepEqual(noneBody?.constraints, { fix_solar_kwp: 9.24, force_no_battery: true });
  // Nothing to pin -> null, never an unpinned search.
  assert.equal(railRecostRequest(railBaselineView({ sizing_results: [] }), "j"), null);
});

// 6-B. EVERY STATE, DISTINCT.
test("3.14-6: the rail's states are a discriminated union and every kind is "
  + "reachable and distinct", () => {
  const physics = CHANGE({ kind: "physics", section: "tariff-network" });
  const good = {
    flags: [RAIL_DECLINE_FLAG, "not_persisted_by_request"],
    engine_mode: "sequential", resolution: "full_year", constraint_deltas: null,
    chosen_solar: { solar_kw: 9.24 },
    optimal_battery: { battery_id: "b1", usable_kwh: 9.83, system_cost: 12000,
      annual_savings_vs_solar_only: 300, incremental_npv: 2900, self_sufficiency_pct: 85 },
    solar_options: { chosen_index: 1, points: [{}, { annual_savings: 1800, npv_25yr: 17100 }] },
  };
  const states: RailState[] = [
    { kind: "stored" },
    railRerank(RAIL_BASELINE, CHANGE({ objective: "max_npv" })),
    railRerank(RAIL_BASELINE, CHANGE({ objective: "custom", customWeight: 0.3 })),
    { kind: "recosting", trigger: physics, startedAt: 1 },
    railRecostState(RAIL_BASELINE, physics, good),
    railFailedState(physics, "the engine did not answer."),
  ];
  const kinds = states.map((s) => s.kind);
  console.log(`        states: ${kinds.join(" · ")}`);
  assert.deepEqual(kinds, [...RAIL_STATE_KINDS],
    "one of each kind, in the declared order");
  assert.equal(new Set(kinds).size, RAIL_STATE_KINDS.length,
    "merge any two and this test is testing nothing");
  // And every status line differs too — the words are the product.
  const lines = states.map((s) => railStatusLine(s));
  assert.equal(lines[0], null, "the stored state has NO recompute line");
  assert.equal(new Set(lines.slice(1)).size, lines.length - 1,
    "every recomputed state says something different");
  for (const line of lines.slice(1)) assert.ok(line && line.length > 20);
});

// 6-C. THE RE-RANK PAIR — the heart of it. Both from stored data, no fetch.
test("3.14-6 D37: a re-rank that does NOT move the array leaves the battery live; "
  + "one that DOES move it marks the battery as the previous array's — no "
  + "request made", async () => {
  // max_npv is the stored objective: nothing moves.
  const same = await withFetchCounter(() =>
    railRerank(RAIL_BASELINE, CHANGE({ objective: "max_npv", budgetAud: null })));
  assert.equal(same.fetches, 0, "the instant path never fetches");
  const s = same.value;
  assert.equal(s.kind, "reranked");
  if (s.kind !== "reranked") return;
  console.log(`        unmoved : arrayMoved=${s.arrayMoved} batteryStale=${s.batteryStale} `
    + `after=${s.after.solarKw} kW + ${s.after.batteryKwh} kWh basis=${s.after.basis}`);
  console.log(`                  ${s.note}`);
  assert.equal(s.arrayMoved, false);
  assert.equal(s.batteryStale, false, "the battery figures stay LIVE");
  assert.deepEqual(s.after, s.before, "the delta is zero");
  assert.ok(s.deltas.every((d) => d.direction === "none" && d.change === "no change"));
  assert.match(s.note, /moves nothing/);
  assert.equal(s.after.basis, "whole-system");

  // max_self_sufficiency ranks the 10.12 kW array above 9.24: the array MOVES.
  const moved = await withFetchCounter(() =>
    railRerank(RAIL_BASELINE, CHANGE({ objective: "max_self_sufficiency", seq: 2 })));
  assert.equal(moved.fetches, 0, "still no fetch");
  const m = moved.value;
  assert.equal(m.kind, "reranked");
  if (m.kind !== "reranked") return;
  console.log(`        moved   : arrayMoved=${m.arrayMoved} batteryStale=${m.batteryStale} `
    + `after=${m.after.solarKw} kW basis=${m.after.basis} npv=${m.after.npv} self=${m.after.selfSufficiencyPct}`);
  console.log(`                  ${m.note}`);
  assert.equal(m.arrayMoved, true);
  assert.equal(m.batteryStale, true, "the battery was solved around the PREVIOUS array");
  assert.equal(m.after.solarKw, 10.12, "the newly-top array");
  assert.equal(m.after.basis, "solar-only", "its OWN stored solar figures, nothing composed");
  assert.equal(m.after.npv, 17039.91, "exact — the run stored it");
  assert.equal(m.after.selfSufficiencyPct, 85.3);
  assert.equal(m.after.batteryKwh, null, "no battery figure is claimed for the new array");
  assert.equal(m.before.basis, "solar-only", "compared against the OLD array's solar-only parts");
  assert.equal(m.before.npv, 17068.33);
  assert.match(m.note, /belong to the 9\.24 kW array/);
  assert.match(m.note, /full Size/);
  // The two outcomes are genuinely different states of the same kind.
  assert.notDeepEqual(
    { a: s.arrayMoved, b: s.batteryStale, f: s.after },
    { a: m.arrayMoved, b: m.batteryStale, f: m.after });

  // A budget cap that cuts the chosen battery re-ranks the CANDIDATES around
  // the SAME array — live, exact, composed from stored parts.
  const capped = railRerank(RAIL_BASELINE, CHANGE({ objective: "max_npv", budgetAud: 8000, seq: 3 }));
  assert.equal(capped.kind, "reranked");
  if (capped.kind === "reranked") {
    console.log(`        capped  : arrayMoved=${capped.arrayMoved} after=${capped.after.solarKw} kW + ${capped.after.batteryKwh} kWh npv=${capped.after.npv}`);
    assert.equal(capped.arrayMoved, false);
    assert.equal(capped.after.batteryKwh, 0, "only the no-battery candidate fits $8,000");
    assert.equal(capped.after.npv, 17068.33, "solar NPV + $0 increment");
    assert.equal(capped.batteryStale, false);
  }
  // A custom blend cannot be re-ranked from stored scores: unavailable, named.
  const custom = railRerank(RAIL_BASELINE, CHANGE({ objective: "custom", customWeight: 0.2, seq: 4 }));
  assert.equal(custom.kind, "rerank-unavailable");
  // A run with no stored options: unavailable, NOT a re-cost called instant.
  const bare = railBaselineView({ sizing_results: [{ sizing_result_id: "x", run_kind: "solar_battery",
    solar_kw: 6.6, battery_kwh: 10, evaluated_options: { dimension_keys: ["battery_id"], points: [] } }] });
  const none = railRerank(bare, CHANGE({ objective: "max_npv", seq: 5 }));
  assert.equal(none.kind, "rerank-unavailable");
  assert.match(none.kind === "rerank-unavailable" ? none.reason : "", /did not record/);
});

// 6-D. A FAILED RE-COST returns to the stored figures and says so.
test("3.14-6: a failed re-cost keeps the stored figures and says the attempt "
  + "failed — and contradictions or substitutions are refused, not guessed", () => {
  const physics = CHANGE({ kind: "physics", section: "tariff-network" });
  const failed = railFailedState(physics, "the engine did not answer.");
  assert.equal(failed.kind, "failed");
  assert.equal(failed.canRetry, true);
  const line = railStatusLine(failed) ?? "";
  console.log(`        failed line: ${line}`);
  assert.match(line, /did not complete/);
  assert.match(line, /stored run's figures are shown/);
  assert.match(line, /Try again/);
  // From a response: an error body, a contradiction, a substituted battery,
  // a missing provenance — every one FAILED, never a half-updated figure.
  const ok = {
    flags: [RAIL_DECLINE_FLAG], engine_mode: "sequential", resolution: "full_year",
    constraint_deltas: null, chosen_solar: { solar_kw: 9.24 },
    optimal_battery: { battery_id: "b1", usable_kwh: 9.83, system_cost: 12000,
      annual_savings_vs_solar_only: 300, incremental_npv: 2900, self_sufficiency_pct: 85 },
    solar_options: { chosen_index: 1, points: [{}, { annual_savings: 1800, npv_25yr: 17100 }] },
  };
  const cases: [string, unknown][] = [
    ["error body", { error: "Internal error in the battery optimiser." }],
    ["contradiction: declined AND deltas", { ...ok, constraint_deltas: { battery_kwh: 0 } }],
    ["no decline flag", { ...ok, flags: [] }],
    ["different battery", { ...ok, optimal_battery: { ...ok.optimal_battery, battery_id: "b2", usable_kwh: 13.5 } }],
    ["different array", { ...ok, chosen_solar: { solar_kw: 10.12 } }],
    ["battery gone from catalogue", { ...ok, flags: [RAIL_DECLINE_FLAG, "battery_ids not in the active catalogue — not evaluated: ['b1']"] }],
    ["no engine_mode", { ...ok, engine_mode: undefined }],
    ["no resolution", { ...ok, resolution: undefined }],
    ["junk", null],
  ];
  for (const [label, resp] of cases) {
    const st = railRecostState(RAIL_BASELINE, physics, resp);
    assert.equal(st.kind, "failed", label);
    console.log(`        ${label.padEnd(34)} -> ${st.kind === "failed" ? st.reason.slice(0, 70) : ""}`);
  }
  // And the healthy shape is a re-cost, with its provenance spelled out.
  const good = railRecostState(RAIL_BASELINE, physics, ok);
  assert.equal(good.kind, "recosted");
  if (good.kind === "recosted") {
    assert.equal(good.after.solarKw, 9.24);
    assert.equal(good.after.batteryKwh, 9.83);
    assert.equal(good.after.npv, 20000, "17100 + 2900, composed as the route composes");
    assert.equal(good.after.paybackYears, 5.71, "12000 / 2100, rounded as _payback_years rounds");
    assert.equal(good.provenance.engineMode, "sequential");
    assert.equal(good.provenance.resolution, "full_year");
    assert.match(good.provenance.label, /sequential engine/);
    assert.match(good.provenance.label, /full-year dispatch/);
    assert.deepEqual(good.before, RAIL_BASELINE.figures, "before IS the stored run");
    const npv = good.deltas.find((d) => d.label === "NPV");
    assert.equal(npv?.change, "+$64");
    assert.equal(npv?.direction, "up");
  }
});

// 6-E. NEVER "SAVED": the not-saved words on every recomputed state, absent on stored.
test("3.14-6: the not-saved labelling is on EVERY recomputed state and absent on "
  + "the stored state", () => {
  const physics = CHANGE({ kind: "physics", section: "energy-data" });
  const ok = {
    flags: [RAIL_DECLINE_FLAG], engine_mode: "sequential", resolution: "full_year",
    chosen_solar: { solar_kw: 9.24 },
    optimal_battery: { battery_id: "b1", usable_kwh: 9.83, system_cost: 12000,
      annual_savings_vs_solar_only: 300, incremental_npv: 2900, self_sufficiency_pct: 85 },
    solar_options: { chosen_index: 1, points: [{}, { annual_savings: 1800, npv_25yr: 17100 }] },
  };
  const recomputed: RailState[] = [
    railRerank(RAIL_BASELINE, CHANGE({ objective: "max_npv" })),
    railRerank(RAIL_BASELINE, CHANGE({ objective: "max_self_sufficiency" })),
    railRerank(RAIL_BASELINE, CHANGE({ objective: "custom" })),
    { kind: "recosting", trigger: physics, startedAt: 1 },
    railRecostState(RAIL_BASELINE, physics, ok),
    railFailedState(physics, "x."),
  ];
  for (const st of recomputed) {
    const line = railStatusLine(st) ?? "";
    assert.ok(/not saved|nothing is saved|Nothing here is saved|stored run's figures are shown/i.test(line),
      `${st.kind}: "${line}"`);
    assert.ok(!/\bsaved\b(?! —)/.test(line.replace(/not saved|nothing is saved|Nothing here is saved/gi, "")),
      `${st.kind} must never read as "saved"`);
  }
  assert.equal(railStatusLine({ kind: "stored" }), null, "stored: no recompute line at all");
  for (const st of recomputed) {
    if (st.kind === "reranked" || st.kind === "recosted") {
      assert.equal(st.notSaved, RAIL_NOT_SAVED);
    }
  }
  assert.match(RAIL_NOT_SAVED, /press Size to commit/i);
});

// 6-F. WHICH SECTIONS ANNOUNCE — the list derived from what the endpoints read.
test("3.14-6: exactly the sections the engine reads announce a save; the bar is "
  + "hosted by the body; the sizing routes are untouched", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const read = (f: string) => fs.readFileSync(path.join(FRONTEND, f), "utf8");
  const announcing: [string, string, number][] = [
    // file, kind, number of announce sites
    ["components/worksheet/address-roof-section.tsx", "physics", 2],
    ["components/worksheet/site-details-section.tsx", "physics", 1],
    ["components/worksheet/energy-data-section.tsx", "physics", 3],
    ["components/worksheet/tariff-network-section.tsx", "physics", 1],
    ["components/worksheet/objective-budget-section.tsx", "objective-budget", 1],
    // 3.14b prompt 3: equipment joined the list the moment prompts 1 and 2 made
    // jobs.equipment_* an engine input. It was silent before that, correctly.
    ["components/worksheet/equipment-specs-section.tsx", "equipment", 1],
  ];
  for (const [file, kind, sites] of announcing) {
    const s = read(file);
    assert.equal((s.match(/onSaved\?\.\(/g) ?? []).length, sites, `${file}: announce sites`);
    assert.ok(s.includes(`kind: "${kind}"`), `${file}: kind ${kind}`);
    assert.ok(/onSaved\?: \(change: SizingInputSave\) => void;/.test(s), `${file}: optional prop`);
  }
  // STILL SILENT by decision: the two Size sections (they create a NEW stored
  // run, which resets the rail by id) and the edit button. Equipment left this
  // list at 3.14b prompt 3 — see above.
  for (const file of [
    "components/worksheet/solar-sizing-section.tsx",
    "components/worksheet/battery-sizing-section.tsx",
    "components/worksheet/job-edit-button.tsx",
  ]) {
    assert.ok(!read(file).includes("onSaved"), `${file} stays silent`);
  }
  const body = read("components/worksheet/worksheet-body.tsx");
  assert.equal((body.match(/onSaved=\{announce\(section\.id\)\}/g) ?? []).length, 6,
    "the body threads the callback to exactly six sections");
  assert.match(body, /<ResultsBar[\s\S]*change=\{change\}/, "the body hosts the bar and hands it the change");
  const page = read("app/(app)/jobs/[id]/worksheet/page.tsx");
  assert.ok(!page.includes("<ResultsBar"), "page.tsx no longer renders the bar itself");
  assert.match(page, /baseline: railBaselineView\(job\)/);
  // The bar: no debounce, no timer, reuses RunProgress, posts the builder's body.
  const bar = read("components/worksheet/results-bar.tsx");
  assert.ok(!/setTimeout|debounce/.test(bar), "the trigger is a save, never a keystroke (D37)");
  assert.match(bar, /<RunProgress startedAt=\{rail\.startedAt\} \/>/);
  assert.match(bar, /railRecostRequest\(baseline, jobId\)/);
  assert.match(bar, /requestJson<Record<string, unknown>>\(\s*"POST",\s*baseline\.endpoint,\s*body,?\s*\)/);
  // The API routes forward unaltered — no whitelist was added.
  for (const route of ["app/api/sizing/optimise/route.ts", "app/api/sizing/battery/route.ts"]) {
    assert.ok(!/persist|compare_to_unconstrained/.test(read(route)), `${route} untouched`);
  }
});


// ── 3.14 prompt 8 — the chart follows the rail (F210), and the baseline ───────

const HISTORY_PAYLOAD = {
  job_id: "job-1",
  runs: [
    { sizing_result_id: "s-batt", created_at: "2026-08-21T02:00:00Z", run_kind: "solar_battery",
      engine_mode: "sequential", objective_used: "max_npv", dispatch_resolution: "full_year",
      solar_kw: 9.24, battery_kwh: 9.83, system_cost: 11868.77, self_sufficiency_pct: 84.12,
      has_chosen_marker: true, has_solar_curve: true, financial_result_id: "f1",
      payback_years: 5.55, npv_25_year: 19935.55, undiscounted_savings_25yr: 56539.32 },
    { sizing_result_id: "s-old", created_at: "2026-08-20T05:00:00Z", run_kind: "solar_battery",
      engine_mode: "sequential", objective_used: "max_npv", dispatch_resolution: null,
      solar_kw: 6.6, battery_kwh: 13.5, system_cost: 16000, self_sufficiency_pct: null,
      has_chosen_marker: false, has_solar_curve: false, financial_result_id: "f0",
      payback_years: 7.1, npv_25_year: 15000, undiscounted_savings_25yr: 40000 },
    { sizing_result_id: "s-nofin", created_at: "2026-08-19T05:00:00Z", run_kind: "solar",
      engine_mode: "sequential", objective_used: "min_payback", dispatch_resolution: null,
      solar_kw: 4.84, battery_kwh: null, system_cost: 4900, self_sufficiency_pct: null,
      has_chosen_marker: false, has_solar_curve: false, financial_result_id: null,
      payback_years: null, npv_25_year: null, undiscounted_savings_25yr: null },
  ],
  total: 3, returned: 3, limit: 25, offset: 0, truncated: false,
};
const HISTORY = parseRunHistory(HISTORY_PAYLOAD);
// The prompt-3 fixture carries no objective_used / engine_mode (they were not
// what it tested); the compare is ABOUT those facts, so this run states them
// the way every run since 3.11b is stored.
const SCORED_BATTERY_RUN = {
  ...STORED_BATTERY_RUN, objective_used: "max_npv", engine_mode: "sequential",
};
const RAIL_JOB8 = { ...RAIL_JOB, sizing_results: [SCORED_BATTERY_RUN] };
const RAIL_BASELINE8 = railBaselineView(RAIL_JOB8);
const CURRENT_META: RailRunMeta = RAIL_BASELINE8.meta;

// 8-A. THE CHART RE-RANKS WITH THE RAIL — four respects, all different.
test("3.14-8 F210: the re-ranked chart differs from the stored one in top "
  + "option, axis measure, caption AND highlighted bar — from the same points", () => {
  const stored = solarCurveView(RAIL_JOB8);
  const change = CHANGE({ objective: "max_self_sufficiency" });
  const rail = railRerank(RAIL_BASELINE8, change);
  const reranked = railRerankedCurve(RAIL_BASELINE8, change);
  assert.ok(stored.bars && reranked?.bars, "both views draw");
  // (1) the same stored points — same bars, same count, same labels.
  assert.deepEqual(reranked.bars.map((b) => b.label), stored.bars.map((b) => b.label),
    "the SAME stored points, not a second set");
  // (2) a different top option, and it is the RAIL's own pick — one ranking.
  // Typed wide on purpose: assert.equal narrows a literal, and the later
  // `!==` between the two must stay a real comparison, not a dead one.
  const storedTop: string | undefined = stored.bars.find((b) => b.chosen)?.label;
  const rerankTop: string | undefined = reranked.bars.find((b) => b.chosen)?.label;
  assert.equal(storedTop, "9.24 kW");
  assert.equal(rerankTop, "10.12 kW");
  assert.notEqual(rerankTop, storedTop, "(2) a different highlighted bar");
  assert.equal(rail.kind, "reranked");
  assert.equal(rail.kind === "reranked" ? formatKw(rail.after.solarKw) : null, rerankTop,
    "the chart highlights EXACTLY the array the rail names");
  // (3) a different axis measure.
  const storedAxis: string = stored.valueLabel;
  const rerankAxis: string = reranked.valueLabel;
  assert.equal(storedAxis, "25-year NPV");
  assert.equal(rerankAxis, "Self-sufficiency (%)");
  assert.notEqual(rerankAxis, storedAxis, "(3) the axis follows the objective");
  assert.equal(reranked.unit, "pct");
  assert.notEqual(reranked.unit, stored.unit);
  // (4) a caption naming the APPLIED objective and the stored one.
  assert.equal(stored.objectiveLabel, "maximum NPV");
  assert.match(reranked.objectiveLabel ?? "", /maximum self-sufficiency/);
  assert.match(reranked.objectiveLabel ?? "", /re-ranked now/);
  assert.match(reranked.objectiveLabel ?? "", /scored for maximum NPV/);
  assert.notEqual(reranked.objectiveLabel, stored.objectiveLabel, "(4) the caption");
  assert.match(reranked.chosenNote ?? "", /10\.12 kW is the top array/);
  assert.match(reranked.chosenNote ?? "", /Nothing here is saved/);
  console.log(`        stored  : top=${storedTop} axis=${stored.valueLabel} caption="${stored.objectiveLabel}"`);
  console.log(`        reranked: top=${rerankTop} axis=${reranked.valueLabel} caption="${reranked.objectiveLabel}"`);
  // A test that passes when only one respect changes is not testing this:
  // Fresh reads: assert.equal narrows the consts above to their literals,
  // which would make these comparisons dead in the type system.
  const respects = [
    reranked.bars.find((b) => b.chosen)?.label !== stored.bars.find((b) => b.chosen)?.label,
    reranked.valueLabel !== stored.valueLabel,
    reranked.objectiveLabel !== stored.objectiveLabel,
    reranked.bars.findIndex((b) => b.chosen) !== stored.bars.findIndex((b) => b.chosen),
  ];
  assert.equal(respects.filter(Boolean).length, 4, `all four must differ: ${respects}`);
  // The same objective re-applied changes NOTHING but the caption — the
  // highlighted bar and the axis are identical to the stored view.
  const same = railRerankedCurve(RAIL_BASELINE8, CHANGE({ objective: "max_npv" }));
  assert.equal(same?.bars?.find((b) => b.chosen)?.label, storedTop);
  assert.equal(same?.valueLabel, stored.valueLabel);
  // ONE ranking: rankSolarPoints is what both consult.
  const r = rankSolarPoints(RAIL_BASELINE8.solarPoints, "max_self_sufficiency", null);
  assert.ok(r.ok && r.topIndex === reranked.bars.findIndex((b) => b.chosen) + 1,
    "the chart's chosen bar is the ranking's topIndex (bars omit the baseline point)");
});

// 8-B. THE TIE SENTENCE FOLLOWS THE MEASURE.
test("3.14-8 F210: the tie sentence is recomputed against the applied measure — "
  + "a tie on value is not a tie on payback", () => {
  // Ties on 25-year value (within $28) and NOT on payback (2.4 vs 4.2 vs 4.6 yr).
  const tiedOnValue = {
    ...RAIL_JOB,
    sizing_results: [{
      ...STORED_SOLAR_RUN, objective_used: "max_npv", engine_mode: "sequential",
      evaluated_options: {
        dimension_keys: ["solar_kw"], chosen_index: 2,
        points: [
          { solar_kw: 0, npv_25yr: 0, simple_payback_years: null, self_sufficiency_pct: 0, system_cost: 0 },
          { solar_kw: 1.32, npv_25yr: 17040, simple_payback_years: 2.4, self_sufficiency_pct: 18, system_cost: 2100 },
          { solar_kw: 9.24, npv_25yr: 17068, simple_payback_years: 4.2, self_sufficiency_pct: 65, system_cost: 7248 },
          { solar_kw: 11.44, npv_25yr: 17062, simple_payback_years: 4.6, self_sufficiency_pct: 72, system_cost: 8600 },
        ],
      },
    }],
  };
  const base = railBaselineView(tiedOnValue);
  const onValue = railRerankedCurve(base, CHANGE({ objective: "max_npv" }));
  const onPayback = railRerankedCurve(base, CHANGE({ objective: "min_payback" }));
  assert.ok(onValue?.bars && onPayback?.bars);
  console.log(`        max_npv     : flatNote = ${onValue.flatNote}`);
  console.log(`        min_payback : flatNote = ${onPayback.flatNote}`);
  assert.ok(onValue.flatNote, "the three tie on value — the sentence appears");
  assert.match(onValue.flatNote ?? "", /\$28/);
  assert.equal(onPayback.flatNote, null,
    "2.4 / 4.2 / 4.6 years is no tie — the sentence must NOT be carried over");
  assert.equal(onPayback.bars.find((b) => b.chosen)?.label, "1.32 kW", "shortest payback wins");
  assert.equal(onValue.bars.find((b) => b.chosen)?.label, "9.24 kW");
});

// 8-C. THE COMPARABILITY VERDICT — one outcome per reason, all distinct.
test("3.14-8 D33: the comparability verdict names each reason — five distinct "
  + "outcomes", () => {
  const same: RailRunMeta = { ...CURRENT_META, sizingResultId: "b" };
  const cases: [string, RailRunMeta][] = [
    ["fully comparable", same],
    ["different engine", { ...same, engineMode: "combined" }],
    ["different resolution", { ...same, dispatchResolution: "representative_days" }],
    ["resolution not recorded", { ...same, dispatchResolution: null }],
    ["different objective", { ...same, objectiveUsed: "min_payback" }],
  ];
  const outcomes = cases.map(([label, meta]) => {
    const v = railComparability(CURRENT_META, meta);
    const key = v.comparable ? "comparable" : v.reasons.map((r) => r.kind).join("+");
    console.log(`        ${label.padEnd(24)} -> ${key.padEnd(24)} ${v.headline.slice(0, 80)}`);
    return key;
  });
  assert.deepEqual(outcomes, [
    "comparable", "engine-differs", "resolution-differs", "resolution-not-recorded",
    "objective-differs",
  ]);
  assert.equal(new Set(outcomes).size, 5, "five distinct outcomes");
  // The engine is the HEADLINE when several reasons apply.
  const worst = railComparability(CURRENT_META, {
    ...same, engineMode: "combined", dispatchResolution: null, objectiveUsed: "custom",
  });
  assert.equal(worst.reasons.length, 3);
  assert.equal(worst.reasons[0].kind, "engine-differs");
  assert.match(worst.headline, /Different engines/);
  // A recorded silence is never read as full_year.
  const silent = railComparability(CURRENT_META, { ...same, dispatchResolution: null });
  assert.match(silent.reasons[0].text, /recorded silence/);
  assert.ok(!/like-for-like: same/i.test(silent.headline));
  // Both runs are STATED, with the objective and the engine beside each.
  assert.match(worst.currentLabel, /sequential engine/);
  assert.match(worst.currentLabel, /maximum NPV/);
  assert.match(worst.baselineLabel, /combined engine/);
  assert.match(worst.baselineLabel, /dispatch resolution not recorded/);
});

// 8-D. THE SPLIT TILE against a historical baseline.
test("3.14-8: against a historical baseline the split tile says it is current-"
  + "only, and NEVER shows the current run's split; self-sufficiency says the "
  + "history does not carry it", () => {
  const old = HISTORY.runs.find((r) => r.sizingResultId === "s-old") as RailHistoryRun;
  const current = resultsBarView(RAIL_JOB8);
  const splitLabel = current.sized ? current.valueOrigin.label : "—";
  assert.equal(splitLabel, "$17,068 + $2,867", "the current run HAS a split");
  const last = railCompareView(RAIL_BASELINE8, null, { kind: "stored" }, splitLabel);
  const hist = railCompareView(RAIL_BASELINE8, old, { kind: "stored" }, splitLabel);
  console.log(`        last run   : split tile = ${last.splitTile.text}`);
  console.log(`        historical : split tile = ${hist.splitTile.text}`);
  assert.equal(last.baseline, "last-run");
  assert.equal(last.splitTile.available, true);
  assert.equal(last.splitTile.text, splitLabel);
  assert.equal(hist.baseline, "historical");
  assert.equal(hist.splitTile.available, false);
  assert.equal(hist.splitTile.text, RAIL_SPLIT_CURRENT_ONLY);
  assert.notEqual(hist.splitTile.text, splitLabel, "never the current split beside a baseline");
  assert.ok(!hist.splitTile.text.includes("$"), "words, not a figure, and not a dash");
  assert.notEqual(hist.splitTile.text.trim(), "—");
  // The deltas read against the HISTORICAL run's figures.
  assert.equal(hist.before.solarKw, 6.6);
  assert.equal(hist.before.batteryKwh, 13.5);
  assert.equal(hist.before.npv, 15000);
  assert.equal(hist.after.solarKw, 9.24);
  const npv = hist.deltas.find((d) => d.label === "NPV");
  assert.equal(npv?.change, "+$4,936");
  // 3.14 prompt 9: this baseline recorded no marker, so its self-sufficiency
  // is a recorded silence — null, and the tile says not recorded.
  assert.equal(hist.before.selfSufficiencyPct, null);
  assert.equal(hist.selfSufficiencyNote, RAIL_SELF_SUFFICIENCY_NOT_RECORDED);
  assert.ok(!("selfConsumptionRatio" in old), "self-consumption is gone from the history");
  assert.ok(hist.comparability && !hist.comparability.comparable);
  assert.equal(hist.comparability.reasons[0].kind, "resolution-not-recorded");
  // A baseline with NO financial row: absent, not borrowed, not zero.
  const nofin = HISTORY.runs.find((r) => r.sizingResultId === "s-nofin") as RailHistoryRun;
  const h2 = railCompareView(RAIL_BASELINE8, nofin, { kind: "stored" }, splitLabel);
  assert.equal(h2.before.npv, null);
  assert.equal(h2.before.paybackYears, null);
  // F212 (b): an absent baseline figure is NOT "—" and NOT "no change" — it
  // says nothing was recorded to compare against.
  const h2npv = h2.deltas.find((d) => d.label === "NPV");
  assert.equal(h2npv?.direction, "unknown");
  assert.equal(h2npv?.change,
    railNotRecordedNote("NPV", "the baseline run"));
});

// 8-E. TRUNCATION IS ADMITTED.
test("3.14-8: a truncated history says the list is partial; a complete one "
  + "says nothing", () => {
  const complete = parseRunHistory(HISTORY_PAYLOAD);
  const partial = parseRunHistory({ ...HISTORY_PAYLOAD, total: 40, truncated: true });
  console.log(`        complete : ${railHistoryNotice(complete)}`);
  console.log(`        partial  : ${railHistoryNotice(partial)}`);
  assert.equal(railHistoryNotice(complete), null);
  const line = railHistoryNotice(partial);
  assert.ok(line, "a partial list ADMITS it");
  assert.match(line ?? "", /newest 3 of 40/);
  assert.match(line ?? "", /partial/);
  const picker = railPickerState(partial, "s-batt", null);
  assert.equal(picker.kind, "ready");
  assert.equal(picker.kind === "ready" ? picker.notice : null, line,
    "the picker carries the admission");
  // Junk never throws and never claims completeness it cannot know: a
  // `total` below the rows returned is read as the rows returned.
  for (const junk of [null, {}, { runs: "x" }, { runs: [null, 3, { sizing_result_id: "" }] }]) {
    assert.doesNotThrow(() => parseRunHistory(junk));
    assert.deepEqual(parseRunHistory(junk).runs, []);
  }
  assert.equal(parseRunHistory({ runs: HISTORY_PAYLOAD.runs, total: 1 }).total, 3);
});

// 8-F. ONE RUN: no picker, and the reason.
test("3.14-8: a one-run job offers no picker and says why; a failed history "
  + "says it could not load and never offers a shorter list", () => {
  const one = parseRunHistory({ ...HISTORY_PAYLOAD, runs: [HISTORY_PAYLOAD.runs[0]], total: 1, returned: 1 });
  const p = railPickerState(one, "s-batt", null);
  console.log(`        one run  : ${p.kind} — ${p.kind === "ready" ? "" : p.reason}`);
  assert.equal(p.kind, "nothing-to-compare");
  assert.match(p.kind === "nothing-to-compare" ? p.reason : "", /one run/);
  assert.match(p.kind === "nothing-to-compare" ? p.reason : "", /nothing to compare against yet/);
  const failed = railPickerState(null, "s-batt", "HTTP 503");
  console.log(`        failed   : ${failed.kind} — ${failed.kind === "ready" ? "" : failed.reason}`);
  assert.equal(failed.kind, "history-unavailable");
  assert.match(failed.kind === "history-unavailable" ? failed.reason : "", /could not be loaded/);
  assert.match(failed.kind === "history-unavailable" ? failed.reason : "", /last run/);
  // The picker EXCLUDES the current run — it is what the others compare against.
  const ready = railPickerState(HISTORY, "s-batt", null);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.kind === "ready" ? ready.choices.map((r) => r.sizingResultId) : [],
    ["s-old", "s-nofin"]);
  // The selection is session-scoped: a history meta is built from the run
  // itself, so a superseded selection stays exactly what it was.
  const meta = railHistoryMeta(HISTORY.runs[1]);
  assert.equal(meta.sizingResultId, "s-old");
  assert.equal(meta.dispatchResolution, null);
});

// 8-G. The wiring: the bar fetches the history from the ENDPOINT, swaps the
// curve on a re-rank, and the chart component is untouched.
test("3.14-8: the bar reads the history from GET /api/sizing/runs, swaps in the "
  + "re-ranked curve, and neither chart component nor Results tab changed", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const read = (f: string) => fs.readFileSync(path.join(FRONTEND, f), "utf8");
  const bar = read("components/worksheet/results-bar.tsx");
  assert.match(bar, /\/api\/sizing\/runs\?/, "the history comes from the lean endpoint");
  assert.ok(!/sizing_results/.test(bar), "never from the job payload's child table");
  assert.match(bar, /railRerankedCurve\(baseline, rail\.trigger\)/);
  assert.match(bar, /view=\{shownCurve\}/);
  assert.match(bar, /railCompareView\(/);
  // Every storage WRITE in the bar targets one of the two prompt-3 keys —
  // the preference and the auto-expand marker. The selection is never one.
  const writes = bar.match(/localStorage\.setItem\(\s*([A-Z_]+)/g) ?? [];
  assert.ok(writes.length >= 2, "the two prompt-3 writes still exist");
  assert.ok(writes.every((w) => /RESULTS_BAR_(AUTOEXPAND_)?STORAGE_KEY/.test(w)),
    `the baseline selection is session state, never stored: ${writes}`);
  assert.ok(!/setItem\([^)]*selected/i.test(bar));
  // The prompt-6 guards still hold.
  assert.ok(!/setTimeout|debounce/.test(bar));
  // Untouched files.
  const S = "/private/tmp/claude-501/-Volumes-OWC1TB-enrgengine/73611770-76c2-46c1-9e72-9baf6b5f2509/scratchpad/p4";
  assert.ok(!read("components/results/score-curve.tsx").includes("railRerank"),
    "the chart component knows nothing of the rail — the re-rank is in the VIEW");
});


// ── 3.14 prompt 9 — ONE rule for which option a run chose (2R.1, F195) ───────

/** A battery run whose chosen candidate has a TWIN — two candidates equal on
    usable_kwh AND system_cost — with the marker pointing at one of them. */
const TIED_BATTERY_RUN = {
  sizing_result_id: "s-tie", run_kind: "solar_battery", objective_used: "max_npv",
  engine_mode: "sequential", solar_kw: 9.24, battery_kwh: 9.83, system_cost: 11868.77,
  evaluated_options: {
    dimension_keys: ["battery_id"],
    chosen_index: 2,
    points: [
      { usable_kwh: 0, model: "No battery", system_cost: 6342, self_sufficiency_pct: 44.61 },
      { battery_id: "twin-a", usable_kwh: 9.83, model: "Twin A", system_cost: 11868.77, self_sufficiency_pct: 80.0 },
      { battery_id: "twin-b", usable_kwh: 9.83, model: "Twin B", system_cost: 11868.77, self_sufficiency_pct: 84.12 },
    ],
  },
};

// 9-A. THE MARKER WINS where the numeric match returns null on a tie.
test("3.14-9 F195: a marker pointing at one of two candidates tied on capacity "
  + "AND cost resolves — where the numeric match alone returns null", () => {
  const eo = TIED_BATTERY_RUN.evaluated_options;
  const legacy = legacySelfSufficiencyByMatch(TIED_BATTERY_RUN, eo);
  const marker = storedSelfSufficiencyPct(TIED_BATTERY_RUN, eo);
  console.log(`        tie: numeric match -> ${legacy}   marker-first -> ${marker}`);
  assert.equal(legacy, null, "the premise: the old rule cannot tell the twins apart");
  assert.equal(marker, 84.12, "the marker names Twin B, and its figure is read");
  // It flows through every reader: the bar, the Results section, the stored
  // battery section — one derivation, four callers.
  const job = { ...RAIL_JOB, sizing_results: [TIED_BATTERY_RUN] };
  const bar = resultsBarView(job);
  assert.equal(bar.sized ? bar.selfSufficiencyPct : null, 84.12);
  assert.equal(batterySizingView(job).storedRun?.run.headline?.selfSufficiencyPct, "84.12%");
  assert.equal(railBaselineView(job).figures.selfSufficiencyPct, 84.12);
  // The solar branch is the same rule, unchanged: the marker names the point.
  assert.equal(storedSelfSufficiencyPct(STORED_SOLAR_RUN, STORED_SOLAR_RUN.evaluated_options), 84.1);
});

// 9-B. THE LEGACY FALLBACK, unchanged for pre-marker runs.
test("3.14-9: a pre-marker battery run still resolves by the capacity-and-cost "
  + "match exactly as before, and a pre-marker tie is still null", () => {
  const pre = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  delete pre.evaluated_options.chosen_index;
  const eo = pre.evaluated_options;
  const viaRule = storedSelfSufficiencyPct(pre, eo);
  const viaLegacy = legacySelfSufficiencyByMatch(pre, eo);
  console.log(`        pre-marker: rule -> ${viaRule}   legacy -> ${viaLegacy}`);
  assert.equal(viaLegacy, 84.1, "the premise: the numeric match resolves this run");
  assert.equal(viaRule, 84.1, "the rule answers through the fallback — unchanged");
  const preBar = resultsBarView({ ...RAIL_JOB, sizing_results: [pre] });
  assert.equal(preBar.sized ? preBar.selfSufficiencyPct : null, 84.1);
  // A pre-marker TIE is still null — the fallback never guesses.
  const preTie = JSON.parse(JSON.stringify(TIED_BATTERY_RUN));
  delete preTie.evaluated_options.chosen_index;
  assert.equal(storedSelfSufficiencyPct(preTie, preTie.evaluated_options), null);
  // A pre-marker SOLAR run recorded nothing to read.
  const preSolar = JSON.parse(JSON.stringify(STORED_SOLAR_RUN));
  delete preSolar.evaluated_options.chosen_index;
  assert.equal(storedSelfSufficiencyPct(preSolar, preSolar.evaluated_options), null);
});

// 9-C. A CORRUPT MARKER yields null AND the fallback does not fire.
test("3.14-9: a corrupt marker yields null and does NOT fall through to the "
  + "numeric match — which would have answered", () => {
  // A run where the numeric match WOULD resolve (unique twin-free chosen
  // candidate), so a null can only mean the fallback was not consulted.
  const base = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  assert.equal(legacySelfSufficiencyByMatch(base, base.evaluated_options), 84.1,
    "the premise: the match WOULD answer on this run");
  const cases: [string, unknown][] = [
    ["out of range (99)", 99],
    ["negative", -1],
    ["not an integer", 1.5],
    ["a string", "1"],
    ["a boolean", true],
  ];
  for (const [label, idx] of cases) {
    const run = JSON.parse(JSON.stringify(base));
    run.evaluated_options.chosen_index = idx;
    const got = storedSelfSufficiencyPct(run, run.evaluated_options);
    console.log(`        corrupt marker ${label.padEnd(20)} -> ${got}  (match would give 84.1)`);
    assert.equal(got, null, label);
    assert.doesNotThrow(() => resultsBarView({ ...RAIL_JOB, sizing_results: [run] }));
  }
  // A marker naming a point with NO figure: null, not the match's 84.1.
  const noFigure = JSON.parse(JSON.stringify(base));
  delete noFigure.evaluated_options.points[1].self_sufficiency_pct;
  const gotNoFigure = storedSelfSufficiencyPct(noFigure, noFigure.evaluated_options);
  console.log(`        marker at a point with no figure -> ${gotNoFigure}  (match would give null too — so the twin proves it):`);
  assert.equal(gotNoFigure, null);
  // And the decisive twin: the marker names a point with no figure while the
  // numeric match would find a DIFFERENT, unique, figured candidate.
  const decisive = JSON.parse(JSON.stringify(TIED_BATTERY_RUN));
  decisive.evaluated_options.points[2] = { battery_id: "twin-b", usable_kwh: 9.83, model: "Twin B", system_cost: 11868.77 };
  decisive.evaluated_options.points[1].system_cost = 99999; // twin-a no longer matches the row
  decisive.evaluated_options.points.push({ battery_id: "c", usable_kwh: 9.83, model: "C", system_cost: 11868.77, self_sufficiency_pct: 70 });
  decisive.evaluated_options.chosen_index = 2;
  assert.equal(legacySelfSufficiencyByMatch(decisive, decisive.evaluated_options), null,
    "(two rows now match the row's figures — a tie — so use a cleaner fixture)");
  decisive.evaluated_options.points.pop();
  assert.equal(legacySelfSufficiencyByMatch(decisive, decisive.evaluated_options), null);
  decisive.evaluated_options.points[2].system_cost = 11868.77;
  decisive.evaluated_options.points[1] = { battery_id: "twin-a", usable_kwh: 9.83, model: "Twin A", system_cost: 11868.77, self_sufficiency_pct: 80 };
  decisive.evaluated_options.points[2] = { battery_id: "twin-b", usable_kwh: 9.83, model: "Twin B", system_cost: 55555 };
  // Now: marker -> Twin B (no figure); the match -> Twin A uniquely (80).
  assert.equal(legacySelfSufficiencyByMatch(decisive, decisive.evaluated_options), 80,
    "the premise: the match would answer 80");
  const got = storedSelfSufficiencyPct(decisive, decisive.evaluated_options);
  console.log(`        marker names a figureless point, match would say 80 -> ${got}`);
  assert.equal(got, null, "the fallback did NOT fire — a corrupt marker is not hidden behind a plausible number");
});

// 9-D. self_consumption_ratio appears NOWHERE in the feature.
test("3.14-9: self_consumption_ratio and selfConsumptionRatio appear nowhere in "
  + "the history endpoint, the lib or the bar", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const read = (f: string) => fs.readFileSync(path.join(FRONTEND, f), "utf8");
  assert.ok(!read("lib/worksheet.ts").includes("selfConsumptionRatio"));
  assert.ok(!read("lib/worksheet.ts").includes("self_consumption_ratio"));
  assert.ok(!read("components/worksheet/results-bar.tsx").includes("elfConsumption"));
  assert.ok(!read("components/worksheet/results-bar.tsx").includes("self_consumption"));
  // The endpoint's projection and summary — by name, in the route source.
  const route = read("../backend/routes/sizing.py");
  const runsBlock = route.slice(route.indexOf("_RUNS_SELECT = ("), route.indexOf("@router.get(\"/api/sizing/runs\")"));
  assert.ok(!runsBlock.includes("self_consumption_ratio"), "not in the history projection or summary");
  assert.ok(runsBlock.includes("self_sufficiency_pct"), "the tile's quantity is what travels");
  assert.ok(runsBlock.includes("_chosen_self_sufficiency"), "projected by the marker");
  // The parser reads the new field and nothing of the old.
  const parsed = parseRunHistory(HISTORY_PAYLOAD);
  assert.equal(parsed.runs[0].selfSufficiencyPct, 84.12);
  assert.ok(!("selfConsumptionRatio" in parsed.runs[0]));
});

// 9-E. THE TILE COMPARES — two outcomes.
test("3.14-9: self-sufficiency compares against a historical baseline that "
  + "recorded a marker, and says not-recorded against one that did not", () => {
  const splitLabel = "$17,068 + $2,867";
  const withMarker: RailHistoryRun = {
    ...(HISTORY.runs.find((r) => r.sizingResultId === "s-old") as RailHistoryRun),
    sizingResultId: "s-marked", selfSufficiencyPct: 76.6, hasChosenMarker: true,
    dispatchResolution: "full_year",
  };
  const compared = railCompareView(RAIL_BASELINE8, withMarker, { kind: "stored" }, splitLabel);
  const ss = compared.deltas.find((d) => d.label === "Self-sufficiency");
  console.log(`        marked baseline   : before=${compared.before.selfSufficiencyPct} after=${compared.after.selfSufficiencyPct} change=${ss?.change} note=${compared.selfSufficiencyNote}`);
  assert.equal(compared.before.selfSufficiencyPct, 76.6);
  assert.equal(compared.after.selfSufficiencyPct, 84.1);
  assert.equal(ss?.change, "+7.5 pts");
  assert.equal(ss?.direction, "up");
  assert.equal(compared.selfSufficiencyNote, null, "a real comparison — no caveat");

  const silent = HISTORY.runs.find((r) => r.sizingResultId === "s-old") as RailHistoryRun;
  const notRecorded = railCompareView(RAIL_BASELINE8, silent, { kind: "stored" }, splitLabel);
  const ss2 = notRecorded.deltas.find((d) => d.label === "Self-sufficiency");
  console.log(`        pre-marker baseline: before=${notRecorded.before.selfSufficiencyPct} change=${ss2?.change} note=${notRecorded.selfSufficiencyNote}`);
  assert.equal(notRecorded.before.selfSufficiencyPct, null);
  assert.equal(notRecorded.selfSufficiencyNote, RAIL_SELF_SUFFICIENCY_NOT_RECORDED);
  assert.match(notRecorded.selfSufficiencyNote ?? "", /not recorded/);
  assert.ok(!/—$/.test(notRecorded.selfSufficiencyNote ?? ""), "never a dash alone");
  // Two distinct outcomes.
  assert.notEqual(compared.selfSufficiencyNote, notRecorded.selfSufficiencyNote);
  assert.notEqual(ss?.change, ss2?.change);
});


// ── 3.14 F212 — an absence is not a zero, and the warning says the negative ──

// F212-A. THE MISSING NEGATIVE: assert the MEANING, not that a string exists.
test("3.14 F212: the incomparability warning says the run recorded NO dispatch "
  + "resolution — the sentence asserts the negative", () => {
  const base: RailRunMeta = {
    sizingResultId: "b", createdAt: "2026-08-20T05:00:00Z", runKind: "solar_battery",
    engineMode: "sequential", dispatchResolution: "full_year", objectiveUsed: "max_npv",
  };
  const cases: [string, RailRunMeta, RailRunMeta][] = [
    ["baseline silent", base, { ...base, dispatchResolution: null }],
    ["current silent", { ...base, dispatchResolution: null }, base],
    ["both silent", { ...base, dispatchResolution: null }, { ...base, dispatchResolution: null }],
  ];
  const texts: string[] = [];
  for (const [label, current, baseline] of cases) {
    const v = railComparability(current, baseline);
    const reason = v.reasons.find((r) => r.kind === "resolution-not-recorded");
    assert.ok(reason, `${label}: the reason is raised`);
    const text = reason.text;
    texts.push(text);
    console.log(`        ${label.padEnd(16)} ${text}`);
    // THE MEANING: it must say a resolution was NOT recorded. A test that
    // only checked the string was non-empty passed all week while the
    // sentence said the opposite.
    assert.match(text, /recorded (no dispatch resolution|a dispatch resolution)/);
    assert.ok(
      /recorded no dispatch resolution/.test(text)
        || /Neither run recorded a dispatch resolution/.test(text),
      `${label}: must assert the NEGATIVE, got: ${text}`,
    );
    // The exact phrase that was wrong must not reappear in any voice.
    assert.ok(!/(The current run|The baseline) recorded its dispatch resolution/.test(text),
      `${label}: the self-contradicting clause is back`);
    assert.ok(!/Neither run recorded no dispatch/.test(text), `${label}: double negative`);
    // The rest of the wording is right and is kept.
    assert.match(text, /a recorded silence, not a full-year run/);
    assert.match(text, /Whether the two dispatched alike cannot be stated/);
    assert.equal(v.comparable, false, `${label}: never like-for-like`);
  }
  assert.equal(new Set(texts).size, 3, "each case names WHICH run was silent");
});

// F212-B. THE THREE DELTA OUTCOMES, distinct.
test("3.14 F212: a delta has THREE outcomes — changed, no change, and not "
  + "recorded — and they are three DISTINCT results", () => {
  const figs = (npv: number | null): RailFigures => ({
    solarKw: 9.24, batteryKwh: 9.83, paybackYears: 4.4, npv,
    selfSufficiencyPct: 84.1, basis: "whole-system",
  });
  const npvOf = (before: number | null, after: number | null) =>
    railDeltas(figs(before), figs(after)).find((d) => d.label === "NPV") as RailDelta;
  const changed = npvOf(15000, 19935.55);
  const equal = npvOf(19935.55, 19935.55);
  const absent = npvOf(null, 19935.55);
  for (const [label, d] of [["changed", changed], ["no change", equal], ["absent", absent]] as const) {
    console.log(`        ${label.padEnd(10)} direction=${d.direction.padEnd(8)} before=${d.before.padEnd(14)} change=${d.change}`);
  }
  assert.deepEqual(
    [changed.direction, equal.direction, absent.direction],
    ["up", "none", "unknown"],
    "three directions, one per outcome",
  );
  assert.equal(changed.change, "+$4,936");
  assert.equal(equal.change, "no change");
  assert.equal(absent.change, railNotRecordedNote("NPV", "the baseline run"));
  // THREE DISTINCT RESULTS. Merge "absent" into "no change" and this fails.
  const words = [changed.change, equal.change, absent.change];
  assert.equal(new Set(words).size, 3, `three distinct words: ${words}`);
  assert.notEqual(absent.change, equal.change, "an absence is NOT stability");
  assert.notEqual(absent.direction, equal.direction);
  // The absent case says WHY, and names the figure.
  assert.match(absent.change, /was not recorded/);
  assert.match(absent.change, /nothing to compare it against/);
  assert.match(absent.change, /^NPV /);
  // It follows the existing wording rather than inventing a fourth voice.
  assert.ok(RAIL_SELF_SUFFICIENCY_NOT_RECORDED.includes("was not recorded for"));
  assert.ok(absent.change.includes("was not recorded for"));
  assert.ok(RAIL_SELF_SUFFICIENCY_NOT_RECORDED.includes("nothing to compare it against"));
  assert.ok(absent.change.includes("nothing to compare it against"));
  // The before TEXT is the words, never the formatter's null rendering —
  // formatYears(null) is a MEANING ("no payback within the analysis period").
  const pay = railDeltas(
    { ...figs(1), paybackYears: null }, { ...figs(1), paybackYears: 4.4 },
  ).find((d) => d.label === "Payback") as RailDelta;
  console.log(`        payback absent before="${pay.before}" change=${pay.change}`);
  assert.equal(pay.before, "not recorded");
  assert.notEqual(pay.before, formatYears(null));
  assert.ok(!pay.before.includes("no payback within the analysis period"),
    "the exact substitution F212 (b) reported");
});

// F212-C. ZERO IS A REAL VALUE.
test("3.14 F212: zero is not absent — 0 vs 0 is no change, 0 vs a number is "
  + "the change", () => {
  const figs = (npv: number | null, pay: number | null): RailFigures => ({
    solarKw: 1, batteryKwh: 0, paybackYears: pay, npv,
    selfSufficiencyPct: 0, basis: "whole-system",
  });
  const d = (b: RailFigures, a: RailFigures, label: string) =>
    railDeltas(b, a).find((x) => x.label === label) as RailDelta;
  const zeroZero = d(figs(0, 0), figs(0, 0), "NPV");
  const zeroUp = d(figs(0, 0), figs(1200, 0), "NPV");
  const downToZero = d(figs(1200, 0), figs(0, 0), "NPV");
  const payZero = d(figs(0, 0), figs(0, 0), "Payback");
  const battZero = d(figs(0, 0), figs(0, 0), "Battery");
  const ssZero = d(figs(0, 0), figs(0, 0), "Self-sufficiency");
  console.log(`        0 vs 0     -> ${zeroZero.direction} / ${zeroZero.change}`);
  console.log(`        0 vs 1200  -> ${zeroUp.direction} / ${zeroUp.change}`);
  console.log(`        1200 vs 0  -> ${downToZero.direction} / ${downToZero.change}`);
  for (const z of [zeroZero, payZero, battZero, ssZero]) {
    assert.equal(z.direction, "none", `${z.label}: zero vs zero is no change`);
    assert.equal(z.change, "no change");
    assert.notEqual(z.direction, "unknown", `${z.label}: 0 must NEVER read as absent`);
  }
  assert.equal(zeroUp.direction, "up");
  assert.equal(zeroUp.change, "+$1,200");
  assert.equal(downToZero.direction, "down");
  assert.equal(downToZero.change, "−$1,200");
  // A zero payback and a zero self-sufficiency render as figures, not words.
  assert.equal(payZero.before, formatYears(0));
  assert.equal(ssZero.before, formatPct(0));
  assert.notEqual(payZero.before, "not recorded");
});

// F212-D. ABSENCE IN EITHER DIRECTION, AND IN BOTH.
test("3.14 F212: absence is handled in BOTH directions and when both are "
  + "absent — three different reasons, none of them 'no change'", () => {
  const figs = (npv: number | null): RailFigures => ({
    solarKw: 9.24, batteryKwh: null, paybackYears: null, npv,
    selfSufficiencyPct: null, basis: "whole-system",
  });
  const npvOf = (b: number | null, a: number | null) =>
    railDeltas(figs(b), figs(a)).find((d) => d.label === "NPV") as RailDelta;
  const baselineGone = npvOf(null, 19935.55);
  const currentGone = npvOf(19935.55, null);
  const bothGone = npvOf(null, null);
  for (const [label, d] of [
    ["baseline absent", baselineGone], ["current absent", currentGone], ["both absent", bothGone],
  ] as const) {
    console.log(`        ${label.padEnd(16)} direction=${d.direction} before="${d.before}" after="${d.after}" change=${d.change}`);
    assert.equal(d.direction, "unknown", label);
    assert.notEqual(d.change, "no change", `${label}: both absent is NOT stability either`);
    assert.match(d.change, /nothing to compare it against/);
  }
  assert.equal(baselineGone.change, railNotRecordedNote("NPV", "the baseline run"));
  assert.equal(currentGone.change, railNotRecordedNote("NPV", "the current figures"));
  assert.equal(bothGone.change, railNotRecordedNote("NPV", "either run"));
  assert.equal(new Set([baselineGone.change, currentGone.change, bothGone.change]).size, 3,
    "the reason that applies is the reason said");
  assert.equal(baselineGone.before, "not recorded");
  assert.equal(baselineGone.after, formatMoney(19935.55));
  assert.equal(currentGone.after, "not recorded");
  assert.equal(bothGone.before, "not recorded");
  assert.equal(bothGone.after, "not recorded");
});

// F212-E. THE SWEEP: every before-and-after caption, against null figures.
test("3.14 F212 sweep: every rail caption survives a null baseline and a null "
  + "current figure without claiming stability or printing a formatter's null", () => {
  const NOTHING: RailFigures = {
    solarKw: null, batteryKwh: null, paybackYears: null, npv: null,
    selfSufficiencyPct: null, basis: "whole-system",
  };
  const REAL: RailFigures = {
    solarKw: 9.24, batteryKwh: 9.83, paybackYears: 4.4, npv: 19935.55,
    selfSufficiencyPct: 84.1, basis: "whole-system",
  };
  // (1) all five railDeltas captions, both directions and both-absent.
  for (const [b, a] of [[NOTHING, REAL], [REAL, NOTHING], [NOTHING, NOTHING]] as const) {
    for (const d of railDeltas(b, a)) {
      assert.equal(d.direction, "unknown", d.label);
      assert.notEqual(d.change, "no change", d.label);
      assert.notEqual(d.change, "—", `${d.label}: a bare dash says nothing`);
      assert.ok(!d.before.includes("no payback within the analysis period"), d.label);
      assert.ok(!d.after.includes("no payback within the analysis period"), d.label);
    }
  }
  console.log(`        railDeltas x5, null baseline: ${railDeltas(NOTHING, REAL).map((d) => `${d.label}=${d.direction}`).join(" ")}`);
  // (2) railStatusLine on every state — carries no figures, and never throws.
  const physics = CHANGE({ kind: "physics", section: "energy-data" });
  const states: RailState[] = [
    { kind: "stored" },
    railRerank(RAIL_BASELINE8, CHANGE({ objective: "max_npv" })),
    railRerank(RAIL_BASELINE8, CHANGE({ objective: "custom" })),
    { kind: "recosting", trigger: physics, startedAt: 1 },
    railFailedState(physics, "the engine did not answer."),
  ];
  for (const s of states) {
    assert.doesNotThrow(() => railStatusLine(s));
    const line = railStatusLine(s) ?? "";
    assert.ok(!line.includes("no payback within the analysis period"), s.kind);
  }
  console.log(`        railStatusLine x${states.length}: no figures carried, none threw`);
  // (3) the re-rank note when the run recorded no chosen array.
  const noArray = JSON.parse(JSON.stringify(STORED_BATTERY_RUN));
  noArray.solar_kw = null;
  noArray.objective_used = "max_npv";
  const noArrayBase = railBaselineView({ ...RAIL_JOB, sizing_results: [noArray] });
  const moved = railRerank(noArrayBase, CHANGE({ objective: "max_self_sufficiency" }));
  if (moved.kind === "reranked") {
    console.log(`        re-rank note, no stored array: ${moved.note}`);
    assert.ok(!/rather than —/.test(moved.note), "never a bare dash mid-sentence");
    assert.match(moved.note, /did not record/);
    // The sweep's own find: a words-for-absence substitution must still read
    // as English where the sentence appends a noun.
    assert.ok(!/the an array/.test(moved.note), `ungrammatical: ${moved.note}`);
    assert.ok(!/record array/.test(moved.note), `ungrammatical: ${moved.note}`);
  }
  // (4) the re-ranked chart's chosenNote — same guard.
  const curveNote = railRerankedCurve(noArrayBase, CHANGE({ objective: "max_npv" }))?.chosenNote ?? "";
  assert.ok(!/chose —/.test(curveNote), "the chart caption never prints a bare dash as a size");
  console.log(`        re-ranked chart caption: ${curveNote.slice(0, 90)}…`);
  // (5) railRunLabel on a wholly unrecorded run — words, never blanks.
  const blank = railRunLabel({
    sizingResultId: null, createdAt: null, runKind: null, engineMode: null,
    dispatchResolution: null, objectiveUsed: null,
  });
  console.log(`        railRunLabel, nothing recorded: ${blank}`);
  for (const part of ["date not recorded", "kind not recorded", "objective not recorded",
                      "engine not recorded", "dispatch resolution not recorded"]) {
    assert.ok(blank.includes(part), part);
  }
  // (6) the component's own captions are swept by the source test below.
});

test("3.14 F212 sweep: the component renders the third outcome as the sentence "
  + "alone, withholds the sign, and the hero tile has words for an empty baseline", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const bar = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/results-bar.tsx"), "utf8");
  assert.match(bar, /if \(d\.direction === "unknown"\) return d\.change;/,
    "the sentence alone — never prefixed with a baseline that does not exist");
  assert.match(bar, /d\.direction === "none" \|\| d\.direction === "unknown"\) return undefined/,
    "an absence is neither good nor bad, so it is not coloured");
  assert.match(bar, /the baseline run recorded no system to compare against/);
  assert.match(bar, /the previous figures were not recorded/);
  // ORDER MATTERS: the unknown branch must run BEFORE the two-way one, or
  // an absent figure falls into "was <before> · <sentence>".
  const fn = bar.slice(bar.indexOf("const tileDelta"), bar.indexOf("const tileSign"));
  assert.ok(fn.indexOf('=== "unknown"') < fn.indexOf('=== "none"'),
    "the unknown branch precedes the two-way one");
});


// ── 3.14b prompt 3 — Equipment & specs announces its save (D37, D30) ─────────
//
// A .tsx file cannot be imported into this runner (node --experimental-strip-types
// erases types but does not transform JSX; the import fails with
// ERR_UNKNOWN_FILE_EXTENSION), so the component's decision is asserted on the
// shipped source — as every other component assertion in this suite is. Where a
// case turns on WHAT `dirty` means, the test EVALUATES the component's own
// `dirty` expression rather than restating it (2R.1).

/** The component's shipped `dirty` expression, lifted out and made callable.
    Nothing here is re-typed: if the expression changes, this changes with it. */
async function equipmentDirty(): Promise<
  (form: Record<string, string>, baseline: Record<string, string>) => boolean
> {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/equipment-specs-section.tsx"), "utf8");
  const start = src.indexOf("const dirty =");
  assert.ok(start > 0, "the component still has a `dirty` flag");
  const expr = src.slice(start + "const dirty =".length, src.indexOf(";", start));
  assert.ok(/form\./.test(expr) && /baseline\./.test(expr), `unexpected dirty expression: ${expr}`);
  const fn = new Function("form", "baseline", `return (${expr});`) as (
    f: Record<string, string>, b: Record<string, string>,
  ) => boolean;
  return fn;
}

/** The save() body, from its opening to the `finally` — the region every
    ordering assertion below is made against. */
async function equipmentSaveBody(): Promise<string> {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/equipment-specs-section.tsx"), "utf8");
  const start = src.indexOf("  async function save() {");
  assert.ok(start > 0, "save() is still where the announce belongs");
  const end = src.indexOf("  function setDraftField(", start);
  assert.ok(end > start, "save() still ends before setDraftField");
  return src.slice(start, end);
}

// (a) A SAVE THAT MOVED A PIN announces exactly once, kind "physics".
test("3.14b-3: a save that changes an equipment id announces exactly once, with "
  + "kind physics, and only after the row has actually been written", async () => {
  const body = await equipmentSaveBody();
  const sites = body.match(/onSaved\?\.\(/g) ?? [];
  assert.equal(sites.length, 1, "exactly one announce site inside save()");
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const whole = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/equipment-specs-section.tsx"), "utf8");
  assert.equal((whole.match(/onSaved\?\.\(/g) ?? []).length, 1,
    "and exactly one in the whole file — createUnit() does not announce");
  assert.match(body, /onSaved\?\.\(\{ kind: "equipment" \}\)/,
    'the one kind it emits is "equipment" — a re-cost whose answer may differ');
  assert.ok(!/kind: "objective-budget"/.test(whole),
    "equipment is never an objective-budget change");
  assert.ok(!/kind: "physics"/.test(whole),
    'and no longer "physics" — the substitution guards must stand down (3.14b-4)');
  // The optional-call form: `onSaved` absent must not throw.
  assert.ok(!/[^?]\.\(|onSaved\(/.test(body.replace(/onSaved\?\.\(/g, "")),
    "the callback is invoked optionally, never as a bare call");
  // It fires AFTER the tick that means the row is written.
  assert.ok(body.indexOf("setSavedTick(true)") < body.indexOf("onSaved?.("),
    "the announce follows the save, never precedes it");
  // The change it announces is real: one moved id makes dirty true.
  const dirty = await equipmentDirty();
  assert.equal(
    dirty({ panels: "p-2", inverters: "i-1", batteries: "b-1" },
          { panels: "p-1", inverters: "i-1", batteries: "b-1" }),
    true, "a changed panel id is a change");
  assert.equal(
    dirty({ panels: "p-1", inverters: "i-1", batteries: "b-2" },
          { panels: "p-1", inverters: "i-1", batteries: "b-1" }),
    true, "a changed battery id is a change");
});

// (b) THE CONFIRMATION-ONLY SAVE — RED PROOF. D30 keeps Save enabled with
// nothing dirty; that save changes no engine input, so it must stay silent.
test("3.14b-3 D30: a confirmation-only save announces NOTHING — the announce is "
  + "guarded by the component's own dirty flag, and that flag is false when "
  + "nothing moved", async () => {
  const body = await equipmentSaveBody();
  // THE GUARD. Removing it is what this test exists to catch.
  assert.match(body, /if \(dirty\) onSaved\?\.\(/,
    "the announce is guarded by `dirty` — a confirmation-only save fires nothing");
  // ...and the guard is not decorative: it is false for a save that moved nothing.
  const dirty = await equipmentDirty();
  const same = { panels: "p-1", inverters: "i-1", batteries: "b-1" };
  assert.equal(dirty({ ...same }, { ...same }), false,
    "nothing moved -> dirty false -> no announce");
  const autos = { panels: "", inverters: "", batteries: "" };
  assert.equal(dirty({ ...autos }, { ...autos }), false,
    "three Autos confirmed for the first time is still not an engine-input change");
  // equipment_confirmed still travels on EVERY save — the silence is the rail's,
  // not the write's. D30 is untouched.
  assert.match(body, /payload\.equipment_confirmed = true;/,
    "pressing Save is still the confirmation");
  assert.ok(body.indexOf("payload.equipment_confirmed = true;") < body.indexOf("if (dirty) onSaved"),
    "the row is written unconditionally; only the announcement is conditional");
});

// (c) A FAILED SAVE announces nothing — both failure shapes.
test("3.14b-3: a failed save announces nothing, and neither does a 200 whose "
  + "returned row disagrees with what was sent", async () => {
  const body = await equipmentSaveBody();
  // Located by the CALL, not by the guard — this test is about ordering, and
  // must fail for its own reason rather than borrowing test (b)'s.
  const announce = body.indexOf("onSaved?.(");
  assert.ok(announce > 0, "there is an announce site to order against");
  // Both early returns stand BEFORE the announce, so neither path reaches it.
  const httpFail = body.indexOf("if (!result.ok) {");
  const rowFail = body.indexOf("if (notices.length > 0) {");
  assert.ok(httpFail > 0 && rowFail > 0, "both failure branches are still there");
  assert.ok(httpFail < announce, "the transport failure returns before the announce");
  assert.ok(rowFail < announce, "the disagreeing-row failure returns before the announce");
  for (const [name, at] of [["http", httpFail], ["row", rowFail]] as const) {
    const branch = body.slice(at, announce);
    assert.match(branch, /return;/, `${name} branch returns rather than falling through`);
  }
  // Nothing announces outside save(): the drawer's createUnit writes a catalogue
  // row, not a job pin, and the job's own ids are untouched by it.
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const whole = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/equipment-specs-section.tsx"), "utf8");
  const after = whole.slice(whole.indexOf("  function setDraftField("));
  assert.ok(!after.includes("onSaved"), "createUnit and the render announce nothing");
});

// (d) CLEARING A PIN BACK TO AUTO is a change and DOES announce.
test("3.14b-3: clearing a pin back to Auto is a change — dirty is true, the "
  + "column is cleared with an explicit null, and the rail is told", async () => {
  const dirty = await equipmentDirty();
  assert.equal(
    dirty({ panels: "", inverters: "i-1", batteries: "b-1" },
          { panels: "p-1", inverters: "i-1", batteries: "b-1" }),
    true, "Auto after a pin is a change, so the rail hears about it");
  // Auto travels as an explicit null, which is what makes the engine fall back
  // to the roof's own panel — the thing the re-cost will then measure.
  const body = await equipmentSaveBody();
  assert.match(body, /payload\[API_FIELD\[kind\]\] = form\[kind\] === "" \? null : form\[kind\];/,
    "Auto is an explicit null, never an absent key");
  assert.match(body, /if \(form\[kind\] === baseline\[kind\]\) continue;/,
    "an untouched kind is absent — absent and null are different facts");
});

// (e) THE RAIL TREATS IT LIKE EVERY OTHER PHYSICS SAVE — no new kind, no new
// branch, and the bar was not touched to make this work.
test("3.14b-3: the bar re-costs an equipment save through the SAME branch every "
  + "other physics save uses — no new kind, no new request field", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const bar = fs.readFileSync(
    path.join(FRONTEND, "components/worksheet/results-bar.tsx"), "utf8");
  assert.match(bar, /if \(change\.kind === "objective-budget"\) \{[\s\S]*?\} else \{\s*void recost\(change\);/,
    "anything that is not objective-budget re-costs — physics needs no branch of its own");
  // The kind set, DERIVED from the union in lib rather than restated here.
  const lib = fs.readFileSync(path.join(FRONTEND, "lib/worksheet.ts"), "utf8");
  const union = lib.slice(
    lib.indexOf("export type SizingInputChangeKind ="),
    lib.indexOf(";", lib.indexOf("export type SizingInputChangeKind =")));
  const kinds = [...union.matchAll(/^  \| "([a-z-]+)"/gm)].map((m) => m[1]);
  console.log(`        change kinds : ${kinds.join(", ")}`);
  assert.deepEqual(kinds, ["objective-budget", "physics", "equipment"],
    "exactly three kinds — 3.14b prompt 4 added equipment, and nothing else");
  // The re-cost pins the stored run's ARRAY SIZE and battery and sends no panel
  // id at all — the job's own pin is what the engine will resolve (D37: the
  // rail re-costs, it never re-searches).
  const body = railRecostRequest(RAIL_BASELINE, "job-1");
  assert.ok(body, "the fixture run can be pinned");
  const sent = JSON.stringify(body);
  for (const key of ["panel_id", "panel_ids", "equipment_panel_id", "inverter_id", "inverter_ids"]) {
    assert.ok(!sent.includes(key), `the re-cost sends no ${key} — the job's pin wins`);
  }
  assert.equal(body.persist, false, "and stores nothing");
});


// ── 3.14b prompt 4 — the substitution guards stand down for kind "equipment",
// and ONLY for it. A changed pin NECESSARILY answers with different kit (a
// 455 W Aiko cannot rebuild a 440 W Maxeon array), so on that kind the rail
// accepts the different system and NAMES what moved, in figures. On every
// other kind both guards fire exactly as before — that is the safety property,
// and (b)/(d) below were red-proven against a let-everything-through condition.
// The response fields the sentence names were PRINTED from a live run in this
// task: chosen_solar.panel_count/solar_kw, optimal.panel_count/solar_kw,
// optimal_battery.model/usable_kwh. The changed-array figures (19 panels,
// 8.645 kW against the stored 440 W array) are that live run's own.

const EQUIPMENT = CHANGE({ kind: "equipment", section: "equipment-specs" });
const EQ_OK = {
  flags: [RAIL_DECLINE_FLAG, "not_persisted_by_request"],
  engine_mode: "sequential", resolution: "full_year", constraint_deltas: null,
  chosen_solar: { solar_kw: 9.24, panel_count: 21 },
  optimal_battery: { battery_id: "b1", usable_kwh: 9.83, model: "GoodWe Lynx Home F",
    system_cost: 12000, annual_savings_vs_solar_only: 300, incremental_npv: 2900,
    self_sufficiency_pct: 85 },
  solar_options: { chosen_index: 1, points: [{}, { annual_savings: 1800, npv_25yr: 17100 }] },
};

// (a) equipment + a changed ARRAY -> accepted, and the sentence carries the
// count and kW on BOTH sides.
test("3.14b-4: kind equipment + a changed array is ACCEPTED, and the sentence "
  + "names the panel count and kW on both sides — never a bare 'changed'", () => {
  const resp = { ...EQ_OK, chosen_solar: { solar_kw: 8.645, panel_count: 19 } };
  const st = railRecostState(RAIL_BASELINE, EQUIPMENT, resp);
  assert.equal(st.kind, "recosted", st.kind === "failed" ? st.reason : "");
  if (st.kind !== "recosted") return;
  console.log(`        moved: ${st.moved}`);
  assert.ok(st.moved, "an equipment change that moved the array SAYS so");
  assert.ok(st.moved.includes("21 panels (9.24 kW)"), `before side: ${st.moved}`);
  assert.ok(st.moved.includes("19 panels (8.645 kW)"), `after side: ${st.moved}`);
  assert.ok(!st.moved.includes("battery"), "the battery did not move, so it is not named");
  assert.equal(st.after.solarKw, 8.645, "the after figures ARE the answer");
  // The one line under the tiles carries the sentence AND the provenance AND
  // the not-saved words — the bar renders railStatusLine, untouched.
  const line = railStatusLine(st) ?? "";
  console.log(`        line : ${line}`);
  assert.ok(line.startsWith("The pinned equipment changed the system:"), line);
  assert.match(line, /sequential engine/);
  assert.match(line, /not saved/i);
  // The SOLAR route's shape, through the same guard. A solar baseline's count
  // comes from the chosen curve point (panels_per_plane [21] on the fixture),
  // so both sides carry counts here.
  const solarBase = railBaselineView({ ...RAIL_JOB, sizing_results: [STORED_SOLAR_RUN] });
  const solarResp = {
    flags: [RAIL_DECLINE_FLAG], engine_mode: "sequential",
    optimal: { solar_kw: 8.645, panel_count: 19, simple_payback_years: 5.1,
      npv_25yr: 17000, self_sufficiency_pct: 40.2 },
  };
  const sst = railRecostState(solarBase, EQUIPMENT, solarResp);
  assert.equal(sst.kind, "recosted", sst.kind === "failed" ? sst.reason : "");
  if (sst.kind !== "recosted") return;
  console.log(`        solar: ${sst.moved}`);
  assert.ok(sst.moved?.includes("was 21 panels (9.24 kW), now 19 panels (8.645 kW)"), `${sst.moved}`);
  // ...and a run that recorded NO per-plane counts shows what IS carried on
  // the before side — the kW — and invents nothing.
  const noCount = JSON.parse(JSON.stringify(STORED_SOLAR_RUN));
  delete noCount.evaluated_options.points[1].panels_per_plane;
  const ncBase = railBaselineView({ ...RAIL_JOB, sizing_results: [noCount] });
  assert.equal(ncBase.chosen.panelsPerPlane, null, "the count is genuinely absent");
  const nst = railRecostState(ncBase, EQUIPMENT, solarResp);
  assert.equal(nst.kind, "recosted");
  if (nst.kind === "recosted") {
    console.log(`        no-count: ${nst.moved}`);
    assert.ok(nst.moved?.includes("was 9.24 kW, now 19 panels (8.645 kW)"), `${nst.moved}`);
    assert.ok(!/undefined|null|NaN/.test(nst.moved ?? ""), "no formatter leak");
  }
  // And an equipment save that moved NOTHING carries no sentence: the line is
  // the provenance alone, exactly as a physics re-cost reads.
  const same = railRecostState(RAIL_BASELINE, EQUIPMENT, EQ_OK);
  assert.equal(same.kind, "recosted");
  if (same.kind === "recosted") {
    assert.equal(same.moved, null, "nothing moved -> nothing claimed");
    assert.equal(railStatusLine(same), same.provenance.label);
  }
});

// (b) physics + a changed ARRAY -> STILL REFUSED, same wording as today.
// RED-PROVEN: fails when the guard is written to let everything through.
test("3.14b-4: kind physics + a changed array is STILL refused with today's "
  + "wording — the guard stood down for equipment only", () => {
  const physics = CHANGE({ kind: "physics", section: "tariff-network" });
  const resp = { ...EQ_OK, chosen_solar: { solar_kw: 8.645, panel_count: 19 } };
  const st = railRecostState(RAIL_BASELINE, physics, resp);
  assert.equal(st.kind, "failed", "a physics save must not move the array");
  if (st.kind !== "failed") return;
  assert.equal(st.reason,
    "The engine answered with a different array from the stored run's, so this is not a re-cost of the stored system.");
});

// (c) equipment + a changed BATTERY -> accepted and named on both sides.
test("3.14b-4: kind equipment + a changed battery is ACCEPTED, and the sentence "
  + "names the model on both sides", () => {
  const resp = { ...EQ_OK, optimal_battery: { battery_id: "b2", usable_kwh: 13.5,
    model: "Tesla Powerwall", system_cost: 16000, annual_savings_vs_solar_only: 400,
    incremental_npv: 1200, self_sufficiency_pct: 90.2 } };
  const st = railRecostState(RAIL_BASELINE, EQUIPMENT, resp);
  assert.equal(st.kind, "recosted", st.kind === "failed" ? st.reason : "");
  if (st.kind !== "recosted") return;
  console.log(`        moved: ${st.moved}`);
  assert.ok(st.moved?.includes("GoodWe Lynx Home F (9.83 kWh)"), `before: ${st.moved}`);
  assert.ok(st.moved?.includes("Tesla Powerwall (13.5 kWh)"), `after: ${st.moved}`);
  assert.ok(!st.moved?.includes("array"), "the array did not move, so it is not named");
  assert.equal(st.after.batteryKwh, 13.5);
  // A response whose battery carries NO model still answers with what it does
  // carry — the kWh — and invents nothing.
  const anon = { ...EQ_OK, optimal_battery: { battery_id: "b2", usable_kwh: 13.5,
    system_cost: 16000, annual_savings_vs_solar_only: 400, incremental_npv: 1200,
    self_sufficiency_pct: 90.2 } };
  const ast = railRecostState(RAIL_BASELINE, EQUIPMENT, anon);
  assert.equal(ast.kind, "recosted");
  if (ast.kind === "recosted") {
    console.log(`        anon : ${ast.moved}`);
    assert.ok(ast.moved?.includes("now 13.5 kWh"), `${ast.moved}`);
    assert.ok(!/undefined|null/.test(ast.moved ?? ""), "no formatter leak");
  }
});

// (d) physics + a changed BATTERY -> STILL REFUSED, same wording as today.
// RED-PROVEN alongside (b).
test("3.14b-4: kind physics + a changed battery is STILL refused with today's "
  + "wording", () => {
  const physics = CHANGE({ kind: "physics", section: "energy-data" });
  const resp = { ...EQ_OK, optimal_battery: { ...EQ_OK.optimal_battery,
    battery_id: "b2", usable_kwh: 13.5, model: "Tesla Powerwall" } };
  const st = railRecostState(RAIL_BASELINE, physics, resp);
  assert.equal(st.kind, "failed", "a physics save must not swap the battery");
  if (st.kind !== "failed") return;
  assert.equal(st.reason,
    "The engine answered with a different battery from the stored run's, so this is not a re-cost of the stored system.");
});

// Every UNTOUCHED guard still fires under kind "equipment" — they are about
// the engine's honesty, not about which system it answered for.
test("3.14b-4: all six untouched guards still fire on an equipment change — "
  + "decline flag, contradiction, catalogue, engine_mode, resolution, no figures", () => {
  const cases: [string, unknown, RegExp][] = [
    ["decline flag missing", { ...EQ_OK, flags: ["not_persisted_by_request"] },
      /did not confirm it skipped the comparison/],
    ["declined AND deltas (contradiction)", { ...EQ_OK, constraint_deltas: { battery_kwh: 0 } },
      /contradictory/],
    ["battery gone from catalogue", { ...EQ_OK,
      flags: [RAIL_DECLINE_FLAG, "battery_ids not in the active catalogue — not evaluated: ['b1']"] },
      /no longer in the catalogue/],
    ["engine_mode missing", { ...EQ_OK, engine_mode: undefined },
      /did not say which engine/],
    ["resolution missing", { ...EQ_OK, resolution: undefined },
      /dispatch resolution/],
    ["no figures", { ...EQ_OK, chosen_solar: {} },
      /returned no figures/],
  ];
  for (const [label, resp, wording] of cases) {
    const st = railRecostState(RAIL_BASELINE, EQUIPMENT, resp);
    assert.equal(st.kind, "failed", label);
    if (st.kind !== "failed") continue;
    assert.match(st.reason, wording, label);
    console.log(`        ${label.padEnd(38)} -> ${st.reason.slice(0, 62)}`);
  }
});

// The permissive path is gated on the EXACT literal — a missing or
// unrecognised kind takes the strict path. Asserted on the source: the
// condition is equality with "equipment", never inequality with "physics".
test("3.14b-4: permissiveness is opt-in by the exact literal — the source "
  + "tests kind === \"equipment\", not kind !== \"physics\"", async () => {
  const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const FRONTEND = path.resolve(import.meta.dirname, "..");
  const lib = fs.readFileSync(path.join(FRONTEND, "lib/worksheet.ts"), "utf8");
  const fn = lib.slice(lib.indexOf("export function railRecostState"),
    lib.indexOf("function equipmentMovedNote"));
  assert.match(fn, /const equipmentChange = change\.kind === "equipment";/,
    "strict by default: only the literal stands the guards down");
  assert.ok(!fn.includes('!== "physics"'), "never an inequality that a fourth kind would slip through");
  assert.equal((fn.match(/equipmentChange/g) ?? []).length >= 3, true,
    "both guards and the sentence read the ONE flag (2R.1)");
});


// ── Incentives (checklist 3.13b) ─────────────────────────────────────────────

// Shaped like the stored run 523b9c93… — the full breakdown of every run
// stored before prompt 1, whose assumptions_used has NO `as_at`.
const LEGACY_BREAKDOWN = {
  net_cost: 11868.77,
  stc_value: -2331.0,
  battery_rebate: -2473.23,
  line_items: [
    { item: "Panels", detail: "21 × Jinko Tiger Neo (440 W)", amount_aud: 4515.0 },
    { item: "Battery", detail: "GoodWe Lynx Home F (9.83 kWh usable, pre-rebate)", amount_aud: 6500.0 },
    { item: "Solar install", detail: "9.24 kW × $450/kW", amount_aud: 4158.0 },
    { item: "Battery install", detail: "flat $1500", amount_aud: 1500.0 },
    { item: "STCs (solar)", detail: "floor(9.24 × 1.382 × 5) = 63 STCs × $37", amount_aud: -2331.0 },
    { item: "Battery rebate", detail: "Cheaper Home Batteries — 9.83 eff. kWh × 6.8/kWh × $37", amount_aud: -2473.23 },
  ],
  assumptions_used: {
    solar_install_per_kw: 450, battery_install_base: 1500, stc_price_net: 37,
    deeming_years: 5, battery_stc_per_kwh: 6.8, stc_zone: 3,
    stc_zone_rating: 1.382, stc_zone_is_default: false, stc_count: 63,
    panel_count: 21, config_source: "docs/2026-06-11-cost-model-pricing.md",
    config_last_verified: "2026-06-11", prices_indicative: true, note: "…",
  },
  flags: [],
};

// The same breakdown as prompt 1 now stores it — the nine time-honesty keys.
const READY_BREAKDOWN = {
  ...LEGACY_BREAKDOWN,
  assumptions_used: {
    ...LEGACY_BREAKDOWN.assumptions_used,
    as_at: "2026-08-25",
    battery_stc_factor_window: "2026-05-01..2026-12-31",
    battery_stc_factor_is_known: true,
    deeming_years_window: "2026-01-01..2026-12-31",
    deeming_years_is_known: true,
    policy_source: { battery_stc_factor: "https://cer.gov.au/x", solar_deeming_years: "https://cer.gov.au/y" },
    policy_verified_on: "2026-08-25",
    config_age_days: 75,
    cec_approval_checked: false,
  },
};

// A 2027 quote: both rates outside every verified period — amounts null with
// the engine's reasons, net equal to gross (prompt 1's whole point).
const EXPIRED_BREAKDOWN = {
  ...READY_BREAKDOWN,
  net_cost: 16673.0,
  stc_value: null,
  battery_rebate: null,
  line_items: [
    ...LEGACY_BREAKDOWN.line_items.slice(0, 4),
    { item: "STCs (solar)", detail: "No solar STC deeming period (years) is on record for 2027-01-15; the last known period is 2026-01-01 to 2026-12-31 at 5. Not deducted — installer to confirm.", amount_aud: null },
    { item: "Battery rebate", detail: "No battery STC factor (certificates per kWh) is on record for 2027-01-15; the last known period is 2026-05-01 to 2026-12-31 at 6.8. Not deducted — installer to confirm.", amount_aud: null },
  ],
  assumptions_used: {
    ...READY_BREAKDOWN.assumptions_used,
    as_at: "2027-01-15", deeming_years: null, battery_stc_per_kwh: null,
    stc_count: null, battery_stc_factor_window: null,
    battery_stc_factor_is_known: false, deeming_years_window: null,
    deeming_years_is_known: false, config_age_days: 218,
  },
};

function incentivesJob(bd: unknown, over: Partial<JobDetailLike> = {}): JobDetailLike {
  return emptyJob({
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 9.24, battery_kwh: 9.83,
      evaluated_options: { chosen_cost_breakdown: bd },
    }],
    ...over,
  });
}

// I1 — THE PAIR CHECK (modelled on R2): the SECTIONS predicate and the view
// state are ONE question. Give the predicate a second rule of its own and
// this fails immediately — which is what F178/F179 lacked.
test("I1: the Incentives predicate and incentivesView agree on EVERY fixture — run both, compare", () => {
  const spec = SECTIONS.find((s) => s.id === "incentives");
  assert.ok(spec);
  const fixtures: [string, unknown][] = [
    ["no run at all", emptyJob()],
    ["a run with no breakdown", incentivesJob(undefined)],
    ["a breakdown with no incentive line", incentivesJob({ net_cost: 1, line_items: [{ item: "Panels", amount_aud: 1 }] })],
    ["line_items not an array", incentivesJob({ net_cost: 1, line_items: "junk" })],
    ["the legacy run 523b9c93", incentivesJob(LEGACY_BREAKDOWN)],
    ["a prompt-1 run", incentivesJob(READY_BREAKDOWN)],
    ["a 2027 expired run", incentivesJob(EXPIRED_BREAKDOWN)],
    ["junk job", "garbage"],
    ["null job", null],
  ];
  for (const [label, job] of fixtures) {
    const tick = spec!.complete(job as never);
    const view = incentivesView(job);
    assert.equal(
      tick,
      view.state === "ready" || view.state === "legacy",
      `${label}: tick says ${tick} but the body renders ${view.state} — a section whose tick and body disagree is the F178/F179 fault`,
    );
    assert.equal(tick, storedIncentives(job) !== null, `${label}: the predicate IS storedIncentives`);
  }
});

// I2 — NON-GATING, PROVED, on the fixture where the flag ALONE decides:
// every gating section before Incentives is complete, Incentives is not, and
// Summary & finish is not. Remove `gates: false` from the incentives entry
// and BOTH assertions fail — incentives becomes "active" and Summary & finish
// sits "locked" behind it. (A fixture with summary-finish already complete
// takes the jumped-pass path and cannot break — rule 4, found on first run.)
test("I2: incomplete Incentives never locks — and never blocks Summary & finish", () => {
  const job = emptyJob({
    status: "draft", // summary-finish INCOMPLETE — the section the flag protects
    objective: "max_npv",
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
    load_profiles: [{ annual_kwh: 5500, created_at: "2026-08-01T00:00:00Z" }],
    tariffs: [{ tariff_id: "t1" }],
    // Sized and costed, but the stored breakdown carries NO incentive line —
    // so every gating section above is complete and Incentives alone is not.
    sizing_results: [{
      sizing_result_id: "s1", solar_kw: 6.6, battery_kwh: 12.8,
      evaluated_options: { chosen_cost_breakdown: {
        net_cost: 10000, line_items: [{ item: "Panels", amount_aud: 10000 }],
      } },
    }],
    financial_results: [{ sizing_result_id: "s1", payback_years: 4.2 }],
  });
  const states = sectionStates(job);
  assert.equal(stateOf(states, "incentives"), "unlocked",
    "an incomplete non-gating section is unlocked — never active, never locked");
  assert.notEqual(stateOf(states, "summary-finish"), "locked",
    "Summary & finish must not sit locked behind a section with nothing to fill in");
  assert.equal(stateOf(states, "summary-finish"), "active",
    "Summary & finish is what the installer should be on — Incentives took no part in choosing it");
});

// I3 — THE LEGACY STATE IS THE LIVE STATE (every one of the 20 stored runs).
test("I3: a run shaped like 523b9c93 is 'legacy' — amounts render, NO validity window is claimed", () => {
  const view = incentivesView(incentivesJob(LEGACY_BREAKDOWN));
  assert.equal(view.state, "legacy");
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[0].amount, "-$2,331.00");
  assert.equal(view.rows[1].amount, "-$2,473.23");
  assert.equal(view.total, "-$4,804.23");
  for (const row of view.rows) {
    assert.equal(row.validity, null, `${row.name}: a run that never recorded a window must claim none`);
  }
  assert.ok(
    !JSON.stringify(view).includes("applies to installations"),
    "no validity wording anywhere in the view — a window invented for a run that never recorded one is the exact wrongness this row removes",
  );
  assert.ok(view.notices.some((n) => n.level === "notice" && n.title.includes("predates")),
    "the legacy note replaces the validity line");
  // The ready state DOES claim the stored window — same wording, real source:
  const ready = incentivesView(incentivesJob(READY_BREAKDOWN));
  assert.equal(ready.state, "ready");
  assert.equal(ready.rows[0].validity, "This rate applies to installations up to 31 December 2026.");
  assert.equal(ready.rows[1].validity, "This rate applies to installations up to 31 December 2026.");
});

// I4 — THE EXPIRED STATE: null amounts render as "installer to confirm" with
// their stored reasons, and NO total is shown (F212 — an absence is not a zero).
test("I4: null amounts render 'installer to confirm' with reasons, and the total is withheld", () => {
  const view = incentivesView(incentivesJob(EXPIRED_BREAKDOWN));
  assert.equal(view.state, "ready");
  assert.equal(view.rows.length, 2);
  for (const row of view.rows) {
    assert.equal(row.amount, "installer to confirm", row.name);
    assert.ok(row.reason && row.reason.includes("last known period"), `${row.name} carries the engine's reason`);
    assert.equal(row.validity, null);
  }
  assert.equal(view.total, null, "a total that silently excluded an unknown line is the F212 fault");
  assert.ok(view.totalNote, "the withheld total says so");
});

// I5 — PATHS: presence comes from the STORED LINE ITEMS, never from the path.
test("I5: solar-only and battery-only breakdowns each yield one row, whatever the path says", () => {
  const solarOnly = {
    net_cost: 6342, stc_value: -2331,
    line_items: [
      { item: "Panels", amount_aud: 4515 },
      { item: "STCs (solar)", detail: "floor(9.24 × 1.382 × 5) = 63 STCs × $37", amount_aud: -2331 },
    ],
    assumptions_used: LEGACY_BREAKDOWN.assumptions_used,
  };
  const batteryOnly = {
    net_cost: 5527, battery_rebate: -2473.23,
    line_items: [
      { item: "Battery", amount_aud: 6500 },
      { item: "Battery rebate", detail: "Cheaper Home Batteries — 9.83 eff. kWh × 6.8/kWh × $37", amount_aud: -2473.23 },
    ],
    assumptions_used: LEGACY_BREAKDOWN.assumptions_used,
  };
  for (const path of ["A", "E", "B", null, "junk"]) {
    const s = incentivesView(incentivesJob(solarOnly, { path: path as never }));
    assert.deepEqual(s.rows.map((r) => r.name), ["Small-scale technology certificates (solar)"],
      `solar-only rows must not vary with path ${path}`);
    const b = incentivesView(incentivesJob(batteryOnly, { path: path as never }));
    assert.deepEqual(b.rows.map((r) => r.name), ["Cheaper Home Batteries rebate"],
      `battery-only rows must not vary with path ${path}`);
    assert.ok(b.notices.some((n) => n.body.includes("Clean Energy Council")),
      "the CEC statement rides with the battery rebate row");
    assert.ok(!s.notices.some((n) => n.body.includes("Clean Energy Council")),
      "…and never appears on a solar-only breakdown");
  }
});

// I6 — TOTALITY: junk in, a state and honest notes out. Never a throw, never
// an invented figure.
test("I6: storedIncentives and incentivesView are total on junk", () => {
  const junks: [string, unknown][] = [
    ["null", null],
    ["a string", "garbage"],
    ["junk evaluated_options", incentivesJob("junk" as never)],
    ["line_items as a string", incentivesJob({ line_items: "nope" })],
    ["a line with no amount", incentivesJob({ line_items: [{ item: "STCs (solar)", detail: "d" }] })],
  ];
  for (const [label, job] of junks) {
    assert.doesNotThrow(() => storedIncentives(job), label);
    assert.doesNotThrow(() => incentivesView(job), label);
  }
  assert.equal(incentivesView(null).state, "unsized");
  assert.equal(incentivesView("garbage").state, "unsized");
  assert.equal(incentivesView(incentivesJob("junk" as never)).state, "unrecorded");
  assert.equal(incentivesView(incentivesJob({ line_items: "nope" })).state, "unrecorded");
  const noAmount = incentivesView(incentivesJob({ line_items: [{ item: "STCs (solar)", detail: "d" }] }));
  assert.equal(noAmount.rows[0].amount, "installer to confirm");
  assert.equal(noAmount.total, null);
});


// ── Incentives fix 1 (2026-08-25): every row is REPRODUCIBLE from its words ──
// Found on screen by Mayur: the battery row named the rate and the price but
// never the QUANTITY, so its amount could not be arrived at from the sentence.
// The test below is not "is the sentence readable" but "can a person get the
// amount from the words alone" — asserted mechanically, for EVERY row, so the
// rule holds for any incentive row added later.

/** Every number in a row's working, in order — the reader's raw material. */
function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Can SOME subset of those numbers be multiplied to the row's amount? That
    is exactly "a person can get the amount from the words alone". */
function reproducible(text: string, amountAud: number): boolean {
  const nums = numbersIn(text);
  const target = Math.abs(amountAud);
  for (let mask = 1; mask < 1 << nums.length; mask++) {
    let product = 1;
    let used = 0;
    for (let i = 0; i < nums.length; i++) {
      if (mask & (1 << i)) {
        product *= nums[i];
        used += 1;
      }
    }
    if (used >= 2 && Math.abs(product - target) <= 0.01) return true;
  }
  return false;
}

/** A breakdown whose battery rebate was calculated on `eff` effective kWh,
    against a battery of `usable` kWh, at 6.8/kWh and $37. */
function batteryRebateBreakdown(eff: number, usable: number, amount: number) {
  return {
    net_cost: 10000,
    battery_rebate: -amount,
    line_items: [
      { item: "Battery", detail: `GoodWe Lynx Home F (${usable} kWh usable, pre-rebate)`, amount_aud: 6500 },
      { item: "Battery rebate", detail: `Cheaper Home Batteries — ${eff} eff. kWh × 6.8/kWh × $37`, amount_aud: -amount },
    ],
    assumptions_used: LEGACY_BREAKDOWN.assumptions_used,
  };
}

// F1 — THE QUANTITY IS STATED, AND IT IS READ, NOT HARDCODED. The fixture's
// figure is 11.5, not the fixture-famous 9.83, so a hardcoded number fails.
test("F1: the battery row states the quantity the rebate was calculated on, READ from the stored line item", () => {
  const view = incentivesView(incentivesJob(batteryRebateBreakdown(11.5, 11.5, 2893.4)));
  const row = view.rows.find((r) => r.name === "Cheaper Home Batteries rebate");
  assert.ok(row?.working, "the battery row must carry a working");
  assert.match(row!.working!, /11\.5/,
    "the quantity must come from the stored line item — a hardcoded 9.83 fails here");
  assert.doesNotMatch(row!.working!, /9\.83/, "9.83 would mean the number was hardcoded");
  assert.match(row!.working!, /6\.8/, "the rate");
  assert.match(row!.working!, /\$37/, "the price");
  assert.equal(row!.amount, "-$2,893.40");
  assert.ok(reproducible(row!.working!, 2893.4),
    `the amount must be reachable from the words alone: ${row!.working}`);
});

// F2 — THE TAPER IS NAMED ONLY WHEN ONE APPLIES, both directions.
test("F2: no taper wording on a battery inside the first band; taper named on one above it", () => {
  // 9.83 kWh usable — the taper does not touch it, so it is not mentioned.
  const small = incentivesView(incentivesJob(batteryRebateBreakdown(9.83, 9.83, 2473.23)));
  const smallRow = small.rows.find((r) => r.name === "Cheaper Home Batteries rebate");
  assert.ok(smallRow?.working);
  assert.doesNotMatch(smallRow!.working!, /taper/i,
    "a parenthetical about a taper that is not in play invites the reader to wonder whether it was");
  assert.match(smallRow!.working!, /9\.83 usable kilowatt-hours/);

  // 24 kWh usable -> 14 + 0.6 x 10 = 20 effective. The taper IS in play, and
  // the row says so AND names both figures, so the gap is explained.
  const large = incentivesView(incentivesJob(batteryRebateBreakdown(20, 24, 5032)));
  const largeRow = large.rows.find((r) => r.name === "Cheaper Home Batteries rebate");
  assert.ok(largeRow?.working);
  assert.match(largeRow!.working!, /taper/i, "a battery above the first band must say so");
  assert.match(largeRow!.working!, /20 effective kilowatt-hours/);
  assert.match(largeRow!.working!, /24 kWh usable/);
  assert.ok(reproducible(largeRow!.working!, 5032),
    `the tapered amount must still be reachable from the words: ${largeRow!.working}`);
});

// F3 — THE RULE ITSELF, over every fixture and every row: quantity, rate and
// price, such that the amount falls out of them. A future incentive row that
// states a rate without its quantity fails here.
test("F3: EVERY confirmed incentive row can be reproduced from its own words", () => {
  const fixtures: [string, unknown][] = [
    ["the legacy run 523b9c93", LEGACY_BREAKDOWN],
    ["a prompt-1 run", READY_BREAKDOWN],
    ["an 11.5 kWh battery", batteryRebateBreakdown(11.5, 11.5, 2893.4)],
    ["a tapered 24 kWh battery", batteryRebateBreakdown(20, 24, 5032)],
  ];
  for (const [label, bd] of fixtures) {
    const view = incentivesView(incentivesJob(bd));
    assert.ok(view.rows.length > 0, label);
    for (const row of view.rows) {
      if (!row.confirmed) continue;
      assert.ok(row.working, `${label} / ${row.name}: a confirmed row must show its working`);
      const amount = Number(row.amount.replace(/[^0-9.]/g, ""));
      assert.ok(
        reproducible(row.working!, amount),
        `${label} / ${row.name}: ${row.amount} cannot be arrived at from "${row.working}"`,
      );
    }
  }
});

// F4 — WHEN THE QUANTITY IS NOT IN THE STORED LINE, the row falls back to the
// engine's own detail verbatim rather than shipping a sentence that cannot be
// reproduced. The rule survives a line the parser cannot read.
test("F4: a rebate line with no stored quantity falls back to the engine's detail verbatim", () => {
  const noQuantity = {
    net_cost: 10000,
    line_items: [
      { item: "Battery rebate", detail: "Cheaper Home Batteries — 9.83 x 6.8 x $37", amount_aud: -2473.23 },
    ],
    assumptions_used: LEGACY_BREAKDOWN.assumptions_used,
  };
  const row = incentivesView(incentivesJob(noQuantity)).rows[0];
  assert.equal(row.working, "Cheaper Home Batteries — 9.83 x 6.8 x $37",
    "the engine's own words, which name all three numbers, beat a sentence missing one");
  assert.ok(reproducible(row.working!, 2473.23));
});

// F5 — THE TEXT THAT SHIPS, printed for the run Mayur is looking at.
test("F5: the exact final text of both rows for the run 523b9c93 fixture", () => {
  const view = incentivesView(incentivesJob(LEGACY_BREAKDOWN));
  for (const row of view.rows) {
    console.log(`        ${row.name}`);
    console.log(`          amount : ${row.amount}`);
    console.log(`          working: ${row.working}`);
  }
  const [solar, battery] = view.rows;
  assert.equal(
    solar.working,
    "63 certificates at $37 each — 9.24 kW, zone 3 rating 1.382, deemed over 5 years.",
  );
  assert.equal(
    battery.working,
    "9.83 usable kilowatt-hours at 6.8 certificates each, $37 per certificate.",
  );
});
// ── 3.4c prompt 3: the section RENDERS the truth (F231/F168/F94 on screen) ──
//
// These checks render the REAL component with react-dom/server (the 3.6b
// harness's module hooks are already registered above) and assert the markup
// that ships — never the style table, never intent (the F47 lesson). The one
// extra hook: next/navigation is served as a stub module, because useRouter
// throws outside a Next app-router context and this component calls it.

const ROOF_SECTION_SOURCE = await (async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return readFileSync(
    path.join(root, "components/worksheet/address-roof-section.tsx"),
    "utf8",
  );
})();

const renderRoofSection = await (async () => {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/navigation") {
        return { url: "virtual:next-navigation-stub", shortCircuit: true };
      }
      if (specifier === "next/link") {
        // Bare Node cannot resolve next's "./link" export the way Next's own
        // bundler does; the stub renders exactly what a static <Link> would.
        return { url: "virtual:next-link-stub", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "virtual:next-navigation-stub") {
        return {
          format: "module",
          source:
            "export function useRouter() { return { refresh() {}, push() {} }; }",
          shortCircuit: true,
        };
      }
      if (url === "virtual:next-link-stub") {
        return {
          format: "module",
          source:
            "export default function Link(props) { return props.children ?? null; }",
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AddressRoofSection } = await import(
    "../components/worksheet/address-roof-section.tsx"
  );
  return (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(AddressRoofSection, props as never));
})();

/** The rendered markup as readable text — tags out, entities decoded. */
function roofTextOf(markup: string): string {
  return decodedMarkup(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function roofSectionMarkup(row: unknown): string {
  const job = emptyJob({ roof_geometry: [row] });
  const view = addressRoofView(job);
  return renderRoofSection({
    view,
    jobId: "job-render",
    isOpen: true,
    diagram: roofDiagramView(job),
  });
}

test("3.4c-3 (3): the FALSE sentence is gone from the component source", () => {
  const hits = ROOF_SECTION_SOURCE.match(/uses a different panel/g) ?? [];
  assert.equal(hits.length, 0, `${hits.length} hits of the deleted sentence`);
});


test("3.4c-3 (5): the SHIPPED panel rectangles carry no stroke-dasharray; adjacent faces still differ", () => {
  const diagram = {
    show: true,
    tileLat: -34.92,
    tileLng: 138.62,
    zoom: 20,
    buildingBox: { x: 10, y: 10, width: 100, height: 80 },
    rects: [0, 1, 2, 3].map((i) => ({
      cx: 60 + i * 40,
      cy: 60,
      widthPx: 20,
      heightPx: 12,
      rotationDeg: 0,
      segmentIndex: i,
    })),
    reason: null,
    panelCount: 4,
    panelWidthM: 1.13,
    panelHeightM: 1.76,
    panelCapacityW: 440,
  };
  const markup = renderRoofSection({
    view: viewFor(A57_ROW),
    jobId: "job-render",
    isOpen: true,
    diagram,
  });
  // The PANEL rects are the ones inside a <g transform=...> wrapper.
  const panelRects = [...markup.matchAll(/<g transform="[^"]*"><rect ([^>]*?)\/?>/g)].map(
    (m) => m[1],
  );
  assert.equal(panelRects.length, 4, markup.slice(0, 400));
  for (const attrs of panelRects) {
    assert.ok(!attrs.includes("stroke-dasharray"), attrs);
  }
  const opacities = panelRects.map((a) => /fill-opacity="([^"]+)"/.exec(a)?.[1]);
  console.log(`        fill-opacity by segment: ${opacities.join(", ")}`);
  assert.equal(new Set(opacities).size, 4, "all four face styles distinct");
  for (let i = 0; i < 4; i++) {
    assert.notEqual(opacities[i], opacities[(i + 1) % 4], `faces ${i}/${(i + 1) % 4}`);
  }
  // The building box KEEPS its dashes — it means extent, and the caption says so.
  assert.ok(/stroke-dasharray="6 4"/.test(markup), "building box dashes stay");
  // The honest two-imagery caveat survives the deletion.
  // D48 rewrote this line: it no longer claims "a different capture" (never
  // established) and names no mechanism (untested — F235, homed at 4.2).
  assert.ok(
    roofTextOf(markup).includes("nothing aligns them, so the shapes are indicative"),
    "the indicative caveat stays",
  );
});

test("3.4c-3 (1): provenance, orientation words and rounded labels are ON SCREEN", () => {
  const text = roofTextOf(
    renderRoofSection({ view: viewFor(A57_ROW), jobId: "job-render", isOpen: false }),
  );
  // D48: assessed faces carry NO label; only the exception is marked.
  assert.ok(!text.includes("from Google's panel layout"), text.slice(0, 200));
  assert.ok(text.includes("estimated from area alone"));
  assert.ok(text.includes("faces west-north-west"));
  assert.ok(!text.includes("faces west-north-west, 23 degree pitch"), "the pitch is not restated");
  assert.ok(text.includes("about 8 m²")); // area-counted face: approximate, whole metres
  assert.ok(text.includes("19 m²")); // Google-laid-out face: whole metres, no "about"
  assert.ok(text.includes("3.5 kW")); // one decimal
  assert.ok(text.includes("11.4 kW")); // the total, one decimal
  assert.ok(!text.includes("11.44"), "the raw two-decimal total no longer prints");
});

test("3.4c-3 (6): totality — junk view, no azimuth, no reconciliation: renders, never throws", () => {
  assert.doesNotThrow(() =>
    renderRoofSection({ view: addressRoofView(null), jobId: "j", isOpen: true }),
  );
  assert.doesNotThrow(() =>
    renderRoofSection({ view: addressRoofView("garbage"), jobId: "j", isOpen: true }),
  );
  const noAzimuth = viewFor(roofRow({ planes: [{ pitch: 20, panel_count: 3 }] }));
  const markup = renderRoofSection({ view: noAzimuth, jobId: "j", isOpen: false });
  assert.ok(roofTextOf(markup).includes("20 degree pitch")); // pitch alone, never a blank-as-zero
});

test("3.4c-3 (step 5): the panel the table was scaled to vs the panel the run priced", () => {
  const SELECTED = { id: "panel-a", brand: "Jinko", model: "Tiger Neo", watts: 440 };
  const run = (panel: unknown) => ({
    sizing_result_id: "s1",
    created_at: "2026-08-25T00:00:00Z",
    run_assumptions: { panel },
  });
  const jobFor = (panel: unknown) =>
    emptyJob({
      roof_geometry: [roofRow({ selected_panel: SELECTED })],
      sizing_results: [run(panel)],
    });

  const mismatch = addressRoofView(jobFor({ id: "panel-b", watts: 475 }));
  assert.ok(mismatch.panelMismatchNotice);
  assert.equal(mismatch.panelMismatchNotice.level, "notice");
  assert.ok(
    mismatch.panelMismatchNotice.body.includes("Jinko Tiger Neo 440 W"),
    mismatch.panelMismatchNotice.body,
  );
  assert.ok(
    mismatch.panelMismatchNotice.body.includes("475 W"),
    mismatch.panelMismatchNotice.body,
  );
  // And it renders, from the view, wording untouched by the component.
  const markup = renderRoofSection({ view: mismatch, jobId: "j", isOpen: false });
  assert.ok(roofTextOf(markup).includes("scaled to a different panel than the quote"));

  // Same product -> silent. Unknown either side -> silent, never asserted equal.
  assert.equal(addressRoofView(jobFor({ id: "panel-a", watts: 440 })).panelMismatchNotice, null);
  assert.equal(addressRoofView(jobFor({ watts: 475 })).panelMismatchNotice, null);
  assert.equal(addressRoofView(jobFor(null)).panelMismatchNotice, null);
  assert.equal(
    addressRoofView(
      emptyJob({ roof_geometry: [roofRow({ selected_panel: SELECTED })] }),
    ).panelMismatchNotice,
    null,
  );
  assert.equal(
    addressRoofView(
      emptyJob({ roof_geometry: [roofRow()], sizing_results: [run({ id: "x" })] }),
    ).panelMismatchNotice,
    null,
  );
});
// ── 3.4c prompt 4: the section asks to be confirmed (D24) ───────────────────

const CONFIRMED_ROW = roofRow({
  roof_confirmed_at: "2026-08-25T07:41:51.519549+00:00",
  roof_confirmed_by: "8e496f09-d1b8-47a3-9d53-3f09ed389b34",
  roof_confirmed_source: "installer",
});

test("3.4c-4 (5): the confirmed state — raw values plus the composed notice", () => {
  const view = viewFor(CONFIRMED_ROW);
  assert.equal(view.roofConfirmedAt, "2026-08-25T07:41:51.519549+00:00");
  assert.equal(view.roofConfirmedSource, "installer");
  assert.ok(view.confirmedNotice);
  assert.equal(view.confirmedNotice.tone, "success");
  assert.equal(view.confirmedNotice.level, "notice"); // fires per job — a finding (D25)
  assert.ok(view.confirmedNotice.body.includes("the installer"), view.confirmedNotice.body);
  assert.ok(view.confirmedNotice.body.includes("25 August 2026"), view.confirmedNotice.body);
  assert.equal(view.showsConfirmControl, false); // already confirmed — no control
  const customer = viewFor({ ...CONFIRMED_ROW, roof_confirmed_source: "customer" });
  assert.ok(customer.confirmedNotice?.body.includes("the customer"));
  // An unknown stored label still renders — raw, never hidden (the D33 family).
  const odd = viewFor({ ...CONFIRMED_ROW, roof_confirmed_source: "auditor" });
  assert.ok(odd.confirmedNotice?.body.includes("auditor"));
});

test("3.4c-4 (5): the control exists exactly where an unconfirmed LOOKUP roof does", () => {
  assert.equal(viewFor(roofRow()).showsConfirmControl, true); // found, unconfirmed
  assert.equal(viewFor(roofRow({ low_confidence: true })).showsConfirmControl, true);
  assert.equal(viewFor(roofRow({ source: "manual_plans" })).showsConfirmControl, false);
  assert.equal(viewFor(roofRow({ found: false, planes: [] })).showsConfirmControl, false);
  assert.equal(addressRoofView(null).showsConfirmControl, false); // no roof row: no control at all
  assert.equal(addressRoofView(null).confirmedNotice, null);
  // Junk in the columns is not a confirmation.
  const junk = viewFor(roofRow({ roof_confirmed_at: 12345, roof_confirmed_source: 7 }));
  assert.equal(junk.confirmedNotice, null);
  assert.equal(junk.showsConfirmControl, true);
});

test("3.4c-4 (5): a re-looked-up roof is unconfirmed BY CONSTRUCTION — asserted, not assumed", async () => {
  // The view half: the NEWEST row (a fresh lookup) wins, and it has no
  // confirmation, so the confirmed state is gone and the control is back.
  const older = { ...CONFIRMED_ROW, created_at: "2026-08-20T00:00:00Z" };
  const fresh = roofRow({ created_at: "2026-08-25T09:00:00Z" });
  const view = addressRoofView(emptyJob({ roof_geometry: [older, fresh] }));
  assert.equal(view.confirmedNotice, null);
  assert.equal(view.showsConfirmControl, true);
  // The backend half, pinned at the source: _persist's inserted row dict
  // carries none of the three columns (verify_roof_confirmation.py runs the
  // full inheritance proof; this is the cross-repo tripwire).
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const platform = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const roofPy = readFileSync(path.join(platform, "backend/routes/roof.py"), "utf8");
  const rowDict = /def _persist[\s\S]*?row = \{[\s\S]*?\n    \}/.exec(roofPy)?.[0];
  assert.ok(rowDict, "found _persist's row dict");
  assert.ok(!rowDict.includes("roof_confirmed"), "an appended row cannot carry a confirmation");
});

test("3.4c-4 (b): the confirm control renders first for a found roof, and only while unconfirmed", () => {
  const unconfirmed = renderRoofSection({
    view: viewFor(roofRow()),
    jobId: "j",
    isOpen: false,
  });
  const text = roofTextOf(unconfirmed);
  const iConfirm = text.indexOf("Confirm this roof");
  const iCorrect = text.indexOf("Correct these values");
  const iLookup = text.indexOf("Look up again");
  assert.ok(iConfirm !== -1 && iCorrect !== -1 && iLookup !== -1, text.slice(-300));
  assert.ok(iConfirm < iCorrect && iCorrect < iLookup, `${iConfirm} ${iCorrect} ${iLookup}`);
  const confirmed = roofTextOf(
    renderRoofSection({ view: viewFor(CONFIRMED_ROW), jobId: "j", isOpen: false }),
  );
  assert.ok(!confirmed.includes("Confirm this roof"), "no control once confirmed");
  assert.ok(confirmed.includes("Roof confirmed"), confirmed.slice(0, 200));
  const none = roofTextOf(
    renderRoofSection({ view: addressRoofView(null), jobId: "j", isOpen: false }),
  );
  assert.ok(!none.includes("Confirm this roof"), "no roof row: no control at all");
});

test("3.4c-4 (item e): the EXPIRED state no longer asserts found and deleted at once", () => {
  const expired = viewFor(roofRow({ solar_data_expired: true }));
  assert.equal(expired.solarDataExpired, true);
  assert.equal(expired.notice, null); // the prefill caption yields to the expiry notice
  const text = roofTextOf(
    renderRoofSection({ view: expired, jobId: "j", isOpen: false }),
  );
  console.log(`        [expired render] ${text.slice(0, 420)}`);
  assert.ok(text.includes("has been deleted"), text.slice(0, 300));
  assert.ok(!text.includes("Roof found"), "the old success tick is gone");
  assert.ok(!text.includes("Roof prefilled"), "the prefill caption yields while expired");
});

test("D48 (1)(2): the caption is three lines and carries no deleted claim", () => {
  // WAS "3.4c-5 (F234): the caption STATES the drawing and its assumptions",
  // which asserted the fitted-panel total and the two-wattage line. D48
  // deletes both; what survives is that the caption states the drawing is
  // indicative, dates the MODEL, and names the box.
  const view = viewFor({
    ...withImagery(roofRow({
      selected_panel: { id: "p1", brand: "Jinko", model: "Tiger Neo", watts: 440 },
    })),
  });
  const text = roofTextOf(
    renderRoofSection({ view, jobId: "j", isOpen: true, diagram: CAPTION_DIAGRAM }),
  );
  for (const dead of [
    "Check this picture",
    "is this the right building",
    "judge the building, not the layout",
    "they will sit roughly",
    "uses a different panel",
    "a different capture",
    "Google's model fitted",
    "W assumption",
    "% of each face is treated as usable",
    "take their panel counts",
    "The photo is dated",
    "medium-quality",
  ]) {
    assert.ok(!text.includes(dead), `still on screen: ${dead}`);
  }
  assert.ok(text.includes("so the shapes are indicative"), text);
  assert.ok(text.includes("Google's solar model is dated 2018-11-17."), text);
  assert.ok(text.includes("The dashed box is the area Google measured."), text);
});

test("3.4c-4 (item d): the multi-dwelling caution has ONE home", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const phrase = /may not be this dwelling/g;
  const site = readFileSync(path.join(root, "components/worksheet/site-details-section.tsx"), "utf8");
  const roof = readFileSync(path.join(root, "components/worksheet/address-roof-section.tsx"), "utf8");
  const lib = readFileSync(path.join(root, "lib/worksheet.ts"), "utf8");
  const counts = [site, roof, lib].map((s) => (s.match(phrase) ?? []).length);
  console.log(`        occurrences [site-details, address-roof, lib]: ${counts.join(", ")}`);
  assert.deepEqual(counts, [0, 0, 1], "the wording lives ONCE, in the logic layer");
  // And the one renderer really is Address & roof, from the one constant.
  assert.ok(roof.includes("MULTI_DWELLING_CAPTION"));
  assert.ok(!site.includes("MULTI_DWELLING_CAPTION"));
});

test("3.4c-4 (7): an unconfirmed roof still sizes — no gate, no lock, anywhere", () => {
  const unconfirmedJob = emptyJob({ roof_geometry: [roofRow()] });
  const confirmedJob = emptyJob({ roof_geometry: [CONFIRMED_ROW] });
  const spec = SECTIONS.find((s) => s.id === "address-roof");
  assert.ok(spec);
  assert.equal(spec.complete(unconfirmedJob), true, "completion never waits for a confirmation");
  // The whole ladder is IDENTICAL confirmed vs not — a gate would split them.
  assert.deepEqual(
    sectionStates(unconfirmedJob).map((s) => [s.id, s.state]),
    sectionStates(confirmedJob).map((s) => [s.id, s.state]),
  );
});

test("3.4c-4 (a): the route handler forwards the session Bearer and HARDCODES source installer", async () => {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/lib/supabase/server") {
        return { url: "virtual:supabase-server-stub", shortCircuit: true };
      }
      if (specifier === "next/server") {
        // Bare Node cannot resolve next's "./server" export; point it at the
        // real file so the REAL NextResponse is what the test exercises.
        return {
          url: new URL("../node_modules/next/server.js", import.meta.url).href,
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "virtual:supabase-server-stub") {
        return {
          format: "module",
          source:
            "export async function createClient() { return { auth: { getSession: async () => ({ data: { session: { access_token: 'suite-token' } } }) } }; }",
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  const { POST } = await import("../app/api/roof/confirm/route.ts");
  const recorded: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    recorded.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify({ confirmed: true, roof_geometry_id: "r1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    // The client SENT a source — the handler must ignore it (D29: the label is
    // the handler's fact, not the browser's claim).
    const res = await POST(
      new Request("http://localhost/api/roof/confirm", {
        method: "POST",
        body: JSON.stringify({ job_id: "job-9", source: "customer" }),
      }),
    );
    assert.equal(recorded.length, 1);
    assert.ok(recorded[0].url.endsWith("/api/roof/confirm"), recorded[0].url);
    const headers = recorded[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer suite-token");
    const forwarded = JSON.parse(String(recorded[0].init.body));
    assert.deepEqual(forwarded, { job_id: "job-9", source: "installer" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { confirmed: true, roof_geometry_id: "r1" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
// ── 3.4c prompt 5: the caption is objective, and F128's notices are data ────

/** A drawable diagram, Google's own figures — the a57e13f1 shape. */
const CAPTION_DIAGRAM = {
  show: true,
  tileLat: -34.92,
  tileLng: 138.62,
  zoom: 20,
  buildingBox: { x: 10, y: 10, width: 100, height: 80 },
  rects: [{ cx: 60, cy: 60, widthPx: 20, heightPx: 12, rotationDeg: 0, segmentIndex: 0 }],
  reason: null,
  panelCount: 21,
  panelWidthM: 1.05,
  panelHeightM: 1.88,
  panelCapacityW: 400,
};

const withImagery = (row: Record<string, unknown>) => ({
  ...row,
  imagery_date: "2018-11-17",
  imagery_quality: "MEDIUM",
  selected_panel: { id: "p1", brand: "Jinko", model: "Tiger Neo", watts: 440 },
  usability_factor: 0.7,
});

/**
 * Second-person address, or an imperative aimed at the reader. The caption may
 * contain none of these: the drawing is under keep-or-kill review at 8.4
 * (F234) and must not be built up into a task the reader is set.
 */
const READER_INSTRUCTION = [
  /\byou\b/i, /\byour\b/i, /\byours\b/i,
  /\bshould\b/i, /\bmust\b/i, /\bneed to\b/i, /\bworth\b/i,
];
const IMPERATIVE_OPENERS = [
  "check", "judge", "look", "use", "confirm", "treat", "note", "make",
  "consider", "see", "read", "verify", "compare", "ignore", "remember",
  "ensure", "watch", "review", "refer", "take", "keep", "do", "avoid",
  "assume", "trust", "rely", "bear", "count", "expect",
];

/** Every reader-instruction found in these lines, with why it tripped. */
function readerInstructionsIn(lines: readonly string[]): string[] {
  const bad: string[] = [];
  for (const line of lines) {
    for (const raw of line.split(/(?<=\.)\s+/)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      for (const pattern of READER_INSTRUCTION) {
        if (pattern.test(sentence)) bad.push(`${pattern} in: ${sentence}`);
      }
      const opener = (sentence.match(/^[A-Za-z']+/)?.[0] ?? "").toLowerCase();
      if (IMPERATIVE_OPENERS.includes(opener)) {
        bad.push(`imperative opener "${opener}" in: ${sentence}`);
      }
    }
  }
  return bad;
}

test("3.4c-5 (3): the caption instructs the reader NOWHERE, on any roof", () => {
  const fixtures: [string, unknown, unknown][] = [
    ["a57e13f1", withImagery(A57_ROW), CAPTION_DIAGRAM],
    ["670c80db", withImagery(BISHOPS_ROW), { ...CAPTION_DIAGRAM, panelCount: 28 }],
    ["456e0242", withImagery(FROME_ROW), { ...CAPTION_DIAGRAM, reason: "no_panel_positions", panelCount: 0 }],
    ["no diagram", withImagery(roofRow()), undefined],
    ["no building box", withImagery(roofRow()), { ...CAPTION_DIAGRAM, buildingBox: null }],
  ];
  for (const [name, row, diagram] of fixtures) {
    const lines = roofDiagramCaptionLines(viewFor(row), diagram as never);
    const bad = readerInstructionsIn(lines);
    assert.deepEqual(bad, [], `${name}: ${bad.join(" | ")}`);
  }
  // The check is only worth something if the WHOLE caption is being read.
  assert.ok(
    readerInstructionsIn(["Check this picture for two things."]).length > 0,
    "the detector itself must catch a planted instruction",
  );
  assert.ok(readerInstructionsIn(["Your roof is fine."]).length > 0);
});

test("D48 (2): the caption on a lookup roof is EXACTLY the three lines, in order", () => {
  // WAS "the three real roofs — every caption figure traces to the view",
  // which asserted eight lines including the reconciliation summary, the
  // fitted-panel total and the usable-area factor. D48 deletes all of those:
  // the caption is three lines. THE COUNT IS ASSERTED, not just the contents —
  // a fourth line creeping back is the failure this row exists to prevent.
  const cases: [string, Record<string, unknown>, unknown, string[]][] = [
    ["a57e13f1", withImagery(A57_ROW), CAPTION_DIAGRAM, [
      "The panel shapes are Google's estimate for this building, drawn over Google's satellite view. The two are separate products and nothing aligns them, so the shapes are indicative.",
      "Google's solar model is dated 2018-11-17.",
      "The dashed box is the area Google measured.",
    ]],
    ["670c80db", withImagery(BISHOPS_ROW), CAPTION_DIAGRAM, [
      "The panel shapes are Google's estimate for this building, drawn over Google's satellite view. The two are separate products and nothing aligns them, so the shapes are indicative.",
      "Google's solar model is dated 2018-11-17.",
      "The dashed box is the area Google measured.",
    ]],
    // The roof whose drawing cannot be drawn keeps its reason copy elsewhere
    // and still states the model's date (D48's fallback).
    ["456e0242 (no layout)", withImagery(FROME_ROW),
      { ...CAPTION_DIAGRAM, reason: "no_panel_positions", panelCount: 0 }, [
      "Google's solar model is dated 2018-11-17.",
      "The dashed box is the area Google measured.",
    ]],
  ];
  for (const [name, row, diagram, expected] of cases) {
    const lines = roofDiagramCaptionLines(viewFor(row), diagram as never);
    console.log(`        [${name}] ${lines.length} line(s)`);
    for (const line of lines) console.log(`          ${line}`);
    assert.deepEqual(lines, expected, name);
  }
  // No stored date: line 2 is OMITTED, never guessed — and the count drops.
  const noDate = roofDiagramCaptionLines(viewFor(A57_ROW), CAPTION_DIAGRAM as never);
  assert.equal(noDate.length, 2, noDate.join(" | "));
  assert.ok(!noDate.join(" ").includes("dated"), noDate.join(" | "));
  // No dashed box: line 3 is omitted too.
  const noBox = roofDiagramCaptionLines(
    viewFor(withImagery(A57_ROW)),
    { ...CAPTION_DIAGRAM, buildingBox: null } as never,
  );
  assert.equal(noBox.length, 2, noBox.join(" | "));
  // A MANUAL roof says nothing about Google at all (D48's fallback).
  const manual = roofDiagramCaptionLines(
    viewFor({ ...withImagery(roofRow()), source: "manual_plans" }),
    undefined,
  );
  assert.deepEqual(manual, []);
});

test("D48 (1): line 1 says the shapes are INDICATIVE, names no cause and no vendor", () => {
  // WAS "the drawable roof states what was drawn, whose panel, and why it sits
  // roughly" — the fitted-panel and two-wattage lines it asserted are deleted.
  // Line 1 is rewritten: it must not claim the two are "a different capture"
  // (never established) and must not name a mechanism for the misalignment
  // (untested — F235, homed at 4.2).
  const lines = roofDiagramCaptionLines(viewFor(withImagery(A57_ROW)), CAPTION_DIAGRAM as never);
  const line1 = lines[0];
  assert.ok(line1.startsWith("The panel shapes are Google's estimate"), line1);
  assert.ok(line1.includes("drawn over Google's satellite view"), line1);
  assert.ok(line1.includes("separate products and nothing aligns them"), line1);
  assert.ok(line1.endsWith("so the shapes are indicative."), line1);
  for (const forbidden of [
    "a different capture", "supplier", "vendor", "third party",
    "Airbus", "Maxar", "Vexcel",
    "lean", "relief displacement", "parallax", "perspective", "ortho",
    "placement plan",
  ]) {
    assert.ok(!new RegExp(forbidden, "i").test(line1), `line 1 must not say "${forbidden}": ${line1}`);
  }
  assert.deepEqual(readerInstructionsIn(lines), []);
});

test("D48: totality — junk view and missing figures invent nothing", () => {
  assert.deepEqual(roofDiagramCaptionLines(addressRoofView(null), undefined), []);
  const junk = roofDiagramCaptionLines(addressRoofView("garbage"), CAPTION_DIAGRAM as never);
  assert.deepEqual(readerInstructionsIn(junk), []);
  for (const forbidden of ["dated", "faces", "% of each face", "scaled to"]) {
    assert.ok(!junk.join(" ").includes(forbidden), `${forbidden} invented from a junk view`);
  }
  // A drawable diagram over a junk view still describes only the DRAWING.
  assert.ok(junk.includes("The dashed box is the area Google measured."), junk.join(" | "));
  const bare = viewFor(roofRow({ planes: [{}], usability_factor: null }));
  const lines = roofDiagramCaptionLines(bare, {
    ...CAPTION_DIAGRAM, panelWidthM: null, panelHeightM: null,
    panelCapacityW: null, buildingBox: null,
  } as never);
  const text = lines.join(" ");
  for (const junkWord of ["null", "undefined", "NaN"]) {
    assert.ok(!text.includes(junkWord), text);
  }
  assert.doesNotThrow(() =>
    renderRoofSection({ view: bare, jobId: "j", isOpen: true, diagram: CAPTION_DIAGRAM }),
  );
});

test("3.4c-5 (F128): all FIVE notices are data in the logic layer, none composed inline", async () => {
  // The prompt named three; the manual form's omitted-faces caution and prompt
  // 4's confirm-failure copy are the other two. Derived from the file, not counted.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const component = readFileSync(
    path.join(root, "components/worksheet/address-roof-section.tsx"),
    "utf8",
  );
  const literalProps = component.match(/(?:tone|title)="/g) ?? [];
  console.log(`        literal tone=/title= props left in the component: ${literalProps.length}`);
  assert.equal(literalProps.length, 0, `still inline: ${literalProps.join(", ")}`);

  // Each one, as data, with its wording moved VERBATIM.
  assert.equal(ROOF_NOT_SAVED_NOTICE.tone, "caution");
  assert.equal(ROOF_NOT_SAVED_NOTICE.level, "notice");
  assert.equal(ROOF_NOT_SAVED_NOTICE.title, "This roof could not be saved");
  assert.equal(ROOF_CONFIRM_FAILED_NOTICE.tone, "problem");
  assert.equal(ROOF_CONFIRM_FAILED_NOTICE.title, "The roof could not be confirmed");

  const mismatch = roofStateMismatchNotice(
    { jobState: "SA", jobPostcode: "5000", geocodedState: "VIC", geocodedPostcode: "3000", mismatch: true },
    null,
  );
  assert.ok(mismatch);
  assert.equal(mismatch.tone, "caution");
  assert.ok(mismatch.body.includes("set up as SA"), mismatch.body);
  assert.ok(mismatch.body.includes("geocodes to VIC"), mismatch.body);
  // The LIVE mismatch a just-finished lookup returned, with no stored one.
  const live = roofStateMismatchNotice(null, { jobState: "SA", geocodedState: "NSW" });
  assert.ok(live?.body.includes("geocodes to NSW"), String(live?.body));
  // Agreement, or nothing known: silent.
  assert.equal(
    roofStateMismatchNotice(
      { jobState: "SA", jobPostcode: "5000", geocodedState: "SA", geocodedPostcode: "5000", mismatch: false },
      null,
    ),
    null,
  );
  assert.equal(roofStateMismatchNotice(null, null), null);

  assert.equal(roofOmittedPlanesNotice(0, 12), null);
  assert.equal(roofOmittedPlanesNotice(-1, 12), null);
  const omitted = roofOmittedPlanesNotice(3, 12);
  assert.ok(omitted);
  assert.equal(omitted.title, "Only the first 12 faces are shown");
  assert.ok(omitted.body.includes("This roof has 15 faces"), omitted.body);
  assert.ok(omitted.body.includes("so 3 were left out"), omitted.body);
  assert.ok(roofOmittedPlanesNotice(1, 12)?.body.includes("so 1 was left out"));

  const err = roofActionErrorNotice({ heading: "Your session has expired", body: "Sign in again." });
  assert.equal(err.tone, "problem");
  assert.equal(err.level, "notice");
  assert.equal(err.title, "Your session has expired");
});

test("3.4c-5 (F128): the moved notices still RENDER, wording unchanged", () => {
  const view = viewFor(
    roofRow({
      site_cross_check: {
        job_state: "SA",
        job_postcode: "5000",
        geocoded_state: "VIC",
        geocoded_postcode: "3000",
        mismatch: true,
      },
    }),
  );
  const text = roofTextOf(renderRoofSection({ view, jobId: "j", isOpen: false }));
  assert.ok(text.includes("The address geocodes to a different state"), text.slice(0, 300));
  assert.ok(text.includes("The job was set up as SA, but the address geocodes to VIC"), text);
  assert.ok(text.includes("worth checking before quoting"), "wording moved verbatim");
});
test("D48 (3): NOTHING anywhere composes an orientation judgement", () => {
  // D48 supersedes D40 and removes the caution and its split caption. F258:
  // the caution counted panels and never read PITCH — on a57e13f1 eight of
  // the twelve it counted sat on a 5.6 degree face, very nearly flat, where
  // azimuth barely changes what the panel collects.
  const view = viewFor(A57_ROW); // 12 of 26 on southerly faces — used to fire
  // The view fields are GONE, not merely null: an orphan field is F255's defect.
  assert.ok(!("orientationNotice" in view), "orientationNotice must not exist");
  assert.ok(!("orientationSplitCaption" in view), "orientationSplitCaption must not exist");
  // And no rendered output mentions it, on the roof that used to warn.
  const text = roofTextOf(renderRoofSection({ view, jobId: "j", isOpen: true, diagram: CAPTION_DIAGRAM }));
  for (const gone of [
    "southern half", "northern half", "low-sun", "face the southern",
    "panels face", "compass",
  ]) {
    assert.ok(!text.includes(gone), `orientation judgement still on screen: ${gone}`);
  }
  // The FACTS the table states are untouched — direction and pitch per face.
  assert.ok(text.includes("faces east-south-east"), text);
});
// ── 3.4c fix 3: the roof table follows the pinned panel (F217, D39) ─────────
// Fixtures shaped on the two LIVE runs, both verified against the database on
// 2026-08-26: 0df98317 (Maxeon 6 pinned) and 523b9c93 (Auto, Tiger Neo).

const MAXEON_PANEL = {
  id: "d9e94b28-5cd2-4986-bdf7-a67d82eb9b6d",
  brand: "SunPower / Maxeon",
  model: "Maxeon 6",
  watts: 440,
  area_m2: 1.9319,
  width_mm: 1032.0,
  length_mm: 1872.0,
};

/** Run 0df98317: panel pinned; capacity point 27 panels, chosen system 20. */
const PINNED_RUN = {
  sizing_result_id: "0df98317",
  created_at: "2026-08-23T03:43:36Z",
  run_assumptions: {
    panel: MAXEON_PANEL,
    constraints_applied: {
      equipment_pin_source: { panel: "job", battery: null, inverter: null },
    },
  },
  evaluated_options: {
    chosen_solar: {
      solar_kw: 8.8, panel_count: 20,
      plane_indices: [0, 1, 3], panels_per_plane: [4, 8, 0, 8, 0, 0],
    },
    solar_options: {
      chosen_index: 3,
      points: [
        { solar_kw: 8.8, panel_count: 20, plane_indices: [0, 1, 3],
          panels_per_plane: [4, 8, 0, 8, 0, 0] },
        { solar_kw: 11.88, panel_count: 27, plane_indices: [0, 1, 3, 4, 2, 5],
          panels_per_plane: [4, 8, 2, 8, 2, 3] },
      ],
    },
  },
};

/** Run 523b9c93: Auto — no pin, whatever the stored options say. */
const AUTO_RUN = {
  sizing_result_id: "523b9c93",
  created_at: "2026-08-25T03:13:51Z",
  run_assumptions: {
    panel: { id: "p1", watts: 440 },
    constraints_applied: {
      equipment_pin_source: { panel: null, battery: null, inverter: null },
    },
  },
  evaluated_options: {
    chosen_solar: { solar_kw: 9.24, panel_count: 21, panels_per_plane: [3, 8, 0, 8, 2, 0] },
    solar_options: {
      chosen_index: 4,
      points: [
        { solar_kw: 11.44, panel_count: 26, plane_indices: [0, 1, 3, 4, 2, 5],
          panels_per_plane: [3, 8, 2, 8, 2, 3] },
      ],
    },
  },
};

const jobWithRun = (run: unknown) =>
  emptyJob({
    roof_geometry: [withImagery(A57_ROW)],
    sizing_results: [run],
  });

test("3.4c fix 3 (3): PINNED — the table shows the engine's capacity for the Maxeon", () => {
  const view = addressRoofView(jobWithRun(PINNED_RUN));
  // Today this read 26 and [3,8,2,8,2,3] — the Tiger Neo's capacity, a wrong
  // per-face capacity for the panel the engine was instructed to use (F217).
  assert.deepEqual(view.planes.map((p) => p.panelCount), [4, 8, 2, 8, 2, 3]);
  assert.deepEqual(view.planes.map((p) => p.kwp), [1.76, 3.52, 0.88, 3.52, 0.88, 1.32]);
  assert.deepEqual(view.planes.map((p) => p.kwpLabel),
    ["1.8 kW", "3.5 kW", "0.9 kW", "3.5 kW", "0.9 kW", "1.3 kW"]);
  assert.deepEqual(view.totals, { panels: 27, kwp: 11.88 });
  assert.equal(view.totalKwpLabel, "11.9 kW");
  assert.ok(view.panelLabel?.includes("Maxeon 6"), String(view.panelLabel));
  assert.equal(
    view.scaledToLine,
    "Scaled to SunPower / Maxeon Maxeon 6 440 W — the panel pinned for the current run",
  );
  // (c) the table now FOLLOWS the pin, so the disagreement notice would be
  // false — it stays silent here.
  assert.equal(view.panelMismatchNotice, null);
  // Roof facts are untouched by the pin: provenance and orientation stay.
  assert.deepEqual(
    view.planes.map((p) => p.countSource),
    ["roof_area", "google_layout", "roof_area", "google_layout", "google_layout", "google_layout"],
  );
  // And it RENDERS.
  const text = roofTextOf(
    renderRoofSection({ view, jobId: "j", isOpen: false }),
  );
  console.log(`        [pinned table] ${text.slice(text.indexOf("Direction"), text.indexOf("Direction") + 620)}`);
  assert.ok(text.includes("the panel pinned for the current run"), text);
});

test("3.4c fix 3 (4): UNPINNED — the roof row's own numbers, exactly as today", () => {
  const view = addressRoofView(jobWithRun(AUTO_RUN));
  assert.deepEqual(view.planes.map((p) => p.panelCount), [3, 8, 2, 8, 2, 3]);
  assert.deepEqual(view.totals, { panels: 26, kwp: 11.44 });
  assert.equal(view.totalKwpLabel, "11.4 kW");
  assert.equal(view.panelLabel, "Jinko Tiger Neo 440 W");
  // D47 (was "… — the panel the lookup was scaled to"): with no pin there is
  // nothing to distinguish it from, so the trailing clause described our
  // plumbing rather than the roof. Mark the exception, not the rule.
  assert.equal(view.scaledToLine, "Scaled to Jinko Tiger Neo 440 W");
  assert.ok(!view.scaledToLine.includes("—"), "no trailing clause without a pin");
  const text = roofTextOf(renderRoofSection({ view, jobId: "j", isOpen: false }));
  console.log(`        [auto table]   ${text.slice(text.indexOf("Direction"), text.indexOf("Direction") + 620)}`);
  // D47: the unpinned line carries no explanation — just the panel.
  assert.ok(text.includes("Scaled to Jinko Tiger Neo 440 W"), text);
  assert.ok(!text.includes("the panel the lookup was scaled to"), text);
});

test("3.4c fix 3 (5): the CONFUSION GUARD — capacity is the largest point, never chosen_solar", () => {
  const view = addressRoofView(jobWithRun(PINNED_RUN));
  // chosen_solar is 20 panels on this run; capacity is 27. Showing 20 as
  // capacity would be a new and worse error.
  assert.equal(view.totals.panels, 27);
  assert.notEqual(view.totals.panels, 20, "the table must never show chosen_solar as capacity");
  assert.notEqual(view.planes[2].panelCount, 0, "chosen_solar zeroes face 3; capacity does not");
});

test("3.4c fix 3 (6): totality — no run, no layout, junk points: falls back, never throws, never blanks", () => {
  const lookupCounts = [3, 8, 2, 8, 2, 3];
  const cases: [string, unknown][] = [
    ["no sizing run at all", undefined],
    ["run with no evaluated_options", { ...PINNED_RUN, evaluated_options: undefined }],
    ["run with no solar_options", { ...PINNED_RUN, evaluated_options: { chosen_solar: {} } }],
    ["solar_options is junk", { ...PINNED_RUN, evaluated_options: { solar_options: "junk" } }],
    ["points is empty", { ...PINNED_RUN, evaluated_options: { solar_options: { points: [] } } }],
    ["points are junk", { ...PINNED_RUN, evaluated_options: { solar_options: { points: ["x", null, 7] } } }],
    ["panels_per_plane wrong length", { ...PINNED_RUN, evaluated_options: { solar_options: { points: [
      { solar_kw: 11.88, panel_count: 27, panels_per_plane: [27] }] } } }],
    ["panels_per_plane junk entries", { ...PINNED_RUN, evaluated_options: { solar_options: { points: [
      { solar_kw: 11.88, panel_count: 27, panels_per_plane: [4, 8, "2", 8, 2, 3] }] } } }],
    ["stored figures disagree with themselves", { ...PINNED_RUN, evaluated_options: { solar_options: { points: [
      { solar_kw: 11.88, panel_count: 27, panels_per_plane: [3, 8, 2, 8, 2, 3] }] } } }],
    ["panel has no watts", { ...PINNED_RUN, run_assumptions: {
      panel: { id: "x" },
      constraints_applied: { equipment_pin_source: { panel: "job" } } } }],
    ["pin marker null with a layout present", AUTO_RUN],
  ];
  for (const [name, run] of cases) {
    const job = run === undefined
      ? emptyJob({ roof_geometry: [withImagery(A57_ROW)] })
      : jobWithRun(run);
    const view = addressRoofView(job);
    assert.deepEqual(view.planes.map((p) => p.panelCount), lookupCounts, name);
    assert.deepEqual(view.totals, { panels: 26, kwp: 11.44 }, name);
    assert.equal(view.scaledToLine, "Scaled to Jinko Tiger Neo 440 W", name);
    assert.doesNotThrow(() => renderRoofSection({ view, jobId: "j", isOpen: false }), name);
  }
});

test("3.4c fix 3 (c): the narrowed mismatch notice — silent when the table follows, live when it cannot", () => {
  // A pinned run whose layout is UNUSABLE and whose panel differs from the
  // lookup's: the table falls back to the lookup, so the disagreement is real
  // and the notice must still fire.
  const brokenPinned = {
    ...PINNED_RUN,
    evaluated_options: { solar_options: { points: [] } },
  };
  const view = addressRoofView(jobWithRun(brokenPinned));
  assert.ok(view.panelMismatchNotice, "the table could not follow the run — the notice stays");
  assert.ok(view.panelMismatchNotice.body.includes("Jinko Tiger Neo 440 W"),
    view.panelMismatchNotice.body);
  // And when the table DOES follow (test 3 above), it is silent — asserted there.
});
// ── D40 / D43 / D46 — the three copy changes of 2026-08-26 ─────────────────







/** Every string this module composes for a given job — the caption lines plus
 *  every notice anywhere in the view, found by walking it. A DEEP walk on
 *  purpose: F256's lesson is that a claim is not a location, so the detector
 *  must not depend on knowing which field a sentence lives in. */
function everyComposedString(view: AddressRoofView, diagram: unknown): string[] {
  const out: string[] = [...roofDiagramCaptionLines(view, diagram as never)];
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") { out.push(value); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(view);
  return out;
}

test("D48 (1): NOTHING this module composes dates, ages or vintages the PHOTOGRAPH", () => {
  // F247 fixed one composer; F256 found the same false claim in a second one
  // minutes later, because the fix repaired a LOCATION rather than a CLAIM.
  // This detector reads every string the module produces, wherever it lives.
  const SUBJECT = /\b(photo|photograph|picture)\b/i;
  const VINTAGE = /\b(dated|date|aged?|years? old|old|vintage|predates?|since then|current)\b/i;
  const fixtures: [string, unknown, unknown][] = [
    ["a57e13f1", withImagery(A57_ROW), CAPTION_DIAGRAM],
    ["456e0242", withImagery(FROME_ROW), { ...CAPTION_DIAGRAM, reason: "no_panel_positions" }],
    ["stale flag set", { ...withImagery(A57_ROW), imagery_stale: true }, CAPTION_DIAGRAM],
    ["every low-confidence cause", {
      ...withImagery(A57_ROW),
      low_confidence: true,
      flags: [
        "low_confidence_too_few_segments", "low_confidence_too_few_panels",
        "low_confidence_implausible_pitch", "low_confidence_no_google_panel_layout",
      ],
    }, CAPTION_DIAGRAM],
    ["no diagram", withImagery(roofRow()), undefined],
  ];
  for (const [name, row, diagram] of fixtures) {
    for (const raw of everyComposedString(viewFor(row), diagram)) {
      for (const sentence of raw.split(/(?<=\.)\s+/)) {
        if (SUBJECT.test(sentence)) {
          assert.ok(
            !VINTAGE.test(sentence),
            `${name}: a vintage is attributed to the photograph: ${sentence}`,
          );
        }
      }
    }
  }
  // The model's date IS stated, attributed to the model, on a lookup roof.
  const lines = roofDiagramCaptionLines(viewFor(withImagery(A57_ROW)), CAPTION_DIAGRAM as never);
  assert.ok(lines.includes("Google's solar model is dated 2018-11-17."), lines.join(" | "));
});

test("D48 (4): the newer-build notice keeps its ADVICE, with the model as its subject", () => {
  const view = viewFor({
    ...FROME_ROW,
    flags: ["low_confidence_too_few_segments", "low_confidence_result"],
  });
  const notice = view.confidenceNotices.find((n) => n.title.includes("newer build"));
  assert.ok(notice, view.confidenceNotices.map((n) => n.title).join(" | "));
  // THE ADVICE, asserted for substance rather than phrasing.
  assert.ok(/may not be the real one/i.test(notice.body), notice.body);
  assert.ok(/confirm.*against the plans/i.test(notice.body), notice.body);
  // THE SUBJECT is Google's model, never the photograph.
  assert.ok(/Google's model/i.test(notice.title + notice.body), notice.title);
  assert.ok(!/\bphoto(graph)?\b/i.test(notice.title + notice.body), notice.body);
});
test("D48 (6): the RENDERED a57e13f1 section carries none of the deleted strings", () => {
  const view = viewFor({ ...withImagery(A57_ROW), lat: -34.92, lng: 138.62 });
  const text = roofTextOf(
    renderRoofSection({ view, jobId: "j", isOpen: true, diagram: CAPTION_DIAGRAM }),
  );
  const DELETED = [
    // 1 — every reference to the photograph's date or age
    "The photo is", "years old", "Anything built or planted since then",
    "newer build than the photo", "predates this house", "medium-quality",
    // 2 — Google's own total and the whole reconciliation
    "Google's model fitted", "W assumption", "take their panel counts",
    "The faces Google assessed match the table exactly",
    "disagree on faces both assessed", "possible explanation",
    "estimated from roof area alone", "supplied the panel counts",
    // 3 — the orientation judgement
    "southern half", "northern half", "low-sun",
    // 4 — the duplicated usable-factor line in the caption
    "of each face is treated as usable",
    // 5 — the label on faces Google DID assess
    "from Google's panel layout",
  ];
  for (const dead of DELETED) {
    assert.ok(!text.includes(dead), `still rendered: ${dead}`);
  }
  // The three caption lines, and only those, in order.
  const line1 = "The panel shapes are Google's estimate for this building, drawn over Google's satellite view. The two are separate products and nothing aligns them, so the shapes are indicative.";
  const line2 = "Google's solar model is dated 2018-11-17.";
  const line3 = "The dashed box is the area Google measured.";
  assert.ok(text.includes(line1), text.slice(0, 400));
  assert.ok(text.includes(line2), text);
  assert.ok(text.includes(line3), text);
  assert.ok(text.indexOf(line1) < text.indexOf(line2), "line 1 precedes line 2");
  assert.ok(text.indexOf(line2) < text.indexOf(line3), "line 2 precedes line 3");
  // Exactly two per-face markers, on the two faces Google never assessed.
  assert.equal((text.match(/estimated from area alone/g) ?? []).length, 2);
  // The usable-area factor survives ONCE, under the table (D48 item 5).
  assert.equal((text.match(/of each face treated as usable/g) ?? []).length, 1);
});

test("D48 (7): every item on the WHAT STAYS list is still on screen", () => {
  const base = { ...withImagery(A57_ROW), lat: -34.92, lng: 138.62 };
  const render = (row: unknown, extra: Record<string, unknown> = {}, props = {}) =>
    roofTextOf(
      renderRoofSection({
        view: addressRoofView(emptyJob({ roof_geometry: [row], ...extra })),
        jobId: "j",
        isOpen: true,
        diagram: CAPTION_DIAGRAM,
        ...props,
      }),
    );

  // The address, the table (direction AND pitch), "Scaled to", the attribution.
  const main = render(base);
  assert.ok(main.includes("Direction") && main.includes("Pitch"), "the table columns");
  assert.ok(main.includes("faces east-south-east"), "direction in words");
  assert.ok(main.includes("Scaled to Jinko Tiger Neo 440 W"), "the Scaled to line");
  assert.ok(main.includes("Includes solar data from Google"), "the attribution");
  assert.ok(main.includes("The dashed box is the area Google measured."), "the box");
  // The prefill-and-confirm line (D24) and the three controls.
  assert.ok(main.includes("Roof prefilled from Google's aerial imagery"), "D24 prefill line");
  for (const control of ["Confirm this roof", "Correct these values", "Look up again"]) {
    assert.ok(main.includes(control), `control: ${control}`);
  }
  // The multi-dwelling caution (passed in, F99).
  assert.ok(
    render(base, {}, { showsMultiDwellingCaution: true }).includes(
      "The roof lookup may not be this dwelling",
    ),
    "multi-dwelling caution",
  );
  // Expired Solar Data.
  assert.ok(
    render({ ...base, solar_data_expired: true }).includes(
      "Google's roof data for this job has been deleted",
    ),
    "expired Solar Data caution",
  );
  // The three surviving low-confidence causes, plus the unrecognised fallback.
  const flagged = render({
    ...base,
    low_confidence: true,
    planes: [{ azimuth: 173, pitch: 77, panel_count: 23, kwp: 10.12 }],
    flags: [
      "low_confidence_implausible_pitch",
      "low_confidence_no_google_panel_layout",
      "low_confidence_madeup",
    ],
  });
  assert.ok(flagged.includes("One of these faces is too steep to be a roof"), "too steep");
  assert.ok(flagged.includes("Google could not fit any panels on this building"), "no panels fitted");
  assert.ok(flagged.includes("Something about this result looks wrong"), "unrecognised flag");
  // The confirmed-roof notice.
  assert.ok(
    render({ ...base, roof_confirmed_at: "2026-08-25T07:41:51Z", roof_confirmed_source: "installer" })
      .includes("Roof confirmed"),
    "confirmed notice",
  );
  // The panel-versus-quote mismatch notice (D39).
  const mismatch = render(
    { ...base, selected_panel: { id: "panel-a", brand: "Jinko", model: "Tiger Neo", watts: 440 } },
    { sizing_results: [{ sizing_result_id: "s1", created_at: "2026-08-25T00:00:00Z",
        run_assumptions: { panel: { id: "panel-b", watts: 475 } } }] },
  );
  assert.ok(mismatch.includes("scaled to a different panel than the quote"), "D39 mismatch notice");
});
test("D47 (4): RENDER on a57e13f1 — direction without pitch, Scaled to without a clause", () => {
  const view = viewFor({
    ...withImagery(A57_ROW),
    lat: -34.92,
    lng: 138.62,
    selected_panel: { id: "p1", brand: "Jinko", model: "Tiger Neo", watts: 440 },
  });
  const text = roofTextOf(
    renderRoofSection({ view, jobId: "j", isOpen: true, diagram: CAPTION_DIAGRAM }),
  );
  // CHANGE 1: the direction is in words, the pitch is NOT restated beside it.
  assert.ok(text.includes("faces east-south-east"), text.slice(0, 300));
  assert.ok(!text.includes("6 degree pitch"), "the pitch is not printed twice");
  assert.ok(!/degree pitch/.test(text), "no face restates its pitch in words");
  // ...and the Pitch column still carries it, so nothing was lost.
  assert.ok(text.includes("6°"), "the Pitch column still reads 6°");
  // CHANGE 2: the unpinned line is the panel and nothing else.
  assert.ok(text.includes("Scaled to Jinko Tiger Neo 440 W"), text);
  assert.ok(!text.includes("the panel the lookup was scaled to"), text);
  // The full line, as it reads on screen — no trailing dash clause.
  assert.ok(
    text.includes("Scaled to Jinko Tiger Neo 440 W · 70% of each face treated as usable"),
    text,
  );
});
