"use client";

import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { chartSeries, chartSeriesByRole, useChartTokens } from "@/lib/chart-tokens";

/**
 * The recharts baseline — the house chart standard for every NEW chart.
 *
 * Charts get their colours from the CSS chart tokens via useChartTokens(), so they
 * follow the app theme automatically with no reload and no per-chart wiring. New
 * charts must NOT read `chartMode` from the store — that belongs to the four legacy
 * panels and retires at 3.16.
 *
 * The defaults below exist so no individual chart re-specifies them:
 *   grid      `chart-grid`, horizontal only (no vertical rules)
 *   axes      ticks in `chart-axis` at the `caption` role, no axis line, no tick line
 *   tooltip   `popover` surface, 1px `border`, rounded md, elev-2, `caption` type
 *   series    chart-1..5 in DESIGN.md order — do not reassign
 *   baseline  `chart-baseline`, DASHED. This is the one deliberately dashed thing in
 *             the system: it marks the A/B comparison overlay.
 * Numbers in axes and tooltips use tabular figures so digits do not jiggle on a
 * live A/B recompute.
 */

const TABULAR: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums slashed-zero",
};

/** Matches the `caption` type role (12px / 16px / 500). */
const CAPTION_SIZE = 12;

export interface ChartContainerProps {
  children: React.ReactElement;
  /** Fixed pixel height; the chart fills its container's width. */
  height?: number;
  className?: string;
}

/** Responsive wrapper. Give it a height; width comes from the parent. */
export function ChartContainer({
  children,
  height = 260,
  className,
}: ChartContainerProps) {
  return (
    <div className={cn("w-full", className)} style={TABULAR}>
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Tooltip body. Rendered as HTML (not SVG), so it binds to Tailwind semantic
 * classes directly and re-themes with the rest of the app for free.
 */
export interface ChartTooltipPayloadItem {
  name?: string | number;
  value?: string | number;
  color?: string;
  dataKey?: string | number;
}

export interface ChartTooltipContentProps {
  active?: boolean;
  payload?: ChartTooltipPayloadItem[];
  label?: string | number;
  /** Appended after each value, e.g. " kWh". */
  unit?: string;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  unit,
}: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-caption text-popover-foreground shadow-elev-2">
      {label != null ? (
        <p className="mb-1 font-medium text-foreground">{label}</p>
      ) : null}
      <ul className="space-y-0.5">
        {payload.map((item, i) => (
          <li key={`${item.dataKey ?? item.name ?? i}`} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-muted-foreground">{item.name}</span>
            <span className="ml-auto tabular-nums text-foreground" style={TABULAR}>
              {item.value}
              {unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The house defaults, resolved for the current theme. Spread these onto the
 * matching recharts elements:
 *
 *   <CartesianGrid {...d.grid} />
 *   <XAxis dataKey="x" {...d.axis} />
 *   <YAxis {...d.axis} />
 *   <Tooltip {...d.tooltip} />
 *   <Line dataKey="a" stroke={d.series[0]} {...d.line} />
 *   <ReferenceLine y={42} {...d.baseline} />
 */
export function useChartDefaults() {
  const tokens = useChartTokens();
  const series = chartSeries(tokens);

  return {
    tokens,
    series,
    byRole: chartSeriesByRole(tokens),

    grid: {
      stroke: tokens["chart-grid"],
      strokeDasharray: "0",
      vertical: false,
    },

    axis: {
      stroke: tokens["chart-axis"],
      tick: {
        fill: tokens["chart-axis"],
        fontSize: CAPTION_SIZE,
        style: TABULAR,
      },
      tickLine: false,
      axisLine: false,
    },

    tooltip: {
      // Strip recharts' default white box; ChartTooltipContent draws the surface.
      cursor: { stroke: tokens["chart-grid"] },
      content: <ChartTooltipContent />,
    },

    /** Default line styling — series colour is passed per-series. */
    line: {
      strokeWidth: 2,
      dot: false,
      activeDot: { r: 3 },
    },

    /**
     * A/B comparison overlay. Dashed on purpose — the single sanctioned dashed
     * treatment in the system.
     */
    baseline: {
      stroke: tokens["chart-baseline"],
      strokeDasharray: "4 4",
      strokeWidth: 1.5,
    },
  };
}
