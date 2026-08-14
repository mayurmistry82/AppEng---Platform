#!/usr/bin/env python3
"""
verify_roof_contract.py — proves the 3.4-A roof contract: F17 never-raises
hardening, manual-model arithmetic, route auth/ownership, and (with --live)
the three Google coverage cases from the 2026-06-12 CSV.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_roof_contract.py [--live]

Use the interpreter the BACKEND runs under, never bare `python3` (F91 — the
PATH python has no dotenv/fastapi/supabase).

Default run is OFFLINE: no network, no database. Supabase is replaced by stubs
(the same seam style as verify_auth_membership.py — module-level client
factories are swapped out, so create_client is never reached), and the Google
entry point is monkeypatched where a route would otherwise call it. `--live`
adds three real fetch_roof_geometry() calls, which perform NO database write
(persistence lives in the route, not the fetch function).
"""
from __future__ import annotations

import asyncio
import os
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import inspect  # noqa: E402

import roof_geometry  # noqa: E402
from routes import roof  # noqa: E402
import auth  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.params import Depends as DependsParam  # noqa: E402
from pydantic import ValidationError  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


PANEL = dict(roof_geometry._FALLBACK_PANEL)
CALLER = auth.Caller(user_id="user-1", email="u@example.com", company_id="co-1", role="owner")


# ── Stub Supabase client ──────────────────────────────────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, rows, recorder, raise_on_query=False):
        self._rows = rows
        self._recorder = recorder
        self._raise = raise_on_query

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def insert(self, row):
        self._recorder.append(row)
        return self

    def execute(self):
        if self._raise:
            raise OSError(35, "Resource temporarily unavailable")
        return _Result(self._rows)


class StubClient:
    """jobs + roof_geometry tables with fixed rows; records every insert."""

    def __init__(self, jobs_rows=None, roof_rows=None):
        self.inserts: list = []
        self._jobs = jobs_rows or []
        self._roof = roof_rows or []

    def table(self, name):
        rows = self._jobs if name == "jobs" else self._roof
        return _Table(rows, self.inserts)


def t1() -> None:
    print("T1. F17 — _normalise never raises on malformed Google JSON")
    cases = [
        ("solarPanels is a dict", {"solarPotential": {"solarPanels": {"a": 1},
                                                      "roofSegmentStats": []}}),
        ("solarPanels is a string", {"solarPotential": {"solarPanels": "not a list",
                                                        "roofSegmentStats": []}}),
        ("segment list holds junk and None", {"solarPotential": {"roofSegmentStats": [
            {"stats": {"areaMeters2": 40.0, "sunshineQuantiles": [1, 2, 3]}},
            "junk", None]}}),
        ("roofSegmentStats is a dict", {"solarPotential": {"roofSegmentStats": {"not": "a list"}}}),
        ("a segment's stats is a string", {"solarPotential": {"roofSegmentStats": [
            {"stats": "junk-string", "azimuthDegrees": 10}]}}),
    ]
    for name, data in cases:
        try:
            out = roof_geometry._normalise(data, PANEL, 0.7)
            check(f"{name} -> returns dict", isinstance(out, dict))
        except Exception as exc:  # noqa: BLE001
            check(f"{name} -> returns dict", False, f"raised {type(exc).__name__}: {exc}")
    # The valid segment among junk still computes.
    out = roof_geometry._normalise(cases[2][1], PANEL, 0.7)
    good = [p for p in out.get("planes", []) if p.get("area_m2") is not None]
    check("valid segment among junk still yields a plane", len(good) == 1,
          f"planes={out.get('planes')}")
    check("junk segments are flagged", any("malformed" in f for f in out.get("flags", [])),
          f"flags={out.get('flags')}")


