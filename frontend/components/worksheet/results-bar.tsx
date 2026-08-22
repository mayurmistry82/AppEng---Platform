"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight } from "lucide-react";
import { KpiTile } from "@/components/ui/kpi-tile";
import { PinChip } from "@/components/ui/override-drawer";
import { RunProgress } from "@/components/ui/run-progress";
import type { ScoreCurveProps } from "@/components/results/score-curve";
import { requestJson } from "@/lib/client-api";
import {
  formatKw,
  formatKwh,
  formatMoney,
  formatPct,
  formatYears,
  parseRunHistory,
  railCompareView,
  railFailedState,
  railFiguresFor,
  railPickerState,
  railRecostRequest,
  railRecostState,
  railRerank,
  railRerankedCurve,
  railRunLabel,
  railStatusLine,
  RESULTS_BAR_DEFAULT_HEIGHT,
  RESULTS_BAR_MIN_HEIGHT,
  RESULTS_BAR_AUTOEXPAND_STORAGE_KEY,
  RESULTS_BAR_STORAGE_KEY,
  clampResultsBarHeight,
  parseAutoExpandedJobs,
  rememberAutoExpandedJob,
  resultsBarCeiling,
  parseResultsBarPreference,
  resultsBarDefaultCollapsed,
  shouldAutoExpandResultsBar,
  type RailBaseline,
  type RailDelta,
  type RailHistory,
  type RailHistoryRun,
  type RailState,
  type ResultsBarMetrics,
  type ResultsBarView,
  type ScoreCurveView,
  type SizingInputChange,
} from "@/lib/worksheet";

/**
 * Frozen results bar (checklist 3.3, corrected at 3.3a) — wireframe v4
 * Variant A `.frozen`/`.rbar`. Sticky at the top of the worksheet's scroll
 * region, directly beneath the job bar and tabs.
 *
 * NOT-YET-SIZED DISCIPLINE (the 3.1 empty-state rule one level down): the
 * component branches on `view.sized` — the discriminant, never the truthiness
 * of a number. Unsized renders "Not yet sized" + em-dashes, never a
 * fabricated 0 / $0 / 0%.
 *
 * NO CHART LIBRARY HERE — importing one costs ~115 kB First Load (F47) and
 * there is no real chart until 3.12. The chart area is a bg-muted placeholder
 * that GROWS with the bar rather than sitting in a fixed box.
 *
 * STACKED LAYOUT (2026-08-14, deliberate departure from wireframe Variant A):
 * one vertical column — tiles, chips, then the chart placeholder full width —
 * rather than the wireframe's side-by-side metrics/chart split. Dragged tall,
 * the two-column version left a large empty area under the metrics while the
 * chart stayed squeezed into 40% of the width; the wireframe's bar was a short
 * fixed strip and never contemplated a full-height drag. The chart is the only
 * element that takes the leftover height (flex-1 + min-h-0) — the tiles, chips
 * and Metric row keep their natural heights.
 *
 * DECISION D3, fixes 1 and 2:
 *   - first-ever render of an UNSIZED job is numbers-only (the chart is empty
 *     during first-pass entry, and the bar is frozen so its height is spent on
 *     every screen); a sized job starts expanded;
 *   - the collapsed flag AND the dragged height then persist across loads and
 *     across jobs — it is a preference about the bar, not about a job.
 *   - D3's third clause, AUTO-EXPAND ON THE FIRST COMPLETED RUN, is built at
 *     3.14 prompt 3 (it needed a job that can produce a result). Per D3's
 *     2026-08-14 amendment it fires ONCE PER JOB and the saved preference
 *     wins thereafter: the bar opens itself the first time this job has a
 *     result so the installer meets the chart, the job id is marked, and if
 *     the installer then collapses it that sticks. It is the SAME in-place
 *     bar expanding — not a dialog, not an overlay, no animation of its own.
 *     The marker lives in its OWN versioned key; the preference key keeps its
 *     shape and its self-heal untouched. The one-time override does NOT
 *     rewrite the preference — only a real toggle, drag or keyboard commit
 *     does, which is what lets the preference win from then on.
 *
 * HYDRATION: storage is read in an EFFECT, never in a useState initialiser or
 * during render — a render-time read makes the server HTML disagree with the
 * first client render and React logs a hydration error that is easy to ignore
 * and hard to trace. Writes happen only when a value settles: on toggle, on
 * drag END, and on each keyboard commit — never during pointermove.
 *
 * All storage access is wrapped: it is unavailable in some privacy modes and
 * throws on write when full. A failure silently degrades to the D3 default.
 *
 * The clamping arithmetic lives in lib/worksheet.ts and is unit-tested; this
 * component owns only the DOM measurement that feeds it.
 */

