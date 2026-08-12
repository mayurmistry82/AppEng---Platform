"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useDashboardStore } from "@/lib/store";

/**
 * Standalone Light/Dark control for the rail (Stage 2.2). Always visible, never
 * inside a menu — the user flips theme from any screen in one click.
 *
 * CHART MODE SYNC: three legacy panels (do-not-modify until 3.16) read
 * `chartMode` from the Zustand store. We never remove that slice; instead the
 * app theme drives it, so charts follow the theme. The manual chart switcher
 * survives only in the old Sidebar.
 */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const setChartMode = useDashboardStore((s) => s.setChartMode);

  // next-themes only knows the real theme on the client — rendering
  // theme-dependent output before mount would hydrate wrong.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Keep the legacy chart theme in lockstep with the app theme.
  useEffect(() => {
    if (mounted && (resolvedTheme === "dark" || resolvedTheme === "light")) {
      setChartMode(resolvedTheme);
    }
  }, [mounted, resolvedTheme, setChartMode]);

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="flex w-full flex-col items-center gap-1 rounded-md py-2 text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      aria-label={
        mounted ? `Switch to ${isDark ? "light" : "dark"} mode` : "Toggle theme"
      }
    >
      {/* Fixed-size slot before mount so nothing shifts or mis-hydrates. */}
      {mounted ? (
        isDark ? (
          <Sun className="h-5 w-5" />
        ) : (
          <Moon className="h-5 w-5" />
        )
      ) : (
        <span className="h-5 w-5" />
      )}
      <span className="text-caption">
        {mounted ? (isDark ? "Light" : "Dark") : "Theme"}
      </span>
    </button>
  );
}
