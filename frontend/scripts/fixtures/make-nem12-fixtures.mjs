#!/usr/bin/env node
/**
 * Regenerates the NEM12 fixtures used for the 3.6 / 3.6b browser checks and as
 * a design + regression instrument — committed so they can be REGENERATED
 * rather than trusted.
 *
 * Run from frontend/:  node scripts/fixtures/make-nem12-fixtures.mjs
 *
 * WHY THE SHAPE MATTERS (D27). The first version of this generator emitted one
 * identical reading every half hour for a year. Its average day was therefore
 * perfectly flat, every normalised weight was 1.0, and every chart drawn from
 * it was a solid block — so nobody could tell whether the chart worked. Worse,
 * against a flat profile an optimiser genuinely consuming the 8,760-hour series
 * and one silently falling back to an archetype produce IDENTICAL output, so
 * 3.7's verification could not have distinguished them.
 *
 * THE PROFILE BELOW IS MODELLED, NOT SOURCED. There is no authoritative
 * consumption dataset in this repo. The target annual total is a deliberately
 * ordinary figure for a detached South Australian home; it is a plausible
 * shape for drawing and regression, and it is NOT a claim about real
 * households. A generated NEM12 also proves only that we can read files WE
 * wrote — checklist 9.5 (verification against a real customer interval CSV)
 * stands unchanged and is not discharged by this.
 *
 * Deterministic by construction: a seeded PRNG, never Math.random, so the
 * committed fixtures are reproducible byte-for-byte.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The annualise threshold is READ from the parser, never hardcoded.
const parserSource = readFileSync(
  join(here, "..", "..", "..", "backend", "interval_parser.py"),
  "utf8",
);
const thresholdMatch = parserSource.match(/annualised = coverage_days < (\d+)/);
if (!thresholdMatch) {
  console.error("Could not find the annualise threshold in interval_parser.py");
  process.exit(1);
}
const THRESHOLD = Number(thresholdMatch[1]);

/** MODELLED target for a detached SA home — not a sourced figure. */
const TARGET_ANNUAL_KWH = 5500;

/** Deterministic PRNG (mulberry32) — committed fixtures must be reproducible. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Relative hourly shapes. Overnight base load, a morning rise, a low weekday
 * daytime (nobody home), an evening peak, and a taper to midnight. The weekend
 * wakes later and stays occupied through the day.
 */
const WEEKDAY = [
  0.45, 0.42, 0.40, 0.40, 0.42, 0.50, // 0-5   overnight base
  0.85, 1.30, 1.05,                   // 6-8   morning rise
  0.60, 0.55, 0.55, 0.60, 0.58, 0.55, 0.60, 0.75, // 9-16 away
  2.00, 2.20, 2.40, 2.05,             // 17-20 evening peak
  1.50, 0.95, 0.60,                   // 21-23 taper
];
const WEEKEND = [
  0.50, 0.46, 0.43, 0.42, 0.45, 0.50, // 0-5
  0.65, 0.95, 1.25,                   // 6-8   later start
  1.15, 1.10, 1.05, 1.10, 1.05, 1.00, 1.00, 1.10, // 9-16 home all day
  1.95, 2.25, 2.35, 2.05,             // 17-20
  1.55, 1.05, 0.70,                   // 21-23
];

/**
 * Southern-hemisphere seasons: a summer late-afternoon cooling bulge, a winter
 * morning-and-evening heating bump, shoulder months flat.
 */
function seasonalFactor(hour, month) {
  const summer = month === 12 || month <= 2;
  const winter = month >= 6 && month <= 8;
  if (summer) {
    if (hour >= 14 && hour <= 20) return 1.45;
    if (hour >= 21) return 1.15;
    return 1.0;
  }
  if (winter) {
    if (hour >= 6 && hour <= 9) return 1.35;
    if (hour >= 17 && hour <= 21) return 1.3;
    return 1.05;
  }
  return 1.0;
}

