#!/usr/bin/env python3
"""
verify_incentives_contract.py — the 3.13b prompt-1 gate: the dated federal
incentive schedules (F224), the CEC-approval fact (F225), and the cost
model's time-honesty about both deductions.

Covers: the fixture arithmetic (stub AND live), the 8.4/6.8 boundary on both
sides, the 2027 expiry (an unknown rate is NOT quoted — amount_aud None, net
excludes it), the no-battery path, never-raise on junk inputs, the
config-vs-schedule comparison flag, and cec_approval_checked False with the
CEC flag on every battery run and absent on every solar-only run.

Mostly OFFLINE via a stub client — writes NOTHING. The live-database section
SKIPS LOUDLY (printed, uncounted, never a pass — F177) when the database is
unreachable.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_incentives_contract.py
"""
from __future__ import annotations

import os
import sys
import traceback
from contextlib import contextmanager
from datetime import date, datetime
from zoneinfo import ZoneInfo

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

import cost_model  # noqa: E402
import nem_data  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0
SKIPPED = 0

SHAPE_KEYS = {"value", "is_known", "valid_from", "valid_to", "source",
              "verified_on", "reason"}
FIXTURE_RUN_ID = "523b9c93-8185-42ba-bea6-ee7b8fce3780"


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


def skip(msg: str) -> None:
    global SKIPPED
    SKIPPED += 1
    print(f"  SKIP  {msg} NOT counted as a pass (F177).")


# ── Stub client (offline; records nothing, writes nothing) ───────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _StubQuery:
    def __init__(self, rows):
        self._rows = [dict(r) for r in rows]

    def select(self, _cols):
        return self

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return _Result(self._rows)


class _StubClient:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _StubQuery(self._tables.get(name, []))


def _stub(cfg_deeming=5, cfg_factor=6.8, last_verified="2026-06-11"):
    """The fixture, replicated offline: 21 × 440 W Jinko @ $215, GoodWe Lynx
    Home F 9.83 kWh @ $6500, install $450/kW + $1500 flat, STC $37."""
    return _StubClient({
        "cost_assumptions": [{
            "solar_install_per_kw": 450, "battery_install_base": 1500,
            "stc_price_net": 37, "deeming_years": cfg_deeming,
            "battery_stc_per_kwh": cfg_factor, "source": "stub",
            "last_verified": last_verified, "status": "active",
        }],
        "panels": [{"id": "p1", "brand": "Jinko", "model": "Tiger Neo",
                    "rated_power_w": 440, "cost_aud": 215}],
        "inverters": [],
        "batteries": [{"id": "b1", "brand": "GoodWe", "model": "Lynx Home F",
                       "usable_capacity_kwh": 9.83, "cost_aud": 6500}],
        "installer_profiles": [],
    })


@contextmanager
def _client_swapped(stub):
    saved = (cost_model._client_cache, cost_model._client_ready)
    cost_model._client_cache, cost_model._client_ready = stub, True
    try:
        yield
    finally:
        cost_model._client_cache, cost_model._client_ready = saved


FIX = dict(solar_kw=9.24, panel_id="p1", panel_count=21, battery_id="b1",
           battery_usable_kwh=9.83, postcode="5068", state="SA")
GROSS = 4515.0 + 6500.0 + 4158.0 + 1500.0  # panels+battery+solar_install+battery_install


def _line(bd, item):
    return next((li for li in bd.get("line_items", []) if li.get("item") == item), None)


def _has(bd, needle):
    return any(needle in str(f) for f in bd.get("flags", []))


