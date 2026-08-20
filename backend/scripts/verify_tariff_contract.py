#!/usr/bin/env python3
"""
verify_tariff_contract.py — the 3.8 prompt-1 gate: the tariff envelope, the
one resolver, the rate_24 reader that matches bill_parser's emitter, and the
write endpoint. WRITES NOTHING — every check runs against stubs and in-memory
dicts (tariffs is 0 rows live, and a written row would permanently lock a
job's address).

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_tariff_contract.py
"""
from __future__ import annotations

import ast
import asyncio
import os
import re
import sys
import traceback
from types import SimpleNamespace

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import bill_parser  # noqa: E402
import capture  # noqa: E402
import auth  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from routes import demand  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402

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


CALLER = auth.Caller(user_id="u1", email="u@example.com", company_id="co-1", role="owner")


# ── Stub Supabase client ─────────────────────────────────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self._c, self._t = client, table
        self._filters: list[tuple[str, object]] = []
        self._op, self._payload, self._oc = "select", None, None

    def select(self, *_a, **_k):
        return self

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def upsert(self, payload, on_conflict=None):
        self._op, self._payload, self._oc = "upsert", payload, on_conflict
        return self

    def execute(self):
        rows = self._c.tables.setdefault(self._t, [])
        if self._op == "upsert":
            row = dict(self._payload)
            if "tariff_id" not in row:
                self._c.seq += 1
                row["tariff_id"] = f"stub-tariff-{self._c.seq}"
            key = self._oc
            replaced = False
            if key and row.get(key) is not None:
                for i, r in enumerate(rows):
                    if r.get(key) == row.get(key):
                        rows[i] = {**r, **row}
                        row = rows[i]
                        replaced = True
                        break
            if not replaced:
                rows.append(row)
            self._c.upserts.append((self._t, dict(row)))
            return _Result([dict(row)])
        return _Result([dict(r) for r in rows
                        if all(r.get(k) == v for k, v in self._filters)])


class StubClient:
    def __init__(self, tables=None):
        self.tables: dict[str, list] = dict(tables or {})
        self.upserts: list = []
        self.seq = 0

    def table(self, name):
        return _Query(self, name)


def body_ns(**kw) -> SimpleNamespace:
    base = dict(job_id=None, import_rate=None, fit=None, export_limit_kw=None,
                import_rates_24=None, tou_windows=None)
    base.update(kw)
    return SimpleNamespace(**base)


BILL_ROW = {
    "job_id": "j1",  # the stub filters on eq("job_id", ...), as PostgREST would
    "parsed_json": {
        "tariff_rate": 0.38,
        "tariff_structured": {
            "tariff_type": "tou",
            "supply_charge": 1.1,
            "tou_windows": [
                # Rates chosen so the 24-h mean (14*0.60 + 10*0.20)/24 = 0.4333
                # is CLEARLY unequal to the 0.38 scalar — test 4's point.
                {"label": "peak", "rate": 0.60, "start": "07:00", "end": "21:00", "days": "all"},
                {"label": "offpeak", "rate": 0.20, "start": "21:00", "end": "07:00", "days": "all"},
            ],
            "demand_charges": [], "controlled_load": [], "block_tiers": [], "fit_tiers": [],
        },
    },
    "feed_in_tariff": 0.07,
}


def _function_code_without_docs(module_path: str, func_name: str) -> str:
    """The function's source minus its docstring and comments — so a docstring
    SAYING 'never rotated' cannot trip a check for rotation CODE."""
    src = open(module_path).read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            body = node.body
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                body = body[1:]
            lines = []
            for stmt in body:
                seg = ast.get_source_segment(src, stmt) or ""
                for line in seg.split("\n"):
                    lines.append(line.split("#", 1)[0])
            return "\n".join(lines)
    return ""


