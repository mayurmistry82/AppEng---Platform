"""
Cost-model route — POST /api/cost/estimate.

Thin wrapper over cost_model.compute_system_cost (which is best-effort and never raises);
returns the itemised bottom-up breakdown JSON for verification and later use by the
optimiser / financial panel.
"""

from __future__ import annotations

from typing import Optional

import sentry_sdk
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import cost_model

router = APIRouter()


class CostEstimateRequest(BaseModel):
    solar_kw: float
    panel_id: Optional[str] = None
    panel_count: Optional[int] = None
    inverter_id: Optional[str] = None
    battery_id: Optional[str] = None
    battery_usable_kwh: Optional[float] = None
    postcode: Optional[str] = None
    state: Optional[str] = None
    installer_id: Optional[str] = None


@router.post("/api/cost/estimate")
async def estimate(req: CostEstimateRequest):
    try:
        return cost_model.compute_system_cost(
            solar_kw=req.solar_kw,
            panel_id=req.panel_id,
            panel_count=req.panel_count,
            inverter_id=req.inverter_id,
            battery_id=req.battery_id,
            battery_usable_kwh=req.battery_usable_kwh,
            postcode=req.postcode,
            state=req.state,
            installer_id=req.installer_id,
        )
    except Exception as exc:  # noqa: BLE001 - cost_model shouldn't raise, but never 500 the caller silently
        sentry_sdk.capture_exception(exc)
        return JSONResponse(
            status_code=500,
            content={"error": "cost estimate failed", "detail": str(exc)},
        )
