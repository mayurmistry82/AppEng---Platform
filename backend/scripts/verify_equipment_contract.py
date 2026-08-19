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
        self._insert_payload = None
        self._update_payload = None

    def insert(self, payload):
        self._insert_payload = payload
        return self

    def update(self, payload):
        self._update_payload = payload
        return self

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
        if self._update_payload is not None:
            self._c.updates.append((self._t, dict(self._update_payload)))
            rows = self._c.tables.get(self._t, [])
            merged = {**(rows[0] if rows else {}), **self._update_payload}
            return _Result([merged])
        if self._insert_payload is not None:
            if self._c.insert_raises is not None:
                raise self._c.insert_raises
            row = dict(self._insert_payload)
            self._c.insert_seq += 1
            row.setdefault("id", f"new-{self._c.insert_seq}")
            self._c.inserts.append((self._t, dict(row)))
            self._c.tables.setdefault(self._t, []).append(dict(row))
            return _Result([dict(row)])
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
    def __init__(self, tables=None, raise_on=None, insert_raises=None):
        self.tables = dict(tables or {})
        self.raise_on = set(raise_on or [])
        self.insert_raises = insert_raises
        self.queries: list[dict] = []
        self.selects: list[tuple[str, str]] = []
        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict]] = []
        self.insert_seq = 0

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
    # 3.10 added FOUR names in total: the trio (prompt 1) and the confirmation
    # flag (prompt 3). Asserted as a DELTA from the enumerated pre-3.10
    # baseline, so the check states what 3.10 contributed rather than pinning
    # an absolute that goes stale the next time the whitelist legitimately
    # grows — which is exactly what happened to this check between prompts.
    added_by_310 = set(trio) | {"equipment_confirmed"}
    check("(1d) _JOBS_PATCH_FIELDS == the fourteen pre-3.10 names + exactly the four "
          "3.10 names (the trio + equipment_confirmed)",
          job_route._JOBS_PATCH_FIELDS == pre_310 | added_by_310
          and len(job_route._JOBS_PATCH_FIELDS) == len(pre_310) + 4,
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



# ═════════════════════════════════════════════════════════════════════════════
# CHECK 7 (3.10 prompt 2) — the "Other / New" write path.
# ═════════════════════════════════════════════════════════════════════════════

VALID_PANEL = {"brand": "Acme", "model": "P1", "rated_power_w": 440,
               "length_mm": 1762, "width_mm": 1134}
VALID_INVERTER = {"brand": "Acme", "model": "I1", "inverter_type": "hybrid",
                  "phases": "single", "rated_ac_power_kw": 5.0}
VALID_BATTERY = {"brand": "Acme", "model": "B1", "usable_capacity_kwh": 12.8,
                 "cost_aud": 8000}


def run_post(client, kind, body, caller=CALLER_A):
    """(response, exception) — exactly one is None."""
    original = equipment._svc
    equipment._svc = lambda: client
    try:
        return asyncio.run(equipment.create_equipment(kind, body, caller)), None
    except Exception as exc:  # noqa: BLE001
        return None, exc
    finally:
        equipment._svc = original


def t7_write_path() -> int:
    """Returns the number of loudly-skipped (uncounted) checks."""
    print("\nCHECK 7 — POST /api/equipment/{kind}")
    skipped = 0

    # 7a — 2Q.1: two places that must agree, compared by RUNNING the GET.
    res = run_endpoint(None)
    get_keys = set(res) - {"flags"}
    check("(7a) POST kinds == GET response keys (both directions)",
          set(equipment.EQUIPMENT_KINDS) == get_keys,
          f"POST-only={set(equipment.EQUIPMENT_KINDS) - get_keys} "
          f"GET-only={get_keys - set(equipment.EQUIPMENT_KINDS)}")
    _res, exc = run_post(StubClient(), "gadgets", dict(VALID_BATTERY))
    check("(7a) an unknown kind is 404, not 422 (not a bad body — a missing path)",
          getattr(exc, "status_code", None) == 404, repr(exc))

    # 7b — DB-derived mandatory fields: 422 AND zero writes. A 422 that still
    # wrote is the failure worth catching.
    for kind, valid, mandatory in [
        ("panels", VALID_PANEL, ("brand", "model", "rated_power_w")),
        ("inverters", VALID_INVERTER,
         ("brand", "model", "inverter_type", "phases", "rated_ac_power_kw")),
        ("batteries", VALID_BATTERY, ("brand", "model", "usable_capacity_kwh")),
    ]:
        for field in mandatory:
            body = {k: v for k, v in valid.items() if k != field}
            stub = StubClient()
            _res, exc = run_post(stub, kind, body)
            check(f"(7b) {kind} without {field}: 422 and ZERO inserts",
                  getattr(exc, "status_code", None) == 422 and stub.inserts == [],
                  f"exc={exc!r} inserts={stub.inserts}")

    # 7d — server-fixed fields survive a smuggling payload.
    smuggle = {**VALID_BATTERY, "origin": "catalogue", "owner_company_id": "co-EVIL",
               "verified": True, "status": "archived", "promoted_from": "x",
               "id": "evil-id", "created_at": "2020-01-01"}
    stub = StubClient()
    res, exc = run_post(stub, "batteries", smuggle)
    check("(7d) a smuggling payload is accepted without error", exc is None, repr(exc))
    sent = stub.inserts[0][1] if stub.inserts else {}
    check("(7d) origin='user_defined', not the smuggled 'catalogue'",
          sent.get("origin") == "user_defined", str(sent.get("origin")))
    check("(7d) owner is the CALLER's company, not the smuggled one",
          sent.get("owner_company_id") == "co-A", str(sent.get("owner_company_id")))
    check("(7d) verified=False, status='active', promoted_from=None",
          sent.get("verified") is False and sent.get("status") == "active"
          and sent.get("promoted_from") is None,
          f"verified={sent.get('verified')} status={sent.get('status')}")
    check("(7d) the smuggled id did not survive",
          sent.get("id") != "evil-id" and res is not None and res["id"] != "evil-id",
          f"row id={sent.get('id')} resp id={res['id'] if res else None}")

    # 7e — THE ENGINE-READABILITY REFUSAL. Mechanism: battery_specs returns
    # None without cost_aud ("price cannot be assumed 0"), and that return is
    # the ONLY thing the endpoint consults; same for _panel_from_row without
    # length_mm.
    stub = StubClient()
    _res, exc = run_post(stub, "batteries",
                         {k: v for k, v in VALID_BATTERY.items() if k != "cost_aud"})
    check("(7e) battery without cost_aud: 422 (battery_specs -> None), zero writes",
          getattr(exc, "status_code", None) == 422 and stub.inserts == [],
          f"exc={exc!r} inserts={len(stub.inserts)}")
    stub = StubClient()
    res, exc = run_post(stub, "batteries", dict(VALID_BATTERY))
    check("(7e) the SAME body with cost_aud saves", exc is None and len(stub.inserts) == 1,
          f"exc={exc!r}")
    stub = StubClient()
    _res, exc = run_post(stub, "panels",
                         {k: v for k, v in VALID_PANEL.items() if k != "length_mm"})
    check("(7e) panel without length_mm: 422 (_panel_from_row -> None), zero writes "
          "— the alternative is a silent fall-back to the DEFAULT panel: a wrong roof",
          getattr(exc, "status_code", None) == 422 and stub.inserts == [],
          f"exc={exc!r} inserts={len(stub.inserts)}")
    stub = StubClient()
    res, exc = run_post(stub, "panels", dict(VALID_PANEL))
    check("(7e) the SAME panel with length_mm saves", exc is None and len(stub.inserts) == 1,
          f"exc={exc!r}")

    # 7f — THE ROW'S OWN TEST: equal battery_specs dicts mean an identical LP,
    # because the LP consumes NOTHING but this dict. Proven offline; the
    # on-screen end-to-end is Mayur's at prompt 3.
    numbers = {"brand": "Acme", "model": "B1", "usable_capacity_kwh": 12.8,
               "cost_aud": 8000, "depth_of_discharge_pct": 100.0,
               "round_trip_efficiency_pct": 96.0, "max_continuous_charge_kw": 6.6,
               "max_continuous_discharge_kw": 6.6, "warranty_cycles": 6000,
               "warranty_years": 10}
    cat_row = {**numbers, "id": "cat-1", "origin": "catalogue",
               "owner_company_id": None, "verified": True}
    usr_row = {**numbers, "id": "usr-1", "origin": "user_defined",
               "owner_company_id": "co-A", "verified": False}
    f1: list[str] = []
    f2: list[str] = []
    s1 = battery_optimiser.battery_specs(cat_row, f1)
    s2 = battery_optimiser.battery_specs(usr_row, f2)
    stripped1 = {k: v for k, v in (s1 or {}).items() if k != "id"}
    stripped2 = {k: v for k, v in (s2 or {}).items() if k != "id"}
    check("(7f) custom battery drives the LP IDENTICALLY to a catalogue unit: "
          "battery_specs dicts equal on every key except id (the LP reads nothing else)",
          s1 is not None and s2 is not None and stripped1 == stripped2 and f1 == f2,
          f"{stripped1} vs {stripped2}")

    # 7g — engine_assumptions VERBATIM: measure what ships, because a re-worded
    # copy would drift from the engine's own wording and nothing would notice.
    body = {"brand": "Acme", "model": "AX1", "usable_capacity_kwh": 10.0,
            "cost_aud": 7000}
    expected_row = equipment.BatteryIn.model_validate(body).model_dump(exclude_none=True)
    expected_flags: list[str] = []
    battery_optimiser.battery_specs(dict(expected_row), expected_flags)
    stub = StubClient()
    res, exc = run_post(stub, "batteries", dict(body))
    check("(7g) engine_assumptions is battery_specs' flag list BYTE-IDENTICAL",
          exc is None and res["engine_assumptions"] == expected_flags,
          f"resp={res['engine_assumptions'] if res else None} vs engine={expected_flags}")
    check("(7g) ...and it is non-empty for this sparse body (the check can bite)",
          bool(expected_flags), str(expected_flags))

    # 7h — THE PRIVACY BOUNDARY, asserted on the FULL SERIALISED RESPONSE:
    # a leak in a flag or a detail message would pass a list-only check.
    import json as _json
    dup_tables = {"batteries": [
        {"id": "cat-1", "brand": "Sungrow", "model": "SBR128", "series": None,
         "status": "active", "origin": "catalogue", "owner_company_id": None,
         "verified": True, "usable_capacity_kwh": "12.8", "cost_aud": "8000"},
        {"id": "mine-1", "brand": "Sungrow", "model": "SBR128", "series": "v1",
         "status": "active", "origin": "user_defined", "owner_company_id": "co-A",
         "verified": False, "usable_capacity_kwh": 13.0, "cost_aud": 8200},
        {"id": "theirs-1", "brand": "Sungrow", "model": "SBR128", "series": None,
         "status": "active", "origin": "user_defined", "owner_company_id": "co-B",
         "verified": False, "usable_capacity_kwh": 12.8, "cost_aud": 7900},
    ]}
    stub = StubClient(dict(dup_tables))
    res, exc = run_post(stub, "batteries",
                        {"brand": "Sungrow", "model": "SBR128",
                         "usable_capacity_kwh": 13.5, "cost_aud": 8500})
    dup_ids = {d["id"] for d in (res or {}).get("duplicates", [])}
    check("(7h) duplicates = the catalogue row and OUR row exactly",
          exc is None and dup_ids == {"cat-1", "mine-1"}, str(dup_ids))
    serialised = _json.dumps(res)
    check("(7h) company B's id appears NOWHERE in the serialised response",
          "theirs-1" not in serialised and "co-B" not in serialised,
          serialised[:200])
    check("(7h) no count or message reveals a third match exists",
          len((res or {}).get("duplicates", [])) == 2 and (res or {}).get("flags") == [],
          str(res)[:200])

    # 7i — coercion: PostgREST numerics arrive as STRINGS. Without coercion the
    # endpoint reports every field of every duplicate as differing.
    cat_dup = next(d for d in res["duplicates"] if d["id"] == "cat-1")
    diff_fields = {d["field"] for d in cat_dup["differences"]}
    check("(7i) stored \"8000\" (string) vs submitted 8500: IS a difference",
          "cost_aud" in diff_fields, str(cat_dup["differences"]))
    check("(7i) stored \"12.8\" vs 13.5: IS a difference; and usable 13.5 vs \"12.8\" "
          "differs while equal-valued strings do not",
          "usable_capacity_kwh" in diff_fields, str(diff_fields))
    stub2 = StubClient(dict(dup_tables))
    res2, _exc2 = run_post(stub2, "batteries",
                           {"brand": "Sungrow", "model": "SBR128",
                            "usable_capacity_kwh": 12.8, "cost_aud": 8000})
    cat_dup2 = next(d for d in res2["duplicates"] if d["id"] == "cat-1")
    check("(7i) stored \"12.8\"/\"8000\" strings vs submitted 12.8/8000 numbers: "
          "NOT differences (coerced comparison)",
          not {d["field"] for d in cat_dup2["differences"]}
          & {"usable_capacity_kwh", "cost_aud"},
          str(cat_dup2["differences"]))

    # 7j — case-insensitive matching, DELIBERATELY broader than the
    # case-sensitive DB constraint: the comparison should catch MORE than the
    # constraint refuses, never less.
    stub3 = StubClient(dict(dup_tables))
    res3, _exc3 = run_post(stub3, "batteries",
                           {"brand": "sungrow", "model": "sbr128",
                            "usable_capacity_kwh": 12.8, "cost_aud": 8000})
    check("(7j) 'sungrow'/'sbr128' matches 'Sungrow'/'SBR128' (case-insensitive, "
          "broader than the case-sensitive unique constraint — deliberate)",
          {d["id"] for d in (res3 or {}).get("duplicates", [])} >= {"cat-1"},
          str(res3.get("duplicates") if res3 else None))

    # 7k — 23505 SPECIFICALLY is 409; anything else stays 500.
    dup_exc = RuntimeError("duplicate key value violates unique constraint")
    dup_exc.code = "23505"
    _res, exc = run_post(StubClient(insert_raises=dup_exc), "batteries", dict(VALID_BATTERY))
    check("(7k) a 23505 from the insert is 409 with a plain-English detail",
          getattr(exc, "status_code", None) == 409
          and "already added" in str(getattr(exc, "detail", "")),
          repr(exc))
    _res, exc = run_post(StubClient(insert_raises=RuntimeError("disk on fire")),
                         "batteries", dict(VALID_BATTERY))
    check("(7k) any OTHER insert error is 500, never dressed up as 409",
          getattr(exc, "status_code", None) == 500, repr(exc))
    _res, exc = run_post(None, "batteries", dict(VALID_BATTERY))
    check("(7k) no client: 503, never a 200 with a fabricated id (the 3.6 rule)",
          getattr(exc, "status_code", None) == 503, repr(exc))

    # 7l — total under junk: every outcome is a documented HTTP refusal, never
    # an unhandled raise.
    for label, body in [("None", None), ("a string", "x"), ("a list", [1, 2]),
                        ("empty dict", {}),
                        ("every-value-null", {k: None for k in VALID_BATTERY})]:
        _res, exc = run_post(StubClient(), "batteries", body)
        check(f"(7l) junk body ({label}): clean 4xx, no unhandled raise",
              getattr(exc, "status_code", None) in (404, 422), repr(exc)[:120])

    # 7m — caller counts re-derived, signatures unchanged.
    hits_bs, hits_pfr = [], []
    for root, dirs, files in os.walk(BACKEND_DIR):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "scripts", "_legacy")]
        for fn in files:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, BACKEND_DIR)
            for i, line in enumerate(open(path), 1):
                if line.lstrip().startswith("#"):
                    continue  # a comment NAMING the function is not a caller
                if "battery_specs(" in line:
                    hits_bs.append(f"{rel}:{i}")
                if "_panel_from_row(" in line:
                    hits_pfr.append(f"{rel}:{i}")
    print(f"        battery_specs   : {hits_bs}")
    print(f"        _panel_from_row : {hits_pfr}")
    check("(7m) battery_specs: 1 definition + 2 callers (optimiser + this POST)",
          len(hits_bs) == 3, str(hits_bs))
    check("(7m) _panel_from_row: 1 definition + 3 callers (2 in roof_geometry + this POST)",
          len(hits_pfr) == 4, str(hits_pfr))
    import inspect
    # `from __future__ import annotations` makes inspect render annotations as
    # quoted strings — strip the quotes before comparing.
    sig_bs = str(inspect.signature(battery_optimiser.battery_specs)).replace("'", "")
    sig_pfr = str(inspect.signature(roof_geometry._panel_from_row)).replace("'", "")
    check("(7m) battery_specs' signature is unchanged",
          sig_bs == "(row: dict, flags: list[str]) -> Optional[dict]", sig_bs)
    check("(7m) _panel_from_row's signature is unchanged",
          sig_pfr == "(row: dict) -> Optional[dict]", sig_pfr)

    # 7c — LIVE enum check, LOUD SKIP construction (2Q.1). pg_constraint is a
    # system catalog PostgREST does not expose, so the service-role REST client
    # CANNOT read it — this check needs a direct Postgres connection
    # (SUPABASE_DB_URL + psycopg2). Without one it SKIPS LOUDLY, printed and
    # uncounted; WITH one, any error other than absence FAILS so the bridge
    # cannot rot silently.
    db_url = os.getenv("SUPABASE_DB_URL")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        psycopg2 = None
    if not db_url or psycopg2 is None:
        print("  SKIP  (7c) live enum-vs-CHECK-constraint comparison — needs a direct "
              "Postgres connection (SUPABASE_DB_URL + psycopg2); the REST client cannot "
              "see pg_constraint. NOT counted as a pass. The pydantic Literals were "
              "transcribed from pg_constraint output pasted in this task's transcript.")
        skipped += 1
    else:
        try:
            conn = psycopg2.connect(db_url)
            cur = conn.cursor()
            cur.execute(
                "select conrelid::regclass::text, conname, pg_get_constraintdef(oid) "
                "from pg_constraint where conrelid::regclass::text in "
                "('panels','inverters','batteries') and contype='c'")
            defs = {(t, n): d for t, n, d in cur.fetchall()}
            conn.close()

            def members(table, name):
                import re as _re
                return set(_re.findall(r"'([a-z_]+)'::text", defs.get((table, name), "")))

            pairs = [
                ("panels", "panels_cell_technology_check",
                 equipment.PanelIn.model_fields["cell_technology"]),
                ("inverters", "inverters_inverter_type_check",
                 equipment.InverterIn.model_fields["inverter_type"]),
                ("inverters", "inverters_phases_check",
                 equipment.InverterIn.model_fields["phases"]),
                ("batteries", "batteries_chemistry_check",
                 equipment.BatteryIn.model_fields["chemistry"]),
                ("batteries", "batteries_coupling_check",
                 equipment.BatteryIn.model_fields["coupling"]),
            ]
            import typing as _t
            for table, cname, field in pairs:
                lits: set = set()
                for arg in _t.get_args(field.annotation) or (field.annotation,):
                    lits |= {a for a in _t.get_args(arg) if isinstance(a, str)}
                    if isinstance(arg, str):
                        lits.add(arg)
                db_members = members(table, cname)
                check(f"(7c) {cname} members == the pydantic Literal (both directions)",
                      lits == db_members,
                      f"literal-only={lits - db_members} db-only={db_members - lits}")
        except Exception as exc:  # noqa: BLE001
            check("(7c) live enum comparison ran", False, f"errored (not skipped): {exc!r}")
    return skipped



