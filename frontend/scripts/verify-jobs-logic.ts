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

import {
  FILTERS,
  JOB_STATUSES,
  NOT_YET_SIZED,
  buildJobsQuery,
  errorPanelCopy,
  formatCompactAud,
  formatResult,
  formatTier,
  formatUpdated,
  formatWinRate,
  summariseJobs,
  type ApiErrorKind,
  type JobKpis,
  type JobListItem,
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
  const http = errorPanelCopy("http", 503, ENDPOINT).body;
  assert.ok(http.includes(ENDPOINT) && http.includes("503"), http);
  assert.ok(errorPanelCopy("parse", 200, ENDPOINT).body.includes("could not read"));
});

// An unrecognised kind (impossible via the type, reachable via bad data) must
// fall back to the http copy rather than rendering an empty panel.
test("errorPanelCopy: an unrecognised kind falls back to the http copy", () => {
  const bogus = errorPanelCopy(unsafe<ApiErrorKind>("banana"), 500, ENDPOINT);
  assert.deepEqual(bogus, errorPanelCopy("http", 500, ENDPOINT));
  assert.ok(bogus.heading.trim().length > 0);
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
