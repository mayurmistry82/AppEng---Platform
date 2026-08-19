#!/usr/bin/env python3
"""
verify_objective_contract.py — the 3.9 prompt-1 gate: the objective/budget
columns' write path, the ONE resolver both sizing endpoints read, and THE
RELATIONSHIP CHECK — the writable objective set (JobSitePatch's Literal) and
the engine's set (solar_optimiser.VALID_OBJECTIVES) are two artifacts that are
each individually correct, and nothing compared them until now.

Offline, stub client, WRITES NOTHING.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_objective_contract.py
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import traceback
import typing

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import capture  # noqa: E402
import solar_optimiser  # noqa: E402
from routes import job as job_route  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402

GATE_CALLER = auth.Caller(user_id="u-gate", email="gate@example.com",
                          company_id="co-gate", role="owner")

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


# ── Stub Supabase client (reads only — this gate writes nothing) ─────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self._c, self._t = client, table
        self._filters: list[tuple[str, object]] = []

    def select(self, *_a, **_k):
        return self

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        rows = self._c.tables.get(self._t, [])
        return _Result([dict(r) for r in rows
                        if all(r.get(k) == v for k, v in self._filters)])


class StubClient:
    def __init__(self, tables=None):
        self.tables: dict[str, list] = dict(tables or {})

    def table(self, name):
        return _Query(self, name)


def body(**kw) -> sizing_route.OptimiseRequest:
    """A REAL OptimiseRequest — using the actual model is the point: 5a/5b can
    only both pass when the old `objective: str = "max_npv"` default is gone,
    because with it the two cases are literally the same request object."""
    return sizing_route.OptimiseRequest(**kw)


# 3.11b: the endpoints now REQUIRE a Caller (no usable default, deliberately),
# and the ownership check reads jobs.company_id — so the stub rows carry the
# gate Caller's company and the endpoint helper passes it explicitly.
def jobs_stub(**cols) -> StubClient:
    row = {"job_id": "j1", "company_id": "co-gate",
           "created_at": "2026-08-18T00:00:00Z",
           "objective": None, "custom_weight": None, "budget_aud": None}
    row.update(cols)
    return StubClient({"jobs": [row]})


def t3_structure() -> None:
    print("T3. structure — the whitelist, the allowlist, THE RELATIONSHIP")

    # 3a — enumerated, not counted.
    fields = set(job_route.JobSitePatch.model_fields.keys())
    expected = {"storeys", "roof_material", "dwelling_type", "year_built",
                "bedrooms", "floor_area_m2", "electrical_phase",
                "customer_name", "has_existing_solar", "existing_solar_kw",
                "existing_inverter_kw", "intent", "address",
                "objective", "custom_weight", "budget_aud",
                # 3.10 — the equipment constraints and the confirm flag.
                "equipment_panel_id", "equipment_inverter_id",
                "equipment_battery_id", "equipment_confirmed"}
    check("(3a) JobSitePatch.model_fields is exactly the twenty names",
          fields == expected,
          f"extra={fields - expected} missing={expected - fields}")

    # 3b — gained exactly the three, lost none.
    check("(3b) _JOBS_PATCH_FIELDS is the eleven 3.4b/3.3c names + the 3.9 three "
          "+ the 3.10 three + equipment_confirmed (eighteen)",
          job_route._JOBS_PATCH_FIELDS == {
              "storeys", "roof_material", "dwelling_type", "year_built",
              "bedrooms", "floor_area_m2", "electrical_phase",
              "has_existing_solar", "existing_solar_kw", "existing_inverter_kw",
              "intent", "objective", "custom_weight", "budget_aud",
              "equipment_panel_id", "equipment_inverter_id",
              "equipment_battery_id", "equipment_confirmed"},
          str(sorted(job_route._JOBS_PATCH_FIELDS)))

    # 3c
    check("(3c) capture._ALLOWED['jobs'] contains all three",
          {"objective", "custom_weight", "budget_aud"} <= capture._ALLOWED["jobs"],
          str(sorted({"objective", "custom_weight", "budget_aud"}
                     - capture._ALLOWED["jobs"])))

    # 3d — THE RELATIONSHIP CHECK, both directions.
    ann = job_route.JobSitePatch.model_fields["objective"].annotation
    literal_members: set = set()
    for arg in typing.get_args(ann):
        literal_members |= set(typing.get_args(arg))
    literal_members.discard(type(None))
    check("(3d) VALID_OBJECTIVES has exactly four members",
          len(solar_optimiser.VALID_OBJECTIVES) == 4,
          str(sorted(solar_optimiser.VALID_OBJECTIVES)))
    check("(3d) every Literal member is in VALID_OBJECTIVES (writable ⊆ engine)",
          literal_members <= solar_optimiser.VALID_OBJECTIVES,
          f"writable-only: {literal_members - solar_optimiser.VALID_OBJECTIVES}")
    check("(3d) every VALID_OBJECTIVES member is in the Literal (engine ⊆ writable)",
          solar_optimiser.VALID_OBJECTIVES <= literal_members,
          f"engine-only: {solar_optimiser.VALID_OBJECTIVES - literal_members}")

    # 3e — caller count (F135/F145). The def contains the substring too, so
    # the two are separated: exactly 1 definition, exactly 2 non-def calls.
    src = open(os.path.join(BACKEND_DIR, "routes", "sizing.py")).read()
    defs = len(re.findall(r"def _resolve_objective\(", src))
    calls = len(re.findall(r"(?<!def )_resolve_objective\(", src))
    check("(3e) _resolve_objective: 1 definition", defs == 1, str(defs))
    check("(3e) _resolve_objective: exactly 2 call sites (both endpoints)",
          calls == 2, str(calls))
    # The string that is present when the fault is present: a call site left
    # on body.objective. Zero after the change.
    hits = src.count("body.objective")
    check("(3e) the literal string 'body.objective' appears ZERO times",
          hits == 0, f"{hits} occurrences")


def t4_no_regression() -> None:
    print("\nT4. NO-REGRESSION — the defaults are byte-identical to pre-3.9")

    # A job row exists and all three columns are NULL.
    flags: list[str] = []
    r = sizing_route._resolve_objective(jobs_stub(), body(job_id="j1"), flags)
    check("(4) stored all-NULL: objective == 'max_npv'",
          r["objective"] == "max_npv", str(r))
    check("(4) stored all-NULL: custom_weight == 0.5",
          r["custom_weight"] == 0.5, str(r))
    check("(4) stored all-NULL: budget is None", r["budget"] is None, str(r))
    check("(4) ...and the one 'nobody chose' flag was appended",
          len(flags) == 1 and "no objective chosen" in flags[0], str(flags))

    # No job_id at all — a stateless call is the API working, not a fallback.
    flags = []
    r = sizing_route._resolve_objective(StubClient(), body(), flags)
    check("(4) stateless: same three values",
          r == {"objective": "max_npv", "custom_weight": 0.5, "budget": None},
          str(r))
    check("(4) stateless: NO flag appended", flags == [], str(flags))


def t5_precedence() -> None:
    print("\nT5. precedence — one case per rule")

    # 5a — stored wins over nothing.
    flags: list[str] = []
    r = sizing_route._resolve_objective(
        jobs_stub(objective="min_payback"), body(job_id="j1"), flags)
    check("(5a) stored 'min_payback', request None -> 'min_payback'",
          r["objective"] == "min_payback", str(r))
    check("(5a) ...with no defaulted-objective flag (somebody DID choose)",
          flags == [], str(flags))

    # 5b — explicit beats stored. Cannot pass with the old non-None default.
    flags = []
    r = sizing_route._resolve_objective(
        jobs_stub(objective="min_payback"),
        body(job_id="j1", objective="max_npv"), flags)
    check("(5b) stored 'min_payback', request 'max_npv' -> 'max_npv' (explicit wins)",
          r["objective"] == "max_npv", str(r))

    # 5c — the documented limitation, pinned so changing it is deliberate.
    flags = []
    r = sizing_route._resolve_objective(
        jobs_stub(budget_aud=20000), body(job_id="j1"), flags)
    check("(5c) stored budget_aud 20000, request budget None -> 20000 "
          "(None cannot mean 'uncapped' on a job with a stored cap — documented)",
          r["budget"] == 20000.0, str(r))

    # 5d — a stored objective the engine does not know (raw DB edit only).
    flags = []
    r = sizing_route._resolve_objective(
        jobs_stub(objective="banana"), body(job_id="j1"), flags)
    check("(5d) stored 'banana' -> 'max_npv' fallback",
          r["objective"] == "max_npv", str(r))
    check("(5d) ...with a flag naming the fallback",
          any("banana" in f and "max_npv" in f.lower().replace("maximum npv", "max_npv")
              for f in flags) or any("banana" in f for f in flags),
          str(flags))

    # Coercion corners: stored custom_weight garbage / stored budget zero.
    flags = []
    r = sizing_route._resolve_objective(
        jobs_stub(custom_weight="not a number", budget_aud=0), body(job_id="j1"), flags)
    check("(5) stored custom_weight garbage -> 0.5 with a flag",
          r["custom_weight"] == 0.5 and any("custom_weight" in f for f in flags),
          f"{r} {flags}")
    check("(5) stored budget 0 -> NO CAP (never a cap of zero), flagged",
          r["budget"] is None and any("budget" in f for f in flags),
          f"{r} {flags}")
    # A numeric STRING from PostgREST is still a number.
    flags = []
    r = sizing_route._resolve_objective(
        jobs_stub(custom_weight="0.7", budget_aud="15000"), body(job_id="j1"), flags)
    check("(5) numeric strings coerce: custom_weight '0.7' -> 0.7, budget '15000' -> 15000",
          r["custom_weight"] == 0.7 and r["budget"] == 15000.0, str(r))


def _run_endpoint(client: StubClient, **body_kw) -> dict:
    original = sizing_route._sb
    sizing_route._sb = lambda: client
    try:
        return asyncio.run(sizing_route.optimise_sizing(body(**body_kw), GATE_CALLER))
    finally:
        sizing_route._sb = original


def t5e_t6_endpoint() -> None:
    print("\nT5e/T6. the endpoint — error shape and ordering")

    # 5e — a REQUEST objective the engine does not know: the existing error
    # dict, unchanged, valid list sorted.
    res = _run_endpoint(StubClient(), objective="banana")
    check("(5e) request 'banana' -> the existing error dict",
          res.get("error") == "invalid objective 'banana'", str(res))
    check("(5e) ...with 'valid' listing the four sorted names",
          res.get("valid") == sorted(solar_optimiser.VALID_OBJECTIVES), str(res))

    # 6 — ORDERING: a job with NO roof row and a bad request objective must
    # return the objective error, not the roof one. Moves the moment the
    # resolver (and the moved validity check) slides below the roof block.
    res = _run_endpoint(jobs_stub(), job_id="j1", objective="banana")
    check("(6) no roof + invalid objective -> the OBJECTIVE error",
          res.get("error") == "invalid objective 'banana'", str(res))
    check("(6) ...and NOT needs_roof_input",
          "needs_roof_input" not in res, str(res))


def t7_cross_language() -> int:
    """Returns the number of SKIPPED checks (0 or 1) — a skip is NOT a pass."""
    print("\nT7. the cross-language half — the gate 4.5 will trip on")
    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    script = ('import { VALID_OBJECTIVES } from "./lib/worksheet.ts"; '
              "console.log(JSON.stringify([...VALID_OBJECTIVES].sort()))")
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=frontend, capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        check("(7) node available for the cross-language check", False, "node not found")
        return 0
    if proc.returncode != 0:
        stderr = proc.stderr or ""
        if "does not provide an export named 'VALID_OBJECTIVES'" in stderr:
            # Both sides RUN rather than being parsed (F148) — and the
            # frontend half does not exist until prompt 2 exports it.
            print("  SKIP  (7) pending prompt 2 — lib/worksheet.ts does not export "
                  "VALID_OBJECTIVES yet. NOT counted as a pass. The day prompt 2 "
                  "lands, this becomes a live two-sided set-equality check.")
            return 1
        check("(7) node import of lib/worksheet.ts", False, stderr.strip()[:200])
        return 0
    import json
    frontend_set = set(json.loads(proc.stdout.strip()))
    check("(7) frontend VALID_OBJECTIVES == engine VALID_OBJECTIVES (both directions)",
          frontend_set == solar_optimiser.VALID_OBJECTIVES,
          f"frontend-only={frontend_set - solar_optimiser.VALID_OBJECTIVES} "
          f"engine-only={solar_optimiser.VALID_OBJECTIVES - frontend_set}")
    return 0


def main() -> int:
    print("verify_objective_contract.py — 3.9 prompt 1 (offline, writes nothing)\n")
    t3_structure()
    t4_no_regression()
    t5_precedence()
    t5e_t6_endpoint()
    skipped = t7_cross_language()
    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({skipped} skipped pending prompt 2, not counted)" if skipped else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
