#!/usr/bin/env python3
"""
verify_equipment_contract.py — the 3.10 prompt-1 gate: the equipment write
path, GET /api/equipment's auth + scoping, THE RELATIONSHIP CHECK (the
endpoint's column constants vs the engine's OBSERVED reads — both sides RUN,
neither is parsed, per F148), and the auto-pick scoping asserted on the QUERY
THAT SHIPS.

Offline, stub clients, WRITES NOTHING.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_equipment_contract.py
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import battery_optimiser  # noqa: E402
import capture  # noqa: E402
import cost_model  # noqa: E402
import roof_geometry  # noqa: E402
from routes import equipment  # noqa: E402
from routes import job as job_route  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402
from routes.equipment import (  # noqa: E402
    BATTERY_COLUMNS,
    INVERTER_COLUMNS,
    PANEL_COLUMNS,
)

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


CALLER_A = auth.Caller(user_id="u1", email="a@example.com", company_id="co-A", role="owner")


# ── Recording / serving stub client ──────────────────────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self._c, self._t = client, table
        self._filters: list[tuple[str, str]] = []
        self._ors: list[str] = []
        self._cols = "*"

    def select(self, cols="*", *_a, **_k):
        self._cols = cols
        self._c.selects.append((self._t, cols))
        return self

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def or_(self, expr):
        self._ors.append(expr)
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        self._c.queries.append({"table": self._t, "filters": list(self._filters),
                                "ors": list(self._ors), "cols": self._cols})
        if self._c.raise_on and self._t in self._c.raise_on:
            raise RuntimeError(f"stub: {self._t} down")
        rows = self._c.tables.get(self._t, [])
        if rows is None or isinstance(rows, (str, int)):
            return _Result(rows)  # junk passthrough for check 6
        out = []
        for r in rows:
            if not isinstance(r, dict):
                out.append(r)
                continue
            if all(r.get(k) == v for k, v in self._filters):
                if self._ors:
                    # origin.eq.catalogue,owner_company_id.eq.<id>
                    ok = False
                    for clause in self._ors[0].split(","):
                        col, _op, val = clause.split(".", 2)
                        if str(r.get(col)) == val:
                            ok = True
                    if not ok:
                        continue
                out.append(dict(r))
        return _Result(out)


class StubClient:
    def __init__(self, tables=None, raise_on=None):
        self.tables = dict(tables or {})
        self.raise_on = set(raise_on or [])
        self.queries: list[dict] = []
        self.selects: list[tuple[str, str]] = []

    def table(self, name):
        return _Query(self, name)


class _Recorder(dict):
    """Check 3's instrument: a dict that RECORDS which keys the engine reads."""

    def __init__(self, base):
        super().__init__(base)
        self.read: set = set()

    def get(self, key, default=None):
        self.read.add(key)
        return super().get(key, default)


def run_endpoint(client, caller=CALLER_A):
    original = equipment._svc
    equipment._svc = lambda: client
    try:
        return asyncio.run(equipment.list_equipment(caller))
    finally:
        equipment._svc = original


def t1_write_path() -> None:
    print("CHECK 1 — the write path")
    fields = job_route.JobSitePatch.model_fields
    trio = ("equipment_panel_id", "equipment_inverter_id", "equipment_battery_id")
    for name in trio:
        f = fields.get(name)
        check(f"(1a) JobSitePatch.{name} exists, Optional[str], default None",
              f is not None and f.default is None and str in getattr(f.annotation, "__args__", ()),
              str(f))
    check("(1b) all three in _JOBS_PATCH_FIELDS",
          set(trio) <= job_route._JOBS_PATCH_FIELDS,
          str(set(trio) - job_route._JOBS_PATCH_FIELDS))
    check("(1b) none in _CUSTOMER_PATCH_FIELDS",
          not (set(trio) & set(job_route._CUSTOMER_PATCH_FIELDS)),
          str(set(trio) & set(job_route._CUSTOMER_PATCH_FIELDS)))
    check("(1c) all three in capture._ALLOWED['jobs']",
          set(trio) <= capture._ALLOWED["jobs"],
          str(set(trio) - capture._ALLOWED["jobs"]))
    # (1d) THE DELTA: the fourteen pre-3.10 names are the set the 3.9 gate
    # (verify_objective_contract 3b) enumerates and asserts — re-enumerated
    # here, not hardcoded as a bare 17.
    pre_310 = {
        "storeys", "roof_material", "dwelling_type", "year_built", "bedrooms",
        "floor_area_m2", "electrical_phase",
        "has_existing_solar", "existing_solar_kw", "existing_inverter_kw",
        "intent", "objective", "custom_weight", "budget_aud",
    }
    check("(1d) _JOBS_PATCH_FIELDS == the fourteen pre-3.10 names + exactly the trio (17)",
          job_route._JOBS_PATCH_FIELDS == pre_310 | set(trio)
          and len(job_route._JOBS_PATCH_FIELDS) == len(pre_310) + 3,
          str(sorted(job_route._JOBS_PATCH_FIELDS)))


