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
  resultsBarDefaultCollapsed,
  resultsBarMaxHeight,
  resultsBarView,
  sectionStates,
  sectionsForPath,
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
  const job = emptyJob({ roof_geometry: [{ roof_id: "r1" }] });
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
    roof_geometry: [{ roof_id: "r1" }],
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
    roof_geometry: [{ roof_id: "r1" }],
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