# ── 1. the schedule functions themselves (offline) ───────────────────────────
def t1_schedules() -> None:
    print("\nCHECK 1 — nem_data's dated schedules resolve by date, never guess")
    f = nem_data.get_battery_stc_factor
    d = nem_data.get_solar_deeming_years

    r = f(date(2026, 1, 1))
    check("(1) battery factor 2026-01-01 = 8.4 (first period, front edge)",
          r["is_known"] is True and r["value"] == 8.4, str(r))
    r = f(date(2026, 4, 30))
    check("(1) battery factor 2026-04-30 = 8.4 (boundary, inclusive)",
          r["is_known"] is True and r["value"] == 8.4
          and r["valid_from"] == "2026-01-01" and r["valid_to"] == "2026-04-30", str(r))
    r = f(date(2026, 5, 1))
    check("(1) battery factor 2026-05-01 = 6.8 (the step)",
          r["is_known"] is True and r["value"] == 6.8, str(r))
    r = f(date(2026, 12, 31))
    check("(1) battery factor 2026-12-31 = 6.8 (last verified day)",
          r["is_known"] is True and r["value"] == 6.8, str(r))
    r = f(date(2027, 1, 15))
    check("(1) battery factor 2027-01-15 = UNKNOWN, reason names the last "
          "known period — never the nearest period",
          r["is_known"] is False and r["value"] is None
          and "2026-05-01" in str(r["reason"]) and "2026-12-31" in str(r["reason"]),
          str(r))
    r = f(date(2025, 12, 31))
    check("(1) battery factor 2025-12-31 = UNKNOWN (before every period; no "
          "backwards fallback either)",
          r["is_known"] is False and r["value"] is None, str(r))
    r = d(date(2026, 8, 25))
    check("(1) deeming 2026-08-25 = 5 years, window 2026-01-01..2026-12-31",
          r["is_known"] is True and r["value"] == 5
          and r["valid_from"] == "2026-01-01" and r["valid_to"] == "2026-12-31", str(r))
    r = d(date(2027, 1, 15))
    check("(1) deeming 2027-01-15 = UNKNOWN, reason names the last known period",
          r["is_known"] is False and r["value"] is None
          and "2026-01-01" in str(r["reason"]) and "2026-12-31" in str(r["reason"]),
          str(r))

    junk = [None, "2026-06-01", "junk", datetime(2026, 6, 1, 12, 0),
            date(1900, 1, 1), date(2099, 12, 31), 42, 6.8, [], {}, object()]
    for name, fn in (("get_battery_stc_factor", f), ("get_solar_deeming_years", d)):
        ok = True
        why = ""
        for j in junk:
            try:
                out = fn(j)
                if not isinstance(out, dict) or set(out.keys()) != SHAPE_KEYS:
                    ok, why = False, f"bad shape for {j!r}: {out!r}"
                    break
                if out["is_known"] and not isinstance(j, (date, datetime)):
                    ok, why = False, f"{j!r} resolved as known: {out!r}"
                    break
            except Exception as ex:  # noqa: BLE001
                ok, why = False, f"RAISED on {j!r}: {type(ex).__name__}: {ex}"
                break
        check(f"(1) {name} NEVER raises and keeps the exact shape on None / "
              f"string / datetime / far dates / junk", ok, why)

    for tname, table in (("BATTERY_STC_FACTOR_PERIODS",
                          nem_data.BATTERY_STC_FACTOR_PERIODS),
                         ("SOLAR_DEEMING_YEARS_PERIODS",
                          nem_data.SOLAR_DEEMING_YEARS_PERIODS)):
        ok = True
        why = ""
        prev_to = None
        for (vf, vt, val, src, ver) in table:
            try:
                dvf, dvt = date.fromisoformat(vf), date.fromisoformat(vt)
                date.fromisoformat(ver)
            except ValueError:
                ok, why = False, f"unparseable dates in {(vf, vt, ver)}"
                break
            if dvf > dvt or not str(src).startswith("https://"):
                ok, why = False, f"bad entry {(vf, vt, src)}"
                break
            if prev_to is not None and dvf <= prev_to:
                ok, why = False, f"overlap/disorder at {vf}"
                break
            prev_to = dvt
        check(f"(1) {tname} is ordered, non-overlapping, dated and sourced", ok, why)