def t2() -> None:
    print("\nT2. manual model arithmetic (fallback panel 1.9981 m², 440 W, usability 0.7)")
    model = roof_geometry.build_manual_roof_model(
        basis="plans",
        planes=[
            {"azimuth": 0, "pitch": 22, "area_m2": 50.0},
            {"azimuth": 270, "pitch": 22, "area_m2": 30.0},
        ],
        panel=PANEL,
        usability=0.7,
    )
    p0, p1 = model["planes"][0], model["planes"][1]
    c = model["candidate_configs"]
    expected = [
        ("plane0 usable_area_m2 35.0", p0["usable_area_m2"] == 35.0, p0["usable_area_m2"]),
        ("plane0 panel_count 17", p0["panel_count"] == 17, p0["panel_count"]),
        ("plane0 kwp 7.48", p0["kwp"] == 7.48, p0["kwp"]),
        ("plane1 usable_area_m2 21.0", p1["usable_area_m2"] == 21.0, p1["usable_area_m2"]),
        ("plane1 panel_count 10", p1["panel_count"] == 10, p1["panel_count"]),
        ("plane1 kwp 4.4", p1["kwp"] == 4.4, p1["kwp"]),
        ("config0 n_planes 1", c and c[0]["n_planes"] == 1, c),
        ("config0 panel_count 17", c and c[0]["panel_count"] == 17, c),
        ("config0 kwp 7.48", c and c[0]["kwp"] == 7.48, c),
        ("config1 n_planes 2", len(c) > 1 and c[1]["n_planes"] == 2, c),
        ("config1 panel_count 27", len(c) > 1 and c[1]["panel_count"] == 27, c),
        ("config1 kwp 11.88", len(c) > 1 and c[1]["kwp"] == 11.88, c),
        ("total_kwp 11.88", model["total_kwp"] == 11.88, model["total_kwp"]),
        ("max_panels 27", model["max_panels"] == 27, model["max_panels"]),
        ("source manual_plans", model["source"] == "manual_plans", model["source"]),
        ("found True", model["found"] is True, model["found"]),
        ("low_confidence False", model["low_confidence"] is False, model["low_confidence"]),
        ("panels_raw []", model["panels_raw"] == [], model["panels_raw"]),
        ("segment_bounding_boxes []", model["segment_bounding_boxes"] == [],
         model["segment_bounding_boxes"]),
    ]
    for name, ok, actual in expected:
        check(name, bool(ok), f"actual: {actual!r}")
    check("flag manual_entry", "manual_entry" in model["flags"], str(model["flags"]))
    check("flag manual_basis_plans", "manual_basis_plans" in model["flags"], str(model["flags"]))
    check("flag manual_no_coordinates (no lat/lng given)",
          "manual_no_coordinates" in model["flags"], str(model["flags"]))


def t3() -> None:
    print("\nT3. manual model — degenerate inputs")
    empty = roof_geometry.build_manual_roof_model("plans", [], PANEL, 0.7)
    check("planes=[] -> no raise, planes []", empty["planes"] == [], str(empty["planes"]))
    check("planes=[] -> configs []", empty["candidate_configs"] == [])
    check("planes=[] -> total_kwp 0", empty["total_kwp"] == 0.0, str(empty["total_kwp"]))
    check("planes=[] -> max_panels 0", empty["max_panels"] == 0, str(empty["max_panels"]))
    check("planes=[] -> explaining flag", "manual_no_planes" in empty["flags"],
          str(empty["flags"]))

    none_area = roof_geometry.build_manual_roof_model(
        "plans", [{"azimuth": 0, "pitch": 20, "area_m2": None}], PANEL, 0.7)
    check("area None -> panel_count 0", none_area["planes"][0]["panel_count"] == 0)
    check("area None -> per-plane flag",
          any(f.startswith("plane_0_area") for f in none_area["flags"]),
          str(none_area["flags"]))

    mixed = roof_geometry.build_manual_roof_model(
        "site_measure",
        [{"azimuth": 0, "pitch": 20, "area_m2": -5},
         {"azimuth": 90, "pitch": 20, "area_m2": 20.0}],
        PANEL, 0.7)
    check("area -5 -> that plane 0, no raise", mixed["planes"][0]["panel_count"] == 0)
    check("area -5 -> per-plane flag",
          any(f.startswith("plane_0_area") for f in mixed["flags"]), str(mixed["flags"]))
    check("the OTHER plane still computes", mixed["planes"][1]["panel_count"] > 0,
          str(mixed["planes"][1]))
    check("no negative panel_count anywhere",
          all((p["panel_count"] or 0) >= 0 for p in mixed["planes"]))

    thirteen = [{"azimuth": 0, "pitch": 20, "area_m2": 10.0}] * 13
    try:
        roof.ManualRoofRequest(job_id="j", basis="plans",
                               planes=[roof.ManualPlane(**p) for p in thirteen])
        check("13 planes -> 422 at the route model", False, "ValidationError not raised")
    except ValidationError:
        check("13 planes -> 422 at the route model", True)
    try:
        roof.ManualPlane(azimuth=400, pitch=20, area_m2=10)
        check("azimuth 400 -> 422, not clamped", False, "ValidationError not raised")
    except ValidationError:
        check("azimuth 400 -> 422, not clamped", True)
    try:
        roof.ManualPlane(azimuth=0, pitch=75, area_m2=10)
        check("pitch 75 -> 422, not clamped", False, "ValidationError not raised")
    except ValidationError:
        check("pitch 75 -> 422, not clamped", True)


