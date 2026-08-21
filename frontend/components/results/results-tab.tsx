"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Notice } from "@/components/ui/notice";
import { HoverHelp } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { requestJson } from "@/lib/client-api";
import { ScoreCurve } from "@/components/results/score-curve";
import { NoticeStack } from "@/components/ui/notice-stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ResultsTabView } from "@/lib/worksheet";

/**
 * The Results tab (checklist 3.13 prompt 4) — wireframe Tab 1: headline
 * figures across the top, the split ROI, the itemised cost breakdown, the
 * panel layout in words, then the assumptions block, expandable. Every figure
 * traces to an assumption; every stored gap is an honest sentence.
 *
 * The score curve (3.13 prompt 4b) renders between the split and the cost —
 * this tab is the ONE route that pays the chart library's First Load cost;
 * the worksheet stays chart-free (F47).
 *
 * A NULL cost-line amount reads "installer to confirm", NEVER $0 — an
 * unpriced line is a different fact from a free one. A breakdown whose lines
 * do not sum to its own net shows BOTH figures and says they disagree
 * (summing to net is the row's acceptance, so a mismatch is a finding).
 */
/**
 * The D34 ROI panel (3.13 prompt 4c). OFF renders NOTHING — not a collapsed
 * panel, not a placeholder. ON renders ALL THREE definitions together via one
 * map over roiFigures' fixed triple — there is deliberately no code path that
 * can render one figure without the other two, because a control that picks
 * one is the persuasion lever D34 rejected. The explanations come from the
 * figures themselves (lib's ROI_EXPLANATIONS) — the same strings 8.1 prints
 * in the customer report.
 */
