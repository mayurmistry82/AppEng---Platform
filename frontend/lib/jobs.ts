/**
 * Job-tracker domain logic (checklist 3.1) — PURE. No React, no fetch, no
 * next/*, no DOM. This file is exercised by scripts/verify-jobs-logic.ts under
 * `node --experimental-strip-types`, so it must stay strip-safe: no `enum`, no
 * namespaces, no parameter properties, no decorators. Types, interfaces,
 * `as const` and plain functions only.
 *
 * Every formatter accepts null/undefined/NaN and returns a display string —
 * none throw. A bad field renders a placeholder, never breaks a row.
 */

// ── Statuses / API contract ──────────────────────────────────────────────────

/** The six values allowed by jobs_status_check and backend _VALID_STATUSES. */
export const JOB_STATUSES = [
  "draft",
  "sized",
  "sent",
  "won",
  "installed",
  "lost",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobHeadline {
  solar_kw: number | null;
  battery_kwh: number | null;
  payback_years: number | null;
}

export interface JobListItem {
  job_id: string;
  customer_name: string | null;
  address: string | null;
  status: string; // one of the six; the pill guards unknown values
  path: string | null;
  path_label: string | null;
  headline: JobHeadline;
  accuracy_tier: number | null; // INTEGER 1|2|3 — never the string "tier_3"
  assigned_to: string | null; // uuid — no name available until the 7.2 join
  notes: string | null;
  scheduled_date: string | null; // rendered by 7.3, not 3.1
  event_type: string | null; // rendered by 7.3, not 3.1
  updated_at: string | null; // ISO8601
}

export interface JobKpis {
  pipeline_value: number;
  win_rate: number | null; // 0..1 fraction; null when no won/lost in 90 days
  in_progress: number;
  won_this_month: { count: number; value: number };
}

export interface JobsResponse {
  jobs: JobListItem[];
  total: number;
  limit: number;
  offset: number;
  kpis: JobKpis;
}

/** Minimal structural check — a 200 body missing `jobs` is an ERROR, not empty. */
export function isJobsResponse(value: unknown): value is JobsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { jobs?: unknown }).jobs)
  );
}

// ── Filters / sorts ──────────────────────────────────────────────────────────

export interface JobFilter {
  id: string;
  label: string;
  /** Statuses sent as repeated ?status= params; empty = no status param. */
  statuses: readonly JobStatus[];
}

/**
 * The four wireframe tabs. A job with status `installed` appears only under
 * All — that is the four-tab design, deliberate for 3.1 (no fifth tab, and
 * installed is NOT folded into Won).
 */
export const FILTERS = [
  { id: "all", label: "All", statuses: [] },
  { id: "in-progress", label: "In progress", statuses: ["draft", "sized", "sent"] },
  { id: "won", label: "Won", statuses: ["won"] },
  { id: "lost", label: "Lost", statuses: ["lost"] },
] as const satisfies readonly JobFilter[];

export type JobFilterId = (typeof FILTERS)[number]["id"];

export const DEFAULT_FILTER_ID: JobFilterId = "all";

/** The four sorts GET /api/jobs accepts — anything else 422s. */
export const SORTS = [
  { id: "updated_desc", label: "Recently updated" },
  { id: "updated_asc", label: "Least recently updated" },
  { id: "created_desc", label: "Newest" },
  { id: "created_asc", label: "Oldest" },
] as const;

export type JobSortId = (typeof SORTS)[number]["id"];

export const DEFAULT_SORT_ID: JobSortId = "updated_desc";

/** Unknown/absent filter ids silently fall back to All (never a 422). */
export function resolveFilter(id: string | null | undefined): JobFilter {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}

/** Unknown/absent sort ids silently fall back to updated_desc (never a 422). */
export function resolveSort(id: string | null | undefined): JobSortId {
  return SORTS.some((s) => s.id === id) ? (id as JobSortId) : DEFAULT_SORT_ID;
}

export interface JobsQueryInput {
  filter?: string | null;
  q?: string | null;
  sort?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Build the /api/jobs query string. Only values the backend accepts are ever
 * emitted: unknown filter → no status param, unknown sort → updated_desc.
 */
export function buildJobsQuery(input: JobsQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  for (const status of resolveFilter(input.filter).statuses) {
    params.append("status", status);
  }
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q) params.set("q", q);
  params.set("sort", resolveSort(input.sort));
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    params.set("limit", String(Math.trunc(input.limit)));
  }
  if (typeof input.offset === "number" && Number.isFinite(input.offset) && input.offset > 0) {
    params.set("offset", String(Math.trunc(input.offset)));
  }
  return params;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One decimal, with a trailing ".0" dropped: 9.2 → "9.2", 10 → "10". */
