#!/usr/bin/env node
/**
 * verify-tokens.mjs — proves the token layer is correct end to end:
 * docs/DESIGN.md -> app/globals.css -> tailwind.config.ts.
 *
 * WHICH BYTES EACH CHECK CONSUMES (F61: a negative test once targeted a hex audit
 * comment that the parser strips, and so could never have gone red — state the
 * consumed bytes explicitly so a negative test can be aimed correctly):
 *
 *   CHECK 1 — expected tokens. Reads docs/DESIGN.md line by line and keeps only lines
 *     matching `name: { light: "#RRGGBB", dark: "#RRGGBB" }`. A reformatted or
 *     multi-line entry is SILENTLY NOT SEEN. (Deliberately not a YAML parser: the front
 *     matter has six `key:{` lines missing a space after the colon and will not parse.)
 *
 *   CHECK 2 — emitted values. Reads app/globals.css, slices the `:root {` and `.dark {`
 *     blocks, STRIPS ALL /* ... *​/ BLOCK COMMENTS, then matches
 *     `--name: <H> <S>% <L>%;` declarations. It therefore consumes the HSL TRIPLET ONLY —
 *     the trailing `/* #RRGGBB *​/` audit comment is stripped before matching and is NOT
 *     verified. To make this check fail you must change a NUMBER in the triplet, never
 *     the hex comment. Each triplet is converted back to hex and compared to CHECK 1.
 *
 *   CHECK 3 — tailwind reachability (F62). Reads tailwind.config.ts as raw TEXT and, for
 *     every token CHECK 2 found in `:root`, asserts the literal substring `var(--name)`
 *     appears somewhere in that text. It consumes the whole file as one string — it does
 *     not parse the config, so it is indifferent to nesting, key names and formatting;
 *     it only proves the CSS variable is referenced. Without this, a token could be
 *     defined in DESIGN.md, correctly emitted into both modes, pass 83/83, and STILL be
 *     unreachable from a className — which is exactly what happened to
 *     `--destructive-subtle` between F35 and 3.1.
 *
 * Exit non-zero on any mismatch, if any token found in DESIGN.md is missing from either
 * mode, or if any emitted colour token is unmapped in tailwind.
 * Run: node scripts/verify-tokens.mjs   (intentionally not a package.json script)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DESIGN_MD = join(here, "..", "..", "..", "docs", "DESIGN.md");
const GLOBALS = join(here, "..", "app", "globals.css");
const TAILWIND = join(here, "..", "tailwind.config.ts");

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

// ── 5. Tailwind reachability (F62) ────────────────────────────────────────────
// Raw text, not a parse: a token is "mapped" iff the literal `var(--name)` appears
// anywhere in tailwind.config.ts. Every colour token emitted in :root must be
// reachable from a className.
const tailwindText = readFileSync(TAILWIND, "utf8");
const emittedNames = Object.keys(emitted.light);
const unmapped = emittedNames.filter(
  (name) => !tailwindText.includes(`var(--${name})`)
);

console.log("-".repeat(64));
console.log(`DESIGN.md tokens found : ${expected.length}`);
console.log(`emitted in :root       : ${counts.light}/${expected.length}`);
console.log(`emitted in .dark       : ${counts.dark}/${expected.length}`);
console.log(`mismatches             : ${failures}`);
console.log(
  `mapped in tailwind     : ${emittedNames.length - unmapped.length}/${emittedNames.length}`
);
for (const name of unmapped) {
  console.log(`UNMAPPED: ${name} — no "var(--${name})" in tailwind.config.ts`);
}

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
if (unmapped.length > 0) {
  console.error(
    `FAIL: ${unmapped.length} emitted token(s) unmapped in tailwind.config.ts: ${unmapped.join(", ")}`
  );
  process.exit(1);
}
console.log(
  `OK: ${counts.light}/${expected.length} PASS in light, ${counts.dark}/${expected.length} PASS in dark`
);
console.log(`OK: ${emittedNames.length}/${emittedNames.length} reachable in tailwind.config.ts`);
