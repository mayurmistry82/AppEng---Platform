"use client";

import * as React from "react";

import { elapsedLabel } from "@/lib/worksheet";

/**
 * RunProgress (checklist 3.13 prompt 2b) — the ONE in-flight indicator both
 * sizing buttons share: an animated ring plus a live elapsed-seconds counter,
 * ticking about once a second. The counter is the honest caption; the fixed
 * "takes a few seconds" promise it replaces is the thing that was deleted.
 *
 * - Renders NOTHING when startedAt is null — never a zeroed timer.
 * - Colours are existing tokens only (border/primary); no colour is added.
 * - Under motion-reduce the ring stops animating but the COUNTER KEEPS
 *   COUNTING: the number is the information, the movement is decoration.
 * - The wrapper is role="status" aria-live="polite" with the stable name
 *   "Sizing in progress". The ticking seconds are aria-hidden — announcing a
 *   new number every second would make the page unusable with a screen
 *   reader; the stable status name is the accessible information.
 */
export function RunProgress({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = React.useState<number>(() => Date.now());

  React.useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="Sizing in progress"
      className="inline-flex items-center gap-2 text-caption text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none"
      />
      <span aria-hidden="true" className="tabular-nums">
        {elapsedLabel(now - startedAt)}
      </span>
    </span>
  );
}