function fmt1(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

export const NOT_YET_SIZED = "— not yet sized";

/**
 * Headline → "9.2 kW + 10 kWh · 6.4 yr" (see the column spec for the shapes).
 * Sizes but no payback → the size part alone; nothing at all → NOT_YET_SIZED.
 */
export function formatResult(headline: JobHeadline | null | undefined): string {
  const solar = isNum(headline?.solar_kw) ? headline.solar_kw : null;
  const battery = isNum(headline?.battery_kwh) ? headline.battery_kwh : null;
  const payback = isNum(headline?.payback_years) ? headline.payback_years : null;

  const sizes: string[] = [];
  if (solar !== null) sizes.push(`${fmt1(solar)} kW`);
  if (battery !== null) sizes.push(`${fmt1(battery)} kWh`);
  const sizePart = sizes.join(" + ");

  if (!sizePart) return payback !== null ? `${fmt1(payback)} yr` : NOT_YET_SIZED;
  if (payback === null) return sizePart;
  return `${sizePart} · ${fmt1(payback)} yr`;
}

/** Integer accuracy tier → label; tier 1 is flagged low (worth improving). */
export function formatTier(
  tier: number | null | undefined,
): { label: string; low: boolean } {
  if (tier === 1 || tier === 2 || tier === 3) {
    return { label: `Tier ${tier}`, low: tier === 1 };
  }
  return { label: "—", low: false };
}

/**
 * ISO timestamp → "2 Aug" in Australia/Adelaide — never the server's local
 * zone. Unparseable/absent → "—".
 */
export function formatUpdated(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "Australia/Adelaide",
  }).format(date);
}