def _run(coro):
    return asyncio.run(coro)


def t4() -> None:
    print("\nT4. route auth + ownership, offline (stubbed Supabase)")

    # (a) Both endpoints carry Depends(require_company) — inspected, not grepped.
    for fn, label in ((roof.roof_geometry_endpoint, "geometry"),
                      (roof.roof_manual_endpoint, "manual")):
        param = inspect.signature(fn).parameters.get("caller")
        dep_ok = (
            param is not None
            and isinstance(param.default, DependsParam)
            and param.default.dependency is auth.require_company
        )
        check(f"(a) {label} endpoint depends on require_company", dep_ok,
              f"default={getattr(param, 'default', None)!r}")

    original_client = roof._client
    original_rg_client = roof_geometry._client
    original_fetch = roof_geometry.fetch_roof_geometry
    try:
        # Keep every collaborator offline: panel catalogue unavailable -> fallback panel.
        roof_geometry._client = lambda: None

        # (b) foreign job -> 404
        foreign = StubClient(jobs_rows=[{"job_id": "j1", "company_id": "co-OTHER",
                                         "site_postcode": "5000", "site_state": "SA"}])
        roof._client = lambda: foreign
        body = roof.ManualRoofRequest(
            job_id="j1", basis="plans",
            planes=[roof.ManualPlane(azimuth=0, pitch=20, area_m2=50.0)], persist=False)
        raised_foreign = None
        try:
            _run(roof.roof_manual_endpoint(body, CALLER))
        except HTTPException as exc:
            raised_foreign = exc
        check("(b) foreign job -> 404", raised_foreign is not None
              and raised_foreign.status_code == 404,
              f"got {getattr(raised_foreign, 'status_code', None)}")

        # (c) absent job -> 404, detail identical to (b)
        absent = StubClient(jobs_rows=[])
        roof._client = lambda: absent
        raised_absent = None
        try:
            _run(roof.roof_manual_endpoint(body, CALLER))
        except HTTPException as exc:
            raised_absent = exc
        check("(c) absent job -> 404", raised_absent is not None
              and raised_absent.status_code == 404,
              f"got {getattr(raised_absent, 'status_code', None)}")
        check("(c) details identical — existence never leaks",
              raised_foreign is not None and raised_absent is not None
              and raised_foreign.detail == raised_absent.detail,
              f"{getattr(raised_foreign, 'detail', None)!r} vs "
              f"{getattr(raised_absent, 'detail', None)!r}")

        # (d) persist=False -> the stub's insert is never called.
        mine = StubClient(jobs_rows=[{"job_id": "j2", "company_id": "co-1",
                                      "site_postcode": "5061", "site_state": "SA"}])
        roof._client = lambda: mine
        body_ok = roof.ManualRoofRequest(
            job_id="j2", basis="plans",
            planes=[roof.ManualPlane(azimuth=0, pitch=20, area_m2=50.0)], persist=False)
        model = _run(roof.roof_manual_endpoint(body_ok, CALLER))
        check("(d) persist=False -> insert never called", mine.inserts == [],
              f"inserts={mine.inserts!r}")
        check("(d) persisted is False", model.get("persisted") is False)
        check("(d) flag not_persisted_by_request",
              "not_persisted_by_request" in model.get("flags", []), str(model.get("flags")))
        check("(d) manual model found=True source manual_plans",
              model.get("found") is True and model.get("source") == "manual_plans")

        # (e) cross-check key ABSENT when job_id is None (geometry path, fetch stubbed
        #     offline) and when the job's site_state is None.
        def fake_fetch(address, panel_id=None, usability_factor=None):
            out = roof_geometry._blank()
            out["address"] = address
            out["found"] = True
            out["geocoded_state"] = "SA"
            out["geocoded_postcode"] = "5061"
            return out

        roof_geometry.fetch_roof_geometry = fake_fetch
        geo_body = roof.RoofGeometryRequest(address="x", persist=False)
        no_job = _run(roof.roof_geometry_endpoint(geo_body, CALLER))
        check("(e) no job_id -> site_cross_check ABSENT", "site_cross_check" not in no_job,
              str(no_job.get("site_cross_check")))

        stateless = StubClient(jobs_rows=[{"job_id": "j3", "company_id": "co-1",
                                           "site_postcode": None, "site_state": None}])
        roof._client = lambda: stateless
        geo_body2 = roof.RoofGeometryRequest(address="x", job_id="j3", persist=False)
        no_state = _run(roof.roof_geometry_endpoint(geo_body2, CALLER))
        check("(e) job site_state None -> site_cross_check ABSENT",
              "site_cross_check" not in no_state, str(no_state.get("site_cross_check")))

        # And the positive control: both states known -> key present; mismatch flagged.
        vic = StubClient(jobs_rows=[{"job_id": "j4", "company_id": "co-1",
                                     "site_postcode": "3000", "site_state": "VIC"}])
        roof._client = lambda: vic
        geo_body3 = roof.RoofGeometryRequest(address="x", job_id="j4", persist=False)
        mismatch = _run(roof.roof_geometry_endpoint(geo_body3, CALLER))
        cc = mismatch.get("site_cross_check")
        check("(e+) both states known -> key present with mismatch true",
              isinstance(cc, dict) and cc.get("mismatch") is True, str(cc))
        check("(e+) geocode_state_mismatch flagged",
              "geocode_state_mismatch" in mismatch.get("flags", []),
              str(mismatch.get("flags")))
    finally:
        roof._client = original_client
        roof_geometry._client = original_rg_client
        roof_geometry.fetch_roof_geometry = original_fetch


