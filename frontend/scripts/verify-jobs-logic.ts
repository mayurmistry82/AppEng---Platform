/**
 * verify-jobs-logic.ts — checklist 3.1 fixture harness for lib/jobs.ts.
 *
 * Run: node --test --experimental-strip-types scripts/verify-jobs-logic.ts
 *
 * The 18-job fixture below is an IN-MEMORY object — it never touches a
 * database (the production jobs table has zero rows and stays that way).
 * lib/jobs.ts is imported with an explicit relative .ts path because type
 * stripping does not resolve the @/ alias.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DISABLED_PATH_REASON,
  FILTERS,
  JOB_STATUSES,
  NOT_YET_SIZED,
  buildJobsQuery,
  clientActionErrorCopy,
  derivePath,
  errorPanelCopy,
  formatCompactAud,
  formatResult,
  formatTier,
  formatUpdated,
  formatWinRate,
  sizingOptions,
  summariseJobs,
  type ApiErrorKind,
  type JobIntent,
  type JobKpis,
  type JobListItem,
  EDIT_JOB_FOOTER_NOTE,
  NEW_JOB_FOOTER_NOTE,
  UNIT_ADDRESS_HINT,
  jobDialogFooterNote,
  jobEditErrorCopy,
  needsUnitNumberHint,
} from "../lib/jobs.ts";

/** Runtime-shaped garbage reaching a typed formatter — cast via unknown, never `any`. */
function unsafe<T>(v: unknown): T {
  return v as T;
}

function job(overrides: Partial<JobListItem> & { job_id: string }): JobListItem {
  return {
    customer_name: "T. Nguyen",
    address: "12 Example St, Adelaide SA",
    status: "draft",
    path: "A",
    path_label: "Solar + battery",
    headline: { solar_kw: 6.6, battery_kwh: 13.5, payback_years: 5.2 },
    accuracy_tier: 2,
    assigned_to: null,
    notes: null,
    scheduled_date: null,
    event_type: null,
    updated_at: "2026-08-02T04:00:00Z",
    ...overrides,
  };
}

// ── The 18-job fixture ───────────────────────────────────────────────────────
// Covers: all six statuses (incl. installed); solar only; battery only; both;
// none; payback null with sizes present; tiers 1/2/3/null; customer_name null;
// address null; notes null + non-null; updated_at null + an ISO that falls on
// a different calendar day in UTC than in Australia/Adelaide.
const ADELAIDE_BOUNDARY_ISO = "2026-08-01T15:30:00Z"; // 1 Aug UTC → 2 Aug ACST (+9:30)

const FIXTURE: JobListItem[] = [
  job({ job_id: "j01", status: "draft", accuracy_tier: 3 }),
  job({
    job_id: "j02",
    status: "sized",
    headline: { solar_kw: 9.2, battery_kwh: null, payback_years: 6.4 }, // solar only
    accuracy_tier: 2,
  }),
  job({
    job_id: "j03",
    status: "sent",
    headline: { solar_kw: null, battery_kwh: 10, payback_years: 6.4 }, // battery only
    accuracy_tier: 1,
  }),
  job({
    job_id: "j04",
    status: "won",
    headline: { solar_kw: null, battery_kwh: null, payback_years: null }, // none
    accuracy_tier: null,
    customer_name: null,
  }),
  job({
    job_id: "j05",
    status: "installed",
    headline: { solar_kw: 9.2, battery_kwh: 10, payback_years: null }, // sizes, no payback
    address: null,
  }),
  job({
    job_id: "j06",
    status: "lost",
    notes: "Went with a cheaper quote",
    updated_at: ADELAIDE_BOUNDARY_ISO,
  }),
  job({ job_id: "j07", status: "draft", updated_at: null }),
  job({
    job_id: "j08",
    status: "sized",
    headline: { solar_kw: 9.2, battery_kwh: 10, payback_years: 6.4 }, // both + payback
  }),
  job({
    job_id: "j09",
    status: "sent",
    headline: { solar_kw: 9.2, battery_kwh: null, payback_years: null }, // solar, no payback
  }),
  job({ job_id: "j10", status: "installed", accuracy_tier: 3, notes: "Panels up 28 Jul" }),
  job({ job_id: "j11", status: "won", accuracy_tier: 1 }),
  job({ job_id: "j12", status: "draft", customer_name: null, address: null }),
  job({ job_id: "j13", status: "sent", updated_at: "not-a-timestamp" }),
  job({ job_id: "j14", status: "lost", accuracy_tier: null }),
  job({ job_id: "j15", status: "sized", notes: "   " }), // whitespace-only note = no note
  job({ job_id: "j16", status: "won", headline: { solar_kw: 13, battery_kwh: 27, payback_years: 3.9 } }),
  job({ job_id: "j17", status: "installed", headline: { solar_kw: null, battery_kwh: 13.5, payback_years: 3.9 } }),
  job({ job_id: "j18", status: "draft", accuracy_tier: 2, updated_at: "2026-07-28T10:00:00+09:30" }),
];

