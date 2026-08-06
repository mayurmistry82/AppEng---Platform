"""
backend/cost_model.py — bottom-up system cost model (foundation A3).

compute_system_cost(...) returns an itemised line-item breakdown:

    hardware (panels + inverter + battery — from the Supabase equipment catalogue)
  + solar_install   (solar_kw × installer $/kW)
  + battery_install (flat $)
  − stc_value       (computed solar STCs)
  − battery_rebate  (computed Cheaper Home Batteries STCs)
  = net_cost

Value authority: docs/2026-06-11-cost-model-pricing.md. Soft-cost + policy params come from
the `cost_assumptions` config table; `installer_profiles` overrides win. All prices are
INDICATIVE and installer-overridable — `assumptions_used` + `flags` are returned so the
breakdown is transparent. Standalone for now (NOT wired into sizing_engine/financial_model;
they consume this later).

Best-effort reads — never raises. If Supabase or a row is unavailable, documented defaults
are used and a flag is added. A NULL catalogue price falls back to the §1 tier $/W band for
panels, or a "price unavailable — installer to confirm" flag for inverter/battery — it is
NEVER treated as $0 silently.
"""

from __future__ import annotations

import math
import os
from typing import Any, Optional

import nem_data

try:  # pragma: no cover - import guard
    from supabase import create_client
except Exception:  # pragma: no cover
    create_client = None  # type: ignore[assignment]


# Documented safe defaults — used only when cost_assumptions is unreachable.
_DEFAULTS: dict[str, Any] = {
    "solar_install_per_kw": 450.0,
    "battery_install_base": 1500.0,
    "stc_price_net": 37.0,
    "deeming_years": 5,
    "battery_stc_per_kwh": 6.8,
}

# §1 tier $/W fallback bands (supply, GST inc.) for a panel with NULL cost_aud.
_PANEL_TIER_PER_W: dict[str, float] = {"value": 0.35, "mid": 0.45, "premium": 0.70}
_PANEL_FALLBACK_PER_W: float = _PANEL_TIER_PER_W["mid"]  # mid-band default

_client_cache: Any = None
_client_ready = False


# ── Supabase client (lazy; prefers service-role key, bypasses RLS) ────────────
def _client() -> Any:
    global _client_cache, _client_ready
    if _client_ready:
        return _client_cache
    _client_ready = True
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if create_client is None or not url or not key:
        _client_cache = None
        return None
    try:
        _client_cache = create_client(url, key)
    except Exception:
        _client_cache = None
    return _client_cache


def reset_client_cache() -> None:
    """Test/ops hook — drop the cached client so the next call re-reads env."""
    global _client_cache, _client_ready
    _client_cache = None
    _client_ready = False


def _round2(x: Any) -> float:
    return round(float(x), 2)


def _fetch_one(table: str, id_value: Optional[str], columns: str) -> Optional[dict]:
    c = _client()
    if c is None or not id_value:
        return None
    try:
        resp = c.table(table).select(columns).eq("id", id_value).limit(1).execute()
        data = getattr(resp, "data", None)
        return data[0] if data else None
    except Exception:
        return None


def _fetch_active_assumptions(flags: list[str]) -> dict:
    c = _client()
    if c is not None:
        try:
            resp = (
                c.table("cost_assumptions")
                .select("*")
                .eq("status", "active")
                .limit(1)
                .execute()
            )
            data = getattr(resp, "data", None)
            if data:
                row = data[0]
                return {
                    "solar_install_per_kw": float(row["solar_install_per_kw"]),
                    "battery_install_base": float(row["battery_install_base"]),
                    "stc_price_net": float(row["stc_price_net"]),
                    "deeming_years": int(row["deeming_years"]),
                    "battery_stc_per_kwh": float(row["battery_stc_per_kwh"]),
                    "source": row.get("source"),
                    "last_verified": row.get("last_verified"),
                }
        except Exception:
            pass
    flags.append("cost_assumptions unavailable — used documented default soft-cost/STC params.")
    return {**_DEFAULTS, "source": "documented defaults (cost_assumptions unavailable)", "last_verified": None}


def _fetch_installer_override(installer_id: Optional[str]) -> Optional[dict]:
    c = _client()
    if c is None or not installer_id:
        return None
    try:
        resp = (
            c.table("installer_profiles")
            .select("solar_install_per_kw,battery_install_base")
            .eq("user_id", installer_id)
            .limit(1)
            .execute()
        )
        data = getattr(resp, "data", None)
        return data[0] if data else None
    except Exception:
        return None


