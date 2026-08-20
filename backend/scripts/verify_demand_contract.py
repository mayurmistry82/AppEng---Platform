#!/usr/bin/env python3
"""
verify_demand_contract.py — proves the 3.6 prompt-1 demand write path: auth +
ownership on all three endpoints, the re-upload update fix, the one-writer
tier mirror (and that it can go DOWN), capture-allowlist reality, never-500
degradation, and the parse-failure shapes.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_demand_contract.py [--live]

Use the interpreter the BACKEND runs under, never bare `python3` (F91).

Default run is OFFLINE: no network, no database. The Supabase client is a
stateful stub with a call recorder (the same seam style as
verify_roof_contract.py — module-level client factories are swapped out), and
bill_parser.parse_bill is monkeypatched where a real parse would call Claude.
NEM12 fixtures are GENERATED here, never committed.

`--live` performs the ONE authorised production pass on job
6b804157-b271-4586-9da9-2429e84d87e4 (A. Chen, path E): 1 interval_data row,
1 bills pair (L1, deleted), 1 surveys row (none — no survey sent), 1
load_profiles row, and that job's accuracy_tier/confidence_pct — then cleans
up and re-asserts every count it read at the start.
"""
from __future__ import annotations

import asyncio
import copy
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import inspect  # noqa: E402

from fastapi import HTTPException, UploadFile  # noqa: E402
from fastapi.params import Depends as DependsParam  # noqa: E402

import auth  # noqa: E402
import bill_parser  # noqa: E402
import capture  # noqa: E402
import interval_parser  # noqa: E402
import job_tier  # noqa: E402
import solar_optimiser  # noqa: E402
from routes import demand  # noqa: E402
from routes import interval  # noqa: E402
from routes import load as load_route  # noqa: E402
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


CALLER = auth.Caller(user_id="user-1", email="u@example.com", company_id="co-1", role="owner")
MY_JOB = {"job_id": "j1", "company_id": "co-1"}


# ── Stateful stub Supabase client with a call recorder ───────────────────────
class _Result:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _Query:
    def __init__(self, client, table):
        self._c = client
        self._t = table
        self._filters: list[tuple[str, object]] = []
        self._op: str = "select"
        self._payload = None
        self._on_conflict = None

    def select(self, *_a, **_k):
        return self

    def eq(self, key, value):
        self._filters.append((key, value))
        return self

    def is_(self, key, _value):
        self._filters.append((key, None))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def insert(self, row):
        self._op, self._payload = "insert", row
        return self

    def update(self, row):
        self._op, self._payload = "update", row
        return self

    def upsert(self, row, on_conflict=None):
        self._op, self._payload, self._on_conflict = "upsert", row, on_conflict
        return self

    def delete(self):
        self._op = "delete"
        return self

    def _match(self, row):
        return all(row.get(k) == v for k, v in self._filters)

    def execute(self):
        if (self._t, self._op) in self._c.raise_on:
            raise OSError(35, f"stubbed failure on {self._t}.{self._op}")
        rows = self._c.tables.setdefault(self._t, [])
        self._c.calls.append((self._t, self._op, self._payload, list(self._filters)))
        if self._op == "select":
            return _Result([dict(r) for r in rows if self._match(r)])
        if self._op == "insert":
            rows.append(dict(self._payload))
            return _Result([dict(self._payload)])
        if self._op == "update":
            for r in rows:
                if self._match(r):
                    r.update(self._payload)
            return _Result([dict(r) for r in rows if self._match(r)])
        if self._op == "upsert":
            row = dict(self._payload)
            pk = capture._PK.get(self._t)
            if pk and pk not in row:
                self._c.pk_seq += 1
                row[pk] = f"{self._t}-pk-{self._c.pk_seq}"
            key = self._on_conflict
            replaced = False
            if key and row.get(key) is not None:
                for i, r in enumerate(rows):
                    if r.get(key) == row.get(key):
                        merged = {**r, **row}
                        rows[i] = merged
                        row = merged
                        replaced = True
                        break
            if not replaced:
                rows.append(row)
            return _Result([dict(row)])
        if self._op == "delete":
            kept = [r for r in rows if not self._match(r)]
            removed = [r for r in rows if self._match(r)]
            self._c.tables[self._t] = kept
            return _Result(removed)
        raise AssertionError(f"unknown op {self._op}")


class _StorageBucket:
    def __init__(self, client, bucket):
        self._c = client
        self._b = bucket

    def upload(self, key, data, _opts=None):
        if self._c.raise_storage:
            raise OSError(35, "stubbed storage failure")
        self._c.uploads.append((self._b, key, len(data)))
        return {"Key": key}


class _Storage:
    def __init__(self, client):
        self._c = client

    def from_(self, bucket):
        return _StorageBucket(self._c, bucket)


class StubClient:
    """Stateful tables + full call recorder. Filters actually apply."""

    def __init__(self, jobs_rows=None):
        self.tables: dict[str, list[dict]] = {"jobs": [dict(r) for r in (jobs_rows or [])]}
        self.calls: list[tuple] = []
        self.uploads: list[tuple] = []
        self.raise_on: set[tuple[str, str]] = set()
        self.raise_storage = False
        self.pk_seq = 0
        self.storage = _Storage(self)

    def table(self, name):
        return _Query(self, name)

    def jobs_updates(self):
        return [p for (t, op, p, _f) in self.calls if t == "jobs" and op == "update"]

    def ops(self, table, op):
        return [p for (t, o, p, _f) in self.calls if t == table and o == op]


def _run(coro):
    return asyncio.run(coro)


def _upload_file(data: bytes, name: str = "meter.csv") -> UploadFile:
    return UploadFile(io.BytesIO(data), filename=name)


def _patch(stub):
    """Point every client seam at the stub. Returns the restore closure."""
    saved = (demand._client, interval._client, capture._get_client)
    demand._client = lambda: stub
    interval._client = lambda: stub
    capture._get_client = lambda: stub
    def restore():
        demand._client, interval._client, capture._get_client = saved
    return restore


# ── NEM12 generator — fixtures are BUILT, never committed ────────────────────
def make_nem12(days: int, nmi: str = "6001234567",
               start: dt.date = dt.date(2025, 1, 1), daily_kwh: float = 24.0) -> bytes:
    """Valid NEM12: 100 header, one E1 200-block (30-min, KWH), `days` 300-rows
    of 48 actual ('A') reads, 900 footer."""
    lines = ["100,NEM12,200506081149,UNITEDDP,NEMMCO"]
    lines.append(f"200,{nmi},E1,1,E1,N1,METSER123,KWH,30,")
    vals = ",".join(f"{daily_kwh / 48.0:.4f}" for _ in range(48))
    for i in range(days):
        d = start + dt.timedelta(days=i)
        lines.append(f"300,{d.strftime('%Y%m%d')},{vals},A,,,20250101120000,")
    lines.append("900")
    return ("\n".join(lines) + "\n").encode()


