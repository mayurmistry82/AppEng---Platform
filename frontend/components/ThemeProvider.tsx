"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App-wide theme provider (Stage 2.2, F27) — replaces 2.1's hardcoded
 * className="dark" on <html>.
 *
 * - attribute="class": next-themes toggles the `dark` class, which is what the
 *   2.1 token layer keys on (:root = light, .dark = dark).
 * - defaultTheme="dark": today's appearance is preserved exactly, and if
 *   next-themes ever fails to hydrate, the blocking script still lands on dark —
 *   never an unstyled page.
 * - enableSystem={false} DELIBERATELY: DESIGN.md specifies two modes, Light and
 *   Dark. Do not add a System option.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
