"""
Roof geometry from the Google Solar API (Stage 3 — B1 + B2).

Geocode an address (Google Geocoding API) → call buildingInsights:findClosest → parse
`solarPotential` into a NORMALISED, panel-agnostic roof model: per-plane azimuth / pitch /
usable area, panel counts rescaled to OUR chosen catalogue panel, and cumulative
best-plane-first candidate configurations.

GEOMETRY / LAYOUT ONLY. Google's `yearlyEnergyDcKwh`, `solarPanelConfigs[].yearlyEnergyDcKwh`
and `financialAnalyses` are deliberately NOT read or returned — our own generation model
(Stage 5, PVGIS) runs later and consumes the pitch/azimuth from here. The `dataLayers`
endpoint is never called (buildingInsights only).

Resilient to the three real-world coverage gaps the SA coverage test exposed:
  1. Regional NOT_FOUND (404, even after EXPANDED_COVERAGE) — the NORM, not an edge case:
     found=false, manual_entry_required=true, geocoded lat/lng returned for manual entry.
  2. New-build "found-but-junk" (<=1 segment or implausibly few panels): found=true but
     low_confidence + needs_manual_confirmation, never silently trusted.
  3. Stale imagery: imagery_date + imagery_quality always returned; >~3y → imagery_stale.

Never raises — every failure path returns a structured dict the route can persist + return.
"""

from __future__ import annotations

import datetime as _dt
import math
import os
import time
from typing import Any, Optional

import requests

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
SOLAR_URL = "https://solar.googleapis.com/v1/buildingInsights:findClosest"

MAX_RETRIES = 3
TIMEOUT = 30

# Fraction of a roof segment's raw area that is actually usable for panels (setbacks,
# obstructions, walkways). Configurable via env; conservative default.
DEFAULT_USABILITY_FACTOR = 0.7

# Imagery older than this is flagged stale (surfaced, not hidden).
STALE_IMAGERY_YEARS = 3

# Junk-detection thresholds (new-build gap). A residential roof with <=1 plane or fewer
# than this many Google-placed panels is almost certainly pre-build/partial imagery.
JUNK_MAX_SEGMENTS = 1
JUNK_MIN_PANELS = 6

# Fallback panel when the catalogue is unreachable — Jinko Tiger Neo 440 W (1762×1134 mm).
# Keeps normalisation working even if Supabase is down; flagged so it's never silent.
_FALLBACK_PANEL: dict[str, Any] = {
    "id": None,
    "brand": "Jinko",
    "model": "Tiger Neo",
    "watts": 440,
    "length_mm": 1762.0,
    "width_mm": 1134.0,
    "area_m2": round(1762.0 * 1134.0 / 1_000_000.0, 4),  # 1.998
}


# ── Config / clients ──────────────────────────────────────────────────────────
def _api_key() -> Optional[str]:
    key = os.getenv("GOOGLE_MAPS_API_KEY")
    return key.strip() if key else None


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


def _usability_factor(override: Optional[float]) -> float:
    if override is not None and override > 0:
        return float(override)
    env = os.getenv("ROOF_USABILITY_FACTOR")
    if env:
        try:
            v = float(env)
            if v > 0:
                return v
        except ValueError:
            pass
    return DEFAULT_USABILITY_FACTOR


# ── HTTP with retry/backoff (transient 429/5xx) ───────────────────────────────
def _get_with_retry(url: str, params: dict) -> requests.Response:
    delay = 1.0
    last: Optional[requests.Response] = None
    for attempt in range(MAX_RETRIES):
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        last = resp
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
        return resp
    return last  # type: ignore[return-value]


def _geocode(address: str, key: str) -> tuple[Optional[float], Optional[float], Optional[str]]:
    """Return (lat, lng, error). error is None on success."""
    params = {"address": address, "key": key, "region": "au", "components": "country:AU"}
    try:
        resp = _get_with_retry(GEOCODE_URL, params)
    except Exception as exc:  # noqa: BLE001
        return None, None, f"geocode request failed: {exc}"
    try:
        data = resp.json()
    except Exception:
        return None, None, f"geocode HTTP {resp.status_code} (non-JSON response)"
    status = data.get("status")
    if status == "OK" and data.get("results"):
        loc = data["results"][0]["geometry"]["location"]
        return float(loc["lat"]), float(loc["lng"]), None
    if status == "REQUEST_DENIED":
        msg = data.get("error_message") or "request denied"
        return None, None, f"geocode REQUEST_DENIED: {msg}"
    msg = data.get("error_message") or status or f"HTTP {resp.status_code}"
    return None, None, f"geocode failed: {msg}"