FULL_SURVEY = dict(
    annual_kwh=4000.0, household_size="3-4", hot_water="electric_storage",
    appliances=["ev", "pool_pump"], occupancy="away_weekdays", tariff_type="tou",
    occupancy_grid=[[1] * 24 for _ in range(7)],
)

BILL_PARSE_FIXTURE = {
    "billing_period_days": 91, "billing_period_start": "2026-05-01",
    "billing_period_end": "2026-07-30", "total_kwh": 1150.0, "daily_avg_kwh": 12.6,
    "tariff_rate": 0.32, "feed_in_tariff": 0.05, "annual_spend": 2100.0,
    "retailer": "AGL", "plan_name": "Value Saver", "historical_usage": [],
    "has_solar": False, "nmi": "6001234567", "daily_supply_charge": 1.12,
    "tariff_structured": {"tariff_type": "single_rate"}, "parse_confidence": {"total_kwh": 0.9},
    "field_provenance": {}, "parser_version": "test-fixture-v1",
}


# ── Offline checks ───────────────────────────────────────────────────────────
def t1_signatures() -> None:
    print("1. auth + signature contract (inspected, never grepped)")
    for fn, label in ((interval.upload_interval, "interval/upload"),
                      (demand.upload_job_bill, "job/{id}/bill"),
                      (demand.characterise_demand, "job/{id}/demand")):
        param = inspect.signature(fn).parameters.get("caller")
        dep_ok = (
            param is not None
            and isinstance(param.default, DependsParam)
            and param.default.dependency is auth.require_company
        )
        check(f"(1) {label} depends on require_company", dep_ok,
              f"default={getattr(param, 'default', None)!r}")
    params = inspect.signature(interval.upload_interval).parameters
    check("(3) installer_id is no longer a parameter of upload_interval",
          "installer_id" not in params, str(list(params)))


def t2_ownership() -> None:
    print("\n2. ownership — identical 404s, 503 when unknowable (F88)")
    absent = StubClient(jobs_rows=[])
    exc_absent = None
    try:
        demand.require_company_job(absent, "jX", "co-1")
    except HTTPException as exc:
        exc_absent = exc
    check("(4) absent job -> 404", exc_absent is not None and exc_absent.status_code == 404)

    foreign = StubClient(jobs_rows=[{"job_id": "jX", "company_id": "co-OTHER"}])
    exc_foreign = None
    try:
        demand.require_company_job(foreign, "jX", "co-1")
    except HTTPException as exc:
        exc_foreign = exc
    check("(4) foreign job -> 404", exc_foreign is not None and exc_foreign.status_code == 404)
    check("(4) the two 404 details are IDENTICAL strings — existence never leaks",
          exc_absent is not None and exc_foreign is not None
          and exc_absent.detail == exc_foreign.detail,
          f"{getattr(exc_absent, 'detail', None)!r} vs {getattr(exc_foreign, 'detail', None)!r}")

    raising = StubClient(jobs_rows=[dict(MY_JOB)])
    raising.raise_on.add(("jobs", "select"))
    exc_503 = None
    try:
        demand.require_company_job(raising, "j1", "co-1")
    except HTTPException as exc:
        exc_503 = exc
    check("(4) lookup RAISES -> 503, never 404/200",
          exc_503 is not None and exc_503.status_code == 503
          and exc_503.detail == "Job lookup temporarily unavailable",
          str(getattr(exc_503, "detail", None)))
    exc_none = None
    try:
        demand.require_company_job(None, "j1", "co-1")
    except HTTPException as exc:
        exc_none = exc
    check("(4) no client at all -> 503", exc_none is not None and exc_none.status_code == 503)

    # Wiring: each ENDPOINT actually consults it (foreign job -> 404 before any work).
    for label, call in (
        ("interval/upload", lambda s: interval.upload_interval(
            file=_upload_file(make_nem12(3)), job_id="jX",
            include_controlled_load=False, caller=CALLER)),
        ("job/{id}/bill", lambda s: demand.upload_job_bill(
            "jX", file=_upload_file(b"x", "b.pdf"), caller=CALLER)),
        ("job/{id}/demand", lambda s: demand.characterise_demand(
            "jX", load_route.LoadCharacteriseRequest(annual_kwh=4000.0), CALLER)),
    ):
        stub = StubClient(jobs_rows=[{"job_id": "jX", "company_id": "co-OTHER"}])
        restore = _patch(stub)
        try:
            raised = None
            try:
                _run(call(stub))
            except HTTPException as exc:
                raised = exc
            check(f"(4) {label} rejects a foreign job with 404",
                  raised is not None and raised.status_code == 404,
                  f"got {getattr(raised, 'status_code', None)}")
            check(f"(4) {label} wrote NOTHING for the foreign job",
                  not [c for c in stub.calls if c[1] in ("insert", "update", "upsert")]
                  and stub.uploads == [], str(stub.calls))
        finally:
            restore()


def t3_reupload() -> None:
    print("\n3. re-upload updates the row — fault (f)")
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        first = _run(interval.upload_interval(
            file=_upload_file(make_nem12(30, start=dt.date(2025, 1, 1))),
            job_id="j1", include_controlled_load=False, caller=CALLER))
        check("(5) first upload ok + persisted", first.get("ok") is True
              and first.get("persisted") is True, str(first.get("flags")))
        check("(5) first upload INSERTED (zero updates so far)",
              len(stub.ops("interval_data", "insert")) == 1
              and len(stub.ops("interval_data", "update")) == 0)
        ref1 = first.get("parsed_series_ref")

        second = _run(interval.upload_interval(
            file=_upload_file(make_nem12(45, start=dt.date(2025, 3, 1))),
            job_id="j1", include_controlled_load=False, caller=CALLER))
        updates = stub.ops("interval_data", "update")
        # WHY THIS CHANGES WHEN THE FAULT IS PRESENT: the old code returned
        # early before any write, so this recorder saw ZERO update calls; the
        # fix records exactly one, carrying the NEW parsed_series_ref.
        check("(5) second upload for the same (job, nmi) recorded ONE update",
              len(updates) == 1, f"{len(updates)} updates")
        check("(5) the update carries the NEW parsed_series_ref",
              bool(updates) and updates[0].get("parsed_series_ref")
              == second.get("parsed_series_ref")
              and updates[0].get("parsed_series_ref") != ref1,
              str(updates[:1]))
        check("(5) still exactly one interval_data row for the pair",
              len(stub.tables.get("interval_data", [])) == 1,
              f"{len(stub.tables.get('interval_data', []))} rows")
        check("(5) the stored row's period_end moved to the new file",
              stub.tables["interval_data"][0].get("period_end") == "2025-04-14",
              str(stub.tables["interval_data"][0].get("period_end")))
    finally:
        restore()