const KPIS: JobKpis = {
  pipeline_value: 84200,
  win_rate: 0.61,
  in_progress: 7,
  won_this_month: { count: 4, value: 61000 },
};

test("fixture integrity: 18 jobs covering all six statuses incl. installed", () => {
  assert.equal(FIXTURE.length, 18);
  for (const status of JOB_STATUSES) {
    assert.ok(
      FIXTURE.some((j) => j.status === status),
      `fixture missing status ${status}`,
    );
  }
  assert.ok(FIXTURE.filter((j) => j.status === "installed").length >= 1);
});

// a. In progress → exactly three repeated status params
test("buildJobsQuery: In progress emits exactly draft, sized, sent", () => {
  const params = buildJobsQuery({ filter: "in-progress" });
  assert.deepEqual(params.getAll("status"), ["draft", "sized", "sent"]);
});

// b. All → NO status param at all
test("buildJobsQuery: All emits no status param", () => {
  const params = buildJobsQuery({ filter: "all" });
  assert.deepEqual(params.getAll("status"), []);
  assert.equal(params.has("status"), false);
});

// c. Won / Lost → exactly one each
test("buildJobsQuery: Won and Lost each emit exactly one status", () => {
  assert.deepEqual(buildJobsQuery({ filter: "won" }).getAll("status"), ["won"]);
  assert.deepEqual(buildJobsQuery({ filter: "lost" }).getAll("status"), ["lost"]);
});

// d. Unknown filter and unknown sort silently fall back to All / updated_desc
test("buildJobsQuery: unknown filter and sort fall back to All / updated_desc", () => {
  const params = buildJobsQuery({ filter: "banana", sort: "sideways" });
  assert.deepEqual(params.getAll("status"), []);
  assert.equal(params.get("sort"), "updated_desc");
});

// e. formatResult — the exact string for all six headline shapes
test("formatResult: exact strings for the six headline shapes", () => {
  assert.equal(
    formatResult({ solar_kw: 9.2, battery_kwh: 10, payback_years: 6.4 }),
    "9.2 kW + 10 kWh · 6.4 yr",
  );
  assert.equal(
    formatResult({ solar_kw: 9.2, battery_kwh: null, payback_years: 6.4 }),
    "9.2 kW · 6.4 yr",
  );
  assert.equal(
    formatResult({ solar_kw: null, battery_kwh: 10, payback_years: 6.4 }),
    "10 kWh · 6.4 yr",
  );
  // Sizes but no payback → the size part alone, no trailing " · "
  assert.equal(
    formatResult({ solar_kw: 9.2, battery_kwh: 10, payback_years: null }),
    "9.2 kW + 10 kWh",
  );
  assert.equal(
    formatResult({ solar_kw: 9.2, battery_kwh: null, payback_years: null }),
    "9.2 kW",
  );
  assert.equal(
    formatResult({ solar_kw: null, battery_kwh: null, payback_years: null }),
    "— not yet sized",
  );
  assert.equal(NOT_YET_SIZED, "— not yet sized");
});

// f. formatTier — low only for tier 1; "—" for null
test("formatTier: low=true for tier 1 only, dash for null", () => {
  assert.deepEqual(formatTier(1), { label: "Tier 1", low: true });
  assert.deepEqual(formatTier(2), { label: "Tier 2", low: false });
  assert.deepEqual(formatTier(3), { label: "Tier 3", low: false });
  assert.deepEqual(formatTier(null), { label: "—", low: false });
});

// g. formatUpdated — Adelaide day, not UTC day, at the boundary
test("formatUpdated: renders the Adelaide day for the UTC-boundary case", () => {
  // 2026-08-01T15:30:00Z is 1 Aug in UTC but 01:00 on 2 Aug in Australia/Adelaide.
  assert.equal(formatUpdated(ADELAIDE_BOUNDARY_ISO), "2 Aug");
  assert.notEqual(formatUpdated(ADELAIDE_BOUNDARY_ISO), "1 Aug");
  assert.equal(formatUpdated("2026-08-02T04:00:00Z"), "2 Aug");
  assert.equal(formatUpdated(null), "—");
  assert.equal(formatUpdated("not-a-timestamp"), "—");
});

