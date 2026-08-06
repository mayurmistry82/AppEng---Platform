"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSizingData } from "@/lib/api";
import { useDashboardStore, type Occupancy } from "@/lib/store";

const OCCUPANCY_TO_BACKEND: Record<Occupancy, string> = {
  home_day: "home_all_day",
  away_day: "away_during_day",
  business: "mixed",
};

const OCCUPANCY_READABLE: Record<string, string> = {
  home_all_day: "Home all day",
  away_during_day: "Away during day",
  mixed: "Mixed (home + away)",
};

const DEFAULT_BUDGET = 15000;

function fmt_money(v: number): string {
  return `~$${Math.round(v).toLocaleString()}`;
}

function fmt_kwh_per_year(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${Math.round(v).toLocaleString()} kWh/year`;
}

interface LastRunInputs {
  occupancy: Occupancy;
  budget: number | null;
  wantsBattery: boolean;
}

export default function SizingPanel() {
  const billData = useDashboardStore((s) => s.billData);
  const solarData = useDashboardStore((s) => s.solarData);
  const customerInputs = useDashboardStore((s) => s.customerInputs);
  const sizingData = useDashboardStore((s) => s.sizingData);
  const setSizingData = useDashboardStore((s) => s.setSizingData);

  const [expanded, setExpanded] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [renderError, setRenderError] = useState(false);
  const lastRunInputs = useRef<LastRunInputs | null>(null);

  const billReady = billData !== null;
  const solarReady = solarData !== null;
  const siteReady = customerInputs.propertyAddress.trim() !== "";
  const prereqsReady = billReady && solarReady && siteReady;

  const isStale =
    sizingData !== null &&
    lastRunInputs.current !== null &&
    (lastRunInputs.current.occupancy !== customerInputs.occupancy ||
      lastRunInputs.current.budget !== customerInputs.budget ||
      lastRunInputs.current.wantsBattery !== customerInputs.wantsBattery);

  async function runSizing() {
    if (!billData || !solarData) return;
    setIsFetching(true);
    setErrorMsg("");
    try {
      const budget = customerInputs.budget ?? DEFAULT_BUDGET;
      const occ = OCCUPANCY_TO_BACKEND[customerInputs.occupancy];
      const data = await fetchSizingData(
        billData,
        solarData,
        budget,
        customerInputs.wantsBattery,
        occ,
      );
      setSizingData(data);
      lastRunInputs.current = {
        occupancy: customerInputs.occupancy,
        budget: customerInputs.budget,
        wantsBattery: customerInputs.wantsBattery,
      };
    } catch (err) {
      if (err instanceof TypeError) {
        setErrorMsg(
          "Could not connect to the API. Make sure the backend is running on port 8000.",
        );
      } else if (err instanceof Error) {
        setErrorMsg(
          err.message ||
            "Sizing could not be calculated. Check that bill and solar data are loaded.",
        );
      } else {
        setErrorMsg(
          "Sizing could not be calculated. Check that bill and solar data are loaded.",
        );
      }
    } finally {
      setIsFetching(false);
    }
  }

  // Auto-run once when prerequisites become ready.
  useEffect(() => {
    if (prereqsReady && sizingData === null && !isFetching && !errorMsg) {
      runSizing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billData, solarData, customerInputs.propertyAddress]);

  function handleReRun() {
    runSizing();
  }

  if (renderError) {
    return (
      <div className="p-6">
        <h2 className="font-syne text-xs font-extrabold uppercase tracking-[0.2em] text-foreground">
          System Sizing
        </h2>
        <p className="mt-4 text-sm text-enrg-amber">
          System sizing unavailable — please refresh and try again.
        </p>
      </div>
    );
  }

  let summary = "Waiting for bill and solar data";
  if (sizingData) {
    const battery =
      sizingData.battery_kwh > 0
        ? ` · ${sizingData.battery_kwh.toFixed(1)} kWh battery`
        : "";
    summary = `${sizingData.solar_kw.toFixed(1)} kW solar${battery} · ${fmt_money(sizingData.system_cost)}`;
  }

  try {
    return (
      <div>
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <h2 className="font-syne text-xs font-extrabold uppercase tracking-[0.2em] text-foreground">
              System Sizing
            </h2>
            {!expanded && (
              <span className="text-sm text-muted-foreground">{summary}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-syne text-[10px] font-bold uppercase tracking-wider text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▴" : "▾"}
          </button>
        </div>

        {expanded && (
          <div className="border-t border-white/5 px-6 py-5">
            {!prereqsReady ? (
              <Checklist
                billReady={billReady}
                solarReady={solarReady}
                siteReady={siteReady}
              />
            ) : isFetching && !sizingData ? (
              <LoadingView />
            ) : sizingData ? (
              <Results
                data={sizingData}
                billData={billData}
                isStale={!!isStale}
                isFetching={isFetching}
                errorMsg={errorMsg}
                onReRun={handleReRun}
              />
            ) : errorMsg ? (
              <ErrorView msg={errorMsg} onRetry={handleReRun} />
            ) : (
              <LoadingView />
            )}
          </div>
        )}
      </div>
    );
  } catch {
    setRenderError(true);
    return null;
  }
}

function Checklist({
  billReady,
  solarReady,
  siteReady,
}: {
  billReady: boolean;
  solarReady: boolean;
  siteReady: boolean;
}) {
  return (
    <div>
      <h3 className="mb-3 font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        Prerequisites
      </h3>
      <ul className="space-y-1.5">
        <PrereqItem label="Bill data" ready={billReady} />
        <PrereqItem label="Solar resource" ready={solarReady} />
        <PrereqItem label="Site details" ready={siteReady} />
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        Sizing will run automatically once all three are available.
      </p>
    </div>
  );
}

function PrereqItem({ label, ready }: { label: string; ready: boolean }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
          ready
            ? "bg-emerald-400/20 text-emerald-400"
            : "bg-white/10 text-muted-foreground"
        }`}
        aria-hidden="true"
      >
        {ready ? "✓" : "○"}
      </span>
      <span className={ready ? "text-foreground" : "text-muted-foreground"}>
        {label}
      </span>
    </li>
  );
}