def _building_insights(
    lat: float, lng: float, key: str, expanded: bool = False
) -> tuple[int, Optional[dict], Optional[str]]:
    """
    buildingInsights:findClosest → (http_status, json|None, error|None).
    A 404 / NOT_FOUND is DATA (no building), returned with json=None, error=None.

    requiredQuality=LOW + exactQualityRequired=false makes the API treat LOW as a MINIMUM
    and return ANY available quality (LOW/MEDIUM/HIGH), so coverage isn't undercounted.
    """
    params = {
        "location.latitude": lat,
        "location.longitude": lng,
        "requiredQuality": "LOW",
        "exactQualityRequired": "false",
        "key": key,
    }
    if expanded:
        params["experiments"] = "EXPANDED_COVERAGE"
    try:
        resp = _get_with_retry(SOLAR_URL, params)
    except Exception as exc:  # noqa: BLE001
        return -1, None, f"solar request failed: {exc}"

    if resp.status_code == 200:
        try:
            return 200, resp.json(), None
        except Exception:
            return 200, None, "solar 200 but non-JSON body"
    if resp.status_code == 404:
        return 404, None, None  # NOT_FOUND — data, not an error
    detail = ""
    try:
        j = resp.json()
        detail = j.get("error", {}).get("status") or j.get("error", {}).get("message", "")
    except Exception:
        detail = (resp.text or "")[:160]
    return resp.status_code, None, f"solar HTTP {resp.status_code} {detail}".strip()


