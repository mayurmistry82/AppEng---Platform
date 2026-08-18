import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Input — DESIGN.md `components: input`.
 * bg `background`, border `input`, text `foreground`, placeholder `muted-foreground`,
 * rounded md, 36px control height (density), focus ring = `ring`.
 *
 * 3.8-2b — NUMBER INPUTS DO NOT CHANGE THEMSELVES. Found on screen: no `step`
 * was set on most number fields, so the browser default of 1 applied, and one
 * click of the Feed-in tariff's up arrow took 0.05 to 1 — twenty times the real
 * number, on a field the whole savings calculation runs on. The quieter half
 * was the wheel: a FOCUSED number input changes value as the page scrolls, with
 * no click at all, so a wrong number could reach a customer quote untouched.
 * The F78 family — a control that yields a plausible wrong number nobody
 * notices. Fixed once, here, so every current and future Input inherits it.
 *
 * The keyboard arrows deliberately STILL WORK (an accessibility affordance);
 * the explicit `step` each call site now passes is what makes that path safe.
 */
const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, onWheel, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-body text-foreground",
      "placeholder:text-muted-foreground",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "file:border-0 file:bg-transparent file:text-body file:font-medium",
      // The stepper arrows, off in WebKit and in Firefox both. They are drawn by
      // the browser INSIDE the existing box, so removing them changes no width,
      // no height and no alignment. Still before `className`, so a caller can
      // override.
      "[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [appearance:textfield]",
      className,
    )}
    {...props}
    // AFTER the spread, and `onWheel` is destructured out of props above, so a
    // caller's handler can neither be silently dropped nor silently win — it is
    // composed below instead.
    onWheel={(event) => {
      // The CALLER'S handler runs FIRST, on an untouched event, so it can opt
      // out of this behaviour with preventDefault. The other order would blur
      // before the caller ever got a say.
      onWheel?.(event);
      if (event.defaultPrevented) return;
      // *** ONLY number inputs. *** Input is also the address autocomplete and
      // the jobs filter box, and a TEXT field that lost focus every time the
      // page scrolled would be a far worse regression than the bug being fixed
      // — and, like this bug, it would be found by a person rather than a test.
      if (type !== "number") return;
      // Blur rather than preventDefault: the page keeps scrolling normally and
      // the value simply cannot change. preventDefault would stop the page
      // scrolling, which is the worse bug.
      const element = event.currentTarget;
      if (document.activeElement === element) element.blur();
    }}
  />
));
Input.displayName = "Input";

export { Input };
