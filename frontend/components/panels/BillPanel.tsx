"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseBill,
  type BillData,
  type CombinedUsagePeriod,
  type MergedBillData,
} from "@/lib/api";
import { useDashboardStore } from "@/lib/store";

type PanelState = "idle" | "loading" | "success" | "error";

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
const ACCEPTED_EXTS = [".pdf", ".jpg", ".jpeg", ".png"];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 4;

function isAcceptedFile(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTS.some((ext) => name.endsWith(ext));
}

function fmt_tariff(v: number | null): string {
  if (v === null) return "Not found";
  return `$${v.toFixed(2)} / kWh`;
}

function fmt_daily(v: number | null): string {
  if (v === null) return "—";
  return `$${v.toFixed(2)} / day`;
}

function fmt_annual(v: number | null): string {
  if (v === null) return "—";
  return `~$${Math.round(v).toLocaleString()} / year`;
}

function fmt_date(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmt_period_single(
  start: string | null,
  end: string | null,
  days: number | null,
): string {
  if (!start && !end && days === null) return "—";
  const dStr = days !== null ? `${days} days` : "";
  const dateStr =
    start && end
      ? `${fmt_date(start)} – ${fmt_date(end)}`
      : start
        ? fmt_date(start)
        : end
          ? fmt_date(end)
          : "";
  return [dStr, dateStr].filter(Boolean).join("  ·  ");
}

function fmt_period_covered(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (start && end) return `${fmt_date(start)} – ${fmt_date(end)}`;
  return start ? fmt_date(start) : fmt_date(end!);
}

function fmt_total_kwh(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v).toLocaleString()} kWh`;
}

function fmt_daily_avg(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)} kWh/day`;
}

function mergeBillData(bills: BillData[]): MergedBillData {
  const sorted = [...bills].sort((a, b) => {
    if (!a.billing_period_end) return 1;
    if (!b.billing_period_end) return -1;
    return b.billing_period_end.localeCompare(a.billing_period_end);
  });

  const primary = sorted[0];

  const combined_usage_periods: CombinedUsagePeriod[] = sorted
    .slice()
    .reverse()
    .map((bill) => ({
      period_label:
        bill.billing_period_start && bill.billing_period_end
          ? `${fmt_date(bill.billing_period_start)} – ${fmt_date(bill.billing_period_end)}`
          : (bill.billing_period_start ?? bill.billing_period_end ?? "Unknown period"),
      kwh: bill.total_kwh,
      days: bill.billing_period_days,
    }));

  const totalKwh =
    bills.reduce((s, b) => s + (b.total_kwh ?? 0), 0) || null;
  const totalDays =
    bills.reduce((s, b) => s + (b.billing_period_days ?? 0), 0) || null;
  const dailyAvg = totalKwh && totalDays ? totalKwh / totalDays : null;

  const tariff = primary.tariff_rate ?? 0;
  const supply = primary.daily_supply_charge ?? 0;
  const annualSpend =
    dailyAvg !== null
      ? dailyAvg * tariff * 365 + supply * 365
      : primary.annual_spend;

  const starts = bills
    .map((b) => b.billing_period_start)
    .filter(Boolean) as string[];
  const ends = bills
    .map((b) => b.billing_period_end)
    .filter(Boolean) as string[];
  const period_covered_start = starts.length ? [...starts].sort()[0] : null;
  const period_covered_end = ends.length
    ? [...ends].sort().reverse()[0]
    : null;

  return {
    ...primary,
    total_kwh: totalKwh,
    daily_avg_kwh: dailyAvg,
    annual_spend: annualSpend,
    has_solar: bills.some((b) => b.has_solar),
    bill_count: bills.length,
    combined_usage_periods,
    period_covered_start,
    period_covered_end,
    total_days_covered: totalDays,
  };
}

