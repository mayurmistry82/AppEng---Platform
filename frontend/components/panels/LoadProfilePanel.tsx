"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchLoadCharacterisation,
  type LoadCharacterisationData,
} from "@/lib/api";
import { getChartColors } from "@/lib/chart-theme";
import { useDashboardStore } from "@/lib/store";

function LoadTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { hour: number; kwh: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/10 bg-enrg-dark2 p-3 text-xs shadow-lg">
      <p className="mb-1 font-syne text-[11px] font-bold uppercase tracking-wider text-foreground">
        {String(d.hour).padStart(2, "0")}:00
      </p>
      <p className="text-muted-foreground">
        Load:{" "}
        <span className="text-foreground">{d.kwh.toFixed(2)} kWh</span>
      </p>
    </div>
  );
}

function fmt_kwh_year(v: number): string {
  if (!isFinite(v)) return "—";
  return `${Math.round(v).toLocaleString()} kWh/year`;
}

function fmt_kwh_day(v: number): string {
  if (!isFinite(v)) return "—";
  return `${v.toFixed(1)} kWh/day`;
}

function fmt_delta(v: number): string {
  if (v === 0) return "0 kWh/day";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} kWh/day`;
}

export default function LoadProfilePanel() {
  const billData = useDashboardStore((s) => s.billData);
  const surveyInputs = useDashboardStore((s) => s.surveyInputs);
  const loadData = useDashboardStore((s) => s.loadData);
  const setLoadData = useDashboardStore((s) => s.setLoadData);
  const chartMode = useDashboardStore((s) => s.chartMode) ?? "dark";

  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function run() {
    if (!billData || !surveyInputs) return;
    setIsFetching(true);
    setErrorMsg("");
    try {
      const data = await fetchLoadCharacterisation(billData, surveyInputs);
      setLoadData(data);
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? "Could not connect to the API. Make sure the backend is running on port 8000."
          : err instanceof Error && err.message
            ? err.message
            : "Could not calculate load profile. Please check your inputs and try again.";
      setErrorMsg(msg);
    } finally {
      setIsFetching(false);
    }
  }

  useEffect(() => {
    if (
      billData &&
      surveyInputs &&
      loadData === null &&
      !isFetching &&
      !errorMsg
    ) {
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billData, surveyInputs, loadData]);

  if (!billData || !surveyInputs) return null;

  if (isFetching && !loadData) {
    return (
      <Shell>
        <div className="flex items-center gap-3 py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
          <p className="text-sm text-muted-foreground">
            Building load profile...
          </p>
        </div>
      </Shell>
    );
  }

  if (errorMsg && !loadData) {
    return (
      <Shell>
        <div className="flex flex-col items-start gap-3 rounded-md border border-enrg-amber/30 bg-enrg-amber/5 p-4">
          <p className="text-sm font-medium text-enrg-amber">
            Could not calculate load profile. Please check your inputs and try
            again.
          </p>
          <p className="text-xs text-muted-foreground">{errorMsg}</p>
          <button
            type="button"
            onClick={run}
            className="rounded-md bg-enrg-gradient px-4 py-2 font-syne text-xs font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  if (!loadData) return null;

  return (
    <Shell rightSlot={<TierBadge data={loadData} />}>
      <Results data={loadData} chartMode={chartMode} />
    </Shell>
  );
}

function Shell({
  rightSlot,
  children,
}: {
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-syne text-xs font-extrabold uppercase tracking-[0.2em] text-foreground">
          Load Profile
        </h2>
        {rightSlot}
      </div>
      {children}
    </div>
  );
}

function TierBadge({ data }: { data: LoadCharacterisationData }) {
  return (
    <span className="rounded-full border border-enrg-amber/60 bg-enrg-dark px-3 py-1 font-syne text-[10px] font-bold uppercase tracking-wider text-enrg-amber">
      Tier {data.accuracy_tier} — {data.confidence_pct}% Confidence
    </span>
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

function Results({
  data,
  chartMode,
}: {
  data: LoadCharacterisationData;
  chartMode: "dark" | "light";
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const hourlyKwh = data.hourly_profile_weights.map(
    (w) => (w / 24.0) * data.daily_avg_kwh,
  );

  const sumWeights = data.hourly_profile_weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sumWeights - 24.0) > 0.1) {
    // eslint-disable-next-line no-console
    console.warn(
      `Load profile weights sum to ${sumWeights.toFixed(3)}, expected ~24.0`,
    );
  }

  const colors = getChartColors(chartMode);
  const chartData = hours.map((h, i) => ({
    hour: h,
    label: String(h).padStart(2, "0"),
    kwh: hourlyKwh[i],
  }));

  const chartTitle =
    data.accuracy_tier === 2
      ? "Typical daily load profile (Tier 2 adjusted)"
      : "Tier 1 — AEMO archetype";

  return (
    <div className="space-y-5">
      <div className="divide-y divide-white/5">
        <Row label="Archetype used" value={data.archetype_used} />
        <Row
          label="Annual consumption"
          value={`${fmt_kwh_year(data.annual_kwh)}${
            data.accuracy_tier === 1 ? " (from bill)" : ""
          }`}
        />
        <Row label="Daily average" value={fmt_kwh_day(data.daily_avg_kwh)} />
        <Row label="Tariff type" value={data.tariff_type_used} />
      </div>

      {data.adjustment_log.length > 0 && (
        <div>
          <h3 className="mb-2 font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Load Adjustments
          </h3>
          <div className="divide-y divide-white/[0.08]">
            {data.adjustment_log.map((adj, i) => (
              <div
                key={`${adj.description}-${i}`}
                className="flex items-center justify-between px-3 py-2"
              >
                <div className="text-sm text-foreground">{adj.description}</div>
                <div
                  className={`text-sm font-medium ${
                    adj.kwh_delta === 0
                      ? "text-muted-foreground"
                      : "text-enrg-amber"
                  }`}
                >
                  {fmt_delta(adj.kwh_delta)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          {chartTitle}
        </h3>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              barSize={10}
              margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray=""
                stroke={colors.gridStroke}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                ticks={["00", "03", "06", "09", "12", "15", "18", "21"]}
                tick={{
                  fill: colors.tickFill,
                  fontSize: 10,
                  fontFamily: "DM Sans",
                }}
                axisLine={false}
                tickLine={false}
                label={{
                  value: "Hour of day",
                  position: "insideBottom",
                  offset: -4,
                  fill: colors.tickFill,
                  fontSize: 10,
                }}
                height={36}
              />
              <YAxis
                tick={{
                  fill: colors.tickFill,
                  fontSize: 10,
                  fontFamily: "DM Sans",
                }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => v.toFixed(1)}
                label={{
                  value: "kWh",
                  angle: -90,
                  position: "insideLeft",
                  fill: colors.tickFill,
                  fontSize: 10,
                  dx: -4,
                }}
              />
              <Tooltip
                content={<LoadTooltip />}
                cursor={{ fill: colors.cursorFill }}
              />
              <Bar
                dataKey="kwh"
                fill={colors.barFill}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {data.accuracy_tier === 1 && (
        <p className="text-xs text-muted-foreground">
          Answer the survey to improve your estimate to Tier 2 (82% confidence).
        </p>
      )}
    </div>
  );
}
