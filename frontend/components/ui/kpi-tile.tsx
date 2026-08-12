import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * KpiTile — DESIGN.md `components: kpi-tile`. Replaces the old stats-bar TODO.
 *
 * `card` surface, 1px `border`, rounded lg, 16px padding. Label is `overline`,
 * value is `metric-sm` (the .metric-sm utility from 2.1 — tabular + slashed
 * zero — applied via the class, never re-implemented). Delta is `caption`,
 * `muted-foreground` by default, `delta-positive`/`delta-negative` when signed.
 */

export interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  /** Omit for a neutral (muted-foreground) delta; pass a sign to colour it. */
  delta?: React.ReactNode;
  deltaSign?: "positive" | "negative";
  className?: string;
}

export function KpiTile({
  label,
  value,
  delta,
  deltaSign,
  className,
}: KpiTileProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        className,
      )}
    >
      <p className="text-overline text-muted-foreground">{label}</p>
      <p className="metric-sm mt-1 text-foreground">{value}</p>
      {delta != null ? (
        <p
          className={cn(
            "mt-1 text-caption",
            deltaSign === "positive" && "text-delta-positive",
            deltaSign === "negative" && "text-delta-negative",
            !deltaSign && "text-muted-foreground",
          )}
        >
          {delta}
        </p>
      ) : null}
    </div>
  );
}

export interface KpiStripProps {
  children: React.ReactNode;
  className?: string;
}

/** 4-equal-column grid wrapper for a row of KpiTiles. */
export function KpiStrip({ children, className }: KpiStripProps) {
  return (
    <div className={cn("grid grid-cols-4 gap-3", className)}>{children}</div>
  );
}
