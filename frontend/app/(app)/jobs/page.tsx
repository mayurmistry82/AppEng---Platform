import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JobFilterBar, JobSearchInput } from "@/components/jobs/job-filter-bar";
import { JobKpiStrip } from "@/components/jobs/job-kpi-strip";
import { JobTable } from "@/components/jobs/job-table";
import { apiGet, type ApiResult } from "@/lib/api-server";
import {
  buildJobsQuery,
  errorPanelCopy,
  isJobsResponse,
  summariseJobs,
  type ApiErrorKind,
  type JobsResponse,
  type JobsSummary,
} from "@/lib/jobs";

/**
 * /jobs — the dashboard job tracker (checklist 3.1). Layout from the
 * 2026-08-04 dashboard wireframe Screen 1; every colour/spacing value from
 * DESIGN.md tokens. Desktop-first (decision #28).
 *
 * The List | Calendar toggle in the wireframe is checklist 7.3 — not built.
 *
 * Data problems NEVER crash the page: apiGet never throws, and every failure
 * shape (401/403, 5xx, network, malformed body) lands in the error panel —
 * which is deliberately distinct from the zero-jobs empty state, because with
 * an empty jobs table a silent auth failure would otherwise render as a
 * convincing "No jobs yet". No auto-redirect on 401 — the (app) layout and
 * middleware own that, and a redirect here would hide a real auth-wiring bug.
 */

const ENDPOINT = "/api/jobs";

/** All wording comes from errorPanelCopy — this holds no copy of its own. */
function ErrorPanel({ kind, status }: { kind: ApiErrorKind; status: number }) {
  const { heading, body } = errorPanelCopy(kind, status, ENDPOINT);
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive-subtle p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 text-destructive" />
        <div>
          <h2 className="text-h3 text-foreground">{heading}</h2>
          <p className="mt-1 text-body text-muted-foreground">{body}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * One discriminated view for the whole page, so the compiler narrows the
 * success branch on its own — no non-null assertion, cast or `any` anywhere.
 */
type JobsView =
  | { ok: true; total: number; summary: JobsSummary }
  | { ok: false; kind: ApiErrorKind; status: number };

function toView(result: ApiResult<JobsResponse>): JobsView {
  if (!result.ok) {
    return { ok: false, kind: result.kind, status: result.status };
  }
  // 200 with a malformed body (missing/non-array `jobs`) is an ERROR, never an
  // empty list — otherwise a broken backend would look like a clean slate. It
  // is a `parse` failure: the response could not be read as a job list. The 502
  // is an internal sentinel; the parse copy never prints a status.
  if (!isJobsResponse(result.data)) {
    return { ok: false, kind: "parse", status: 502 };
  }
  return {
    ok: true,
    total: result.data.total,
    summary: summariseJobs(result.data.jobs, result.data.kpis),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const filter = first(params.filter) ?? null;
  const q = first(params.q) ?? null;
  const sort = first(params.sort) ?? null;

  const view = toView(
    await apiGet<JobsResponse>(ENDPOINT, buildJobsQuery({ filter, q, sort })),
  );

  const filtersActive = Boolean(
    (filter && filter !== "all") || (q && q.trim()),
  );

  return (
    <div className="w-full px-8 py-8">
      {/* Header row — title · search · New job */}
      <div className="flex items-center gap-6">
        <h1 className="text-h1 text-foreground">Jobs</h1>
        <div className="flex flex-1 justify-center">
          <JobSearchInput />
        </div>
        {/* The creation modal is checklist 3.2 — until then this button
            deliberately does nothing (same as AppRail's New job control).
            Not linked anywhere, not disabled. */}
        <Button>＋ New job</Button>
      </div>

      {view.ok ? (
        <>
          <div className="mt-6">
            <JobKpiStrip tiles={view.summary.tiles} />
          </div>
          <div className="mt-6">
            <JobFilterBar total={view.total} />
          </div>
          <div className="mt-4">
            <JobTable rows={view.summary.rows} filtersActive={filtersActive} />
          </div>
        </>
      ) : (
        // No KPI tiles with fabricated zeros in the error state — the strip
        // and filter bar are omitted entirely.
        <div className="mt-6">
          <ErrorPanel kind={view.kind} status={view.status} />
        </div>
      )}
    </div>
  );
}
