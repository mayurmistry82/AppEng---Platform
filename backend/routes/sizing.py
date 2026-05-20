from __future__ import annotations

from typing import Any
from pydantic import BaseModel
import sentry_sdk
from fastapi import APIRouter, HTTPException

import sizing_engine

router = APIRouter()


class SizingRequest(BaseModel):
    bill_data: dict[str, Any]
    solar_data: dict[str, Any]
    budget: float
    wants_battery: bool
    occupancy: str


@router.post("/api/sizing/size")
async def size_system(body: SizingRequest):
    try:
        result = sizing_engine.size_system(
            bill_data=body.bill_data,
            solar_data=body.solar_data,
            budget=body.budget,
            wants_battery=body.wants_battery,
            occupancy=body.occupancy,
        )
        return result
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))
