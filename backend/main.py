"""
EnrgEngine FastAPI backend.

Run:
  cd backend
  uvicorn main:app --reload
"""

from __future__ import annotations

import os

import sentry_sdk
from dotenv import load_dotenv

load_dotenv()

# Sentry — initialise before the app is created; skip silently if DSN is absent.
_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    sentry_sdk.init(dsn=_sentry_dsn, traces_sample_rate=1.0)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.bill import router as bill_router
from routes.solar import router as solar_router
from routes.sizing import router as sizing_router
from routes.financial import router as financial_router
from routes.load import router as load_router
from routes.report import router as report_router
from routes.job import router as job_router
from routes.nem import router as nem_router
from routes.cost import router as cost_router
from routes.interval import router as interval_router
from routes.demand import router as demand_router
from routes.roof import router as roof_router
from routes.generation import router as generation_router
from routes.address import router as address_router
from routes.equipment import router as equipment_router
from auth import router as auth_router

app = FastAPI(title="EnrgEngine API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://*.vercel.app"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(bill_router)
app.include_router(solar_router)
app.include_router(sizing_router)
app.include_router(financial_router)
app.include_router(load_router)
app.include_router(report_router)
app.include_router(job_router)
app.include_router(nem_router)
app.include_router(cost_router)
app.include_router(interval_router)
app.include_router(demand_router)
app.include_router(roof_router)
app.include_router(generation_router)
app.include_router(address_router)
app.include_router(auth_router)  # GET /api/auth/me — no existing endpoint gains a dependency
app.include_router(equipment_router)  # 3.10 — GET /api/equipment, company-scoped catalogue


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}
