"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { ChartContainer, useChartDefaults } from "@/components/charts/chart-container";
import {
  formatAxisTick,
  scoreCurveAxisSpace,
  truncateLabel,
  type ScoreCurveView,
} from "@/lib/worksheet";

/**
 * The option comparison chart (3.13 prompt 4b, rebuilt as bars at 4d) — on the
 * Results tab ONLY. The worksheet route stays chart-free (F47).
 *
 * BARS, NOT A LINE, and no line mark appears anywhere in this file. The
 * options are discrete PRODUCTS: the live fixture holds two different
 * batteries at 12.8 kWh with very different answers, so a connecting line
 * joined two unrelated products and implied a continuous relationship between
 * capacity and value. There is no 13.1 kWh battery to buy.
 *
 * THE DO-NOTHING OPTION IS THE REFERENCE LINE, NOT A BAR — its value is zero
 * by construction on a delta measure, and a zero-height bar is invisible and
 * says nothing. Every bar therefore reads as better or worse than doing
 * nothing.
 *
 * HORIZONTAL: product names are long ("Sigenergy SigenStor Sigen Battery
 * 8.0") and would collide as vertical tick labels. Laid on their side they
 * have room, and better/worse reads left/right of the reference line.
 *
 * EMPHASIS, NOT A PALETTE: the chosen option in the accent role, every other
 * option recessive — two roles instead of seven distinguishable colours.
 *
 * THE AXIS WIDTH AND THE TOP SPACE ARE DERIVED FROM THE LABELS (4e), in lib,
 * where the suite can assert on them — a hardcoded 172px sliced "Sigenergy
 * SigenStor Sigen Battery 8.0" down to "gy SigenStor Sigen Battery 8.0" on
 * screen, and no static render can catch that because the chart sizes itself
 * from an effect. There is no hardcoded pixel margin for either here.
 *
 * COLOURS come from useChartDefaults' roles AS RETURNED — already wrapped as
 * `hsl(...)`. Wrapping again yields `hsl(hsl(...))`, which SVG renders BLACK;
 * that fault shipped for a whole build cycle in August, so this file contains
 * no `hsl(` literal at all and the suite asserts on the RENDERED attribute.
 */

/** Row height per bar, plus room for the axis and its title. */
const ROW_H = 44;
const CHART_CHROME = 72;

/**
 * The two-line category tick: the product on top, its capacity beneath.
 * Rendered as SVG tspans because a recharts tick is inside the <svg>.
 */
function ProductTick({
  x,
  y,
  payload,
  bars,
  maxChars,
  axisFill,
  textFill,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
  bars: ScoreCurveView["bars"];
  maxChars: number;
  axisFill: string;
  textFill: string;
}) {
  // The category value IS the full label, so the tooltip shows the whole
  // product name even when the tick has to shorten it.
  const full = String(payload?.value ?? "");
  const bar = (bars ?? []).find((b) => b.label === full);
  if (!bar) return null;
  return (
    <text x={x} y={y} textAnchor="end" dominantBaseline="middle">
      <tspan x={x} dy={bar.subLabel ? "-0.35em" : "0"} fontSize={12} fill={textFill}>
        {truncateLabel(bar.label, maxChars)}
      </tspan>
      {bar.subLabel ? (
        <tspan x={x} dy="1.2em" fontSize={11} fill={axisFill}>
          {bar.subLabel}
        </tspan>
      ) : null}
    </text>
  );
}