// h. Null money/rate → "—", never "$0" / "0%"
test("formatCompactAud / formatWinRate: dash for null, never $0 / 0%", () => {
  assert.equal(formatCompactAud(null), "—");
  assert.equal(formatWinRate(null), "—");
  assert.notEqual(formatCompactAud(null), "$0");
  assert.notEqual(formatWinRate(null), "0%");
  assert.equal(formatCompactAud(84200), "$84.2k");
  assert.equal(formatCompactAud(61000), "$61k");
  assert.equal(formatCompactAud(610), "$610");
  assert.equal(formatWinRate(0.61), "61%");
});

// i. No exported formatter throws for null, undefined or NaN — per formatter
test("formatters never throw on null / undefined / NaN", () => {
  assert.doesNotThrow(() => formatResult(null));
  assert.doesNotThrow(() => formatResult(undefined));
  assert.doesNotThrow(() =>
    formatResult({ solar_kw: NaN, battery_kwh: NaN, payback_years: NaN }),
  );

  assert.doesNotThrow(() => formatTier(null));
  assert.doesNotThrow(() => formatTier(undefined));
  assert.doesNotThrow(() => formatTier(NaN));

  assert.doesNotThrow(() => formatUpdated(null));
  assert.doesNotThrow(() => formatUpdated(undefined));
  assert.doesNotThrow(() => formatUpdated(unsafe<string>(NaN)));

  assert.doesNotThrow(() => formatCompactAud(null));
  assert.doesNotThrow(() => formatCompactAud(undefined));
  assert.doesNotThrow(() => formatCompactAud(NaN));

  assert.doesNotThrow(() => formatWinRate(null));
  assert.doesNotThrow(() => formatWinRate(undefined));
  assert.doesNotThrow(() => formatWinRate(NaN));

  // NaN inside a headline renders the placeholder, not "NaN kW"
  assert.equal(
    formatResult({ solar_kw: NaN, battery_kwh: NaN, payback_years: NaN }),
    NOT_YET_SIZED,
  );
});

// summariseJobs over the full fixture — one bad field never drops a row
test("summariseJobs: 18 rows, per-column null handling, KPI tiles", () => {
  const { tiles, rows } = summariseJobs(FIXTURE, KPIS);
  assert.equal(rows.length, 18);

  const byId = new Map(rows.map((r) => [r.jobId, r]));
  assert.equal(byId.get("j04")?.customerName, "Unnamed customer");
  assert.equal(byId.get("j05")?.address, "No address yet");
  assert.equal(byId.get("j07")?.updated, "—");
  assert.equal(byId.get("j13")?.updated, "—");
  assert.equal(byId.get("j06")?.updated, "2 Aug"); // Adelaide day, not 1 Aug UTC
  assert.equal(byId.get("j15")?.notes, null); // whitespace-only note = no note
  assert.equal(byId.get("j06")?.notes, "Went with a cheaper quote");
  assert.equal(byId.get("j04")?.result, NOT_YET_SIZED);
  assert.equal(byId.get("j04")?.resultMuted, true);
  assert.equal(byId.get("j05")?.result, "9.2 kW + 10 kWh");
  assert.equal(byId.get("j03")?.tierLow, true);
  assert.equal(byId.get("j04")?.tierLabel, "—");
  assert.equal(byId.get("j01")?.href, "/jobs/j01/worksheet");

  assert.equal(tiles[0].value, "$84.2k");
  assert.equal(tiles[1].value, "61%");
  assert.equal(tiles[2].value, "7");
  assert.equal(tiles[3].value, "4");
  assert.equal(tiles[3].delta, "$61k modelled value");
  // F25 — never "installed value"
  for (const tile of tiles) assert.ok(!tile.delta.includes("installed value"));

  // Absent KPI object → all four tiles "—", strip still renders
  const empty = summariseJobs(FIXTURE, null);
  assert.deepEqual(
    empty.tiles.map((t) => t.value),
    ["—", "—", "—", "—"],
  );
  assert.doesNotThrow(() => summariseJobs(null, null));
});

