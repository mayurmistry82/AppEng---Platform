"""
Generation route — POST /api/generation/profiles (C1).

Per-plane PVGIS generation for a roof model (planes in the request, or loaded from
roof_geometry by job_id), plus a combined system profile for a candidate config. Returns
per-plane summaries (annual + monthly kWh/kWp) and the full 8,760 arrays for D1. Geometry
in, generation out — no Google Solar energy figures are used.

Persists a per-job solar_resources summary (blended per-kWp yield). Best-effort: a PVGIS
error returns a clear message (never a silent fallback), a partial failure returns the
successful planes + a flag, and a persistence failure still returns the profiles in-response.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter
from pydantic import BaseModel

import capture
import generation
import nem_data

router = APIRouter()


class PlaneIn(BaseModel):
    tilt: Optional[float] = None
    azimuth_google: Optional[float] = None
    kwp: Optional[float] = None
    plane_index: Optional[int] = None


class ConfigItem(BaseModel):
    plane_index: int
    kwp: float


class GenerationRequest(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    planes: Optional[list[PlaneIn]] = None
    job_id: Optional[str] = None
    config: Optional[list[ConfigItem]] = None
    include_hourly: bool = True


def _client() -> Any:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception:
        return None


def _load_roof(job_id: str) -> Optional[dict]:
    """Load the most recent roof_geometry row for a job (planes + lat/lng). None on miss."""
    client = _client()
    if client is None:
        return None
    try:
        res = (
            client.table("roof_geometry")
            .select("planes,lat,lng,found")
            .eq("job_id", job_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception:
        return None


def _persist_summary(
    job_id: str, lat: float, lon: float, planes: list[dict], system: dict
) -> bool:
    """
    Upsert a per-job solar_resources summary: the blended per-kWp yield (system annual ÷
    total kWp), or — when the config holds no panels — the best plane's per-kWp yield.
    Best-effort via the capture layer (one row per job). Returns persisted bool.
    """
    total_kwp = system.get("total_kwp") or 0.0
    if total_kwp > 0:
        annual_per_kwp = round(system["annual_kwh"] / total_kwp, 1)
        monthly_per_kwp = [round(m / total_kwp, 2) for m in system["monthly_kwh"]]
    else:
        best = max(
            planes,
            key=lambda p: p.get("annual_kwh_per_kwp") or 0.0,
            default=None,
        )
        if not best:
            return False
        annual_per_kwp = best.get("annual_kwh_per_kwp")
        monthly_per_kwp = best.get("monthly_kwh_per_kwp")

    sr_id = capture.save_solar_resource(
        {
            "job_id": job_id,
            "lat": lat,
            "lon": lon,
            "annual_kwh_per_kwp": annual_per_kwp,
            "peak_sun_hours": round(annual_per_kwp / 365.0, 2) if annual_per_kwp else None,
            "monthly_profile": monthly_per_kwp,
            "source": "pvgis",
            "source_version": "pvgis-seriescalc-c1-per-plane",
        }
    )
    return bool(sr_id)


@router.post("/api/generation/profiles")
async def generation_profiles(body: GenerationRequest):
    try:
        lat, lon = body.lat, body.lon
        raw_planes: list[dict] = (
            [p.model_dump() for p in body.planes] if body.planes else []
        )

        # Load from roof_geometry when planes/coords are not supplied directly.
        if (not raw_planes or lat is None or lon is None) and body.job_id:
            roof = _load_roof(body.job_id)
            if roof:
                if not raw_planes:
                    raw_planes = roof.get("planes") or []
                if lat is None:
                    lat = roof.get("lat")
                if lon is None:
                    lon = roof.get("lng")

        if not raw_planes:
            return {
                "found": False,
                "error": "No roof planes supplied (pass planes, or a job_id with stored roof geometry).",
                "source": "pvgis",
            }
        if lat is None or lon is None:
            return {
                "found": False,
                "error": "lat/lon required (pass directly or via a job_id with geocoded roof geometry).",
                "source": "pvgis",
            }

        # ── 3.7: resolve the site's state (job row only — this route carries no
        # state field) and rotate generation into local standard time. ──
        state: Optional[str] = None
        if body.job_id:
            client = _client()
            if client is not None:
                try:
                    jr = (
                        client.table("jobs").select("site_state")
                        .eq("job_id", body.job_id).limit(1).execute()
                    )
                    if jr.data:
                        state = jr.data[0].get("site_state")
                except Exception:  # noqa: BLE001 — unknown state degrades, never blocks
                    state = None
        utc_offset = nem_data.get_utc_offset_hours(state)

        built = generation.build_plane_profiles(
            raw_planes, float(lat), float(lon), utc_offset
        )
        planes = built["planes"]
        flags: list[str] = []
        if utc_offset is None:
            flags.append(
                "generation_time_base_unrotated — state unknown, generation left in UTC — is_fallback"
            )
        elif built.get("time_base_rounded"):
            flags.append(
                f"generation_time_base_rounded_30min — {state} is UTC+9:30, "
                f"rotated by {built.get('time_base_rotated_hours')} h"
            )
        if built["failed_planes"]:
            flags.append("partial_plane_failure")

        if not planes:
            # Every plane failed — clear error, no silent fallback.
            return {
                "found": False,
                "error": "PVGIS returned no usable plane profiles.",
                "failed_planes": built["failed_planes"],
                "source": "pvgis",
                "flags": ["pvgis_error"],
            }

        # Config: explicit, else whole-roof at each plane's kWp.
        config = (
            [c.model_dump() for c in body.config]
            if body.config
            else generation.default_config(planes)
        )
        system = generation.system_generation_for_config(planes, config)

        # Persist the per-job solar_resources summary (best-effort).
        persisted = False
        if body.job_id:
            try:
                persisted = _persist_summary(
                    body.job_id, float(lat), float(lon), planes, system
                )
            except Exception as exc:  # noqa: BLE001 — never block the response
                sentry_sdk.capture_exception(exc)
            if not persisted:
                flags.append("summary_not_persisted")
        else:
            flags.append("no_job_id_not_persisted")
        if built["cache_persist_failed"]:
            flags.append("cache_persist_failed")

        # Shape planes for the response (optionally omit the bulky hourly arrays).
        plane_out = []
        for p in planes:
            item = {
                "plane_index": p["plane_index"],
                "tilt": p["tilt"],
                "azimuth_google": p["azimuth_google"],
                "aspect": p["aspect"],
                "kwp": p["kwp"],
                "annual_kwh_per_kwp": p["annual_kwh_per_kwp"],
                "monthly_kwh_per_kwp": p["monthly_kwh_per_kwp"],
                "flags": p["flags"],
            }
            if body.include_hourly:
                item["hourly_kwh_per_kwp"] = p["hourly_kwh_per_kwp"]
            plane_out.append(item)

        system_out = {
            "config": config,
            "total_kwp": system["total_kwp"],
            "annual_kwh": system["annual_kwh"],
            "monthly_kwh": system["monthly_kwh"],
            "plane_indices": system["plane_indices"],
            "missing_planes": system["missing_planes"],
        }
        if body.include_hourly:
            system_out["hourly_kwh"] = system["hourly_kwh"]

        return {
            "found": True,
            "source": "pvgis",
            "lat": float(lat),
            "lon": float(lon),
            "loss_assumption_pct": 0,
            "cache_hits": built["cache_hits"],
            "cache_misses": built["cache_misses"],
            "planes": plane_out,
            "system": system_out,
            "failed_planes": built["failed_planes"],
            "persisted": persisted,
            "flags": flags,
        }
    except Exception as exc:  # noqa: BLE001 — never surface a traceback / crash the app
        sentry_sdk.capture_exception(exc)
        return {
            "found": False,
            "error": "Internal error computing generation profiles.",
            "source": "pvgis",
            "flags": ["internal_error"],
        }
