"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { RunProgress } from "@/components/ui/run-progress";
import { NoticeStack } from "@/components/ui/notice-stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requestJson } from "@/lib/client-api";
import { clientActionErrorCopy, type ApiErrorKind } from "@/lib/jobs";
import {
  batteryRunNotices,
  batteryRunResult,
  type BatteryRunResult,
  type BatterySizingView,
  type RoofNoticeView,
} from "@/lib/worksheet";

/**
 * Battery sizing (checklist 3.12) — the LP result reaches a screen.
 *
 * THE BUTTON SAYS "Size the system", decided by Mayur 2026-08-20, and it is
 * not cosmetic: this endpoint sizes solar AND battery in one run and stores
 * one result labelled solar_battery, so "Size the battery" would describe
 * something the software does not do. It is also the wording D33 says this
 * action must eventually carry, so it never needs renaming when the combined
 * engine lands at 4.0.
 *
 * THIS SECTION DOES NOT REQUIRE A SOLAR RESULT, does not check for one, and
 * never disables its button because one is missing. The endpoint re-runs the
 * solar step itself. Under a combined engine this section becomes one VIEW of
 * one result with no change to its contract — and that only holds if the
 * sequence is absent from it now (D33).
 *
 * The request body is {job_id} AND NOTHING ELSE. The objective, budget,
 * tariff, load and equipment are read server-side from what the earlier
 * sections stored; sending them from here would be a second source of truth
 * (D29), and verify_sizing_request_contract.py holds this to it.
 *
 * A 200 IS NOT AUTOMATICALLY A RESULT: the engine answers 200 with
 * `needs_roof_input` when there is no usable roof (not an error — the roof
 * needs doing first) and 200 with an `error` key on an internal fault.
 *
 * NO BATTERY IS A LEGITIMATE OUTCOME, not a failure: the flowchart's NB node
 * names it on four of the six paths. When the engine recommends none, its own
 * not_economic_reason is the visible answer in a NEUTRAL tone — never an error,
 * never a warning, and never paraphrased (prompt 1 made those sentences plain
 * English in the engine precisely so no second copy exists here, F161).
 *
 * WHAT IS DELIBERATELY ABSENT: no Advanced options (coupling is 4.9, backup
 * reserve SoC 4.5, VPP 4.6, grid-charge 4.7), no Pin/constrain dropdown
 * (6.1/6.3), and no budget badge (the response carries no within_budget and a
 * second derivation here is what 2R.1 forbids; results are 3.13). A control
 * that stores a choice and changes no number is the shape D29 rejected.
 */

function saveErrorCopy(kind: ApiErrorKind, status: number, message: string) {
  if (kind === "http" && status === 404) {
    // Never "no permission" — that would leak that the job exists.
    return {
      heading: "This job could not be found",
      body: "Head back to the job list and reopen it.",
    };
  }
  if (kind === "http" && message && (status === 403 || status === 503)) {
    return { heading: "That didn't run", body: message };
  }
  return clientActionErrorCopy(kind, status);
}

