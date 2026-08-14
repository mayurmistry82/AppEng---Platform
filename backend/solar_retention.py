"""
backend/solar_retention.py — Google Solar Data retention (checklist 3.5b, §20.2).

Maps Platform Service Specific Terms §20.2 permits caching Solar API Building
Insights for 30 consecutive calendar days, after which the cached Solar Data must
be deleted. The fixed-media exception covers the generated PDF (8.2), never the
database. Legal confirmation is pending (D14) — this module builds the
CONSERVATIVE reading, deliberately without a switch to relax it.

THE SINGLE SOURCE OF TRUTH. Nothing else may hardcode the field list or the day
count: the migration's SQL function, this module's redaction and the frontend's
mirror constant are all asserted equal by scripts/verify_solar_retention.py, so
drift fails a gate instead of shipping.

The Google/our split is decided and not open here:
  GOOGLE CONTENT (deleted on expiry)  — GOOGLE_SOLAR_FIELDS below.
  ENRGENGINE CONTENT (never deleted)  — planes, candidate_configs, total_kwp,
    max_panels, usability_factor, selected_panel, imagery_stale, low_confidence,
    needs_manual_confirmation, flags, reason, source, found,
    manual_entry_required, lat, lng, address, geocoded_*.
Geocoding results are NOT Solar Data (§20.2 does not reach them) and have no
expiry.

BOUNDARY: 30 days is NOT yet expired — expiry begins strictly AFTER 30 days.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Optional

SOLAR_DATA_RETENTION_DAYS = 30

# Exactly the seven Google-content columns, matching the migration's SQL function.
GOOGLE_SOLAR_FIELDS: tuple[str, ...] = (
    "panels_raw",
    "segment_bounding_boxes",
    "building_center",
    "building_bounding_box",
    "google_max_array_panels_count",
    "imagery_date",
    "imagery_quality",
    # 3.5 (F106): the panel dimensions are Google Solar Data too — adding the
    # columns WITHOUT adding them here would silently re-open the hole 3.5b
    # closed.
    "google_panel_width_m",
    "google_panel_height_m",
    "google_panel_capacity_w",
)


def _parse_ts(value: Any) -> Optional[_dt.datetime]:
    """ISO 8601 (or datetime) → aware datetime; None on anything unreadable."""
    if isinstance(value, _dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


def solar_data_age_reference(row: Any) -> Optional[_dt.datetime]:
    """
    The instant the 30-day clock started: solar_data_captured_at, falling back to
    created_at. None when neither parses. The fallback is deliberate — a NULL
    capture date must never mean "keep forever" (the migration's SQL coalesces
    the same way).
    """
    if not isinstance(row, dict):
        return None
    return _parse_ts(row.get("solar_data_captured_at")) or _parse_ts(row.get("created_at"))


def is_solar_data_expired(row: Any, now: Optional[_dt.datetime] = None) -> bool:
    """
    True when this row's Google Solar Data must no longer be served: the row is a
    google_solar row AND (the sweep already tombstoned it, OR its age reference is
    STRICTLY older than 30 days). Always False for manual_* sources — an
    installer's own measurements are not Google content.

    Never raises. A row that cannot be read is NOT expired: blanking a roof on a
    parse failure would be worse than serving it one extra day.
    """
    if not isinstance(row, dict):
        return False
    if row.get("source") != "google_solar":
        return False
    if _parse_ts(row.get("solar_data_expired_at")) is not None:
        return True
    reference = solar_data_age_reference(row)
    if reference is None:
        return False
    current = now if now is not None else _dt.datetime.now(_dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=_dt.timezone.utc)
    return (current - reference) > _dt.timedelta(days=SOLAR_DATA_RETENTION_DAYS)


def redact_expired_solar_data(row: Any, now: Optional[_dt.datetime] = None) -> Any:
    """
    Defence in depth for the read path: even if the nightly sweep has not run,
    expired Solar Data never leaves the server.

    Returns a NEW dict. Not expired → returned unchanged (and WITHOUT a
    solar_data_expired key: an unchecked thing must not render as a passed thing,
    the same rule as site_cross_check in routes/roof.py). Expired → the seven
    GOOGLE_SOLAR_FIELDS nulled and "solar_data_expired": True.

    Never raises; a row it cannot parse is returned as-is.
    """
    try:
        if not is_solar_data_expired(row, now):
            return row
        redacted = dict(row)
        for field in GOOGLE_SOLAR_FIELDS:
            redacted[field] = None
        redacted["solar_data_expired"] = True
        return redacted
    except Exception:  # noqa: BLE001 — the contract is never-raise
        return row


__all__ = [
    "SOLAR_DATA_RETENTION_DAYS",
    "GOOGLE_SOLAR_FIELDS",
    "solar_data_age_reference",
    "is_solar_data_expired",
    "redact_expired_solar_data",
]