def t4_tier_sync() -> None:
    print("\n4. sync_job_tier — the one writer, and the number can go DOWN")
    stub = StubClient(jobs_rows=[{**MY_JOB, "accuracy_tier": 3, "confidence_pct": 92}])
    stub.tables["load_profiles"] = [{"job_id": "j1", "accuracy_tier": 1, "confidence_pct": 65}]
    tier, err = job_tier.sync_job_tier(stub, "j1")
    updates = stub.jobs_updates()
    # WHY THIS CHANGES WHEN THE FAULT IS PRESENT: the old code only ever wrote
    # the literal 3; the assertion is on the WRITTEN VALUE being 1, which no
    # monotonic implementation can produce.
    check("(6) writes the LOWER tier 1 over a stored 3",
          tier == 1 and err is None and len(updates) == 1
          and updates[0].get("accuracy_tier") == 1,
          f"tier={tier} err={err} updates={updates}")
    check("(6) confidence_pct mirrored alongside",
          bool(updates) and updates[0].get("confidence_pct") == 65, str(updates))

    empty = StubClient(jobs_rows=[{**MY_JOB, "accuracy_tier": 3}])
    tier2, err2 = job_tier.sync_job_tier(empty, "j1")
    check("(7) NO load_profiles row -> zero updates, returns (None, None)",
          tier2 is None and err2 is None and empty.jobs_updates() == [],
          f"tier={tier2} err={err2} updates={empty.jobs_updates()}")

    broken = StubClient(jobs_rows=[dict(MY_JOB)])
    broken.tables["load_profiles"] = [{"job_id": "j1", "accuracy_tier": 2, "confidence_pct": 82}]
    broken.raise_on.add(("jobs", "update"))
    tier3, err3 = job_tier.sync_job_tier(broken, "j1")
    check("(7b) a raising client -> (None, error string), never a raise",
          tier3 is None and isinstance(err3, str) and err3, f"tier={tier3} err={err3}")


def t5_source_scan() -> None:
    print("\n5. tier arithmetic is not duplicated in demand.py")
    src = open(os.path.join(BACKEND_DIR, "routes", "demand.py")).read()
    check("(8) no literal 92 / 82 / 65 in routes/demand.py",
          re.search(r"\b(92|82|65)\b", src) is None)
    check("(8) no literal accuracy_tier constant in routes/demand.py",
          re.search(r"accuracy_tier[\"']?\s*[:=]\s*\d", src) is None)


def t6_demand_tiers() -> None:
    print("\n6. /demand tier paths — the ROW carries the tier, not just the response")
    cases = [
        ("interval_profile present -> tier 3",
         dict(interval_profile={"hourly_profile_weights": [1.0] * 24,
                                "annual_kwh": 5000.0, "daily_avg_kwh": 13.7}), 3),
        ("complete survey, no interval -> tier 2", dict(FULL_SURVEY), 2),
        ("neither -> tier 1", dict(annual_kwh=4000.0), 1),
    ]
    for label, body_kwargs, expected in cases:
        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        restore = _patch(stub)
        try:
            resp = _run(demand.characterise_demand(
                "j1", load_route.LoadCharacteriseRequest(**body_kwargs), CALLER))
            lp_upserts = stub.ops("load_profiles", "upsert")
            check(f"(9) {label} in the response",
                  resp.get("accuracy_tier") == expected
                  and resp.get("accuracy_tier_written") == expected,
                  f"resp tier={resp.get('accuracy_tier')} written={resp.get('accuracy_tier_written')}")
            check(f"(9) {label} in the RECORDED load_profiles row",
                  bool(lp_upserts) and lp_upserts[-1].get("accuracy_tier") == expected,
                  str(lp_upserts[-1:] or None))
            check(f"(9) {label}: jobs mirror written",
                  bool(stub.jobs_updates())
                  and stub.jobs_updates()[-1].get("accuracy_tier") == expected,
                  str(stub.jobs_updates()))
        finally:
            restore()

    print("\n   fall-back-a-tier end to end (10)")
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        up = _run(interval.upload_interval(
            file=_upload_file(make_nem12(30)), job_id="j1",
            include_controlled_load=False, caller=CALLER))
        check("(10) NEM12 upload lifted the job to 3",
              up.get("accuracy_tier_written") == 3
              and stub.jobs_updates()[-1].get("accuracy_tier") == 3,
              f"written={up.get('accuracy_tier_written')} updates={stub.jobs_updates()}")
        down = _run(demand.characterise_demand(
            "j1", load_route.LoadCharacteriseRequest(annual_kwh=4000.0), CALLER))
        check("(10) then /demand with nothing -> FINAL jobs update writes tier 1",
              down.get("accuracy_tier_written") == 1
              and stub.jobs_updates()[-1].get("accuracy_tier") == 1,
              f"written={down.get('accuracy_tier_written')} final={stub.jobs_updates()[-1:]}")
        check("(10) exactly one load_profiles row remains (replaced, not stacked)",
              len(stub.tables.get("load_profiles", [])) == 1,
              f"{len(stub.tables.get('load_profiles', []))} rows")
    finally:
        restore()


def t7_allowlists() -> None:
    print("\n7. capture allowlist reality — asserted against capture._ALLOWED itself")
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    raw_payloads: dict[str, dict] = {}
    saved_survey, saved_lp, saved_bill = (
        capture.save_survey, capture.save_load_profile, capture.save_bill)
    capture.save_survey = lambda p: raw_payloads.__setitem__("surveys", dict(p)) or saved_survey(p)
    capture.save_load_profile = (
        lambda p: raw_payloads.__setitem__("load_profiles", dict(p)) or saved_lp(p))
    capture.save_bill = lambda p: raw_payloads.__setitem__("bills", dict(p)) or saved_bill(p)
    saved_parse = bill_parser.parse_bill
    bill_parser.parse_bill = lambda _path: dict(BILL_PARSE_FIXTURE)
    try:
        _run(demand.characterise_demand(
            "j1", load_route.LoadCharacteriseRequest(**FULL_SURVEY), CALLER))
        survey_keys = set(raw_payloads["surveys"]) - {"job_id"}
        check("(11) survey payload keys ⊆ capture._ALLOWED['surveys'] — none dropped",
              survey_keys <= capture._ALLOWED["surveys"],
              f"outside allowlist: {sorted(survey_keys - capture._ALLOWED['surveys'])}")
        check("(11) survey payload carries the mapped answers",
              {"household_size", "occupancy_pattern", "hot_water_type", "has_ev",
               "has_pool", "occupancy_grid", "daytime_home_frac"} <= set(raw_payloads["surveys"]),
              str(sorted(raw_payloads["surveys"])))
        lp_keys = set(raw_payloads["load_profiles"]) - {"job_id"}
        check("(11) load_profiles payload keys ⊆ allowlist — none dropped",
              lp_keys <= capture._ALLOWED["load_profiles"],
              f"outside allowlist: {sorted(lp_keys - capture._ALLOWED['load_profiles'])}")

        _run(demand.upload_job_bill("j1", file=_upload_file(b"pdf", "b.pdf"), caller=CALLER))
        stored_bill_rows = stub.ops("bills", "upsert")
        check("(11) the PERSISTED bills row uses only allowlisted keys",
              bool(stored_bill_rows)
              and set(stored_bill_rows[-1]) <= capture._ALLOWED["bills"] | {"bill_id"},
              str(sorted(set(stored_bill_rows[-1]) - capture._ALLOWED["bills"]))
              if stored_bill_rows else "no bills upsert recorded")
        check("(11) the parser's allowlisted fields SURVIVED the filter",
              bool(stored_bill_rows)
              and {"total_kwh", "retailer", "nmi", "parser_version", "parse_confidence",
                   "parsed_json", "raw_file_path", "job_id"} <= set(stored_bill_rows[-1]),
              str(sorted(stored_bill_rows[-1])) if stored_bill_rows else "none")
    finally:
        capture.save_survey, capture.save_load_profile, capture.save_bill = (
            saved_survey, saved_lp, saved_bill)
        bill_parser.parse_bill = saved_parse
        restore()


