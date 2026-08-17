"""
backend/job_tier.py — the ONE writer of jobs.accuracy_tier / jobs.confidence_pct
(checklist 3.6 prompt 1).

THE STRUCTURAL DECISION, so it is not reinvented: `load_profiles` is the SOURCE
OF TRUTH for a job's demand accuracy tier. `jobs.accuracy_tier` and
`jobs.confidence_pct` are a MIRROR of it, written in exactly this one function.
Data flows one way only — load_profiles -> jobs — and never the reverse.
load_profiles has UNIQUE(job_id), so there is exactly one row per job and
replacing it (capture.save_load_profile upserts on job_id) is how a tier
change is recorded; this function then mirrors whatever is there, INCLUDING a
LOWER tier than the job currently shows. Before 3.6, jobs.accuracy_tier was
written to the literal 3 in routes/interval.py and never lowered anywhere —
UT-5's "fall back a tier" was impossible.

No other function anywhere may write jobs.accuracy_tier or jobs.confidence_pct
(outside the legacy bulk save retired at 3.16).
"""

from __future__ import annotations

from typing import Any, Optional

import sentry_sdk


def sync_job_tier(client: Any, job_id: str) -> tuple[Optional[int], Optional[str]]:
    """
    Mirror the job's load_profiles tier onto the jobs row.

    Returns (tier_written, error). With NO load_profiles row it writes nothing
    and returns (None, None): a job whose tier was set by the legacy bulk save
    must not be nulled out by a function that simply found nothing to mirror.
    NEVER raises — any exception is reported to Sentry and returned as the
    error string; the caller surfaces it as a warning, never a 500.
    """
    if client is None:
        return None, "Supabase not configured"
    try:
        res = (
            client.table("load_profiles")
            .select("accuracy_tier, confidence_pct")
            .eq("job_id", job_id)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        if not rows:
            return None, None
        tier = rows[0].get("accuracy_tier")
        confidence = rows[0].get("confidence_pct")
        client.table("jobs").update(
            {"accuracy_tier": tier, "confidence_pct": confidence}
        ).eq("job_id", job_id).execute()
        return tier, None
    except Exception as exc:  # noqa: BLE001 — never block the request on the mirror
        sentry_sdk.capture_exception(exc)
        return None, f"tier sync failed: {exc}"


__all__ = ["sync_job_tier"]
