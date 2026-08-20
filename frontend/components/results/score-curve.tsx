"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { ChartContainer, useChartDefaults } from "@/components/charts/chart-container";
import type { ScoreCurveView } from "@/lib/worksheet";

/**
 * ScoreCurve (checklist 3.13 prompt 4b) — the LP score curve, on the Results
 * tab ONLY. The worksheet route stays chart-free (F47: a chart library costs
 * ~115 kB First Load, and the tab is the one route that pays it).
 *
 * The vertical axis is the figure the job's OWN objective was scored on —
 * never a metric the run was not optimising presented as the score. The
 * domain spans the REAL data range (including the no-system point), so a
 * $28 spread between the top options renders as the near-flat line it is —
 * zooming into it would manufacture a cliff, and the accuracy positioning
 * applies to pictures too. When the spread is trivial, view.flatNote says so
 * in words beside the chart.
 *
 * COLOURS: chart tokens AS RETURNED by useChartDefaults — they arrive
 * already wrapped as `hsl(...)` (chart-tokens' own docstring). Wrapping them
 * again produces `hsl(hsl(...))`, which SVG silently renders BLACK; that
 * fault shipped for a build cycle in August, and the render test asserts on
 * the attribute string that actually lands in the SVG.
 */
/**
 * The chart subtree, exported separately so the render test can mount it with
 * EXPLICIT dimensions (recharts' ResponsiveContainer measures the DOM and
 * emits nothing under server rendering, so the test hands LineChart a fixed
 * width/height and asserts on the stroke attributes that actually land in
 * the SVG — the August all-black fault is only visible there).
 */
export function ScoreCurveChart({
  view,
  width,
  height,
}: {
  view: ScoreCurveView;
  width?: number;
  height?: number;
}) {
  const d = useChartDefaults();
  if (!view.points) return null;
  const ys = view.points.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const pad = (max - min || Math.abs(max) || 1) * 0.05;
  const chosen =
    view.chosenX !== null
      ? (view.points.find((p) => p.x === view.chosenX) ?? null)
      : null;
  return (
    <LineChart
      data={view.points}
      width={width}
      height={height}
      margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
    >
      <CartesianGrid {...d.grid} />
      <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            label={{
              value: view.xLabel,
              position: "insideBottom",
              offset: -2,
              fill: d.tokens["chart-axis"],
              fontSize: 12,
            }}
            {...d.axis}
          />
          <YAxis
            domain={[min - pad, max + pad]}
            width={72}
            label={{
              value: view.yLabel,
              angle: -90,
              position: "insideLeft",
              fill: d.tokens["chart-axis"],
              fontSize: 12,
            }}
            {...d.axis}
          />
          <Tooltip {...d.tooltip} />
          <Line
            dataKey="y"
            name={view.yLabel}
            stroke={d.series[0]}
            {...d.line}
            dot={{ r: 2, fill: d.series[0], stroke: d.series[0] }}
          />
      {chosen ? (
        <ReferenceDot
          x={chosen.x}
          y={chosen.y}
          r={5}
          fill={d.series[1]}
          stroke={d.series[1]}
        />
      ) : null}
    </LineChart>
  );
}

export function ScoreCurve({ view }: { view: ScoreCurveView }) {
  if (!view.points) {
    return <p className="text-caption text-muted-foreground">{view.note}</p>;
  }
  const chosen =
    view.chosenX !== null
      ? (view.points.find((p) => p.x === view.chosenX) ?? null)
      : null;
  return (
    <div className="flex flex-col gap-1">
      <ChartContainer height={260}>
        <ScoreCurveChart view={view} />
      </ChartContainer>
      <p className="text-caption text-muted-foreground">
        Scored for {view.objectiveLabel}
        {chosen ? "; the marked point is the chosen option." : "."}
      </p>
      {view.chosenNote ? (
        <p className="text-caption text-muted-foreground">{view.chosenNote}</p>
      ) : null}
      {view.flatNote ? (
        <p className="text-caption text-muted-foreground">{view.flatNote}</p>
      ) : null}
    </div>
  );
}
