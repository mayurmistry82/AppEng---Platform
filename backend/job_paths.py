"""
backend/job_paths.py — six-path job routing, derived in pure Python.

THE DATABASE IS THE SOURCE OF TRUTH. `public.jobs.path` is a Postgres
GENERATED ALWAYS AS (...) STORED column (migration
`20260806044950_extend_jobs_tracker_and_six_paths`), so a stored job can never
have a path that disagrees with its has_existing_solar / intent inputs.

This module exists only to derive the same value *before* an insert — to branch
the engine or label the UI — and for display. It never writes anything, and its
result must never be persisted to `jobs.path` (that column rejects writes).
Keep the mapping here byte-for-byte identical to the generated column.

Pure: no I/O, no database access, no imports beyond typing. Never raises.
"""

from __future__ import annotations

from typing import Optional

# Human labels for each path letter — used by the dashboard and the report.
PATH_LABELS: dict[str, str] = {
    "A": "Solar only",
    "B": "Solar + battery",
    "C": "Battery only (has solar)",
    "D": "Add solar + battery",
    "E": "Battery only (no solar)",
    "F": "Expand solar only",
}

# (has_existing_solar, intent) -> path letter. Mirrors the generated column's CASE.
_PATHS: dict[tuple[bool, str], str] = {
    (False, "solar"): "A",
    (False, "both"): "B",
    (True, "battery"): "C",
    (True, "both"): "D",
    (False, "battery"): "E",
    (True, "solar"): "F",
}

_INTENTS = ("solar", "battery", "both")


def derive_path(has_existing_solar: Optional[bool], intent: Optional[str]) -> Optional[str]:
    """
    Return the six-path letter ('A'..'F') for a job, or None.

    Returns None when either argument is None, when `intent` is not one of
    'solar' / 'battery' / 'both', or on anything unexpected (wrong types
    included). Never raises — callers treat None as "not yet classified",
    which is exactly what the database stores for such a job.

    `intent` is matched case-insensitively and with surrounding whitespace
    stripped, so 'BATTERY ' resolves to the same path as 'battery'.
    """
    try:
        if has_existing_solar is None or intent is None:
            return None
        if not isinstance(has_existing_solar, bool):
            return None
        if not isinstance(intent, str):
            return None

        normalised = intent.strip().lower()
        if normalised not in _INTENTS:
            return None

        return _PATHS.get((has_existing_solar, normalised))
    except Exception:  # pragma: no cover - belt and braces; this function must never raise
        return None


def path_label(path: Optional[str]) -> Optional[str]:
    """Human label for a path letter, or None if the letter is unknown/None."""
    try:
        if not isinstance(path, str):
            return None
        return PATH_LABELS.get(path.strip().upper())
    except Exception:  # pragma: no cover
        return None


__all__ = ["derive_path", "path_label", "PATH_LABELS"]
