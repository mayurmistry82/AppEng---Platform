"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Config, Data, Layout } from "plotly.js";
import type { PlotParams } from "react-plotly.js";
import { cn } from "@/lib/utils";
import { useChartTokens } from "@/lib/chart-tokens";

/**
 * PLOTLY IS RESERVED FOR EXACTLY TWO CHART TYPES:
 *   1. the 8,760-hour interval series
 *   2. the 7x24 day-by-hour heatmap
 * Nothing else. recharts is the standard for every other chart — see
 * components/charts/chart-container.tsx. If you are reaching for this wrapper for
 * a third kind of chart, use recharts instead.
 *
 * WHY THE DYNAMIC IMPORT MATTERS: plotly.js is roughly 3 MB. A static top-level
 * import puts it in the shared chunk, so EVERY page pays for it — including the
 * login screen, which renders no chart at all. `next/dynamic` with ssr:false keeps
 * it in its own lazily-fetched chunk, loaded only when a Plotly chart actually
 * mounts. Do not convert this to a static import.
 *
 * Themed from lib/chart-tokens (the same source recharts uses), NOT from the
 * legacy lib/plotly-theme.ts, which carries hardcoded hex and retires at 3.16.
 */

/** Shown while the ~3 MB chunk is in flight. */
function ChartLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center text-caption text-muted-foreground">
      Loading chart…
    </div>
  );
}

/**
 * Shown if the chunk fails to load (offline, blocked, chunk 404 after a deploy).
 * Quiet and explanatory — never a blank box and never a crash.
 */
function ChartUnavailable() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-card px-4 py-6 text-center text-caption text-muted-foreground">
      This chart could not be loaded. Reload the page to try again.
    </div>
  );
}

/**
 * The lazy boundary. Typed with react-plotly.js's own PlotParams so the props
 * line up exactly. `.catch` resolves to the unavailable notice, so a failed chunk
 * degrades quietly instead of throwing inside React's lazy machinery.
 */
const Plot = dynamic<PlotParams>(
  () =>
    import("react-plotly.js")
      .then((mod) => mod.default)
      .catch(() => ChartUnavailable),
  { ssr: false, loading: () => <ChartLoading /> },
);

export interface PlotlyChartProps {
  data: Data[];
  /** Merged over the themed defaults. */
  layout?: Partial<Layout>;
  config?: Partial<Config>;
  height?: number;
  className?: string;
}

/**
 * Themed Plotly wrapper. Colours come from the live chart tokens, so it follows
 * the app theme exactly as the recharts baseline does.
 */
export function PlotlyChart({
  data,
  layout,
  config,
  height = 320,
  className,
}: PlotlyChartProps) {
  const tokens = useChartTokens();

  const themedLayout: Partial<Layout> = React.useMemo(
    () => ({
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: tokens["chart-axis"], size: 12 },
      xaxis: {
        gridcolor: tokens["chart-grid"],
        linecolor: tokens["chart-grid"],
        zerolinecolor: tokens["chart-grid"],
        tickfont: { color: tokens["chart-axis"], size: 11 },
        automargin: true,
      },
      yaxis: {
        gridcolor: tokens["chart-grid"],
        linecolor: tokens["chart-grid"],
        zerolinecolor: tokens["chart-grid"],
        tickfont: { color: tokens["chart-axis"], size: 11 },
        automargin: true,
      },
      colorway: [
        tokens["chart-1"],
        tokens["chart-2"],
        tokens["chart-3"],
        tokens["chart-4"],
        tokens["chart-5"],
      ],
      margin: { t: 16, r: 16, b: 40, l: 52 },
      showlegend: false,
      ...layout,
    }),
    [tokens, layout],
  );

  const themedConfig: Partial<Config> = React.useMemo(
    () => ({ displaylogo: false, responsive: true, ...config }),
    [config],
  );

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <Plot
        data={data}
        layout={themedLayout}
        config={themedConfig}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