def t1_structure() -> None:
    print("T1. structure — caller counts and the no-rotation rule")
    src = open(os.path.join(BACKEND_DIR, "routes", "sizing.py")).read()
    rate_defs = len(re.findall(r"def _build_rate_24\(", src))
    rate_calls = len(re.findall(r"(?<!def )_build_rate_24\(", src))
    # THE PROMPT PREDICTED 2 CALL SITES; reality is 1 — the resolver is the
    # sole caller, because both endpoints take rate_24 FROM the resolver
    # rather than building it themselves. Asserting reality; the discrepancy
    # is reported. A second caller appearing later fails here.
    check("(1) _build_rate_24: 1 definition", rate_defs == 1, str(rate_defs))
    check("(1) _build_rate_24: exactly 1 call site (inside _resolve_tariff)",
          rate_calls == 1, str(rate_calls))
    res_defs = len(re.findall(r"def _resolve_tariff\(", src))
    res_calls = len(re.findall(r"(?<!def )_resolve_tariff\(", src))
    check("(1) _resolve_tariff: 1 definition", res_defs == 1, str(res_defs))
    check("(1) _resolve_tariff: exactly 2 call sites (both endpoints)",
          res_calls == 2, str(res_calls))

    wh_defs = len(re.findall(r"def _window_hour\(", src))
    wh_calls = len(re.findall(r"(?<!def )_window_hour\(", src))
    # 3.8b took this from 2 call sites to 3: the `hours` branch now coerces
    # through _window_hour instead of int(h), which is the whole point of the
    # task — ONE coercion rule for an hour. All 3 are inside _build_rate_24.
    check("(1) _window_hour: 1 definition", wh_defs == 1, str(wh_defs))
    check("(1) _window_hour: exactly 3 call sites (start, end, hours entry)",
          wh_calls == 3, str(wh_calls))

    hits = len(re.findall(r"get_default_fit|get_export_limit", src))
    # docstring mentions each once; code calls each once => 2 code + 2 doc.
    code_hits = len(re.findall(r"nem_data\.(get_default_fit|get_export_limit)\(", src))
    check("(1) get_default_fit/get_export_limit called ONLY in the resolver (1 each)",
          code_hits == 2, f"code calls={code_hits} total mentions={hits}")

    path = os.path.join(BACKEND_DIR, "routes", "sizing.py")
    for fn in ("_resolve_tariff", "_build_rate_24", "_window_hour"):
        code = _function_code_without_docs(path, fn).lower()
        matches = sum(code.count(w) for w in ("utc", "offset", "rotate"))
        check(f"(1) {fn}: zero rotation/offset/utc in CODE (docstrings excluded)",
              matches == 0, f"{matches} matches")


def t2_round_trip() -> None:
    print("\nT2. the round trip — bill_parser's own output into _build_rate_24")
    # THE CHECK THAT DID NOT EXIST: every earlier test looked at one side.
    structured, detected = bill_parser._build_tariff_structured(None, 0.40, 1.10, 0.05)
    check("(2) the parser synthesises a flat window even with no structure",
          not detected and structured["tou_windows"], str(structured["tou_windows"]))
    flags: list[str] = []
    try:
        rate, is_tou = sizing_route._build_rate_24(None, None, structured, 0.40, flags)
        check("(2) the parser's own shape does not raise", True)
    except Exception as exc:  # noqa: BLE001
        check("(2) the parser's own shape does not raise", False,
              f"{type(exc).__name__}: {exc}")
        return
    check("(2) 00:00-24:00 flat window -> ALL 24 hours filled at the flat rate",
          is_tou is True and len(rate) == 24 and all(v == 0.40 for v in rate),
          str(rate[:4]))
    check("(2) rate_24 is 24 finite floats",
          len(rate) == 24 and all(isinstance(v, float) and v == v
                                  and abs(v) != float("inf") for v in rate))

    flags2: list[str] = []
    rate2, tou2 = sizing_route._build_rate_24(
        None, None, BILL_ROW["parsed_json"]["tariff_structured"], 0.40, flags2)
    check("(2) a real 2-window TOU maps: 07..20 peak, 21..23+00..06 offpeak",
          tou2 is True and rate2[7] == 0.60 and rate2[20] == 0.60
          and rate2[21] == 0.20 and rate2[6] == 0.20, str(rate2))


def t4_no_regression() -> None:
    print("\nT4. no-regression — the solar scalar is the bill's, never the mean")
    stub = StubClient({"jobs": [], "tariffs": [], "bills": [BILL_ROW]})
    flags: list[str] = []
    t = sizing_route._resolve_tariff(stub, body_ns(job_id="j1"), "SA", "5000", flags)
    mean = sum(t["rate_24"]) / 24.0
    print(f"        import_rate = {t['import_rate']}   sum(rate_24)/24 = {mean:.6f}")
    check("(4) import_rate == 0.38 exactly (the bill's scalar)",
          t["import_rate"] == 0.38, str(t["import_rate"]))
    check("(4) ...and the mean is CLEARLY different, so wiring to the mean would fail",
          abs(mean - 0.38) > 0.01, f"mean={mean:.6f}")
    check("(4) fit from the bill: 0.07, not a fallback",
          t["fit"] == 0.07 and t["fit_is_fallback"] is False)
    # 3.13 prompt 4b: `source` RENAMED to import_rate_source (what it always
    # genuinely meant). The scalar came from the bill; the flat vector it
    # tiled therefore carries the bill's provenance too.
    check("(4) import_rate_source is 'bill'",
          t["import_rate_source"] == "bill", t["import_rate_source"])
    check("(4) rate_24_source: the bill's WINDOWS built the vector -> 'bill'",
          t["rate_24_source"] == "bill", t["rate_24_source"])
    check("(4) fit_source is 'bill' (the bill's feed-in figure)",
          t["fit_source"] == "bill", t["fit_source"])
    check("(4) tariff_type_source is 'bill'",
          t["tariff_type_source"] == "bill", t["tariff_type_source"])


