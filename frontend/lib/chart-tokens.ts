"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/**
 * chart-tokens — resolves the ten CSS chart tokens to real colour values.
 *
 * WHY THIS EXISTS: recharts needs concrete colour values for most props (stroke,
 * fill), not the string "hsl(var(--chart-1))" — an SVG attribute will not resolve
 * a custom property. So we read the computed custom properties off
 * <html> at runtime and hand back usable CSS colour strings.
 *
 * TWO THINGS THAT ARE EASY TO GET WRONG, both handled here:
 *
 *  1. RE-READS ON THEME CHANGE. Reading once and memoising forever freezes every
 *     chart in whichever mode happened to load first — and it looks perfectly fine
 *     until someone flips the toggle. `useChartTokens` subscribes to next-themes'
 *     resolvedTheme and recomputes whenever it changes.
 *
 *  2. SSR-SAFE. `getComputedStyle` does not exist on the server, and the first
 *     client render happens before the effect runs. Both paths return the DARK
 *     values (dark is the app's defaultTheme) rather than undefined, so a chart is
 *     never rendered colourless or transparent.
 *
 * NOTE ON THE FALLBACK MAP BELOW: it duplicates the dark-mode values from
 * globals.css. It deliberately stores the SAME space-separated HSL triplet format
 * the CSS variables use (not hex), so the fallback and the runtime-read path
 * produce byte-identical strings through the same `hsl(...)` wrapper — and so this
 * file contains no hardcoded hex at all.
 *
 * New charts read these tokens. They must NOT read `chartMode` from the Zustand
 * store — that field belongs to the four legacy panels and is retired at 3.16.
 */

export const CHART_TOKEN_NAMES = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-grid",
  "chart-axis",
  "chart-baseline",
  "delta-positive",
  "delta-negative",
] as const;

export type ChartTokenName = (typeof CHART_TOKEN_NAMES)[number];
export type ChartTokens = Record<ChartTokenName, string>;

/** Dark-mode HSL triplets, mirroring the `.dark` block in app/globals.css. */
const DARK_FALLBACK_TRIPLETS: ChartTokens = {
  "chart-1": "39.1 100% 57.8%",
  "chart-2": "210 70.9% 54.1%",
  "chart-3": "16 100% 60.4%",
  "chart-4": "156.5 60.9% 46.1%",
  "chart-5": "358 75% 59%",
  "chart-grid": "222 39% 18%",
  "chart-axis": "220 20% 53%",
  "chart-baseline": "220 20% 53%",
  "delta-positive": "156.5 60.9% 46.1%",
  "delta-negative": "358 75% 59%",
};

function wrap(triplet: string): string {
  return `hsl(${triplet})`;
}

const DARK_FALLBACK: ChartTokens = {
  "chart-1": wrap(DARK_FALLBACK_TRIPLETS["chart-1"]),
  "chart-2": wrap(DARK_FALLBACK_TRIPLETS["chart-2"]),
  "chart-3": wrap(DARK_FALLBACK_TRIPLETS["chart-3"]),
  "chart-4": wrap(DARK_FALLBACK_TRIPLETS["chart-4"]),
  "chart-5": wrap(DARK_FALLBACK_TRIPLETS["chart-5"]),
  "chart-grid": wrap(DARK_FALLBACK_TRIPLETS["chart-grid"]),
  "chart-axis": wrap(DARK_FALLBACK_TRIPLETS["chart-axis"]),
  "chart-baseline": wrap(DARK_FALLBACK_TRIPLETS["chart-baseline"]),
  "delta-positive": wrap(DARK_FALLBACK_TRIPLETS["delta-positive"]),
  "delta-negative": wrap(DARK_FALLBACK_TRIPLETS["delta-negative"]),
};

/**
 * Read the live values off <html>. Per-token fallback: a variable that cannot be
 * read falls back to its dark value rather than producing an empty string, which
 * SVG would treat as no colour at all.
 */
function readChartTokens(): ChartTokens {
  if (typeof document === "undefined") return DARK_FALLBACK;

  const computed = getComputedStyle(document.documentElement);
  const read = (name: ChartTokenName): string => {
    const raw = computed.getPropertyValue(`--${name}`).trim();
    return raw ? wrap(raw) : DARK_FALLBACK[name];
  };

  return {
    "chart-1": read("chart-1"),
    "chart-2": read("chart-2"),
    "chart-3": read("chart-3"),
    "chart-4": read("chart-4"),
    "chart-5": read("chart-5"),
    "chart-grid": read("chart-grid"),
    "chart-axis": read("chart-axis"),
    "chart-baseline": read("chart-baseline"),
    "delta-positive": read("delta-positive"),
    "delta-negative": read("delta-negative"),
  };
}

/**
 * The ten chart tokens, live for the current theme.
 * Returns the dark values on the server and on the first client render, then the
 * real computed values once mounted — and again on every theme change.
 */
export function useChartTokens(): ChartTokens {
  const { resolvedTheme } = useTheme();
  const [tokens, setTokens] = useState<ChartTokens>(DARK_FALLBACK);

  useEffect(() => {
    setTokens(readChartTokens());
  }, [resolvedTheme]);

  return tokens;
}

/**
 * The five series colours in their DESIGN.md-assigned order. Do not reassign:
 *   1 solar generation · 2 grid import / consumption · 3 export ·
 *   4 self-consumption · 5 loss / negative
 */
export function chartSeries(tokens: ChartTokens): [string, string, string, string, string] {
  return [
    tokens["chart-1"],
    tokens["chart-2"],
    tokens["chart-3"],
    tokens["chart-4"],
    tokens["chart-5"],
  ];
}

/** Semantic aliases for the five series, so call sites read by meaning. */
export function chartSeriesByRole(tokens: ChartTokens) {
  return {
    solarGeneration: tokens["chart-1"],
    gridImport: tokens["chart-2"],
    export: tokens["chart-3"],
    selfConsumption: tokens["chart-4"],
    loss: tokens["chart-5"],
  } as const;
}

export { DARK_FALLBACK as CHART_TOKENS_DARK_FALLBACK };
