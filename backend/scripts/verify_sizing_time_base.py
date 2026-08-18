#!/usr/bin/env python3
"""
verify_sizing_time_base.py — the 3.7 gate: one declared time base for
generation, load and tariff, and the true Tier-3 8,760 series into the
optimisers.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_sizing_time_base.py

Tests 1 and 3 are offline. Tests 2, 4 and 5 READ the live database and Storage
(pvgis_cache, interval_data, load_profiles, the series object) — reads only.
THE GATE WRITES NOTHING: test 5 runs the optimiser on a roof built from two
planes ALREADY IN pvgis_cache — the cell -34.93/138.6 at tilt 22.0 facing
-180 and -90 — so both planes are cache HITS: no PVGIS network call, no cache
write, and generation._cache_put is additionally no-opped for the run as belt
and braces. Those two planes are SELECTED BY FULL KEY (lat, lon, tilt,
azimuth) from however many rows the cache happens to hold; the cache GROWS
with real platform use, so neither its size nor the position of a row in it
may be assumed. See select_reference_row. The roof is therefore synthetic; the LOAD is job 456e0242's real
data on both paths, which is what test 5 measures. sizing_results is asserted
0 before and after.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import generation  # noqa: E402
import interval_parser  # noqa: E402
import nem_data  # noqa: E402
import solar_irradiance  # noqa: E402
import solar_optimiser  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


LIVE_JOB = "456e0242-17f9-4b2a-8faa-f664ddd9eed9"

# THE REFERENCE PLANE, by its FULL key. Azimuth alone stopped identifying it on
# 2026-08-18, when real platform use cached a second -180.0 row at tilt 20.0 in
# the same cell: an azimuth-only pick could then bind to a DIFFERENT ROOF and
# nothing would fail, because a 20-degree roof yields a perfectly plausible
# generation curve. t5's synthetic roof is built at pitch 22.0 to match this.
REF_LAT, REF_LON, REF_TILT = -34.93, 138.6, 22.0


def select_reference_row(rows, *, lat, lon, tilt, azimuth, tol=1e-6):
    """Every row matching ALL FOUR key fields, as a LIST.

    Returns a list rather than a row so the caller can assert HOW MANY matched:
    zero means the reference data is gone, two-or-more means the gate no longer
    knows which roof it is measuring, and both must be loud rather than
    silently binding to whichever row PostgREST happened to return first (it
    guarantees no order without an ORDER BY).

    PostgREST returns numerics as STRINGS ("22.0", not 22.0), so every value is
    coerced with float() and compared within `tol` — a bare == against a float
    fails on the string form, and a bare == between strings is brittle
    ("22.0" != "22.00"). Total: a junk row is skipped, never raised on."""
    want = {"lat_cell": lat, "lon_cell": lon, "tilt": tilt, "azimuth": azimuth}
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            if all(abs(float(row[col]) - value) <= tol for col, value in want.items()):
                out.append(row)
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _key_of(row) -> str:
    """The four key fields of a row, for a failure message that names WHICH
    rows matched rather than just how many."""
    return (f"(lat {row.get('lat_cell')}, lon {row.get('lon_cell')}, "
            f"tilt {row.get('tilt')}, az {row.get('azimuth')})")


def hour_of_day_means(hourly: list[float]) -> list[float]:
    sums = [0.0] * 24
    counts = [0] * 24
    for i, v in enumerate(hourly):
        sums[i % 24] += float(v)
        counts[i % 24] += 1
    return [s / c if c else 0.0 for s, c in zip(sums, counts)]


def pearson(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    ma = sum(a[:n]) / n
    mb = sum(b[:n]) / n
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    va = math.sqrt(sum((a[i] - ma) ** 2 for i in range(n)))
    vb = math.sqrt(sum((b[i] - mb) ** 2 for i in range(n)))
    return cov / (va * vb) if va > 0 and vb > 0 else 0.0


def t1_offsets_and_rotation() -> None:
    print("T1. the offset table and the rotation")
    for state, expected in (("SA", 9.5), ("NT", 9.5), ("NSW", 10.0), ("ACT", 10.0),
                            ("VIC", 10.0), ("TAS", 10.0), ("QLD", 10.0), ("WA", 8.0)):
        check(f"(1a) {state} -> {expected}",
              nem_data.get_utc_offset_hours(state) == expected,
              str(nem_data.get_utc_offset_hours(state)))
    for bad in (None, "", "XX", "Adelaide"):
        # Explicitly None — never a falsy 0 or a silent default.
        check(f"(1a) {bad!r} -> None, explicitly",
              nem_data.get_utc_offset_hours(bad) is None,
              repr(nem_data.get_utc_offset_hours(bad)))

    series = [float(i % 24) for i in range(8760)]
    out, rounded = generation.rotate_utc_to_local(series, None)
    check("(1b) offset None -> input unchanged, rounded False",
          out == series and rounded is False)

    for off in (8.0, 9.5, 10.0):
        rotated, _ = generation.rotate_utc_to_local(series, off)
        check(f"(1c) offset {off}: sum preserved to 6dp",
              abs(sum(rotated) - sum(series)) < 1e-6,
              f"{sum(rotated)} vs {sum(series)}")
        check(f"(1d) offset {off}: length exactly 8760", len(rotated) == 8760)

    # (1e) DIRECTION. This assertion moves when the fault is present because a
    # backwards rotation sends the spike to index 8750, not 10 — two different
    # integers, so the equality cannot hold in both implementations.
    spike = [0.0] * 8760
    spike[0] = 1.0
    rotated, _ = generation.rotate_utc_to_local(spike, 10.0)
    check("(1e) a spike at UTC index 0 lands at LOCAL index 10",
          rotated[10] == 1.0 and rotated[8750] == 0.0,
          f"idx10={rotated[10]} idx8750={rotated[8750]}")

    check("(1f) rounded True for 9.5", generation.rotate_utc_to_local(spike, 9.5)[1] is True)
    check("(1f) rounded False for 10.0", generation.rotate_utc_to_local(spike, 10.0)[1] is False)
    check("(1f) rounded False for 8.0", generation.rotate_utc_to_local(spike, 8.0)[1] is False)

    # (1g) NO CALLER LEFT BEHIND. This can fail two ways: a FOURTH caller added
    # later without the offset changes the count, and a call that stops passing
    # an offset argument fails the per-site argument check. It is the check
    # that would have caught the original miscount of the callers.
    call_sites: list[tuple[str, str]] = []
    definitions = 0
    for root, _dirs, files in os.walk(BACKEND_DIR):
        if "__pycache__" in root or "scripts" in root:
            continue
        for fname in files:
            if not fname.endswith(".py"):
                continue
            path = os.path.join(root, fname)
            src = open(path).read()
            for m in re.finditer(r"(def\s+)?build_plane_profiles\(", src):
                if m.group(1):
                    definitions += 1
                    continue
                window = src[m.end(): m.end() + 200]
                call_sites.append((os.path.relpath(path, BACKEND_DIR), window))
    check("(1g) exactly one definition and exactly three call sites",
          definitions == 1 and len(call_sites) == 3,
          f"defs={definitions} calls={[c[0] for c in call_sites]}")
    for path, window in call_sites:
        check(f"(1g) {path} passes an offset argument",
              "utc_offset" in window, window[:80])


def t1b_reference_selection() -> None:
    """The helper, offline. Without this the only proof that the full-key pick
    works is the live data agreeing with it today — which is exactly the
    assumption that went stale."""
    print("\nT1b. select_reference_row — full-key selection, offline")
    A = {"lat_cell": -34.93, "lon_cell": 138.6, "tilt": 22.0, "azimuth": -180.0, "tag": "A"}
    B = {"lat_cell": -34.93, "lon_cell": 138.6, "tilt": 20.0, "azimuth": -180.0, "tag": "B"}
    C = {"lat_cell": -34.93, "lon_cell": 138.6, "tilt": 22.0, "azimuth": -90.0, "tag": "C"}
    D = {"lat_cell": -35.50, "lon_cell": 138.6, "tilt": 22.0, "azimuth": -180.0, "tag": "D"}
    rows = [A, B, C, D]

    # The OLD azimuth-only predicate matches A, B AND D — three different roofs
    # (a different tilt in the same cell, and a different cell entirely), any
    # of which `next()` could bind depending on PostgREST's unordered return.
    # This is the fault, expressed as a number.
    old_way = [r for r in rows if float(r["azimuth"]) == -180.0]
    print(f"        azimuth-only predicate matches: {[r['tag'] for r in old_way]} "
          f"({len(old_way)} rows — the fault)")
    check("(1b) the azimuth-only predicate is genuinely ambiguous (A, B and D)",
          [r["tag"] for r in old_way] == ["A", "B", "D"],
          str([r["tag"] for r in old_way]))

    north = select_reference_row(rows, lat=-34.93, lon=138.6, tilt=22.0, azimuth=-180.0)
    check("(1b) full key tilt 22.0 / az -180.0 returns exactly [A]",
          north == [A], str([r["tag"] for r in north]))
    west = select_reference_row(rows, lat=-34.93, lon=138.6, tilt=22.0, azimuth=-90.0)
    check("(1b) full key tilt 22.0 / az -90.0 returns exactly [C]",
          west == [C], str([r["tag"] for r in west]))

    # The ZERO case must be LOUD, not skipped: the helper returns [] and the
    # exactly-one predicate t2 applies evaluates False, so t2 FAILS.
    absent = select_reference_row(rows, lat=-34.93, lon=138.6, tilt=21.0, azimuth=-180.0)
    check("(1b) an absent tilt returns [] and FAILS the exactly-one predicate",
          absent == [] and not (len(absent) == 1), str(absent))

    # lat is genuinely part of the key, not decoration: D shares tilt and
    # azimuth with A and must not match.
    check("(1b) a different lat (D) is excluded — lat is part of the key",
          D not in north and select_reference_row(
              rows, lat=-35.50, lon=138.6, tilt=22.0, azimuth=-180.0) == [D],
          str([r["tag"] for r in north]))

    # What PostgREST ACTUALLY returns: every key field as a string.
    as_strings = [{"lat_cell": "-34.93", "lon_cell": "138.6", "tilt": "22.0",
                   "azimuth": "-180.0", "tag": "A-str"}]
    check("(1b) STRING key fields still match (PostgREST's real shape)",
          len(select_reference_row(as_strings, lat=-34.93, lon=138.6,
                                   tilt=22.0, azimuth=-180.0)) == 1,
          str(as_strings))
    # Junk never raises.
    check("(1b) junk rows are skipped, never raised on",
          select_reference_row([None, "x", 42, {}, {"lat_cell": "nope"}],
                               lat=-34.93, lon=138.6, tilt=22.0, azimuth=-180.0) == [],
          "raised or matched")


def t2_the_fault_measured(client) -> tuple[list[float], list[float]]:
    """Returns (adelaide_north_hourly_utc, load_weights) for later tests."""
    print("\nT2. the fault itself, measured on the real cached data (read-only)")
    rows = (
        client.table("pvgis_cache")
        .select("lat_cell,lon_cell,tilt,azimuth,hourly")
        .execute()
    ).data or []
    # NEVER an absolute count of live production data — F77's rule applied to a
    # gate instead of a prompt. The cache grows with real use; that is evidence
    # the platform is being used, not a regression. The total is PRINTED so the
    # growth stays visible without failing anything.
    print(f"        pvgis_cache holds {len(rows)} row(s)")
    check("(2) at least the two reference PVGIS rows are cached", len(rows) >= 2,
          str(len(rows)))

    north_matches = select_reference_row(
        rows, lat=REF_LAT, lon=REF_LON, tilt=REF_TILT, azimuth=-180.0)
    west_matches = select_reference_row(
        rows, lat=REF_LAT, lon=REF_LON, tilt=REF_TILT, azimuth=-90.0)
    check(f"(2) EXACTLY ONE north reference row (lat {REF_LAT}, lon {REF_LON}, "
          f"tilt {REF_TILT}, az -180.0)",
          len(north_matches) == 1,
          f"{len(north_matches)} matched: {[_key_of(r) for r in north_matches]}")
    check(f"(2) EXACTLY ONE west reference row (lat {REF_LAT}, lon {REF_LON}, "
          f"tilt {REF_TILT}, az -90.0)",
          len(west_matches) == 1,
          f"{len(west_matches)} matched: {[_key_of(r) for r in west_matches]}")
    north = north_matches[0] if len(north_matches) == 1 else None
    other = west_matches[0] if len(west_matches) == 1 else None
    check("(2) the north-facing Adelaide row is present", north is not None)
    hourly = [float(v) for v in (north or {}).get("hourly", [])]

    means = hour_of_day_means(hourly)
    print("        UTC hour-of-day means:", [round(m, 4) for m in means])
    peak_idx = means.index(max(means))
    check("(2a) BEFORE rotation the fault is present: peak at index 02 or 03",
          peak_idx in (2, 3), f"peak at {peak_idx}")
    # "Exactly 0.000" in the prompt was measured at 4-dp rounding: at full
    # precision hours 10..18 ARE exactly zero and hour 19 carries a dusk
    # residual with mean ~1.1e-05 kWh/kWp (largest single value 0.00102). The
    # premise — dark for the whole local daytime — stands; the assertion is
    # therefore "zero at the measurement's own 4-dp precision".
    zeros_10_19 = all(means[h] < 0.001 for h in range(10, 20))
    check("(2a) ...and zero (at 4-dp precision) from index 10 through 19", zeros_10_19,
          str([f"{means[h]:.8f}" for h in range(10, 20)]))
    print(f"        residual at hour 19: mean {means[19]:.8f} kWh/kWp (dusk edge)")

    offset = nem_data.get_utc_offset_hours("SA")
    rotated, _ = generation.rotate_utc_to_local(hourly, offset)
    rmeans = hour_of_day_means(rotated)
    rpeak = rmeans.index(max(rmeans))
    night = max(rmeans[h] for h in [0, 1, 2, 3, 21, 22, 23])
    check("(2b) AFTER rotation the peak sits in 11..14", 11 <= rpeak <= 14,
          f"peak at {rpeak}")
    check("(2b) ...and 00..03 + 21..23 are below 1% of the peak",
          night < 0.01 * max(rmeans), f"night max {night:.4f} vs peak {max(rmeans):.4f}")

    if other is not None:
        oh = [float(v) for v in other.get("hourly", [])]
        omeans = hour_of_day_means(generation.rotate_utc_to_local(oh, offset)[0])
        opeak = omeans.index(max(omeans))
        print(f"        second row: lat {other['lat_cell']} lon {other['lon_cell']} "
              f"azimuth {other['azimuth']} (same Adelaide site, west-facing) — "
              f"rotated peak hour {opeak}")
        check("(2c) second row (Australian): rotated peak in daylight 10..17",
              10 <= opeak <= 17, f"peak {opeak}")

    lp = (
        client.table("load_profiles")
        .select("hourly_profile_weights")
        .eq("job_id", LIVE_JOB)
        .limit(1)
        .execute()
    ).data
    weights = [float(w) for w in (lp[0]["hourly_profile_weights"] if lp else [])]
    check("(2d) live load weights read (24 values)", len(weights) == 24, str(len(weights)))
    print(f"        load trough {min(weights):.4f} at {weights.index(min(weights)):02d}, "
          f"peak {max(weights):.4f} at {weights.index(max(weights)):02d}")

    corr_before = pearson(means, weights)
    corr_after = pearson(rmeans, weights)
    print(f"        gen-vs-load 24h correlation BEFORE rotation: {corr_before:+.4f}")
    print(f"        gen-vs-load 24h correlation AFTER  rotation: {corr_after:+.4f}")
    # THE ONE FIGURE that expresses the whole fault, and the metric that
    # actually responds to it (F47): a UTC series anti-aligns with an
    # Adelaide-clock household; rotation must move the correlation UP.
    check("(2d) the correlation IMPROVES after rotation", corr_after > corr_before,
          f"{corr_before:+.4f} -> {corr_after:+.4f}")
    return hourly, weights


def t3_series_builder() -> None:
    print("\nT3. series_to_8760, offline fixtures")
    def day(v: float) -> list[float]:
        return [v] * 24

    full = {f"2025-{m:02d}-{d:02d}": day(1.0)
            for m in range(1, 13)
            for d in range(1, interval_parser._REF_MONTH_DAYS[m - 1] + 1)}
    r = interval_parser.series_to_8760(full, None, 8760.0, False)
    check("(3a) 365 flat days -> 8760 ones, mapped 365, filled 0, scaled False",
          len(r["hourly"]) == 8760 and all(v == 1.0 for v in r["hourly"])
          and r["days_mapped"] == 365 and r["days_filled"] == 0 and r["scaled"] is False,
          f"mapped={r['days_mapped']} filled={r['days_filled']}")

    # (3b) THE DUPLICATE-DATE CASE the live file actually has.
    dup1 = dict(full)
    dup1["2026-01-01"] = day(3.0)  # 1 Jan appears twice: 1.0 and 3.0 -> mean 2.0
    r1 = interval_parser.series_to_8760(dup1, None, None, False)
    check("(3b) duplicated 1 Jan -> the MEAN of the two (2.0)",
          r1["hourly"][0] == 2.0 and r1["hourly"][23] == 2.0, str(r1["hourly"][:2]))
    check("(3b) ...and the duplicate is flagged",
          any("more than one year" in f for f in r1["flags"]), str(r1["flags"]))
    dup2 = {"2026-01-01": day(3.0)}
    dup2.update(full)  # reversed insertion order
    r2 = interval_parser.series_to_8760(dup2, None, None, False)
    check("(3b) insertion order reversed -> IDENTICAL result (take-the-first fails this)",
          r1["hourly"] == r2["hourly"])

    missing = dict(full)
    del missing["2025-06-15"]
    rm = interval_parser.series_to_8760(missing, day(7.0), None, False)
    idx = (sum(interval_parser._REF_MONTH_DAYS[:5]) + 14) * 24
    check("(3c) missing day + average_day_kwh -> filled with it, days_filled 1",
          rm["hourly"][idx] == 7.0 and rm["days_filled"] == 1,
          f"val={rm['hourly'][idx]} filled={rm['days_filled']}")
    rn = interval_parser.series_to_8760(missing, None, None, False)
    check("(3d) missing day, NO average_day_kwh -> filled from the mean, no throw",
          rn["hourly"][idx] == 1.0 and rn["days_filled"] == 1, str(rn["hourly"][idx]))

    dst = dict(full)
    dst["2025-04-06"] = [1.0] * 23
    dst["2025-10-05"] = [1.0] * 25
    rd = interval_parser.series_to_8760(dst, day(1.0), None, False)
    check("(3e) 23- and 25-value days treated as missing, filled, flagged",
          rd["days_filled"] == 2
          and any("not 24 numbers" in f for f in rd["flags"]),
          f"filled={rd['days_filled']} flags={rd['flags']}")

    leap = dict(full)
    leap["2024-02-29"] = day(9.0)
    rl = interval_parser.series_to_8760(leap, None, None, False)
    check("(3f) a 29 February is dropped, flagged, and output is still 8760",
          len(rl["hourly"]) == 8760
          and any("29-February" in f for f in rl["flags"]), str(rl["flags"][:1]))

    part = {f"2025-01-{d:02d}": day(2.0) for d in range(1, 32)}
    rs = interval_parser.series_to_8760(part, day(2.0), 9000.0, True)
    check("(3g) annualised=True -> scaled, sum == annual_kwh to 2dp",
          rs["scaled"] is True and abs(sum(rs["hourly"]) - 9000.0) < 0.01,
          f"sum={sum(rs['hourly']):.2f}")
    ru = interval_parser.series_to_8760(full, None, 9999.0, False)
    check("(3h) annualised=False -> NOT rescaled, raw sum kept, divergence flagged",
          ru["scaled"] is False and abs(sum(ru["hourly"]) - 8760.0) < 0.01
          and any("NOT rescaled" in f for f in ru["flags"]),
          f"sum={sum(ru['hourly']):.2f} flags={ru['flags'][:1]}")

    for label, garbage in (("None", None), ("a string", "junk"), ("empty dict", {}),
                           ("list of strings", {"2025-01-01": ["a"] * 24})):
        rg = interval_parser.series_to_8760(garbage, None, None, False)
        check(f"(3i) {label} -> empty hourly, flagged, no throw",
              rg["hourly"] == [] and rg["flags"], str(rg["flags"][:1]))


def t4_live_series(client) -> tuple[dict, list[float]]:
    print("\nT4. the live series end to end (read-only)")
    row = (
        client.table("interval_data")
        .select("parsed_series_ref,coverage_days")
        .eq("job_id", LIVE_JOB)
        .limit(1)
        .execute()
    ).data
    ref = row[0]["parsed_series_ref"] if row else None
    print(f"        parsed_series_ref: {ref}")
    doc = sizing_route._download_series(client, ref)
    check("(4a) download through the new helper SUCCEEDS (bills/ strip is right)",
          isinstance(doc, dict), str(type(doc)))
    if not isinstance(doc, dict):
        return {}, []
    sbd = doc.get("series_by_date") or {}
    print(f"        document bytes ~{len(json.dumps(doc))}, series_by_date keys: {len(sbd)}")

    keys = sorted(sbd.keys())
    check("(4b) 372 keys spanning 2025-01-01 to 2026-01-07",
          len(keys) == 372 and keys[0] == "2025-01-01" and keys[-1] == "2026-01-07",
          f"{len(keys)}: {keys[:1]}..{keys[-1:]}")
    monthdays: dict[str, int] = {}
    for k in keys:
        monthdays[k[5:]] = monthdays.get(k[5:], 0) + 1
    dups = sorted(md for md, n in monthdays.items() if n > 1)
    print(f"        duplicate month-days: {dups}")
    check("(4b) 1-7 January appear twice by month-day",
          dups == ["01-01", "01-02", "01-03", "01-04", "01-05", "01-06", "01-07"],
          str(dups))

    built = interval_parser.series_to_8760(
        sbd, doc.get("average_day_kwh"), doc.get("annual_kwh"),
        annualised=bool((doc.get("coverage_days") or 0)
                        < interval_parser.ANNUALISED_THRESHOLD_DAYS),
    )
    check("(4c) exactly 8760 values", len(built["hourly"]) == 8760, str(len(built["hourly"])))
    check("(4c) days_mapped + days_filled == 365",
          built["days_mapped"] + built["days_filled"] == 365,
          f"{built['days_mapped']}+{built['days_filled']}")
    print(f"        days_filled: {built['days_filled']} (expected 0 with 372 days, 0 gaps)")

    lp = (
        client.table("load_profiles")
        .select("annual_kwh,hourly_profile_weights")
        .eq("job_id", LIVE_JOB).limit(1).execute()
    ).data[0]
    stored_annual = float(lp["annual_kwh"])
    total = sum(built["hourly"])
    print(f"        (4d) series total {total:.1f} kWh vs load_profiles.annual_kwh "
          f"{stored_annual:.1f} -> {((total - stored_annual) / stored_annual * 100):+.3f}% "
          f"(REPORTED, deliberately not asserted)")

    shape = hour_of_day_means(built["hourly"])
    mean_shape = sum(shape) / 24
    norm_shape = [v / mean_shape for v in shape]
    weights = [float(w) for w in lp["hourly_profile_weights"]]
    corr = pearson(norm_shape, weights)
    maxdiff = max(abs(norm_shape[h] - weights[h]) for h in range(24))
    print(f"        (4e) true-series hour shape vs stored weights: correlation "
          f"{corr:+.4f}, max abs weight diff {maxdiff:.4f}")
    check("(4e) the two shapes are close (same file, same derivation)",
          corr > 0.99, f"corr {corr:+.4f}")
    return doc, built["hourly"]


def t5_two_modes(client, true_hourly: list[float]) -> None:
    print("\nT5. the two modes differ — in process, persisting NOTHING")
    n0 = (client.table("sizing_results").select("*", count="exact").limit(1)
          .execute()).count
    check("(5) sizing_results is 0 before", n0 == 0, str(n0))

    # ZERO-WRITE GUARANTEE: the roof below maps exactly onto the two cached
    # PVGIS rows (cell -34.93/138.6, tilt 22, aspects -180/-90), so both planes
    # are cache hits — no PVGIS call, no cache_put. _cache_put is ALSO no-opped
    # for the duration as belt and braces. The roof is synthetic; the LOAD is
    # the job's real data on both paths, which is what this test measures.
    a0 = solar_irradiance.google_azimuth_to_pvgis_aspect(0)
    check("(5) the synthetic plane maps to the cached aspect -180",
          round(a0, 1) == -180.0, str(a0))
    # A LOAD-COMPARABLE system, deliberately: at 10+ kW against a 15 kWh/day
    # household, generation dwarfs load and self-consumption% goes numb (-0.9%
    # relative at 11 kW, measured) — a size at which test 5d structurally
    # cannot respond (the F47 class). At ~1.3 kW the metric responds (-2.2 to
    # -2.8% relative). The sweep is in the 3.7 report.
    planes = [{"pitch": 22.0, "azimuth": 0.0, "kwp": 1.32, "panel_count": 3}]
    configs = [{"plane_indices": [0]}]
    panel = {"id": "7ea2822f-2293-42b0-a511-88d33843699b", "watts": 440}
    lat, lon = -34.93, 138.6
    offset = nem_data.get_utc_offset_hours("SA")

    lp = (client.table("load_profiles")
          .select("annual_kwh,hourly_profile_weights")
          .eq("job_id", LIVE_JOB).limit(1).execute()).data[0]
    rep_load = solar_optimiser.expand_load_to_8760(
        float(lp["annual_kwh"]), lp["hourly_profile_weights"])

    saved_put = generation._cache_put
    generation._cache_put = lambda *a, **k: True  # belt and braces: no write possible
    try:
        results = {}
        for label, load in (("representative", rep_load), ("tier3_actual", true_hourly)):
            flags: list[str] = []
            fin = solar_optimiser.load_financial_params(flags)
            t0 = time.perf_counter()
            res = solar_optimiser.optimise(
                roof_planes=planes, candidate_configs=configs, lat=lat, lon=lon,
                utc_offset_hours=offset, panel=panel, load_hourly=load,
                import_rate=0.40, fit=0.05, export_limit_kw=5.0,
                objective="max_npv", fin=fin, postcode="5000", state="SA",
            )
            dt = time.perf_counter() - t0
            results[label] = (res, dt, sum(load))
            check(f"(5a) {label}: optimiser returned without error",
                  isinstance(res, dict) and "optimal" in res, str(type(res)))
            check(f"(5) {label}: the plane was a cache HIT (no network, no write)",
                  res.get("cache_hits") == 1 and res.get("cache_misses") == 0,
                  f"hits={res.get('cache_hits')} misses={res.get('cache_misses')}")
        # (5b) is the ROUTE's label; here the mode is chosen by construction —
        # the resolver's labelling is proven in T4/T2 and by the route code.
        rep_total = results["representative"][2]
        act_total = results["tier3_actual"][2]
        check("(5c) total annual load agrees within 2%",
              abs(rep_total - act_total) / rep_total < 0.02,
              f"{rep_total:.0f} vs {act_total:.0f}")
        sc_rep = results["representative"][0]["optimal"]["self_consumption_pct"]
        sc_act = results["tier3_actual"][0]["optimal"]["self_consumption_pct"]
        delta = sc_act - sc_rep
        print(f"        (5d) self-consumption: representative {sc_rep:.2f}% vs "
              f"tier3_actual {sc_act:.2f}%  (delta {delta:+.2f} pts, "
              f"{'actual lower' if delta < 0 else 'actual higher'})")
        check("(5d) self-consumption differs by MORE than 1% relative",
              abs(delta) / sc_rep > 0.01 if sc_rep > 0 else False,
              f"{sc_rep:.2f} vs {sc_act:.2f}")
        print(f"        (5e) runtimes: representative {results['representative'][1]:.2f}s, "
              f"tier3_actual {results['tier3_actual'][1]:.2f}s")
    finally:
        generation._cache_put = saved_put

    n1 = (client.table("sizing_results").select("*", count="exact").limit(1)
          .execute()).count
    check("(5f) sizing_results is STILL 0 after", n1 == 0, str(n1))


def main() -> int:
    print("verify_sizing_time_base.py — 3.7: one time base, then the true series\n")
    t1_offsets_and_rotation()
    t1b_reference_selection()
    client = sizing_route._sb()
    if client is None:
        check("(live) Supabase client available", False, "env not configured")
    else:
        t2_the_fault_measured(client)
        t3_series_builder()
        _doc, true_hourly = t4_live_series(client)
        if true_hourly:
            t5_two_modes(client, true_hourly)
        else:
            check("(5) skipped — no true series available", False)
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print(f"OK: all {CHECKS_RUN} checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 — a crashing verifier must not read as success
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