def t5_resolution_order() -> None:
    print("\nT5. resolution order — request > stored > bill > default")
    stored_row = {"tariff_type": "flat", "supply_charge": 0.9, "tou_windows": None,
                  "import_rate": 0.42, "fit_aud_per_kwh": 0.06, "export_limit_kw": 7.5,
                  "source": "installer", "job_id": "j1"}
    cases = [
        ("a. request beats all", body_ns(job_id="j1", import_rate=0.55, fit=0.09,
                                          export_limit_kw=3.0),
         {"tariffs": [stored_row], "bills": [BILL_ROW]},
         0.55, "request", 0.09, 3.0),
        ("b. stored beats bill", body_ns(job_id="j1"),
         {"tariffs": [stored_row], "bills": [BILL_ROW]},
         0.42, "installer", 0.06, 7.5),
        ("c. bill beats default", body_ns(job_id="j1"),
         {"tariffs": [], "bills": [BILL_ROW]},
         0.38, "bill", 0.07, None),
        ("d. nothing -> defaults, flagged", body_ns(job_id="j1"),
         {"tariffs": [], "bills": []},
         0.40, "default", None, None),
    ]
    for label, body, tables, exp_rate, exp_source, exp_fit, exp_export in cases:
        stub = StubClient({"jobs": [], **tables})
        flags: list[str] = []
        t = sizing_route._resolve_tariff(stub, body, "SA", "5000", flags)
        check(f"(5{label[0]}) import_rate {exp_rate} / import_rate_source "
              f"{exp_source} (3.13-4b rename of `source`)",
              t["import_rate"] == exp_rate
              and t["import_rate_source"] == exp_source,
              f"{t['import_rate']} / {t['import_rate_source']}")
        if exp_fit is not None:
            check(f"(5{label[0]}) fit {exp_fit}", t["fit"] == exp_fit, str(t["fit"]))
        if exp_export is not None:
            check(f"(5{label[0]}) export {exp_export}",
                  t["export_limit_kw"] == exp_export, str(t["export_limit_kw"]))
        if label.startswith("d"):
            check("(5d) fit falls back via get_default_fit and is flagged",
                  t["fit_is_fallback"] is True
                  and any("fit fallback" in f for f in flags), str(flags))
            check("(5d) export falls back via get_export_limit (meta shape)",
                  "is_default" in t["export_meta"] or "dnsp" in t["export_meta"],
                  str(t["export_meta"]))
            check("(5d) the existing import_rate fallback flag is present",
                  any("import_rate fallback $0.40/kWh" in f for f in flags), str(flags))


def t6_days_flag() -> None:
    print("\nT6. the days flag")
    windows = [
        {"label": "peak", "rate": 0.5, "start": "06:00", "end": "10:00", "days": "weekday"},
        {"label": "offpeak", "rate": 0.2, "start": "10:00", "end": "06:00", "days": "weekday"},
    ]
    flags: list[str] = []
    rate, tou = sizing_route._build_rate_24(None, windows, None, 0.40, flags)
    expected = ("This tariff has weekday/weekend-specific rates; the model applies one "
                "24-hour rate profile to every day of the year.")
    check("(6) the exact weekday/weekend flag STRING is present",
          expected in flags, str(flags))
    check("(6) ...and the rates are still applied to all 24 hours",
          tou is True and rate[7] == 0.5 and rate[12] == 0.2, str(rate[:8]))


def _run_endpoint(stub, job_id, payload):
    saved_client = demand._client
    saved_capture = capture._get_client
    demand._client = lambda: stub
    capture._get_client = lambda: stub
    try:
        body = demand.TariffSaveRequest(**payload)
        return asyncio.run(demand.save_job_tariff(job_id, body, CALLER)), None
    except HTTPException as exc:
        return None, exc
    finally:
        demand._client = saved_client
        capture._get_client = saved_capture