def t8_never500() -> None:
    print("\n8. never-500 degradation — each failure surfaces, none blocks")
    saved_parse = bill_parser.parse_bill
    bill_parser.parse_bill = lambda _path: dict(BILL_PARSE_FIXTURE)
    try:
        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        stub.raise_storage = True
        restore = _patch(stub)
        try:
            resp = _run(demand.upload_job_bill("j1", file=_upload_file(b"pdf", "b.pdf"),
                                               caller=CALLER))
            check("(12) storage raises -> bill 200, raw_file_path null, warning",
                  resp.get("ok") is True and resp.get("raw_file_path") is None
                  and isinstance(resp.get("warning"), str) and resp["warning"],
                  str(resp.get("warning")))
        finally:
            restore()

        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        stub.raise_on.add(("bills", "upsert"))
        restore = _patch(stub)
        try:
            resp = _run(demand.upload_job_bill("j1", file=_upload_file(b"pdf", "b.pdf"),
                                               caller=CALLER))
            check("(12) capture raises -> bill 200, persisted false, warning",
                  resp.get("ok") is True and resp.get("persisted") is False
                  and resp.get("bill_id") is None and resp.get("warning"),
                  str(resp))
        finally:
            restore()

        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        stub.raise_on.add(("load_profiles", "upsert"))
        stub.raise_on.add(("load_profiles", "select"))
        restore = _patch(stub)
        try:
            resp = _run(demand.characterise_demand(
                "j1", load_route.LoadCharacteriseRequest(annual_kwh=4000.0), CALLER))
            check("(12) capture raises -> demand 200, load_profile_saved false, warning",
                  resp.get("load_profile_saved") is False and resp.get("warnings"),
                  str(resp.get("warnings")))
        finally:
            restore()

        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        stub.raise_on.add(("jobs", "update"))
        restore = _patch(stub)
        try:
            resp = _run(demand.characterise_demand(
                "j1", load_route.LoadCharacteriseRequest(annual_kwh=4000.0), CALLER))
            check("(12) tier sync raises -> demand 200, tier warning surfaced",
                  resp.get("accuracy_tier_written") is None
                  and any("tier" in w.lower() for w in resp.get("warnings", [])),
                  str(resp.get("warnings")))
        finally:
            restore()

        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        stub.raise_storage = True
        restore = _patch(stub)
        try:
            resp = _run(interval.upload_interval(
                file=_upload_file(make_nem12(10)), job_id="j1",
                include_controlled_load=False, caller=CALLER))
            check("(12) storage raises -> interval 200, persisted false, flagged",
                  resp.get("ok") is True and resp.get("persisted") is False
                  and any("not fully saved" in f for f in resp.get("flags", [])),
                  str(resp.get("flags")))
        finally:
            restore()
    finally:
        bill_parser.parse_bill = saved_parse


def t9_http_shapes() -> None:
    print("\n9. HTTP-level shapes via TestClient (dependency overridden, clients stubbed)")
    from fastapi.testclient import TestClient
    import main

    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    saved_parse = bill_parser.parse_bill

    def _raise(_path):
        raise ValueError("unreadable test bill")

    bill_parser.parse_bill = _raise
    main.app.dependency_overrides[auth.require_company] = lambda: CALLER
    try:
        tc = TestClient(main.app)
        r = tc.post("/api/interval/upload", files={"file": ("m.csv", b"junk,junk", "text/csv")})
        check("(2) upload without job_id -> 422 validation error", r.status_code == 422,
              f"{r.status_code}: {r.text[:120]}")

        r = tc.post("/api/interval/upload",
                    files={"file": ("m.csv", b"total,garbage\n1,2", "text/csv")},
                    data={"job_id": "j1"})
        check("(13) junk interval file -> HTTP 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("(13) ...ok:false + suggest_tier2_fallback:true",
              body.get("ok") is False and body.get("suggest_tier2_fallback") is True,
              str(body))

        r = tc.post("/api/job/j1/bill", files={"file": ("b.pdf", b"junk", "application/pdf")})
        check("(13) junk bill -> HTTP 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("(13) ...ok:false + suggest_manual_correction:true",
              body.get("ok") is False and body.get("suggest_manual_correction") is True,
              str(body))
    finally:
        main.app.dependency_overrides.pop(auth.require_company, None)
        bill_parser.parse_bill = saved_parse
        restore()


def t10_annualise_boundary() -> None:
    print("\n10. NEM12 annualise boundary — the constant read from the module")
    src = inspect.getsource(interval_parser)
    m = re.search(r"annualised = coverage_days < (\d+)", src)
    check("(14) the annualise threshold is findable in interval_parser.py", m is not None)
    if not m:
        return
    threshold = int(m.group(1))
    below = interval_parser.parse_interval_file(
        "m.csv", make_nem12(threshold - 1), False)
    check(f"(14) {threshold - 1} days -> annualised true",
          below.get("ok") is True and below.get("annualised") is True,
          str(below.get("annualised")))
    check("(14) ...with a months flag in flags",
          any("month" in f for f in below.get("flags", [])), str(below.get("flags")))
    at = interval_parser.parse_interval_file("m.csv", make_nem12(threshold), False)
    check(f"(14) {threshold} days -> annualised false",
          at.get("ok") is True and at.get("annualised") is False,
          str(at.get("annualised")))