/**
 * The chart subtree, exported separately so a render probe can mount it with
 * EXPLICIT dimensions — recharts v3 dispatches its chart size from a
 * useEffect (chartLayoutContext.js), so no static render emits the SVG.
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
  if (!view.bars) return null;
  // Derived from the labels, never a guessed margin (4e).
  const space = scoreCurveAxisSpace(view.bars, view.baseline?.label ?? null);
  const ticks = view.ticks ?? undefined;
  const domain: [number, number] | undefined =
    ticks && ticks.length > 1 ? [ticks[0], ticks[ticks.length - 1]] : undefined;
  const baseValue =
    view.baseline && Number.isFinite(view.baseline.value)
      ? view.baseline.value
      : null;

  return (
    <BarChart
      layout="vertical"
      data={view.bars}
      width={width}
      height={height}
      // top: room for the reference-line label, derived. bottom: room for the
      // tick labels AND the axis title beneath them (set at 4d, unchanged).
      margin={{ top: space.topSpace, right: 24, bottom: 28, left: 8 }}
      barCategoryGap="22%"
    >
      <CartesianGrid {...d.grid} horizontal={false} vertical />
      <XAxis
        {...d.axis}
        type="number"
        domain={domain}
        ticks={ticks}
        tickFormatter={(v: number) => formatAxisTick(v, view.unit)}
        label={{
          value: view.valueLabel,
          position: "insideBottom",
          // Clear of the tick labels — they collided before 4d.
          offset: -18,
          fill: d.tokens["chart-axis"],
          fontSize: 12,
        }}
      />
      <YAxis
        {...d.axis}
        type="category"
        dataKey="label"
        width={space.axisWidth}
        tick={
          <ProductTick
            bars={view.bars}
            maxChars={space.maxChars}
            axisFill={d.tokens["chart-axis"]}
            textFill={d.tokens["chart-axis"]}
          />
        }
      />
      <Tooltip
        {...d.tooltip}
        // 3.13 prompt 4f: THE HOVER BAND, in the same token the table hovers a
        // row with. d.tooltip's cursor carries only a stroke, so without a
        // fill the cursor rectangle painted with recharts' own default and
        // the hovered bar read near-white. recharts draws the cursor BENEATH
        // the bars, which is exactly the band-behind the table does.
        cursor={{ fill: d.byRole.hoverSurface }}
      />
      {baseValue !== null ? (
        <ReferenceLine
          x={baseValue}
          stroke={d.tokens["chart-baseline"]}
          strokeDasharray="4 4"
          label={{
            value: view.baseline?.label ?? "",
            position: "top",
            fill: d.tokens["chart-axis"],
            fontSize: 11,
          }}
        />
      ) : null}
      {/* activeBar={false} is recharts' current default, stated EXPLICITLY so
          the guarantee is ours and not a library default that may change: the
          bar keeps its own fill when hovered — the chosen option stays amber,
          a recessive one stays recessive. Only the band behind it changes. */}
      <Bar
        dataKey="value"
        name={view.valueLabel}
        isAnimationActive={false}
        activeBar={false}
      >
        {view.bars.map((bar) => (
          <Cell
            key={bar.key}
            fill={bar.chosen ? d.byRole.chosenEmphasis : d.byRole.alternative}
          />
        ))}
      </Bar>
    </BarChart>
  );
}

export function ScoreCurve({ view }: { view: ScoreCurveView }) {
  if (!view.bars) {
    return <p className="text-caption text-muted-foreground">{view.note}</p>;
  }
  const chosen = view.bars.find((b) => b.chosen) ?? null;
  const unnamed = view.bars.filter((b) => b.labelNote !== null);
  return (
    <div className="flex flex-col gap-1">
      <ChartContainer height={Math.max(200, view.bars.length * ROW_H + CHART_CHROME)}>
        <ScoreCurveChart view={view} />
      </ChartContainer>
      <p className="text-caption text-muted-foreground">
        Scored for {view.objectiveLabel ?? "the measure recorded with the run"}
        {chosen ? `; ${chosen.label} was chosen.` : "."}
      </p>
      {view.baselineNote ? (
        <p className="text-caption text-muted-foreground">{view.baselineNote}</p>
      ) : null}
      {view.chosenNote ? (
        <p className="text-caption text-muted-foreground">{view.chosenNote}</p>
      ) : null}
      {unnamed.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          {unnamed.length === 1
            ? "One option shows its capacity only — "
            : `${unnamed.length} options show their capacity only — `}
          the product was not recorded with this run.
        </p>
      ) : null}
      {view.flatNote ? (
        <p className="text-caption text-muted-foreground">{view.flatNote}</p>
      ) : null}
    </div>
  );
}
