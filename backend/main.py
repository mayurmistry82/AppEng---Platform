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


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}