# ── Live pass (--live) — the ONE authorised production write set ─────────────
LIVE_JOB = "6b804157-b271-4586-9da9-2429e84d87e4"
LIVE_CALLER = auth.Caller(
    user_id="8e496f09-d1b8-47a3-9d53-3f09ed389b34",
    email="info@enrgengine.com",
    company_id="f1b9a202-9fd0-41a9-aa66-4f74688619b7",
    role="owner",
)
_COUNT_TABLES = ["companies", "company_members", "jobs", "roof_geometry",
                 "interval_data", "bills", "surveys", "load_profiles"]


def _counts(client) -> dict:
    out = {}
    for t in _COUNT_TABLES:
        res = client.table(t).select("*", count="exact").limit(1).execute()
        out[t] = res.count
    return out


def t_live() -> None:
    print("\nLIVE — job 6b804157 (A. Chen) only; every write cleaned up after")
    client = demand._client()
    if client is None:
        check("(L0) live Supabase client available", False, "env not configured")
        return

    start_counts = _counts(client)
    before_job = client.table("jobs").select(
        "accuracy_tier, confidence_pct").eq("job_id", LIVE_JOB).execute().data[0]
    print(f"        start counts: {start_counts}")
    print(f"        job tier before: {before_job}")
    storage_keys: list[str] = []

    try:
        # L1 — bills upsert reality: no bill_id supplied + on_conflict=bill_id
        # + no UNIQUE on job_id => two inserts, two distinct rows.
        b1 = capture.save_bill({"job_id": LIVE_JOB, "retailer": "verify-L1", "total_kwh": 1.0})
        b2 = capture.save_bill({"job_id": LIVE_JOB, "retailer": "verify-L1", "total_kwh": 2.0})
        rows = client.table("bills").select("bill_id").eq("job_id", LIVE_JOB).execute().data
        check("(L1) two saves -> two DISTINCT bill_ids",
              b1 and b2 and b1 != b2, f"{b1} / {b2}")
        check("(L1) two rows in the real table", len(rows) == 2, f"{len(rows)} rows")
        for bid in (b1, b2):
            if bid:
                client.table("bills").delete().eq("bill_id", bid).execute()
        left = client.table("bills").select("bill_id").eq("job_id", LIVE_JOB).execute().data
        check("(L1) both deleted", len(left) == 0, f"{len(left)} left")

        # L2 — the tier round trip on the real database (UT-5).
        up = _run(interval.upload_interval(
            file=_upload_file(make_nem12(30, start=dt.date(2025, 1, 1))),
            job_id=LIVE_JOB, include_controlled_load=False, caller=LIVE_CALLER))
        for ref in (up.get("raw_file_path"), up.get("parsed_series_ref")):
            if ref:
                storage_keys.append(ref.split("/", 1)[1])
        check("(L2) upload ok + persisted + tier written 3",
              up.get("ok") is True and up.get("persisted") is True
              and up.get("accuracy_tier_written") == 3, str(up.get("flags")))
        n_rows = client.table("interval_data").select(
            "interval_id").eq("job_id", LIVE_JOB).execute().data
        tier_now = client.table("jobs").select(
            "accuracy_tier, confidence_pct").eq("job_id", LIVE_JOB).execute().data[0]
        check("(L2) one interval_data row; jobs.accuracy_tier reads 3",
              len(n_rows) == 1 and tier_now.get("accuracy_tier") == 3,
              f"rows={len(n_rows)} tier={tier_now}")
        down = _run(demand.characterise_demand(
            LIVE_JOB, load_route.LoadCharacteriseRequest(annual_kwh=4000.0), LIVE_CALLER))
        tier_after = client.table("jobs").select(
            "accuracy_tier, confidence_pct").eq("job_id", LIVE_JOB).execute().data[0]
        check("(L2) /demand with nothing -> jobs.accuracy_tier reads 1 (the number went DOWN)",
              down.get("accuracy_tier_written") == 1 and tier_after.get("accuracy_tier") == 1,
              f"written={down.get('accuracy_tier_written')} job={tier_after}")

        # L3 — re-upload same NMI, different period: refs change, count stays 1.
        row_before = client.table("interval_data").select(
            "parsed_series_ref, period_end").eq("job_id", LIVE_JOB).execute().data[0]
        up2 = _run(interval.upload_interval(
            file=_upload_file(make_nem12(45, start=dt.date(2025, 3, 1))),
            job_id=LIVE_JOB, include_controlled_load=False, caller=LIVE_CALLER))
        for ref in (up2.get("raw_file_path"), up2.get("parsed_series_ref")):
            if ref:
                storage_keys.append(ref.split("/", 1)[1])
        rows_after = client.table("interval_data").select(
            "parsed_series_ref, period_end").eq("job_id", LIVE_JOB).execute().data
        check("(L3) still exactly one row", len(rows_after) == 1, f"{len(rows_after)}")
        check("(L3) parsed_series_ref CHANGED",
              rows_after and rows_after[0]["parsed_series_ref"] != row_before["parsed_series_ref"]
              and rows_after[0]["parsed_series_ref"] == up2.get("parsed_series_ref"),
              f"{row_before['parsed_series_ref']} -> {rows_after[0]['parsed_series_ref'] if rows_after else None}")
        # period_end is timestamptz in the real table — PostgREST returns a full
        # ISO timestamp, so compare on the date prefix, not string equality.
        check("(L3) period_end CHANGED to the new file's",
              bool(rows_after)
              and str(rows_after[0]["period_end"]).startswith("2025-04-14")
              and str(row_before["period_end"]).startswith("2025-01-30"),
              f"{row_before['period_end']} -> {rows_after[0]['period_end'] if rows_after else None}")
    finally:
        # CLEANUP — delete the pass's child rows, restore the tier EXACTLY as
        # found, remove the uploaded Storage objects, re-assert every count.
        print("\n   live cleanup")
        for t in ("interval_data", "load_profiles", "surveys"):
            try:
                client.table(t).delete().eq("job_id", LIVE_JOB).execute()
            except Exception as exc:  # noqa: BLE001
                check(f"(cleanup) delete {t}", False, str(exc))
        try:
            client.table("jobs").update(
                {"accuracy_tier": before_job.get("accuracy_tier"),
                 "confidence_pct": before_job.get("confidence_pct")}
            ).eq("job_id", LIVE_JOB).execute()
        except Exception as exc:  # noqa: BLE001
            check("(cleanup) restore job tier", False, str(exc))
        if storage_keys:
            try:
                client.storage.from_("bills").remove(storage_keys)
            except Exception as exc:  # noqa: BLE001
                check("(cleanup) remove storage objects", False, str(exc))

        end_counts = _counts(client)
        job_after = client.table("jobs").select(
            "accuracy_tier, confidence_pct").eq("job_id", LIVE_JOB).execute().data[0]
        print(f"        end counts:   {end_counts}")
        print(f"        job tier after restore: {job_after}")
        check("(cleanup) EVERY count unchanged from the start", end_counts == start_counts,
              f"start={start_counts} end={end_counts}")
        check("(cleanup) job tier/confidence restored exactly as found",
              job_after == before_job, f"before={before_job} after={job_after}")