function PanelShell({
  badge,
  rightSlot,
  children,
}: {
  badge?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Bill Data
          {badge && (
            <span className="ml-2 text-muted-foreground"> · {badge}</span>
          )}
        </h2>
        {rightSlot}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
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

// Editable tariff rate — the installer can correct the parsed value. Commits on
// blur / Enter; the parent applies the override and records a gold-label correction.
function EditableTariffRow({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  function commit() {
    const t = text.trim();
    if (t === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(t);
    if (!isFinite(parsed) || parsed < 0) {
      setText(value === null ? "" : String(value)); // revert garbage
      return;
    }
    if (parsed !== value) onCommit(parsed);
  }

  return (
    <div className="flex items-center border-b border-white/5 py-2 last:border-b-0">
      <div className="w-2/5 text-sm text-muted-foreground">Tariff rate</div>
      <div className="flex w-3/5 items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Tariff rate in dollars per kWh"
          className="w-24 rounded-md border border-white/10 bg-transparent px-2 py-1 text-sm font-medium text-foreground focus:border-enrg-amber focus:outline-none"
        />
        <span className="text-sm text-muted-foreground">/ kWh</span>
        {value === null && (
          <span className="text-xs text-enrg-amber">not found — enter to correct</span>
        )}
      </div>
    </div>
  );
}

export default function BillPanel() {
  const setBillData = useDashboardStore((s) => s.setBillData);
  const setCustomerInputs = useDashboardStore((s) => s.setCustomerInputs);
  const recordCorrection = useDashboardStore((s) => s.recordCorrection);
  const existingBillData = useDashboardStore.getState().billData;
  const inputRef = useRef<HTMLInputElement>(null);
  // The tariff_rate as originally parsed (gold-label baseline for corrections).
  const originalTariffRef = useRef<number | null>(
    existingBillData?.tariff_rate ?? null,
  );
  const lastCorrectedTariffRef = useRef<number | null>(null);
  const [state, setState] = useState<PanelState>(existingBillData ? "success" : "idle");
  const [mergedData, setMergedData] = useState<MergedBillData | null>(existingBillData);
  const [loadingFiles, setLoadingFiles] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [failedFiles, setFailedFiles] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  function reset() {
    setState("idle");
    setMergedData(null);
    setLoadingFiles([]);
    setErrorMsg("");
    setFailedFiles([]);
    setBillData(null);
    const currentInputs = useDashboardStore.getState().customerInputs;
    setCustomerInputs({
      ...currentInputs,
      propertyAddress: "",
      customerName: "",
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFiles(files: File[]) {
    try {
      if (files.length === 0) return;

      if (files.length > MAX_FILES) {
        setErrorMsg(`Maximum ${MAX_FILES} bills at once`);
        setState("error");
        return;
      }

      const valid: File[] = [];
      const invalid: string[] = [];
      for (const f of files) {
        if (!isAcceptedFile(f)) {
          invalid.push(`${f.name} — unsupported file type`);
        } else if (f.size > MAX_BYTES) {
          invalid.push(`${f.name} — exceeds 10 MB`);
        } else {
          valid.push(f);
        }
      }

      if (valid.length === 0) {
        setErrorMsg(invalid.join("\n") || "No valid files");
        setState("error");
        return;
      }

      setState("loading");
      setLoadingFiles(valid.map((f) => f.name));
      setErrorMsg("");
      setFailedFiles([]);

      const results = await Promise.allSettled(valid.map((f) => parseBill(f)));

      const successes: BillData[] = [];
      const failures: string[] = [...invalid];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          successes.push(r.value);
        } else {
          const reason =
            r.reason instanceof TypeError
              ? "could not connect to API"
              : r.reason instanceof Error
                ? r.reason.message
                : "parse failed";
          failures.push(`${valid[i].name} — ${reason}`);
        }
      });

      if (successes.length === 0) {
        setErrorMsg(failures.join("\n"));
        setState("error");
        return;
      }

      const merged = mergeBillData(successes);
      setMergedData(merged);
      setBillData(merged);
      // Baseline for tariff_rate override corrections (the parsed value).
      originalTariffRef.current = merged.tariff_rate;
      lastCorrectedTariffRef.current = null;

      const currentInputs = useDashboardStore.getState().customerInputs;
      setCustomerInputs({
        ...currentInputs,
        propertyAddress:
          merged.property_address ?? currentInputs.propertyAddress,
        customerName: merged.customer_name ?? currentInputs.customerName,
      });

      setFailedFiles(failures);
      setState("success");
    } catch (err) {
      if (err instanceof TypeError) {
        setErrorMsg(
          "Could not connect to the API. Make sure the backend is running on port 8000.",
        );
      } else if (err instanceof Error) {
        setErrorMsg(err.message || "Parse failed");
      } else {
        setErrorMsg("Something went wrong. Please refresh and try again.");
      }
      setState("error");
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length) handleFiles(files);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files
      ? Array.from(e.dataTransfer.files)
      : [];
    if (files.length) handleFiles(files);
  }

  if (state === "idle") {
    return (
      <PanelShell>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer ${
            dragOver
              ? "border-solid border-enrg-amber bg-enrg-amber/5"
              : "border-white/15 hover:border-white/30"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-10 w-10 text-enrg-amber"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 7.5m0 0L7.5 12M12 7.5v9"
            />
          </svg>
          <p className="text-sm font-medium text-foreground">
            Drop up to {MAX_FILES} bills here, or click to browse
          </p>
          <p className="text-xs text-muted-foreground">
            Upload quarterly bills for a full year of data · PDF, JPG, PNG · max 10 MB each
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            className="mt-3 rounded-md bg-enrg-gradient px-4 py-2 text-sm font-medium text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
          >
            Browse File
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            onChange={onInputChange}
            className="hidden"
          />
        </div>
      </PanelShell>
    );
  }

  if (state === "loading") {
    return (
      <PanelShell>
        <div className="flex flex-col items-center justify-center gap-4 py-10">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-enrg-amber" />
          <div className="w-full max-w-md space-y-1">
            {loadingFiles.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2 text-xs"
              >
                <span className="truncate text-foreground">{name}</span>
                <span className="ml-3 shrink-0 text-muted-foreground">
                  Parsing...
                </span>
              </div>
            ))}
          </div>
        </div>
      </PanelShell>
    );
  }

  if (state === "error") {
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
            Could not parse this bill.
          </p>
          {errorMsg && (
            <pre className="max-w-md whitespace-pre-wrap text-left text-xs text-muted-foreground">
              {errorMsg}
            </pre>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded-md bg-enrg-gradient px-4 py-2 text-sm font-medium text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
          >
            Try Again
          </button>
        </div>
      </PanelShell>
    );
  }

  // success
  const d = mergedData!;
  const multi = d.bill_count > 1;

  // Installer corrects the parsed tariff rate: apply the override downstream (store)
  // and record it as a gold-label correction (source_module "bill").
  function handleTariffEdit(newValue: number | null) {
    if (!mergedData) return;
    const updated = { ...mergedData, tariff_rate: newValue };
    setMergedData(updated);
    setBillData(updated);

    const original = originalTariffRef.current;
    if (newValue !== original && newValue !== lastCorrectedTariffRef.current) {
      lastCorrectedTariffRef.current = newValue;
      recordCorrection({
        source_module: "bill",
        field_path: "tariff_rate",
        original_value: original === null ? null : String(original),
        corrected_value: newValue === null ? null : String(newValue),
        value_type: "float",
      });
    }
  }

  return (
    <PanelShell
      badge={multi ? `${d.bill_count} bills` : undefined}
      rightSlot={
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
        >
          Upload Another
        </button>
      }
    >
      {failedFiles.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          <div className="mb-1 font-medium">
            {failedFiles.length}{" "}
            file{failedFiles.length === 1 ? "" : "s"} could not be processed:
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {failedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="divide-y divide-white/5">
        <Row label="Retailer" value={d.retailer ?? "—"} />
        <Row label="Plan" value={d.plan_name ?? "—"} />
        <EditableTariffRow value={d.tariff_rate} onCommit={handleTariffEdit} />
        <Row label="Feed-in tariff" value={fmt_tariff(d.feed_in_tariff)} />
        <Row label="Supply charge" value={fmt_daily(d.daily_supply_charge)} />
        {multi ? (
          <Row
            label="Period covered"
            value={fmt_period_covered(
              d.period_covered_start,
              d.period_covered_end,
            )}
          />
        ) : (
          <Row
            label="Billing period"
            value={fmt_period_single(
              d.billing_period_start,
              d.billing_period_end,
              d.billing_period_days,
            )}
          />
        )}
        <Row label="Total usage" value={fmt_total_kwh(d.total_kwh)} />
        <Row label="Daily average" value={fmt_daily_avg(d.daily_avg_kwh)} />
        <Row label="Annual spend (est.)" value={fmt_annual(d.annual_spend)} />
        <Row label="Existing solar" value={d.has_solar ? "Yes" : "No"} />
        {d.nmi && <Row label="NMI" value={d.nmi} />}
      </div>

    </PanelShell>
  );
}