def t2_endpoint() -> None:
    print("\nCHECK 2 — the endpoint")
    import main  # noqa: PLC0415 — imported here so a broken main fails a check, not the gate

    route = next((r for r in main.app.routes if getattr(r, "path", "") == "/api/equipment"), None)
    check("(2a) GET /api/equipment is registered", route is not None
          and "GET" in getattr(route, "methods", set()), str(route))

    # (2b) THE RESOLVED DEPENDENCY, not a grep — a grep passes on a
    # commented-out line; the dependant tree only holds what FastAPI will run.
    dep_calls = []

    def walk(dependant):
        for d in dependant.dependencies:
            dep_calls.append(d.call)
            walk(d)

    if route is not None:
        walk(route.dependant)
    check("(2b) require_company is in the route's resolved dependency tree",
          auth.require_company in dep_calls,
          f"resolved deps: {[getattr(c, '__name__', c) for c in dep_calls]}")

    # (2c) THE SCOPING RULE, both directions.
    rows = [
        {"id": "cat-1", "brand": "Jinko", "model": "Tiger Neo", "status": "active",
         "origin": "catalogue", "owner_company_id": None, "verified": True},
        {"id": "mine-1", "brand": "Acme", "model": "OwnPanel", "status": "active",
         "origin": "user_defined", "owner_company_id": "co-A", "verified": False},
        {"id": "theirs-1", "brand": "Rival", "model": "Secret", "status": "active",
         "origin": "user_defined", "owner_company_id": "co-B", "verified": False},
    ]
    res = run_endpoint(StubClient({"panels": rows, "inverters": [], "batteries": []}))
    got = {p["id"] for p in res["panels"]}
    check("(2c) company A sees the catalogue row and its own — nothing missing",
          got >= {"cat-1", "mine-1"}, str(got))
    check("(2c) ...and NOT company B's row — nothing extra",
          got == {"cat-1", "mine-1"}, str(got))

    # (2d) dead client — three empty lists, ONE flag, no exception.
    res = run_endpoint(None)
    check("(2d) no client: [] lists + the single unavailable flag, no raise",
          res["panels"] == [] and res["inverters"] == [] and res["batteries"] == []
          and res["flags"] == ["equipment_catalogue_unavailable"], str(res))
    res = run_endpoint(StubClient(raise_on={"panels", "inverters", "batteries"}))
    check("(2d) failing queries: same shape, flag appended ONCE",
          res["panels"] == [] and res["flags"] == ["equipment_catalogue_unavailable"],
          str(res["flags"]))

    # (2e) sort stability over a shuffled stub.
    shuffled = [rows[2], rows[0], rows[1]]
    r1 = run_endpoint(StubClient({"panels": list(shuffled)}, ))
    r2 = run_endpoint(StubClient({"panels": list(reversed(shuffled))}))
    ids1 = [p["id"] for p in r1["panels"]]
    ids2 = [p["id"] for p in r2["panels"]]
    check("(2e) identical id order across differently-ordered stubs",
          ids1 == ids2 and len(ids1) == 2, f"{ids1} vs {ids2}")