def t5_live() -> None:
    print("\nT5. LIVE Google checks (fetch_roof_geometry directly — no DB write)")
    if not os.getenv("GOOGLE_MAPS_API_KEY"):
        check("GOOGLE_MAPS_API_KEY present for --live", False, "key not in environment")
        return

    a = roof_geometry.fetch_roof_geometry("109 Cheltenham St, Malvern SA 5061")
    check("(a) found True", a.get("found") is True, str(a.get("reason") or a.get("error")))
    check("(a) imagery_quality MEDIUM", a.get("imagery_quality") == "MEDIUM",
          str(a.get("imagery_quality")))
    check("(a) low_confidence False", a.get("low_confidence") is False)
    check("(a) a plane with non-null azimuth",
          any(p.get("azimuth") is not None for p in a.get("planes", [])),
          f"{len(a.get('planes', []))} planes")
    check("(a) imagery_stale True (2018-11-17)", a.get("imagery_stale") is True,
          str(a.get("imagery_date")))
    check("(a) geocoded_state SA", a.get("geocoded_state") == "SA", str(a.get("geocoded_state")))
    check("(a) geocoded_postcode 5061", a.get("geocoded_postcode") == "5061",
          str(a.get("geocoded_postcode")))

    b = roof_geometry.fetch_roof_geometry("1 Wimmera St, Mount Gambier SA 5290")
    check("(b) found False", b.get("found") is False, str(b.get("imagery_quality")))
    check("(b) manual_entry_required True", b.get("manual_entry_required") is True)
    check("(b) flag not_found_regional", "not_found_regional" in b.get("flags", []),
          str(b.get("flags")))
    check("(b) lat/lng still populated", b.get("lat") is not None and b.get("lng") is not None,
          f"lat={b.get('lat')} lng={b.get('lng')}")
    check("(b) geocoded_postcode 5290 on the 404 path",
          b.get("geocoded_postcode") == "5290", str(b.get("geocoded_postcode")))

    c = roof_geometry.fetch_roof_geometry("47 Corymbia Ave, Riverlea Park SA 5120")
    check("(c) found True", c.get("found") is True, str(c.get("reason") or c.get("error")))
    check("(c) low_confidence True", c.get("low_confidence") is True,
          f"segments={c.get('roof_segment_count')}")
    check("(c) needs_manual_confirmation True", c.get("needs_manual_confirmation") is True)
    check("(c) flag low_confidence_result", "low_confidence_result" in c.get("flags", []),
          str(c.get("flags")))


def main() -> int:
    live = "--live" in sys.argv
    print("verify_roof_contract.py — 3.4-A roof contract"
          + (" (with --live Google checks)" if live else " (offline)") + "\n")
    t1()
    t2()
    t3()
    t4()
    if live:
        t5_live()

    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print(f"OK: all {CHECKS_RUN} checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 — a crashing verifier must not read as success
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