export function BatterySizingSection({
  view,
  jobId,
}: {
  view: BatterySizingView;
  jobId: string;
}) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  // 3.13 prompt 2b: when the in-flight run began, for the live elapsed
  // counter. Cleared in the same finally that clears `running`, so the
  // indicator can never be left ticking after a failure.
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [result, setResult] = React.useState<BatteryRunResult | null>(null);
  const [runNotices, setRunNotices] = React.useState<readonly RoofNoticeView[]>([]);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);

  async function run() {
    if (running) return;
    setRunning(true);
    setStartedAt(Date.now());
    setActionError(null);
    try {
      // THE WHOLE BODY. Nothing stored on the job travels from the browser.
      const res = await requestJson<Record<string, unknown>>(
        "POST",
        "/api/sizing/battery",
        { job_id: jobId },
      );
      if (!res.ok) {
        const copy = saveErrorCopy(res.kind, res.status, res.message);
        setActionError({ ...copy, isAuth: res.kind === "auth" });
        return; // screen intact, nothing navigates, no partial result
      }
      const parsed = batteryRunResult(res.data);
      setResult(parsed);
      setRunNotices(parsed.ok ? batteryRunNotices(res.data) : []);
      if (parsed.ok) router.refresh(); // the tick + results bar read the new row
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }

  function renderResult(r: BatteryRunResult) {
    if (r.needsRoofInput) {
      return (
        <Notice tone="info" title="This job needs its roof sorted first">
          The engine has no usable roof to size on. Find or enter the roof in{" "}
          <Link href="#address-roof" className="text-primary underline">
            Address &amp; roof
          </Link>{" "}
          and come back — the button stays right here.
        </Notice>
      );
    }
    if (r.errorMessage) {
      return (
        <Notice tone="problem" title="The engine could not size this job">
          {r.errorMessage}
        </Notice>
      );
    }
    if (!r.headline) return null;
    return (
      <div className="flex flex-col gap-3">
        {/* NO BATTERY: the engine's own sentence is the answer, in a neutral
            tone. Not an error, not a warning — a real recommendation. */}
        {r.noBattery ? (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="text-label text-foreground">
              No battery is recommended for this job
            </p>
            {r.notEconomicReason ? (
              <p className="mt-1 text-body text-muted-foreground">
                {r.notEconomicReason}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {[
              ["Battery", r.headline.model],
              ["Usable capacity", r.headline.usableKwh],
              ["Battery cost (added)", r.headline.batteryCost],
              ["Whole system cost", r.headline.systemCost],
              ["Incremental payback", r.headline.payback],
              ["Incremental NPV", r.headline.npv],
              ["Self-sufficiency", r.headline.selfSufficiencyPct],
            ].map(([label, value]) => (
              <div key={label as string}>
                <p className="text-caption text-muted-foreground">{label}</p>
                <p className="metric-sm text-foreground">{value}</p>
                {/* 3.13 prompt 3 (H/F184): the ENGINE's within_budget flag,
                    verbatim, beside the cost it judges — rendered only when
                    the job HAS a budget (a job with no cap has nothing to be
                    within), and never recomputed on screen (D29, 2R.1). */}
                {label === "Whole system cost" &&
                view.hasBudget &&
                r.withinBudget !== null ? (
                  <p
                    className={
                      r.withinBudget
                        ? "text-caption text-success"
                        : "text-caption text-destructive"
                    }
                  >
                    {r.withinBudget ? "Within the budget" : "Over the budget"}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* The solar THIS run chose — it sizes both halves itself (D33). */}
        {r.chosenSolar ? (
          <div>
            <p className="text-caption text-muted-foreground">
              The solar this run chose
            </p>
            <div className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
              {[
                ["System size", r.chosenSolar.solarKw],
                ["Annual generation", r.chosenSolar.annualGenerationKwh],
                ["Solar-only cost", r.chosenSolar.systemCostSolarOnly],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <p className="text-caption text-muted-foreground">{label}</p>
                  <p className="metric-sm text-foreground">{value}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {r.options.length > 0 ? (
          <div>
            <p className="text-caption text-muted-foreground">
              The options the engine considered
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Capacity</TableHead>
                  <TableHead>Battery</TableHead>
                  <TableHead>Whole system</TableHead>
                  <TableHead>Payback</TableHead>
                  <TableHead>Incremental NPV</TableHead>
                  <TableHead>Self-sufficiency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.options.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <span className={row.chosen ? "text-body text-primary" : "text-body text-foreground"}>
                        {row.label}
                        {row.chosen ? " · chosen" : ""}
                      </span>
                    </TableCell>
                    <TableCell><span className="text-body text-foreground">{row.model}</span></TableCell>
                    <TableCell><span className="text-body text-foreground tabular-nums">{row.systemCost}</span></TableCell>
                    <TableCell><span className="text-body text-foreground tabular-nums">{row.payback}</span></TableCell>
                    <TableCell><span className="text-body text-foreground tabular-nums">{row.npv}</span></TableCell>
                    <TableCell><span className="text-body text-foreground tabular-nums">{row.selfSufficiency}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {/* The engine's own flags, VERBATIM (F161). A flag that reads badly is
            a defect in the engine's string — reported, never reworded here. */}
        {r.engineFlags.length > 0 ? (
          <div>
            <p className="text-caption text-muted-foreground">Engine notes</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {r.engineFlags.map((flag, i) => (
                <li key={i} className="text-caption text-muted-foreground">
                  {flag}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        Sizes the solar and the battery together in one run, using the
        objective, tariff, load and equipment already saved on this job — the
        sections above are honoured, not ignored.
      </p>

      <NoticeStack items={[...runNotices, ...view.notices]} />

      {actionError ? (
        <Notice tone="problem" title={actionError.heading}>
          {actionError.body}
          {actionError.isAuth ? (
            <>
              {" "}
              <Link href="/login" className="text-primary underline">
                Go to sign in
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}

      {result ? renderResult(result) : null}

      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={running}>
          {running ? "Sizing…" : "Size the system"}
        </Button>
        {running ? (
          <span className="flex flex-col gap-1">
            <RunProgress startedAt={startedAt} />
            {/* The one honest sentence — this button runs the full-year
                dispatch (D35). The live counter above is the caption; no
                fixed duration promise anywhere. */}
            <span className="text-caption text-muted-foreground">
              A full-year run checks all 365 days and can take a minute or
              two.
            </span>
          </span>
        ) : view.alreadySized && !result ? (
          // NOT "running again replaces the stored result" — the run log has
          // been append-only since 3.11b, so that sentence would be false.
          <span className="text-caption text-muted-foreground">
            Already sized
            {view.storedBatteryKwh !== null
              ? ` — ${view.storedBatteryKwh} kWh stored`
              : ""}
            .
          </span>
        ) : null}
      </div>
    </div>
  );
}
