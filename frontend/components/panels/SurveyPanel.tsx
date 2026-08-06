"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  type Appliance,
  type HotWater,
  type HouseholdSize,
  type SurveyInputs,
  type SurveyOccupancy,
  type TariffType,
} from "@/lib/api";
import { useDashboardStore } from "@/lib/store";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Full 24-hour grid — all columns user-editable, no forced overrides.
const VISIBLE_HOURS: number[] = Array.from({ length: 24 }, (_, i) => i);
const VISIBLE_CELL_COUNT = 7 * 24; // 168

// Show labels only at every 3rd column to avoid crowding.
const HOUR_LABEL_MAP: Record<number, string> = {
  0: "12am",
  3: "3am",
  6: "6am",
  9: "9am",
  12: "12pm",
  15: "3pm",
  18: "6pm",
  21: "9pm",
};

function hourLabel(h: number): string {
  return HOUR_LABEL_MAP[h] ?? "";
}

function buildPresetGrid(preset: SurveyOccupancy): number[][] {
  return Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      if (preset === "always_home") return 1;
      const weekday = day < 5;
      if (preset === "away_weekdays") {
        return weekday && hour >= 9 && hour <= 16 ? 0 : 1;
      }
      // shift_work — retained for backwards-compat (not shown as a preset button)
      if (weekday && ((hour >= 6 && hour <= 7) || (hour >= 21 && hour <= 22))) {
        return 0;
      }
      return 1;
    }),
  );
}

function buildClearedGrid(): number[][] {
  return Array.from({ length: 7 }, () => Array<number>(24).fill(0));
}

function gridsEqual(a: number[][], b: number[][]): boolean {
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if ((a[d]?.[h] ?? 0) !== (b[d]?.[h] ?? 0)) return false;
    }
  }
  return true;
}

const PRESETS: SurveyOccupancy[] = [
  "always_home",
  "away_weekdays",
  "shift_work",
];

function detectPreset(grid: number[][]): SurveyOccupancy | null {
  for (const p of PRESETS) {
    if (gridsEqual(grid, buildPresetGrid(p))) return p;
  }
  return null;
}

function homePct(grid: number[][]): number {
  let count = 0;
  for (let d = 0; d < 7; d++) {
    for (const h of VISIBLE_HOURS) {
      if (grid[d]?.[h] === 1) count++;
    }
  }
  return Math.round((count / VISIBLE_CELL_COUNT) * 100);
}

const HOUSEHOLD_OPTIONS: { value: HouseholdSize; label: string }[] = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3-4", label: "3–4" },
  { value: "5+", label: "5+" },
];

const HOT_WATER_OPTIONS: {
  value: HotWater;
  label: string;
  description?: string;
}[] = [
  {
    value: "electric_storage",
    label: "Electric storage",
    description: "Most common, resistive element",
  },
  {
    value: "gas",
    label: "Gas",
    description: "Gas-heated storage tank",
  },
  {
    value: "heat_pump",
    label: "Heat pump",
    description: "High efficiency, pairs well with solar",
  },
  {
    value: "solar_hws",
    label: "Solar HWS",
    description: "Solar thermal hot water system",
  },
];

const APPLIANCE_OPTIONS: { value: Appliance; label: string }[] = [
  { value: "ev", label: "EV" },
  { value: "pool_pump", label: "Pool pump" },
  { value: "ducted_ac", label: "Ducted A/C" },
];

const OCCUPANCY_OPTIONS: { value: SurveyOccupancy; label: string }[] = [
  { value: "always_home", label: "Always home" },
  { value: "away_weekdays", label: "Away weekdays (9–5)" },
];

const OCCUPANCY_LABEL: Record<SurveyOccupancy, string> = {
  always_home: "Always Home",
  away_weekdays: "Away Weekdays (9–5)",
  shift_work: "Shift Work / Irregular",
};

const TARIFF_OPTIONS: {
  value: TariffType;
  label: string;
  description?: string;
}[] = [
  {
    value: "single_rate",
    label: "Single rate",
    description: "One flat rate all day",
  },
  {
    value: "tou",
    label: "Time of use",
    description: "Peak, shoulder and off-peak rates",
  },
  {
    value: "demand",
    label: "Demand tariff",
    description: "Charged on peak demand (kW)",
  },
  {
    value: "not_sure",
    label: "Not sure",
    description: "We'll use a single rate estimate",
  },
];

