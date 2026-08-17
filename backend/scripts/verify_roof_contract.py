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



# ── 3.4-C: roof plausibility ─────────────────────────────────────────────────
# The 14 Frome St fixture is TRANSCRIBED FROM THE STORED ROW written during 3.4-B
# acceptance on 2026-08-14 (roof_geometry: pitches 76.4/77.0, areas 2.3/68.32,
# solarPanels absent, maxArrayPanelsCount null) — not invented. Pre-3.4-C this
# returned low_confidence FALSE: 2 segments defeated the first clause, and g_max
# being None short-circuited the second, so "Google told us nothing" read as
# "Google told us it is fine".
FROME_ST = {
    "solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 76.4, "azimuthDegrees": 14.7,
             "stats": {"areaMeters2": 2.3, "sunshineQuantiles": [686.2] * 11}},
            {"pitchDegrees": 77.0, "azimuthDegrees": 173.1,
             "stats": {"areaMeters2": 68.32, "sunshineQuantiles": [504.5] * 11}},
        ],
        # solarPanels ABSENT, maxArrayPanelsCount null — exactly what Google returned.
    },
    "imageryQuality": "MEDIUM",
    "imageryDate": {"year": 2018, "month": 11, "day": 17},
}

# A normal roof: 3 faces at ordinary pitches WITH a real Google layout. The
# false-positive guard — this must never be flagged.
NORMAL_ROOF = {
    "solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 18.0, "azimuthDegrees": 0.0,
             "stats": {"areaMeters2": 40.0, "sunshineQuantiles": [1300.0] * 11}},
            {"pitchDegrees": 22.0, "azimuthDegrees": 90.0,
             "stats": {"areaMeters2": 35.0, "sunshineQuantiles": [1250.0] * 11}},
            {"pitchDegrees": 22.0, "azimuthDegrees": 270.0,
             "stats": {"areaMeters2": 30.0, "sunshineQuantiles": [1200.0] * 11}},
        ],
        "solarPanels": (
            [{"segmentIndex": 0}] * 15 + [{"segmentIndex": 1}] * 13
            + [{"segmentIndex": 2}] * 12
        ),
        "maxArrayPanelsCount": 40,
    },
    "imageryQuality": "HIGH",
    "imageryDate": {"year": 2025, "month": 1, "day": 10},
}


def _causes_for(data: dict, usability: float = 0.7) -> tuple[dict, dict]:
    """
    Run the REAL fetch_roof_geometry over a fixture, offline.

    The network seams (_api_key, _geocode, _building_insights) and the Supabase
    client are stubbed; the confidence rules themselves are NOT — this calls the
    shipping code path. An earlier version of this helper RE-IMPLEMENTED those
    rules, which meant deleting a clause from roof_geometry.py left the suite
    green: a test that could not detect the thing it exists to detect, the exact
    F39 fault this row was written to fix. Caught by running the red proof.

    Returns (model, norm) — the model from the real entry point, and _normalise's
    own dict for the two internals the model does not carry.
    """
    saved = (
        roof_geometry._api_key,
        roof_geometry._geocode,
        roof_geometry._building_insights,
        roof_geometry._client,
    )
    try:
        roof_geometry._api_key = lambda: "stub-key"
        roof_geometry._geocode = lambda _a, _k: (
            -34.92, 138.60, roof_geometry._blank_geocoded(), None,
        )
        roof_geometry._building_insights = lambda _lat, _lng, _k, expanded=False: (
            200, data, None,
        )
        roof_geometry._client = lambda: None  # fallback panel, no DB
        model = roof_geometry.fetch_roof_geometry("stub address", usability_factor=usability)
    finally:
        (
            roof_geometry._api_key,
            roof_geometry._geocode,
            roof_geometry._building_insights,
            roof_geometry._client,
        ) = saved
    norm = roof_geometry._normalise(data, dict(PANEL), usability)
    return model, norm


