"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button — DESIGN.md `components:` button-primary / secondary / ghost / danger.
 *
 * F45: the primary variant fills with `primary-solid`, NOT `primary`. `primary`
 * is also link text, focus rings and borders, and at its normal value a white
 * label on it falls below WCAG AA (~3.6:1 dark). `primary-solid` is a separate,
 * deliberately darker fill ramp verified >=4.5:1 with a white label in both
 * modes — darkening `primary` itself would have fixed the button while breaking
 * blue-on-card text elsewhere. One token cannot be both a filled surface and
 * text on a surface. The focus ring stays on `ring` (== `primary`) — unaffected,
 * a ring is not a fill.
 *
 * F35: the danger variant is WHITE ON RED. `destructive-foreground` is pure white
 * in BOTH modes (DESIGN.md), so text binds to `destructive-foreground` while the
 * surface binds to `destructive`. Binding both to `destructive` would render
 * red-on-red and be invisible. (Danger's own contrast gap is a separate, deferred
 * issue — checklist 10.13 — left untouched here.)
 *
 * Focus uses the 2.1 `--shadow-focus-ring` token (shadow-focus-ring), not a
 * Tailwind default ring, so the 2px-gap blue ring matches DESIGN.md elevation.
 */
const buttonVariants = cva(
  // Disabled dims via opacity — never a colour shift, so the variant stays readable.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-button transition-colors focus-visible:outline-none focus-visible:shadow-focus-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover active:bg-primary-solid-active",
        // Neutral by design — secondary is never amber (amber stays rare).
        secondary:
          "border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        ghost:
          "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        danger:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
      },
      size: {
        // DESIGN.md density: control height 36px.
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