# ── 2. the cost model's time honesty (offline, stub client) ──────────────────
def t2_cost_model() -> None:
    print("\nCHECK 2 — compute_system_cost resolves policy against as_at")
    with _client_swapped(_stub()):
        # (a) the fixture, at the verified date
        bd = cost_model.compute_system_cost(as_at=date(2026, 8, 25), **FIX)
        check("(2a) fixture stc_value == -2331.00",
              bd["stc_value"] == -2331.0, str(bd["stc_value"]))
        check("(2a) fixture battery_rebate == -2473.23",
              bd["battery_rebate"] == -2473.23, str(bd["battery_rebate"]))
        check("(2a) fixture net_cost == 11868.77 (gross 16673 − 2331 − 2473.23)",
              bd["net_cost"] == 11868.77, str(bd["net_cost"]))
        au = bd["assumptions_used"]
        nine = {"as_at", "battery_stc_factor_window", "battery_stc_factor_is_known",
                "deeming_years_window", "deeming_years_is_known", "policy_source",
                "policy_verified_on", "config_age_days", "cec_approval_checked"}
        check("(2a) all nine 3.13b keys present in assumptions_used",
              nine <= set(au.keys()), str(sorted(nine - set(au.keys()))))
        check("(2a) as_at recorded; both windows known and dated",
              au["as_at"] == "2026-08-25"
              and au["battery_stc_factor_window"] == "2026-05-01..2026-12-31"
              and au["deeming_years_window"] == "2026-01-01..2026-12-31"
              and au["battery_stc_factor_is_known"] is True
              and au["deeming_years_is_known"] is True,
              str({k: au.get(k) for k in nine}))
        check("(2a) policy_source names both CER pages; policy_verified_on set",
              isinstance(au["policy_source"], dict)
              and str(au["policy_source"].get("battery_stc_factor", "")).startswith("https://cer.gov.au/")
              and str(au["policy_source"].get("solar_deeming_years", "")).startswith("https://cer.gov.au/")
              and au["policy_verified_on"] == "2026-08-25", str(au.get("policy_source")))
        check("(2a) config_age_days == 75 (2026-06-11 → 2026-08-25) and NO "
              "stale-config flag at ≤90 days",
              au["config_age_days"] == 75 and not _has(bd, "MARKET price"),
              f"age={au['config_age_days']} flags={bd['flags']}")
        check("(2a) cec_approval_checked is False AND the CEC flag is on this "
              "battery run (F225 — a fact on screen)",
              au["cec_approval_checked"] is False
              and _has(bd, "Clean Energy Council") and _has(bd, "4.10"),
              str(bd["flags"]))
        check("(2a) agreeing config raises NO schedule-vs-config flag",
              not _has(bd, "the schedule wins"), str(bd["flags"]))

        # (b) the boundary, both sides
        apr = cost_model.compute_system_cost(as_at=date(2026, 4, 30), **FIX)
        may = cost_model.compute_system_cost(as_at=date(2026, 5, 1), **FIX)
        dec = cost_model.compute_system_cost(as_at=date(2026, 12, 31), **FIX)
        print(f"        rebates: 2026-04-30 {apr['battery_rebate']}  "
              f"2026-05-01 {may['battery_rebate']}  2026-12-31 {dec['battery_rebate']}")
        check("(2b) 2026-04-30 uses factor 8.4 → rebate -3055.16 "
              "(9.83 × 8.4 × $37)",
              apr["battery_rebate"] == -3055.16, str(apr["battery_rebate"]))
        check("(2b) 2026-05-01 and 2026-12-31 both use 6.8 → -2473.23, equal; "
              "and the April figure differs",
              may["battery_rebate"] == -2473.23
              and dec["battery_rebate"] == -2473.23
              and apr["battery_rebate"] != may["battery_rebate"],
              f"{apr['battery_rebate']} {may['battery_rebate']} {dec['battery_rebate']}")

        # (c) the expiry — THE WHOLE POINT (F224)
        x = cost_model.compute_system_cost(as_at=date(2027, 1, 15), **FIX)
        xau = x["assumptions_used"]
        reb = _line(x, "Battery rebate")
        stc = _line(x, "STCs (solar)")
        check("(2c) 2027-01-15: battery rebate line amount_aud is None with a "
              "reason naming the last known period — NOT a stale -2473.23",
              reb is not None and reb["amount_aud"] is None
              and "2026-05-01" in reb["detail"] and "2026-12-31" in reb["detail"],
              str(reb))
        check("(2c) 2027-01-15: STC line amount_aud is None, same treatment",
              stc is not None and stc["amount_aud"] is None
              and "2026-01-01" in stc["detail"] and "2026-12-31" in stc["detail"],
              str(stc))
        check("(2c) 2027-01-15: net_cost == GROSS cost (16673.0) — neither "
              "deduction taken, neither zeroed",
              x["net_cost"] == GROSS and x["stc_value"] is None
              and x["battery_rebate"] is None, str(x["net_cost"]))
        check("(2c) 2027-01-15: is_known False on both windows; windows None; "
              "deeming_years and battery_stc_per_kwh None",
              xau["battery_stc_factor_is_known"] is False
              and xau["deeming_years_is_known"] is False
              and xau["battery_stc_factor_window"] is None
              and xau["deeming_years_window"] is None
              and xau["deeming_years"] is None
              and xau["battery_stc_per_kwh"] is None, str(xau))
        check("(2c) 2027-01-15: config_age_days == 218 and the stale-config "
              "flag fires, naming the market price it applies to",
              xau["config_age_days"] == 218 and _has(x, "MARKET price")
              and _has(x, "stc_price_net"), f"age={xau['config_age_days']} flags={x['flags']}")

        # (d) the no-battery path
        s = cost_model.compute_system_cost(
            solar_kw=9.24, panel_id="p1", panel_count=21, postcode="5068",
            state="SA", as_at=date(2026, 8, 25))
        check("(2d) solar-only: stc -2331.0, battery_rebate None, no Battery "
              "rebate line, net 6342.0",
              s["stc_value"] == -2331.0 and s["battery_rebate"] is None
              and _line(s, "Battery rebate") is None and s["net_cost"] == 6342.0,
              f"{s['stc_value']} {s['net_cost']}")
        check("(2d) solar-only: NO CEC flag, yet cec_approval_checked key "
              "still present and False",
              not _has(s, "Clean Energy Council")
              and s["assumptions_used"]["cec_approval_checked"] is False,
              str(s["flags"]))
        sx = cost_model.compute_system_cost(
            solar_kw=9.24, panel_id="p1", panel_count=21, postcode="5068",
            state="SA", as_at=date(2027, 1, 15))
        check("(2d) solar-only at 2027-01-15: STC not taken, net == its gross "
              "8673.0",
              sx["stc_value"] is None and sx["net_cost"] == 8673.0,
              str(sx["net_cost"]))

        # (e) junk in, dict out — the model still NEVER raises
        try:
            j = cost_model.compute_system_cost(solar_kw="junk", as_at="junk")
            ok = isinstance(j, dict) and "net_cost" in j
            why = str(type(j))
        except Exception as ex:  # noqa: BLE001
            ok, why = False, f"RAISED: {type(ex).__name__}: {ex}"
        check("(2e) junk solar_kw + junk as_at: returns a dict, never raises", ok, why)

        try:
            dflt = cost_model.compute_system_cost(**FIX)
            today_adl = datetime.now(ZoneInfo("Australia/Adelaide")).date().isoformat()
            ok = dflt["assumptions_used"]["as_at"] == today_adl
            why = f"{dflt['assumptions_used']['as_at']} vs {today_adl}"
        except Exception as ex:  # noqa: BLE001
            ok, why = False, f"RAISED: {type(ex).__name__}: {ex}"
        check("(2e) as_at omitted → defaults to today in Australia/Adelaide", ok, why)

    # (f) the config-vs-schedule comparison — the schedule WINS and says so
    with _client_swapped(_stub(cfg_deeming=6, cfg_factor=7.5)):
        dd = cost_model.compute_system_cost(as_at=date(2026, 8, 25), **FIX)
        deem_flag = next((f for f in dd["flags"]
                          if "Solar deeming period" in f and "the schedule wins" in f), None)
        bat_flag = next((f for f in dd["flags"]
                         if "Battery STC factor" in f and "the schedule wins" in f), None)
        check("(2f) disagreeing config: BOTH comparison flags fire, in plain "
              "English, naming both numbers",
              deem_flag is not None and "5" in deem_flag and "6" in deem_flag
              and bat_flag is not None and "6.8" in bat_flag and "7.5" in bat_flag,
              str(dd["flags"]))
        check("(2f) …and the schedule WINS arithmetically: stc -2331.0 and "
              "rebate -2473.23 despite config 6 years / 7.5 per kWh",
              dd["stc_value"] == -2331.0 and dd["battery_rebate"] == -2473.23,
              f"{dd['stc_value']} {dd['battery_rebate']}")

    # (g) last_verified absent → age None, no age flag even far in the future
    with _client_swapped(_stub(last_verified=None)):
        nv = cost_model.compute_system_cost(as_at=date(2027, 1, 15), **FIX)
        check("(2g) last_verified absent: config_age_days is None and the age "
              "flag is not raised",
              nv["assumptions_used"]["config_age_days"] is None
              and not _has(nv, "MARKET price"), str(nv["flags"]))


