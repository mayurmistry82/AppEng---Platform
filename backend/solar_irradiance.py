"""
Solar irradiance / production helper for Australia.

This module:
1) Geocodes an address to (lat, lon) using `geopy`
2) Calls the PVGIS `PVcalc` API to get solar production + peak sun hours
3) Returns a dictionary with a normalized schema for downstream sizing
"""

from __future__ import annotations

import collections
import json
import math
import re
import socket
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from dotenv import load_dotenv

load_dotenv()


PVGIS_PVCALC_URL = "https://re.jrc.ec.europa.eu/api/v5_2/PVcalc"


def _require_geopy() -> Any:
    try:
        from geopy.geocoders import Nominatim  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "geopy is required. Install it with: pip install geopy"
        ) from exc
    return Nominatim


def geocode_address(address: str) -> tuple[float, float]:
    """Convert a street address to (latitude, longitude).

    If the first geocoding attempt fails, retries with any leading
    unit/apartment/level prefix stripped (PVGIS only needs street-level
    precision).
    """
    Nominatim = _require_geopy()

    if not address or not address.strip():
        raise ValueError("Address must be a non-empty string.")

    geolocator = Nominatim(user_agent="energy-bill-calculator-pvgis")
    location = geolocator.geocode(address, timeout=20)

    if location is None:
        stripped = re.sub(
            r'^(u\s*\d+|unit\s*\d+|apt\s*\d+|apartment\s*\d+|level\s*\d+|'
            r'suite\s*\d+|shop\s*\d+)\s*,\s*',
            '',
            address.strip(),
            flags=re.IGNORECASE,
        )
        if stripped != address.strip():
            location = geolocator.geocode(stripped, timeout=20)

    if location is None:
        raise ValueError(f"Could not geocode address: {address}")

    return float(location.latitude), float(location.longitude)


