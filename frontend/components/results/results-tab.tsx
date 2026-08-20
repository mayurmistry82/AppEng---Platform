import Link from "next/link";
import { Notice } from "@/components/ui/notice";
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
 * NO CHART — and deliberately no placeholder promising one: a promise naming
 * a row number is exactly what went stale in the results bar and was deleted
 * there. Prompt 4b brings the score curve.
 *
 * A NULL cost-line amount reads "installer to confirm", NEVER $0 — an
 * unpriced line is a different fact from a free one. A breakdown whose lines
 * do not sum to its own net shows BOTH figures and says they disagree
 * (summing to net is the row's acceptance, so a mismatch is a finding).
 */
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
      <p className="text-body text-muted-foreground">
        This job is sized, but the financial figures for the current run are
        still being worked out. Run the sizing again in {worksheetLink} —
        earlier runs are kept.
      </p>
    );
  }

  const h = view.headline;
  return (
    <div className="flex flex-col gap-6">
      {/* ── Headline ── */}
      {h ? (
        <div className="flex flex-wrap gap-x-8 gap-y-3">
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
            <div key={label}>
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="metric-lg text-foreground">{value}</p>
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