def t7_endpoint() -> None:
    print("\nT7. the write endpoint, fully stubbed — no rows created anywhere")
    my_job = {"job_id": "j1", "company_id": "co-1"}

    stub = StubClient({"jobs": [my_job]})
    res, exc = _run_endpoint(stub, "j1", {"tariff_type": "flat", "import_rate": 0.42})
    check("(7a) flat 0.42 -> 200, saved true", exc is None and res["saved"] is True,
          f"exc={exc} res={res}")
    check("(7a) address_now_locked true (the tariff row itself locks it)",
          res is not None and res["address_now_locked"] is True)
    check("(7a) the echoed tariff row comes from the DB read-back",
          res is not None and res["tariff"] is not None
          and res["tariff"].get("import_rate") == 0.42, str(res and res["tariff"]))

    stub = StubClient({"jobs": [my_job]})
    _res, exc = _run_endpoint(stub, "j1", {"tariff_type": "flat"})
    check("(7b) flat with no import_rate -> 422",
          exc is not None and exc.status_code == 422, str(exc))

    stub = StubClient({"jobs": [my_job]})
    _res, exc = _run_endpoint(stub, "j1", {
        "tariff_type": "tou",
        "tou_windows": [{"label": "flat", "rate": 0.4, "start": "00:00", "end": "24:00"}]})
    check("(7c) tou with ONE window -> 422",
          exc is not None and exc.status_code == 422, str(exc))

    stub = StubClient({"jobs": [my_job]})
    res, exc = _run_endpoint(stub, "j1", {
        "tariff_type": "tou",
        "tou_windows": [
            {"label": "peak", "rate": 0.5, "start": "6:00", "end": "21:00"},
            {"label": "offpeak", "rate": 0.2, "start": "21:00", "end": "6:00"},
        ]})
    check("(7d) two windows with start '6:00' -> 200 (regex accepts H:MM)",
          exc is None and res["saved"] is True, str(exc))

    try:
        demand.TariffWindowIn(label="peak", rate=0.5, start="25:00", end="26:00")
        check("(7e) start '25:00' -> 422 at the model", False, "validated cleanly")
    except Exception:  # noqa: BLE001 — pydantic ValidationError
        check("(7e) start '25:00' -> 422 at the model", True)

    stub = StubClient({"jobs": [my_job]})
    saved_save = capture.save_tariff
    capture.save_tariff = lambda payload: None
    try:
        res, exc = _run_endpoint(stub, "j1", {"tariff_type": "flat", "import_rate": 0.42})
    finally:
        capture.save_tariff = saved_save
    check("(7f) capture returns None -> 200, saved is the boolean False, warned",
          exc is None and res["saved"] is False and res["saved"] is not None
          and isinstance(res["saved"], bool)
          and any("could not be saved" in w for w in res["warnings"]),
          str(res))
    check("(7f) ...and address_now_locked is False", res["address_now_locked"] is False)

    foreign = StubClient({"jobs": [{"job_id": "j1", "company_id": "co-OTHER"}]})
    _res, exc_foreign = _run_endpoint(foreign, "j1", {"tariff_type": "flat", "import_rate": 0.4})
    absent = StubClient({"jobs": []})
    _res, exc_absent = _run_endpoint(absent, "j1", {"tariff_type": "flat", "import_rate": 0.4})
    print(f"        foreign 404 detail: {getattr(exc_foreign, 'detail', None)!r}")
    print(f"        absent  404 detail: {getattr(exc_absent, 'detail', None)!r}")
    check("(7g) foreign and absent 404s byte-identical",
          exc_foreign is not None and exc_absent is not None
          and exc_foreign.status_code == exc_absent.status_code == 404
          and exc_foreign.detail == exc_absent.detail,
          f"{exc_foreign} vs {exc_absent}")


# The four flag strings that existed before 3.8b, asserted by EQUALITY: a
# reworded flag is a silent break of anything that matches on it later.
FLAG_ROUNDED = ("TOU window times were rounded down to the hour — rate_24 has "
                "one slot per hour.")
FLAG_DAYS = ("This tariff has weekday/weekend-specific rates; the model applies "
             "one 24-hour rate profile to every day of the year.")
FLAG_GAPS = "Some hours had no TOU window — filled with the flat rate."
FLAG_FLAT = ("No TOU tariff — flat import rate used (battery value = "
             "self-consumption + peak avoidance only) — is_fallback.")
# 3.8b's two new ones.
FLAG_PARTIAL_HOURS = "Some hours in a TOU window were unreadable and were skipped."


def _build(windows, flat=0.40):
    """Call it and never let an exception escape — a raise IS the failure."""
    flags: list[str] = []
    try:
        rate, is_tou = sizing_route._build_rate_24(None, windows, None, flat, flags)
        return rate, is_tou, flags, None
    except Exception as ex:  # noqa: BLE001
        return None, None, flags, f"{type(ex).__name__}: {ex}"