// ── errorPanelCopy (F55) ─────────────────────────────────────────────────────
const KINDS: ApiErrorKind[] = ["config", "auth", "network", "http", "parse"];
const ENDPOINT = "/api/jobs";

// a. A distinct heading for each of the five kinds
test("errorPanelCopy: each of the five kinds has a distinct heading", () => {
  const headings = KINDS.map((k) => errorPanelCopy(k, 500, ENDPOINT).heading);
  assert.equal(new Set(headings).size, KINDS.length, `not distinct: ${headings.join(" | ")}`);
});

// b. THE POINT OF F55 — a config fault must never read as an auth fault
test("errorPanelCopy: config copy never says session / sign in / expired", () => {
  const { heading, body } = errorPanelCopy("config", 500, ENDPOINT);
  const text = `${heading} ${body}`.toLowerCase();
  for (const banned of ["session", "sign in", "expired"]) {
    assert.ok(
      !text.includes(banned),
      `config copy must not contain ${JSON.stringify(banned)}: ${text}`,
    );
  }
  // It must instead name the two env vars, by NAME only — never a value.
  assert.ok(body.includes("NEXT_PUBLIC_SUPABASE_URL"));
  assert.ok(body.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
});

// c. The auth copy DOES send the installer to sign in
test("errorPanelCopy: auth copy mentions signing in", () => {
  const { heading, body } = errorPanelCopy("auth", 401, ENDPOINT);
  const text = `${heading} ${body}`.toLowerCase();
  assert.ok(text.includes("sign in"), text);
  assert.ok(text.includes("session"), text);
});

// d. No kind returns an empty heading or body
test("errorPanelCopy: no kind returns an empty heading or body", () => {
  for (const kind of KINDS) {
    const { heading, body } = errorPanelCopy(kind, 500, ENDPOINT);
    assert.ok(heading.trim().length > 0, `${kind} heading empty`);
    assert.ok(body.trim().length > 0, `${kind} body empty`);
  }
});

test("errorPanelCopy: network and http surface the endpoint and status", () => {
  assert.ok(errorPanelCopy("network", 0, ENDPOINT).body.includes(ENDPOINT));
  assert.ok(errorPanelCopy("network", 0, ENDPOINT).body.includes("port 8000"));
  // 500, not 503 — 503 gained its own database-unavailable branch at 3.4-B, so it
  // is no longer a valid example of the GENERIC http copy this test pins.
  const http = errorPanelCopy("http", 500, ENDPOINT).body;
  assert.ok(http.includes(ENDPOINT) && http.includes("500"), http);
  assert.ok(errorPanelCopy("parse", 200, ENDPOINT).body.includes("could not read"));
});

// An unrecognised kind (impossible via the type, reachable via bad data) must
// fall back to the http copy rather than rendering an empty panel.
test("errorPanelCopy: an unrecognised kind falls back to the http copy", () => {
  const bogus = errorPanelCopy(unsafe<ApiErrorKind>("banana"), 500, ENDPOINT);
  assert.deepEqual(bogus, errorPanelCopy("http", 500, ENDPOINT));
  assert.ok(bogus.heading.trim().length > 0);
});

// ── derivePath / sizingOptions (checklist 3.2) ───────────────────────────────

// a. All six valid combinations, each asserted explicitly — no table loop.
test("derivePath: all six combinations map exactly as backend/job_paths.py", () => {
  assert.equal(derivePath(false, "solar"), "A");
  assert.equal(derivePath(false, "both"), "B");
  assert.equal(derivePath(true, "battery"), "C");
  assert.equal(derivePath(true, "both"), "D");
  assert.equal(derivePath(false, "battery"), "E");
  assert.equal(derivePath(true, "solar"), "F");
});

// b. Null for incomplete or invalid input — and it never throws.
test("derivePath: null for null intent, null solar flag, invalid intent", () => {
  assert.equal(derivePath(false, null), null);
  assert.equal(derivePath(true, null), null);
  assert.equal(derivePath(null, "solar"), null);
  assert.equal(derivePath(null, null), null);
  assert.equal(derivePath(undefined, "both"), null);
  assert.equal(derivePath(false, unsafe<JobIntent>("heat-pump")), null);
  assert.doesNotThrow(() => derivePath(unsafe<boolean>("yes"), unsafe<JobIntent>(42)));
});

// c. Section hidden until step 3 is answered.
test("sizingOptions: null returns []", () => {
  assert.deepEqual(sizingOptions(null), []);
  assert.deepEqual(sizingOptions(undefined), []);
});

// d. No existing solar → A, B, E, all enabled.
test("sizingOptions(false): exactly A, B, E — all enabled", () => {
  const options = sizingOptions(false);
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => o.path), ["A", "B", "E"]);
  for (const o of options) assert.equal(o.enabled, true, `${o.path} should be enabled`);
});

