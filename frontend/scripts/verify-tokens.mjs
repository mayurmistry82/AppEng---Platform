#!/usr/bin/env node
/**
 * verify-tokens.mjs — proves app/globals.css matches docs/DESIGN.md exactly.
 *
 * Extracts every { light, dark } colour token from the DESIGN.md `colors:` block with a
 * line regex (deliberately NOT a YAML parser: the front matter has six `key:{` lines
 * missing a space after the colon and will not parse as YAML — and DESIGN.md must never
 * be edited). Then reads the `--var: H S% L%;` declarations from the `:root` and `.dark`
 * blocks of app/globals.css, converts each HSL triplet BACK to hex, and diffs.
 *
 * Exit non-zero on any mismatch, or if any token found in DESIGN.md is missing from
 * either mode.
 * Run: node scripts/verify-tokens.mjs   (intentionally not a package.json script)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DESIGN_MD = join(here, "..", "..", "..", "docs", "DESIGN.md");
const GLOBALS = join(here, "..", "app", "globals.css");

// Sanity floor: catches a gutted or unreadable DESIGN.md (e.g. the regex silently
// matching nothing). NOT the pass/fail gate — that demands every token found, below.
const MIN_EXPECTED_TOKENS = 70;

// ── 1. Expected tokens from DESIGN.md ────────────────────────────────────────
const LINE_RE =
  /^\s*([a-z0-9-]+):\s*\{\s*light:\s*"(#[0-9A-Fa-f]{6})",\s*dark:\s*"(#[0-9A-Fa-f]{6})"\s*\}/;
const expected = []; // [name, lightHex, darkHex]
for (const line of readFileSync(DESIGN_MD, "utf8").split("\n")) {
  const m = LINE_RE.exec(line);
  if (m) expected.push([m[1], m[2].toUpperCase(), m[3].toUpperCase()]);
}

// ── 2. Emitted variables from globals.css ────────────────────────────────────
const css = readFileSync(GLOBALS, "utf8");
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector ${selector} not found in globals.css`);
  const end = css.indexOf("\n  }", start);
  // Strip block comments before matching, so a commented-out declaration (e.g.
  // /* --destructive-subtle: 354.8 35.4% 12.7%; */) doesn't count as present — the
  // trailing /* #HEX */ audit comments sit AFTER the semicolon, so live declarations
  // are unaffected.
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = {};
  const re = /--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g;
  for (let m; (m = re.exec(body)); ) vars[m[1]] = [+m[2], +m[3], +m[4]];
  return vars;
}
const emitted = { light: block(":root"), dark: block(".dark") };

// ── 3. HSL triplet -> hex (same rounding as the generator) ───────────────────
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return (
    "#" +
    rgb
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

// ── 4. Compare ────────────────────────────────────────────────────────────────
let failures = 0;
const counts = { light: 0, dark: 0 };
console.log(
  "token".padEnd(28) + "mode ".padEnd(7) + "expected".padEnd(10) + "got".padEnd(10) + "result"
);
console.log("-".repeat(64));
for (const [name, lightHex, darkHex] of expected) {
  for (const [mode, want] of [["light", lightHex], ["dark", darkHex]]) {
    const triplet = emitted[mode][name];
    let got = "(missing)";
    if (triplet) {
      counts[mode] += 1;
      got = hslToHex(...triplet);
    }
    const ok = got === want;
    if (!ok) failures += 1;
    // Print failures always; passes compactly.
    console.log(
      name.padEnd(28) + mode.padEnd(7) + want.padEnd(10) + got.padEnd(10) + (ok ? "PASS" : "FAIL")
    );
  }
}

console.log("-".repeat(64));
console.log(`DESIGN.md tokens found : ${expected.length}`);
console.log(`emitted in :root       : ${counts.light}/${expected.length}`);
console.log(`emitted in .dark       : ${counts.dark}/${expected.length}`);
console.log(`mismatches             : ${failures}`);

if (expected.length < MIN_EXPECTED_TOKENS) {
  console.error(
    `FAIL: expected at least ${MIN_EXPECTED_TOKENS} tokens in DESIGN.md, found ${expected.length}`
  );
  process.exit(1);
}
if (counts.light < expected.length || counts.dark < expected.length || failures > 0) {
  console.error("FAIL: token layer does not match DESIGN.md");
  process.exit(1);
}
console.log(
  `OK: ${counts.light}/${expected.length} PASS in light, ${counts.dark}/${expected.length} PASS in dark`
);