/** Compact AUD: 84200 → "$84.2k", 610 → "$610", 1250000 → "$1.3m", null → "—". */
export function formatCompactAud(n: number | null | undefined): string {
  if (!isNum(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${fmt1(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}$${fmt1(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** 0..1 fraction → "61%"; null (no won/lost in 90 days) → "—", never "0%". */
export function formatWinRate(r: number | null | undefined): string {
  if (!isNum(r)) return "—";
  return `${Math.round(r * 100)}%`;
}

// ── Six-path derivation (checklist 3.2) ──────────────────────────────────────

export type JobIntent = "solar" | "battery" | "both";
export type PathLetter = "A" | "B" | "C" | "D" | "E" | "F";

/**
 * (has_existing_solar, intent) → path letter. Mirrors backend/job_paths.py
 * BYTE-FOR-BYTE — the Postgres GENERATED column `jobs.path` is the source of
 * truth and this value is NEVER sent to the API; it only labels the UI.
 * Null on any incomplete or invalid input. Never throws.
 */
export function derivePath(
  hasExistingSolar: boolean | null | undefined,
  intent: JobIntent | null | undefined,
): PathLetter | null {
  if (typeof hasExistingSolar !== "boolean") return null;
  switch (intent) {
    case "solar":
      return hasExistingSolar ? "F" : "A";
    case "both":
      return hasExistingSolar ? "D" : "B";
    case "battery":
      return hasExistingSolar ? "C" : "E";
    default:
      return null;
  }
}

/** Human labels for each path — mirrors backend/job_paths.py PATH_LABELS. */
export const PATH_LABELS: Record<PathLetter, string> = {
  A: "Solar only",
  B: "Solar + battery",
  C: "Battery only (has solar)",
  D: "Add solar + battery",
  E: "Battery only (no solar)",
  F: "Expand solar only",
};

export interface SizingOption {
  intent: JobIntent;
  path: PathLetter;
  label: string;
  enabled: boolean;
}

/**
 * The exact sentence rendered under the disabled C/D pair (decision D1).
 * Do not reword it — the reason is specific and true.
 */
export const DISABLED_PATH_REASON =
  "Battery sizing on a home that already has solar needs true consumption, which the meter cannot see. That calculation is being built (4.1).";

/**
 * The New Job modal's footer caption in create mode. Do not reword it — the
 * sentence is specific and true, and it is FALSE if shown in edit mode (F133):
 * it tells an installer editing a job from inside the worksheet to go to the
 * worksheet later, when they are already there.
 */
export const NEW_JOB_FOOTER_NOTE =
  "Job type is shown and editable later in the worksheet.";

/**
 * The footer caption in edit mode (F133). Do not reword it — chosen because it
 * is true and it is what the installer standing in this window needs to know
 * (F82: the address locks once anything has been derived from it; everything
 * else stays editable for the life of the job).
 */
export const EDIT_JOB_FOOTER_NOTE =
  "Everything except a locked address stays editable for the life of the job.";

/**
 * The modal's footer caption, by MODE — not a boolean, not the job object.
 * F133: a hard-coded string in the component was invisible to every gate, so
 * nothing noticed when a second mode made it false. The classification lives
 * HERE, in the pure module, so it is testable — the same rule D25 applies to
 * notices. The union has exactly two members and both are handled: no default
 * branch, because a widened parameter with a fallback is how a future third
 * mode would silently inherit the create-mode sentence.
 */
export function jobDialogFooterNote(mode: "create" | "edit"): string {
  return mode === "edit" ? EDIT_JOB_FOOTER_NOTE : NEW_JOB_FOOTER_NOTE;
}

/**
 * Which sizing options the modal shows, and which are selectable — the SINGLE
 * source of truth; the component must not re-derive any of this.
 *
 * null  → []                       (the section is hidden until step 3 answers)
 * false → A, B, E — all enabled
 * true  → C, D disabled (D1 — battery sizing behind an existing array needs
 *         true consumption; built at 4.1), F enabled. Exactly one selectable
 *         option is INTENDED until 4.1 — do not "fix" it.
 */
export function sizingOptions(
  hasExistingSolar: boolean | null | undefined,
): SizingOption[] {
  if (typeof hasExistingSolar !== "boolean") return [];
  if (!hasExistingSolar) {
    return [
      { intent: "solar", path: "A", label: PATH_LABELS.A, enabled: true },
      { intent: "both", path: "B", label: PATH_LABELS.B, enabled: true },
      { intent: "battery", path: "E", label: PATH_LABELS.E, enabled: true },
    ];
  }
  return [
    { intent: "battery", path: "C", label: PATH_LABELS.C, enabled: false },
    { intent: "both", path: "D", label: PATH_LABELS.D, enabled: false },
    { intent: "solar", path: "F", label: PATH_LABELS.F, enabled: true },
  ];
}

// ── Error-panel copy ─────────────────────────────────────────────────────────

/**
 * Why a request failed, as a cause rather than a status code (F55).
 *
 * Defined HERE, in the pure module, rather than in lib/api-server.ts, so the
 * copy below can be unit-tested under --experimental-strip-types without
 * loading that server-only module. api-server.ts imports and re-exports it.
 *
 * config  — the Supabase client could not be constructed (missing env vars)
 * auth    — the client worked; there is no signed-in session
 * network — fetch() threw; the request never reached the server
 * http    — the backend answered with a non-2xx
 * parse   — the response body could not be read as the expected JSON
 */
export type ApiErrorKind = "config" | "auth" | "network" | "http" | "parse";

export interface ErrorPanelCopy {
  heading: string;
  body: string;
}

/**
 * Every word the /jobs error panel renders. page.tsx holds no copy of its own,
 * so all of it is testable without a browser.
 *
 * F55 is the whole point of the `config` branch: it must never mention a
 * session, signing in, or expiry — an unset env var is a deployment fault, and
 * sending the installer to the login screen hides it. An unrecognised kind
 * (impossible via the type, reachable via bad data) falls back to `http` rather
 * than rendering an empty panel.
 *
 * Env var NAMES only — never a value, and never the access token.
 */
export function errorPanelCopy(
  kind: ApiErrorKind,
  status: number,
  endpoint: string,
): ErrorPanelCopy {
  switch (kind) {
    case "config":
      return {
        heading: "Jobs can't load — the app is misconfigured",
        body: `NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Set both in the deployment environment and redeploy.`,
      };
    case "auth":
      return {
        heading: "Couldn't load jobs — you may be signed out",
        body: `${endpoint} responded with HTTP ${status}. Your session may have expired — sign in again.`,
      };
    case "network":
      return {
        heading: "Couldn't load jobs — the backend is unreachable",
        body: `The request to ${endpoint} never reached the server. Check the backend is running on port 8000.`,
      };
    case "parse":
      return {
        heading: "Couldn't load jobs — the response was unreadable",
        body: `${endpoint} returned a response the app could not read. Try reloading, and check the backend logs if it persists.`,
      };
    case "http":
    default:
      if (kind === "http" && status === 503) {
        // F88 residual: a 503 means the server could not reach its database, so
        // it could not check anything about you. Deliberately says nothing about
        // permissions or the session — pointing at authorisation is exactly the
        // mistake the F88 auth fix removed.
        return {
          heading: "Couldn't load jobs — the server is briefly unavailable",
          body: "The server could not reach its database for a moment. This is usually temporary — wait a few seconds and reload.",
        };
      }
      return {
        heading: "Couldn't load jobs",
        body: `${endpoint} responded with HTTP ${status}. The backend hit an error — try reloading, and check the backend logs if it persists.`,
      };
  }
}

/**
 * Copy for a FAILED BUTTON PRESS, not a failed page load (3.4-E).
 *
 * errorPanelCopy and worksheetErrorCopy are both worded for a page that could not
 * load — "try reloading" is the right advice there and the wrong advice here: the
 * installer has a half-filled form open and reloading would destroy it. These
 * branches are deliberately separate, and the suite asserts the auth wording of
 * the two differs so a later tidy-up cannot silently unify them.
 *
 * Never mentions a token, a cookie, or an env var VALUE — an installer can act on
 * none of those, and the config branch names the variables only because a
 * deployer needs them.
 */
export function clientActionErrorCopy(
  kind: ApiErrorKind,
  status: number,
): ErrorPanelCopy {
  switch (kind) {
    case "auth":
      return {
        heading: "Your session has expired",
        body: "Sign in again and your work on this page will still be here.",
      };
    case "network":
      return {
        heading: "Couldn't reach the server",
        body: "Check the backend is running on port 8000, then try again. Nothing you have entered has been lost.",
      };
    case "config":
      return {
        heading: "The app is misconfigured",
        body: "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. This needs fixing in the deployment, not on this page.",
      };
    case "parse":
      return {
        heading: "The server sent something unreadable",
        body: `The response to this request could not be read${
          status ? ` (HTTP ${status})` : ""
        }. Try again, and check the backend logs if it persists.`,
      };
    case "http":
    default:
      if (kind === "http" && (status === 409 || status === 422)) {
        return {
          heading: "The server rejected these values",
          body: "Something in what was sent is not valid. Check the fields and try again.",
        };
      }
      return {
        heading: "That didn't work",
        body: `The server responded with HTTP ${status}. Try again, and check the backend logs if it persists.`,
      };
  }
}

// ── View models for the strip + table ────────────────────────────────────────

export interface KpiTileView {
  label: string;
  value: string;
  delta: string;
}

export interface JobRowView {
  jobId: string;
  customerName: string; // "Unnamed customer" when null — never "null"/empty
  address: string; // "No address yet" when null
  status: string;
  result: string;
  resultMuted: boolean;
  /**
   * "metric" gets the row's headline-figure treatment (the metric-sm utility,
   * 18px/600 — the same emphasis the KPI tiles use); "body" renders at the
   * table's own text. A SEPARATE field from resultMuted rather than the
   * component branching on resultMuted for both colour and size: colour and
   * emphasis are two different decisions that happen to coincide today (an
   * unsized row is both muted AND small), and naming them separately means a
   * later change to one — e.g. a muted-but-emphasised state — cannot silently
   * move the other. D25's precedent: the classification lives in the logic
   * layer so a gate can see it, never inside the component.
   */
  resultEmphasis: "metric" | "body";
  tierLabel: string;
  tierLow: boolean;
  notes: string | null;
  updated: string;
  href: string;
}

export interface JobsSummary {
  tiles: [KpiTileView, KpiTileView, KpiTileView, KpiTileView];
  rows: JobRowView[];
}

/**
 * Everything the KPI strip and the table render, precomputed. A null/absent
 * KPI object yields four "—" tiles; a null field in any job yields that
 * column's placeholder — one bad row never removes the row.
 *
 * F25: the two dollar captions read jobs.quoted_value_aud, which holds the
 * engine's MODELLED net cost until an installer enters real pricing at 4.12 —
 * so they say "modelled estimate" / "modelled value", never "installed value".
 */
export function summariseJobs(
  jobs: readonly JobListItem[] | null | undefined,
  kpis: JobKpis | null | undefined,
): JobsSummary {
  const tiles: JobsSummary["tiles"] = [
    {
      label: "Pipeline value",
      value: formatCompactAud(kpis?.pipeline_value),
      delta: "sized + sent · modelled estimate",
    },
    {
      label: "Win rate",
      value: formatWinRate(kpis?.win_rate),
      delta: "last 90 days",
    },
    {
      label: "Jobs in progress",
      value: isNum(kpis?.in_progress) ? String(kpis.in_progress) : "—",
      delta: "draft + sized + sent",
    },
    {
      label: "Won this month",
      value: isNum(kpis?.won_this_month?.count)
        ? String(kpis.won_this_month.count)
        : "—",
      delta: `${formatCompactAud(kpis?.won_this_month?.value)} modelled value`,
    },
  ];

  const rows: JobRowView[] = (jobs ?? []).map((job) => {
    const result = formatResult(job.headline);
    const tier = formatTier(job.accuracy_tier);
    return {
      jobId: job.job_id,
      customerName: job.customer_name ?? "Unnamed customer",
      address: job.address ?? "No address yet",
      status: job.status,
      result,
      resultMuted: result === NOT_YET_SIZED,
      // One derivation, read twice (resultMuted above, resultEmphasis here) —
      // never re-compared as a second string check. Anything OTHER than the
      // placeholder gets "metric": an unrecognised or unexpected value is a
      // real result and should be emphasised, because failing quiet on a
      // genuine figure is the worse error than over-emphasising an edge case.
      resultEmphasis: result === NOT_YET_SIZED ? "body" : "metric",
      tierLabel: tier.label,
      tierLow: tier.low,
      notes: job.notes && job.notes.trim() ? job.notes : null,
      updated: formatUpdated(job.updated_at),
      href: `/jobs/${job.job_id}/worksheet`,
    };
  });

  return { tiles, rows };
}

// ── 3.3c — the unit-address nudge (F99) and the edit-error copy ──────────────

/** The caption under a bare street address. A caption, never a gate. */
export const UNIT_ADDRESS_HINT =
  "No unit number. On a unit, townhouse or duplex the roof lookup measures whichever building is nearest — which may not be your customer's. Add the unit number if there is one.";

const UNIT_PREFIX_WORDS = [
  "unit", "u", "apt", "apartment", "flat", "suite", "ste", "lot", "shop",
  "villa", "townhouse",
];

/**
 * True when the trimmed address is at least 6 characters, starts with a street
 * number, and carries NO unit/subpremise marker — a "/" before the first
 * comma, or a leading unit word followed by a number.
 *
 * A HEURISTIC, and wrong sometimes, acceptably: a false positive shows a
 * caption suggesting something already true; a false negative is the status
 * quo. It NEVER changes the submitted value and never parses or normalises
 * the address.
 */
export function needsUnitNumberHint(address: string): boolean {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();
  // A slash before the first comma is a subpremise marker ("5/53 Bishops Pl").
  const head = lower.split(",")[0];
  if (head.includes("/")) return false;
  // A leading unit word followed by a number ("Unit 5 ...", "U5 ...", "Apt 2, ...").
  const wordMatch = lower.match(/^([a-z]+)\s*(\d)/);
  if (wordMatch && UNIT_PREFIX_WORDS.includes(wordMatch[1])) return false;
  // Otherwise it must START with a street number to look like an address at all.
  return /^\d/.test(lower);
}

/**
 * Error copy for the job-edit dialog (3.3c): identical to
 * clientActionErrorCopy EXCEPT a 409, whose body is the SERVER'S OWN detail —
 * a 409 here always carries a specific, true reason (the address lock), and
 * discarding it for generic copy is the opposite of what this product is for.
 * Falls back to the generic copy when the server message is empty.
 */
export function jobEditErrorCopy(
  kind: ApiErrorKind,
  status: number,
  serverMessage: string,
): ErrorPanelCopy {
  if (kind === "http" && status === 409 && serverMessage.trim() !== "") {
    return { heading: "This change was rejected", body: serverMessage };
  }
  return clientActionErrorCopy(kind, status);
}