// e. Has solar → C, D disabled (D1), F enabled. ONE selectable option is intended.
test("sizingOptions(true): C and D disabled, F enabled", () => {
  const options = sizingOptions(true);
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => o.path), ["C", "D", "F"]);
  const byPath = new Map(options.map((o) => [o.path, o]));
  assert.equal(byPath.get("C")?.enabled, false, "C must be disabled until 4.1");
  assert.equal(byPath.get("D")?.enabled, false, "D must be disabled until 4.1");
  assert.equal(byPath.get("F")?.enabled, true, "F must be enabled");
  assert.equal(options.filter((o) => o.enabled).length, 1);
});

// f. The disabled reason is real and names 4.1.
test("DISABLED_PATH_REASON: non-empty and mentions 4.1", () => {
  assert.ok(DISABLED_PATH_REASON.trim().length > 0);
  assert.ok(DISABLED_PATH_REASON.includes("4.1"));
});

// The option list's intents and the path derivation must agree with each other.
test("sizingOptions and derivePath are mutually consistent", () => {
  for (const has of [false, true]) {
    for (const option of sizingOptions(has)) {
      assert.equal(derivePath(has, option.intent), option.path);
    }
  }
});

// The four tabs stay exactly the wireframe's four — installed gets no fifth tab
test("FILTERS: exactly four tabs, installed only reachable under All", () => {
  assert.equal(FILTERS.length, 4);
  assert.deepEqual(
    FILTERS.map((f) => f.id),
    ["all", "in-progress", "won", "lost"],
  );
  for (const f of FILTERS) {
    // Widening cast: each tab's `statuses` is a distinct literal tuple, so
    // .includes() on the union narrows its parameter to `never`.
    assert.ok(
      !(f.statuses as readonly string[]).includes("installed"),
      "installed must not be folded into any tab",
    );
  }
});

// ── errorPanelCopy 503 branch (3.4-B — the F88 residual) ─────────────────────

test("errorPanelCopy: 503 says database-unavailable, never authorisation", () => {
  const copy = errorPanelCopy("http", 503, ENDPOINT);
  const text = `${copy.heading} ${copy.body}`.toLowerCase();
  for (const banned of ["sign", "session", "permission", "expired"]) {
    assert.ok(!text.includes(banned), `503 copy must not contain ${JSON.stringify(banned)}: ${text}`);
  }
  assert.ok(copy.heading !== errorPanelCopy("http", 500, ENDPOINT).heading);
  assert.ok(text.includes("temporar"), text);
});

test("errorPanelCopy: the other branches are byte-identical to pre-3.4-B", () => {
  // Asserted, not eyeballed: the exact pre-change objects.
  assert.deepEqual(errorPanelCopy("config", 500, ENDPOINT), {
    heading: "Jobs can't load — the app is misconfigured",
    body: "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Set both in the deployment environment and redeploy.",
  });
  assert.deepEqual(errorPanelCopy("auth", 401, ENDPOINT), {
    heading: "Couldn't load jobs — you may be signed out",
    body: `${ENDPOINT} responded with HTTP 401. Your session may have expired — sign in again.`,
  });
  assert.deepEqual(errorPanelCopy("network", 0, ENDPOINT), {
    heading: "Couldn't load jobs — the backend is unreachable",
    body: `The request to ${ENDPOINT} never reached the server. Check the backend is running on port 8000.`,
  });
  assert.deepEqual(errorPanelCopy("parse", 200, ENDPOINT), {
    heading: "Couldn't load jobs — the response was unreadable",
    body: `${ENDPOINT} returned a response the app could not read. Try reloading, and check the backend logs if it persists.`,
  });
  assert.deepEqual(errorPanelCopy("http", 500, ENDPOINT), {
    heading: "Couldn't load jobs",
    body: `${ENDPOINT} responded with HTTP 500. The backend hit an error — try reloading, and check the backend logs if it persists.`,
  });
  // A 503 under a NON-http kind still takes that kind's own branch.
  assert.equal(
    errorPanelCopy("network", 503, ENDPOINT).heading,
    "Couldn't load jobs — the backend is unreachable",
  );
});

