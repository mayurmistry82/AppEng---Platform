"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tooltip — Radix Tooltip on the `popover` surface with elev-2 and rounded md,
 * `caption` type role.
 *
 * HoverHelp is the convenience wrapper: a small circled question mark in
 * `muted-foreground` that opens on hover AND on keyboard focus. Radix opens on
 * focus for a focusable trigger, so the trigger is a real <button> — keyboard
 * access is not optional.
 */

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs rounded-md border border-border bg-popover px-3 py-1.5 text-caption text-popover-foreground shadow-elev-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export interface HoverHelpProps {
  /** Tooltip body. */
  children: React.ReactNode;
  /** Accessible name for the trigger; also the title for screen readers. */
  label?: string;
  className?: string;
}

/**
 * HoverHelp — circled "?" that reveals help on hover or focus.
 * Self-contained: it brings its own Provider so a caller cannot forget one.
 */
function HoverHelp({
  children,
  label = "More information",
  className,
}: HoverHelpProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors",
              "hover:text-foreground",
              "focus-visible:outline-none focus-visible:shadow-focus-ring",
              className,
            )}
          >
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  HoverHelp,
};
