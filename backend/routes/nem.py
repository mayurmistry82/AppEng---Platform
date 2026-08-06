"""
Thin GET routes over nem_data for verification and to feed the optimiser later.

No UI panel in this task — these return JSON only. Both endpoints are total (the
underlying lookups never raise and always return a sensible default).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter

import nem_data

router = APIRouter()


@router.get("/api/nem/export-limit")
async def export_limit(
    postcode: Optional[str] = None,
    state: Optional[str] = None,
    dnsp: Optional[str] = None,
):
    """Standard single-phase export limit for a postcode / state / DNSP."""
    return nem_data.get_export_limit(state=state, postcode=postcode, dnsp=dnsp)


@router.get("/api/nem/fit")
async def fit(state: Optional[str] = None, postcode: Optional[str] = None):
    """Fallback feed-in tariff for a state (or a postcode, which is mapped to a state)."""
    resolved_state = state or (
        nem_data.postcode_to_state(postcode) if postcode else None
    )
    return nem_data.get_default_fit(resolved_state or "")
