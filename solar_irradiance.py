"""
Solar irradiance / production helper for Australia.

This module:
1) Geocodes an address to (lat, lon) using `geopy`
2) Calls the PVGIS `PVcalc` API to get solar production + peak sun hours
3) Returns a dictionary with a normalized schema for downstream sizing
"""

from __future__ import annotations

import json
import math
import socket
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen


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
    """Convert a street address to (latitude, longitude)."""
    Nominatim = _require_geopy()

    if not address or not address.strip():
        raise ValueError("Address must be a non-empty string.")

    geolocator = Nominatim(user_agent="energy-bill-calculator-pvgis")
    # Geocoding performs network requests to the geocoding provider.
    location = geolocator.geocode(address, timeout=20)
    if location is None:
        raise ValueError(f"Could not geocode address: {address}")

    lat = float(location.latitude)
    lon = float(location.longitude)
    return lat, lon


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


def main() -> None:
    """Smoke test using a sample address."""
    address = "53 Bishops Place, Kensington SA 5068"
    result = fetch_pvgis_profile(address, peakpower_kwp=6.6)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

