import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * THE TYPE ROLES, and why tailwind-merge has to be told about them.
 *
 * `cn` was `twMerge(clsx(inputs))` with no configuration. tailwind-merge knows
 * nothing about this project's `fontSize` keys, and its default `text-color`
 * group accepts ANY `text-*` value — so `text-body` was filed as a colour,
 * collided with the real colour written beside it, and the earlier class was
 * dropped. The role always lost, because the role is always written first:
 *
 *     twMerge("text-body text-foreground")  ->  "text-foreground"
 *
 * Nothing was wrong in any component. Eleven correctly-written call sites had
 * their size instruction deleted at render time, on every render, and rendered
 * at the browser default of 16px instead. It survived a passing colour-token
 * gate because that gate reads token VALUES, never the class string that
 * reaches the element (the 2N.1 / F47 shape).
 *
 * THIS LIST IS DERIVED FROM tailwind.config.ts's `fontSize` block and must stay
 * exactly equal to its keys — verify-worksheet-logic.ts reads the config at test
 * time and fails if the two ever drift, so a role added there and not here
 * cannot quietly go back to rendering at 16px.
 */
export const TYPE_ROLES = [
  "hero-xl",
  "hero",
  "hero-sub",
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "body-medium",
  "label",
  "button",
  "nav",
  "caption",
  "overline",
  "eyebrow",
  "metric-lg",
  "metric-sm",
] as const;

// `extend` ADDS to the default font-size group rather than replacing it, so
// Tailwind's own text-sm/text-lg/text-[13px] keep working exactly as before.
// A literal registers as an exact match, which beats the text-color group's
// catch-all validator — the reason this separates the two groups instead of
// merging them, and why a caller overriding one size with another still wins.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_ROLES] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
