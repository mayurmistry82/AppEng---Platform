import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AccuracyMeter — DESIGN.md `components: accuracy-meter`.
 *
 * DATA CONTRACT (C10): `tier` is the INTEGER 1 | 2 | 3 — never the string
 * "tier_3" — matching the Postgres column. Fill width = tier/3:
 *   1 -> 33.3%   2 -> 66.6%   3 -> 100%
 * An out-of-range or missing tier renders the track EMPTY with the label
 * "Accuracy — not yet assessed" and never throws.
 *
 * SANCTIONED AMBER USE #2 — fill and the tier word are `brand-amber`. Never
 * orange, never a semantic status colour.
 */

export type AccuracyTier = 1 | 2 | 3;

const FILL_WIDTH: Record<AccuracyTier, string> = {
  1: "33.3%",
  2: "66.6%",
  3: "100%",
};

const TIER_LABEL: Record<AccuracyTier, string> = {
  1: "Tier 1",
  2: "Tier 2",
  3: "Tier 3",
};

function isAccuracyTier(v: unknown): v is AccuracyTier {
  return v === 1 || v === 2 || v === 3;
}

export interface AccuracyMeterProps {
  /** The integer accuracy tier (1|2|3). Anything else renders "not yet assessed". */
  tier: AccuracyTier | number | null | undefined;
  className?: string;
}

export function AccuracyMeter({ tier, className }: AccuracyMeterProps) {
  const valid = isAccuracyTier(tier);

  return (
    <div className={cn("min-w-[110px] max-w-[190px]", className)}>
      <p className="mb-1 text-caption text-muted-foreground">
        {valid ? (
          <>
            Accuracy — <span className="font-bold text-brand-amber">{TIER_LABEL[tier]}</span>
          </>
        ) : (
          "Accuracy — not yet assessed"
        )}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full border border-border bg-muted">
        {valid ? (
          <div
            className="h-full bg-brand-amber"
            style={{ width: FILL_WIDTH[tier] }}
          />
        ) : null}
      </div>
    </div>
  );
}
