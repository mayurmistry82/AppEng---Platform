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
  addressRoofView,
  azimuthLabel,
  planeFormRowsFromView,
  latestRoofGeometry,
  resultsBarView,
  roofEntryState,
  sectionStates,
  sectionsForPath,
  siteDetailsView,
  worksheetErrorCopy,
  type JobDetailLike,
} from "../lib/worksheet.ts";
import type { ApiErrorKind } from "../lib/jobs.ts";

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
    assert.equal(states[i].state, "locked", states[i].id);
  }
  assert.deepEqual(phaseStates(emptyJob()), [
    "current",
    "pending",
    "pending",
    "pending",
  ]);
});

// e. roof_geometry populated -> 1 complete, 2 active
test("roof done: section 1 complete, section 2 active", () => {
  const job = emptyJob({ roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }] });
  const states = sectionStates(job);
  assert.equal(states[0].state, "complete");
  assert.equal(states[1].state, "active");
  assert.equal(states[2].state, "locked");
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
  assert.equal(states[1].state, "locked", "Site details must stay locked");
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
  // A job with a usable roof row and NO site details: Site details is the active
  // section and the phase rail reads exactly as before this task. Asserted
  // against the exact pre-change output, not eyeballed.
  const job = emptyJob({
    roof_geometry: [{ created_at: "2026-08-01T00:00:00Z", found: true, planes: [{ panel_count: 12 }] }],
  });
  const states = sectionStates(job);
  assert.equal(states[0].id, "address-roof");
  assert.equal(states[0].state, "complete");
  assert.equal(states[1].id, "site-details");
  assert.equal(states[1].state, "active");
  assert.equal(states[2].state, "locked");
  assert.deepEqual(phaseStates(job), ["current", "pending", "pending", "pending"]);

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
