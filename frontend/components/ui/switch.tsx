"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Switch — a two-state control, built by hand against a `<button>` the way the
 * other eight standard components were built. No package: a switch does not
 * need a Radix primitive, and each of the four already present was its own
 * approved decision.
 *
 * SEMANTICS ARE PRESERVED, NOT INTRODUCED: the control this replaces was an
 * `<input type="checkbox" role="switch">`, which already announced correctly.
 * This changes the element and the appearance, never the announcement —
 * `role="switch"` with `aria-checked` and an accessible name, exactly as
 * before.
 *
 * KEYBOARD: a native `<button>` fires its click handler on BOTH Space and
 * Enter, and takes focus in the normal tab order. There is deliberately no
 * `onKeyDown` here — adding one would double-fire against the native
 * behaviour (Enter on keydown, Space on keyup) rather than improve it.
 *
 * FOCUS: the project's `shadow-focus-ring` token, as button.tsx and
 * tooltip.tsx use it. Not reimplemented.
 *
 * MOTION: the thumb's slide is `transition-transform`, disabled under
 * `motion-reduce`. The state stays obvious without it, because the state is
 * carried by the thumb's POSITION and the track's FILL — both static facts,
 * not the animation between them.
 *
 * GENERIC: it knows nothing about return on investment. The grid-charge
 * toggle (4.7) and the VPP option (4.6) are the next two callers.
 */
export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name. Required — a switch with no name announces nothing. */
  label: string;
  className?: string;
  id?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  className,
  id,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors",
        "focus-visible:outline-none focus-visible:shadow-focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary-solid" : "bg-border",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-4 w-4 rounded-full bg-primary-foreground transition-transform motion-reduce:transition-none",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
