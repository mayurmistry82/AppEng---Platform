import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * WorksheetSection — DESIGN.md `components: worksheet-section`.
 *
 * Native <details>/<summary> disclosure — keyboard (Enter/Space on the
 * summary) and screen-reader support come free, no Radix needed.
 *
 * Three states, driven by `state`:
 *   locked    opacity 50%, not expandable (no <summary>, aria-disabled), empty tick
 *   active    1.5px `brand-amber` border; tick border+glyph also `brand-amber`
 *             — SANCTIONED AMBER USE #3 (DESIGN.md)
 *   complete  tick FILLED with `foreground`, glyph in `background` — NEUTRAL,
 *             not a status colour. Done and current must never read alike:
 *             that is why complete does NOT reuse the active section's amber.
 *
 * An unrecognised `state` falls back to "locked" rather than throwing.
 */

export type WorksheetSectionState = "locked" | "active" | "complete";

function isSectionState(v: unknown): v is WorksheetSectionState {
  return v === "locked" || v === "active" || v === "complete";
}

function Tick({ state }: { state: WorksheetSectionState }) {
  if (state === "complete") {
    return (
      <span
        aria-hidden="true"
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground bg-foreground text-[10px] leading-none text-background"
      >
        ✓
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-brand-amber text-caption text-brand-amber"
      />
    );
  }
  // locked — empty tick, neutral.
  return (
    <span
      aria-hidden="true"
      className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-strong"
    />
  );
}

export interface WorksheetSectionProps {
  title: string;
  state: WorksheetSectionState | (string & {});
  children?: React.ReactNode;
  className?: string;
  /** Expanded by default when state is "active" or "complete" — set explicitly to override. */
  defaultOpen?: boolean;
}

export function WorksheetSection({
  title,
  state,
  children,
  className,
  defaultOpen,
}: WorksheetSectionProps) {
  const resolved: WorksheetSectionState = isSectionState(state)
    ? state
    : "locked";
  const locked = resolved === "locked";
  const open = defaultOpen ?? resolved !== "locked";

  if (locked) {
    // Not expandable by mouse OR keyboard: a plain <div>, no <summary>/tabindex.
    return (
      <div
        aria-disabled="true"
        className={cn(
          "cursor-not-allowed rounded-lg border border-border bg-card opacity-50",
          className,
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 text-h3 text-foreground">
          <Tick state={resolved} />
          <span>{title}</span>
        </div>
      </div>
    );
  }

  return (
    <details
      open={open}
      className={cn(
        "rounded-lg border bg-card",
        resolved === "active" ? "border-[1.5px] border-brand-amber" : "border-border",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-h3 text-foreground [&::-webkit-details-marker]:hidden">
        <Tick state={resolved} />
        <span>{title}</span>
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  );
}
