"""
Per-plane solar generation + system aggregation (C1).

Turns a Stage 3 roof model into accurate generation: for each plane, fetch a normalised
8,760-hour PVGIS profile (kWh per kWp) — cached on a ~500 m lat/lon cell + tilt + aspect —
and combine planes into total system generation for any candidate config (Σ plane_kwp ×
plane_profile). Energy is additive: profiles are SUMMED, never averaged.

This is the generation layer the solar optimiser (D1) consumes. PVGIS is the source today;
Solcast (F1) will slot behind the same interface later. No Google Solar energy figures are
ever used — generation comes only from PVGIS.

THE TIME-BASE CONVENTION (3.7 Part A), declared once, here:

    Hour index h in 0..8759 means hour h of a 365-day non-leap year in the SITE'S LOCAL
    STANDARD TIME, starting at local midnight on 1 January. Load, tariff and generation
    are all in this base. Daylight saving is NOT modelled.

Local STANDARD time, not clock time, deliberately: load series and TOU windows come from
meter and bill data recorded against the local jurisdiction clock, and modelling DST
correctly would require knowing which convention each retailer used. A uniform declared
standard-time base is wrong by at most one hour for part of the year; the pre-3.7 state
was wrong by nine and a half hours all year (PVGIS seriescalc returns UTC, and it was
netted against local-clock load index-for-index).

`pvgis_cache` KEEPS RAW UTC and is never migrated or invalidated: the cache stores what
the vendor returned, and the rotation below is a per-site INTERPRETATION applied
downstream of both the cache-hit and cache-miss paths. A cache holding half-rotated rows
would be unfixable. `annual_kwh_per_kwp` is rotation-invariant and is not recomputed;
`monthly_kwh_per_kwp` shifts by a few hours at each month boundary under rotation, an
error smaller than the figure's own precision, and is likewise left as stored. Rotation
wraps the final `shift` hours of 31 December onto the start of 1 January — night hours in
every Australian state, so the wrapped values are approximately zero.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import solar_irradiance

CACHE_TABLE = "pvgis_cache"

# ~500 m cache grid (0.005° ≈ 0.5 km at SA latitudes).
GRID_DEG = 0.005

# Days per month for 2019 (non-leap) — maps a system hourly index back to its month.
_DAYS_2019 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
HOURS = 8760


def _grid(v: float) -> float:
    return round(round(float(v) / GRID_DEG) * GRID_DEG, 4)


def _client() -> Any:
    """Supabase client preferring the service-role key. None if unconfigured/unavailable."""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception:
        return None


# ── PVGIS cache ───────────────────────────────────────────────────────────────
def _cache_get(
    client: Any, lat_cell: float, lon_cell: float, tilt: float, aspect: float
) -> Optional[dict]:
    if client is None:
        return None
    try:
        res = (
            client.table(CACHE_TABLE)
            .select("hourly,annual_kwh_per_kwp,monthly")
            .eq("lat_cell", lat_cell)
            .eq("lon_cell", lon_cell)
            .eq("tilt", tilt)
            .eq("azimuth", aspect)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
    except Exception:
        return None
    return None


def _cache_put(
    client: Any, lat_cell: float, lon_cell: float, tilt: float, aspect: float, prof: dict
) -> bool:
    if client is None:
        return False
    try:
        client.table(CACHE_TABLE).upsert(
            {
                "lat_cell": lat_cell,
                "lon_cell": lon_cell,
                "tilt": tilt,
                "azimuth": aspect,
                "hourly": prof["hourly_kwh_per_kwp"],
                "annual_kwh_per_kwp": prof["annual_kwh_per_kwp"],
                "monthly": prof["monthly_kwh_per_kwp"],
                "source": "pvgis",
            },
            on_conflict="lat_cell,lon_cell,tilt,azimuth",
        ).execute()
        return True
    except Exception:
        return False


# ── Plane normalisation (accepts roof_geometry shape OR explicit API shape) ───
def normalise_planes(raw_planes: list[dict]) -> list[dict]:
    """
    Accept planes from roof_geometry (pitch/azimuth) or the API (tilt/azimuth_google) and
    return a uniform [{plane_index, tilt, azimuth_google, kwp}]. plane_index is positional
    unless the source already carries one.
    """
    out: list[dict] = []
    for i, p in enumerate(raw_planes):
        tilt = p.get("tilt")
        if tilt is None:
            tilt = p.get("pitch")
        az = p.get("azimuth_google")
        if az is None:
            az = p.get("azimuth")
        # Positional index unless the source carries an explicit one. Note an explicit
        # None (e.g. from a Pydantic model_dump) must still fall back to the position.
        idx = p.get("plane_index")
        if idx is None:
            idx = i
        out.append(
            {
                "plane_index": idx,
                "tilt": tilt,
                "azimuth_google": az,
                "kwp": p.get("kwp"),
            }
        )
    return out


# ── Time-base rotation (3.7 Part A) ───────────────────────────────────────────
def rotate_utc_to_local(
    hourly_utc: list[float], utc_offset_hours: Optional[float]
) -> tuple[list[float], bool]:
    """Rotate a UTC-indexed hourly series into the site's local standard time.

    Returns (rotated, rounded). With offset None the INPUT IS RETURNED
    UNCHANGED and rounded=False — an unknown state must surface as the
    `generation_time_base_unrotated` flag upstream, never as a silent guess.

    The shift is the offset rounded HALF-UP to whole hours (9.5 -> 10), and
    `rounded` is True whenever the offset was not already whole. Direction:
    local_hour = utc_hour + offset, so the value PVGIS reports at UTC index u
    belongs at local index (u + shift) — equivalently
    rotated[i] = hourly_utc[(i - shift) % n]. The direction is pinned
    empirically by verify_sizing_time_base.py against the real cached Adelaide
    profile (wrong direction puts the solar peak near 17:00, not midday)."""
    if utc_offset_hours is None:
        return hourly_utc, False
    import math

    shift = int(math.floor(float(utc_offset_hours) + 0.5))
    rounded = float(utc_offset_hours) != float(shift)
    n = len(hourly_utc)
    if n == 0 or shift % n == 0:
        return list(hourly_utc), rounded
    return [hourly_utc[(i - shift) % n] for i in range(n)], rounded


# ── Build per-plane profiles ──────────────────────────────────────────────────
def build_plane_profiles(
    planes: list[dict], lat: float, lon: float, utc_offset_hours: Optional[float]
) -> dict:
    """
    Fetch (cached) a normalised 8,760 profile for each plane. One plane failing never aborts
    the batch — it's recorded in failed_planes and the rest proceed.

    3.7: `utc_offset_hours` is REQUIRED with no default, deliberately — a default is how a
    future caller silently gets UTC back. The rotation to local standard time (module
    docstring) is applied AFTER the cache-hit and cache-miss branches converge, so both
    paths get identical treatment; the cache itself keeps raw UTC. Pass None only when the
    site's state is genuinely unknown, and flag it upstream.

    Returns {planes:[...], cache_hits, cache_misses, failed_planes:[...], lat_cell, lon_cell,
             cache_persist_failed, time_base_rotated_hours: int|None, time_base_rounded: bool}.
    Each plane: {plane_index, tilt, azimuth_google, aspect, kwp, annual_kwh_per_kwp,
    monthly_kwh_per_kwp, hourly_kwh_per_kwp, flags}.
    """
    client = _client()
    lat_cell, lon_cell = _grid(lat), _grid(lon)

    results: list[dict] = []
    failed: list[dict] = []
    hits = misses = 0
    persist_failed = False

    for plane in normalise_planes(planes):
        idx = plane["plane_index"]
        tilt_raw = plane.get("tilt")
        az = plane.get("azimuth_google")
        tilt_key = round(max(0.0, float(tilt_raw or 0.0)), 1)
        flat = tilt_key <= 0.5
        aspect_key = (
            0.0 if flat else round(solar_irradiance.google_azimuth_to_pvgis_aspect(az), 1)
        )
        flags: list[str] = []
        if flat:
            flags.append("flat_plane_azimuth_ignored")

        cached = _cache_get(client, lat_cell, lon_cell, tilt_key, aspect_key)
        if cached is not None:
            hits += 1
            hourly = cached["hourly"]
            annual = cached["annual_kwh_per_kwp"]
            monthly = cached["monthly"]
        else:
            try:
                # Call PVGIS with the gridded lat/lon so the call inputs match the cache key.
                prof = solar_irradiance.fetch_pvgis_plane_profile(
                    lat_cell, lon_cell, tilt_key, az
                )
            except Exception as exc:  # noqa: BLE001 — one bad plane must not abort the batch
                failed.append({"plane_index": idx, "tilt": tilt_key, "error": str(exc)})
                continue
            misses += 1
            hourly = prof["hourly_kwh_per_kwp"]
            annual = prof["annual_kwh_per_kwp"]
            monthly = prof["monthly_kwh_per_kwp"]
            if not _cache_put(client, lat_cell, lon_cell, tilt_key, aspect_key, prof):
                persist_failed = True

        # THE ROTATION — after the hit/miss branches converge, so both paths
        # are treated identically. The cache row (raw UTC) is never mutated.
        hourly, _rot_rounded = rotate_utc_to_local(hourly, utc_offset_hours)

        results.append(
            {
                "plane_index": idx,
                "tilt": tilt_key,
                "azimuth_google": az,
                "aspect": aspect_key,
                "kwp": plane.get("kwp"),
                "annual_kwh_per_kwp": annual,
                "monthly_kwh_per_kwp": monthly,
                "hourly_kwh_per_kwp": hourly,
                "flags": flags,
            }
        )

    import math

    shift = (
        None
        if utc_offset_hours is None
        else int(math.floor(float(utc_offset_hours) + 0.5))
    )
    return {
        "planes": results,
        "cache_hits": hits,
        "cache_misses": misses,
        "failed_planes": failed,
        "lat_cell": lat_cell,
        "lon_cell": lon_cell,
        "cache_persist_failed": persist_failed,
        "time_base_rotated_hours": shift,
        "time_base_rounded": (
            utc_offset_hours is not None and float(utc_offset_hours) != float(shift)
        ),
    }


# ── System aggregation ────────────────────────────────────────────────────────
def _monthly_from_hourly(hourly: list[float]) -> list[float]:
    monthly = [0.0] * 12
    h = 0
    for m, days in enumerate(_DAYS_2019):
        for _ in range(days * 24):
            if h < len(hourly):
                monthly[m] += hourly[h]
            h += 1
    return [round(x, 2) for x in monthly]


def system_generation_for_config(plane_profiles: list[dict], config: list[dict]) -> dict:
    """
    Combine planes into total system generation for a candidate config.

    config: [{plane_index, kwp}, ...]. System hourly[h] = Σ over config of kwp ×
    plane_profile[h] (energy is additive — summed). Returns {hourly_kwh: [8760], annual_kwh,
    monthly_kwh: [12], total_kwp, plane_indices, missing_planes}.
    """
    by_idx = {p["plane_index"]: p for p in plane_profiles}
    system = [0.0] * HOURS
    total_kwp = 0.0
    used: list[int] = []
    missing: list[int] = []

    for item in config:
        idx = item.get("plane_index")
        kwp = item.get("kwp")
        p = by_idx.get(idx)
        if p is None:
            missing.append(idx)
            continue
        if kwp is None:
            continue
        prof = p.get("hourly_kwh_per_kwp") or []
        k = float(kwp)
        for h in range(min(HOURS, len(prof))):
            try:
                system[h] += k * float(prof[h])
            except (TypeError, ValueError):
                continue
        total_kwp += k
        used.append(idx)

    return {
        "hourly_kwh": [round(x, 4) for x in system],
        "annual_kwh": round(sum(system), 2),
        "monthly_kwh": _monthly_from_hourly(system),
        "total_kwp": round(total_kwp, 3),
        "plane_indices": used,
        "missing_planes": missing,
    }


def default_config(plane_profiles: list[dict]) -> list[dict]:
    """Whole-roof config: every plane that holds panels, at its own kWp."""
    return [
        {"plane_index": p["plane_index"], "kwp": p["kwp"]}
        for p in plane_profiles
        if p.get("kwp")
    ]