# ═════════════════════════════════════════════════════════════════════════════
# CHECK 8 (3.10 prompt 3) — the wiring: the confirm flag and the full save path.
# ═════════════════════════════════════════════════════════════════════════════

FRONTEND_DIR = os.path.join(os.path.dirname(BACKEND_DIR), "frontend")
JOB_PROXY = os.path.join(FRONTEND_DIR, "app", "api", "job", "[id]", "route.ts")
EQUIP_PROXY = os.path.join(FRONTEND_DIR, "app", "api", "equipment", "[kind]", "route.ts")


def _parse_ts_string_array(path: str, name: str) -> set:
    """The string literals of a `const <name> = [ ... ]` array, PARSED out of
    the TypeScript source. Comments inside the array are ignored because only
    quoted literals are collected."""
    src = open(path).read()
    m = re.search(rf"const\s+{name}\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return set()
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def t8_wiring() -> None:
    print("\nCHECK 8 — the save path: every whitelist between the browser and the DB")

    # 8a — THE 2Q.1 TWO-SIDED SHAPE: two whitelists that must agree, each
    # individually correct today. The Python side is DERIVED from the live
    # model; the TypeScript side is PARSED from the file (a route handler
    # cannot be executed outside Next, so this is weaker than the objective
    # gate's node bridge — it is the best available here, and it is stated).
    backend_fields = set(job_route.JobSitePatch.model_fields.keys())
    proxy_fields = _parse_ts_string_array(JOB_PROXY, "FIELDS")
    missing = backend_fields - proxy_fields
    print(f"        JobSitePatch  ({len(backend_fields)}): {sorted(backend_fields)}")
    print(f"        proxy FIELDS  ({len(proxy_fields)}): {sorted(proxy_fields)}")
    print(f"        accepted by the backend but DROPPED by the proxy: {sorted(missing)}")
    check("(8a) the Next job proxy's FIELDS is a SUPERSET of JobSitePatch's fields "
          "[TS side PARSED, not executed — a handler cannot run outside Next]",
          not missing,
          f"silently dropped in transit: {sorted(missing)}")

    # 8b — the confirm flag, all four places.
    check("(8b) equipment_confirmed is in JobSitePatch",
          "equipment_confirmed" in job_route.JobSitePatch.model_fields,
          str(sorted(job_route.JobSitePatch.model_fields)))
    check("(8b) equipment_confirmed is in _JOBS_PATCH_FIELDS",
          "equipment_confirmed" in job_route._JOBS_PATCH_FIELDS,
          str(sorted(job_route._JOBS_PATCH_FIELDS)))
    check("(8b) equipment_confirmed is in capture._ALLOWED['jobs']",
          "equipment_confirmed" in capture._ALLOWED["jobs"], "absent")
    check("(8b) equipment_confirmed is NOT in _CUSTOMER_PATCH_FIELDS",
          "equipment_confirmed" not in job_route._CUSTOMER_PATCH_FIELDS, "present")

    # 8c — true AND explicit false both reach the update. A truthiness bug
    # would drop false silently and un-confirming would stop working.
    for value in (True, False):
        stub = StubClient({"jobs": [{"job_id": "j1", "company_id": "co-A", "path": "A"}]})
        original = job_route._svc
        job_route._svc = lambda: stub
        try:
            body = job_route.JobSitePatch(equipment_confirmed=value)
            asyncio.run(job_route.patch_job("j1", body, CALLER_A))
        except Exception as exc:  # noqa: BLE001
            check(f"(8c) equipment_confirmed={value} reaches the update", False, repr(exc))
            continue
        finally:
            job_route._svc = original
        sent = stub.updates[0][1] if stub.updates else {}
        check(f"(8c) equipment_confirmed={value} reaches the jobs update as exactly {value}"
              + (" (a truthiness bug would DROP false)" if value is False else ""),
              sent.get("equipment_confirmed") is value, str(sent))

    # 8d — the new proxy: POST only, and its kind guard matches the backend's.
    exists = os.path.exists(EQUIP_PROXY)
    check("(8d) frontend/app/api/equipment/[kind]/route.ts exists", exists, EQUIP_PROXY)
    if exists:
        src = open(EQUIP_PROXY).read()
        check("(8d) it exports POST", re.search(r"export\s+async\s+function\s+POST", src)
              is not None, "no POST export")
        check("(8d) it does NOT export GET (the catalogue is read server-side via apiGet)",
              re.search(r"export\s+async\s+function\s+GET", src) is None,
              "a GET export is present")
        kinds = _parse_ts_string_array(EQUIP_PROXY, "KINDS")
        check("(8d) its kind guard == the backend's EQUIPMENT_KINDS (both directions)",
              kinds == set(equipment.EQUIPMENT_KINDS),
              f"proxy-only={kinds - set(equipment.EQUIPMENT_KINDS)} "
              f"backend-only={set(equipment.EQUIPMENT_KINDS) - kinds}")

    # 8e — derived, never copied from a prompt.
    n_fields = len(job_route.JobSitePatch.model_fields)
    n_jobs = len(job_route._JOBS_PATCH_FIELDS)
    print(f"        len(JobSitePatch.model_fields) = {n_fields}")
    print(f"        len(_JOBS_PATCH_FIELDS)        = {n_jobs}")
    check("(8e) JobSitePatch holds 20 fields and _JOBS_PATCH_FIELDS holds 18",
          n_fields == 20 and n_jobs == 18, f"{n_fields} / {n_jobs}")


def main_() -> int:
    print("verify_equipment_contract.py — 3.10 prompt 1 (offline, writes nothing)\n")
    t1_write_path()
    t2_endpoint()
    t3_relationship()
    t4_autopick_scoping()
    t5_caller_counts()
    t6_junk()
    skipped = t7_write_path()
    t8_wiring()
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({skipped} skipped, not counted)" if skipped else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main_())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
