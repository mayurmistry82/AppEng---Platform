#!/usr/bin/env node
/**
 * Regenerates the three NEM12 fixtures used for the 3.6 browser checks —
 * committed so the fixtures can be REGENERATED rather than trusted.
 *
 * Run from frontend/:  node scripts/fixtures/make-nem12-fixtures.mjs
 *
 * The annualise threshold is READ from backend/interval_parser.py
 * (`annualised = coverage_days < N`), never hardcoded: nem12-good.csv gets
 * enough days to clear it, nem12-truncated.csv gets 120 days so the flag
 * fires, nem12-junk.csv is not NEM12 at all so the parser refuses it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const parserSource = readFileSync(
  join(here, "..", "..", "..", "backend", "interval_parser.py"),
  "utf8",
);
const match = parserSource.match(/annualised = coverage_days < (\d+)/);
if (!match) {
  console.error("Could not find the annualise threshold in interval_parser.py");
  process.exit(1);
}
const threshold = Number(match[1]);

function nem12(days, { nmi = "6001234567", startYear = 2025, dailyKwh = 24 } = {}) {
  const lines = ["100,NEM12,200506081149,UNITEDDP,NEMMCO"];
  lines.push(`200,${nmi},E1,1,E1,N1,METSER123,KWH,30,`);
  const vals = Array.from({ length: 48 }, () => (dailyKwh / 48).toFixed(4)).join(",");
  const start = Date.UTC(startYear, 0, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86400000);
    const ymd =
      `${d.getUTCFullYear()}` +
      `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
      `${String(d.getUTCDate()).padStart(2, "0")}`;
    lines.push(`300,${ymd},${vals},A,,,20250101120000,`);
  }
  lines.push("900");
  return lines.join("\n") + "\n";
}

mkdirSync(here, { recursive: true });
const goodDays = threshold + 22; // clears the threshold with margin (372 for 350)
const truncatedDays = 120; // well under — the annualised flag fires
writeFileSync(join(here, "nem12-good.csv"), nem12(goodDays));
writeFileSync(join(here, "nem12-truncated.csv"), nem12(truncatedDays));
writeFileSync(
  join(here, "nem12-junk.csv"),
  "This is not a NEM12 file.\nJust some words,and,commas\nwith no interval data at all.\n",
);
console.log(
  `threshold=${threshold}: nem12-good.csv ${goodDays} days, ` +
    `nem12-truncated.csv ${truncatedDays} days, nem12-junk.csv written`,
);
