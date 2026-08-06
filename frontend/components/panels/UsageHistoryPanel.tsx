"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDashboardStore } from "@/lib/store";
import { getChartColors } from "@/lib/chart-theme";

interface ChartDatum {
  name: string;
  usage: number;
  days: number | string;
  dailyAvg: number;
}

interface TooltipPayload {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
}

function CustomTooltip({ active, payload }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/10 bg-enrg-dark2 p-3 text-xs shadow-lg">
      <p className="mb-1.5 font-syne text-[11px] font-bold uppercase tracking-wider text-foreground">
        {d.name}
      </p>
      <p className="text-muted-foreground">
        Usage:{" "}
        <span className="text-foreground">
          {Math.round(d.usage).toLocaleString()} kWh
        </span>
      </p>
      <p className="text-muted-foreground">
        Days: <span className="text-foreground">{d.days}</span>
      </p>
      <p className="text-muted-foreground">
        Daily avg:{" "}
        <span className="text-foreground">{d.dailyAvg} kWh/day</span>
      </p>
    </div>
  );
}

export default function UsageHistoryPanel() {
  const billData = useDashboardStore((s) => s.billData);
  const chartMode = useDashboardStore((s) => s.chartMode) ?? "dark";
  const colors = getChartColors(chartMode);

  if (!billData || !billData.combined_usage_periods?.length) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Upload a bill on the Bill Upload page to see usage history.
        </p>
      </div>
    );
  }

  const periods = billData.combined_usage_periods;
  const chartData: ChartDatum[] = periods.map((p) => ({
    name: p.period_label,
    usage: p.kwh ?? 0,
    days: p.days ?? 0,
    dailyAvg:
      p.kwh && p.days ? Math.round((p.kwh / p.days) * 10) / 10 : 0,
  }));

  return (
    <div>
      <div className="px-6 py-4">
        <h2 className="font-syne text-xs font-extrabold uppercase tracking-[0.2em] text-foreground">
          Usage History
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Quarterly energy consumption from uploaded bills
        </p>
      </div>

      <div className="mx-6 mb-6 grid grid-cols-5 items-start gap-6">
        <div className="col-span-3 h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              barSize={36}
              margin={{ top: 8, right: 16, bottom: 16, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray=""
                stroke={colors.gridStroke}
                vertical={false}
              />
              <XAxis
                dataKey="name"
                axisLine={false}
                tickLine={false}
                interval={0}
                height={48}
                tick={(props) => {
                  const { x, y, payload } = props as {
                    x: number;
                    y: number;
                    payload: { value: string };
                  };
                  const parts = payload.value.split(" – ");
                  return (
                    <text
                      x={x}
                      y={y + 6}
                      textAnchor="middle"
                      fill={colors.tickFill}
                      fontSize={10}
                      fontFamily="DM Sans"
                    >
                      <tspan x={x} dy="0">
                        {parts[0]}
                      </tspan>
                      {parts[1] && (
                        <tspan x={x} dy="14">
                          {parts[1]}
                        </tspan>
                      )}
                    </text>
                  );
                }}
              />
              <YAxis
                tick={{
                  fill: colors.tickFill,
                  fontSize: 11,
                  fontFamily: "DM Sans",
                }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}`}
                label={{
                  value: "kWh",
                  angle: -90,
                  position: "insideLeft",
                  fill: colors.tickFill,
                  fontSize: 11,
                  dx: -4,
                }}
              />
              <Tooltip
                content={<CustomTooltip />}
                cursor={{ fill: colors.cursorFill }}
              />
              <Bar
                dataKey="usage"
                fill={colors.barFill}
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {periods.length > 1 && (
          <div className="col-span-2">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 font-medium">kWh</th>
                  <th className="px-3 py-2 font-medium">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {periods.map((p, i) => (
                  <tr key={`${p.period_label}-${i}`}>
                    <td className="px-3 py-2 text-foreground">
                      {p.period_label}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {p.kwh !== null
                        ? Math.round(p.kwh).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {p.days !== null ? p.days : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