def fetch_pvgis_profile(
    address: str,
    peakpower_kwp: float = 6.6,
) -> dict[str, Any]:
    """
    Get PVGIS-derived solar profile for an address.

    Returns:
      - latitude: float
      - longitude: float
      - annual_kwh_per_kwp: annual energy production per kW installed
      - peak_sun_hours: average daily peak sun hours
      - monthly_profile: list of monthly generation values (kWh for given system size)
    """
    lat, lon = geocode_address(address)

    if peakpower_kwp <= 0:
        raise ValueError("peakpower_kwp must be > 0.")

    # Build PVGIS request.
    # We request JSON to simplify parsing.
    params = {
        "lat": lat,
        "lon": lon,
        "peakpower": float(peakpower_kwp),
        # PVGIS "loss" is optional; including a default improves comparability.
        "loss": 14,
        "outputformat": "json",
    }

    url = f"{PVGIS_PVCALC_URL}?{urlencode(params)}"

    try:
        with urlopen(url, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except socket.timeout as exc:
        raise RuntimeError("PVGIS request timed out.") from exc
    except Exception as exc:
        raise RuntimeError(f"PVGIS request failed: {exc}") from exc

    # Parse PVGIS JSON response.
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("PVGIS returned non-JSON response.") from exc

    outputs = data.get("outputs") or {}
    totals = (outputs.get("totals") or {}).get("fixed") or {}
    monthly = (outputs.get("monthly") or {}).get("fixed") or []

    if not isinstance(monthly, list):
        monthly = []

    # Monthly profile: use E_m (kWh/month) and keep it in month order.
    monthly_entries: list[dict[str, Any]] = []
    for item in monthly:
        if isinstance(item, dict):
            monthly_entries.append(item)

    monthly_entries.sort(key=lambda x: x.get("month", 0))

    monthly_profile: list[float] = []
    for item in monthly_entries:
        # E_m is average monthly energy production for the given system size.
        e_m = item.get("E_m")
        try:
            if e_m is None:
                continue
            monthly_profile.append(float(e_m))
        except (TypeError, ValueError):
            continue

    # Totals:
    # - E_y is average annual energy production for the given system size (kWh/year)
    # - H(i)_d is average daily peak sun hours (irradiation on the module plane), in kWh/m2/d
    e_y = totals.get("E_y")
    h_i_d = totals.get("H(i)_d")

    annual_total_kwh = None
    peak_sun_hours = None
    try:
        if e_y is not None:
            annual_total_kwh = float(e_y)
    except (TypeError, ValueError):
        annual_total_kwh = None

    try:
        if h_i_d is not None:
            peak_sun_hours = float(h_i_d)
    except (TypeError, ValueError):
        peak_sun_hours = None

    annual_kwh_per_kwp = None
    if annual_total_kwh is not None and peakpower_kwp > 0:
        annual_kwh_per_kwp = annual_total_kwh / float(peakpower_kwp)

    # If PVGIS didn't return enough values, keep fields as None rather than crashing.
    return {
        "latitude": lat,
        "longitude": lon,
        "annual_kwh_per_kwp": annual_kwh_per_kwp,
        "peak_sun_hours": peak_sun_hours,
        "monthly_profile": monthly_profile,
    }


def fetch_pvgis_daily(
    lat: float,
    lon: float,
    peakpower_kwp: float = 6.6,
) -> dict[str, Any]:
    """Fetch hourly PVGIS data for a full year and aggregate to 365 daily
    kWh totals. Uses lat/lon directly (no geocoding needed).

    Returns {"daily_profile": [365 floats]} — kWh/day for each day Jan–Dec.
    Uses 2019 (non-leap year) for a clean 365-day result.
    """
    if peakpower_kwp <= 0:
        raise ValueError("peakpower_kwp must be > 0.")

    params = {
        "lat": lat,
        "lon": lon,
        "peakpower": float(peakpower_kwp),
        "loss": 14,
        "outputformat": "json",
        "startyear": 2019,
        "endyear": 2019,
        "pvcalculation": 1,
    }

    url = f"https://re.jrc.ec.europa.eu/api/v5_2/seriescalc?{urlencode(params)}"

    try:
        with urlopen(url, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except socket.timeout as exc:
        raise RuntimeError("PVGIS daily request timed out.") from exc
    except Exception as exc:
        raise RuntimeError(f"PVGIS daily request failed: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("PVGIS returned non-JSON response.") from exc

    hourly = (data.get("outputs") or {}).get("hourly") or []

    # Hourly profile: every entry in time order, P (W) converted to kWh/hour.
    hourly_profile: list[float] = []
    for entry in hourly:
        if not isinstance(entry, dict):
            hourly_profile.append(0.0)
            continue
        p_w = entry.get("P", 0) or 0
        try:
            hourly_profile.append(float(p_w) / 1000)
        except (TypeError, ValueError):
            hourly_profile.append(0.0)

    # Trim or pad to 8760 (365 × 24, non-leap year).
    hourly_profile = hourly_profile[:8760]
    while len(hourly_profile) < 8760:
        hourly_profile.append(0.0)

    # Aggregate hourly W → daily kWh.
    # time format: "20190101:0010" (YYYYMMDD:HHMM)
    # P is average power output in W for that hour → energy = P/1000 kWh
    daily_kwh: dict[str, float] = collections.defaultdict(float)
    for entry in hourly:
        if not isinstance(entry, dict):
            continue
        time_str = str(entry.get("time", ""))
        p_w = entry.get("P", 0) or 0
        if len(time_str) >= 8:
            day_key = time_str[:8]
            try:
                daily_kwh[day_key] += float(p_w) / 1000
            except (TypeError, ValueError):
                continue

    sorted_days = sorted(daily_kwh.keys())
    daily_profile = [daily_kwh[d] for d in sorted_days[:365]]

    # Pad to 365 if fewer days returned.
    while len(daily_profile) < 365:
        daily_profile.append(0.0)

    return {
        "daily_profile": daily_profile,
        "hourly_profile": hourly_profile,
    }


PVGIS_SERIESCALC_URL = "https://re.jrc.ec.europa.eu/api/v5_2/seriescalc"


def google_azimuth_to_pvgis_aspect(google_azimuth: float | None) -> float:
    """
    Convert a Google Solar azimuth to a PVGIS aspect.

    Google: 0=N, 90=E, 180=S, 270=W.  PVGIS aspect: 0=S, -90=E, +90=W, ±180=N.
    aspect = google - 180, normalised into [-180, 180) so that due north resolves to -180
    (matching the spec's check table: N 0→-180, E 90→-90, S 180→0, W 270→+90). PVGIS treats
    -180 and +180 identically (both north). Returns 0.0 for an undefined azimuth (flat plane).
    """
    if google_azimuth is None:
        return 0.0
    g = float(google_azimuth) % 360.0
    aspect = g - 180.0
    if aspect >= 180.0:
        aspect -= 360.0
    if aspect < -180.0:
        aspect += 360.0
    return aspect


def fetch_pvgis_plane_profile(
    lat: float,
    lon: float,
    tilt_deg: float,
    azimuth_google: float | None,
) -> dict[str, Any]:
    """
    8,760 normalised hourly generation (kWh per kWp) for ONE roof plane.

    Reuses the seriescalc plumbing + the 2019 non-leap-year convention (clean 365×24=8,760).
    peakpower=1 kWp, angle=tilt, aspect=converted from Google azimuth, and PVGIS system
    loss=0 — we apply our own performance ratio downstream (Stage 4), so losses are not
    double-counted here. PVGIS's temperature/irradiance model is retained (pvcalculation=1).
    A flat plane (tilt≈0) ignores azimuth (aspect=0) and is flagged.

    Raises RuntimeError on any PVGIS failure — the caller decides what to do; this never
    silently substitutes another data source (accuracy positioning).

    Returns:
      {hourly_kwh_per_kwp: [8760], annual_kwh_per_kwp, monthly_kwh_per_kwp: [12],
       tilt, aspect, azimuth_google, flat, loss_assumption_pct: 0, source: "pvgis"}
    """
    tilt = max(0.0, float(tilt_deg or 0.0))
    flat = tilt <= 0.5
    aspect = 0.0 if flat else google_azimuth_to_pvgis_aspect(azimuth_google)

    params = {
        "lat": lat,
        "lon": lon,
        "peakpower": 1,
        "loss": 0,  # our own performance ratio is applied later — do not double-count here
        "angle": round(tilt, 1),
        "aspect": round(aspect, 1),
        "outputformat": "json",
        "startyear": 2019,
        "endyear": 2019,
        "pvcalculation": 1,
    }
    url = f"{PVGIS_SERIESCALC_URL}?{urlencode(params)}"

    try:
        with urlopen(url, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except socket.timeout as exc:
        raise RuntimeError("PVGIS plane request timed out.") from exc
    except Exception as exc:
        raise RuntimeError(f"PVGIS plane request failed: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("PVGIS returned non-JSON response.") from exc

    hourly = (data.get("outputs") or {}).get("hourly") or []
    if not hourly:
        raise RuntimeError("PVGIS returned no hourly data for this plane.")

    # P is average power (W) for the hour; for a 1 kWp system, P/1000 = kWh/kWp for that hour.
    profile: list[float] = []
    monthly = [0.0] * 12
    for entry in hourly[:8760]:
        if not isinstance(entry, dict):
            profile.append(0.0)
            continue
        p_w = entry.get("P", 0) or 0
        try:
            kwh = float(p_w) / 1000.0
        except (TypeError, ValueError):
            kwh = 0.0
        profile.append(kwh)
        time_str = str(entry.get("time", ""))  # "YYYYMMDD:HHMM"
        if len(time_str) >= 6:
            try:
                m = int(time_str[4:6])
                if 1 <= m <= 12:
                    monthly[m - 1] += kwh
            except ValueError:
                pass

    # Clean 365×24 (2019, non-leap).
    profile = profile[:8760]
    while len(profile) < 8760:
        profile.append(0.0)

    return {
        "hourly_kwh_per_kwp": profile,
        "annual_kwh_per_kwp": round(sum(profile), 2),
        "monthly_kwh_per_kwp": [round(x, 2) for x in monthly],
        "tilt": round(tilt, 1),
        "aspect": round(aspect, 1),
        "azimuth_google": azimuth_google,
        "flat": flat,
        "loss_assumption_pct": 0,
        "source": "pvgis",
    }


def main() -> None:
    """Smoke test using a sample address."""
    address = "53 Bishops Place, Kensington SA 5068"
    result = fetch_pvgis_profile(address, peakpower_kwp=6.6)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

