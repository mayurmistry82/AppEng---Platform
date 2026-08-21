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
  solarRunNotices,
  solarRunResult,
  type RoofNoticeView,
  type SolarRunResult,
  type SolarSizingView,
} from "@/lib/worksheet";

/**
 * Solar sizing (checklist 3.11) — the engine reaches a screen.
 *
 * The request body is {job_id} — or {job_id, constraints:{fix_solar_kwp}} on a
 * pinned keep-as-is run — AND NOTHING ELSE. The objective, tariff, load and
 * equipment are read server-side from what the earlier sections stored;
 * sending them from here would be a second source of truth (D29), and the
 * two-sided gate verify_sizing_request_contract.py holds this to it.
 *
 * A 200 IS NOT AUTOMATICALLY A RESULT: the optimiser answers 200 with
 * `needs_roof_input` when there is no usable roof (not an error — the roof
 * needs doing first) and 200 with an `error` key on an internal fault. The
 * component branches on the BODY.
 *
 * Opening a worksheet never fires a run on its own. 3.14 prompt 3 (F206):
 * A REVISIT RENDERS THE STORED RUN — the section's body comes from what the
 * database already holds, and the button's reply is only what makes it update
 * without waiting for a refresh. ONE rendering path (renderResult), fed from
 * two places; before this the body lived in React state alone, so navigating
 * to Results and back left an eighteen-second re-run as the only way to see a
 * stored answer again.
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

export function SolarSizingSection({
  view,
  jobId,
}: {
  view: SolarSizingView;
  jobId: string;
}) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  // 3.13 prompt 2b: when the in-flight run began, for the live elapsed
  // counter. Cleared in the same finally that clears `running`, so the
  // indicator can never be left ticking after a failure.
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  // "keep" is only offered when canPin (path pins AND a size was recorded).
  const [mode, setMode] = React.useState<"keep" | "reoptimise">(
    view.canPin ? "keep" : "reoptimise",
  );
  const [result, setResult] = React.useState<SolarRunResult | null>(null);
  const [keptResult, setKeptResult] = React.useState<SolarRunResult | null>(null);
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
      const body: Record<string, unknown> =
        mode === "keep" && view.canPin && view.existingSolarKw !== null
          ? { job_id: jobId, constraints: { fix_solar_kwp: view.existingSolarKw } }
          : { job_id: jobId };
      const res = await requestJson<Record<string, unknown>>(
        "POST",
        "/api/sizing/optimise",
        body,
      );
      if (!res.ok) {
        const copy = saveErrorCopy(res.kind, res.status, res.message);
        setActionError({ ...copy, isAuth: res.kind === "auth" });
        return; // screen intact, nothing navigates
      }
      const parsed = solarRunResult(res.data);
      // Path C "show both": a keep-as-is run parks its result on the side so a
      // later re-optimise renders alongside it rather than replacing it.
      if (mode === "keep") {
        setKeptResult(parsed);
        setResult(null);
      } else {
        setResult(parsed);
      }
      setRunNotices(parsed.ok ? solarRunNotices(res.data) : []);
      if (parsed.ok) router.refresh(); // the tick + results bar read the new row
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }

  function renderResult(r: SolarRunResult, title: string | null) {
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
        {title ? <p className="text-label text-foreground">{title}</p> : null}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {[
            ["System size", r.headline.solarKw],
            ["Panels", r.headline.panelCount ?? "—"],
            ["Annual generation", r.headline.annualGenerationKwh],
            ["System cost", r.headline.systemCost],
            ["Simple payback", r.headline.payback],
            ["25-year NPV", r.headline.npv],
            ["Self-sufficiency", r.headline.selfSufficiencyPct],
          ].map(([label, value]) => (
            <div key={label as string}>
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="metric-sm text-foreground">{value}</p>
            </div>
          ))}
        </div>

        {r.options.length > 0 ? (
          <div>
            <p className="text-caption text-muted-foreground">
              The options the engine considered
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Size</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Payback</TableHead>
                  <TableHead>25-year NPV</TableHead>
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
                    <TableCell><span className="text-body text-foreground tabular-nums">{row.cost}</span></TableCell>
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
        Sizes the solar for this roof using the objective, tariff, load and
        equipment already saved on this job — the sections above are honoured,
        not ignored.
      </p>

      {view.solarMode === "pinned" ? (
        <fieldset>
          <legend className="text-caption text-muted-foreground">
            This job has solar on the roof
          </legend>
          <div className="mt-1 flex flex-col gap-1">
            <label className="flex items-center gap-2 text-body text-foreground">
              <input
                type="radio"
                name="solar-mode"
                checked={mode === "keep"}
                disabled={!view.canPin}
                onChange={() => setMode("keep")}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              Keep the existing array
              {view.existingSolarKw !== null
                ? ` — ${view.existingSolarKw} kW`
                : " (size not recorded)"}
            </label>
            <label className="flex items-center gap-2 text-body text-foreground">
              <input
                type="radio"
                name="solar-mode"
                checked={mode === "reoptimise"}
                onChange={() => setMode("reoptimise")}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              Re-optimise the array
            </label>
          </div>
        </fieldset>
      ) : null}

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

      {/* Path C "show both": the kept array and the re-optimised recommendation
          render together, never one replacing the other. */}
      {keptResult ? renderResult(keptResult, "Kept as-is") : null}
      {result
        ? renderResult(result, keptResult ? "Re-optimised recommendation" : null)
        : null}

      {/* 3.14 prompt 3 (F206): the STORED run — the same renderResult, fed
          from the job rather than from a reply, and shown only when this
          visit has no fresh one of its own. */}
      {!result && !keptResult && view.storedRun ? (
        <div className="flex flex-col gap-2">
          {renderResult(view.storedRun.run, null)}
          {view.storedRun.chosenNote ? (
            <p className="text-caption text-muted-foreground">
              {view.storedRun.chosenNote}
            </p>
          ) : null}
          {view.storedRun.notRecordedNote ? (
            <p className="text-caption text-muted-foreground">
              {view.storedRun.notRecordedNote}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={running}>
          {running ? "Sizing…" : "Size the solar"}
        </Button>
        {/* 3.13 prompt 3 (G/F183): "replaces the stored result" was FALSE —
            the run log has been append-only since 3.11b; a new run is
            INSERTED and earlier runs survive (D33's engine comparison and
            3.14's A/B compare depend on exactly that). */}
        {running ? (
          <RunProgress startedAt={startedAt} />
        ) : view.alreadySized && !result && !keptResult ? (
          <span className="text-caption text-muted-foreground">
            Already sized{view.storedSolarKw !== null ? ` — ${view.storedSolarKw} kW stored` : ""}. Running again adds a new result; earlier runs are kept.
          </span>
        ) : null}
      </div>
    </div>
  );
}