function RoiPanel({
  view,
  jobId,
}: {
  view: ResultsTabView;
  jobId: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function setShowRoi(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // The ONE writer every other job setting uses — no second endpoint.
      const res = await requestJson<Record<string, unknown>>(
        "PATCH",
        `/api/job/${encodeURIComponent(jobId)}`,
        { show_roi: next },
      );
      if (!res.ok) {
        setError("The setting could not be saved — nothing changed.");
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Return on investment">
      <div className="flex items-center gap-2 text-body text-foreground">
        {/* 3.13 prompt 4d: the standard Switch. The checkbox it replaces
            already carried role="switch" — the announcement is unchanged, the
            control is now a real switch. The state shown is the state ON THE
            JOB, never an optimistic guess, and it is disabled while saving. */}
        <Switch
          label="Show return on investment"
          checked={view.showRoi}
          disabled={saving}
          onChange={(next) => void setShowRoi(next)}
        />
        Show return on investment
        <HoverHelp label="About return on investment">
          Return on investment has three defensible definitions that give very
          different numbers for the same system, so when it is shown, all
          three appear together. The setting is saved on the job and the
          customer report follows it.
        </HoverHelp>
      </div>
      {error ? (
        <p className="mt-1 text-caption text-destructive">{error}</p>
      ) : null}
      {view.showRoi ? (
        view.state === "ready" ? (
          <div className="mt-3 flex flex-wrap gap-x-12 gap-y-4">
            {view.roi.map((figure) => (
              <div key={figure.key} className="min-w-[132px]">
                <p className="flex items-center gap-1 text-caption text-muted-foreground">
                  {figure.label}
                  <HoverHelp label={`About ${figure.label.toLowerCase()}`}>
                    {figure.explanation}
                  </HoverHelp>
                </p>
                <p className="mt-0.5 metric-lg text-foreground">
                  {figure.value ?? "unavailable for this run"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-caption text-muted-foreground">
            Nothing to show yet — run the sizing first.
          </p>
        )
      ) : null}
    </section>
  );
}

export function ResultsTab({
  view,
  jobId,
}: {
  view: ResultsTabView;
  jobId: string;
}) {
  const worksheetLink = (
    <Link
      href={`/jobs/${jobId}/worksheet`}
      className="text-primary underline"
    >
      the worksheet
    </Link>
  );

  if (view.state === "unsized") {
    return (
      <p className="text-body text-muted-foreground">
        This job has not been sized yet. Run the sizing sections in{" "}
        {worksheetLink} — the results land here.
      </p>
    );
  }
  if (view.state === "awaiting-financial") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body text-muted-foreground">
          This job is sized, but the financial figures for the current run are
          still being worked out. Run the sizing again in {worksheetLink} —
          earlier runs are kept.
        </p>
        {/* The toggle still renders on a run with no financial row — it says
            there is nothing to show yet (3.13-4c fallback). */}
        <RoiPanel view={view} jobId={jobId} />
      </div>
    );
  }

  const h = view.headline;
  return (
    <div className="flex flex-col gap-6">
      {/* ── Headline ── */}
      {h ? (
        <div className="flex flex-wrap gap-x-12 gap-y-5">
          {(
            [
              ["Solar", h.solarKw],
              ...(h.battery !== null ? [["Battery", h.battery]] : []),
              ["Whole system cost", h.systemCost],
              ["Annual saving", h.annualSavings],
              ["Payback", h.payback],
              ["25-year NPV", h.npv],
              ["Current annual spend", h.currentSpend],
              ...(h.selfSufficiency !== null
                ? [["Self-sufficiency", h.selfSufficiency]]
                : []),
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="min-w-[132px]">
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="mt-0.5 metric-lg text-foreground">{value}</p>
            </div>
          ))}
          {/* Projected spend carries the UT-9 framing: at or below zero the
              bill is ELIMINATED and the surplus is a positive export income —
              never "$0", never a minus sign. */}
          <div>
            <p className="text-caption text-muted-foreground">
              Projected annual spend
            </p>
            {view.projected === null ? (
              <p className="metric-lg text-foreground">—</p>
            ) : view.projected.kind === "spend" ? (
              <p className="metric-lg text-foreground">
                {view.projected.label}
              </p>
            ) : (
              <>
                <p className="metric-lg text-foreground">Bill eliminated</p>
                {view.projected.exportIncome ? (
                  <p className="text-caption text-success">
                    plus {view.projected.exportIncome}/yr export income
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* The roof this run was built on — its doubt beside the figures. */}
      <NoticeStack items={view.roofNotices} />

      {/* ── Split ROI ── */}
      <section aria-label="Split return">
        <h2 className="text-h3 text-foreground">
          Solar and battery, split out
        </h2>
        {view.split ? (
          <div className="mt-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead> </TableHead>
                  <TableHead>Solar on its own</TableHead>
                  <TableHead>What the battery adds</TableHead>
                  <TableHead>Whole system</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(
                  [
                    ["Annual saving", "savings"],
                    ["25-year NPV", "npv"],
                    ["Payback", "payback"],
                    ["Net cost", "cost"],
                  ] as [string, keyof typeof view.split.solar][]
                ).map(([label, key]) => (
                  <TableRow key={label}>
                    <TableCell className="text-body text-muted-foreground">
                      {label}
                    </TableCell>
                    <TableCell className="metric-sm">
                      {view.split!.solar[key]}
                    </TableCell>
                    <TableCell className="metric-sm">
                      {view.split!.battery[key]}
                    </TableCell>
                    <TableCell className="metric-sm">
                      {view.split!.whole[key]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="mt-1 text-caption text-muted-foreground">
            {view.splitNote}
          </p>
        )}
      </section>

      {/* ── Return on investment (3.13 prompt 4c, D34) ── */}
      <RoiPanel view={view} jobId={jobId} />

      {/* ── The score curve (3.13 prompt 4b) ── */}
      <section aria-label="Score curve">
        <h2 className="text-h3 text-foreground">
          Every option the engine scored
        </h2>
        <div className="mt-2">
          <ScoreCurve view={view.curve} />
        </div>
      </section>

      {/* ── Itemised cost ── */}
      <section aria-label="Itemised cost">
        <h2 className="text-h3 text-foreground">What the cost is made of</h2>
        {view.cost ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.cost.lines.map((line, i) => (
                    <TableRow key={`${line.item}-${i}`}>
                      <TableCell className="text-body text-foreground">
                        {line.item}
                      </TableCell>
                      <TableCell className="text-caption text-muted-foreground">
                        {line.detail}
                      </TableCell>
                      <TableCell
                        className={
                          line.confirmed
                            ? "metric-sm text-right"
                            : "text-right text-caption text-muted-foreground"
                        }
                      >
                        {line.amount}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="text-label text-foreground">
                      Net cost
                    </TableCell>
                    <TableCell />
                    <TableCell className="metric-sm text-right">
                      {view.cost.net}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            {!view.cost.sumAgrees ? (
              <Notice tone="caution" title="The cost lines do not sum to the net cost">
                The itemised lines add to {view.cost.sumOfLines} while the
                stored net cost is {view.cost.net}. Both are shown; neither is
                preferred — the disagreement is the finding.
              </Notice>
            ) : null}
            {view.cost.flags.map((flag) => (
              <p key={flag} className="text-caption text-muted-foreground">
                {flag}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-caption text-muted-foreground">
            {view.costNote}
          </p>
        )}
      </section>

      {/* ── Panel layout, in words ── */}
      <section aria-label="Panel layout">
        <h2 className="text-h3 text-foreground">Where the panels sit</h2>
        {view.layoutLines ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {view.layoutLines.map((line) => (
              <li key={line} className="text-body text-foreground">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-caption text-muted-foreground">
            {view.layoutNote}
          </p>
        )}
      </section>

      {/* ── Assumptions ── */}
      <section aria-label="Assumptions">
        <details className="rounded-lg border border-border bg-card">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-h3 text-foreground [&::-webkit-details-marker]:hidden">
            What this run assumed
          </summary>
          <div className="border-t border-border px-3 py-2">
            {view.assumptions ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Assumption</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.assumptions.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="text-body text-foreground">
                          {row.label}
                        </TableCell>
                        <TableCell className="metric-sm">{row.value}</TableCell>
                        <TableCell className="text-caption text-muted-foreground">
                          {row.source ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-caption text-muted-foreground">
                {view.assumptionsNote}
              </p>
            )}
          </div>
        </details>
      </section>

      <p className="text-caption text-muted-foreground">
        Full sizing controls are in {worksheetLink}.
      </p>
    </div>
  );
}
