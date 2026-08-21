"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { NoticeStack } from "@/components/ui/notice-stack";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestJson } from "@/lib/client-api";
import { clientActionErrorCopy, type ApiErrorKind } from "@/lib/jobs";
import {
  EMPTY_TARIFF_WINDOW_ROW,
  TARIFF_BOUNDS,
  TARIFF_DAYS_VALUES,
  TARIFF_WINDOW_LABELS,
  isTariffTime,
  tariffSaveNotices,
  type RoofNoticeView,
  type TariffNetworkView,
  type TariffWindowFormRow,
  type SizingInputSave,
} from "@/lib/worksheet";

/**
 * Tariff & network (checklist 3.8) — the financial envelope: what power costs,
 * what export earns, and how much the network lets this house send back.
 *
 * The database is the single source of truth. The server page hands in the
 * view (stored row over lookup default, per field), saving POSTs the seven
 * fields TariffSaveRequest accepts, then router.refresh() re-reads. There is no
 * store and nothing persisted client-side — section state is local React state.
 *
 * THE EXPORT LIMIT IS A NUMBER ONLY (Mayur, 2026-08-18). No fixed-or-flexible
 * dropdown, not even disabled: flexible and dynamic export is checklist 4.4 and
 * builds the whole control there. A greyed placeholder protects nobody — no
 * installer sees this platform before every stage ships — and would be built
 * twice. The v4 wireframe's `5.0 kW · fixed/flexible ▾` is superseded.
 *
 * A `saved: false` response NEVER reads as success: the section's completeness
 * predicate reads the database, so a false success is the worst outcome
 * available here. tariffSaveNotices classifies the response in the logic layer.
 */

const LABEL_OPTIONS: { value: string; label: string }[] = [
  { value: "peak", label: "Peak" },
  { value: "shoulder", label: "Shoulder" },
  { value: "offpeak", label: "Off-peak" },
  { value: "flat", label: "Flat" },
];

const DAYS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All days" },
  { value: "weekday", label: "Weekdays" },
  { value: "weekend", label: "Weekends" },
];

interface FormState {
  tariffType: "flat" | "tou";
  importRate: string;
  supplyCharge: string;
  fitRate: string;
  exportLimitKw: string;
  windows: TariffWindowFormRow[];
}

function fromView(view: TariffNetworkView): FormState {
  return {
    // Flat is the default on a job with no stored row — the common case, and
    // the one that needs the fewest keystrokes.
    tariffType: view.tariffType ?? "flat",
    importRate: view.importRate.text,
    supplyCharge: view.supplyCharge.text,
    fitRate: view.fitRate.text,
    exportLimitKw: view.exportLimitKw.text,
    windows: view.windows.map((w) => ({ ...w })),
  };
}

/** 409/422/503 carry a plain-English `detail` written for exactly this — show
    the backend's own words rather than a generic sentence over the top. */
function saveErrorCopy(kind: ApiErrorKind, status: number, message: string) {
  if (kind === "http" && message && (status === 409 || status === 422 || status === 503)) {
    return { heading: "That didn't save", body: message };
  }
  return clientActionErrorCopy(kind, status);
}

