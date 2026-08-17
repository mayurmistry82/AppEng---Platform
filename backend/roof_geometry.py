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

# A roof face steeper than this is far more likely a wall, a parapet or a facade than a
# roof plane. Australian pitched roofs are commonly 15-25° for tile and 5-15° for metal;
# steep gables and heritage reach the mid-30s and rarely 45°.
#
# 45 is deliberately GENEROUS. This flag says "look at this", never "reject this" — no
# plane is ever dropped and no number ever changes because of it. A false positive costs
# one glance; a false negative puts a wrong system on a customer's quote. Found live on
# 2026-08-14: 14 Frome St returned two faces at 76.4° and 77.0° and was reported as a
# clean 10.12 kW roof.
IMPLAUSIBLE_PITCH_DEGREES = 45.0

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


def _blank_geocoded() -> dict:
    """The three authoritative-geocode keys, all None — the F22 contract skeleton."""
    return {
        "geocoded_postcode": None,
        "geocoded_state": None,
        "geocoded_formatted_address": None,
    }


def _extract_geocoded(result: Any) -> dict:
    """
    F22: pull the authoritative postcode/state/formatted address out of one geocode
    result. Every value is OPTIONAL — a missing component yields None and is NEVER
    inferred from anything else (no guessing a postcode from the address string).
    Never raises, whatever shape Google hands back.
    """
    out = _blank_geocoded()
    if not isinstance(result, dict):
        return out
    formatted = result.get("formatted_address")
    if isinstance(formatted, str) and formatted:
        out["geocoded_formatted_address"] = formatted
    components = result.get("address_components")
    if not isinstance(components, list):
        return out
    for comp in components:
        if not isinstance(comp, dict):
            continue
        types = comp.get("types")
        if not isinstance(types, list):
            continue
        if "postal_code" in types and out["geocoded_postcode"] is None:
            value = comp.get("long_name")
            if isinstance(value, str) and value:
                out["geocoded_postcode"] = value
        if "administrative_area_level_1" in types and out["geocoded_state"] is None:
            value = comp.get("short_name")  # e.g. "SA"
            if isinstance(value, str) and value:
                out["geocoded_state"] = value
    return out