// 3.13 prompt 4 (E): NO local formatter — the bar renders through the same
// shared set the Results section and the Results tab use, so the three
// surfaces cannot disagree about the same stored number again.

/** Shown while the chart chunk is in flight. */
function CurveLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center text-caption text-muted-foreground">
      Loading the curve…
    </div>
  );
}

/**
 * Shown if the chunk never arrives (offline, blocked, a 404 after a deploy):
 * the plain sentence the rail would show without a chart. The bar must never
 * break because a chunk did not load.
 */
function CurveUnavailable() {
  return (
    <p className="text-caption text-muted-foreground">
      The curve could not be loaded. The options this run compared are listed
      in the Solar sizing section.
    </p>
  );
}

/**
 * 3.14 prompt 4 — THE SAME ScoreCurve the Results tab renders, never a second
 * chart (2R.1), reached through next/dynamic with ssr:false so recharts lands
 * in its OWN chunk instead of the worksheet route's First Load (F47).
 *
 * The pattern follows components/charts/plotly-chart.tsx rather than
 * components/panels/SolarPanel.tsx: that file's one-liner has neither a
 * loading state nor a failure path, and this prompt requires both — a `.catch`
 * that resolves to a plain sentence, so a failed chunk degrades quietly
 * instead of throwing inside React's lazy machinery.
 *
 * The bar is numbers-only by default, so a user who never expands never
 * fetches this. D3's auto-expand means the cost DOES arrive once on a job's
 * first result — after paint rather than before it, accepted deliberately.
 */
const ScoreCurve = dynamic<ScoreCurveProps>(
  () =>
    import("@/components/results/score-curve")
      .then((mod) => mod.ScoreCurve)
      .catch(() => CurveUnavailable),
  { ssr: false, loading: () => <CurveLoading /> },
);

/**
 * THE FRAME (3.14 prompt 4). The expanded bar is 320px by default and the
 * chart gets what the tiles and chips leave — nowhere near the seven 44px
 * rows the Results tab spends. Two things are changed and nothing else: the
 * rows are DENSER (the rail's solar bars carry a single-line label, so 30px
 * is comfortable where the tab's two-line product ticks need 44), and past
 * the space available the plot keeps its natural height and SCROLLS inside
 * the bar. Every option stays reachable and no label is squeezed; shrinking
 * the plot to fit would slice them, which is the fault 4e exists to prevent.
 * NOTHING IN THE SUITE CAN SEE WHAT A BROWSER LAYS OUT (F200) — this is a
 * stated choice, not a verified one.
 */
const RAIL_ROW_HEIGHT = 30;

/**
 * 3.14 prompt 6 (D37) — THE LIVE RAIL. The bar answers "what did that change
 * do": INSTANTLY from the stored options on an objective/budget save, and
 * by RE-COSTING the stored system (persist false, compare_to_unconstrained
 * false, pinned) on a physics save. Every state is derived in lib
 * (RailState) and this component only renders it. It NEVER re-searches, it
 * saves NOTHING, and the status line beneath the tiles is the only carrier
 * of where a recomputed figure came from — so it is always present on a
 * recomputed state and never on the stored one.
 *
 * A new stored run (a Size) changes the baseline's sizing_result_id; any
 * client-side recompute belonged to the old run and is dropped, never shown
 * beside the new one.
 */