// ── clientActionErrorCopy (3.4-E) ────────────────────────────────────────────
// Worded for a FAILED BUTTON PRESS, not a failed page load. Kept separate from
// errorPanelCopy on purpose: "try reloading" is right for a page that would not
// load and wrong for an installer with a half-filled form open.

test("clientActionErrorCopy: every branch has non-empty, distinct copy", () => {
  const kinds: ApiErrorKind[] = ["config", "auth", "network", "http", "parse"];
  const headings = kinds.map((k) => clientActionErrorCopy(k, 500).heading);
  assert.equal(new Set(headings).size, kinds.length, headings.join(" | "));
  for (const kind of kinds) {
    const copy = clientActionErrorCopy(kind, 500);
    assert.ok(copy.heading.trim().length > 0, `${kind} heading empty`);
    assert.ok(copy.body.trim().length > 0, `${kind} body empty`);
  }
});

test("clientActionErrorCopy: the auth branch is the expired-session wording", () => {
  const copy = clientActionErrorCopy("auth", 401);
  assert.equal(copy.heading, "Your session has expired");
  assert.equal(
    copy.body,
    "Sign in again and your work on this page will still be here.",
  );
});

test("clientActionErrorCopy: auth copy never mentions a token, cookie or env var", () => {
  const copy = clientActionErrorCopy("auth", 401);
  const text = `${copy.heading} ${copy.body}`.toLowerCase();
  for (const banned of ["token", "cookie", "jwt", "bearer", "env", "supabase"]) {
    assert.ok(!text.includes(banned), `auth copy must not contain ${banned}: ${text}`);
  }
});

test("clientActionErrorCopy: auth copy DIFFERS from errorPanelCopy's auth copy", () => {
  // They serve different situations — a dead page vs a dead button press — and a
  // later tidy-up must not silently unify them.
  const action = clientActionErrorCopy("auth", 401);
  const panel = errorPanelCopy("auth", 401, ENDPOINT);
  assert.notEqual(action.heading, panel.heading);
  assert.notEqual(action.body, panel.body);
  // The page copy tells you to reload; the action copy must NOT.
  assert.ok(!`${action.heading} ${action.body}`.toLowerCase().includes("reload"));
});

test("clientActionErrorCopy: 409 and 422 say the server rejected the values", () => {
  for (const status of [409, 422]) {
    const copy = clientActionErrorCopy("http", status);
    assert.equal(copy.heading, "The server rejected these values");
    assert.ok(copy.body.toLowerCase().includes("not valid"), copy.body);
  }
  // A plain 500 keeps the generic wording, not the rejection wording.
  assert.notEqual(
    clientActionErrorCopy("http", 500).heading,
    "The server rejected these values",
  );
  assert.ok(clientActionErrorCopy("http", 500).body.includes("500"));
});

test("clientActionErrorCopy: parse carries the real status; network reassures", () => {
  assert.ok(clientActionErrorCopy("parse", 502).body.includes("502"));
  assert.ok(
    clientActionErrorCopy("network", 0).body.toLowerCase().includes("port 8000"),
  );
  // Nothing entered is lost — say so, on both.
  assert.ok(clientActionErrorCopy("network", 0).body.toLowerCase().includes("lost"));
});

test("clientActionErrorCopy: an unrecognised kind falls back, never empty", () => {
  const bogus = clientActionErrorCopy(unsafe<ApiErrorKind>("banana"), 500);
  assert.deepEqual(bogus, clientActionErrorCopy("http", 500));
  assert.ok(bogus.heading.trim().length > 0);
});

test("errorPanelCopy: all six branches BYTE-IDENTICAL after 3.4-E", () => {
  // Asserted, not eyeballed — adding a sibling function must not disturb it.
  assert.deepEqual(errorPanelCopy("config", 500, ENDPOINT), {
    heading: "Jobs can't load — the app is misconfigured",
    body: "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Set both in the deployment environment and redeploy.",
  });
  assert.deepEqual(errorPanelCopy("auth", 401, ENDPOINT), {
    heading: "Couldn't load jobs — you may be signed out",
    body: `${ENDPOINT} responded with HTTP 401. Your session may have expired — sign in again.`,
  });
  assert.deepEqual(errorPanelCopy("network", 0, ENDPOINT), {
    heading: "Couldn't load jobs — the backend is unreachable",
    body: `The request to ${ENDPOINT} never reached the server. Check the backend is running on port 8000.`,
  });
  assert.deepEqual(errorPanelCopy("parse", 200, ENDPOINT), {
    heading: "Couldn't load jobs — the response was unreadable",
    body: `${ENDPOINT} returned a response the app could not read. Try reloading, and check the backend logs if it persists.`,
  });
  assert.deepEqual(errorPanelCopy("http", 503, ENDPOINT), {
    heading: "Couldn't load jobs — the server is briefly unavailable",
    body: "The server could not reach its database for a moment. This is usually temporary — wait a few seconds and reload.",
  });
  assert.deepEqual(errorPanelCopy("http", 500, ENDPOINT), {
    heading: "Couldn't load jobs",
    body: `${ENDPOINT} responded with HTTP 500. The backend hit an error — try reloading, and check the backend logs if it persists.`,
  });
});