def t_confidence() -> None:
    print("\nT-3.4C. roof plausibility — the 14 Frome St regression")
    model, norm = _causes_for(FROME_ST)
    causes = model["low_confidence_causes"]

    check("low_confidence is now TRUE (was False — the bug)",
          model["low_confidence"] is True, str(model["low_confidence"]))
    check("needs_manual_confirmation is TRUE",
          model["needs_manual_confirmation"] is True)
    check("causes include no_google_panel_layout", "no_google_panel_layout" in causes,
          f"causes={causes}")
    check("causes include implausible_pitch", "implausible_pitch" in causes,
          f"causes={causes}")
    check("summary flag low_confidence_result KEPT", "low_confidence_result" in model["flags"],
          str(model["flags"]))
    check("per-cause flags present",
          "low_confidence_implausible_pitch" in model["flags"]
          and "low_confidence_no_google_panel_layout" in model["flags"],
          str(model["flags"]))
    check("plane_1_implausible_pitch flagged (77 degrees, 23 panels)",
          "plane_1_implausible_pitch" in norm["flags"], f"flags={norm['flags']}")
    check("plane_0_implausible_pitch ABSENT (76.4 degrees but 0 panels)",
          "plane_0_implausible_pitch" not in norm["flags"], f"flags={norm['flags']}")
    check("max_flagged_pitch is 77.0", norm["max_flagged_pitch"] == 77.0,
          str(norm["max_flagged_pitch"]))

    # THE MOST IMPORTANT ASSERTION IN THIS TASK: flagging changes NO number and
    # drops NO plane. If any of these move, the fix has silently altered a
    # recommendation, which is the failure mode this row exists to prevent.
    check("plane 1 panel_count STILL 23", model["planes"][1]["panel_count"] == 23,
          str(model["planes"][1]["panel_count"]))
    check("plane 1 kwp STILL 10.12", model["planes"][1]["kwp"] == 10.12,
          str(model["planes"][1]["kwp"]))
    check("total_kwp STILL 10.12", model["total_kwp"] == 10.12, str(model["total_kwp"]))
    check("max_panels STILL 23", model["max_panels"] == 23, str(model["max_panels"]))
    check("BOTH planes still present — none dropped", len(model["planes"]) == 2,
          f"{len(model['planes'])} planes")
    check("plane 0 still rendered with its area", model["planes"][0]["area_m2"] == 2.3,
          str(model["planes"][0]))
    check("found is still True — the roof is not rejected", model["found"] is True)

    # False-positive guard on an ordinary roof.
    print("\n   false-positive guard — an ordinary 3-face roof")
    normal_model, normal_norm = _causes_for(NORMAL_ROOF)
    check("ordinary roof yields NO causes",
          normal_model["low_confidence_causes"] == [],
          str(normal_model["low_confidence_causes"]))
    check("ordinary roof low_confidence FALSE", normal_model["low_confidence"] is False)
    check("ordinary roof carries no low_confidence_result flag",
          "low_confidence_result" not in normal_model["flags"], str(normal_model["flags"]))
    check("ordinary roof has no pitch flag", normal_norm["max_flagged_pitch"] is None,
          str(normal_norm["max_flagged_pitch"]))
    check("ordinary roof HAS a google layout", normal_norm["have_google_layout"] is True)

    # Threshold behaviour at the edges.
    print("\n   pitch threshold edges")
    steep_empty = {"solarPotential": {"roofSegmentStats": [
        {"pitchDegrees": 50.0, "stats": {"areaMeters2": 1.0}}], "maxArrayPanelsCount": 40,
        "solarPanels": [{"segmentIndex": 0}] * 40}}
    n = roof_geometry._normalise(steep_empty, dict(PANEL), 0.7)
    check("50 degrees carrying 0 panels -> NOT flagged",
          n["max_flagged_pitch"] is None and n["planes"][0]["panel_count"] == 0,
          f"pitch flag={n['max_flagged_pitch']} count={n['planes'][0]['panel_count']}")

    steep_full = {"solarPotential": {"roofSegmentStats": [
        {"pitchDegrees": 46.0, "stats": {"areaMeters2": 20.0}}], "maxArrayPanelsCount": 40,
        "solarPanels": [{"segmentIndex": 0}] * 40}}
    n = roof_geometry._normalise(steep_full, dict(PANEL), 0.7)
    check("46 degrees carrying panels -> flagged",
          n["max_flagged_pitch"] == 46.0 and n["planes"][0]["panel_count"] > 0,
          f"pitch flag={n['max_flagged_pitch']} count={n['planes'][0]['panel_count']}")

    for label, pitch in (("None", None), ("negative", -10.0), ("above 90", 120.0)):
        seg = {"stats": {"areaMeters2": 20.0}}
        if pitch is not None:
            seg["pitchDegrees"] = pitch
        data = {"solarPotential": {"roofSegmentStats": [seg],
                "maxArrayPanelsCount": 40, "solarPanels": [{"segmentIndex": 0}] * 40}}
        try:
            n = roof_geometry._normalise(data, dict(PANEL), 0.7)
            ok = n["max_flagged_pitch"] is None and len(n["planes"]) == 1
        except Exception as exc:  # noqa: BLE001
            ok = False
            n = {"err": str(exc)}
        check(f"pitch {label} -> not flagged, plane still rendered, no throw", ok, str(n))

    # The `g_max is None` clause is LOAD-BEARING and needs its own fixture: on
    # 14 Frome St solarPanels is absent, so `not have_layout` already fires and the
    # clause is redundant there. This case — Google DID return a layout but reported
    # no maxArrayPanelsCount — is the only one that isolates it, and without this
    # check the clause could be deleted with the suite still green (found while
    # running the red proof for this very clause).
    layout_no_max = {"solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 20.0, "stats": {"areaMeters2": 40.0}},
            {"pitchDegrees": 22.0, "stats": {"areaMeters2": 35.0}},
            {"pitchDegrees": 20.0, "stats": {"areaMeters2": 30.0}},
        ],
        "solarPanels": [{"segmentIndex": 0}] * 12 + [{"segmentIndex": 1}] * 10,
        # maxArrayPanelsCount deliberately ABSENT while a layout exists.
    }}
    lnm_model, lnm_norm = _causes_for(layout_no_max)
    lnm_causes = lnm_model["low_confidence_causes"]
    check("layout present but maxArrayPanelsCount null -> have_google_layout True",
          lnm_norm["have_google_layout"] is True)
    check("layout present but maxArrayPanelsCount null -> STILL flagged "
          "no_google_panel_layout", "no_google_panel_layout" in lnm_causes,
          f"causes={lnm_causes}")

    # The reason sentence names the causes and never leaks a raw cause id.
    reason = roof_geometry._confidence_reason(causes, norm["max_flagged_pitch"])
    check("reason names the steep pitch in degrees", "77" in reason, reason)
    check("reason mentions confirming against plans", "plans" in reason.lower(), reason)
    check("_blank carries low_confidence_causes on every path",
          roof_geometry._blank().get("low_confidence_causes") == [])



