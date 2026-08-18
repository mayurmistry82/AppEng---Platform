"""
backend/interval_parser.py — smart-meter interval-data parser (build item E1).

Parses an AEMO **NEM12** file (SA Power Networks / Ausgrid / Energex et al.) or a
**generic CSV** fallback into an hourly consumption (LOAD) profile + metadata, for
Tier-3 (~90–95%) load characterisation and the ML data-flywheel interval intake.

CRITICAL channel rule: keep import/consumption channels (E*), EXCLUDE solar export (B*).
Default load = E1; E2 (controlled load) added only when the caller opts in. Multiple
selected import channels are SUMMED per interval. B* is never silently included.

Energy is additive: intervals are SUMMED into the hour (never averaged). UOM is honoured
(KWH/WH/MWH rescaled to kWh). Partial years are annualised and flagged. DST short/long
days (46/50 half-hours) are handled by reading the actual interval count, not assuming 48.

`parse_interval_file()` never raises — on an unrecognised/garbled file it returns
{"ok": False, "error": "..."} naming the supported formats so the caller can offer the
Tier-2 survey fallback.
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import re
from typing import Any, Optional

# NEM12 quality methods that count as genuine actual reads.
_ACTUAL_QUALITY = {"A"}
_SUPPORTED_MSG = (
    "Unrecognised file. Supported formats: AEMO NEM12 (.csv/.dat) or a simple CSV "
    "with a date/time column and a kWh column (or a wide 48-column-per-day layout)."
)


# ── small helpers ─────────────────────────────────────────────────────────────
def _is_number(tok: str) -> bool:
    try:
        float(tok)
        return True
    except (TypeError, ValueError):
        return False


def _uom_factor(uom: Optional[str]) -> float:
    u = (uom or "KWH").strip().upper()
    if u in ("KWH", "KW H"):
        return 1.0
    if u == "WH":
        return 0.001
    if u == "MWH":
        return 1000.0
    return 1.0  # unknown → assume kWh (flagged by caller via uom string)


def _normalise_weights(avg_day: list[float]) -> list[float]:
    total = sum(avg_day)
    if total <= 0:
        return [1.0] * 24
    f = 24.0 / total
    return [round(v * f, 6) for v in avg_day]


def _intervals_to_hours(values: list[float], interval_minutes: int) -> list[float]:
    """Sum interval values into 24 hourly buckets (energy is additive).

    Robust to DST short/long days: buckets by interval index so any interval count
    (e.g. 46/48/50 for 30-min) is handled without assuming a fixed 48; total daily
    energy is preserved. Bucket index is clamped to 0–23.
    """
    per_hour = max(1, 60 // max(1, interval_minutes))
    hours = [0.0] * 24
    for i, v in enumerate(values):
        h = min(i // per_hour, 23)
        hours[h] += v
    return hours


def _date_iso(d: _dt.date) -> str:
    return d.isoformat()


# ── NEM12 ─────────────────────────────────────────────────────────────────────
def _parse_nem12(text: str) -> dict:
    """Walk 100/200/300/400/900 records into per-channel daily interval data."""
    reader = csv.reader(io.StringIO(text))
    channels: dict[str, dict] = {}
    nmis: list[str] = []
    cur: Optional[dict] = None  # current 200-block context

    for row in reader:
        if not row:
            continue
        rec = row[0].strip()
        if rec == "200":
            # 200, NMI, Config, RegisterID, NMISuffix, MDMStreamId, MeterSerial, UOM, IntervalLength, ...
            nmi = row[1].strip() if len(row) > 1 else ""
            suffix = row[4].strip() if len(row) > 4 else ""
            uom = row[7].strip() if len(row) > 7 else "KWH"
            try:
                il = int(row[8])
            except (IndexError, ValueError):
                il = 30
            if nmi and nmi not in nmis:
                nmis.append(nmi)
            cur = channels.setdefault(
                suffix,
                {"nmi": nmi, "il": il, "uom": uom, "dates": {}, "actual": 0, "total": 0},
            )
        elif rec == "300" and cur is not None:
            if len(row) < 3:
                continue
            try:
                d = _dt.datetime.strptime(row[1].strip(), "%Y%m%d").date()
            except ValueError:
                continue
            factor = _uom_factor(cur["uom"])
            vals: list[float] = []
            quality_method = "A"
            for tok in row[2:]:
                t = tok.strip()
                if _is_number(t):
                    vals.append(float(t) * factor)
                else:
                    quality_method = t.upper()[:1] if t else "A"
                    break
            if not vals:
                continue
            cur["dates"][d] = vals
            cur["total"] += len(vals)
            if quality_method in _ACTUAL_QUALITY:
                cur["actual"] += len(vals)
        elif rec == "900":
            break
        # 400 (interval events) and 500/550 (B2B) are not needed for the load shape.

    if not channels:
        return {"ok": False, "error": _SUPPORTED_MSG}
    return {"ok": True, "channels": channels, "nmis": nmis, "format": "nem12"}


# ── Generic CSV fallback ──────────────────────────────────────────────────────
_DT_FORMATS = [
    "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S",
    "%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M",
]
_DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y%m%d", "%d-%m-%Y"]


def _try_datetime(s: str) -> Optional[_dt.datetime]:
    s = s.strip()
    for f in _DT_FORMATS:
        try:
            return _dt.datetime.strptime(s, f)
        except ValueError:
            continue
    return None


def _try_date(s: str) -> Optional[_dt.date]:
    s = s.strip()
    for f in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def _try_time_hour(s: str) -> Optional[int]:
    s = s.strip()
    m = re.match(r"^(\d{1,2})[:.]?(\d{2})?", s)
    if m:
        h = int(m.group(1))
        if 0 <= h <= 23:
            return h
    return None


def _parse_generic_csv(text: str) -> dict:
    """Sniff a long (datetime+kWh) or wide (date + N intervals) CSV. No hard-coded headers."""
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        return {"ok": False, "error": _SUPPORTED_MSG}

    # Header = first row that is not mostly numeric.
    header = rows[0]
    numeric_in_header = sum(1 for c in header if _is_number(c))
    has_header = numeric_in_header < max(1, len(header) // 2)
    data_rows = rows[1:] if has_header else rows
    data_rows = [r for r in data_rows if any(c.strip() for c in r)]
    if not data_rows:
        return {"ok": False, "error": _SUPPORTED_MSG}

    hourly_by_date: dict[_dt.date, list[float]] = {}

    # Wide layout: a date-like first cell + many numeric columns (≈24/48/96/288).
    sample = data_rows[0]
    numeric_cols = sum(1 for c in sample[1:] if _is_number(c))
    first_is_date = _try_date(sample[0]) is not None or _try_datetime(sample[0]) is not None
    if first_is_date and numeric_cols >= 20:
        for r in data_rows:
            d = _try_date(r[0]) or (
                _try_datetime(r[0]).date() if _try_datetime(r[0]) else None
            )
            if d is None:
                continue
            vals = [float(c) for c in r[1:] if _is_number(c)]
            if not vals:
                continue
            il = 1440 // len(vals) if len(vals) in (24, 48, 96, 288) else 30
            hourly_by_date[d] = _intervals_to_hours(vals, il)
        if hourly_by_date:
            return {"ok": True, "hourly_by_date": hourly_by_date, "format": "csv",
                    "layout": "wide"}

    # Long layout: identify a datetime column (or date+time) and a kWh column.
    n = len(sample)
    dt_col = date_col = time_col = kwh_col = None
    for j in range(n):
        if _try_datetime(sample[j]) is not None:
            dt_col = j
            break
    if dt_col is None:
        for j in range(n):
            if _try_date(sample[j]) is not None:
                date_col = j
                break
        # time column = a different column that looks like a time
        for j in range(n):
            if j != date_col and _try_time_hour(sample[j]) is not None and not _is_number(sample[j]):
                time_col = j
                break
    # kWh column: prefer a header hint, else the last numeric column.
    if has_header:
        for j, name in enumerate(header):
            if re.search(r"kwh|usage|consum|import|energy|load", name, re.I):
                if _is_number(sample[j]):
                    kwh_col = j
                    break
    if kwh_col is None:
        for j in range(n - 1, -1, -1):
            if j not in (dt_col, date_col, time_col) and _is_number(sample[j]):
                kwh_col = j
                break

    if kwh_col is None or (dt_col is None and date_col is None):
        return {"ok": False, "error": _SUPPORTED_MSG}

    for r in data_rows:
        if len(r) <= kwh_col:
            continue
        if dt_col is not None and len(r) > dt_col:
            dtv = _try_datetime(r[dt_col])
            if dtv is None:
                continue
            d, hour = dtv.date(), dtv.hour
        else:
            d = _try_date(r[date_col]) if date_col is not None and len(r) > date_col else None
            hour = _try_time_hour(r[time_col]) if time_col is not None and len(r) > time_col else 0
            if d is None or hour is None:
                continue
        if not _is_number(r[kwh_col]):
            continue
        bucket = hourly_by_date.setdefault(d, [0.0] * 24)
        bucket[hour] += float(r[kwh_col])

    if not hourly_by_date:
        return {"ok": False, "error": _SUPPORTED_MSG}
    return {"ok": True, "hourly_by_date": hourly_by_date, "format": "csv", "layout": "long"}


# ── Public API ────────────────────────────────────────────────────────────────
def parse_interval_file(
    filename: str, content: bytes, include_controlled_load: bool = False
) -> dict:
    """
    Parse a NEM12 or generic-CSV interval file into an hourly load profile + metadata.
    Never raises — returns {"ok": False, "error": ...} on failure.
    """
    try:
        text = content.decode("utf-8", errors="replace")
    except Exception:
        return {"ok": False, "error": _SUPPORTED_MSG}

    # Detect type: first token "100" → NEM12; else generic CSV.
    first_tok = ""
    for line in text.splitlines():
        if line.strip():
            first_tok = line.split(",")[0].strip()
            break
    flags: list[str] = []

    if first_tok == "100":
        parsed = _parse_nem12(text)
        if not parsed.get("ok"):
            return parsed
        return _build_from_nem12(parsed, include_controlled_load, flags)

    parsed = _parse_generic_csv(text)
    if not parsed.get("ok"):
        return parsed
    return _build_from_csv(parsed, flags)


def _finalise(
    hourly_by_date: dict[_dt.date, list[float]],
    *,
    source: str,
    fmt: str,
    nmi: Optional[str],
    resolution: Optional[int],
    uom: str,
    channels_available: list[str],
    channels_used: list[str],
    channels_excluded: list[str],
    pct_actual: float,
    multiple_nmis: bool,
    flags: list[str],
) -> dict:
    if not hourly_by_date:
        return {"ok": False, "error": _SUPPORTED_MSG}

    dates = sorted(hourly_by_date)
    period_start, period_end = dates[0], dates[-1]
    coverage_days = len(dates)
    span_days = (period_end - period_start).days + 1
    gap_days = max(0, span_days - coverage_days)

    # Average-day shape (kWh per hour averaged over covered days).
    avg_day = [0.0] * 24
    for d in dates:
        for h in range(24):
            avg_day[h] += hourly_by_date[d][h]
    avg_day = [v / coverage_days for v in avg_day]

    daily_avg_kwh = sum(avg_day)
    total_kwh = sum(sum(hourly_by_date[d]) for d in dates)
    annual_kwh = daily_avg_kwh * 365.0
    annualised = coverage_days < 350
    if annualised:
        months = max(1, round(coverage_days / 30.4))
        flags.append(
            f"{months} month{'s' if months != 1 else ''} of data ({coverage_days} days) "
            f"— annualised to a full year."
        )
    if gap_days > 0:
        flags.append(
            f"{gap_days} day gap(s) within the period — filled with the average-day "
            f"profile and excluded from coverage."
        )

    # Full-year hourly series for the optimiser: actual days where present, else the
    # average day. Keyed by date so seasonal detail is retained; gaps filled transparently.
    series_by_date = {_date_iso(d): [round(v, 4) for v in hourly_by_date[d]] for d in dates}

    weights = _normalise_weights(avg_day)
    return {
        "ok": True,
        "source": source,
        "format": fmt,
        "nmi": nmi,
        "resolution_minutes": resolution,
        "uom": uom,
        "period_start": _date_iso(period_start),
        "period_end": _date_iso(period_end),
        "coverage_days": coverage_days,
        "gap_days": gap_days,
        "annualised": annualised,
        "annual_kwh": round(annual_kwh, 2),
        "daily_avg_kwh": round(daily_avg_kwh, 4),
        "total_kwh_in_period": round(total_kwh, 2),
        "hourly_profile_weights": weights,
        "average_day_kwh": [round(v, 4) for v in avg_day],
        "channels_available": channels_available,
        "channels_used": channels_used,
        "channels_excluded": channels_excluded,
        "pct_actual": round(pct_actual, 1),
        "multiple_nmis": multiple_nmis,
        "series_by_date": series_by_date,
        "flags": flags,
    }


def _build_from_nem12(parsed: dict, include_controlled_load: bool, flags: list[str]) -> dict:
    channels: dict[str, dict] = parsed["channels"]
    nmis: list[str] = parsed["nmis"]
    available = sorted(channels.keys())

    e_channels = sorted(c for c in channels if c.upper().startswith("E"))
    b_channels = sorted(c for c in channels if c.upper().startswith("B"))

    if not e_channels:
        return {
            "ok": False,
            "error": (
                "No consumption (E) channel found in this NEM12 file"
                + (f" — only solar export ({', '.join(b_channels)}) is present. " if b_channels else ". ")
                + "Can't build a load profile; fall back to the survey estimate."
            ),
        }

    main = "E1" if "E1" in channels else e_channels[0]
    selected = [main]
    if include_controlled_load and "E2" in channels and "E2" != main:
        selected.append("E2")

    if b_channels:
        flags.append(
            f"Solar export channel(s) {', '.join(b_channels)} present — automatically "
            f"excluded (load profile uses consumption only)."
        )
    multiple_nmis = len(nmis) > 1
    if multiple_nmis:
        flags.append(
            f"Multiple NMIs in file ({', '.join(nmis)}) — used {channels[main]['nmi']}."
        )

    # Aggregate selected channels per date → hourly (sum across channels).
    hourly_by_date: dict[_dt.date, list[float]] = {}
    actual = total = 0
    main_dates = set(channels[main]["dates"].keys())
    for ch in selected:
        cdata = channels[ch]
        il = cdata["il"]
        actual += cdata["actual"]
        total += cdata["total"]
        for d, vals in cdata["dates"].items():
            hrs = _intervals_to_hours(vals, il)
            bucket = hourly_by_date.setdefault(d, [0.0] * 24)
            for h in range(24):
                bucket[h] += hrs[h]
    # Coverage is driven by the main channel's days.
    hourly_by_date = {d: v for d, v in hourly_by_date.items() if d in main_dates}

    pct_actual = (actual / total * 100.0) if total else 100.0
    if pct_actual < 100.0:
        flags.append(
            f"{round(pct_actual, 1)}% of intervals are actual reads; the remainder are "
            f"substituted/estimated (still used)."
        )

    resolution = channels[main]["il"]
    uom = channels[main]["uom"]
    return _finalise(
        hourly_by_date,
        source="NEM12",
        fmt="nem12",
        nmi=channels[main]["nmi"],
        resolution=resolution,
        uom=uom,
        channels_available=available,
        channels_used=selected,
        channels_excluded=b_channels,
        pct_actual=pct_actual,
        multiple_nmis=multiple_nmis,
        flags=flags,
    )


def _build_from_csv(parsed: dict, flags: list[str]) -> dict:
    hourly_by_date: dict[_dt.date, list[float]] = parsed["hourly_by_date"]
    layout = parsed.get("layout", "long")
    flags.append(
        f"Generic CSV ({layout} layout) — assumed to be consumption (import). "
        f"If it contains solar export, remove that column before upload."
    )
    return _finalise(
        hourly_by_date,
        source="Generic CSV",
        fmt="csv",
        nmi=None,
        resolution=None,
        uom="KWH",
        channels_available=["csv_import"],
        channels_used=["csv_import"],
        channels_excluded=[],
        pct_actual=100.0,  # generic CSV carries no quality flags
        multiple_nmis=False,
        flags=flags,
    )


# ── 3.7 Part B: the stored series → a calendar-year 8,760 ─────────────────────
# The threshold interval coverage is annualised under, mirroring the literal in
# _finalise (line ~341: `annualised = coverage_days < 350`). Named here so
# callers deciding whether to SCALE a rebuilt series reference one constant
# rather than re-typing the number; the original line is deliberately untouched.
ANNUALISED_THRESHOLD_DAYS = 350

# Non-leap month lengths for the reference calendar.
_REF_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def series_to_8760(
    series_by_date: Any,
    average_day_kwh: Optional[list],
    annual_kwh: Optional[float],
    annualised: bool,
) -> dict:
    """
    Map the stored `series_by_date` document ({"YYYY-MM-DD": [24 floats]}, ALREADY
    hourly — this function performs no 30-minute arithmetic) onto a 365-day
    non-leap reference year, index = day*24 + h.

    THE TIME BASE: series_by_date is in the meter's LOCAL CLOCK hours, which is
    the base generation.py declares (local standard time; DST not modelled). NO
    rotation is applied to load — only generation is rotated, because only
    generation arrives in UTC.

    Rules, in order:
      1. Reference year is non-leap. A 29 February key is DROPPED and flagged.
      2. Source dates are keyed by (month, day); where several years supply the
         same month-day (a 372-day file carries 1-7 January twice) the MEAN of
         those days is used — never the first or last, which would make the
         result depend on dict ordering.
      3. A month-day with no data is filled from average_day_kwh when present,
         else from the mean of all mapped days; counted in days_filled.
      4. A day whose array is not exactly 24 numbers is treated as missing
         (DST short/long days land here; the parser flags them upstream).
      5. SCALING: only when `annualised` is True (the stored annual figure was
         extrapolated from a partial year). A full-year measured series is THE
         TRUTH and is never quietly rescaled to match a rounded stored figure —
         any divergence is recorded in flags instead of hidden.
      6. Never raises: malformed input returns {"hourly": [], ...} with a flag
         and the caller falls back to the representative profile.

    Returns {"hourly": [8760 floats], "days_mapped": int, "days_filled": int,
             "scaled": bool, "scale_factor": float|None, "flags": [str]}.
    """
    out = {
        "hourly": [],
        "days_mapped": 0,
        "days_filled": 0,
        "scaled": False,
        "scale_factor": None,
        "flags": [],
    }
    try:
        if not isinstance(series_by_date, dict) or not series_by_date:
            out["flags"].append("series_by_date missing or empty")
            return out

        def _day_ok(values: Any) -> Optional[list[float]]:
            if not isinstance(values, list) or len(values) != 24:
                return None
            day: list[float] = []
            for v in values:
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    return None
                day.append(float(v))
            return day

        # Group by (month, day); mean where duplicated.
        by_monthday: dict[tuple[int, int], list[list[float]]] = {}
        feb29_dropped = 0
        bad_days = 0
        for key, values in series_by_date.items():
            try:
                y, m, d = (int(x) for x in str(key).split("-"))
            except (TypeError, ValueError):
                bad_days += 1
                continue
            if m == 2 and d == 29:
                feb29_dropped += 1
                continue
            day = _day_ok(values)
            if day is None:
                bad_days += 1
                continue
            by_monthday.setdefault((m, d), []).append(day)
        if feb29_dropped:
            out["flags"].append(f"dropped {feb29_dropped} 29-February day(s) — non-leap reference year")
        if bad_days:
            out["flags"].append(f"{bad_days} day(s) unusable (bad key or not 24 numbers) — treated as missing")

        means: dict[tuple[int, int], list[float]] = {}
        duplicates = 0
        for md, days in by_monthday.items():
            if len(days) > 1:
                duplicates += 1
                means[md] = [sum(day[h] for day in days) / len(days) for h in range(24)]
            else:
                means[md] = days[0]
        if duplicates:
            out["flags"].append(f"{duplicates} month-day(s) supplied by more than one year — averaged")
        if not means:
            out["flags"].append("no usable days — series unusable")
            return out

        # The fill day: average_day_kwh when valid, else the mean of mapped days.
        fill = _day_ok(average_day_kwh)
        if fill is None:
            n = len(means)
            fill = [sum(day[h] for day in means.values()) / n for h in range(24)]

        hourly: list[float] = []
        mapped = filled = 0
        for month in range(1, 13):
            for day_of_month in range(1, _REF_MONTH_DAYS[month - 1] + 1):
                day = means.get((month, day_of_month))
                if day is None:
                    day = fill
                    filled += 1
                else:
                    mapped += 1
                hourly.extend(day)

        total = sum(hourly)
        if total <= 0:
            out["flags"].append("series sums to zero or negative — unusable")
            return out

        if annualised and isinstance(annual_kwh, (int, float)) and annual_kwh > 0:
            factor = float(annual_kwh) / total
            hourly = [v * factor for v in hourly]
            out["scaled"] = True
            out["scale_factor"] = round(factor, 6)
        elif isinstance(annual_kwh, (int, float)) and annual_kwh > 0:
            divergence_pct = (total - float(annual_kwh)) / float(annual_kwh) * 100.0
            out["flags"].append(
                f"series total {total:.1f} kWh vs stored annual {float(annual_kwh):.1f} kWh "
                f"({divergence_pct:+.2f}%) — measured data NOT rescaled"
            )

        out["hourly"] = hourly
        out["days_mapped"] = mapped
        out["days_filled"] = filled
        return out
    except Exception as exc:  # noqa: BLE001 — the contract is never-raise
        out["flags"].append(f"series_to_8760 failed: {exc}")
        out["hourly"] = []
        return out
