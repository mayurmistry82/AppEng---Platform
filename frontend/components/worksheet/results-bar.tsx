"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { KpiTile } from "@/components/ui/kpi-tile";
import { PinChip } from "@/components/ui/override-drawer";
import {
  RESULTS_BAR_DEFAULT_HEIGHT,
  RESULTS_BAR_MIN_HEIGHT,
  RESULTS_BAR_STORAGE_KEY,
  clampResultsBarHeight,
  parseResultsBarPreference,
  resultsBarDefaultCollapsed,
  resultsBarMaxHeight,
  type ResultsBarView,
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
 *   D3's third clause, auto-expand on the first completed run, is deliberately
 *   NOT built: nothing can produce a sizing result until 3.11/3.12, so it
 *   could not be tested. Moved to 3.14 with Mayur.
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

function fmt(value: number | null, suffix: string): string {
  return value == null ? "—" : `${value}${suffix}`;
}

export function ResultsBar({ view }: { view: ResultsBarView }) {
  // First render: the D3 default, derived purely from props so server and
  // client agree. The stored preference is applied in the effect below.
  const [collapsed, setCollapsed] = React.useState(() =>
    resultsBarDefaultCollapsed(view),
  );
  const [height, setHeight] = React.useState(RESULTS_BAR_DEFAULT_HEIGHT);
  const [maxHeight, setMaxHeight] = React.useState(RESULTS_BAR_DEFAULT_HEIGHT);
  const barRef = React.useRef<HTMLElement | null>(null);
  const drag = React.useRef<{ startY: number; startHeight: number } | null>(null);

  /** Where the bar starts, and how tall it may be right now. */
  const measure = React.useCallback(() => {
    // An unattached ref yields 0 — clamped, never NaN and never negative.
    const barTop = barRef.current?.getBoundingClientRect().top ?? 0;
    const viewportHeight =
      typeof window === "undefined" ? 0 : window.innerHeight;
    return { barTop, viewportHeight };
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
    const { barTop, viewportHeight } = measure();
    setMaxHeight(resultsBarMaxHeight(viewportHeight, barTop));

    let stored: { collapsed: boolean; height: number } | null = null;
    try {
      stored = parseResultsBarPreference(
        window.localStorage.getItem(RESULTS_BAR_STORAGE_KEY),
      );
    } catch {
      stored = null;
    }
    if (stored) setCollapsed(stored.collapsed);
    setHeight(
      clampResultsBarHeight(
        stored ? stored.height : RESULTS_BAR_DEFAULT_HEIGHT,
        viewportHeight,
        barTop,
      ),
    );
  }, [measure]);

  // A shorter window lowers the ceiling; the current height follows it down so
  // the worksheet strip stays visible.
  React.useEffect(() => {
    function onResize() {
      const { barTop, viewportHeight } = measure();
      setMaxHeight(resultsBarMaxHeight(viewportHeight, barTop));
      setHeight((current) =>
        clampResultsBarHeight(current, viewportHeight, barTop),
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    persist({ collapsed: next, height });
  }

  function applyHeight(desired: number): number {
    const { barTop, viewportHeight } = measure();
    const clamped = clampResultsBarHeight(desired, viewportHeight, barTop);
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
    // Write only once the value has settled.
    if (wasDragging) persist({ collapsed, height });
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
    persist({ collapsed, height: applyHeight(desired) });
  }

  const heroValue = view.sized
    ? [
        view.solarKw != null ? `${view.solarKw} kW` : null,
        view.batteryKwh != null ? `${view.batteryKwh} kWh` : null,
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

      <div
        className={collapsed ? "" : "flex min-h-0 flex-col gap-2"}
        style={collapsed ? undefined : { height }}
      >
        {/* Metrics — full width. Keeps its own scrollbar only if it genuinely
            overflows at the minimum height; it never takes the leftover space
            (no flex-1 here — the chart below gets that). */}
        <div className="flex shrink-0 flex-col gap-2 overflow-y-auto">
          <div className="grid grid-cols-5 gap-2">
            <KpiTile
              className="col-span-1"
              label="Recommended system"
              value={heroValue}
              delta={view.sized ? "latest sizing run" : "—"}
            />
            <KpiTile
              label="Payback"
              value={view.sized ? fmt(view.paybackYears, " yr") : "—"}
            />
            <KpiTile
              label="NPV"
              value={view.sized && view.npv != null ? `$${view.npv}` : "—"}
            />
            {/* Self-sufficiency and split solar ROI are produced at 3.12/3.13 —
                no field carries them yet, so they are em-dashes even when sized. */}
            <KpiTile label="Self-sufficiency" value="—" />
            <KpiTile label="Solar ROI" value="—" />
          </div>
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
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-muted">
              <span className="px-4 text-center text-caption text-muted-foreground">
                {view.sized
                  ? "Chart arrives with battery sizing (3.12)"
                  : "Results appear after the first sizing run (3.11-3.12)"}
              </span>
            </div>
            <div className="flex shrink-0 items-center justify-between">
              <button
                type="button"
                disabled
                title="Metric selection arrives with the real chart (3.12)"
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-caption text-text-disabled"
              >
                Metric
                <ChevronDown aria-hidden="true" className="h-3 w-3" />
              </button>
              <span className="text-caption text-muted-foreground">
                dashed = baseline (A) · solid = current (B) · auto-recomputes on edit
              </span>
            </div>
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
