"use client";

import * as React from "react";
import { CHART_TOKENS_DARK_FALLBACK, useChartTokens } from "@/lib/chart-tokens";
import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import type { LoadPreviewView } from "@/lib/worksheet";

/**
 * The average-day chart (3.6b, under D27) — 24 hand-drawn SVG bars, one per
 * hour. No chart library: a charting dependency on the worksheet route costs
 * roughly 115 kB First Load (F47), and this needs none of it.
 *
 * WHY BARS: hourly energy is additive and bucketed, so a bar per hour is
 * literally what the data is. A line would imply a continuous reading between
 * hours, which is not what a meter gives us.
 *
 * ONE SERIES, SO ONE HUE AND NO LEGEND. An earlier version used chart-2 for
 * ordinary hours and chart-1 for the peak, which paints a single series as two
 * identities; the version after that reduced the non-peak bars' opacity, which
 * could not clear 3:1 contrast at any visible difference. Now every bar renders
 * at full strength in one hue and the peak run is marked by a rule beneath it —
 * and the peak is ALSO named in words beside the chart, so nothing depends on
 * colour alone.
 *
 * OPEN BY DEFAULT, NO NESTED COLLAPSE (D27.1): the section already collapses,
 * and a fold inside a fold buys nothing. Drawing costs nothing, unlike the
 * satellite tile, whose open/closed gate exists because each open is a
 * BILLABLE Google fetch — that reason does not transfer here.
 *
 * Presentational only: bar heights, flatness, the peak window or its absence,
 * the kWh reconstruction and the tier-aware flat message were all decided by
 * loadPreviewView in lib/worksheet.ts.
 */

const BAR_W = 16;
const GAP = 4;
const CHART_H = 120; // the readable height — 40px was why it read as a smudge
const LABEL_H = 24; // room for the peak rule between the baseline and the labels
const WIDTH = 24 * BAR_W + 23 * GAP; // 476
const HEIGHT = CHART_H + LABEL_H;
/** Even a zero hour draws a sliver — an empty column reads as missing data. */
const MIN_BAR = 2;
/**
 * THE PEAK IS MARKED BY A RULE, NOT BY OPACITY — and that is settled, not a
 * style preference. The bars ARE the content, so they need 3:1 against `card`;
 * measured, 0.45 opacity gives 1.70:1 light and 1.99:1 dark (failing) and 0.90
 * is the first step that clears it. The widest LEGAL gap is therefore 1.0
 * against 0.9 — about a tenth, invisible. Opacity cannot carry this
 * distinction at an accessible contrast, so it is not asked to: every bar
 * renders at full strength in one hue, and the peak run gets a thin rule
 * beneath it. That reads in greyscale, survives forced-colours mode, and does
 * not paint one series as two identities. The words beside the chart remain
 * the primary encoding; the rule is their visual echo.
 */
const MARKER_H = 2.5;
const MARKER_GAP = 4;
/** Only these hours are labelled; a label per hour is noise at this size. */
const AXIS_HOURS = [0, 6, 12, 18, 23];

