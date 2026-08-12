import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * OverrideDrawer — DESIGN.md `components: override-drawer`.
 *
 * A nested <details> inside a WorksheetSection — "Advanced options". Solid 1px
 * `border-strong`, rounded sm, `muted` surface. The summary prefix is
 * "+" closed / "–" open, in `primary` (blue — this is a neutral disclosure
 * affordance, not a state).
 *
 * Pin chips are BLUE (`primary` border/text on `info-subtle`) — DELIBERATELY,
 * never amber: a pin marks a constraint, not a current/active state.
 */

export interface OverrideDrawerProps {
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

export function OverrideDrawer({
  children,
  className,
  defaultOpen = false,
}: OverrideDrawerProps) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group mt-2 rounded-sm border border-border-strong bg-muted",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-[7px] text-label text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-primary group-open:hidden">
          +
        </span>
        <span aria-hidden="true" className="hidden text-primary group-open:inline">
          –
        </span>
        Advanced options
      </summary>
      <div className="px-2.5 pb-2.5 text-caption text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

export interface OverrideDrawerRowProps {
  label: string;
  value: React.ReactNode;
  /** True on the last row — omits the bottom divider. */
  isLast?: boolean;
  className?: string;
}

export function OverrideDrawerRow({
  label,
  value,
  isLast = false,
  className,
}: OverrideDrawerRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between py-[5px]",
        !isLast && "border-b border-border",
        className,
      )}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export interface OverrideDrawerPinsProps {
  children: React.ReactNode;
  className?: string;
}

/** Wraps a wrapping row of pin chips above the drawer's rows. */
export function OverrideDrawerPins({ children, className }: OverrideDrawerPinsProps) {
  return (
    <div className={cn("mb-2 flex flex-wrap gap-1", className)}>{children}</div>
  );
}

export interface PinChipProps {
  children: React.ReactNode;
  className?: string;
}

/** A single pinned-constraint chip. BLUE by design — never amber (see module doc). */
export function PinChip({ children, className }: PinChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-primary bg-info-subtle px-2 py-0.5 text-caption text-primary",
        className,
      )}
    >
      {children}
    </span>
  );
}
