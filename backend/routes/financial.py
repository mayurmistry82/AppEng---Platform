from __future__ import annotations

from typing import Any
from pydantic import BaseModel
import sentry_sdk
from fastapi import APIRouter, HTTPException

import financial_model

router = APIRouter()


class FinancialRequest(BaseModel):
    bill_data: dict[str, Any]
    sizing_data: dict[str, Any]
    solar_data: dict[str, Any]


@router.post("/api/financial/calculate")
async def calculate_financials(body: FinancialRequest):
    try:
        result = financial_model.calculate_financials(
            bill_data=body.bill_data,
            sizing_data=body.sizing_data,
            solar_data=body.solar_data,
        )
        return result
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))