def t_panel_dimensions() -> None:
    """3.5 prompt 1: Google's panel dimensions are captured, degrade safely, and
    never touch a computed number."""
    print("\nT-3.5. google panel dimensions")

    with_dims = {"solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 20.0, "stats": {"areaMeters2": 40.0}}],
        "solarPanels": [{"segmentIndex": 0}] * 10,
        "maxArrayPanelsCount": 40,
        "panelWidthMeters": 1.045,
        "panelHeightMeters": 1.879,
        "panelCapacityWatts": 400,
    }}
    n = roof_geometry._normalise(with_dims, dict(PANEL), 0.7)
    check("found path: width captured", n["google_panel_width_m"] == 1.045,
          str(n["google_panel_width_m"]))
    check("found path: height captured", n["google_panel_height_m"] == 1.879)
    check("found path: capacity captured (int coerced to float)",
          n["google_panel_capacity_w"] == 400.0)
    check("no absence flag when present",
          "google_panel_dimensions_absent" not in n["flags"], str(n["flags"]))

    # THE NUMBERS DO NOT MOVE: identical input without the dimension keys must
    # yield identical counts/kwp/configs — the dimensions influence nothing.
    without_dims = {"solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 20.0, "stats": {"areaMeters2": 40.0}}],
        "solarPanels": [{"segmentIndex": 0}] * 10,
        "maxArrayPanelsCount": 40,
    }}
    m = roof_geometry._normalise(without_dims, dict(PANEL), 0.7)
    check("computed numbers identical with and without dimensions",
          n["planes"] == m["planes"] and n["candidate_configs"] == m["candidate_configs"]
          and n["total_kwp"] == m["total_kwp"] and n["max_panels"] == m["max_panels"],
          f"{n['total_kwp']}/{n['max_panels']} vs {m['total_kwp']}/{m['max_panels']}")
    check("absent dimensions -> all three None + absence flag",
          m["google_panel_width_m"] is None and m["google_panel_height_m"] is None
          and m["google_panel_capacity_w"] is None
          and "google_panel_dimensions_absent" in m["flags"], str(m["flags"]))

    # Junk shapes degrade to None without raising (the F17 contract).
    junk = {"solarPotential": {
        "roofSegmentStats": [{"pitchDegrees": 20.0, "stats": {"areaMeters2": 40.0}}],
        "panelWidthMeters": "wide", "panelHeightMeters": {"m": 2},
        "panelCapacityWatts": [400],
    }}
    try:
        j = roof_geometry._normalise(junk, dict(PANEL), 0.7)
        check("junk dimension shapes -> None, no raise",
              j["google_panel_width_m"] is None and j["google_panel_height_m"] is None
              and j["google_panel_capacity_w"] is None)
    except Exception as exc:  # noqa: BLE001
        check("junk dimension shapes -> None, no raise", False, str(exc))

    # Zero / negative are not usable dimensions: None plus a flag naming it.
    zeroneg = {"solarPotential": {
        "roofSegmentStats": [{"pitchDegrees": 20.0, "stats": {"areaMeters2": 40.0}}],
        "panelWidthMeters": 0, "panelHeightMeters": -1.8, "panelCapacityWatts": 400,
    }}
    z = roof_geometry._normalise(zeroneg, dict(PANEL), 0.7)
    check("zero width -> None + flag", z["google_panel_width_m"] is None
          and "google_panel_width_invalid" in z["flags"], str(z["flags"]))
    check("negative height -> None + flag", z["google_panel_height_m"] is None
          and "google_panel_height_invalid" in z["flags"], str(z["flags"]))
    check("valid capacity beside invalid siblings still captured",
          z["google_panel_capacity_w"] == 400.0)

    # Not-found path and manual model both carry the keys as None.
    blank = roof_geometry._blank()
    check("not-found/_blank path: keys present, all None",
          all(blank[k] is None for k in
              ("google_panel_width_m", "google_panel_height_m", "google_panel_capacity_w")))
    manual = roof_geometry.build_manual_roof_model(
        "plans", [{"azimuth": 0, "pitch": 20, "area_m2": 50.0}], dict(PANEL), 0.7)
    check("manual model: all three None — never inherited, never invented",
          all(manual.get(k) is None for k in
              ("google_panel_width_m", "google_panel_height_m", "google_panel_capacity_w")))