def t3_relationship() -> None:
    print("\nCHECK 3 — THE RELATIONSHIP: engine reads ⊆ endpoint columns (both sides RUN)")

    # (3a) battery_specs, twice: full row + a row missing every defaultable
    # spec, so the default branches' reads are observed too. A single pass
    # misses every read that only happens in a default branch.
    full = _Recorder({
        "id": "b1", "brand": "X", "model": "Y", "usable_capacity_kwh": 12.8,
        "cost_aud": 8000, "depth_of_discharge_pct": 100,
        "round_trip_efficiency_pct": 96, "max_continuous_charge_kw": 6.6,
        "max_continuous_discharge_kw": 6.6, "warranty_cycles": 6000,
        "warranty_years": 10,
    })
    sparse = _Recorder({"id": "b2", "brand": "X", "model": "Z",
                        "usable_capacity_kwh": 10.0, "cost_aud": 7000})
    battery_optimiser.battery_specs(full, [])
    battery_optimiser.battery_specs(sparse, [])
    reads = full.read | sparse.read
    missing = reads - set(BATTERY_COLUMNS)
    print(f"        battery_specs reads : {sorted(reads)}")
    print(f"        BATTERY_COLUMNS     : {sorted(BATTERY_COLUMNS)}")
    check("(3a) battery_specs' observed reads ⊆ BATTERY_COLUMNS",
          missing == set(), f"engine reads the endpoint omits: {sorted(missing)}")

    # (3b) _panel_from_row.
    prow = _Recorder({"id": "p1", "brand": "Jinko", "model": "Tiger Neo",
                      "rated_power_w": 440, "length_mm": 1762, "width_mm": 1134})
    roof_geometry._panel_from_row(prow)
    sparse_p = _Recorder({"id": "p2"})
    roof_geometry._panel_from_row(sparse_p)
    reads = prow.read | sparse_p.read
    missing = reads - set(PANEL_COLUMNS)
    print(f"        _panel_from_row reads: {sorted(reads)}")
    check("(3b) _panel_from_row's observed reads ⊆ PANEL_COLUMNS",
          missing == set(), f"engine reads the endpoint omits: {sorted(missing)}")

    # (3c) cost_model: capture the column STRINGS at runtime. The stub serves
    # cost_assumptions and the three catalogue rows so the function completes.
    stub = StubClient({
        "cost_assumptions": [{
            "solar_install_per_kw": 1000, "battery_install_base": 800,
            "stc_price_net": 38, "deeming_years": 6, "battery_stc_per_kwh": 372,
            "source": "stub", "last_verified": None, "status": "active",
        }],
        "panels": [{"id": "p1", "brand": "Jinko", "model": "Tiger Neo",
                    "rated_power_w": 440, "cost_aud": 130}],
        "inverters": [{"id": "i1", "brand": "Fronius", "model": "Primo",
                       "cost_aud": 1500}],
        "batteries": [{"id": "b1", "brand": "X", "model": "Y",
                       "usable_capacity_kwh": 12.8, "cost_aud": 8000}],
        "installer_profiles": [],
    })
    saved_cache, saved_ready = cost_model._client_cache, cost_model._client_ready
    try:
        cost_model._client_cache, cost_model._client_ready = stub, True
        result = cost_model.compute_system_cost(
            solar_kw=6.6, panel_id="p1", panel_count=15, inverter_id="i1",
            battery_id="b1", battery_usable_kwh=12.8,
        )
        check("(3c) compute_system_cost completed against the stub",
              isinstance(result, dict) and "flags" in result, str(result)[:120])
    finally:
        cost_model._client_cache, cost_model._client_ready = saved_cache, saved_ready
    by_table = {"panels": PANEL_COLUMNS, "inverters": INVERTER_COLUMNS,
                "batteries": BATTERY_COLUMNS}
    exercised = set()
    for table, cols in stub.selects:
        if table not in by_table or cols == "*":
            continue
        exercised.add(table)
        requested = {c.strip() for c in cols.split(",")}
        missing = requested - set(by_table[table])
        check(f"(3c) cost_model's {table} select ⊆ {table.upper()[:-1]}_COLUMNS"
              if table != "batteries" else "(3c) cost_model's batteries select ⊆ BATTERY_COLUMNS",
              missing == set(), f"cost_model reads the endpoint omits: {sorted(missing)}")
    check("(3c) all three catalogue fetches actually executed",
          exercised == {"panels", "inverters", "batteries"}, str(exercised))


def t4_autopick_scoping() -> None:
    print("\nCHECK 4 — auto-pick scoping, asserted on the QUERY THAT SHIPS")

    # (4a) drive the battery endpoint far enough to hit the unconstrained
    # pool. Everything before it is satisfied from the body, so the pool is
    # the FIRST stub query; whatever the endpoint does afterwards (it will
    # fail in the solar run against this skeleton fixture) cannot un-record it.
    stub = StubClient({"batteries": []})
    original = sizing_route._sb
    sizing_route._sb = lambda: stub
    try:
        body = sizing_route.BatteryRequest(
            planes=[{"azimuth": 0, "pitch": 20, "area_m2": 30}],
            candidate_configs=[{}],
            lat=-34.93, lon=138.6, state="SA", postcode="5000",
            panel_id="p-stub", panel_watts=440.0,
            load_hourly_8760=[0.5] * 8760,
            import_rate=0.40, fit=0.05, export_limit_kw=5.0,
        )
        asyncio.run(sizing_route.battery_sizing(body))
    finally:
        sizing_route._sb = original
    pool = [q for q in stub.queries if q["table"] == "batteries"]
    check("(4a) the unconstrained pool query executed", len(pool) >= 1, str(stub.queries))
    filters = pool[0]["filters"] if pool else []
    check("(4a) ...and carries ('origin', 'catalogue')",
          ("origin", "catalogue") in filters, str(filters))
    check("(4a) ...alongside ('status', 'active')",
          ("status", "active") in filters, str(filters))

    # (4b) both default-branch queries in _get_panel. The stub returns no
    # rows, so the Jinko preference AND the highest-rated fallback both run.
    stub = StubClient({"panels": []})
    saved = roof_geometry._client
    roof_geometry._client = lambda: stub
    try:
        roof_geometry._get_panel(None)
    finally:
        roof_geometry._client = saved
    queries = [q for q in stub.queries if q["table"] == "panels"]
    check("(4b) both default queries executed", len(queries) == 2, str(queries))
    for i, q in enumerate(queries):
        check(f"(4b) default query {i + 1} carries ('origin', 'catalogue')",
              ("origin", "catalogue") in q["filters"], str(q["filters"]))

    # (4d) the explicit-id lookup is UNCHANGED: serving the id row makes
    # _get_panel return before the default branch, so exactly one query runs,
    # filtered by id and NOT by origin — the pinned path did not quietly break.
    stub = StubClient({"panels": [{"id": "some-id", "brand": "B", "model": "M",
                                   "rated_power_w": 440, "length_mm": 1762,
                                   "width_mm": 1134}]})
    saved = roof_geometry._client
    roof_geometry._client = lambda: stub
    try:
        panel, flags = roof_geometry._get_panel("some-id")
    finally:
        roof_geometry._client = saved
    check("(4d) explicit id resolves through the id filter",
          len(stub.queries) == 1 and ("id", "some-id") in stub.queries[0]["filters"],
          str(stub.queries))
    check("(4d) ...with NO origin filter on the pinned path",
          ("origin", "catalogue") not in stub.queries[0]["filters"],
          str(stub.queries[0]["filters"]))
    check("(4d) ...and the panel resolved", panel.get("id") == "some-id", str(panel))