const HOUSEHOLD_LABEL: Record<HouseholdSize, string> = {
  "1": "1 person",
  "2": "2 people",
  "3-4": "3–4 people",
  "5+": "5+ people",
};

const HOT_WATER_LABEL: Record<HotWater, string> = {
  electric_storage: "Electric HWS",
  gas: "Gas HWS",
  heat_pump: "Heat pump HWS",
  solar_hws: "Solar HWS",
};

const APPLIANCE_LABEL: Record<Appliance, string> = {
  ev: "EV",
  pool_pump: "Pool pump",
  ducted_ac: "Ducted A/C",
};

const OCCUPANCY_LABEL_SHORT: Record<SurveyOccupancy, string> = {
  always_home: "Home daytime",
  away_weekdays: "Away weekdays",
  shift_work: "Shift work",
};

const TARIFF_LABEL_SHORT: Record<TariffType, string> = {
  single_rate: "Flat",
  tou: "TOU",
  demand: "Demand",
  not_sure: "Tariff TBD",
};

const DEFAULT_FORM: SurveyInputs = {
  household_size: "3-4",
  hot_water: "gas",
  appliances: [],
  occupancy: "away_weekdays",
  tariff_type: "single_rate",
  occupancy_grid: buildPresetGrid("away_weekdays"),
};

function summarise(s: SurveyInputs): string {
  const parts: string[] = [HOUSEHOLD_LABEL[s.household_size]];
  parts.push(HOT_WATER_LABEL[s.hot_water]);
  if (s.appliances.length > 0) {
    parts.push(s.appliances.map((a) => APPLIANCE_LABEL[a]).join(" + "));
  }
  parts.push(OCCUPANCY_LABEL_SHORT[s.occupancy]);
  parts.push(TARIFF_LABEL_SHORT[s.tariff_type]);
  return parts.join("  ·  ");
}

