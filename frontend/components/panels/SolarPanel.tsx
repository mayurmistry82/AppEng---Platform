"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  fetchSolarData,
  fetchDailySolarData,
  type DailyIrradianceData,
} from "@/lib/api";
import { useDashboardStore } from "@/lib/store";
import { ENRG_LAYOUT, ENRG_CONFIG } from "@/lib/plotly-theme";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

type PanelState = "idle" | "loading" | "success" | "error";

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function padMonthly(values: number[]): number[] {
  const out = [...values];
  while (out.length < 12) out.push(0);
  return out.slice(0, 12);
}

function padDaily(values: number[]): number[] {
  const out = [...values];
  while (out.length < 365) out.push(0);
  return out.slice(0, 365);
}

function padHourly(values: number[]): number[] {
  const out = [...values];
  while (out.length < 8760) out.push(0);
  return out.slice(0, 8760);
}

function generateDayLabels(): string[] {
  const labels: string[] = [];
  const d = new Date(2019, 0, 1);
  for (let i = 0; i < 365; i++) {
    labels.push(
      d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }),
    );
    d.setDate(d.getDate() + 1);
  }
  return labels;
}
const DAY_LABELS = generateDayLabels();

function generateHourLabels(): string[] {
  const labels: string[] = [];
  const d = new Date(2019, 0, 1, 0, 0, 0);
  for (let i = 0; i < 8760; i++) {
    labels.push(
      d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) +
        " " +
        d.toLocaleTimeString("en-AU", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
    );
    d.setHours(d.getHours() + 1);
  }
  return labels;
}
const HOUR_LABELS = generateHourLabels();

type ViewMode = "monthly" | "daily" | "hourly";