def t_segment_index() -> None:
    """3.5 prompt 2: each plane records GOOGLE'S segment index (the enumerate
    index), so panels_raw[].segmentIndex can be joined to the right roof face
    even when a malformed segment was skipped and list positions diverge."""
    print("\nT-3.5p2. plane segment_index")

    clean = {"solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 20.0, "azimuthDegrees": 0.0, "stats": {"areaMeters2": 40.0}},
            {"pitchDegrees": 22.0, "azimuthDegrees": 90.0, "stats": {"areaMeters2": 30.0}},
        ],
        "solarPanels": [{"segmentIndex": 0}] * 5 + [{"segmentIndex": 1}] * 5,
        "maxArrayPanelsCount": 40,
    }}
    n = roof_geometry._normalise(clean, dict(PANEL), 0.7)
    check("clean row: segment_index equals list position",
          [p.get("segment_index") for p in n["planes"]] == [0, 1],
          str([p.get("segment_index") for p in n["planes"]]))

    # THE TRAP: a malformed segment between two valid ones. The second valid
    # plane sits at LIST position 1 but is GOOGLE segment 2 — positional
    # indexing would hand its panels to the wrong face.
    skipped = {"solarPotential": {
        "roofSegmentStats": [
            {"pitchDegrees": 20.0, "azimuthDegrees": 0.0, "stats": {"areaMeters2": 40.0}},
            "junk-not-a-segment",
            {"pitchDegrees": 22.0, "azimuthDegrees": 90.0, "stats": {"areaMeters2": 30.0}},
        ],
        "solarPanels": [{"segmentIndex": 0}] * 5 + [{"segmentIndex": 2}] * 5,
        "maxArrayPanelsCount": 40,
    }}
    s = roof_geometry._normalise(skipped, dict(PANEL), 0.7)
    check("skipped segment: 2 planes from 3 segments", len(s["planes"]) == 2,
          str(len(s["planes"])))
    check("skipped segment: indices are [0, 2], NOT [0, 1]",
          [p.get("segment_index") for p in s["planes"]] == [0, 2],
          str([p.get("segment_index") for p in s["planes"]]))
    check("plane at list position 1 carries segment 2's azimuth",
          s["planes"][1]["azimuth"] == 90.0 and s["planes"][1]["segment_index"] == 2,
          str(s["planes"][1]))

    # Manual planes have no Google segment — the key must NOT appear (additive
    # only; inventing an index for a manual face would be a fake join target).
    manual = roof_geometry.build_manual_roof_model(
        "plans", [{"azimuth": 0, "pitch": 20, "area_m2": 50.0}], dict(PANEL), 0.7)
    check("manual planes carry NO segment_index key",
          all("segment_index" not in p for p in manual["planes"]),
          str(manual["planes"][0].keys()))

    # Refinement: the tile endpoint's scale param — optional, defaulting to 1,
    # so every pre-existing caller is untouched (the clamp to 1..2 runs in the
    # handler body, after auth, like the zoom clamp).
    scale_param = inspect.signature(roof.roof_tile_endpoint).parameters.get("scale")
    check("tile endpoint has optional scale param defaulting to 1",
          scale_param is not None and scale_param.default == 1,
          f"default={getattr(scale_param, 'default', None)!r}")