def t8_never_raises() -> None:
    print("\nT8. _build_rate_24 never raises — the rate and hours coercions (3.8b)")

    # 8a-8d: the four shapes that raised before 3.8b. int(h) and float(r) were
    # unguarded coercions inside a function whose only error channel is the
    # endpoint catch-all; since 3.8 BOTH sizing endpoints reach this code.
    rate, is_tou, flags, err = _build([{"rate": 0.6, "hours": ["06:00", "07:00"]}])
    check("(8a) hours ['06:00','07:00'] does not raise", err is None, str(err))
    # NOTE: this one is APPLIED, not skipped — _window_hour reads "HH:MM", so
    # hours 6 and 7 legitimately take the window rate. (The prompt predicted a
    # skip; reusing _window_hour, which it mandates, makes it readable.)
    check("(8a) ...and hours 6 and 7 take the window rate 0.6",
          rate is not None and rate[6] == 0.6 and rate[7] == 0.6 and rate[8] == 0.40,
          str(rate))

    # 8b2 (3.12, F142): an `hours` value that is NOT a list at all. A bare
    # string is truthy AND iterable, so pre-3.12 "06:00" iterated character by
    # character and hours 0 and 6 took the rate; a bare int RAISED. The fix
    # iterates nothing for a non-list/tuple, so the whole window is ignored
    # with the unreadable-HOURS-LIST flag — never the unreadable-TIMES flag
    # (that would misname an hours fault as a start/end fault).
    for label, hours_val in (("'06:00' (bare string)", "06:00"),
                             ("{'a': 1} (a dict)", {"a": 1}),
                             ("6 (a bare int)", 6)):
        rate, is_tou, flags, err = _build([{"rate": 0.6, "hours": hours_val}])
        check(f"(8b2) hours {label} does not raise", err is None, str(err))
        check(f"(8b2) hours {label}: whole window ignored — flat fill, is_tou False",
              rate == [0.40] * 24 and is_tou is False, f"{rate} is_tou={is_tou}")
        check(f"(8b2) hours {label}: unreadable-hours-list flag, never unreadable times",
              any(f.startswith("A TOU window had an unreadable hours list and was ignored: ")
                  for f in flags)
              and not any("unreadable times" in f for f in flags), str(flags))

    rate, is_tou, flags, err = _build([{"rate": 0.6, "hours": ["breakfast"]}])
    check("(8b) hours ['breakfast'] does not raise", err is None, str(err))
    check("(8b) ...whole window ignored, flat fill, is_tou False",
          rate == [0.40] * 24 and is_tou is False, str(rate))
    check("(8b) ...with the unreadable-hours flag naming the window",
          any(f.startswith("A TOU window had an unreadable hours list and was ignored: ")
              for f in flags), str(flags))

    rate, is_tou, flags, err = _build([{"rate": "forty cents", "start": "06:00", "end": "10:00"}])
    check("(8c) rate 'forty cents' does not raise", err is None, str(err))
    check("(8c) ...whole window ignored, flat fill, is_tou False",
          rate == [0.40] * 24 and is_tou is False, str(rate))
    check("(8c) ...with the unreadable-rate flag naming the window",
          any(f.startswith("A TOU window had an unreadable rate and was ignored: ")
              for f in flags), str(flags))

    rate, is_tou, flags, err = _build([{"rate": {"amount": 0.4}, "start": "06:00", "end": "10:00"}])
    check("(8d) rate {'amount': 0.4} (a dict) does not raise", err is None, str(err))
    check("(8d) ...whole window ignored, flat fill",
          rate == [0.40] * 24 and is_tou is False, str(rate))

    # 8e: a numeric STRING is legitimate parser output. Rejecting it would be
    # a regression, not a hardening.
    rate, _, flags, err = _build([{"rate": "0.45", "start": "06:00", "end": "10:00"}])
    check("(8e) numeric-string rate '0.45' is ACCEPTED, hours 6-9 == 0.45",
          err is None and rate[6:10] == [0.45] * 4, f"{err} {rate}")

    # 8f: THE ONE A CARELESS FIX GETS WRONG. bool is a subclass of int, so
    # isinstance(r, (int, float)) silently makes True a $1.00/kWh tariff.
    rate, _, flags, err = _build([{"rate": True, "start": "06:00", "end": "10:00"}])
    check("(8f) rate True is UNREADABLE, not 1.0 — rate_24[6] == 0.40",
          err is None and rate[6] == 0.40, f"{err} rate_24[6]={rate[6] if rate else None}")
    check("(8f) ...and it is not silently dropped — the flag is there",
          any(f.startswith("A TOU window had an unreadable rate and was ignored: ")
              for f in flags), str(flags))

    # 8g: a partially readable hours list applies what it could read.
    rate, is_tou, flags, err = _build([{"rate": 0.6, "hours": [6, "07:00", "breakfast", 99]}])
    check("(8g) partial hours: 6 and 7 applied at 0.6, 8 left flat",
          err is None and rate[6] == 0.6 and rate[7] == 0.6 and rate[8] == 0.40, f"{err} {rate}")
    check("(8g) ...with the partially-unreadable flag, exact string",
          FLAG_PARTIAL_HOURS in flags, str(flags))
    check("(8g) ...and NOT the whole-window flag (it was not ignored)",
          not any(f.startswith("A TOU window had an unreadable hours list") for f in flags),
          str(flags))

    # 8h: NaN and inf parse through float() but are not rates. The contract is
    # 24 FINITE floats.
    for label, bad in (("nan", float("nan")), ("inf", float("inf")), ("'nan'", "nan")):
        rate, _, flags, err = _build([{"rate": bad, "start": "06:00", "end": "10:00"}])
        check(f"(8h) rate {label} is unreadable, vector stays finite",
              err is None and rate == [0.40] * 24, f"{err} {rate}")

    # 8i: the contract is total — no input of any type may raise.
    hostile = [
        [{"rate": [0.4], "start": "06:00", "end": "10:00"}],
        [{"rate": 0.4, "start": None, "end": None}],
        [{"rate": 0.4, "hours": []}],
        [{"rate": 0.4, "hours": [None, True]}],
        [{"rate": 0.4, "hours": "06:00"}],
        [{"rate": 0.4, "start": {"h": 6}, "end": [10]}],
        [{}],
        ["not a dict", 42, None],
        [{"rate": 0.4, "days": 7}],
    ]
    for i, w in enumerate(hostile):
        rate, _, _, err = _build(w)
        ok = err is None and isinstance(rate, list) and len(rate) == 24 \
            and all(isinstance(x, float) and x == x and abs(x) != float("inf") for x in rate)
        check(f"(8i) hostile input #{i} returns 24 finite floats, no raise", ok, str(err))

    # 8j: NO REGRESSION on the four flags that already existed — by equality.
    _, is_tou, flags, err = _build(
        [{"label": "flat", "rate": 0.40, "start": "00:00", "end": "24:00", "days": "all"}])
    check("(8j) bill_parser's flat window still fills all 24 and is unflagged",
          err is None and flags == [] and is_tou is True, f"{err} {flags}")

    _, _, flags, err = _build(
        [{"label": "peak", "rate": 0.55, "start": "07:00", "end": "21:00", "days": "weekdays"}])
    check("(8j) the weekday/weekend flag string is unchanged, character for character",
          flags == [FLAG_DAYS, FLAG_GAPS], str(flags))

    _, _, flags, err = _build(
        [{"label": "peak", "rate": 0.55, "start": "06:30", "end": "21:00", "days": "all"}])
    check("(8j) the rounded-to-the-hour flag string is unchanged",
          flags == [FLAG_ROUNDED, FLAG_GAPS], str(flags))

    _, is_tou, flags, err = _build(None)
    check("(8j) the no-TOU fallback flag string is unchanged",
          flags == [FLAG_FLAT] and is_tou is False, str(flags))

    # 8k: the two-window bill tariff, element by element, unchanged by 3.8b.
    rate, is_tou, flags, err = _build(
        [{"label": "peak", "rate": 0.60, "start": "07:00", "end": "21:00", "days": "all"},
         {"label": "offpeak", "rate": 0.20, "start": "21:00", "end": "07:00", "days": "all"}],
        flat=0.38)
    expected = [0.2] * 7 + [0.6] * 14 + [0.2] * 3
    check("(8k) the 2-window bill TOU vector is element-for-element unchanged",
          rate == expected and is_tou is True and flags == [], f"{rate} {flags}")