# ── 3. the live database (loud-skip when unreachable; READS ONLY) ────────────
def t3_live() -> None:
    print("\nCHECK 3 — the live fixture (reads only; skips loudly without a DB)")
    cost_model.reset_client_cache()
    c = cost_model._client()
    if c is None:
        skip("(3) no Supabase client (env not set / package missing) — the "
             "live fixture checks need the database.")
        return
    try:
        panels = (c.table("panels").select("id,brand,model").execute().data) or []
        bats = (c.table("batteries").select("id,brand,model").execute().data) or []
    except Exception as ex:  # noqa: BLE001
        skip(f"(3) catalogue unreadable ({type(ex).__name__}) — live checks skipped.")
        return
    pid = next((p["id"] for p in panels if "Tiger Neo" in str(p.get("model"))), None)
    bid = next((b["id"] for b in bats if "Lynx Home F" in str(b.get("model"))), None)
    if not pid or not bid:
        skip("(3) fixture panel/battery not found in the live catalogue.")
        return
    bd = cost_model.compute_system_cost(
        solar_kw=9.24, panel_id=pid, panel_count=21, battery_id=bid,
        battery_usable_kwh=9.83, postcode="5068", state="SA",
        as_at=date(2026, 8, 25))
    check("(3) live fixture: stc_value -2331.0 and battery_rebate -2473.23 "
          "at the verified date",
          bd["stc_value"] == -2331.0 and bd["battery_rebate"] == -2473.23,
          f"{bd['stc_value']} {bd['battery_rebate']}")
    try:
        row = (c.table("sizing_results").select("evaluated_options")
               .eq("sizing_result_id", FIXTURE_RUN_ID).limit(1).execute().data)
    except Exception as ex:  # noqa: BLE001
        skip(f"(3) stored run unreadable ({type(ex).__name__}).")
        return
    if not row:
        skip(f"(3) stored run {FIXTURE_RUN_ID[:8]}… not found.")
        return
    stored = ((row[0].get("evaluated_options") or {})
              .get("chosen_cost_breakdown") or {})
    check("(3) live fixture net_cost equals the STORED run 523b9c93…'s "
          "net_cost — proved from the database, not from a test",
          bd["net_cost"] == stored.get("net_cost"),
          f"{bd['net_cost']} vs stored {stored.get('net_cost')}")


def main_() -> int:
    print("verify_incentives_contract.py — 3.13b prompt 1 (stub offline + "
          "live reads, writes nothing)")
    t1_schedules()
    t2_cost_model()
    t3_live()
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({SKIPPED} skipped LOUDLY, not counted)" if SKIPPED else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main_())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
