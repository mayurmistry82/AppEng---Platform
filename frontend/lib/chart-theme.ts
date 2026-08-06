import type { CSSProperties } from "react";

export type ChartMode = "dark" | "light";

export function getChartColors(mode: ChartMode) {
  return {
    barFill: mode === "dark" ? "#FF6B35" : "#090E1C",
    gridStroke:
      mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(9,14,28,0.08)",
    tickFill: mode === "dark" ? "#6B7280" : "#374151",
    cursorFill:
      mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(9,14,28,0.04)",
    tooltipStyle: {
      backgroundColor: mode === "dark" ? "#0F1628" : "#ffffff",
      border: `1px solid ${
        mode === "dark" ? "rgba(255,255,255,0.1)" : "rgba(9,14,28,0.1)"
      }`,
      borderRadius: "8px",
      fontSize: "12px",
      padding: "10px 12px",
    } as CSSProperties,
  };
}