// ── 3.3c: the unit-address nudge (F99) and the edit-error copy ───────────────

test("3.3c 2i: bare street addresses need the unit hint", () => {
  // Both are REAL rows in the live database — the exact strings the check
  // exists for.
  assert.equal(
    needsUnitNumberHint("53 Bishops Pl, Kensington SA 5068, Australia"),
    true,
  );
  assert.equal(
    needsUnitNumberHint("14 Frome St, Adelaide SA 5000, Australia"),
    true,
  );
  assert.ok(UNIT_ADDRESS_HINT.includes("Add the unit number"));
});

test("3.3c 2j: unit-marked addresses do NOT get the hint", () => {
  for (const address of [
    "Unit 5/53 Bishops Pl, Kensington SA 5068",
    "unit 5/53 Bishops Pl, Kensington SA 5068, Australia",
    "5/53 Bishops Pl, Kensington SA 5068",
    "U5 53 Bishops Pl",
    "Apt 2, 10 High St",
    "Lot 3, 22 Oak Ave",
  ]) {
    assert.equal(needsUnitNumberHint(address), false, address);
  }
});

test("3.3c 2k: empty and non-address strings never get the hint", () => {
  assert.equal(needsUnitNumberHint(""), false);
  assert.equal(needsUnitNumberHint("   "), false);
  assert.equal(needsUnitNumberHint("abc"), false);
});

test("3.3c 2l: jobEditErrorCopy — the 409 carries the server's own words", () => {
  const specific = jobEditErrorCopy("http", 409, "This job's address is locked — X.");
  assert.equal(specific.heading, "This change was rejected");
  assert.equal(specific.body, "This job's address is locked — X.");
  // Empty server message falls back to the generic copy.
  assert.deepEqual(jobEditErrorCopy("http", 409, ""), clientActionErrorCopy("http", 409));
  assert.deepEqual(jobEditErrorCopy("http", 409, "   "), clientActionErrorCopy("http", 409));
  // Every other kind/status is EXACTLY the shared copy.
  assert.deepEqual(jobEditErrorCopy("http", 500, "x"), clientActionErrorCopy("http", 500));
  assert.deepEqual(jobEditErrorCopy("http", 404, "x"), clientActionErrorCopy("http", 404));
  assert.deepEqual(jobEditErrorCopy("auth", 401, "x"), clientActionErrorCopy("auth", 401));
  assert.deepEqual(jobEditErrorCopy("network", 0, "x"), clientActionErrorCopy("network", 0));
  assert.deepEqual(jobEditErrorCopy("parse", 200, "x"), clientActionErrorCopy("parse", 200));
});

// ── F133: the modal footer sentence is mode-dependent ────────────────────────

test("F133 1a-1b: jobDialogFooterNote returns the right constant per mode", () => {
  assert.equal(jobDialogFooterNote("create"), NEW_JOB_FOOTER_NOTE);
  assert.equal(jobDialogFooterNote("edit"), EDIT_JOB_FOOTER_NOTE);
});

test("F133 1c: the two constants are NOT equal — this is the check that would have caught it", () => {
  // If a future edit collapses them back to one string, 1a and 1b both still
  // pass and only this fails.
  assert.notEqual(NEW_JOB_FOOTER_NOTE, EDIT_JOB_FOOTER_NOTE);
});

test("F133 1d: EDIT_JOB_FOOTER_NOTE does not contain the false create-mode phrase", () => {
  // The fault WAS this sentence appearing in edit mode — the substring check
  // is the fault itself, not a proxy for it: it directly re-tests the exact
  // false claim ("editable later in the worksheet") that F133 was raised over.
  assert.ok(!EDIT_JOB_FOOTER_NOTE.includes("later in the worksheet"));
});

