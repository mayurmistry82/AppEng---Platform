"use client";

import * as React from "react";
import { useChartTokens } from "@/lib/chart-tokens";
import { NoticeCaption } from "@/components/ui/notice-caption";
import type { LoadPreviewView } from "@/lib/worksheet";

/**
 * Load preview strip (3.6 prompt 3) — a GLANCE at the shape of the day the
 * profile produced. 24 hand-drawn SVG <rect>s; no chart library (a charting
 * dependency on the worksheet route costs ~115 kB First Load, F47), no
 * tooltip, no interaction, no axis. The real analytics live on the Load
 * insight tab (5.2).
 *
 * Presentational ONLY: every decision — bar heights, flatness, the peak window
 * or its absence — was made by loadPreviewView in lib/worksheet.ts. The
 * flat-profile case matters most: Tier 1's weights are [1.0] x 24 and naming a
 * "peak" on that would be a confident fabrication, so a flat view arrives with
 * peak null and this component prints the words for that instead.
 *
 * Colours come from the existing chart tokens via useChartTokens — never a
 * hardcoded colour, never the legacy store's chartMode. aria-label states the
 * shape IN WORDS: a picture that is meaningless to a screen reader is not
 * accessible, and meaning must survive greyscale.
 */

const BAR_W = 8;
const GAP = 2;
const HEIGHT = 40;
const WIDTH = 24 * BAR_W + 23 * GAP;
/** Even a zero hour draws a sliver — an empty column reads as missing data. */
const MIN_BAR = 2;

export function LoadPreviewStrip({ view }: { view: LoadPreviewView }) {
  const tokens = useChartTokens();
  if (!view.ok || view.bars.length !== 24) return null;

  const fill = `hsl(${tokens["chart-2"]})`;
  const peakFill = `hsl(${tokens["chart-1"]})`;
  const inPeak = (hour: number): boolean =>
    view.peak !== null && hour >= view.peak.startHour && hour <= view.peak.endHour;

  return (
    <div className="flex flex-col gap-1">
      <svg
        role="img"
        aria-label={view.ariaLabel}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-10 w-full max-w-[320px]"
        preserveAspectRatio="none"
      >
        {view.bars.map((height, hour) => {
          const barHeight = Math.max(MIN_BAR, height * HEIGHT);
          return (
            <rect
              key={hour}
              x={hour * (BAR_W + GAP)}
              y={HEIGHT - barHeight}
              width={BAR_W}
              height={barHeight}
              rx={1}
              fill={inPeak(hour) ? peakFill : fill}
              fillOpacity={inPeak(hour) ? 1 : 0.55}
            />
          );
        })}
      </svg>
      {view.flat ? (
        <NoticeCaption>
          No daily shape — this is a national-average estimate.
        </NoticeCaption>
      ) : view.peak ? (
        <p className="text-caption text-muted-foreground">
          {view.peak.startHour >= 17 ? "Evening peak" : "Peak use"},{" "}
          {view.peak.label}
        </p>
      ) : null}
      <p className="text-caption text-muted-foreground">
        The full picture is on the Load insight tab.
      </p>
    </div>
  );
}