def make_generic_csv(days: int = 2) -> bytes:
    """A generic long-layout CSV — the parser path with NO resolution_minutes."""
    lines = ["datetime,kwh"]
    for d in range(1, days + 1):
        for h in range(24):
            lines.append(f"2025-01-{d:02d} {h:02d}:00,0.5")
    return ("\n".join(lines) + "\n").encode()


def t12_quality_columns() -> None:
    """3.6 follow-up: the parser's quality numbers are PERSISTED, so the readout
    survives a page load — and a re-upload refreshes them."""
    print("\n12. interval data-quality columns persisted")

    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        _run(interval.upload_interval(
            file=_upload_file(make_nem12(30, start=dt.date(2025, 1, 1))),
            job_id="j1", include_controlled_load=False, caller=CALLER))
        inserts = stub.ops("interval_data", "insert")
        check("(1) insert carries all four quality keys with the parser's values",
              bool(inserts)
              and inserts[0].get("coverage_days") == 30
              and inserts[0].get("gap_days") == 0
              and inserts[0].get("pct_actual") == 100.0
              and inserts[0].get("interval_minutes") == 30,
              str({k: inserts[0].get(k) for k in
                   ("coverage_days", "gap_days", "pct_actual", "interval_minutes")}
                  if inserts else None))

        _run(interval.upload_interval(
            file=_upload_file(make_nem12(45, start=dt.date(2025, 3, 1))),
            job_id="j1", include_controlled_load=False, caller=CALLER))
        updates = stub.ops("interval_data", "update")
        check("(2) a same-meter re-upload UPDATES the four as well",
              bool(updates)
              and updates[-1].get("coverage_days") == 45
              and updates[-1].get("interval_minutes") == 30
              and "gap_days" in updates[-1] and "pct_actual" in updates[-1],
              str(updates[-1:]))
    finally:
        restore()

    # (3) The generic-CSV path has NO resolution -> interval_minutes null, no raise.
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        resp = _run(interval.upload_interval(
            file=_upload_file(make_generic_csv(), "usage.csv"),
            job_id="j1", include_controlled_load=False, caller=CALLER))
        inserts = stub.ops("interval_data", "insert")
        check("(3) no resolution_minutes -> interval_minutes None, no raise",
              resp.get("ok") is True and bool(inserts)
              and inserts[0].get("interval_minutes") is None
              and inserts[0].get("coverage_days") == 2,
              str(inserts[:1]))
    finally:
        restore()

    # (4) The legacy backfill path carries none of the four keys: absent from
    # the insert means the columns default NULL — never invented, never raising.
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        written, err = interval.backfill_interval_row(
            "j1", {"nmi": "6001234567", "raw_file_path": "bills/x.csv",
                   "source": "NEM12", "resolution": "30 min",
                   "period_start": "2025-01-01", "period_end": "2025-01-30",
                   "parsed_series_ref": "bills/x.series.json"})
        inserts = stub.ops("interval_data", "insert")
        check("(4) backfill without the keys -> nulls by omission, no raise",
              written is True and err is None and bool(inserts)
              and all(inserts[0].get(k) is None for k in
                      ("coverage_days", "gap_days", "pct_actual", "interval_minutes")),
              f"written={written} err={err} insert_keys={sorted(inserts[0]) if inserts else None}")
    finally:
        restore()


PII_NAME = "Jane Q. Testerson"
PII_ADDRESS = "42 Wallaby Way, Kensington SA 5068"


def _recorded_json(stub, table: str) -> str:
    """Every payload the stub recorded for `table`, as one JSON text to search."""
    rows = [p for (t, op, p, _f) in stub.calls if t == table and op in ("insert", "upsert")]
    return json.dumps(rows, default=str)