// ── Jobs list — the metric treatment follows the figure, not the placeholder ─
// Found by Mayur on screen: the Result cell always carried metric-sm (18px/600),
// which is correct for a real headline figure and wrong for the "— not yet
// sized" placeholder — an em dash and four words is not a figure, and with
// every job in the database currently unsized, the emptiest cell in every row
// was the loudest thing on screen. resultEmphasis carries that decision from
// the SAME fact that already drives resultMuted (result === NOT_YET_SIZED),
// derived once and read twice — never re-compared as a second string check.

test("resultEmphasis (a): no sizing at all -> body, muted, the placeholder", () => {
  const { rows } = summariseJobs(FIXTURE, KPIS);
  const j04 = rows.find((r) => r.jobId === "j04");
  assert.equal(j04?.result, NOT_YET_SIZED);
  assert.equal(j04?.resultMuted, true);
  assert.equal(j04?.resultEmphasis, "body");
});

test("resultEmphasis (b): a solar size -> metric, not muted", () => {
  const { rows } = summariseJobs(FIXTURE, KPIS);
  const j05 = rows.find((r) => r.jobId === "j05"); // solar 9.2 + battery 10, no payback
  assert.equal(j05?.result, "9.2 kW + 10 kWh");
  assert.equal(j05?.resultEmphasis, "metric");
  assert.equal(j05?.resultMuted, false);
});

test("resultEmphasis (c): a payback with NO size -> metric — tracks 'is there a figure', not 'is there a solar size'", () => {
  // No fixture row has this shape (solar null, battery null, payback set), so
  // it is built directly — the case that proves resultEmphasis is not secretly
  // "does this row have a solar_kw".
  const { rows } = summariseJobs(
    [job({ job_id: "payback-only", headline: { solar_kw: null, battery_kwh: null, payback_years: 4.1 } })],
    KPIS,
  );
  const row = rows[0];
  assert.equal(row.result, "4.1 yr");
  assert.equal(row.resultEmphasis, "metric");
  assert.equal(row.resultMuted, false);
});

test("resultEmphasis (d): resultMuted's existing assertion is UNCHANGED", () => {
  // Byte-for-byte the check that already existed at line 276 before this task —
  // pasted here rather than only trusting the original still runs, since it now
  // sits beside a field this task added.
  const { rows } = summariseJobs(FIXTURE, KPIS);
  const byId = new Map(rows.map((r) => [r.jobId, r]));
  assert.equal(byId.get("j04")?.resultMuted, true);
});

test("resultEmphasis (e): the two fields AGREE on every fixture row — recorded, not assumed", () => {
  // They coincide today (muted <=> body) because both derive from the same
  // NOT_YET_SIZED check. This test records that coincidence for the CURRENT
  // fixture; it is not a structural invariant either field is entitled to
  // assume about the other, which is exactly why they are two fields.
  const { rows } = summariseJobs(FIXTURE, KPIS);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(
      row.resultMuted,
      row.resultEmphasis === "body",
      `${row.jobId}: resultMuted=${row.resultMuted} but resultEmphasis=${row.resultEmphasis}`,
    );
  }
});

test("resultEmphasis: job-table.tsx applies metric-sm ONCE, and only inside a branch on resultEmphasis", () => {
  // job-table.tsx has no render harness — verify-worksheet-logic.ts's harness
  // is not lifted here for one conditional (a second copy is drift). This is
  // therefore a SOURCE check, not a rendered-attribute check: it proves the
  // class string is gated in the code, not that the gate evaluates correctly
  // on screen. The on-screen result is Mayur's check, not this suite's — F109,
  // a check that cannot be rehearsed needs its mechanism written down.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../components/jobs/job-table.tsx"),
    "utf8",
  );
  const quoted = src.match(/"metric-sm"/g) ?? [];
  assert.equal(quoted.length, 1, `expected exactly one "metric-sm" class string, found ${quoted.length}`);
  assert.ok(
    src.includes('row.resultEmphasis === "metric" ? "metric-sm"'),
    "metric-sm must be applied only inside a branch on row.resultEmphasis",
  );
  // Never applied unconditionally — i.e. never sitting bare in a className
  // template/string outside that ternary.
  assert.ok(
    !/className=\{?`?metric-sm[\s`]/.test(src.replace('row.resultEmphasis === "metric" ? "metric-sm" : "text-body"', "")),
    "metric-sm must not appear unconditionally anywhere else in this file",
  );
});
