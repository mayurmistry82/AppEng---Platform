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
  addressRoofView,
  energyDataView,
  intervalUploadView,
  azimuthLabel,
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
import { postFormData } from "../lib/client-api.ts";

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
    // D5 (2026-08-18): site-details is NON-GATING, so it is "unlocked" rather
    // than "locked" even here, with the gating section above it still active —
    // an optional section must always be openable. Every OTHER section locks
    // exactly as before.
    const expected = states[i].id === "site-details" ? "unlocked" : "locked";
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
  // objective-budget / equipment-specs / incentives are () => false by design
  // (no columns exist until 3.9 / 3.10 / 3.13b), so "all true" means: force
  // them true to test the aggregate rule, not the schema.
  const patched = SECTIONS.map((s) =>
    ["objective-budget", "equipment-specs", "incentives"].includes(s.id)
      ? { ...s, complete: () => true }
      : s,
  );
  const done = patched.map((s) => s.complete(job));
  assert.ok(done.every(Boolean), `not all predicates true: ${JSON.stringify(done)}`);
  // The three always-false ones really are always false against ANY job:
  for (const id of ["objective-budget", "equipment-specs", "incentives"]) {
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
// LIMITATION, MEASURED NOT ASSUMED (reported with 3.3b): the prompt asked for a
// fixture where all three of path E's Optimise sections are complete, so that
// Optimise reads "done". That fixture CANNOT be built today — Optimise contains
// `objective-budget` and `equipment-specs`, both hardcoded `() => false` until
// 3.9/3.10, on every one of the six paths. Optimise therefore cannot read "done"
// for any job, and swapping phaseStates to count the full catalogue instead of
// the visible list produces IDENTICAL verdicts on every path (verified by
// experiment — the suite stayed green under that mutation). The visible-list
// dependency inside phaseStates is therefore not observable through its public
// behaviour yet; it becomes a real regression test the moment 3.9 lands and
// objective-budget becomes satisfiable.
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
  assert.equal(byBody(REAL_FLAGS.substituted)?.level, "caption", "substituted reads: method fact");
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

  // With site-details COMPLETE, it is not first-incomplete under either rule, so
  // the two must agree on every one of the eleven sections.
  const filled = liveShapedJob({
    storeys: 1, roof_material: "tile", dwelling_type: "unit", electrical_phase: "single",
  });
  assert.deepEqual(
    sectionStates(filled).map((s) => ({ id: s.id, state: s.state })),
    referenceStates(filled),
    "with the optional section filled in, the new rule and the old rule agree exactly",
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
      { id: "equipment-specs", state: "locked" },
      { id: "solar-sizing", state: "locked" },
      { id: "battery-sizing", state: "locked" },
      { id: "results", state: "locked" },
      { id: "incentives", state: "locked" },
      { id: "summary-finish", state: "locked" },
    ],
  );
  // ...and EXACTLY TWO sections differ from the old rule: the optional section
  // itself (active -> unlocked) and the one that should have been active all
  // along (locked -> active). Everything below was already locked under both
  // rules and stays locked, so the change is narrower than it looks: the
  // sections beneath are unlocked by DOING the work, not by this flag.
  const before = referenceStates(empty);
  const after = sectionStates(empty).map((s) => ({ id: s.id, state: s.state }));
  const moved = after
    .filter((a, i) => a.state !== before[i].state)
    .map((a) => `${a.id}: ${before[after.indexOf(a)].state} -> ${a.state}`);
  assert.deepEqual(moved, [
    "site-details: active -> unlocked",
    "energy-data: locked -> active",
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
  // And the catalogue itself: exactly ONE section is non-gating.
  const nonGating = SECTIONS.filter((s) => s.gates === false).map((s) => s.id);
  assert.deepEqual(nonGating, ["site-details"]);
  for (const s of SECTIONS) {
    if (s.id !== "site-details") {
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