export function ResultsBar({
  view,
  jobId,
  curve,
  baseline,
  change,
}: {
  view: ResultsBarView;
  /** 3.14 prompt 3: D3's auto-expand is ONCE PER JOB, so the bar must know
      which job it is looking at. Optional so a caller without one degrades
      to never auto-expanding rather than opening on every load. */
  jobId?: string;
  /** 3.14 prompt 4: the value-versus-size curve, built by solarCurveView.
      Optional — without it the chart area keeps its previous behaviour. */
  curve?: ScoreCurveView;
  /** 3.14 prompt 6: the stored run the rail recomputes against. */
  baseline?: RailBaseline;
  /** 3.14 prompt 6: the last announced save, or null. */
  change?: SizingInputChange | null;
}) {
  const [rail, setRail] = React.useState<RailState>({ kind: "stored" });
  // 3.14 prompt 8: THE BASELINE. The job's run history from the lean
  // endpoint (never the job payload, which caps child tables at twenty and
  // says so only in the log), and the run selected to compare against.
  // SESSION-SCOPED BY DECISION: nothing is stored, and a selection that is
  // later superseded simply stays selected — it never jumps.
  const [history, setHistory] = React.useState<RailHistory | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/sizing/runs?${new URLSearchParams({ job_id: jobId, limit: "100" })}`,
          { cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (cancelled) return;
        if (!res.ok) {
          setHistoryError(res.status === 401 ? "your session has expired" : `HTTP ${res.status}`);
          return;
        }
        setHistory(parseRunHistory(await res.json()));
        setHistoryError(null);
      } catch {
        if (!cancelled) setHistoryError("the request did not complete");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);
  // The change the rail has already acted on — a new seq acts once.
  const actedSeq = React.useRef(0);
  // The baseline the current rail state belongs to.
  const railBaselineId = React.useRef<string | null>(baseline?.sizingResultId ?? null);

  const recost = React.useCallback(
    async (trigger: SizingInputChange) => {
      if (!baseline || !jobId) {
        setRail(railFailedState(trigger, "the rail has no stored run to re-cost."));
        return;
      }
      const body = railRecostRequest(baseline, jobId);
      if (body === null || baseline.endpoint === null) {
        setRail(railFailedState(trigger, "the stored run has no system that can be pinned."));
        return;
      }
      setRail({ kind: "recosting", trigger, startedAt: Date.now() });
      const result = await requestJson<Record<string, unknown>>(
        "POST",
        baseline.endpoint,
        body,
      );
      // A later change superseded this one while it was in flight.
      if (actedSeq.current !== trigger.seq) return;
      if (!result.ok) {
        setRail(
          railFailedState(
            trigger,
            result.kind === "auth"
              ? "your session has expired — sign in again."
              : result.message || "the engine did not answer.",
          ),
        );
        return;
      }
      setRail(railRecostState(baseline, trigger, result.data));
    },
    [baseline, jobId],
  );

  // A NEW STORED RUN supersedes anything the rail computed against the old one.
  React.useEffect(() => {
    const id = baseline?.sizingResultId ?? null;
    if (id !== railBaselineId.current) {
      railBaselineId.current = id;
      setRail({ kind: "stored" });
    }
  }, [baseline?.sizingResultId]);

  // A SAVE ANNOUNCED: act on it once.
  React.useEffect(() => {
    if (!change || change.seq === actedSeq.current) return;
    actedSeq.current = change.seq;
    if (!baseline) return; // nothing to recompute against — stays stored
    if (change.kind === "objective-budget") {
      setRail(railRerank(baseline, change));
    } else {
      void recost(change);
    }
  }, [change, baseline, recost]);

  // First render: the D3 default, derived purely from props so server and
  // client agree. The stored preference is applied in the effect below.
  const [collapsed, setCollapsed] = React.useState(() =>
    resultsBarDefaultCollapsed(view),
  );
  const [height, setHeight] = React.useState(RESULTS_BAR_DEFAULT_HEIGHT);
  const [maxHeight, setMaxHeight] = React.useState(RESULTS_BAR_DEFAULT_HEIGHT);
  const barRef = React.useRef<HTMLElement | null>(null);
  const drag = React.useRef<{ startY: number; startHeight: number } | null>(null);
  // (3.3a-fix2) The last height the USER actually chose — set only by a drag end,
  // a keyboard commit, or a valid stored preference. `toggleCollapsed` persists
  // THIS, never the live clamped state: persisting a squashed height as though it
  // were a choice is what made the fault survive every reload.
  const lastUserChosenHeight = React.useRef(RESULTS_BAR_DEFAULT_HEIGHT);

  /**
   * The bar's RESTING top and the viewport height (3.3a-fix2).
   *
   * `barRef.getBoundingClientRect().top` is VIEWPORT-relative and grows as the
   * page scrolls, so measuring it on a restored-scroll reload computed a ceiling
   * at the floor and squashed the bar to a stripe. We measure the bar's nearest
   * SCROLLING ANCESTOR instead: that element does not move when its own content
   * scrolls, so its top is the same number at scroll 0 and scroll 2000 — which is
   * precisely the bar's resting top, since the bar is `sticky top-0` as that
   * container's first child.
   *
   * No scrolling ancestor found, or no DOM at all (SSR) -> containerTop null,
   * which resultsBarCeiling reads as suspect. Never fall back to the scrolled
   * value: that is the bug.
   */
  const measure = React.useCallback((): ResultsBarMetrics => {
    const viewportHeight =
      typeof window === "undefined" ? 0 : window.innerHeight;
    const bar = barRef.current;
    const barTop = bar?.getBoundingClientRect().top ?? 0;
    let containerTop: number | null = null;
    if (bar && typeof window !== "undefined") {
      let node: HTMLElement | null = bar.parentElement;
      while (node) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          containerTop = node.getBoundingClientRect().top;
          break;
        }
        node = node.parentElement;
      }
    }
    return { viewportHeight, containerTop, barTop };
  }, []);

  const persist = React.useCallback(
    (next: { collapsed: boolean; height: number }) => {
      try {
        window.localStorage.setItem(
          RESULTS_BAR_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // A preference, not data — a full or unavailable store is not an error.
      }
    },
    [],
  );

  // Mount: apply the stored preference over the D3 default, re-clamped against
  // the CURRENT window (a height saved on a large monitor must not swallow a
  // laptop screen).
  React.useEffect(() => {
    const metrics = measure();
    const ceiling = resultsBarCeiling(metrics);

    let stored: { collapsed: boolean; height: number } | null = null;
    try {
      stored = parseResultsBarPreference(
        window.localStorage.getItem(RESULTS_BAR_STORAGE_KEY),
      );
    } catch {
      stored = null;
    }
    // The collapsed flag is a plain choice and never depends on a measurement.
    if (stored) {
      setCollapsed(stored.collapsed);
      // A stored height that survived parsing WAS a real user choice.
      lastUserChosenHeight.current = stored.height;
    }

    // D3's auto-expand, ONCE PER JOB (2026-08-14 amendment). It runs AFTER
    // the stored preference is applied because it deliberately overrides a
    // stored `collapsed: true` that one time — and it writes only the marker,
    // never the preference, so a later collapse is the last word. Every
    // storage touch is wrapped: junk, a full store or no store at all leaves
    // the bar exactly as the preference found it.
    let autoExpanded: string[] = [];
    try {
      autoExpanded = parseAutoExpandedJobs(
        window.localStorage.getItem(RESULTS_BAR_AUTOEXPAND_STORAGE_KEY),
      );
    } catch {
      autoExpanded = [];
    }
    if (shouldAutoExpandResultsBar(view, jobId, autoExpanded) && jobId) {
      setCollapsed(false);
      try {
        window.localStorage.setItem(
          RESULTS_BAR_AUTOEXPAND_STORAGE_KEY,
          JSON.stringify(rememberAutoExpandedJob(autoExpanded, jobId)),
        );
      } catch {
        // A marker, not data. If it cannot be written the bar may open once
        // more on a later visit — far better than throwing on a render path.
      }
    }

    // A suspect measurement leaves BOTH maxHeight and height alone — the bar
    // keeps its default rather than being shrunk by a reading we do not trust.
    if (ceiling === null) return;
    setMaxHeight(ceiling);
    setHeight(
      clampResultsBarHeight(
        stored ? stored.height : RESULTS_BAR_DEFAULT_HEIGHT,
        metrics.viewportHeight,
        metrics.containerTop ?? 0,
      ),
    );
    // `view.sized` is in the deps deliberately: the first completed run
    // arrives through router.refresh(), not a reload, so the auto-expand has
    // to be able to fire when the prop flips from unsized to sized.
  }, [measure, view, jobId]);

  // A shorter window lowers the ceiling; the current height follows it down so
  // the worksheet strip stays visible.
  React.useEffect(() => {
    function onResize() {
      const metrics = measure();
      const ceiling = resultsBarCeiling(metrics);
      if (ceiling === null) return; // suspect — never shrink on a bad reading
      setMaxHeight(ceiling);
      setHeight((current) =>
        clampResultsBarHeight(
          current,
          metrics.viewportHeight,
          metrics.containerTop ?? 0,
        ),
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // The user's height, never the live clamped state (3.3a-fix2 link d).
    persist({ collapsed: next, height: lastUserChosenHeight.current });
  }

  function applyHeight(desired: number): number {
    const metrics = measure();
    // A suspect measurement must not clamp a deliberate drag downward either —
    // fall back to the floor-only clamp rather than a ceiling we do not trust.
    const clamped =
      resultsBarCeiling(metrics) === null
        ? Math.max(RESULTS_BAR_MIN_HEIGHT, desired)
        : clampResultsBarHeight(
            desired,
            metrics.viewportHeight,
            metrics.containerTop ?? 0,
          );
    setHeight(clamped);
    return clamped;
  }

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    drag.current = { startY: e.clientY, startHeight: height };
    // Pointer capture keeps move/up flowing to the handle even when the
    // pointer leaves the window, so a release outside still ends the drag.
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    applyHeight(drag.current.startHeight + (e.clientY - drag.current.startY));
  }
  function onHandlePointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    const wasDragging = drag.current !== null;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Write only once the value has settled. A drag end IS a user choice.
    if (wasDragging) {
      lastUserChosenHeight.current = height;
      persist({ collapsed, height });
    }
  }

  /**
   * The handle is keyboard operable: before 3.3a it had role="separator" but
   * no tabIndex and no key handler, so a keyboard user could not resize the bar
   * at all — and with the range now much larger, that gap matters more.
   */
  function onHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16;
    let desired: number | null = null;
    if (e.key === "ArrowDown") desired = height + step;
    else if (e.key === "ArrowUp") desired = height - step;
    else if (e.key === "Home") desired = RESULTS_BAR_MIN_HEIGHT;
    else if (e.key === "End") desired = maxHeight;
    if (desired === null) return;
    e.preventDefault(); // arrows resize the bar; they must not scroll the page
    const chosen = applyHeight(desired); // a keyboard commit IS a user choice
    lastUserChosenHeight.current = chosen;
    persist({ collapsed, height: chosen });
  }

  // What the chart may occupy: the bar's current height less the tiles, the
  // chips and the caption stack beneath the plot. A floor keeps it usable at
  // the smallest drag; past this the plot scrolls rather than shrinking.
  const railPlotHeight = Math.max(120, height - 210);

  // The figures the tiles show: the stored run's, or the rail's "after".
  const storedFigures = baseline?.figures ?? {
    solarKw: view.sized ? view.solarKw : null,
    batteryKwh: view.sized ? view.batteryKwh : null,
    paybackYears: view.sized ? view.paybackYears : null,
    npv: view.sized ? view.npv : null,
    selfSufficiencyPct: view.sized ? view.selfSufficiencyPct : null,
    basis: "whole-system" as const,
  };
  const shown = railFiguresFor(rail, storedFigures);
  const recomputed = rail.kind === "reranked" || rail.kind === "recosted";
  // 3.14 prompt 8: every delta reads against the SELECTED baseline.
  const picker = railPickerState(history, baseline?.meta.sizingResultId ?? null, historyError);
  const selected: RailHistoryRun | null =
    picker.kind === "ready" && selectedId
      ? picker.choices.find((r) => r.sizingResultId === selectedId) ?? null
      : null;
  const compare = baseline
    ? railCompareView(baseline, selected, rail, view.sized ? view.valueOrigin.label : "—")
    : null;
  const comparing = compare !== null && compare.baseline === "historical";
  const deltas: RailDelta[] = compare
    ? (comparing || recomputed ? compare.deltas : [])
    : [];
  // The chart follows the rail: a re-rank re-ranks the SAME points for the
  // applied objective (F210); otherwise the stored curve, as prompt 4 wired it.
  const rerankedCurve =
    rail.kind === "reranked" && baseline ? railRerankedCurve(baseline, rail.trigger) : null;
  const shownCurve = rerankedCurve ?? curve;
  const deltaFor = (label: string): RailDelta | null =>
    deltas.find((d) => d.label === label) ?? null;
  const tileDelta = (label: string, fallback: string): React.ReactNode => {
    const d = deltaFor(label);
    if (!d) return fallback;
    return d.direction === "none"
      ? `was ${d.before} · no change`
      : `was ${d.before} · ${d.change}`;
  };
  const tileSign = (label: string, higherIsBetter: boolean) => {
    const d = deltaFor(label);
    if (!d || d.direction === "none") return undefined;
    return (d.direction === "up") === higherIsBetter ? "positive" : "negative";
  };
  const statusLine = railStatusLine(rail);

  const heroValue = view.sized
    ? [
        shown.solarKw != null ? formatKw(shown.solarKw) : null,
        shown.batteryKwh != null ? formatKwh(shown.batteryKwh) : null,
      ]
        .filter(Boolean)
        .join(" + ") || "—"
    : "Not yet sized";

  return (
    <section
      ref={barRef}
      aria-label="Results"
      className="sticky top-0 z-30 border-b border-border bg-background pb-2 pt-1"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="mb-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {collapsed ? (
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        Chart
      </button>

      {/* overflow-hidden is the single most important token in this file: without
          it, content that does not fit the fixed height SPILLS OUT and paints over
          the worksheet, because bg-background only covers this box. That spill is
          what read as "the page scrambled" on 2026-08-14. */}
      <div
        className={collapsed ? "" : "flex min-h-0 flex-col gap-2 overflow-hidden"}
        style={collapsed ? undefined : { height }}
      >
        {/* Metrics — full width. Keeps its own scrollbar only if it genuinely
            overflows at the minimum height; it never takes the leftover space
            (no flex-1 here — the chart below gets that). */}
        <div className="flex shrink-0 flex-col gap-2 overflow-y-auto">
          <div className="grid grid-cols-5 gap-2">
            {/* 3.14 prompt 6: before-and-after. A recomputed state shows the
                new figure with "was X · +Y" beneath it; the stored state
                keeps its caption. The hero tile's battery line is marked
                when a re-rank moved the array (D37 clause 3). */}
            <KpiTile
              className="col-span-1"
              label="Recommended system"
              value={heroValue}
              delta={
                !view.sized
                  ? "—"
                  : rail.kind === "reranked" && rail.batteryStale
                    ? `solar re-ranked · battery from the ${formatKw(storedFigures.solarKw)} array, not resolved`
                    : recomputed || comparing
                      ? `was ${[
                          compare?.before.solarKw != null ? formatKw(compare.before.solarKw) : null,
                          compare?.before.batteryKwh != null ? formatKwh(compare.before.batteryKwh) : null,
                        ].filter(Boolean).join(" + ") || "—"}${recomputed ? " · not saved" : " · the selected baseline"}`
                      : "latest sizing run"
              }
            />
            <KpiTile
              label={shown.basis === "solar-only" ? "Payback (solar only)" : "Payback"}
              value={
                view.sized && shown.paybackYears != null
                  ? formatYears(shown.paybackYears)
                  : "—"
              }
              delta={tileDelta("Payback", "")}
              deltaSign={tileSign("Payback", false)}
            />
            <KpiTile
              label={shown.basis === "solar-only" ? "NPV (solar only)" : "NPV"}
              value={view.sized && shown.npv != null ? formatMoney(shown.npv) : "—"}
              delta={tileDelta("NPV", "")}
              deltaSign={tileSign("NPV", true)}
            />
            {/* 3.13 prompt 4 (E): read from the SAME stored derivations the
                Results section uses — the bar showed dashes eight lines above
                a section showing 84.1%, on one screen. */}
            <KpiTile
              label={shown.basis === "solar-only" ? "Self-sufficiency (solar only)" : "Self-sufficiency"}
              value={
                view.sized && shown.selfSufficiencyPct != null
                  ? formatPct(shown.selfSufficiencyPct)
                  : "—"
              }
              delta={
                compare?.selfSufficiencyNote && comparing
                  ? compare.selfSufficiencyNote
                  : tileDelta("Self-sufficiency", "")
              }
              deltaSign={comparing ? undefined : tileSign("Self-sufficiency", true)}
            />
            {/* 3.14 prompt 3 (F205), label decided by Mayur 2026-08-21. The
                THREE cases are discriminated in lib/worksheet.ts, not here —
                a solar-only run said "—", which reads as "we could not work
                this out" when the truth is that there is no battery in this
                recommendation at all. The component renders the label it is
                given and decides nothing. */}
            {/* 3.14 prompt 8: against a historical baseline the split is NOT
                in the history read, and the current run's split must never
                sit beside a baseline as though it belonged to the comparison
                — the tile says so, in words, never a dash. */}
            <KpiTile
              label="Where the value comes from"
              value={
                !view.sized
                  ? "—"
                  : compare && !compare.splitTile.available
                    ? compare.splitTile.text
                    : view.valueOrigin.label
              }
            />
          </div>
          {/* 3.14 prompt 8: THE BASELINE CONTROL — one comparison mechanism,
              defaulting to the last run. A one-run job says why there is
              nothing to choose; a failed history says so rather than
              offering a shorter list; a partial list ADMITS it. */}
          {view.sized && baseline ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-caption text-muted-foreground" htmlFor="rail-baseline">
                Compared against
              </label>
              {picker.kind === "ready" ? (
                <select
                  id="rail-baseline"
                  value={selectedId ?? ""}
                  onChange={(e) => setSelectedId(e.target.value || null)}
                  className="rounded-md border border-border bg-card px-2 py-1 text-caption text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">the last run</option>
                  {picker.choices.map((r) => (
                    <option key={r.sizingResultId} value={r.sizingResultId}>
                      {railRunLabel({
                        sizingResultId: r.sizingResultId, createdAt: r.createdAt,
                        runKind: r.runKind, engineMode: r.engineMode,
                        dispatchResolution: r.dispatchResolution, objectiveUsed: r.objectiveUsed,
                      })}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-caption text-muted-foreground">{picker.reason}</span>
              )}
              {picker.kind === "ready" && picker.notice ? (
                <span className="text-caption text-destructive">{picker.notice}</span>
              ) : null}
            </div>
          ) : null}
          {compare && comparing && compare.comparability ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-caption text-muted-foreground">
                Current: {compare.currentLabel}
              </span>
              <span className="text-caption text-muted-foreground">
                Baseline: {compare.baselineLabel}
              </span>
              {/* The verdict. Every reason, plainly — a different engine is
                  the headline of the comparison, not a footnote (D33). */}
              {compare.comparability.comparable ? (
                <span className="text-caption text-muted-foreground">
                  {compare.comparability.headline}
                </span>
              ) : (
                compare.comparability.reasons.map((r) => (
                  <span key={r.kind} className="text-caption text-destructive">
                    {r.text}
                  </span>
                ))
              )}
            </div>
          ) : null}

          {/* 3.14 prompt 6: THE ONE LINE that says where the figures came
              from and that nothing is saved — derived per state in lib, so
              the suite holds it present on every recomputed state and
              absent on the stored one. While re-costing, the 3.13 progress
              indicator, unchanged. */}
          {rail.kind === "recosting" ? (
            <div className="flex items-center gap-2">
              <RunProgress startedAt={rail.startedAt} />
              <span className="text-caption text-muted-foreground">{statusLine}</span>
            </div>
          ) : statusLine ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  rail.kind === "failed"
                    ? "text-caption text-destructive"
                    : "text-caption text-muted-foreground"
                }
              >
                {statusLine}
              </span>
              {rail.kind === "failed" && rail.canRetry ? (
                <button
                  type="button"
                  onClick={() => void recost(rail.trigger)}
                  className="rounded-md border border-border px-2 py-0.5 text-caption text-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <PinChip>reserve —</PinChip>
            <PinChip>VPP —</PinChip>
            <PinChip>grid-charge —</PinChip>
            <span className="text-caption text-muted-foreground">
              Battery settings arrive at 4.5-4.7
            </span>
          </div>
        </div>

        {/* Chart — full width, absent when collapsed to numbers only. */}
        {collapsed ? null : (
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            {/* flex-1 + min-h-0: the ONLY element that absorbs the leftover
                height, so the bar never has empty space at any drag height. */}
            {shownCurve && view.sized ? (
              // 3.14 prompt 4: the value-versus-size curve. A run with no
              // recorded options renders ScoreCurve's own honest sentence —
              // never an empty axis and never a zero bar. 3.14 prompt 8: on a
              // re-rank this is the re-ranked view (F210).
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ScoreCurve
                  view={shownCurve}
                  rowHeight={RAIL_ROW_HEIGHT}
                  maxPlotHeight={railPlotHeight}
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-muted">
                <span className="px-4 text-center text-caption text-muted-foreground">
                  {view.sized ? "" : "Not yet sized"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Drag handle — pointer or keyboard; clamped so a worksheet strip
          always remains visible beneath the bar. */}
      {collapsed ? null : (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize results bar"
          aria-valuenow={Math.round(height)}
          aria-valuemin={RESULTS_BAR_MIN_HEIGHT}
          aria-valuemax={Math.round(maxHeight)}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerEnd}
          onPointerCancel={onHandlePointerEnd}
          onKeyDown={onHandleKeyDown}
          className="mt-1 h-1.5 cursor-row-resize touch-none rounded-full bg-border transition hover:bg-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      )}
    </section>
  );
}