def t9_fallback_flag_condition() -> None:
    """3.12: the import_rate fallback flag fires ONLY when the defaulted scalar
    actually REACHED rate_24 — the tariff is flat, or _build_rate_24 filled at
    least one uncovered hour with it. A fallback flag that fires when the
    fallback priced nothing is noise that trains installers to ignore flags."""
    print("\nT9. the fallback flag fires ONLY when the fallback was used (3.12)")

    def resolve(windows):
        stored = {"job_id": "j1", "tariff_type": "tou", "supply_charge": 1.0,
                  "tou_windows": windows, "import_rate": None,
                  "fit_aud_per_kwh": 0.06, "export_limit_kw": 5.0,
                  "source": "installer"}
        stub = StubClient({"jobs": [], "tariffs": [stored], "bills": []})
        flags: list[str] = []
        t = sizing_route._resolve_tariff(stub, body_ns(job_id="j1"), "SA", "5000", flags)
        return t, flags

    # (9a) EVERY hour covered by windows: the defaulted scalar reaches nothing.
    # WHY IT MOVES: pre-3.12 the flag fired whenever the scalar was defaulted,
    # coverage or no coverage — observed live on job a57e13f1.
    full, flags_full = resolve([
        {"label": "peak", "rate": 0.35, "start": "07:00", "end": "21:00", "days": "all"},
        {"label": "offpeak", "rate": 0.20, "start": "21:00", "end": "07:00", "days": "all"},
    ])
    check("(9a) all 24 hours window-covered, no scalar anywhere: NO fallback flag",
          not any("import_rate fallback" in f for f in flags_full), str(flags_full))
    check("(9a) ...and rate_24 carries only window rates (the default reached nothing)",
          full["is_tou"] is True and set(full["rate_24"]) == {0.35, 0.20},
          str(sorted(set(full["rate_24"]))))
    check("(9a) ...while import_rate still RESOLVES to the default for reporting",
          full["import_rate"] == solar_optimiser_default(), str(full["import_rate"]))

    # (9b) PARTIAL coverage: the uncovered hours were filled with the default,
    # so the fallback genuinely priced hours and the flag must fire.
    part, flags_part = resolve([
        {"label": "peak", "rate": 0.35, "start": "07:00", "end": "21:00", "days": "all"},
    ])
    check("(9b) uncovered hours filled with the default: the flag FIRES",
          any("import_rate fallback" in f and "— is_fallback" in f for f in flags_part),
          str(flags_part))
    check("(9b) ...and the filled hour really is the default rate",
          part["rate_24"][23] == solar_optimiser_default(), str(part["rate_24"][23]))
    check("(9b) ...alongside the gap-fill flag naming what happened",
          FLAG_GAPS in flags_part, str(flags_part))

    # (9c) CONTROL — nothing stored at all: flat default everywhere, flag fires
    # (this is t5d's case, re-asserted beside its two new neighbours so the
    # three conditions read as one rule).
    stub = StubClient({"jobs": [], "tariffs": [], "bills": []})
    flags_none: list[str] = []
    sizing_route._resolve_tariff(stub, body_ns(job_id="j1"), "SA", "5000", flags_none)
    check("(9c) nothing stored: flat default everywhere, the flag still fires",
          any("import_rate fallback" in f for f in flags_none), str(flags_none))