def _geocode(
    address: str, key: str
) -> tuple[Optional[float], Optional[float], dict, Optional[str]]:
    """
    Return (lat, lng, geocoded, error). error is None on success. `geocoded` always
    carries the three F22 keys (possibly all None) — the authoritative values Google
    already computed, previously fetched and discarded.
    """
    params = {"address": address, "key": key, "region": "au", "components": "country:AU"}
    try:
        resp = _get_with_retry(GEOCODE_URL, params)
    except Exception as exc:  # noqa: BLE001
        return None, None, _blank_geocoded(), f"geocode request failed: {exc}"
    try:
        data = resp.json()
    except Exception:
        return None, None, _blank_geocoded(), f"geocode HTTP {resp.status_code} (non-JSON response)"
    status = data.get("status")
    if status == "OK" and data.get("results"):
        result = data["results"][0]
        loc = result["geometry"]["location"]
        return float(loc["lat"]), float(loc["lng"]), _extract_geocoded(result), None
    if status == "REQUEST_DENIED":
        msg = data.get("error_message") or "request denied"
        return None, None, _blank_geocoded(), f"geocode REQUEST_DENIED: {msg}"
    msg = data.get("error_message") or status or f"HTTP {resp.status_code}"
    return None, None, _blank_geocoded(), f"geocode failed: {msg}"


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
    """
    Turn one buildingInsights response into our normalised roof model. Geometry only.

    F17: every Google-shaped substructure is isinstance-guarded before use. A
    malformed `solarPanels`, `roofSegmentStats`, segment or `stats` degrades to
    []/None with a flag — the module docstring's "Never raises" is a contract,
    not an aspiration, and this function sits directly on third-party JSON.
    """
    if not isinstance(data, dict):
        data = {}
    sp = data.get("solarPotential")
    if not isinstance(sp, dict):
        sp = {}
    panel_area = panel["area_m2"]
    panel_watts = panel["watts"]
    flags: list[str] = []

    segments_raw = sp.get("roofSegmentStats")
    if isinstance(segments_raw, list):
        segments = segments_raw
    else:
        segments = []
        if segments_raw is not None:
            flags.append("roof_segments_malformed")

    # Google's per-segment panel counts (from the max-array layout). segmentIndex only —
    # yearlyEnergyDcKwh on each panel is intentionally ignored. F17: iterated only when
    # it is actually a list, and each entry only when it is actually a dict.
    seg_counts: dict[int, int] = {}
    solar_panels = sp.get("solarPanels")
    if solar_panels is not None and not isinstance(solar_panels, list):
        flags.append("solar_panels_malformed")
        solar_panels = []
    for p in solar_panels or []:
        if not isinstance(p, dict):
            continue
        idx = p.get("segmentIndex")
        if isinstance(idx, int):
            seg_counts[idx] = seg_counts.get(idx, 0) + 1
    have_layout = bool(seg_counts)
    if not have_layout:
        flags.append("google_panel_layout_absent")

    # 3.5 (F106): the panel dimensions Google laid panels_raw out at — width,
    # height, capacity. Without them a centre + orientation cannot make a
    # rectangle, and substituting OUR catalogue panel's size would present a
    # guess as a measurement. §20.2: these are Google Solar Data and are in the
    # 30-day retention set (solar_retention.GOOGLE_SOLAR_FIELDS).
    #
    # Never raises: absent / null / non-numeric / nested degrade to None with a
    # flag naming the absence, and zero or negative is not a usable dimension.
    # These values influence NO existing number — counts, kWp and configs are
    # computed from OUR catalogue panel above, untouched.
    def _google_dim(key: str, flag_name: str) -> Optional[float]:
        value = _num(sp.get(key))
        if value is None:
            return None
        if value <= 0:
            flags.append(f"google_panel_{flag_name}_invalid")
            return None
        return value

    google_panel_width_m = _google_dim("panelWidthMeters", "width")
    google_panel_height_m = _google_dim("panelHeightMeters", "height")
    google_panel_capacity_w = _google_dim("panelCapacityWatts", "capacity")
    if (
        google_panel_width_m is None
        and google_panel_height_m is None
        and google_panel_capacity_w is None
    ):
        flags.append("google_panel_dimensions_absent")

    planes: list[dict] = []
    max_flagged_pitch: Optional[float] = None
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            flags.append(f"segment_{i}_malformed")
            continue
        stats = seg.get("stats")
        if not isinstance(stats, dict):
            if stats is not None:
                flags.append(f"segment_{i}_stats_malformed")
            stats = {}
        area = _num(stats.get("areaMeters2"))  # NULL-safe — never coerced to 0
        quantiles = stats.get("sunshineQuantiles")
        if not isinstance(quantiles, list):
            quantiles = []
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

        # Implausible pitch (3.4-C). Flagged ONLY when this face actually carries
        # panels — a steep face with 0 panels contributes nothing to any number and is
        # harmless. A missing/negative/>90 pitch is UNKNOWN, not suspicious: never
        # invent a cause from absent data. The plane is flagged, never excluded.
        plane_index = len(planes)
        if (
            pitch is not None
            and IMPLAUSIBLE_PITCH_DEGREES < pitch <= 90.0
            and panel_count > 0
        ):
            flags.append(f"plane_{plane_index}_implausible_pitch")
            if max_flagged_pitch is None or pitch > max_flagged_pitch:
                max_flagged_pitch = pitch

        planes.append(
            {
                # 3.5 prompt 2: GOOGLE'S segment index for this plane — the
                # enumerate index `i`, NOT len(planes). The loop `continue`s past
                # a malformed segment, so the plane list position and Google's
                # segment numbering diverge the moment any segment is skipped,
                # and panels_raw[].segmentIndex refers to GOOGLE'S numbering.
                # Joining panels to planes positionally would silently attach
                # them to the wrong roof face. Additive; older rows lack this
                # key and are joined by centre match on the frontend instead.
                "segment_index": i,
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
        # Surfaced for the caller's confidence rules (3.4-C) — both were local, and
        # re-deriving them in the caller is how the original guard drifted.
        "have_google_layout": have_layout,
        "max_flagged_pitch": max_flagged_pitch,
        "google_panel_width_m": google_panel_width_m,
        "google_panel_height_m": google_panel_height_m,
        "google_panel_capacity_w": google_panel_capacity_w,
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
        # 3.5 (F106) — Google's own panel dimensions; None on every no-find and
        # manual path (a manual roof has no Google panel, ever).
        "google_panel_width_m": None,
        "google_panel_height_m": None,
        "google_panel_capacity_w": None,
        # F22 — the authoritative geocode. Present on EVERY path (404, API error,
        # manual) so the contract is stable; populated the moment a geocode succeeds.
        "geocoded_postcode": None,
        "geocoded_state": None,
        "geocoded_formatted_address": None,
        # 3.4-C — why a result is low confidence, if it is. Present (empty) on every
        # path so the contract is stable for the route and the UI.
        "low_confidence_causes": [],
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
    lat, lng, geocoded, geo_err = _geocode(address, key)
    if lat is None or lng is None:
        out["manual_entry_required"] = True
        out["reason"] = "Could not locate this address — enter roof planes manually."
        out["error"] = geo_err or "geocode failed"
        out["flags"] = panel_flags + ["geocode_failed"]
        return out
    out["lat"] = lat
    out["lng"] = lng
    # F22: populated as soon as the geocode succeeds — so the NOT_FOUND path below
    # (the regional case that goes to manual entry) still carries the authoritative
    # postcode/state it needs. A missing component stays None; nothing is inferred.
    out.update(geocoded)

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
            "google_panel_width_m": norm["google_panel_width_m"],
            "google_panel_height_m": norm["google_panel_height_m"],
            "google_panel_capacity_w": norm["google_panel_capacity_w"],
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

    # ── Confidence causes (3.4-C) ────────────────────────────────────────────
    # Evaluated INDEPENDENTLY and collected, not OR-ed into one boolean. The old
    # single expression was
    #     junk = seg_count <= 1 or (g_max is not None and g_max < 6)
    # and on 14 Frome St it returned False because there were 2 segments and g_max
    # was None — the `is not None` guard short-circuited, so "Google told us
    # NOTHING" was read as "Google told us it is FINE". Absence of evidence was
    # being treated as evidence of soundness. Each cause now stands alone and can
    # fire on its own.
    #
    # NO NUMBER CHANGES HERE and NO PLANE IS DROPPED. Everything below only sets
    # flags and wording — the panel counts, kWp and configs computed above are
    # returned exactly as they were. Silently excluding a plane would change a
    # recommendation without telling anyone, which is the black-box behaviour this
    # product exists to replace (D4: hide controls, never information).
    seg_count = norm["roof_segment_count"]
    g_max = norm["google_max_array_panels_count"]
    have_layout = norm["have_google_layout"]

    causes: list[str] = []
    if seg_count <= JUNK_MAX_SEGMENTS:
        causes.append("too_few_segments")
    if g_max is not None and g_max < JUNK_MIN_PANELS:
        causes.append("too_few_panels")
    if not have_layout or g_max is None:
        # Google placed no panels at all, or told us nothing about a layout: the
        # counts above came from raw area alone and are an UPPER BOUND.
        causes.append("no_google_panel_layout")
    if norm["max_flagged_pitch"] is not None:
        causes.append("implausible_pitch")

    if causes:
        out["low_confidence"] = True
        out["needs_manual_confirmation"] = True
        out["reason"] = _confidence_reason(causes, norm["max_flagged_pitch"])
        for cause in causes:
            flags.append(f"low_confidence_{cause}")
        # The pre-3.4-C summary flag is KEPT unchanged — the frontend and later
        # consumers already look for it. Never rename or drop an existing flag.
        flags.append("low_confidence_result")
    out["low_confidence_causes"] = causes

    out["flags"] = flags
    return out


# ── Confidence wording (3.4-C) ───────────────────────────────────────────────
_CAUSE_PHRASES = {
    "too_few_segments": "the photo shows only one roof face",
    "too_few_panels": "Google placed implausibly few panels",
    "no_google_panel_layout": (
        "Google could not fit any panels on this building, so the count comes from roof "
        "area alone"
    ),
    "implausible_pitch": "a roof face is too steep to be a roof",
}


def _confidence_reason(causes: list[str], max_pitch: Optional[float]) -> str:
    """Plain-English sentence naming the causes. Never raises."""
    parts: list[str] = []
    for cause in causes:
        phrase = _CAUSE_PHRASES.get(cause, cause)
        if cause == "implausible_pitch" and max_pitch is not None:
            phrase = f"a roof face at {round(max_pitch)}\u00b0 is too steep to be a roof"
        parts.append(phrase)
    if not parts:
        return ""
    joined = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return f"Check this roof before you use it: {joined} \u2014 confirm against the plans."


# ── Manual / plans entry (OI-10) ─────────────────────────────────────────────
_MANUAL_BASES = ("plans", "site_measure", "estimate")


def build_manual_roof_model(
    basis: str,
    planes: Any,
    panel: dict,
    usability: float,
    note: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    geocoded: Optional[dict] = None,
) -> dict:
    """
    OI-10: a roof the installer entered by hand — from plans, a site measure or an
    estimate — as a FIRST-CLASS model with the SAME shape as fetch_roof_geometry, so
    the worksheet and the optimiser consume both identically. This is the normal path
    for the regional coverage gap (1 in 5 addresses in the 2026-06-12 test), not a
    404 fallback, and it is the highest-trust geometry source when basis is plans.

    Makes NO network call of any kind. panel_count / kwp / candidate_configs come
    from the EXISTING rescale_planes_for_panel — one implementation of the cumulative
    best-plane-first logic, shared with the Google path, deliberately.

    NEVER raises, for any input, matching the module contract.
    """
    out = _blank(found=True)
    basis_str = basis if isinstance(basis, str) and basis in _MANUAL_BASES else "estimate"
    flags: list[str] = ["manual_entry", f"manual_basis_{basis_str}"]
    if basis_str != basis:
        flags.append("manual_basis_unrecognised_defaulted")

    out["source"] = f"manual_{basis_str}"
    out["manual_entry_required"] = False
    out["low_confidence"] = False
    out["needs_manual_confirmation"] = False
    out["imagery_stale"] = False
    out["selected_panel"] = panel if isinstance(panel, dict) else dict(_FALLBACK_PANEL)

    try:
        usability_val = float(usability)
        if usability_val <= 0:
            raise ValueError
    except (TypeError, ValueError):
        usability_val = DEFAULT_USABILITY_FACTOR
        flags.append("usability_factor_invalid_defaulted")
    out["usability_factor"] = usability_val

    if lat is not None and lng is not None:
        out["lat"] = _num(lat)
        out["lng"] = _num(lng)
    if out["lat"] is None or out["lng"] is None:
        out["lat"] = None
        out["lng"] = None
        flags.append("manual_no_coordinates")
    if isinstance(geocoded, dict):
        for key in ("geocoded_postcode", "geocoded_state", "geocoded_formatted_address"):
            value = geocoded.get(key)
            if isinstance(value, str) and value:
                out[key] = value

    # Shape the supplied planes defensively; the arithmetic itself is delegated.
    shaped: list[dict] = []
    plane_list = planes if isinstance(planes, list) else []
    if planes is not None and not isinstance(planes, list):
        flags.append("manual_planes_malformed")
    for i, raw in enumerate(plane_list):
        entry = raw if isinstance(raw, dict) else {}
        if not isinstance(raw, dict):
            flags.append(f"plane_{i}_malformed")
        area = _num(entry.get("area_m2"))
        if area is None or area <= 0:
            usable = None
            if entry.get("area_m2") is not None or not isinstance(raw, dict):
                flags.append(f"plane_{i}_area_invalid")
            else:
                flags.append(f"plane_{i}_area_missing")
            area = None
        else:
            usable = round(area * usability_val, 2)
        az = _num(entry.get("azimuth"))
        pitch = _num(entry.get("pitch"))
        label = entry.get("label")
        shaped.append(
            {
                "azimuth": round(az, 1) if az is not None else None,
                "pitch": round(pitch, 1) if pitch is not None else None,
                "area_m2": round(area, 2) if area is not None else None,
                "usable_area_m2": usable,
                "sunshine_quantile": None,
                "google_panel_count": None,
                "center": None,
                "label": label if isinstance(label, str) and label else None,
            }
        )

    try:
        rescaled = rescale_planes_for_panel(shaped, out["selected_panel"])
        out["planes"] = rescaled["planes"]
        out["candidate_configs"] = rescaled["candidate_configs"]
        flags.extend(rescaled["flags"])
    except Exception:  # noqa: BLE001 — belt and braces; the contract is never-raise
        out["planes"] = shaped
        out["candidate_configs"] = []
        flags.append("manual_rescale_failed")

    configs = out["candidate_configs"]
    out["total_kwp"] = configs[-1]["kwp"] if configs else 0.0
    out["max_panels"] = configs[-1]["panel_count"] if configs else 0
    if not plane_list:
        flags.append("manual_no_planes")
    elif not configs:
        flags.append("manual_no_usable_planes")

    if isinstance(note, str) and note.strip():
        out["reason"] = f"Manual entry: {note.strip()}"

    out["flags"] = flags
    return out