/** One day of 48 half-hourly kWh values, before the annual scale factor. */
function rawDay(date, rand) {
  const day = date.getUTCDay(); // 0 = Sunday
  const weekend = day === 0 || day === 6;
  const shape = weekend ? WEEKEND : WEEKDAY;
  const month = date.getUTCMonth() + 1;
  const dayScale = 0.9 + rand() * 0.2; // small day-to-day variation
  const halves = [];
  for (let hour = 0; hour < 24; hour++) {
    const hourly = shape[hour] * seasonalFactor(hour, month) * dayScale;
    // Split the hour into two halves with a slight tilt, so consecutive
    // intervals are not identical and the file does not look stamped out.
    const tilt = 0.94 + rand() * 0.12;
    halves.push((hourly / 2) * tilt, (hourly / 2) * (2 - tilt));
  }
  return halves;
}

function ymd(date) {
  return (
    `${date.getUTCFullYear()}` +
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(date.getUTCDate()).padStart(2, "0")}`
  );
}

/**
 * Build a NEM12 file plus the statistics it contains.
 * `skipDays` removes whole days INSIDE the period (producing gap_days);
 * `substituteEvery` flags every Nth day's reads as substituted rather than
 * actual (producing pct_actual below 100).
 */
function buildNem12(days, { nmi = "6001234567", startYear = 2025, seed = 20260818,
                            skipDays = new Set(), substituteEvery = 0 } = {}) {
  const rand = mulberry32(seed);
  const start = Date.UTC(startYear, 0, 1);

  // Pass 1 — raw days, so the annual total can be scaled to the target.
  const raw = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000);
    const halves = rawDay(date, rand);
    raw.push({ date, halves, skipped: skipDays.has(i) });
  }
  const rawIncludedTotal = raw
    .filter((d) => !d.skipped)
    .reduce((sum, d) => sum + d.halves.reduce((a, b) => a + b, 0), 0);
  const includedDays = raw.filter((d) => !d.skipped).length;
  // Scale so a FULL YEAR of this shape lands on the target, whatever the file's
  // length — so the 372-day and 120-day fixtures describe the same household.
  const perDayRaw = rawIncludedTotal / includedDays;
  const scale = TARGET_ANNUAL_KWH / 365 / perDayRaw;

  const lines = ["100,NEM12,200506081149,UNITEDDP,NEMMCO"];
  lines.push(`200,${nmi},E1,1,E1,N1,METSER123,KWH,30,`);
  let actualIntervals = 0;
  let totalIntervals = 0;
  let emittedTotal = 0;
  let substitutedDays = 0;
  const hourlyByDate = [];

  for (let i = 0; i < raw.length; i++) {
    const { date, halves, skipped } = raw[i];
    if (skipped) continue;
    const scaled = halves.map((v) => v * scale);
    const substituted = substituteEvery > 0 && i % substituteEvery === 0;
    if (substituted) substitutedDays++;
    const quality = substituted ? "S" : "A";
    totalIntervals += 48;
    if (!substituted) actualIntervals += 48;
    emittedTotal += scaled.reduce((a, b) => a + b, 0);
    // Hourly buckets, exactly as the parser sums them.
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(scaled[h * 2] + scaled[h * 2 + 1]);
    hourlyByDate.push({ date, hours });
    lines.push(
      `300,${ymd(date)},${scaled.map((v) => v.toFixed(4)).join(",")},${quality},,,20250101120000,`,
    );
  }
  lines.push("900");

  // The statistics the parser will compute, recomputed here so the generator
  // can PRINT what it produced and be sanity-checked before anything is drawn.
  const coverageDays = hourlyByDate.length;
  const spanDays =
    Math.round(
      (hourlyByDate[coverageDays - 1].date - hourlyByDate[0].date) / 86400000,
    ) + 1;
  const avgDay = new Array(24).fill(0);
  for (const { hours } of hourlyByDate) {
    for (let h = 0; h < 24; h++) avgDay[h] += hours[h];
  }
  for (let h = 0; h < 24; h++) avgDay[h] /= coverageDays;
  const dailyAvgKwh = avgDay.reduce((a, b) => a + b, 0);
  const weightSum = dailyAvgKwh;
  const weights = avgDay.map((v) => Number(((v * 24) / weightSum).toFixed(6)));

  // Weekday vs weekend daily totals.
  const wdTotals = [];
  const weTotals = [];
  for (const { date, hours } of hourlyByDate) {
    const total = hours.reduce((a, b) => a + b, 0);
    const d = date.getUTCDay();
    (d === 0 || d === 6 ? weTotals : wdTotals).push(total);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Seasonal spread: mean daily total per season.
  const seasons = { summer: [], autumn: [], winter: [], spring: [] };
  for (const { date, hours } of hourlyByDate) {
    const m = date.getUTCMonth() + 1;
    const total = hours.reduce((a, b) => a + b, 0);
    if (m === 12 || m <= 2) seasons.summer.push(total);
    else if (m <= 5) seasons.autumn.push(total);
    else if (m <= 8) seasons.winter.push(total);
    else seasons.spring.push(total);
  }

  // The peak window, by the same 80%-of-max contiguous rule the UI applies.
  const max = Math.max(...weights);
  const peakHour = weights.indexOf(max);
  const cut = max * 0.8;
  let ps = peakHour;
  while (ps > 0 && weights[ps - 1] >= cut) ps--;
  let pe = peakHour;
  while (pe < 23 && weights[pe + 1] >= cut) pe++;
  const label = (h) => {
    const x = ((h % 24) + 24) % 24;
    if (x === 0) return "12am";
    if (x === 12) return "12pm";
    return x < 12 ? `${x}am` : `${x - 12}pm`;
  };

  return {
    text: lines.join("\n") + "\n",
    stats: {
      coverageDays,
      spanDays,
      gapDays: spanDays - coverageDays,
      pctActual: (actualIntervals / totalIntervals) * 100,
      substitutedDays,
      annualKwh: (emittedTotal / coverageDays) * 365,
      dailyAvgKwh,
      weights,
      peak: `${label(ps)} to ${label(pe + 1)}`,
      weekdayMean: mean(wdTotals),
      weekendMean: mean(weTotals),
      seasonMeans: Object.fromEntries(
        Object.entries(seasons).map(([k, v]) => [k, v.length ? mean(v) : 0]),
      ),
    },
  };
}

function report(name, stats) {
  const s = stats;
  console.log(`\n${name}`);
  console.log(`  annual (modelled)   ${Math.round(s.annualKwh).toLocaleString("en-AU")} kWh`);
  console.log(`  daily average       ${s.dailyAvgKwh.toFixed(1)} kWh`);
  console.log(`  coverage / span     ${s.coverageDays} days / ${s.spanDays} days`);
  console.log(`  gap days            ${s.gapDays}`);
  console.log(`  pct actual          ${s.pctActual.toFixed(1)}%  (${s.substitutedDays} substituted days)`);
  console.log(`  peak window         ${s.peak}`);
  console.log(
    `  weekday vs weekend  ${s.weekdayMean.toFixed(2)} vs ${s.weekendMean.toFixed(2)} kWh/day` +
      `  (${(((s.weekendMean - s.weekdayMean) / s.weekdayMean) * 100).toFixed(1)}% weekend)`,
  );
  const se = s.seasonMeans;
  console.log(
    `  seasonal kWh/day    summer ${se.summer.toFixed(2)} · autumn ${se.autumn.toFixed(2)}` +
      ` · winter ${se.winter.toFixed(2)} · spring ${se.spring.toFixed(2)}`,
  );
  console.log(`  average-day weights [${s.weights.map((w) => w.toFixed(3)).join(", ")}]`);
}

mkdirSync(here, { recursive: true });

const goodDays = THRESHOLD + 22; // clears the annualise threshold with margin
const good = buildNem12(goodDays);
writeFileSync(join(here, "nem12-good.csv"), good.text);
report(`nem12-good.csv  (${goodDays} days, threshold ${THRESHOLD})`, good.stats);

const truncatedDays = 120; // well under the threshold — the annualised flag fires
const truncated = buildNem12(truncatedDays, { seed: 771 });
writeFileSync(join(here, "nem12-truncated.csv"), truncated.text);
report(`nem12-truncated.csv  (${truncatedDays} days)`, truncated.stats);

// Whole days missing INSIDE the period, and every 20th day substituted rather
// than actual — so gap_days and pct_actual carry non-trivial values. Until now
// the only file in the system produced "all actual reads" and no gaps, so those
// readout branches had never been seen on screen.
const skip = new Set([37, 38, 39, 84, 120, 121, 199, 240, 241, 242, 300]);
const gappy = buildNem12(200, { seed: 4242, skipDays: skip, substituteEvery: 20 });
writeFileSync(join(here, "nem12-gappy.csv"), gappy.text);
report("nem12-gappy.csv  (200-day period, days missing + substituted reads)", gappy.stats);
