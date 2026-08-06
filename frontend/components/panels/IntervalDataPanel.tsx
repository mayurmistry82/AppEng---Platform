"use client";

import { useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { uploadIntervalData } from "@/lib/api";
import { getChartColors } from "@/lib/chart-theme";
import { useDashboardStore } from "@/lib/store";

type PanelState = "idle" | "parsing" | "success" | "error";

const ACCEPTED = [".csv", ".dat", ".txt"];

function isAccepted(f: File): boolean {
  const n = f.name.toLowerCase();
  return ACCEPTED.some((e) => n.endsWith(e));
}

interface TooltipPayload {
  active?: boolean;
  payload?: Array<{ payload: { hour: string; kwh: number } }>;
}

function HourTooltip({ active, payload }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/10 bg-enrg-dark2 p-3 text-xs shadow-lg">
      <p className="mb-1 font-syne text-[11px] font-bold uppercase tracking-wider text-foreground">
        {d.hour}
      </p>
      <p className="text-muted-foreground">
        Avg load: <span className="text-foreground">{d.kwh.toFixed(2)} kWh</span>
      </p>
    </div>
  );
}

export default function IntervalDataPanel() {
  const setLoadData = useDashboardStore((s) => s.setLoadData);
  const setIntervalData = useDashboardStore((s) => s.setIntervalData);
  const meta = useDashboardStore((s) => s.intervalData);
  const jobId = useDashboardStore((s) => s.jobId);
  const chartMode = useDashboardStore((s) => s.chartMode) ?? "dark";
  const colors = getChartColors(chartMode);

  const [state, setState] = useState<PanelState>(meta ? "success" : "idle");
  const [error, setError] = useState("");
  const [flags, setFlags] = useState<string[]>([]);
  const [includeCL, setIncludeCL] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFile = useRef<File | null>(null);

  async function doUpload(file: File, withControlledLoad: boolean) {
    lastFile.current = file;
    setState("parsing");
    setError("");
    const res = await uploadIntervalData(file, {
      jobId,
      includeControlledLoad: withControlledLoad,
    });
    if (!res.ok || !res.load || !res.metadata) {
      setError(res.error || "Could not read this file.");
      setState("error");
      return;
    }
    setLoadData(res.load); // Tier 3 — wins over the survey estimate
    // Carry the Storage refs + persistence state so JobAutoSave can back-link the
    // interval_data row once a job_id is minted (the upload may have had no job_id yet).
    setIntervalData({
      ...res.metadata,
      raw_file_path: res.raw_file_path ?? null,
      parsed_series_ref: res.parsed_series_ref ?? null,
      persisted: res.persisted,
    });
    setFlags(res.flags || []);
    setState("success");
  }

  function onPick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!isAccepted(f)) {
      setError("Unsupported file. Upload a NEM12 (.csv/.dat) or a CSV (.csv).");
      setState("error");
      return;
    }
    doUpload(f, includeCL);
  }

  function toggleControlledLoad() {
    const next = !includeCL;
    setIncludeCL(next);
    if (lastFile.current) doUpload(lastFile.current, next);
  }

  function reset() {
    setState("idle");
    setError("");
    setFlags([]);
    setIntervalData(null);
    lastFile.current = null;
    if (fileRef.current) fileRef.current.value = "";
  }

  const e2Available = !!meta?.channels_available?.some(
    (c) => c.toUpperCase() === "E2",
  );

  return (
    <div>
      <div className="px-6 pb-4">
        <h2 className="text-sm font-semibold text-foreground">
          Smart-meter data{" "}
          <span className="ml-1 rounded-full border border-enrg-amber/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-enrg-amber">
            Tier 3
          </span>
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Upload the customer&apos;s interval data (NEM12 from their distributor, or a
          CSV) for a real measured load profile — replaces the survey estimate.
        </p>
      </div>

      <div className="border-t border-white/[0.06] px-6 py-6">
        {/* idle / parsing dropzone */}
        {(state === "idle" || state === "parsing") && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (state !== "parsing") onPick(e.dataTransfer.files);
            }}
            onClick={() => state !== "parsing" && fileRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragOver
                ? "border-solid border-enrg-amber bg-enrg-amber/5"
                : "border-white/15 hover:border-white/30"
            }`}
          >
            {state === "parsing" ? (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
                <p className="text-sm text-muted-foreground">Parsing meter data…</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">
                  Upload smart-meter data (NEM12 or CSV)
                </p>
                <p className="text-xs text-muted-foreground">
                  Drop a file here or click to browse · .csv / .dat · solar export is
                  excluded automatically
                </p>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.dat,.txt,text/csv,text/plain"
              onChange={(e) => onPick(e.target.files)}
              className="hidden"
            />
          </div>
        )}

        {/* error */}
        {state === "error" && (
          <div className="flex flex-col items-start gap-3 rounded-md border border-enrg-amber/30 bg-enrg-amber/5 p-4">
            <p className="text-sm font-medium text-enrg-amber">
              Couldn&apos;t read this file
            </p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground">
              You can try a different file, or just use the survey estimate above
              (Tier 2) — the analysis still works.
            </p>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
            >
              Try another file
            </button>
          </div>
        )}

        {/* success */}
        {state === "success" && meta && (
          <div className="space-y-5">
            {/* metadata strip */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <Stat label="Source" value={meta.source ?? "—"} />
              <Stat
                label="Interval"
                value={
                  meta.resolution_minutes
                    ? `${meta.resolution_minutes} min`
                    : "—"
                }
              />
              <Stat
                label="Coverage"
                value={
                  meta.coverage_days != null
                    ? `${meta.coverage_days} days${meta.annualised ? " — annualised" : ""}`
                    : "—"
                }
              />
              <Stat
                label="Actual data"
                value={meta.pct_actual != null ? `${meta.pct_actual}%` : "—"}
              />
              <Stat
                label="Annual"
                value={
                  meta.annual_kwh != null
                    ? `${Math.round(meta.annual_kwh).toLocaleString()} kWh`
                    : "—"
                }
              />
            </div>

            {/* channels */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Channels:</span>
              {meta.channels_used.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-enrg-amber/40 bg-enrg-amber/10 px-2 py-0.5 font-medium text-enrg-amber"
                >
                  {c} (used)
                </span>
              ))}
              {meta.channels_excluded.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-muted-foreground"
                >
                  {c} solar export — excluded
                </span>
              ))}
            </div>

            {/* controlled-load toggle (only if E2 present) */}
            {e2Available && (
              <label className="flex cursor-pointer items-center gap-2.5 text-xs">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                    includeCL
                      ? "border-enrg-amber bg-enrg-amber"
                      : "border-white/20 bg-transparent"
                  }`}
                >
                  {includeCL && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="h-3 w-3 text-enrg-dark"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m4.5 12.75 6 6 9-13.5"
                      />
                    </svg>
                  )}
                </span>
                <input
                  type="checkbox"
                  checked={includeCL}
                  onChange={toggleControlledLoad}
                  className="sr-only"
                  aria-label="Include controlled load (E2)"
                />
                <span className="text-foreground">
                  Include controlled load (E2)
                </span>
              </label>
            )}

            {/* average-day chart */}
            <div>
              <h3 className="mb-2 font-syne text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Average day (measured)
              </h3>
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(meta.average_day_kwh || []).map((v, h) => ({
                      hour: `${String(h).padStart(2, "0")}:00`,
                      kwh: v,
                    }))}
                    margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid
                      strokeDasharray=""
                      stroke={colors.gridStroke}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="hour"
                      ticks={["00:00", "06:00", "12:00", "18:00"]}
                      tick={{ fill: colors.tickFill, fontSize: 10, fontFamily: "DM Sans" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: colors.tickFill, fontSize: 10, fontFamily: "DM Sans" }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${v}`}
                      label={{
                        value: "kWh",
                        angle: -90,
                        position: "insideLeft",
                        fill: colors.tickFill,
                        fontSize: 10,
                        dx: -4,
                      }}
                    />
                    <Tooltip content={<HourTooltip />} cursor={{ fill: colors.cursorFill }} />
                    <Bar dataKey="kwh" fill={colors.barFill} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* flags / assumptions */}
            {flags.length > 0 && (
              <ul className="space-y-1">
                {flags.map((f, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-xs text-muted-foreground"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-enrg-amber/60" />
                    {f}
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
            >
              Upload a different file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}