export function TariffNetworkSection({
  view,
  jobId,
  onSaved,
}: {
  view: TariffNetworkView;
  jobId: string;
  /** 3.14 prompt 6 (D37): called after a PERSISTED save so the results rail
      can answer "what did that change do". Optional — absent means silent,
      and the rail keeps showing the stored run. */
  onSaved?: (change: SizingInputSave) => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => fromView(view));
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [saveNotices, setSaveNotices] = React.useState<readonly RoofNoticeView[]>([]);
  const [savedTick, setSavedTick] = React.useState(false);

  const baseline = React.useMemo(() => fromView(view), [view]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  function touch() {
    setSavedTick(false);
    setSaveNotices([]);
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
    touch();
  }

  function setWindow(index: number, key: keyof TariffWindowFormRow, value: string) {
    setForm((f) => ({
      ...f,
      windows: f.windows.map((w, i) => (i === index ? { ...w, [key]: value } : w)),
    }));
    setErrors((e) => ({ ...e, [`w${index}.${key}`]: "" }));
    touch();
  }

  function chooseType(next: "flat" | "tou") {
    setForm((f) => ({
      ...f,
      tariffType: next,
      // Switching to time of use with nothing stored seeds the two rows the
      // backend requires, so the minimum is visible rather than an error.
      windows:
        next === "tou" && f.windows.length === 0
          ? [{ ...EMPTY_TARIFF_WINDOW_ROW }, { ...EMPTY_TARIFF_WINDOW_ROW }]
          : f.windows,
    }));
    setErrors({});
    touch();
  }

  function addWindow() {
    setForm((f) => ({ ...f, windows: [...f.windows, { ...EMPTY_TARIFF_WINDOW_ROW }] }));
    touch();
  }

  function removeWindow(index: number) {
    setForm((f) => ({ ...f, windows: f.windows.filter((_, i) => i !== index) }));
    setErrors({});
    touch();
  }

  function boundError(
    text: string,
    bound: { min: number; max: number; message: string },
  ): string | null {
    if (text.trim() === "") return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value < bound.min || value > bound.max) {
      return bound.message;
    }
    return null;
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (form.tariffType === "flat" && form.importRate.trim() === "") {
      next.importRate = "A flat tariff needs its import rate.";
    }
    if (form.tariffType === "tou" && form.windows.length < 2) {
      next.windows =
        "A time-of-use tariff needs at least two windows. With one window it is a flat tariff — choose Flat instead.";
    }
    const importError = boundError(form.importRate, TARIFF_BOUNDS.importRate);
    if (importError) next.importRate = importError;
    const supplyError = boundError(form.supplyCharge, TARIFF_BOUNDS.supplyCharge);
    if (supplyError) next.supplyCharge = supplyError;
    const fitError = boundError(form.fitRate, TARIFF_BOUNDS.fitRate);
    if (fitError) next.fitRate = fitError;
    const exportError = boundError(form.exportLimitKw, TARIFF_BOUNDS.exportLimitKw);
    if (exportError) next.exportLimitKw = exportError;

    if (form.tariffType === "tou") {
      form.windows.forEach((w, i) => {
        if (w.rate.trim() === "") {
          next[`w${i}.rate`] = "Every window needs its rate.";
        } else {
          const rateError = boundError(w.rate, TARIFF_BOUNDS.windowRate);
          if (rateError) next[`w${i}.rate`] = rateError;
        }
        if (!isTariffTime(w.start)) next[`w${i}.start`] = "Enter a time like 18:00.";
        if (!isTariffTime(w.end)) next[`w${i}.end`] = "Enter a time like 18:00.";
      });
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const numberOrNull = (text: string): number | null =>
    text.trim() === "" ? null : Number(text);

  async function save() {
    if (saving || !dirty) return;
    if (!validate()) return; // never submit a knowingly invalid body
    setSaving(true);
    setActionError(null);
    setSaveNotices([]);
    try {
      const tou = form.tariffType === "tou";
      const payload = {
        tariff_type: form.tariffType,
        import_rate: tou ? null : numberOrNull(form.importRate),
        tou_windows: tou
          ? form.windows.map((w) => ({
              label: w.label || "peak",
              rate: Number(w.rate),
              // Local clock time, verbatim — no rotation, no conversion.
              start: w.start.trim(),
              end: w.end.trim(),
              days: w.days || "all",
            }))
          : null,
        supply_charge: numberOrNull(form.supplyCharge),
        fit_aud_per_kwh: numberOrNull(form.fitRate),
        export_limit_kw: numberOrNull(form.exportLimitKw),
        // Anything a person typed or accepted on this screen is "installer".
        source: "installer",
      };
      const result = await requestJson<Record<string, unknown>>(
        "POST",
        `/api/job/${encodeURIComponent(jobId)}/tariff`,
        payload,
      );
      if (!result.ok) {
        const copy = saveErrorCopy(result.kind, result.status, result.message);
        setActionError({ ...copy, isAuth: result.kind === "auth" });
        return; // values intact, no navigation
      }
      const notices = tariffSaveNotices(result.data);
      setSaveNotices(notices);
      if (result.data.saved === false) return; // never reads as success
      setSavedTick(true);
      onSaved?.({ kind: "physics" }); // tariff, feed-in, export limit: re-cost
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // Merge the view's notices with this attempt's, deduped by title so the
  // always-on address-lock caption is not shown twice after a save. NoticeStack
  // does the D25 ordering.
  const notices: RoofNoticeView[] = [];
  const seen = new Set<string>();
  for (const notice of [...saveNotices, ...view.notices]) {
    if (seen.has(notice.title)) continue;
    seen.add(notice.title);
    notices.push(notice);
  }

  const network = [view.dnsp, view.state_, view.postcode]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");

  /** An option list that keeps a stored value outside the list, selected and
      labelled — the same behaviour site-details-section gives roof material. */
  function withStored(
    options: readonly { value: string; label: string }[],
    value: string,
  ): { value: string; label: string }[] {
    const out = [...options];
    if (value && !out.some((o) => o.value === value)) {
      out.push({ value, label: `${value} (as stored)` });
    }
    return out;
  }

  const numberField = (
    id: string,
    label: string,
    key: "importRate" | "supplyCharge" | "fitRate" | "exportLimitKw",
    unit: string,
    step: string, // derived from the field's unit and its TARIFF_BOUNDS range
    placeholder: string, // every numeric placeholder carries "e.g." (F78)
    note?: React.ReactNode,
  ) => (
    <div>
      <label className="text-caption text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={id}
          className="w-[130px]"
          type="number"
          inputMode="decimal"
          step={step}
          placeholder={placeholder}
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
        />
        <span className="text-caption text-muted-foreground">{unit}</span>
      </div>
      {errors[key] ? (
        <p className="mt-1 max-w-[320px] text-caption text-destructive">{errors[key]}</p>
      ) : null}
      {note}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        The financial envelope: what power costs, what export earns, and how much
        the network lets this house send back.
      </p>

      {/* Tariff type — two options, Flat default. */}
      <fieldset>
        <legend className="text-caption text-muted-foreground">Tariff</legend>
        <div className="mt-1 flex items-center gap-4">
          {(
            [
              ["flat", "Flat"],
              ["tou", "Time of use"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-body text-foreground">
              <input
                type="radio"
                name="tariff-type"
                value={value}
                checked={form.tariffType === value}
                onChange={() => chooseType(value)}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {form.tariffType === "flat" ? (
        <div className="flex flex-wrap items-start gap-4">
          {numberField(
            "tariff-import-rate",
            "Import rate",
            "importRate",
            "$/kWh",
            "0.01",
            "e.g. 0.42",
          )}
          {numberField(
            "tariff-supply-charge",
            "Supply charge",
            "supplyCharge",
            "$/day",
            "0.01",
            "e.g. 1.05",
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2">
            {form.windows.map((w, i) => (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <div>
                  {i === 0 ? (
                    <label className="text-caption text-muted-foreground">Label</label>
                  ) : null}
                  <div className="mt-1 w-[130px]">
                    <Select
                      value={w.label}
                      onValueChange={(v) => setWindow(i, "label", v)}
                    >
                      <SelectTrigger aria-label={`Window ${i + 1} label`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {withStored(LABEL_OPTIONS, w.label).map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  {i === 0 ? (
                    <label className="text-caption text-muted-foreground">Rate $/kWh</label>
                  ) : null}
                  <Input
                    className="mt-1 w-[110px]"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    placeholder="e.g. 0.55"
                    aria-label={`Window ${i + 1} rate`}
                    value={w.rate}
                    onChange={(e) => setWindow(i, "rate", e.target.value)}
                  />
                  {errors[`w${i}.rate`] ? (
                    <p className="mt-1 max-w-[200px] text-caption text-destructive">
                      {errors[`w${i}.rate`]}
                    </p>
                  ) : null}
                </div>
                <div>
                  {i === 0 ? (
                    <label className="text-caption text-muted-foreground">From</label>
                  ) : null}
                  <Input
                    className="mt-1 w-[90px]"
                    placeholder="e.g. 18:00"
                    aria-label={`Window ${i + 1} start`}
                    value={w.start}
                    onChange={(e) => setWindow(i, "start", e.target.value)}
                  />
                  {errors[`w${i}.start`] ? (
                    <p className="mt-1 max-w-[200px] text-caption text-destructive">
                      {errors[`w${i}.start`]}
                    </p>
                  ) : null}
                </div>
                <div>
                  {i === 0 ? (
                    <label className="text-caption text-muted-foreground">To</label>
                  ) : null}
                  <Input
                    className="mt-1 w-[90px]"
                    placeholder="e.g. 21:00"
                    aria-label={`Window ${i + 1} end`}
                    value={w.end}
                    onChange={(e) => setWindow(i, "end", e.target.value)}
                  />
                  {errors[`w${i}.end`] ? (
                    <p className="mt-1 max-w-[200px] text-caption text-destructive">
                      {errors[`w${i}.end`]}
                    </p>
                  ) : null}
                </div>
                <div>
                  {i === 0 ? (
                    <label className="text-caption text-muted-foreground">Days</label>
                  ) : null}
                  <div className="mt-1 w-[130px]">
                    <Select value={w.days} onValueChange={(v) => setWindow(i, "days", v)}>
                      <SelectTrigger aria-label={`Window ${i + 1} days`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {withStored(DAYS_OPTIONS, w.days).map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className={i === 0 ? "mt-[22px]" : ""}>
                  <button
                    type="button"
                    onClick={() => removeWindow(i)}
                    className="rounded-md border border-border px-2.5 py-1.5 text-caption text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          {errors.windows ? (
            <p className="max-w-[520px] text-caption text-destructive">{errors.windows}</p>
          ) : null}
          <div>
            <button
              type="button"
              onClick={addWindow}
              className="rounded-md border border-border px-2.5 py-1 text-caption text-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              + Add window
            </button>
          </div>
          <div className="flex flex-wrap items-start gap-4">
            {numberField(
              "tariff-supply-charge",
              "Supply charge",
              "supplyCharge",
              "$/day",
              "0.01",
              "e.g. 1.05",
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {numberField(
          "tariff-fit",
          "Feed-in tariff",
          "fitRate",
          "$/kWh",
          "0.01",
          "e.g. 0.05",
          view.fitSourceLabel ? (
            <p className="mt-1 max-w-[260px] text-caption text-muted-foreground">
              {view.fitSourceLabel}
            </p>
          ) : null,
        )}
        {numberField(
          "tariff-export-limit",
          "Export limit",
          "exportLimitKw",
          "kW",
          "0.1",
          "e.g. 5",
          view.exportSourceLabel ? (
            <p className="mt-1 max-w-[260px] text-caption text-muted-foreground">
              {view.exportSourceLabel}
            </p>
          ) : null,
        )}
      </div>

      {/* C&I, behind SHOW_CI_TARIFF_ROWS — ABSENT from the DOM when off, not
          greyed and not hidden with CSS. Prefill only until 10.5 wires the save. */}
      {view.ci ? (
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <label className="text-caption text-muted-foreground" htmlFor="tariff-demand-rate">
              Demand charge
            </label>
            <Input
              id="tariff-demand-rate"
              className="mt-1 w-[130px]"
              type="number"
              inputMode="decimal"
              step="0.01"
              placeholder="e.g. 12.50"
              defaultValue={view.ci.demandChargeRate.text}
              readOnly
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground" htmlFor="tariff-demand-threshold">
              Demand threshold (kW)
            </label>
            <Input
              id="tariff-demand-threshold"
              className="mt-1 w-[130px]"
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder="e.g. 30"
              defaultValue={view.ci.demandThresholdKw.text}
              readOnly
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground" htmlFor="tariff-negotiated-export">
              Negotiated export (kW)
            </label>
            <Input
              id="tariff-negotiated-export"
              className="mt-1 w-[130px]"
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder="e.g. 30"
              defaultValue={view.ci.negotiatedExportKw.text}
              readOnly
            />
          </div>
        </div>
      ) : null}

      {network ? (
        <div>
          <span className="text-caption text-muted-foreground">Network</span>
          <p className="text-body text-foreground">{network}</p>
        </div>
      ) : null}

      <NoticeStack items={notices} />

      {actionError ? (
        <Notice tone="problem" title={actionError.heading}>
          {actionError.body}
          {actionError.isAuth ? (
            <>
              {" "}
              <Link href="/login" className="text-primary underline">
                Go to sign in
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save tariff & network"}
        </Button>
        {dirty ? (
          <span className="text-caption text-muted-foreground">Unsaved changes</span>
        ) : savedTick ? (
          <span className="text-caption text-muted-foreground">Saved</span>
        ) : null}
      </div>
    </div>
  );
}