def t_prefill_provenance() -> None:
    """3.4-D: pre-filling must never launder a lookup into a trusted source."""
    print("\nT-3.4D. manual pre-fill provenance")

    # The request model accepts the flag, defaults it false, and a body omitting
    # it still validates (an older client must not error).
    omitted = roof.ManualRoofRequest(
        job_id="j", basis="plans",
        planes=[roof.ManualPlane(azimuth=0, pitch=20, area_m2=50)])
    check("body omitting prefilled_from_lookup still validates",
          omitted.prefilled_from_lookup is False, str(omitted.prefilled_from_lookup))
    explicit = roof.ManualRoofRequest(
        job_id="j", basis="plans", prefilled_from_lookup=True,
        planes=[roof.ManualPlane(azimuth=0, pitch=20, area_m2=50)])
    check("body setting it true validates", explicit.prefilled_from_lookup is True)

    # ManualPlane carries a label, bounded at 80 characters.
    check("ManualPlane accepts a label",
          roof.ManualPlane(azimuth=0, pitch=20, area_m2=50, label="main north face").label
          == "main north face")
    try:
        roof.ManualPlane(azimuth=0, pitch=20, area_m2=50, label="x" * 81)
        check("a label over 80 chars is rejected", False, "no ValidationError")
    except ValidationError:
        check("a label over 80 chars is rejected", True)

    # Run the REAL endpoint both ways against a stubbed Supabase — never the
    # re-implemented-logic mistake caught at 3.4-C.
    original_client = roof._client
    original_rg_client = roof_geometry._client
    try:
        roof_geometry._client = lambda: None  # fallback panel, no DB
        mine = StubClient(jobs_rows=[{"job_id": "j2", "company_id": "co-1",
                                      "site_postcode": "5000", "site_state": "SA"}])
        roof._client = lambda: mine

        def run(prefilled: bool) -> dict:
            body = roof.ManualRoofRequest(
                job_id="j2", basis="plans", prefilled_from_lookup=prefilled,
                planes=[roof.ManualPlane(azimuth=173.1, pitch=22, area_m2=68.32,
                                         label="main face")],
                persist=False)
            return _run(roof.roof_manual_endpoint(body, CALLER))

        on = run(True)
        off = run(False)

        check("flag present when prefilled_from_lookup is true",
              "manual_prefilled_from_lookup" in on["flags"], str(on["flags"]))
        check("flag ABSENT when false — never present-and-false",
              "manual_prefilled_from_lookup" not in off["flags"], str(off["flags"]))

        # THE SAFEGUARD: provenance records where the numbers started, it never
        # downgrades what the installer said. Both must be identical either way.
        check("source IDENTICAL either way", on["source"] == off["source"] == "manual_plans",
              f"{on['source']!r} vs {off['source']!r}")
        check("the chosen basis is NOT downgraded",
              "manual_basis_plans" in on["flags"] and "manual_basis_plans" in off["flags"],
              f"{on['flags']} vs {off['flags']}")
        check("the numbers are identical either way",
              on["total_kwp"] == off["total_kwp"] and on["max_panels"] == off["max_panels"],
              f"{on['total_kwp']}/{on['max_panels']} vs {off['total_kwp']}/{off['max_panels']}")
        check("the plane label survives to the model",
              on["planes"][0].get("label") == "main face", str(on["planes"][0]))
        check("persist=false still wrote nothing", mine.inserts == [], str(mine.inserts))
    finally:
        roof._client = original_client
        roof_geometry._client = original_rg_client


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
    t_confidence()
    t_prefill_provenance()
    t_panel_dimensions()
    t_segment_index()
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
