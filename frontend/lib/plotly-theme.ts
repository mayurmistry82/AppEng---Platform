import type { Layout, Config } from "plotly.js";

export type ChartMode = "dark" | "light";

export function getChartLayout(mode: ChartMode): Partial<Layout> {
  const dark = mode === "dark";

  return {
    paper_bgcolor: dark ? "transparent" : "#ffffff",
    plot_bgcolor: dark ? "#0F1628" : "#ffffff",
    font: {
      family: "DM Sans, sans-serif",
      color: dark ? "#F0F4FF" : "rgba(9,14,28,0.85)",
      size: 12,
    },
    xaxis: {
      showgrid: false,
      linecolor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,14,28,0.12)",
      tickcolor: "transparent",
      tickfont: {
        color: dark ? "rgba(240,244,255,0.5)" : "rgba(9,14,28,0.45)",
        size: 11,
      },
      title: {
        font: {
          color: dark ? "rgba(240,244,255,0.7)" : "rgba(9,14,28,0.6)",
          size: 12,
        },
      },
      automargin: true,
    },
    yaxis: {
      showgrid: true,
      gridcolor: dark ? "rgba(255,255,255,0.06)" : "rgba(9,14,28,0.08)",
      linecolor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,14,28,0.12)",
      tickcolor: "transparent",
      tickfont: {
        color: dark ? "rgba(240,244,255,0.5)" : "rgba(9,14,28,0.45)",
        size: 11,
      },
      title: {
        font: {
          color: dark ? "rgba(240,244,255,0.7)" : "rgba(9,14,28,0.6)",
          size: 12,
        },
      },
      tickformat: ",d",
      automargin: true,
    },
    hoverlabel: {
      bgcolor: dark ? "#161E33" : "#ffffff",
      bordercolor: dark ? "rgba(255,255,255,0.1)" : "rgba(9,14,28,0.15)",
      font: {
        color: dark ? "#F0F4FF" : "rgba(9,14,28,0.85)",
        family: "DM Sans, sans-serif",
        size: 12,
      },
    },
    margin: { t: 16, r: 16, b: 48, l: 60 },
    showlegend: false,
    dragmode: "zoom",
  };
}

// Backward-compatible alias — do not remove (other panels import this)
export const ENRG_LAYOUT = getChartLayout("dark");

export const ENRG_CONFIG: Partial<Config> = {
  displayModeBar: true,
  modeBarButtonsToRemove: [
    "select2d",
    "lasso2d",
    "autoScale2d",
    "hoverClosestCartesian",
    "hoverCompareCartesian",
    "toggleSpikelines",
  ],
  displaylogo: false,
  responsive: true,
  toImageButtonOptions: {
    format: "png",
    filename: "enrgengine-chart",
    scale: 2,
  },
};