def t11_pii_scrub() -> None:
    """
    The nested-PII fix: capture's allowlist matches TOP-LEVEL keys only, so a full
    bill-parser payload placed in the allowed `parsed_json` column carried the
    customer's name and supply address into a table whose own docstring promises
    no PII. The guard is a recursive KEY scrub inside _filtered.
    """
    print("\n11. nested-PII scrub in capture.py")

    flat = {"customer_name": PII_NAME, "property_address": PII_ADDRESS, "total_kwh": 1150.0}
    out = capture._scrub_pii(flat)
    check("(1) flat dict: customer_name and property_address removed",
          "customer_name" not in out and "property_address" not in out
          and out.get("total_kwh") == 1150.0, str(out))

    nested = {
        "parsed_json": {
            "retailer": "AGL",
            "history": [
                {"period": "Q1", "meta": {"customer_name": PII_NAME,
                                          "property_address": PII_ADDRESS, "kwh": 900}},
            ],
        }
    }
    out = capture._scrub_pii(nested)
    text = json.dumps(out)
    check("(2) removed from a dict nested inside a list inside a dict",
          PII_NAME not in text and PII_ADDRESS not in text and "900" in text, text[:200])

    mixed_case = {"Customer_Name": PII_NAME, "PROPERTY_ADDRESS": PII_ADDRESS,
                  "Property_Address_Full": PII_ADDRESS, "nmi": "6001234567"}
    out = capture._scrub_pii(mixed_case)
    check("(3) key matching is case-insensitive",
          json.dumps(out).find(PII_NAME) == -1 and PII_ADDRESS not in json.dumps(out)
          and out.get("nmi") == "6001234567", str(out))

    # THE CORRECTIONS CASE — keys are matched, values are not. A row whose
    # field_path is the STRING "customer_name" must survive intact.
    correction = {"field_path": "customer_name", "original_value": "17",
                  "corrected_value": "19"}
    out = capture._scrub_pii(correction)
    check("(4) matches KEYS not VALUES: field_path='customer_name' survives",
          out == correction, str(out))

    source = {"parsed_json": {"deep": [{"customer_name": PII_NAME}], "keep": 1}}
    before = copy.deepcopy(source)
    capture._scrub_pii(source)
    check("(5) the input is NOT mutated", source == before, str(source))

    usage = {"parsed_json": {"combined_usage_periods": [{"kwh": 900, "days": 91}],
                            "customer_name": PII_NAME}}
    out = capture._scrub_pii(usage)
    check("(6) combined_usage_periods SURVIVES (a size decision, not a privacy one)",
          out["parsed_json"].get("combined_usage_periods") == [{"kwh": 900, "days": 91}]
          and "customer_name" not in out["parsed_json"], str(out))

    # (7) THE REAL ONE — the defect's own shape, at the capture boundary.
    parsed = {**BILL_PARSE_FIXTURE, "customer_name": PII_NAME,
              "property_address": PII_ADDRESS}
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        capture.save_bill({**parsed, "job_id": "j1", "raw_file_path": None,
                           "parsed_json": parsed})
        recorded = _recorded_json(stub, "bills")
        check("(7) neither PII VALUE appears anywhere in the recorded bills row",
              PII_NAME not in recorded and PII_ADDRESS not in recorded,
              recorded[:220])
        check("(7) the row was still written with its real bill data",
              '"total_kwh": 1150.0' in recorded and "AGL" in recorded, recorded[:160])
    finally:
        restore()

    # (8) Table-agnostic: the same guard on three other writers, PII nested in
    # each one's jsonb column.
    for label, writer, payload, table in (
        ("save_job", capture.save_job,
         {"job_id": "j1", "engine_versions": {"meta": {"customer_name": PII_NAME,
                                                       "supply_address": PII_ADDRESS}}},
         "jobs"),
        ("save_survey", capture.save_survey,
         {"job_id": "j1", "occupancy_grid": [{"note": {"contact_email": PII_NAME,
                                                       "site_address": PII_ADDRESS}}]},
         "surveys"),
        ("save_correction", capture.save_correction,
         {"job_id": "j1", "correction_id": "c1", "field_path": "storeys",
          "original_value": {"account_holder": PII_NAME, "full_address": PII_ADDRESS}},
         "corrections"),
    ):
        stub = StubClient(jobs_rows=[dict(MY_JOB)])
        restore = _patch(stub)
        try:
            writer(payload)
            recorded = _recorded_json(stub, table)
            check(f"(8) {label}: neither PII value reaches {table}",
                  PII_NAME not in recorded and PII_ADDRESS not in recorded,
                  recorded[:200])
        finally:
            restore()

    # (9) Top-level behaviour is exactly as before: PII dropped, every legitimate
    # bills column kept. Asserted against the module's own allowlist.
    stub = StubClient(jobs_rows=[dict(MY_JOB)])
    restore = _patch(stub)
    try:
        capture.save_bill({**parsed, "job_id": "j1", "parsed_json": {"retailer": "AGL"}})
        rows = stub.ops("bills", "upsert")
        keys = set(rows[-1]) - {"bill_id"} if rows else set()
        check("(9) surviving keys ⊆ capture._ALLOWED['bills']",
              keys <= capture._ALLOWED["bills"],
              f"outside: {sorted(keys - capture._ALLOWED['bills'])}")
        check("(9) top-level customer_name / property_address still dropped",
              "customer_name" not in keys and "property_address" not in keys, str(sorted(keys)))
        expected = {k for k in parsed if k in capture._ALLOWED["bills"]} | {"job_id", "parsed_json"}
        check("(9) every legitimate bills column in the payload survived",
              expected - {"customer_name", "property_address"} <= keys,
              f"missing: {sorted(expected - keys)}")
    finally:
        restore()

    # (10) Depth guard fails CLOSED, and a cycle terminates rather than hanging.
    deep: dict = {"customer_name": PII_NAME}
    for _ in range(capture._MAX_SCRUB_DEPTH + 5):
        deep = {"level": deep}
    try:
        out = capture._scrub_pii(deep)
        text = json.dumps(out)
        check("(10) past the depth cap: dropped, not kept, and no raise",
              PII_NAME not in text, text[-160:])
    except Exception as exc:  # noqa: BLE001
        check("(10) past the depth cap: dropped, not kept, and no raise", False, str(exc))

    cyclic: dict = {"total_kwh": 1.0}
    cyclic["self"] = cyclic
    try:
        out = capture._scrub_pii(cyclic)
        check("(10) a self-referencing payload terminates without raising",
              isinstance(out, dict) and out.get("total_kwh") == 1.0, str(type(out)))
    except Exception as exc:  # noqa: BLE001
        check("(10) a self-referencing payload terminates without raising", False, str(exc))


# ── T13 (2026-08-20): THE SCREEN'S TICK vs THE ENGINE'S LOAD RESOLVER ────────
#
# THE FAULT THIS EXISTS FOR: the Energy data section ticked on
# `interval_data | bills | surveys` being non-empty, while the engine resolves a
# load from `interval_data.parsed_series_ref` or the `load_profiles` row. A
# typed annual usage figure writes a load_profiles row and (with the optional
# survey unanswered) NO surveys row — so the section stayed incomplete forever
# and every gating section after it stayed locked, on a job the engine could
# size perfectly well. The F134 family: two halves each correct alone, the fault
# living in the RELATIONSHIP, with nothing comparing them.
#
# BOTH SIDES RUN, NEITHER IS PARSED (F148): the TypeScript side executes the
# REAL predicate out of lib/worksheet.ts over node; the Python side calls the
# REAL _resolve_load with a stub client serving the same job shape. THE POINT IS
# THE PAIRING — one assertion per shape that the two ANSWERS ARE EQUAL, never
# two independent lists of expectations that could both drift.

_WEIGHTS_24 = [1.0] * 24
_DAY_24 = [0.8] * 6 + [1.2] * 12 + [1.6] * 6

# A real stored series document, shaped as interval.py writes one, so the
# interval branch of _resolve_load genuinely RESOLVES rather than falling
# through to the profile branch. A stub that could not serve this would make
# case (d) pass for the wrong reason.
_SERIES_DOC = {
    "series_by_date": {f"2025-01-{d:02d}": list(_DAY_24) for d in range(1, 29)},
    "average_day_kwh": list(_DAY_24),
    "annual_kwh": 8240.0,
    "coverage_days": 28,
}

# The seven shapes, each a job as GET /api/job/{id} hydrates one. Both sides
# read the SAME dict, so neither can be tuned to its own half.
_PAIR_SHAPES: list[tuple[str, str, dict]] = [
    ("a", "load profile, positive annual figure, no interval",
     {"load_profiles": [{"annual_kwh": 8240.0, "hourly_profile_weights": _WEIGHTS_24,
                         "accuracy_tier": 1, "created_at": "2026-08-20T00:00:00Z"}]}),
    ("b", "load profile with annual_kwh NULL, no interval",
     {"load_profiles": [{"annual_kwh": None, "hourly_profile_weights": _WEIGHTS_24,
                         "accuracy_tier": 1, "created_at": "2026-08-20T00:00:00Z"}]}),
    ("c", "load profile with annual_kwh 0, no interval",
     {"load_profiles": [{"annual_kwh": 0, "hourly_profile_weights": _WEIGHTS_24,
                         "accuracy_tier": 1, "created_at": "2026-08-20T00:00:00Z"}]}),
    ("d", "interval row with a parsed_series_ref, NO load profile",
     {"interval_data": [{"parsed_series_ref": "bills/interval/tok.series.json",
                         "coverage_days": 28, "created_at": "2026-08-20T00:00:00Z"}]}),
    ("e", "nothing at all", {}),
    ("f", "a bill row only, no profile, no interval",
     {"bills": [{"bill_id": "b1", "created_at": "2026-08-20T00:00:00Z"}]}),
    ("g", "a survey row only, no profile, no interval",
     {"surveys": [{"survey_id": "s1", "created_at": "2026-08-20T00:00:00Z"}]}),
    # (h) NOT in the original seven, added because the rule is "the NEWEST row",
    # not "any row ever": _resolve_load reads interval_data with
    # order(created_at, desc).limit(1), so a series ref on a SUPERSEDED row is
    # not one the engine would use. A `.some(...)` screen rule would tick here
    # and the engine would answer missing_load. Array order is deliberately the
    # reverse of created_at so a last-element reader cannot pass by accident.
    ("h", "newest interval row has NO ref, an older one does, no profile",
     {"interval_data": [
         {"parsed_series_ref": None, "coverage_days": None,
          "created_at": "2026-08-20T02:00:00Z"},
         {"parsed_series_ref": "bills/interval/old.series.json",
          "coverage_days": 28, "created_at": "2026-08-20T01:00:00Z"},
     ]}),
]

