"use client";

import * as React from "react";
import Link from "next/link";
import { NoticeStack } from "@/components/ui/notice-stack";
import type { ResultsView } from "@/lib/worksheet";

/**
 * Results section (checklist 3.13 prompt 3) — the current recommendation, what
 * it will save, the roof it was built on and which way the panels face.
 * COMPACT on purpose: the Results TAB carries the split ROI, the score curve,
 * the itemised cost and the assumptions (prompt 4); this section is the
 * worksheet's summary of the CURRENT run.
 *
 * THE ROOF'S DOUBT AND THE PANELS' DIRECTION RENDER BESIDE THE FIGURES — not
 * below the fold, not in a drawer. A results panel that headlines a payback
 * while saying nothing about panels facing south is the exact failure this
 * row exists to prevent, and the first real sizing run did precisely that.
 * The doubt's tone comes classified from the logic layer (D25); direction and
 * pitch are plain statements of fact, not warnings — a north-facing roof
 * states its direction the same way a south-facing one does.
 */
export function ResultsSection({
  view,
  jobId,
}: {
  view: ResultsView;
  jobId: string;
}) {
  if (view.state === "unsized") {
    return (
      <p className="text-body text-muted-foreground">
        This job has not been sized yet. Run{" "}
        <Link href="#solar-sizing" className="text-primary underline">
          Solar sizing
        </Link>{" "}
        (and Battery sizing, where the path calls for one) above — the
        recommendation appears here.
      </p>
    );
  }

  if (view.state === "awaiting-financial") {
    return (
      <p className="text-body text-muted-foreground">
        This job is sized, but the financial figures for the current run are
        still being worked out. Run the sizing again to refresh them — earlier
        runs are kept.
      </p>
    );
  }

  const h = view.headline;
  return (
    <div className="flex flex-col gap-3">
      {h ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ["Solar", h.solarKw],
              ...(h.battery !== null ? [["Battery", h.battery]] : []),
              ["Whole system cost", h.systemCost],
              ["Annual saving", h.annualSavings],
              ["Payback", h.payback],
              ["25-year NPV", h.npv],
              ["Current annual spend", h.currentSpend],
              ["Projected annual spend", h.projectedSpend],
              ...(h.selfSufficiency !== null
                ? [["Self-sufficiency", h.selfSufficiency]]
                : []),
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label}>
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="metric-sm text-foreground">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* The roof this run was built on — its doubt, classified in the logic
          layer, rendered at the tone it carries. */}
      <NoticeStack items={view.roofNotices} />

      {/* Which way the panels face — plain facts, one line per plane. */}
      {view.layoutLines ? (
        <div>
          <p className="text-caption text-muted-foreground">
            Where the panels sit
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {view.layoutLines.map((line) => (
              <li key={line} className="text-body text-foreground">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : view.layoutNote ? (
        <p className="text-caption text-muted-foreground">{view.layoutNote}</p>
      ) : null}

      <p className="text-caption text-muted-foreground">
        <Link
          href={`/jobs/${jobId}/results`}
          className="text-primary underline"
        >
          Open the Results tab
        </Link>{" "}
        for the split ROI, the itemised cost, the score curve and the
        assumptions behind these figures.
      </p>
    </div>
  );
}