function hourText(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export function LoadPreviewStrip({ view }: { view: LoadPreviewView }) {
  const tokens = useChartTokens();
  if (!view.ok || view.bars.length !== 24) return null;

  // useChartTokens ALREADY returns usable CSS colour strings — readChartTokens
  // wraps every value in hsl(...) on both the runtime and the fallback path.
  // Wrapping again produced `hsl(hsl(210 70.9% 54.1%))`, which is not a colour,
  // so SVG discarded it and painted the bars BLACK. Use the values as they come.
  // The `|| fallback` is the general form of that bug in one line: an empty
  // token must never become an invalid attribute.
  const fill = tokens["chart-2"] || CHART_TOKENS_DARK_FALLBACK["chart-2"];
  // The baseline is a graphical object, so 3:1 suffices and chart-axis clears it.
  const axisLine = tokens["chart-axis"] || CHART_TOKENS_DARK_FALLBACK["chart-axis"];
  // DELIBERATELY DIFFERENT from the two lines above, and not a bug to "fix":
  // text-secondary is NOT one of the ten chart tokens, so the hook cannot hand
  // it over and `hsl(var(--...))` is the only way to reach it from an
  // attribute. It is used because the 11px hour labels are TEXT needing 4.5:1,
  // which chart-axis (4.46 light / 4.31 dark) marginally misses.
  const axisText = "hsl(var(--text-secondary))";
  const inPeak = (hour: number): boolean =>
    view.peak !== null && hour >= view.peak.startHour && hour <= view.peak.endHour;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        {/* The single kWh maximum — one axis, never two scales. Omitted
            entirely when the units assumption did not hold. */}
        {view.unitsOk && view.maxKwh !== null ? (
          <span className="text-caption text-muted-foreground">
            {view.maxKwh.toLocaleString("en-AU", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })}{" "}
            kWh max
          </span>
        ) : (
          <span />
        )}
        {view.peak ? (
          <span className="text-caption text-muted-foreground">
            {view.peak.startHour >= 17 ? "Evening peak" : "Peak use"},{" "}
            {view.peak.label}
          </span>
        ) : null}
      </div>

      <svg
        role="img"
        aria-label={view.ariaLabel}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full max-w-[520px]"
      >
        {view.bars.map((height, hour) => {
          const barHeight = Math.max(MIN_BAR, height * CHART_H);
          const kwh = view.kwhPerHour?.[hour];
          // A native <title> — a hover for a sighted user and a real reading
          // for assistive tech, with no tooltip machinery and no JavaScript.
          const title =
            typeof kwh === "number"
              ? `${hourText(hour)} — ${kwh.toLocaleString("en-AU", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })} kWh`
              : hourText(hour);
          return (
            <rect
              key={hour}
              x={hour * (BAR_W + GAP)}
              y={CHART_H - barHeight}
              width={BAR_W}
              height={barHeight}
              rx={2}
              fill={fill}
            >
              <title>{title}</title>
            </rect>
          );
        })}
        {/* Recessive baseline, no gridlines. */}
        <line
          x1={0}
          y1={CHART_H + 0.5}
          x2={WIDTH}
          y2={CHART_H + 0.5}
          stroke={axisLine}
          strokeWidth={1}
        />
        {/* The peak marker: a bracket under the run, in the SAME hue. */}
        {view.peak ? (
          <rect
            x={view.peak.startHour * (BAR_W + GAP)}
            y={CHART_H + MARKER_GAP}
            width={
              (view.peak.endHour - view.peak.startHour) * (BAR_W + GAP) + BAR_W
            }
            height={MARKER_H}
            rx={MARKER_H / 2}
            fill={fill}
          >
            <title>{`Peak use, ${view.peak.label}`}</title>
          </rect>
        ) : null}
        {AXIS_HOURS.map((hour) => (
          <text
            key={hour}
            x={hour * (BAR_W + GAP) + BAR_W / 2}
            y={CHART_H + LABEL_H - 2}
            textAnchor={hour === 0 ? "start" : hour === 23 ? "end" : "middle"}
            fill={axisText}
            fontSize={11}
          >
            {hour}
          </text>
        ))}
      </svg>

      {/* NEVER "a typical day" (D27.2): this is the mean of every day in the
          file, and a house with a fierce summer peak reads tame once averaged
          against two hundred mild days. */}
      <p className="text-caption text-muted-foreground">
        An average day, across the year — every day in the file averaged together.
      </p>

      {view.flatMessage ? (
        view.flatMessage.level === "notice" ? (
          <Notice tone={view.flatMessage.tone} title={view.flatMessage.title}>
            {view.flatMessage.body}
          </Notice>
        ) : (
          <NoticeCaption icon={view.flatMessage.icon ?? "info"}>
            {view.flatMessage.body}
          </NoticeCaption>
        )
      ) : null}

      {/* The pointer (D27): a method fact, true of every job — a quiet caption. */}
      <NoticeCaption>
        The full picture, season by season and weekday against weekend, is on the
        Load insight tab.
      </NoticeCaption>
    </div>
  );
}