# ── Panel catalogue ───────────────────────────────────────────────────────────
def _num(v: Any) -> Optional[float]:
    """Coerce a numeric-or-string DB value to float; None-safe (never turns NULL into 0)."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _panel_from_row(row: dict) -> Optional[dict]:
    length = _num(row.get("length_mm"))
    width = _num(row.get("width_mm"))
    watts = _num(row.get("rated_power_w"))
    if not length or not width or not watts:
        return None
    return {
        "id": row.get("id"),
        "brand": row.get("brand"),
        "model": row.get("model"),
        "watts": int(watts),
        "length_mm": length,
        "width_mm": width,
        "area_m2": round(length * width / 1_000_000.0, 4),
    }


def _get_panel(panel_id: Optional[str]) -> tuple[dict, list[str]]:
    """
    Resolve the panel to rescale to. Explicit panel_id → that catalogue panel; otherwise a
    sensible active default (preferring the Jinko Tiger Neo 440 W). Falls back to a hard-coded
    panel (with a flag) if the catalogue is unreachable so normalisation never blocks.
    Returns (panel, flags).
    """
    flags: list[str] = []
    client = _client()
    if client is None:
        flags.append("panel_catalogue_unavailable")
        return dict(_FALLBACK_PANEL), flags
    try:
        if panel_id:
            res = client.table("panels").select("*").eq("id", panel_id).limit(1).execute()
            if res.data:
                panel = _panel_from_row(res.data[0])
                if panel:
                    return panel, flags
            flags.append("panel_id_not_found_used_default")
        # Default: prefer Jinko Tiger Neo, else first active panel deterministically.
        pref = (
            client.table("panels")
            .select("*")
            .eq("status", "active")
            .eq("brand", "Jinko")
            .eq("model", "Tiger Neo")
            .limit(1)
            .execute()
        )
        rows = pref.data or (
            client.table("panels")
            .select("*")
            .eq("status", "active")
            .order("rated_power_w", desc=True)
            .order("created_at")
            .limit(1)
            .execute()
            .data
        )
        if rows:
            panel = _panel_from_row(rows[0])
            if panel:
                return panel, flags
    except Exception:
        flags.append("panel_catalogue_error")
    flags.append("panel_fallback_used")
    return dict(_FALLBACK_PANEL), flags


# ── Imagery date helpers ──────────────────────────────────────────────────────
def _parse_imagery_date(d: Any) -> Optional[_dt.date]:
    if not isinstance(d, dict) or not d.get("year"):
        return None
    try:
        return _dt.date(int(d["year"]), int(d.get("month") or 1), int(d.get("day") or 1))
    except (ValueError, TypeError):
        return None


def _age_years(d: _dt.date) -> int:
    return int((_dt.date.today() - d).days // 365.25)


# ── Normalisation ─────────────────────────────────────────────────────────────
def _normalise(data: dict, panel: dict, usability: float) -> dict:
    """Turn one buildingInsights response into our normalised roof model. Geometry only."""
    sp = data.get("solarPotential") or {}
    segments = sp.get("roofSegmentStats") or []
    panel_area = panel["area_m2"]
    panel_watts = panel["watts"]
    flags: list[str] = []

    # Google's per-segment panel counts (from the max-array layout). segmentIndex only —
    # yearlyEnergyDcKwh on each panel is intentionally ignored.
    seg_counts: dict[int, int] = {}
    for p in sp.get("solarPanels") or []:
        idx = p.get("segmentIndex")
        if isinstance(idx, int):
            seg_counts[idx] = seg_counts.get(idx, 0) + 1
    have_layout = bool(seg_counts)
    if not have_layout:
        flags.append("google_panel_layout_absent")

    planes: list[dict] = []
    for i, seg in enumerate(segments):
        stats = seg.get("stats") or {}
        area = _num(stats.get("areaMeters2"))  # NULL-safe — never coerced to 0
        quantiles = stats.get("sunshineQuantiles") or []
        sunshine_med = _num(quantiles[len(quantiles) // 2]) if quantiles else None

        if area is None:
            usable = None
            area_panel_count = 0
            flags.append(f"segment_{i}_area_missing")
        else:
            usable = area * usability
            area_panel_count = int(math.floor(usable / panel_area)) if panel_area else 0

        google_seg = seg_counts.get(i) if have_layout else None
        if google_seg is not None:
            panel_count = max(0, min(area_panel_count, google_seg))
        else:
            panel_count = max(0, area_panel_count)

        kwp = round(panel_count * panel_watts / 1000.0, 3)
        az = _num(seg.get("azimuthDegrees"))
        pitch = _num(seg.get("pitchDegrees"))
        planes.append(
            {
                "azimuth": round(az, 1) if az is not None else None,
                "pitch": round(pitch, 1) if pitch is not None else None,
                "area_m2": round(area, 2) if area is not None else None,
                "usable_area_m2": round(usable, 2) if usable is not None else None,
                "panel_count": panel_count,
                "kwp": kwp,
                "sunshine_quantile": round(sunshine_med, 1) if sunshine_med is not None else None,
                "google_panel_count": google_seg,
                "center": seg.get("center"),
            }
        )

    # Candidate configs — cumulative, best plane first (highest median sunshine, then area).
    order = sorted(
        range(len(planes)),
        key=lambda i: (
            planes[i]["sunshine_quantile"] if planes[i]["sunshine_quantile"] is not None else -1.0,
            planes[i]["usable_area_m2"] if planes[i]["usable_area_m2"] is not None else -1.0,
        ),
        reverse=True,
    )
    configs: list[dict] = []
    cum_panels = 0
    cum_kwp = 0.0
    used: list[int] = []
    for idx in order:
        p = planes[idx]
        if (p["panel_count"] or 0) <= 0:
            continue
        cum_panels += p["panel_count"]
        cum_kwp += p["kwp"]
        used.append(idx)
        configs.append(
            {
                "n_planes": len(used),
                "panel_count": cum_panels,
                "kwp": round(cum_kwp, 3),
                "plane_indices": list(used),
                "azimuths": [planes[j]["azimuth"] for j in used],
            }
        )

    # Retained (not consumed) geometry — everything needed to redraw the panel layout over
    # a satellite tile later without a second Google call. Purely additive: none of the
    # values above are derived from or affected by any of this.
    raw_panels = sp.get("solarPanels")
    panels_raw = list(raw_panels) if isinstance(raw_panels, list) else []

    segment_boxes: list[dict] = []
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            continue
        segment_boxes.append(
            {
                "segment_index": i,
                "boundingBox": seg.get("boundingBox"),
                "center": seg.get("center"),
            }
        )

    return {
        "planes": planes,
        "candidate_configs": configs,
        "total_kwp": round(cum_kwp, 3),
        "max_panels": cum_panels,
        "google_max_array_panels_count": sp.get("maxArrayPanelsCount"),
        "roof_segment_count": len(segments),
        "flags": flags,
        # Retained verbatim — see comment above.
        "panels_raw": panels_raw,
        "segment_bounding_boxes": segment_boxes,
        "building_center": data.get("center"),
        "building_bounding_box": data.get("boundingBox"),
    }


def rescale_planes_for_panel(planes: list[dict], panel: dict) -> dict:
    """
    Re-scale a STORED roof model to a different panel — purely locally, NO Google Solar call.

    From each plane's already-stored ``usable_area_m2`` (and the existing plane order),
    recompute ``panel_count = floor(usable_area_m2 / panel["area_m2"])`` and
    ``kwp = panel_count * panel["watts"] / 1000``, then rebuild the cumulative
    best-plane-first ``candidate_configs`` exactly as ``_normalise`` does. A plane missing
    ``usable_area_m2`` is skipped (count 0) and flagged. Never raises.

    Returns {"planes": [...], "candidate_configs": [...], "flags": [...]}.
    """
    panel_area = panel.get("area_m2")
    watts = panel.get("watts")
    flags: list[str] = []

    new_planes: list[dict] = []
    for i, p in enumerate(planes or []):
        usable = p.get("usable_area_m2")
        if usable is None or not panel_area:
            count = 0
            if usable is None:
                flags.append(f"plane_{i}_usable_area_missing")
        else:
            try:
                count = int(math.floor(float(usable) / float(panel_area)))
            except (TypeError, ValueError, ZeroDivisionError):
                count = 0
            if count < 0:
                count = 0
        kwp = round(count * float(watts) / 1000.0, 3) if watts else 0.0
        scaled = dict(p)
        scaled["panel_count"] = count
        scaled["kwp"] = kwp
        new_planes.append(scaled)

    # Cumulative best-plane-first, mirroring _normalise (highest median sunshine, then area).
    order = sorted(
        range(len(new_planes)),
        key=lambda i: (
            new_planes[i].get("sunshine_quantile") if new_planes[i].get("sunshine_quantile") is not None else -1.0,
            new_planes[i].get("usable_area_m2") if new_planes[i].get("usable_area_m2") is not None else -1.0,
        ),
        reverse=True,
    )
    configs: list[dict] = []
    cum_panels = 0
    cum_kwp = 0.0
    used: list[int] = []
    for idx in order:
        p = new_planes[idx]
        if (p["panel_count"] or 0) <= 0:
            continue
        cum_panels += p["panel_count"]
        cum_kwp += p["kwp"]
        used.append(idx)
        configs.append(
            {
                "n_planes": len(used),
                "panel_count": cum_panels,
                "kwp": round(cum_kwp, 3),
                "plane_indices": list(used),
                "azimuths": [new_planes[j].get("azimuth") for j in used],
            }
        )

    return {"planes": new_planes, "candidate_configs": configs, "flags": flags}


def _blank(found: bool = False) -> dict:
    """Base response skeleton with all keys present (stable contract for the route/UI)."""
    return {
        "found": found,
        "source": None,
        "address": None,
        "lat": None,
        "lng": None,
        "imagery_quality": None,
        "imagery_date": None,
        "imagery_stale": False,
        "manual_entry_required": False,
        "low_confidence": False,
        "needs_manual_confirmation": False,
        "reason": None,
        "flags": [],
        "selected_panel": None,
        "usability_factor": None,
        "planes": [],
        "candidate_configs": [],
        "total_kwp": None,
        "max_panels": None,
        "google_max_array_panels_count": None,
        # Retained Google geometry — empty/null on every no-find path (manual entry, 404,
        # API error), never absent, so the contract is stable for the route and the UI.
        "panels_raw": [],
        "segment_bounding_boxes": [],
        "building_center": None,
        "building_bounding_box": None,
        "error": None,
    }


# ── Public entry point ────────────────────────────────────────────────────────
def fetch_roof_geometry(
    address: str,
    panel_id: Optional[str] = None,
    usability_factor: Optional[float] = None,
) -> dict:
    """
    Geocode + buildingInsights + normalise. NEVER raises — every failure path returns a
    structured dict with found/manual_entry_required set appropriately.
    """
    out = _blank()
    out["address"] = address
    usability = _usability_factor(usability_factor)
    out["usability_factor"] = usability

    key = _api_key()
    if not key:
        out["manual_entry_required"] = True
        out["reason"] = "Google API key is missing — enter roof planes manually."
        out["error"] = "GOOGLE_MAPS_API_KEY not configured"
        out["flags"] = ["api_key_missing"]
        return out

    # Resolve the panel up front (needed for normalisation; also returned even on no-find).
    panel, panel_flags = _get_panel(panel_id)
    out["selected_panel"] = panel

    # 1) Geocode
    lat, lng, geo_err = _geocode(address, key)
    if lat is None or lng is None:
        out["manual_entry_required"] = True
        out["reason"] = "Could not locate this address — enter roof planes manually."
        out["error"] = geo_err or "geocode failed"
        out["flags"] = panel_flags + ["geocode_failed"]
        return out
    out["lat"] = lat
    out["lng"] = lng

    # 2) buildingInsights (retry once with EXPANDED_COVERAGE on NOT_FOUND)
    http_status, data, err = _building_insights(lat, lng, key)
    if data is None and err is None:  # 404 NOT_FOUND
        e_status, e_data, e_err = _building_insights(lat, lng, key, expanded=True)
        if e_data is not None:
            data, err = e_data, None
            out["flags"].append("found_via_expanded_coverage")
        else:
            out["manual_entry_required"] = True
            out["reason"] = (
                "No building imagery is available for this location (regional coverage "
                "gap) — enter roof planes manually."
            )
            out["flags"] = panel_flags + ["not_found_regional"]
            out["error"] = e_err  # None for a clean 404; populated if the retry errored
            return out
    if data is None:  # non-404 error (incl. exhausted 429/5xx retries)
        out["manual_entry_required"] = True
        out["reason"] = "Roof data is temporarily unavailable — enter roof planes manually."
        out["error"] = err or f"solar HTTP {http_status}"
        out["flags"] = panel_flags + ["solar_api_error"]
        return out

    # 3) Found — normalise (geometry only)
    out["found"] = True
    out["source"] = "google_solar"
    norm = _normalise(data, panel, usability)
    out.update(
        {
            "planes": norm["planes"],
            "candidate_configs": norm["candidate_configs"],
            "total_kwp": norm["total_kwp"],
            "max_panels": norm["max_panels"],
            "google_max_array_panels_count": norm["google_max_array_panels_count"],
            "panels_raw": norm["panels_raw"],
            "segment_bounding_boxes": norm["segment_bounding_boxes"],
            "building_center": norm["building_center"],
            "building_bounding_box": norm["building_bounding_box"],
        }
    )
    flags = panel_flags + norm["flags"]

    # Imagery metadata — always surfaced.
    out["imagery_quality"] = data.get("imageryQuality")
    img_date = _parse_imagery_date(data.get("imageryDate"))
    if img_date is not None:
        out["imagery_date"] = img_date.isoformat()
        age = _age_years(img_date)
        if age >= STALE_IMAGERY_YEARS:
            out["imagery_stale"] = True
            flags.append(f"imagery_{age}y_old")

    # Junk detection (new-build gap): <=1 segment or implausibly few Google-placed panels.
    seg_count = norm["roof_segment_count"]
    g_max = norm["google_max_array_panels_count"]
    junk = seg_count <= JUNK_MAX_SEGMENTS or (g_max is not None and g_max < JUNK_MIN_PANELS)
    if junk:
        out["low_confidence"] = True
        out["needs_manual_confirmation"] = True
        out["reason"] = "result may predate a recent build — confirm against plans"
        flags.append("low_confidence_result")

    out["flags"] = flags
    return out