def solar_optimiser_default() -> float:
    import solar_optimiser  # noqa: PLC0415
    return solar_optimiser.DEFAULT_IMPORT_RATE


def t10_supply_charge_source() -> None:
    """3.13 prompt 2 (G): the supply charge has its OWN provenance key.
    WHY THESE MOVE: pre-prompt-2 the resolver returns no supply_charge_source
    at all (every check fails on a missing key), and the annualiser borrowed
    `source` — which names where the IMPORT RATE came from — so the exact
    fixture shape below (a stored charge beside a NULL import rate) answered
    'default' about a number the installer typed."""
    print("\nT10. supply_charge_source — the charge's own provenance, "
          "never the import rate's")

    # (a) THE FIXTURE CASE THAT WAS WRONG: stored charge, NULL import rate.
    stored = {"job_id": "j1", "tariff_type": "tou", "supply_charge": 1.05,
              "tou_windows": [{"label": "peak", "rate": 0.45,
                               "start": "00:00", "end": "24:00", "days": "all"}],
              "import_rate": None, "fit_aud_per_kwh": 0.05,
              "export_limit_kw": 5.0, "source": "installer"}
    flags: list[str] = []
    t = sizing_route._resolve_tariff(
        StubClient({"tariffs": [stored], "bills": []}),
        body_ns(job_id="j1"), "SA", "5000", flags)
    check("(10a) stored charge + NULL import rate: supply_charge_source is "
          "'installer'...",
          t.get("supply_charge_source") == "installer",
          repr(t.get("supply_charge_source")))
    check("(10a) ...while `source` (the import rate's) is 'default' — the two "
          "keys provably answer DIFFERENT questions on this one row",
          t.get("import_rate_source") == "default"
          and t.get("supply_charge_source") != t.get("import_rate_source"),
          f"import_rate_source={t.get('import_rate_source')!r}")

    # (b) charge from the parsed bill's structured tariff.
    flags2: list[str] = []
    t2 = sizing_route._resolve_tariff(
        StubClient({"tariffs": [], "bills": [BILL_ROW]}),
        body_ns(job_id="j1"), "SA", "5000", flags2)
    check("(10b) charge from the bill's tariff_structured: "
          "supply_charge_source is 'bill'",
          t2.get("supply_charge") == 1.1
          and t2.get("supply_charge_source") == "bill",
          f"{t2.get('supply_charge')!r} / {t2.get('supply_charge_source')!r}")

    # (c) neither supplied it.
    flags3: list[str] = []
    t3 = sizing_route._resolve_tariff(
        StubClient({"tariffs": [], "bills": []}),
        body_ns(job_id="j1"), "SA", "5000", flags3)
    check("(10c) no stored row, no bill: supply_charge is None and "
          "supply_charge_source is 'not stated'",
          t3.get("supply_charge") is None
          and t3.get("supply_charge_source") == "not stated",
          f"{t3.get('supply_charge')!r} / {t3.get('supply_charge_source')!r}")

    # (d) the annualiser consumes the NEW key, not `source`.
    flags4: list[str] = []
    annual, src = sizing_route._annual_supply_charge(t, flags4)
    check("(10d) _annual_supply_charge reads supply_charge_source: "
          "1.05 $/day -> 383.25/yr labelled 'installer', never 'default'",
          annual == 383.25 and src == "installer",
          f"{annual!r} / {src!r}")
    # Every OTHER key keeps its name, type and value — the annualiser's
    # unknown branch is unchanged.
    flags5: list[str] = []
    annual3, src3 = sizing_route._annual_supply_charge(t3, flags5)
    check("(10d) the unknown branch is unchanged: None / 'not stated' / "
          "the supply_charge_unknown flag",
          annual3 is None and src3 == "not stated"
          and any(f.startswith("supply_charge_unknown") for f in flags5),
          f"{annual3!r} / {src3!r} / {flags5}")


