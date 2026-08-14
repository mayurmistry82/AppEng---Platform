#!/usr/bin/env python3
"""
verify_solar_retention.py — proves the 3.5b §20.2 retention contract, offline.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_solar_retention.py

No network, no database, no writes. Covers backend/solar_retention.py's expiry
and redaction rules, and — the anti-drift gate — asserts that the migration's
SQL function, the backend module and the frontend mirror all agree on the SAME
seven columns and the SAME 30 days. Drift between those three is how a legal
deletion obligation quietly stops being met.

BOUNDARY: 30 days is NOT yet expired; expiry begins strictly after 30.
"""
from __future__ import annotations

import datetime as dt
import glob
import os
import re
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import solar_retention as sr  # noqa: E402

# platform repo root -> workspace root (owns supabase/migrations)
PLATFORM_DIR = os.path.dirname(BACKEND_DIR)
WORKSPACE_DIR = os.path.dirname(PLATFORM_DIR)
MIGRATIONS_GLOB = os.path.join(WORKSPACE_DIR, "supabase", "migrations", "*_solar_data_retention.sql")
FRONTEND_WORKSHEET = os.path.join(PLATFORM_DIR, "frontend", "lib", "worksheet.ts")

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


NOW = dt.datetime(2026, 8, 14, 12, 0, 0, tzinfo=dt.timezone.utc)


def iso_days_ago(days: float) -> str:
    return (NOW - dt.timedelta(days=days)).isoformat()


def google_row(**over):
    row = {
        "source": "google_solar",
        "created_at": iso_days_ago(1),
        "solar_data_captured_at": iso_days_ago(1),
        "solar_data_expired_at": None,
        "panels_raw": [{"segmentIndex": 0}],
        "segment_bounding_boxes": [{"segment_index": 0}],
        "building_center": {"latitude": -34.9},
        "building_bounding_box": {"sw": {}},
        "google_max_array_panels_count": 28,
        "imagery_date": "2018-11-17",
        "imagery_quality": "MEDIUM",
        "planes": [{"panel_count": 17}],
        "total_kwp": 7.48,
    }
    row.update(over)
    return row


def t_expiry() -> None:
    print("1. expiry and redaction")
    aged31 = google_row(solar_data_captured_at=iso_days_ago(31))
    out = sr.redact_expired_solar_data(aged31, now=NOW)
    check("31 days: expired", sr.is_solar_data_expired(aged31, now=NOW) is True)
    for field in sr.GOOGLE_SOLAR_FIELDS:
        check(f"31 days: {field} nulled", out.get(field) is None, repr(out.get(field)))
    check("31 days: solar_data_expired True", out.get("solar_data_expired") is True)
    check("31 days: OUR planes untouched", out.get("planes") == [{"panel_count": 17}])
    check("31 days: the input row was NOT mutated", aged31["panels_raw"] == [{"segmentIndex": 0}])

    aged29 = google_row(solar_data_captured_at=iso_days_ago(29))
    out29 = sr.redact_expired_solar_data(aged29, now=NOW)
    check("29 days: not expired", sr.is_solar_data_expired(aged29, now=NOW) is False)
    check("29 days: returned byte-identical (same object, unchanged)",
          out29 is aged29 and out29.get("imagery_date") == "2018-11-17")
    check("29 days: NO solar_data_expired key at all — never present-and-false",
          "solar_data_expired" not in out29, str(out29.keys()))

    # THE BOUNDARY: exactly 30 days old is NOT yet expired (strictly-greater rule).
    aged30 = google_row(solar_data_captured_at=iso_days_ago(30))
    check("exactly 30 days: NOT yet expired — expiry begins after 30",
          sr.is_solar_data_expired(aged30, now=NOW) is False)
    aged30plus = google_row(solar_data_captured_at=iso_days_ago(30.0001))
    check("a moment past 30 days: expired",
          sr.is_solar_data_expired(aged30plus, now=NOW) is True)

    manual = google_row(source="manual_plans", solar_data_captured_at=iso_days_ago(400),
                        created_at=iso_days_ago(400))
    check("manual_plans aged 400 days: never expired",
          sr.is_solar_data_expired(manual, now=NOW) is False)
    check("manual_plans: returned unchanged",
          sr.redact_expired_solar_data(manual, now=NOW) is manual)

    fallback = google_row(solar_data_captured_at=None, created_at=iso_days_ago(31))
    check("captured_at NULL falls back to created_at (never immortal)",
          sr.is_solar_data_expired(fallback, now=NOW) is True)
    check("age reference uses created_at on fallback",
          sr.solar_data_age_reference(fallback) is not None)

    both_null = google_row(solar_data_captured_at=None, created_at=None)
    check("both dates NULL: not expired, no raise",
          sr.is_solar_data_expired(both_null, now=NOW) is False)

    tombstoned = google_row(solar_data_captured_at=iso_days_ago(2),
                            solar_data_expired_at=iso_days_ago(1))
    check("tombstone alone expires, even when recent",
          sr.is_solar_data_expired(tombstoned, now=NOW) is True)

    print("\n2. junk input never raises")
    for label, junk in [("None", None), ("a list", [1, 2]), ("a string", "junk"),
                        ("wrong types", {"source": 7, "created_at": {},
                                         "solar_data_captured_at": ["x"]})]:
        try:
            expired = sr.is_solar_data_expired(junk, now=NOW)
            out = sr.redact_expired_solar_data(junk, now=NOW)
            check(f"{label}: no raise, not expired, passthrough",
                  expired is False and out is junk)
        except Exception as exc:  # noqa: BLE001
            check(f"{label}: no raise, not expired, passthrough", False,
                  f"raised {type(exc).__name__}: {exc}")


def t_anti_drift() -> None:
    print("\n3. ANTI-DRIFT — migration SQL == backend module == frontend mirror")
    matches = glob.glob(MIGRATIONS_GLOB)
    check("exactly one *_solar_data_retention.sql migration", len(matches) == 1,
          str(matches))
    if len(matches) != 1:
        return
    sql = open(matches[0]).read()

    # The columns the SQL function nulls: `<column> = null` assignments.
    sql_nulled = set(re.findall(r"(\w+)\s*=\s*null\b", sql, flags=re.IGNORECASE))
    expected = set(sr.GOOGLE_SOLAR_FIELDS)
    check("SQL nulls exactly GOOGLE_SOLAR_FIELDS", sql_nulled == expected,
          f"sql-only={sorted(sql_nulled - expected)} module-only={sorted(expected - sql_nulled)}")

    intervals = re.findall(r"interval\s+'(\d+)\s+days'", sql, flags=re.IGNORECASE)
    check("SQL interval(s) equal SOLAR_DATA_RETENTION_DAYS",
          len(intervals) >= 1 and all(int(i) == sr.SOLAR_DATA_RETENTION_DAYS for i in intervals),
          str(intervals))

    ts_src = open(FRONTEND_WORKSHEET).read()
    m = re.search(r"export const SOLAR_DATA_RETENTION_DAYS\s*=\s*(\d+)", ts_src)
    check("frontend SOLAR_DATA_RETENTION_DAYS equals backend",
          m is not None and int(m.group(1)) == sr.SOLAR_DATA_RETENTION_DAYS,
          m.group(0) if m else "constant not found in lib/worksheet.ts")


def main() -> int:
    print("verify_solar_retention.py — §20.2 retention contract (offline)\n")
    t_expiry()
    t_anti_drift()
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