function LoadingView() {
  return (
    <div className="flex items-center gap-3 py-6">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
      <p className="text-sm text-muted-foreground">
        Calculating optimal system size...
      </p>
    </div>
  );
}

function ErrorView({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-enrg-amber/30 bg-enrg-amber/5 p-4">
      <p className="text-sm font-medium text-enrg-amber">
        Sizing could not be calculated. Check that bill and solar data are
        loaded.
      </p>
      <p className="text-xs text-muted-foreground">{msg}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-enrg-gradient px-4 py-2 font-syne text-xs font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
      >
        Try Again
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex border-b border-white/5 py-2 last:border-b-0">
      <div className="w-2/5 text-sm text-muted-foreground">{label}</div>
      <div
        className={`w-3/5 text-sm font-medium text-foreground ${valueClass ?? ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function MetricCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-4">
      <h3 className="mb-2 font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h3>
      <div className="divide-y divide-white/5">{children}</div>
    </div>
  );
}

function Results({
  data,
  billData,
  isStale,
  isFetching,
  errorMsg,
  onReRun,
}: {
  data: import("@/lib/api").SizingData;
  billData: import("@/lib/api").MergedBillData | null;
  isStale: boolean;
  isFetching: boolean;
  errorMsg: string;
  onReRun: () => void;
}) {
  const dailyAvg = billData?.daily_avg_kwh ?? null;
  const annualLoad = dailyAvg !== null ? dailyAvg * 365 : null;
  const selfConsumptionPct = Math.round(data.self_consumption_ratio * 100);
  const occupancyLabel =
    OCCUPANCY_READABLE[data.occupancy] ?? data.occupancy ?? "—";

  return (
    <div className="space-y-4">
      {errorMsg && (
        <div className="rounded-md border border-enrg-amber/30 bg-enrg-amber/5 px-3 py-2 text-xs text-enrg-amber">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <MetricCard title="Recommended System">
          <Row label="Solar" value={`${data.solar_kw.toFixed(1)} kW`} />
          <Row
            label="Battery"
            value={
              data.battery_kwh > 0
                ? `${data.battery_kwh.toFixed(1)} kWh`
                : "None"
            }
          />
          <Row label="System cost" value={fmt_money(data.system_cost)} />
          <Row
            label="Within budget"
            value={
              data.within_budget ? (
                <span className="text-enrg-amber">✓ Yes</span>
              ) : (
                <span className="text-enrg-orange">⚠ Exceeds budget</span>
              )
            }
          />
        </MetricCard>

        <MetricCard title="Production Profile">
          <Row
            label="Annual generation"
            value={fmt_kwh_per_year(data.annual_solar_generation_kwh)}
          />
          <Row
            label="Self-consumption"
            value={`${selfConsumptionPct}%`}
          />
          <Row label="Occupancy assumed" value={occupancyLabel} />
          <Row
            label="Annual load"
            value={fmt_kwh_per_year(annualLoad)}
          />
        </MetricCard>
      </div>

      <div className="flex items-center justify-between gap-3">
        {isStale ? (
          <p className="text-xs text-muted-foreground">
            Inputs have changed — re-run to update
          </p>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onReRun}
          disabled={isFetching}
          className="rounded-md border border-enrg-amber bg-transparent px-4 py-2 font-syne text-xs font-extrabold uppercase tracking-wider text-enrg-amber transition hover:bg-enrg-amber/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isFetching ? "Running..." : "Re-run Sizing"}
        </button>
      </div>
    </div>
  );
}
