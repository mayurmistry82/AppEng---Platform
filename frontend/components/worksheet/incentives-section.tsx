"use client";

import * as React from "react";
import { NoticeStack } from "@/components/ui/notice-stack";
import type { IncentivesView } from "@/lib/worksheet";

/**
 * Incentives section (checklist 3.13b) — what the engine already took off the
 * price, the window each government rate is valid in, and the fact that Clean
 * Energy Council approval has not been checked.
 *
 * READ-ONLY BY DESIGN: it renders the current run's own stored breakdown and
 * computes nothing, stores nothing, and offers no control — the CEC line is a
 * statement of fact (D29), never a tick or a dropdown. The prop list says so:
 * `view` and nothing else — no jobId, no onSaved, because there is no action
 * to take and nothing to announce.
 *
 * Every figure comes from the stored breakdown via incentivesView; the
 * completeness tick reads the SAME storedIncentives record, so the tick and
 * this body cannot disagree (F178/F179).
 */
export function IncentivesSection({ view }: { view: IncentivesView }) {
  if (view.state === "unsized") {
    return (
      <p className="text-body text-muted-foreground">
        This job has not been sized yet — the incentives the engine takes off
        the price appear here once it is.
      </p>
    );
  }

  if (view.state === "unrecorded") {
    return (
      <p className="text-body text-muted-foreground">
        The incentives were not recorded for this run — run the sizing again to
        capture them.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {view.headline ? (
        <p className="text-body text-muted-foreground">{view.headline}</p>
      ) : null}

      {/* One row per incentive the engine actually stored — presence comes
          from the stored line items, never from the job's path. */}
      <div className="flex flex-col gap-2">
        {view.rows.map((row) => (
          <div key={row.name} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-body text-foreground">{row.name}</p>
              <p className="metric-sm text-foreground">{row.amount}</p>
            </div>
            {row.working ? (
              <p className="mt-1 text-caption text-muted-foreground">
                {row.working}
              </p>
            ) : null}
            {row.reason ? (
              <p className="mt-1 text-caption text-muted-foreground">
                {row.reason}
              </p>
            ) : null}
            {row.validity ? (
              <p className="mt-1 text-caption text-muted-foreground">
                {row.validity}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* The total, only when every line is confirmed (F212 — an absence is
          not a zero); otherwise the honest line about why there is none. */}
      {view.total ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="text-body text-foreground">
            Taken off the system price:
          </p>
          <p className="metric-sm text-foreground">{view.total}</p>
        </div>
      ) : view.totalNote ? (
        <p className="text-caption text-muted-foreground">{view.totalNote}</p>
      ) : null}

      {/* Legacy note, CEC statement and price age — classified in the logic
          layer (D25); NoticeStack does the ordering. */}
      <NoticeStack items={view.notices} />
    </div>
  );
}