def t5_caller_counts() -> None:
    print("\nCHECK 5 — caller counts (a later unscoped reader fails a gate, not a conversation)")
    hits_p, hits_b = [], []
    for root, dirs, files in os.walk(BACKEND_DIR):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "scripts", "_legacy")]
        for fn in files:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, BACKEND_DIR)
            for i, line in enumerate(open(path), 1):
                if 'table("panels")' in line:
                    hits_p.append(f"{rel}:{i}")
                if 'table("batteries")' in line:
                    hits_b.append(f"{rel}:{i}")
    print(f"        panels   : {hits_p}")
    print(f"        batteries: {hits_b}")
    check("(5a) table(\"panels\") at exactly 4 sites", len(hits_p) == 4, str(hits_p))
    check("(5a) table(\"batteries\") at exactly 1 site", len(hits_b) == 1, str(hits_b))

    src = open(os.path.join(BACKEND_DIR, "roof_geometry.py")).read()
    src_all = src + open(os.path.join(BACKEND_DIR, "routes", "roof.py")).read() \
        + open(os.path.join(BACKEND_DIR, "routes", "sizing.py")).read()
    gp_defs = len(re.findall(r"def _get_panel\(", src_all))
    gp_calls = len(re.findall(r"(?<!def )_get_panel\(", src_all))
    rs_defs = len(re.findall(r"def rescale_planes_for_panel\(", src_all))
    rs_calls = len(re.findall(r"(?<!def )rescale_planes_for_panel\(", src_all))
    print(f"        _get_panel defs={gp_defs} calls={gp_calls}; "
          f"rescale defs={rs_defs} calls={rs_calls}")
    check("(5b) _get_panel: 1 definition + 2 call sites",
          gp_defs == 1 and gp_calls == 2, f"defs={gp_defs} calls={gp_calls}")
    check("(5b) rescale_planes_for_panel: 1 definition + 3 call sites",
          rs_defs == 1 and rs_calls == 3, f"defs={rs_defs} calls={rs_calls}")


def t6_junk() -> None:
    print("\nCHECK 6 — total under junk")
    for label, tables in [
        ("data None", {"panels": None, "inverters": None, "batteries": None}),
        ("data a string", {"panels": "junk", "inverters": "junk", "batteries": "junk"}),
        ("non-dict rows", {"panels": [1, "x", None], "inverters": [[]], "batteries": [42]}),
        ("all-None rows", {"panels": [{c: None for c in PANEL_COLUMNS} | {"status": "active", "origin": "catalogue"}],
                           "inverters": [], "batteries": []}),
    ]:
        try:
            res = run_endpoint(StubClient(tables))
            shape_ok = (set(res) == {"panels", "inverters", "batteries", "flags"}
                        and all(isinstance(res[k], list) for k in res))
            check(f"(6) {label}: no raise, documented shape", shape_ok, str(res)[:140])
        except Exception as exc:  # noqa: BLE001
            check(f"(6) {label}: no raise, documented shape", False, f"raised {exc!r}")


def main_() -> int:
    print("verify_equipment_contract.py — 3.10 prompt 1 (offline, writes nothing)\n")
    t1_write_path()
    t2_endpoint()
    t3_relationship()
    t4_autopick_scoping()
    t5_caller_counts()
    t6_junk()
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
        sys.exit(main_())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