def _pick(override: Optional[dict], assumptions: dict, key: str, flags: list[str]) -> float:
    if override and override.get(key) is not None:
        val = float(override[key])
        flags.append(f"{key}: installer override applied (${val:g}).")
        return val
    return float(assumptions[key])


def _panel_unit_price(panel_row: dict) -> tuple[float, Optional[str]]:
    cost = panel_row.get("cost_aud")
    if cost is not None:
        return float(cost), None
    rated_w = panel_row.get("rated_power_w") or 0
    unit = _PANEL_FALLBACK_PER_W * float(rated_w)
    return unit, (
        f"Panel price unavailable ({panel_row.get('brand')} {panel_row.get('model')}) — "
        f"used mid-band ${_PANEL_FALLBACK_PER_W:.2f}/W fallback (not $0)."
    )


def compute_system_cost(
    solar_kw: float,
    panel_id: Optional[str] = None,
    panel_count: Optional[int] = None,
    inverter_id: Optional[str] = None,
    battery_id: Optional[str] = None,
    battery_usable_kwh: Optional[float] = None,
    postcode: Optional[str] = None,
    state: Optional[str] = None,
    installer_id: Optional[str] = None,
) -> dict:
    """Bottom-up itemised system cost. Never raises; returns a dict (see module docstring)."""
    flags: list[str] = []
    try:
        solar_kw = float(solar_kw or 0)
    except (TypeError, ValueError):
        solar_kw = 0.0

    assumptions = _fetch_active_assumptions(flags)
    override = _fetch_installer_override(installer_id) if installer_id else None
    solar_install_per_kw = _pick(override, assumptions, "solar_install_per_kw", flags)
    battery_install_base = _pick(override, assumptions, "battery_install_base", flags)
    stc_price_net = float(assumptions["stc_price_net"])
    deeming_years = int(assumptions["deeming_years"])
    battery_stc_per_kwh = float(assumptions["battery_stc_per_kwh"])

    # ── Panels ──
    panels_qty = panel_count
    panel_unit: Optional[float] = None
    panel_detail = ""
    panel_row = (
        _fetch_one("panels", panel_id, "brand,model,rated_power_w,cost_aud")
        if panel_id
        else None
    )
    if panel_row:
        rated_w = panel_row.get("rated_power_w") or 0
        if not panels_qty and rated_w:
            panels_qty = max(1, round(solar_kw * 1000 / float(rated_w)))
        panel_unit, pflag = _panel_unit_price(panel_row)
        if pflag:
            flags.append(pflag)
        panels_total = _round2(panel_unit * (panels_qty or 0))
        panel_detail = (
            f"{panels_qty or 0} × {panel_row.get('brand')} {panel_row.get('model')} "
            f"({rated_w} W)"
        )
    else:
        if panel_id:
            flags.append("Panel not found in catalogue — used mid-band $/W fallback (not $0).")
        else:
            flags.append("No panel selected — used mid-band $/W fallback on solar_kw (not $0).")
        panels_total = _round2(_PANEL_FALLBACK_PER_W * solar_kw * 1000)
        panel_detail = f"~${_PANEL_FALLBACK_PER_W:.2f}/W × {solar_kw:g} kW (tier fallback)"

    # ── Inverter ──
    inverter_total = 0.0
    inverter_priced = False
    inverter_detail = ""
    inv_row = (
        _fetch_one("inverters", inverter_id, "brand,model,cost_aud") if inverter_id else None
    )
    if inv_row:
        inverter_detail = f"{inv_row.get('brand')} {inv_row.get('model')}"
        if inv_row.get("cost_aud") is not None:
            inverter_total = _round2(inv_row["cost_aud"])
            inverter_priced = True
        else:
            flags.append(
                f"Inverter price unavailable ({inverter_detail}) — installer to confirm; "
                f"excluded from total (not $0)."
            )
    elif inverter_id:
        inverter_detail = "not found"
        flags.append("Inverter not found in catalogue — excluded; installer to confirm (not $0).")

    # ── Battery (optional) ──
    has_battery = bool(battery_id)
    battery_total = 0.0
    battery_priced = False
    battery_install = 0.0
    battery_rebate = 0.0
    battery_detail = ""
    usable_kwh: Optional[float] = None
    eff_kwh = 0.0
    if has_battery:
        bat_row = _fetch_one(
            "batteries", battery_id, "brand,model,usable_capacity_kwh,cost_aud"
        )
        usable_kwh = (
            battery_usable_kwh
            if battery_usable_kwh is not None
            else (bat_row.get("usable_capacity_kwh") if bat_row else None)
        )
        if bat_row:
            battery_detail = f"{bat_row.get('brand')} {bat_row.get('model')}"
            if bat_row.get("cost_aud") is not None:
                battery_total = _round2(bat_row["cost_aud"])
                battery_priced = True
            else:
                flags.append(
                    f"Battery price unavailable ({battery_detail}) — installer to confirm; "
                    f"excluded from total (not $0)."
                )
        else:
            battery_detail = "not found"
            flags.append("Battery not found in catalogue — excluded; installer to confirm (not $0).")

        battery_install = _round2(battery_install_base)
        eff_kwh = nem_data.battery_rebate_effective_kwh(usable_kwh)
        battery_rebate = _round2(eff_kwh * battery_stc_per_kwh * stc_price_net)

    # ── Solar install ──
    solar_install = _round2(solar_kw * solar_install_per_kw)

    # ── Solar STCs ──
    zone = nem_data.get_stc_zone_rating(state=state, postcode=postcode)
    if zone["is_default"]:
        flags.append("STC zone defaulted to Zone 3 (state/postcode not recognised).")
    stc_count = math.floor(solar_kw * zone["zone_rating"] * deeming_years)
    stc_value = _round2(stc_count * stc_price_net)

    # ── Net ──
    gross = panels_total + inverter_total + battery_total + solar_install + battery_install
    net = _round2(gross - stc_value - battery_rebate)
    net_per_watt = _round2(net / (solar_kw * 1000)) if solar_kw > 0 else None

    # ── Itemised line items (canonical order) ──
    line_items: list[dict] = [
        {
            "item": "Panels",
            "detail": panel_detail,
            "unit_cost_aud": _round2(panel_unit) if panel_unit is not None else None,
            "quantity": panels_qty,
            "amount_aud": panels_total,
        }
    ]
    if inverter_id:
        line_items.append({
            "item": "Inverter",
            "detail": inverter_detail,
            "amount_aud": inverter_total if inverter_priced else None,
        })
    if has_battery:
        line_items.append({
            "item": "Battery",
            "detail": f"{battery_detail} ({usable_kwh} kWh usable, pre-rebate)" if battery_detail else "",
            "amount_aud": battery_total if battery_priced else None,
        })
    line_items.append({
        "item": "Solar install",
        "detail": f"{solar_kw:g} kW × ${solar_install_per_kw:g}/kW (labour + BOS + electrical + margin)",
        "amount_aud": solar_install,
    })
    if has_battery:
        line_items.append({
            "item": "Battery install",
            "detail": f"flat ${battery_install_base:g} (install / wiring / gateway)",
            "amount_aud": battery_install,
        })
    line_items.append({
        "item": "STCs (solar)",
        "detail": (
            f"floor({solar_kw:g} × {zone['zone_rating']} × {deeming_years}) = {stc_count} STCs "
            f"× ${stc_price_net:g}"
        ),
        "amount_aud": _round2(-stc_value),
    })
    if has_battery:
        line_items.append({
            "item": "Battery rebate",
            "detail": (
                f"Cheaper Home Batteries — {eff_kwh:g} eff. kWh × {battery_stc_per_kwh:g}/kWh "
                f"× ${stc_price_net:g}"
            ),
            "amount_aud": _round2(-battery_rebate),
        })

    return {
        "hardware": {
            "panels": panels_total,
            "inverter": inverter_total if inverter_priced else None,
            "battery": (battery_total if battery_priced else None) if has_battery else None,
        },
        "solar_install": solar_install,
        "battery_install": battery_install if has_battery else None,
        "stc_value": _round2(-stc_value),
        "battery_rebate": _round2(-battery_rebate) if has_battery else None,
        "net_cost": net,
        "net_cost_per_watt": net_per_watt,
        "line_items": line_items,
        "assumptions_used": {
            "solar_install_per_kw": solar_install_per_kw,
            "battery_install_base": battery_install_base if has_battery else None,
            "stc_price_net": stc_price_net,
            "deeming_years": deeming_years,
            "battery_stc_per_kwh": battery_stc_per_kwh,
            "stc_zone": zone["zone"],
            "stc_zone_rating": zone["zone_rating"],
            "stc_zone_is_default": zone["is_default"],
            "stc_count": stc_count,
            "panel_count": panels_qty,
            "config_source": assumptions.get("source"),
            "config_last_verified": str(assumptions.get("last_verified")) if assumptions.get("last_verified") else None,
            "prices_indicative": True,
            "note": "Indicative AU prices (±20–30%), installer-overridable — not fixed quotes.",
        },
        "flags": flags,
    }