export default function SurveyPanel() {
  const saved = useDashboardStore((s) => s.surveyInputs);
  const setSurveyInputs = useDashboardStore((s) => s.setSurveyInputs);
  const setLoadData = useDashboardStore((s) => s.setLoadData);

  const [form, setForm] = useState<SurveyInputs>(() => hydrate(saved));

  function update<K extends keyof SurveyInputs>(
    key: K,
    value: SurveyInputs[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setGrid(
    updater: number[][] | ((prev: number[][]) => number[][]),
  ) {
    setForm((prev) => {
      const current = prev.occupancy_grid ?? buildPresetGrid(prev.occupancy);
      const next =
        typeof updater === "function" ? updater(current) : updater;
      return { ...prev, occupancy_grid: next };
    });
  }

  function handlePresetClick(preset: SurveyOccupancy) {
    setForm((f) => ({
      ...f,
      occupancy: preset,
      occupancy_grid: buildPresetGrid(preset),
    }));
  }

  function handleClearAll() {
    // Wipe the editable range (6–22). Keeps form.occupancy untouched so the
    // backend's string fallback still has a sensible value; the preset button
    // highlight is driven by grid match, so it correctly de-highlights.
    setGrid(buildClearedGrid());
  }

  function toggleAppliance(a: Appliance) {
    setForm((f) => {
      const has = f.appliances.includes(a);
      const next = has
        ? f.appliances.filter((x) => x !== a)
        : [...f.appliances, a];
      return { ...f, appliances: next };
    });
  }

  function handleSave() {
    setSurveyInputs(form);
    setLoadData(null); // force LoadProfilePanel to re-fetch
  }

  const currentGrid =
    form.occupancy_grid ?? buildPresetGrid(form.occupancy);
  const activePreset = detectPreset(currentGrid);
  const pctHome = homePct(currentGrid);
  const accuracyLabel = activePreset
    ? `Preset (${pctHome}% home)`
    : `Detailed (${pctHome}% home)`;
  const accuracyDescription = activePreset
    ? `Using ${OCCUPANCY_LABEL[activePreset]} pattern. Fine-tune by painting cells above.`
    : "Using your hourly schedule. Solar self-consumption ratio calculated precisely.";

  return (
    <div>
      <div className="px-6 pb-4">
        <h2 className="text-sm font-semibold text-foreground">
          Load Survey
        </h2>
      </div>

      {/* Section 1: Household */}
          <div className="grid grid-cols-1 gap-8 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
            <div className="md:col-span-1">
              <h3 className="text-sm font-semibold text-foreground">
                Household
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Helps estimate baseline consumption.
              </p>
            </div>
            <div className="md:col-span-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="People in the home">
                  <ToggleGroup
                    options={HOUSEHOLD_OPTIONS}
                    value={form.household_size}
                    onChange={(v) => update("household_size", v)}
                  />
                </Field>

                <Field label="Hot water">
                  <CardSelector
                    options={HOT_WATER_OPTIONS}
                    value={form.hot_water}
                    onChange={(v) => update("hot_water", v)}
                    cols={2}
                  />
                </Field>
              </div>
            </div>
          </div>

          {/* Section 2: Appliances */}
          <div className="grid grid-cols-1 gap-8 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
            <div className="md:col-span-1">
              <h3 className="text-sm font-semibold text-foreground">
                Appliances
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Select all that apply.
              </p>
            </div>
            <div className="md:col-span-2">
              <div className="divide-y divide-white/5 rounded-md border border-white/10">
                {APPLIANCE_OPTIONS.map((opt) => {
                  const checked = form.appliances.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/5"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                          checked
                            ? "border-enrg-amber bg-enrg-amber"
                            : "border-white/20 bg-transparent"
                        }`}
                      >
                        {checked && (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
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
                        checked={checked}
                        onChange={() => toggleAppliance(opt.value)}
                        className="sr-only"
                        aria-label={opt.label}
                      />
                      <span className="text-sm text-foreground">{opt.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Section 3: Occupancy — full-width content */}
          <div className="border-t border-white/[0.06] px-6 py-6">
            <div className="mb-4 md:max-w-md">
              <h3 className="text-sm font-semibold text-foreground">
                Occupancy
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                When is someone typically home? This is the primary driver of
                battery ROI accuracy.
              </p>
            </div>
            <div className="space-y-4">
              <InfoBox />

              <div className="flex flex-wrap items-center gap-2">
                {OCCUPANCY_OPTIONS.map((o) => (
                  <Toggle
                    key={o.value}
                    selected={activePreset === o.value}
                    onClick={() => handlePresetClick(o.value)}
                    label={o.label}
                  />
                ))}
                <div className="ml-auto">
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="rounded-md border border-white/20 bg-transparent px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
                  >
                    Clear All
                  </button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Click hours when someone is typically home
              </p>

              <OccupancyGrid grid={currentGrid} setGrid={setGrid} />

              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm border border-enrg-amber/80 bg-enrg-amber/60" />
                  Home
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm border border-white/10 bg-white/5" />
                  Away
                </span>
              </div>

              <AccuracyBar
                pctHome={pctHome}
                label={accuracyLabel}
                description={accuracyDescription}
              />
            </div>
          </div>

          {/* Section 4: Tariff */}
          <div className="grid grid-cols-1 gap-8 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
            <div className="md:col-span-1">
              <h3 className="text-sm font-semibold text-foreground">Tariff</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                How your electricity is billed by your retailer.
              </p>
            </div>
            <div className="md:col-span-2">
              <CardSelector
                options={TARIFF_OPTIONS}
                value={form.tariff_type}
                onChange={(v) => update("tariff_type", v)}
                cols={2}
              />
            </div>
          </div>

          {/* Action row */}
          <div className="border-t border-white/[0.06] px-6 py-4">
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleSave}
                className="rounded-md bg-enrg-gradient px-4 py-2 text-sm font-medium text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
              >
                Save
              </button>
            </div>
          </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Toggle
          key={o.value}
          selected={value === o.value}
          onClick={() => onChange(o.value)}
          label={o.label}
        />
      ))}
    </div>
  );
}

function Toggle({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
        selected
          ? "border-enrg-amber bg-enrg-amber text-enrg-dark"
          : "border-white/10 bg-white/5 text-foreground hover:border-enrg-amber/40"
      }`}
    >
      {label}
    </button>
  );
}

function CardSelector<T extends string>({
  options,
  value,
  onChange,
  cols = 2,
}: {
  options: { value: T; label: string; description?: string }[];
  value: T;
  onChange: (v: T) => void;
  cols?: number;
}) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`relative rounded-lg border p-3 text-left transition-all ${
              selected
                ? "border-enrg-amber bg-enrg-amber/10"
                : "border-white/10 bg-white/5 hover:border-white/25"
            }`}
          >
            <span
              className={`absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                selected ? "border-enrg-amber" : "border-white/20"
              }`}
            >
              {selected && (
                <span className="h-2 w-2 rounded-full bg-enrg-amber" />
              )}
            </span>
            <span className="block pr-6 text-sm font-medium text-foreground">
              {opt.label}
            </span>
            {opt.description && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {opt.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function InfoBox() {
  return (
    <div className="flex items-start gap-3 rounded-md border border-enrg-blue/30 bg-enrg-blue/5 px-3 py-2.5 text-xs text-foreground">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-enrg-blue/60 text-[10px] font-bold text-enrg-blue"
      >
        i
      </span>
      <p className="leading-relaxed">
        <span className="font-medium">Want a more accurate estimate?</span>{" "}
        Map your typical weekly schedule hour-by-hour. This helps the model
        calculate exactly how much solar you&apos;ll self-consume vs export
        — the primary driver of battery ROI.
      </p>
    </div>
  );
}

function AccuracyBar({
  pctHome,
  label,
  description,
}: {
  pctHome: number;
  label: string;
  description: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Occupancy input accuracy
        </span>
        <span className="text-xs font-medium text-enrg-amber">{label}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-enrg-amber transition-all"
          style={{ width: `${pctHome}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function hydrate(saved: SurveyInputs | null): SurveyInputs {
  if (!saved) return DEFAULT_FORM;
  if (saved.occupancy_grid && saved.occupancy_grid.length === 7) {
    return saved;
  }
  return { ...saved, occupancy_grid: buildPresetGrid(saved.occupancy) };
}

function OccupancyGrid({
  grid,
  setGrid,
}: {
  grid: number[][];
  setGrid: (
    updater: number[][] | ((prev: number[][]) => number[][]),
  ) => void;
}) {
  const isPaintingRef = useRef(false);
  const paintValueRef = useRef<0 | 1>(1);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const stop = () => {
      isPaintingRef.current = false;
    };
    document.addEventListener("mouseup", stop);
    return () => document.removeEventListener("mouseup", stop);
  }, []);

  function paintAt(day: number, hour: number) {
    setGrid((prev) => {
      if (
        !prev[day] ||
        prev[day][hour] === undefined ||
        prev[day][hour] === paintValueRef.current
      ) {
        return prev;
      }
      return prev.map((row, d) =>
        d === day
          ? row.map((v, h) => (h === hour ? paintValueRef.current : v))
          : row,
      );
    });
  }

  function onCellMouseDown(
    day: number,
    hour: number,
    e: React.MouseEvent<HTMLButtonElement>,
  ) {
    e.preventDefault();
    try {
      const current = grid[day][hour];
      paintValueRef.current = current === 1 ? 0 : 1;
      isPaintingRef.current = true;
      paintAt(day, hour);
    } catch {
      // Defensive — leave grid state unchanged on any indexing error.
    }
  }

  function onCellMouseEnter(day: number, hour: number) {
    if (!isPaintingRef.current) return;
    try {
      paintAt(day, hour);
    } catch {
      // ignore
    }
  }

  const cellBase =
    "h-[22px] w-[26px] rounded-sm border transition-colors select-none";
  const cellHome =
    "bg-enrg-amber/60 border-enrg-amber/80 hover:bg-enrg-amber/80";
  const cellAway =
    "bg-white/5 border-white/10 hover:border-enrg-amber/40 hover:bg-white/10";

  return (
    <div className="inline-block max-w-full overflow-x-auto rounded-md border border-white/10 bg-enrg-dark p-3">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `40px repeat(${VISIBLE_HOURS.length}, 26px)`,
          gap: "1px",
        }}
      >
        <div />
        {VISIBLE_HOURS.map((h) => (
          <div
            key={`col-${h}`}
            className="text-center text-[10px] font-medium tabular-nums text-muted-foreground"
          >
            {hourLabel(h)}
          </div>
        ))}

        {DAY_LABELS.map((dayLabel, day) => (
          <Fragment key={`row-${day}`}>
            <div className="flex h-[22px] items-center pr-2 text-xs font-medium text-muted-foreground">
              {dayLabel}
            </div>
            {VISIBLE_HOURS.map((hour) => {
              const v = grid[day]?.[hour] ?? 0;
              const home = v === 1;
              return (
                <button
                  key={`cell-${day}-${hour}`}
                  type="button"
                  aria-label={`${dayLabel} ${hourLabel(hour)} ${home ? "home" : "away"}`}
                  onMouseDown={(e) => onCellMouseDown(day, hour, e)}
                  onMouseEnter={() => onCellMouseEnter(day, hour)}
                  className={`${cellBase} ${home ? cellHome : cellAway}`}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