function fmt_int(v: number | null): string {
  if (v === null || !isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

function PanelShell({
  rightSlot,
  children,
}: {
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-syne text-xs font-extrabold uppercase tracking-[0.2em] text-foreground">
          Solar Resource
        </h2>
        {rightSlot}
      </div>
      {children}
    </div>
  );
}

export default function SolarPanel() {
  const storeAddress = useDashboardStore(
    (s) => s.customerInputs.propertyAddress,
  );
  const solarData = useDashboardStore((s) => s.solarData);
  const setSolarData = useDashboardStore((s) => s.setSolarData);

  const [panelState, setPanelState] = useState<PanelState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [systemKw, setSystemKw] = useState(6.6);
  const [inputKw, setInputKw] = useState("6.6");
  const [viewMode, setViewMode] = useState<ViewMode>("monthly");
  const [dailyData, setDailyData] = useState<DailyIrradianceData | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState("");

  async function doFetch(address: string, kw: number) {
    setPanelState("loading");
    setErrorMsg("");
    try {
      const data = await fetchSolarData(address, kw);
      setSolarData(data);
      setSystemKw(kw);
      setInputKw(String(kw));
      setDailyData(null);
      setDailyError("");
      setPanelState("success");
    } catch (err) {
      if (err instanceof TypeError) {
        setErrorMsg(
          "Could not connect to the API. Make sure the backend is running on port 8000.",
        );
      } else if (err instanceof Error) {
        setErrorMsg(err.message || "Unknown error");
      } else {
        setErrorMsg("Something went wrong. Please refresh and try again.");
      }
      setPanelState("error");
    }
  }

  // Auto-fetch when address becomes available; clear when removed.
  useEffect(() => {
    if (storeAddress) {
      doFetch(storeAddress, systemKw);
    } else {
      setPanelState("idle");
      setSolarData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeAddress]);

  function handleUpdate() {
    const kw = parseFloat(inputKw);
    if (!isNaN(kw) && kw > 0 && storeAddress) {
      doFetch(storeAddress, kw);
    }
  }

  async function doFetchDaily() {
    if (!solarData) return;
    setDailyLoading(true);
    setDailyError("");
    try {
      const data = await fetchDailySolarData(
        solarData.latitude,
        solarData.longitude,
        systemKw,
      );
      setDailyData(data);
    } catch (err) {
      if (err instanceof TypeError) {
        setDailyError(
          "Could not connect to the API. Make sure the backend is running on port 8000.",
        );
      } else if (err instanceof Error) {
        setDailyError(err.message || "Could not fetch daily data.");
      } else {
        setDailyError("Could not fetch daily data.");
      }
    } finally {
      setDailyLoading(false);
    }
  }

  function handleDailyView(targetView: ViewMode = "daily") {
    setViewMode(targetView);
    if (dailyData) return;
    doFetchDaily();
  }

  function handleHourlyView() {
    if (!dailyData) {
      handleDailyView("hourly");
    } else {
      setViewMode("hourly");
    }
  }

  function retryDaily() {
    setDailyData(null);
    doFetchDaily();
  }

  const inputKwNum = parseFloat(inputKw);
  const updateDisabled =
    isNaN(inputKwNum) || inputKwNum <= 0 || !storeAddress;

  if (panelState === "idle" || !storeAddress) {
    return (
      <PanelShell>
        <p className="text-sm text-muted-foreground">
          Enter a property address in Customer &amp; Site above to load solar
          irradiance data for this location.
        </p>
      </PanelShell>
    );
  }

  if (panelState === "loading") {
    return (
      <PanelShell>
        <div className="flex flex-col items-center justify-center gap-3 py-10">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
          <p className="text-sm text-muted-foreground">
            Fetching solar data for {storeAddress}...
          </p>
        </div>
      </PanelShell>
    );
  }

  if (panelState === "error") {
    return (
      <PanelShell>
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-10 w-10 text-destructive"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <p className="text-sm font-medium text-foreground">
            Could not fetch solar data.
          </p>
          {errorMsg && (
            <p className="max-w-md text-xs text-muted-foreground">{errorMsg}</p>
          )}
          <button
            type="button"
            onClick={() => doFetch(storeAddress, systemKw)}
            className="mt-3 rounded-md bg-enrg-gradient px-4 py-2 font-syne text-xs font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
          >
            Try Again
          </button>
        </div>
      </PanelShell>
    );
  }

  if (!solarData) {
    return (
      <PanelShell>
        <p className="text-sm text-muted-foreground">No data.</p>
      </PanelShell>
    );
  }

  const monthly = padMonthly(solarData.monthly_profile ?? []);
  const annualOutput = monthly.reduce((s, v) => s + v, 0);

  return (
    <PanelShell
      rightSlot={
        <button
          type="button"
          onClick={() => doFetch(storeAddress, systemKw)}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-syne text-[10px] font-bold uppercase tracking-wider text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
        >
          ↻ Refresh
        </button>
      }
    >
      <div className="divide-y divide-white/5">
        <Row
          label="Location"
          value={`${solarData.latitude.toFixed(2)}°, ${solarData.longitude.toFixed(2)}°`}
        />
        <Row
          label="Peak sun hours"
          value={
            solarData.peak_sun_hours !== null
              ? `${solarData.peak_sun_hours.toFixed(1)} h/day`
              : "—"
          }
        />
        <Row
          label="Annual output"
          value={
            annualOutput > 0
              ? `${fmt_int(annualOutput)} kWh/year  (for ${systemKw} kW system)`
              : solarData.annual_kwh_per_kwp !== null
                ? `${fmt_int(solarData.annual_kwh_per_kwp * systemKw)} kWh/year  (for ${systemKw} kW system)`
                : "—"
          }
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          System size
        </label>
        <input
          type="number"
          min={0}
          step={0.1}
          value={inputKw}
          onChange={(e) => setInputKw(e.target.value)}
          className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-foreground focus:border-enrg-amber focus:outline-none"
        />
        <span className="text-xs text-muted-foreground">kW</span>
        <button
          type="button"
          onClick={handleUpdate}
          disabled={updateDisabled}
          className="rounded-md bg-enrg-gradient px-3 py-1.5 font-syne text-[10px] font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Update
        </button>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            {viewMode === "monthly"
              ? "Monthly Generation"
              : viewMode === "daily"
                ? "Daily Generation  (2019 typical year)"
                : "Hourly Generation  (2019 typical year)"}
          </h3>
          <div className="flex gap-1 rounded-md border border-white/10 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("monthly")}
              className={`rounded px-3 py-1 font-syne text-[10px] font-bold uppercase tracking-wider transition ${
                viewMode === "monthly"
                  ? "bg-enrg-amber text-enrg-dark"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => handleDailyView()}
              className={`rounded px-3 py-1 font-syne text-[10px] font-bold uppercase tracking-wider transition ${
                viewMode === "daily"
                  ? "bg-enrg-amber text-enrg-dark"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              Daily
            </button>
            <button
              type="button"
              onClick={handleHourlyView}
              className={`rounded px-3 py-1 font-syne text-[10px] font-bold uppercase tracking-wider transition ${
                viewMode === "hourly"
                  ? "bg-enrg-amber text-enrg-dark"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              Hourly
            </button>
          </div>
        </div>

        {viewMode === "monthly" ? (
          <div>
            <Plot
              data={[
                {
                  type: "bar",
                  x: MONTH_LABELS,
                  y: monthly,
                  marker: { color: "#FFB428", opacity: 0.85 },
                  hovertemplate:
                    "<b>%{x}</b><br>Generation: %{y:,.0f} kWh<extra></extra>",
                },
              ]}
              layout={{
                ...ENRG_LAYOUT,
                height: 300,
                yaxis: {
                  ...ENRG_LAYOUT.yaxis,
                  title: {
                    text: "kWh",
                    font: { color: "rgba(240,244,255,0.5)", size: 11 },
                  },
                },
                xaxis: {
                  ...ENRG_LAYOUT.xaxis,
                  tickangle: 0,
                },
              }}
              config={ENRG_CONFIG}
              style={{ width: "100%" }}
              useResizeHandler
            />
          </div>
        ) : dailyLoading ? (
          <div className="flex items-center justify-center gap-3 py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
            <p className="text-sm text-muted-foreground">
              Fetching daily profile... this may take 20–30 seconds
            </p>
          </div>
        ) : dailyError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-sm text-enrg-amber">{dailyError}</p>
            <button
              type="button"
              onClick={retryDaily}
              className="rounded-md bg-enrg-gradient px-4 py-2 font-syne text-xs font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
            >
              Retry
            </button>
          </div>
        ) : dailyData ? (
          viewMode === "daily" ? (
            <div>
              <Plot
                data={[
                  {
                    type: "scatter",
                    mode: "lines",
                    x: DAY_LABELS,
                    y: padDaily(dailyData.daily_profile),
                    line: { color: "#FFB428", width: 1.5 },
                    fill: "tozeroy",
                    fillcolor: "rgba(255,180,40,0.08)",
                    hovertemplate:
                      "<b>%{x}</b><br>Generation: %{y:.1f} kWh<extra></extra>",
                  },
                ]}
                layout={{
                  ...ENRG_LAYOUT,
                  height: 340,
                  yaxis: {
                    ...ENRG_LAYOUT.yaxis,
                    title: {
                      text: "kWh/day",
                      font: { color: "rgba(240,244,255,0.5)", size: 11 },
                    },
                  },
                  xaxis: {
                    ...ENRG_LAYOUT.xaxis,
                    nticks: 12,
                    tickangle: -30,
                    rangeslider: {
                      visible: true,
                      bgcolor: "#0F1628",
                      thickness: 0.06,
                    },
                  },
                }}
                config={ENRG_CONFIG}
                style={{ width: "100%" }}
                useResizeHandler
              />
            </div>
          ) : (
            <div>
              <Plot
                data={[
                  {
                    type: "scatter",
                    mode: "lines",
                    x: HOUR_LABELS,
                    y: padHourly(dailyData.hourly_profile),
                    line: { color: "#FFB428", width: 1 },
                    fill: "tozeroy",
                    fillcolor: "rgba(255,180,40,0.06)",
                    hovertemplate:
                      "<b>%{x}</b><br>Generation: %{y:.2f} kWh<extra></extra>",
                  },
                ]}
                layout={{
                  ...ENRG_LAYOUT,
                  height: 340,
                  yaxis: {
                    ...ENRG_LAYOUT.yaxis,
                    title: {
                      text: "kWh",
                      font: { color: "rgba(240,244,255,0.5)", size: 11 },
                    },
                  },
                  xaxis: {
                    ...ENRG_LAYOUT.xaxis,
                    range: [HOUR_LABELS[0], HOUR_LABELS[167]],
                    nticks: 7,
                    tickangle: -30,
                    rangeslider: {
                      visible: true,
                      bgcolor: "#0F1628",
                      thickness: 0.06,
                    },
                  },
                }}
                config={ENRG_CONFIG}
                style={{ width: "100%" }}
                useResizeHandler
              />
            </div>
          )
        ) : null}
      </div>
    </PanelShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-b border-white/5 py-2 last:border-b-0">
      <div className="w-2/5 text-sm text-muted-foreground">{label}</div>
      <div className="w-3/5 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}