_CHILD_KEYS = ("interval_data", "bills", "surveys", "load_profiles", "tariffs",
               "roof_geometry", "sizing_results", "financial_results", "customer")


def _pair_job(shape: dict) -> dict:
    """One shape as a full hydrated job — every child key present as an array,
    so neither side is answering a question about a MISSING key by accident."""
    job = {key: [] for key in _CHILD_KEYS}
    job.update({"status": "draft", "path": "B", "path_label": None})
    job.update(shape)
    return job


class _PairResult:
    def __init__(self, data):
        self.data = data


class _PairQuery:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return _PairResult([dict(r) for r in self._rows])


class _PairStorage:
    def from_(self, _bucket):
        return self

    def download(self, _key):
        return json.dumps(_SERIES_DOC).encode()


class _PairClient:
    """Serves one job shape. Reads only — there is no write path on it at all,
    so this cannot touch the database even by mistake."""

    def __init__(self, job: dict):
        self._job = job
        self.storage = _PairStorage()

    def table(self, name):
        return _PairQuery(self._job.get(name) or [])


def _engine_resolves(job: dict) -> bool:
    """The REAL _resolve_load against this shape: True when the engine gets a
    load, False when it returns the missing_load error."""
    from types import SimpleNamespace  # noqa: PLC0415

    body = SimpleNamespace(job_id="pair-job", load_hourly_8760=None,
                           load_source=None, annual_kwh=None,
                           hourly_profile_weights=None)
    flags: list[str] = []
    load, _source, error = sizing_route._resolve_load(_PairClient(job), body, flags)
    if error is not None:
        return False
    return bool(load) and len(load) == solar_optimiser.HOURS


def _screen_ticks() -> tuple[dict | None, str]:
    """Run the REAL energy-data predicate out of lib/worksheet.ts over node.
    Returns ({key: bool}, ""), (None, "skip") for the missing-export signature
    only, or (None, <stderr>) for anything else — which FAILS, so the bridge
    cannot rot silently."""
    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    shapes = {key: _pair_job(shape) for key, _label, shape in _PAIR_SHAPES}
    script = (
        'import { SECTIONS } from "./lib/worksheet.ts";\n'
        f"const shapes = {json.dumps(shapes)};\n"
        'const spec = SECTIONS.find((s) => s.id === "energy-data");\n'
        'if (!spec) { console.error("does not provide an export named energy-data"); process.exit(9); }\n'
        "const out = {};\n"
        "for (const [key, job] of Object.entries(shapes)) {\n"
        "  try { out[key] = spec.complete(job) === true; }\n"
        '  catch (e) { out[key] = "THREW: " + String(e); }\n'
        "}\n"
        "console.log(JSON.stringify(out));"
    )
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=frontend, capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        return None, "node not found"
    if proc.returncode != 0:
        stderr = proc.stderr or ""
        if "does not provide an export named" in stderr:
            return None, "skip"
        return None, stderr.strip()[:300]
    return json.loads(proc.stdout.strip()), ""


def t13_screen_vs_engine() -> int:
    """Returns the number of SKIPPED checks (0 or 1) — never a pass (2Q.1)."""
    print("\nT13. the Energy data TICK vs the engine's load resolver — one "
          "assertion per shape that the two ANSWERS AGREE")
    ticks, err = _screen_ticks()
    if ticks is None:
        if err == "skip":
            print("  SKIP  the energy-data section spec is not exported yet — "
                  "pending the frontend half. NOT counted as a pass.")
            return 1
        check("(T13) node ran the real predicate out of lib/worksheet.ts", False, err)
        return 0

    print(f"        {'case':<4} {'shape':<52} {'screen':<8} {'engine':<8} agree")
    for key, label, shape in _PAIR_SHAPES:
        job = _pair_job(shape)
        screen = ticks.get(key)
        engine = _engine_resolves(job)
        agree = screen is engine
        print(f"        ({key})  {label:<52} "
              f"{str(screen):<8} {str(engine):<8} {'yes' if agree else 'NO'}")
        # THE PAIRED ASSERTION. Not "the screen says X" and separately "the
        # engine says X" — two lists can drift together and both stay green.
        check(f"(T13{key}) {label}: the tick EQUALS whether the engine can "
              "resolve a load",
              agree,
              f"screen says complete={screen!r}, engine resolves a load={engine!r} "
              "— the section would " + ("promise a load the engine cannot find"
                                        if screen else "hide a job the engine can size"))
    # The pairing is only meaningful if the shapes actually EXERCISE both
    # answers: a table where every row is True would agree vacuously.
    engine_answers = {_engine_resolves(_pair_job(shape)) for _k, _l, shape in _PAIR_SHAPES}
    check("(T13) the shape table exercises BOTH answers — it cannot agree "
          "vacuously", engine_answers == {True, False}, str(engine_answers))
    return 0


def main_() -> int:
    live = "--live" in sys.argv
    print("verify_demand_contract.py — 3.6 prompt-1 demand write path"
          + (" (with --live database pass)" if live else " (offline)") + "\n")
    t1_signatures()
    t2_ownership()
    t3_reupload()
    t4_tier_sync()
    t5_source_scan()
    t6_demand_tiers()
    t7_allowlists()
    t8_never500()
    t9_http_shapes()
    t10_annualise_boundary()
    t11_pii_scrub()
    t12_quality_columns()
    skipped = t13_screen_vs_engine()
    if live:
        t_live()

    print(f"\n{'-' * 60}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed "
              f"({skipped} skipped, not counted):")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({skipped} skipped, not counted)" if skipped else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main_())
    except Exception:  # noqa: BLE001 — a crashing verifier must not read as success
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
