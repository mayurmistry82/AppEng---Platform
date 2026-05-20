from __future__ import annotations

from pydantic import BaseModel
import sentry_sdk
from fastapi import APIRouter, HTTPException

import solar_irradiance

router = APIRouter()


class IrradianceRequest(BaseModel):
    address: str
    system_kw: float


@router.post("/api/solar/irradiance")
async def get_irradiance(body: IrradianceRequest):
    try:
        result = solar_irradiance.fetch_pvgis_profile(
            body.address, peakpower_kwp=body.system_kw
        )
        return result
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))