def t11_per_field_provenance() -> None:
    """3.13 prompt 4b: every value carries its OWN provenance, set where it is
    read. WHY THESE MOVE: pre-4b one `source` flag was assigned only when the
    SCALAR resolved, so a job with stored TOU windows and no scalar read
    "default" against the installer's own typed rates — the defect Mayur
    found on screen, third of its kind."""
    print("\nT11. per-field provenance — the vector, the type and the fit "
          "each carry their own source")

    # (a) THE DEFECT SHAPE: stored windows, NULL scalar, stored fit.
    stored_tou = {"job_id": "j1", "tariff_type": "tou", "supply_charge": 1.05,
                  "tou_windows": [
                      {"label": "peak", "rate": 0.55, "start": "17:00", "end": "21:00", "days": "all"},
                      {"label": "offpeak", "rate": 0.20, "start": "21:00", "end": "07:00", "days": "all"},
                      {"label": "shoulder", "rate": 0.35, "start": "07:00", "end": "17:00", "days": "all"}],
                  "import_rate": None, "fit_aud_per_kwh": 0.05,
                  "export_limit_kw": 5.0, "source": "installer"}
    flags: list[str] = []
    t = sizing_route._resolve_tariff(
        StubClient({"tariffs": [stored_tou], "bills": []}),
        body_ns(job_id="j1"), "SA", "5000", flags)
    check("(11a) stored windows + NULL scalar: rate_24_source 'installer' — "
          "the installer's typed rates are never labelled 'default'",
          t["rate_24_source"] == "installer", repr(t["rate_24_source"]))
    check("(11a) ...while import_rate_source is 'default' (the scalar "
          "genuinely defaulted) — the two answer different questions",
          t["import_rate_source"] == "default", repr(t["import_rate_source"]))
    check("(11a) tariff_type_source 'installer'",
          t["tariff_type_source"] == "installer", repr(t["tariff_type_source"]))
    check("(11a) fit_source 'installer' (fit_aud_per_kwh stored on the row) "
          "and fit_is_fallback False, unchanged",
          t["fit_source"] == "installer" and t["fit_is_fallback"] is False,
          f"{t['fit_source']!r}/{t['fit_is_fallback']!r}")

    # (b) the flat installer scalar (the 456e0242 shape): the vector IS the
    # scalar tiled, so it carries the scalar's provenance.
    stored_flat = {"job_id": "j1", "tariff_type": "flat", "supply_charge": None,
                   "tou_windows": None, "import_rate": 0.42,
                   "fit_aud_per_kwh": 0.05, "export_limit_kw": None,
                   "source": "installer"}
    t2 = sizing_route._resolve_tariff(
        StubClient({"tariffs": [stored_flat], "bills": []}),
        body_ns(job_id="j1"), "SA", "5000", [])
    check("(11b) flat stored scalar: rate_24_source 'installer' (the flat "
          "vector is the installer's scalar tiled)",
          t2["rate_24_source"] == "installer" and t2["import_rate_source"] == "installer",
          f"{t2['rate_24_source']!r}/{t2['import_rate_source']!r}")

    # (c) nothing anywhere: default scalar priced every hour -> 'default';
    # nothing supplied the type -> 'not stated', never 'default'.
    t3 = sizing_route._resolve_tariff(
        StubClient({"tariffs": [], "bills": []}),
        body_ns(job_id="j1"), "SA", "5000", [])
    check("(11c) nothing stored: rate_24_source and fit_source 'default', "
          "tariff_type_source 'not stated' — an unknown origin is never "
          "claimed as a default",
          t3["rate_24_source"] == "default" and t3["fit_source"] == "default"
          and t3["tariff_type_source"] == "not stated",
          f"{t3['rate_24_source']!r}/{t3['fit_source']!r}/{t3['tariff_type_source']!r}")

    # (d) request windows beat everything.
    t4 = sizing_route._resolve_tariff(
        StubClient({"tariffs": [stored_tou], "bills": []}),
        body_ns(job_id="j1", tou_windows=[{"label": "peak", "rate": 0.9,
                                           "start": "00:00", "end": "24:00",
                                           "days": "all"}]),
        "SA", "5000", [])
    check("(11d) request windows: rate_24_source 'request'",
          t4["rate_24_source"] == "request", repr(t4["rate_24_source"]))


def main() -> int:
    print("verify_tariff_contract.py — 3.8 prompt 1 (writes nothing)\n")
    t1_structure()
    t2_round_trip()
    t4_no_regression()
    t5_resolution_order()
    t6_days_flag()
    t7_endpoint()
    t8_never_raises()
    t9_fallback_flag_condition()
    t10_supply_charge_source()
    t11_per_field_provenance()
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
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
