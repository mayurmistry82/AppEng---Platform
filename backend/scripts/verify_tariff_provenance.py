#!/usr/bin/env python3
"""
verify_tariff_provenance.py — the 3.18 prompt-1 gate: field-level provenance
of the saved tariff envelope. WRITES NOTHING to the live database — the
endpoint checks run against stubs, and the two live reads (the PostgREST
OpenAPI root, pg_constraint) are reads.

What it gates, and why each check exists:
  T1  the migration landed AND all three allowlists agree — a live two-sided
      comparison (the verify_sizing_confidence.py T4 pattern), never a
      transcription, because a column missing from capture._ALLOWED is dropped
      IN SILENCE at write time.
  T2  the vocabulary is ONE constant (D33): the 422 for an unknown label names
      every accepted value, and the column carries no CHECK constraint.
  T3  the four endpoint refusals, each a real call against a stub, each
      asserting the status AND that nothing was written.
  T4  the carry-forward — the rule most likely to be got wrong: an unlabelled
      unchanged value keeps its stored label; an unlabelled CHANGED value gets
      NO label, never "typed".
  T5  the two-sided field-set gate across the language gap (F148: run both
      sides, parse neither) — the failure it prevents is scheduled: 4.4 adds
      flexible export, 4.12 adds installer pricing.

A skip is LOUD, uncounted, and never a pass (F177).

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_tariff_provenance.py
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auth  # noqa: E402
import capture  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402
from routes import demand  # noqa: E402
from routes import sizing as sizing_route  # noqa: E402
from types import SimpleNamespace  # noqa: E402

FAILURES: list[str] = []
CHECKS_RUN = 0
SKIPS: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS_RUN
    CHECKS_RUN += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


def skip(name: str, reason: str) -> None:
    """Printed, recorded, NEVER counted as a pass (F177)."""
    print(f"  SKIP  {name} — {reason}")
    SKIPS.append(name)


CALLER = auth.Caller(user_id="u1", email="u@example.com", company_id="co-1", role="owner")


# ── Stub Supabase client (the verify_tariff_contract.py shape) ───────────────
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
        if (self._op == "select" and self._t == "tariffs"
                and getattr(self._c, "fail_tariff_select", False)):
            raise RuntimeError("stub: tariffs unreadable")
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
                        # PostgREST upsert semantics: only the provided columns
                        # are set; absent keys keep their stored values.
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
    def __init__(self, tables=None, fail_tariff_select=False):
        self.tables: dict[str, list] = dict(tables or {})
        self.upserts: list = []
        self.seq = 0
        self.fail_tariff_select = fail_tariff_select

    def table(self, name):
        return _Query(self, name)


MY_JOB = {"job_id": "j1", "company_id": "co-1"}


def _run_endpoint(stub, payload):
    """(response, HTTPException-or-None). A pydantic ValidationError on the
    model IS the request's 422 (FastAPI raises it before the endpoint runs),
    reported as status 422 — the verify_tariff_contract.py T7e reading."""
    saved_client = demand._client
    saved_capture = capture._get_client
    demand._client = lambda: stub
    capture._get_client = lambda: stub
    try:
        try:
            body = demand.TariffSaveRequest(**payload)
        except ValidationError as exc:
            fake = HTTPException(status_code=422, detail=str(exc))
            return None, fake
        return asyncio.run(demand.save_job_tariff("j1", body, CALLER)), None
    except HTTPException as exc:
        return None, exc
    finally:
        demand._client = saved_client
        capture._get_client = saved_capture


def t1_allowlists() -> None:
    print("T1. the migration landed and the allowlists agree — live, two-sided")
    import httpx  # noqa: PLC0415 — scoped to the one check that needs it
    from dotenv import load_dotenv  # noqa: PLC0415
    load_dotenv(os.path.join(BACKEND_DIR, ".env"))
    base = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    api_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY")
               or os.getenv("SUPABASE_ANON_KEY") or "")
    if not base or not api_key:
        skip("(1) live column list vs _ALLOWED['tariffs']",
             "SUPABASE_URL / key not set — cannot reach PostgREST")
        return
    try:
        resp = httpx.get(f"{base}/rest/v1/",
                         headers={"apikey": api_key,
                                  "Authorization": f"Bearer {api_key}"},
                         timeout=30)
    except Exception as exc:  # noqa: BLE001
        skip("(1) live column list vs _ALLOWED['tariffs']",
             f"PostgREST unreachable: {type(exc).__name__}: {exc}")
        return
    check("(1) the PostgREST OpenAPI root answered 200", resp.status_code == 200,
          str(resp.status_code))
    definitions = (resp.json() or {}).get("definitions") or {}
    columns = set((definitions.get("tariffs") or {}).get("properties") or {})
    allowed = capture._ALLOWED["tariffs"]
    print(f"        tariffs columns  ({len(columns)}): {sorted(columns)}")
    print(f"        tariffs _ALLOWED ({len(allowed)}): {sorted(allowed)}")
    check("(1) field_sources is a LIVE column (the migration landed)",
          "field_sources" in columns, "column absent — migration not applied")
    check("(1) (columns - _ALLOWED) == {'created_at'} — the only intended "
          "exception, database-set and deliberately not writable",
          (columns - allowed) == {"created_at"},
          f"unexpected diff: {sorted(columns - allowed)}")
    check("(1) (_ALLOWED - columns) == set() — no phantom names",
          not (allowed - columns), f"phantom: {sorted(allowed - columns)}")
    check("(1) TariffSaveRequest carries field_sources (allowlist 2 of 3)",
          "field_sources" in demand.TariffSaveRequest.model_fields, "")
    # Allowlist 3 of 3 is the Next.js route — asserted by presence in BOTH the
    # interface and the forwarded body literal, because a field in one and not
    # the other is dropped between the browser and the backend.
    route_path = os.path.abspath(os.path.join(
        BACKEND_DIR, "..", "frontend", "app", "api", "job", "[id]", "tariff", "route.ts"))
    src = open(route_path).read()
    interface_half = src.split("interface TariffBody")[1].split("}")[0]
    body_half = src.split("const body = {")[1].split("}")[0]
    check("(1) route.ts TariffBody interface carries field_sources",
          "field_sources" in interface_half, "")
    check("(1) route.ts forwarded body literal carries field_sources",
          "field_sources: raw.field_sources" in body_half, "")


def t2_vocabulary() -> None:
    print("\nT2. the vocabulary is ONE constant, and the column has no CHECK")
    vocab = demand.TARIFF_FIELD_SOURCES
    check("(2) TARIFF_FIELD_SOURCES is a non-empty frozenset",
          isinstance(vocab, frozenset) and len(vocab) > 0, repr(vocab))
    print(f"        TARIFF_FIELD_SOURCES: {sorted(vocab)}")
    check("(2) exactly the two values of 3.18 — typed / accepted_default. "
          "NOT 'bill': tariffNetworkView has no bill branch, and a value no "
          "path can emit is a feature that only claims to exist (F39)",
          vocab == frozenset({"typed", "accepted_default"}), repr(sorted(vocab)))

    stub = StubClient({"jobs": [MY_JOB]})
    _res, exc = _run_endpoint(stub, {
        "tariff_type": "flat", "import_rate": 0.42,
        "field_sources": {"fit_aud_per_kwh": "guessed"}})
    check("(2) unknown label -> 422", exc is not None and exc.status_code == 422,
          str(exc))
    detail = str(getattr(exc, "detail", ""))
    print(f"        422 detail: {detail!r}")
    # WHY THIS CAN BREAK: reword the refusal to drop the accepted list and the
    # containment fails — the refusal must keep naming the vocabulary, which is
    # what lets the constant stay the single source of truth (D33).
    check("(2) the 422 message CONTAINS every member of the vocabulary",
          all(member in detail for member in vocab), detail)

    from dotenv import load_dotenv  # noqa: PLC0415
    load_dotenv(os.path.join(BACKEND_DIR, ".env"))
    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        skip("(2) no CHECK constraint on tariffs.field_sources",
             "SUPABASE_DB_URL not set — cannot query pg_constraint")
        return
    try:
        import psycopg2  # noqa: PLC0415
        conn = psycopg2.connect(db_url)
        conn.set_session(readonly=True)
        cur = conn.cursor()
        cur.execute("""select count(*) from pg_constraint
                       where conrelid = 'public.tariffs'::regclass
                         and contype = 'c'""")
        n_check = cur.fetchone()[0]
        conn.close()
    except Exception as exc:  # noqa: BLE001
        skip("(2) no CHECK constraint on tariffs.field_sources",
             f"pg_constraint unreadable: {type(exc).__name__}: {exc}")
        return
    check("(2) zero CHECK constraints on tariffs — the vocabulary lives in the "
          "constant, not the schema (D33)", n_check == 0, str(n_check))


def t3_refusals() -> None:
    print("\nT3. the four endpoint refusals — status asserted AND nothing written")
    cases = [
        ("(3a) unknown field name",
         {"field_sources": {"unicorn": "typed"}}),
        ("(3b) unknown label",
         {"field_sources": {"fit_aud_per_kwh": "guessed"}}),
        ("(3c) 'accepted_default' on a field with no default (import_rate)",
         {"field_sources": {"import_rate": "accepted_default"}}),
        ("(3d) nested value (not a plain string label)",
         {"field_sources": {"fit_aud_per_kwh": {"deep": 1}}}),
        ("(3d) non-string value (a number)",
         {"field_sources": {"fit_aud_per_kwh": 5}}),
        ("(3d) field_sources not an object at all",
         {"field_sources": "typed"}),
    ]
    for name, extra in cases:
        stub = StubClient({"jobs": [MY_JOB]})
        _res, exc = _run_endpoint(stub, {
            "tariff_type": "flat", "import_rate": 0.42, **extra})
        check(f"{name} -> 422", exc is not None and exc.status_code == 422, str(exc))
        check(f"{name}: nothing was written", stub.upserts == [], str(stub.upserts))
    # The unknown-field refusal names the accepted field names, so the caller
    # can fix the request without reading the source.
    stub = StubClient({"jobs": [MY_JOB]})
    _res, exc = _run_endpoint(stub, {
        "tariff_type": "flat", "import_rate": 0.42,
        "field_sources": {"unicorn": "typed"}})
    detail = str(getattr(exc, "detail", ""))
    check("(3a) ...and its detail names every savable field",
          all(f in detail for f in demand.SAVABLE_TARIFF_FIELDS), detail)


def t4_carry_forward() -> None:
    print("\nT4. the carry-forward — the rule most likely to be got wrong")

    def stored_row():
        return {
            "tariff_id": "t-1", "job_id": "j1", "tariff_type": "flat",
            "import_rate": 0.42, "supply_charge": None, "tou_windows": None,
            "fit_aud_per_kwh": 0.05, "export_limit_kw": 5.0,
            "source": "installer",
            "field_sources": {"fit_aud_per_kwh": "accepted_default",
                              "export_limit_kw": "accepted_default"},
        }

    def resave(fit, field_sources=None, fail_read=False):
        stub = StubClient({"jobs": [MY_JOB], "tariffs": [stored_row()]},
                          fail_tariff_select=fail_read)
        payload = {"tariff_type": "flat", "import_rate": 0.42,
                   "fit_aud_per_kwh": fit, "export_limit_kw": 5.0}
        if field_sources is not None:
            payload["field_sources"] = field_sources
        res, exc = _run_endpoint(stub, payload)
        return stub.tables["tariffs"][0], res, exc

    # (4a) SAME fit value, no key: the stored label survives. WHY EACH HALF
    # BREAKS: default unlabelled fields to "typed" and the label reads "typed";
    # drop the carry-forward and the key is absent — either fails the equality.
    row, res, exc = resave(0.05)
    check("(4a) re-save, same 0.05, no key -> label STILL 'accepted_default'",
          exc is None and row["field_sources"].get("fit_aud_per_kwh") == "accepted_default",
          f"exc={exc} field_sources={row.get('field_sources')}")
    check("(4a) ...and export_limit_kw carried too (unchanged, unlabelled)",
          row["field_sources"].get("export_limit_kw") == "accepted_default",
          str(row.get("field_sources")))

    # (4b) DIFFERENT fit value, no key: the key is ABSENT — not "typed" (the
    # client did not say so; a guessed label cannot tell a default from a
    # decision), not carried (the value is no longer the one the label was
    # about). A blind carry keeps 'accepted_default'; a typed default inserts
    # 'typed' — both fail the absence assertion.
    row, res, exc = resave(0.08)
    check("(4b) re-save, fit 0.08, no key -> the key is ABSENT",
          exc is None and "fit_aud_per_kwh" not in row["field_sources"],
          f"exc={exc} field_sources={row.get('field_sources')}")

    # (4c) a supplied key WINS over the carry — this save's own claim.
    row, res, exc = resave(0.05, field_sources={"fit_aud_per_kwh": "typed"})
    check("(4c) supplied 'typed' beats the stored 'accepted_default'",
          exc is None and row["field_sources"].get("fit_aud_per_kwh") == "typed",
          str(row.get("field_sources")))

    # (4d) rule C4: a key supplied for a NULL-valued field is dropped, silently
    # — no value, no provenance, never a placeholder.
    stub = StubClient({"jobs": [MY_JOB]})
    res, exc = _run_endpoint(stub, {
        "tariff_type": "flat", "import_rate": 0.42,
        "field_sources": {"supply_charge": "typed", "import_rate": "typed"}})
    written = stub.tables["tariffs"][0]
    check("(4d) null supply_charge with a supplied key -> key dropped, save OK",
          exc is None and "supply_charge" not in written.get("field_sources", {}),
          f"exc={exc} field_sources={written.get('field_sources')}")
    check("(4d) ...while the non-null import_rate keeps its supplied key",
          written.get("field_sources", {}).get("import_rate") == "typed",
          str(written.get("field_sources")))

    # (4e) the C5 fallback: the stored row cannot be read back. Do NOT guess —
    # store only the client's own keys, warn, and with NOTHING supplied leave
    # the stored column untouched rather than overwrite history nobody saw.
    row, res, exc = resave(0.05, field_sources={"fit_aud_per_kwh": "accepted_default"},
                           fail_read=True)
    check("(4e) read-back failed: the supplied key is stored",
          exc is None and row["field_sources"] == {"fit_aud_per_kwh": "accepted_default"},
          f"exc={exc} field_sources={row.get('field_sources')}")
    check("(4e) ...with a warning in the response, never a silent guess",
          res is not None and any("provenance" in w for w in res["warnings"]),
          str(res and res["warnings"]))
    row, res, exc = resave(0.05, fail_read=True)
    check("(4e) read-back failed + nothing supplied: stored labels untouched",
          exc is None and row["field_sources"] == stored_row()["field_sources"],
          f"exc={exc} field_sources={row.get('field_sources')}")

    # (4f) an older client (no field_sources anywhere) still saves — and an
    # unchanged value's history survives it.
    row, res, exc = resave(0.05)
    check("(4f) no field_sources in the request: save proceeds, ok true",
          exc is None and res is not None and res["saved"] is True, str(exc))


def t5_cross_language() -> None:
    print("\nT5. the two-sided field-set gate across the language gap (F148)")
    savable_from_model = frozenset(
        name for name in demand.TariffSaveRequest.model_fields
        if name not in ("source", "field_sources")
    )
    check("(5) demand.SAVABLE_TARIFF_FIELDS is derived from the model, not "
          "transcribed beside it",
          demand.SAVABLE_TARIFF_FIELDS == savable_from_model,
          f"constant={sorted(demand.SAVABLE_TARIFF_FIELDS)} "
          f"model={sorted(savable_from_model)}")
    check("(5) PREFILLED is a non-empty subset of SAVABLE",
          demand.PREFILLED_TARIFF_FIELDS
          and demand.PREFILLED_TARIFF_FIELDS <= demand.SAVABLE_TARIFF_FIELDS,
          f"{sorted(demand.PREFILLED_TARIFF_FIELDS)}")

    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    script = (
        'import { PREFILLED_TARIFF_FIELDS, SAVABLE_TARIFF_FIELDS } '
        'from "./lib/worksheet.ts"; '
        "console.log(JSON.stringify({"
        "prefilled: [...PREFILLED_TARIFF_FIELDS].sort(), "
        "savable: [...SAVABLE_TARIFF_FIELDS].sort()}))"
    )
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=frontend, capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        check("(5) node available for the cross-language check", False,
              "node not found")
        return
    if proc.returncode != 0:
        # ANY node error FAILS rather than skips — the bridge must not rot
        # silently. (There is no pending-prompt window here: both exports land
        # in the same change as this gate.)
        check("(5) node import of lib/worksheet.ts", False,
              (proc.stderr or "").strip()[:300])
        return
    payload = json.loads(proc.stdout.strip())
    fe_prefilled = set(payload["prefilled"])
    fe_savable = set(payload["savable"])
    print(f"        frontend PREFILLED: {sorted(fe_prefilled)}")
    print(f"        backend  PREFILLED: {sorted(demand.PREFILLED_TARIFF_FIELDS)}")
    print(f"        frontend SAVABLE  : {sorted(fe_savable)}")
    print(f"        backend  SAVABLE  : {sorted(savable_from_model)}")
    check("(5) PREFILLED set equality, both directions",
          fe_prefilled == set(demand.PREFILLED_TARIFF_FIELDS),
          f"frontend-only={sorted(fe_prefilled - demand.PREFILLED_TARIFF_FIELDS)} "
          f"backend-only={sorted(set(demand.PREFILLED_TARIFF_FIELDS) - fe_prefilled)}")
    check("(5) SAVABLE set equality against the MODEL's own fields, both directions",
          fe_savable == savable_from_model,
          f"frontend-only={sorted(fe_savable - savable_from_model)} "
          f"backend-only={sorted(savable_from_model - fe_savable)}")


# ── 3.18 prompt 2: the READER — T6 the founding case, T7 export and gaps ─────

def _resolve(tables, state="SA", postcode="5000", **body_kw):
    """_resolve_tariff over a stub; returns (result, flags)."""
    base = dict(job_id="j1", import_rate=None, fit=None, export_limit_kw=None,
                import_rates_24=None, tou_windows=None)
    base.update(body_kw)
    stub = StubClient({"jobs": [], **tables})
    flags: list[str] = []
    return sizing_route._resolve_tariff(
        stub, SimpleNamespace(**base), state, postcode, flags), flags


def _flat_row(**kw):
    row = {"job_id": "j1", "tariff_type": "flat", "import_rate": 0.42,
           "supply_charge": 1.05, "tou_windows": None, "fit_aud_per_kwh": 0.05,
           "export_limit_kw": 5.0, "source": "installer",
           "created_at": "2026-08-20T00:00:00Z"}
    row.update(kw)
    return row


_PER_FIELD_KEYS = ("import_rate_source", "rate_24_source", "fit_source",
                   "tariff_type_source", "supply_charge_source")


def t6_founding_case() -> None:
    print("\nT6. the founding case at the resolver — field_sources is READ")

    # (6a) recorded typed / accepted labels flow through, per field. The
    # NUMBERS are pinned beside the labels: a provenance edit that moves a
    # number is the worst outcome available here.
    recorded = _flat_row(field_sources={
        "import_rate": "typed", "tariff_type": "accepted_default",
        "fit_aud_per_kwh": "accepted_default", "export_limit_kw": "accepted_default"})
    t, _ = _resolve({"tariffs": [recorded], "bills": []})
    check("(6a) field_sources 'typed' -> installer_typed (import rate)",
          t["import_rate_source"] == "installer_typed", repr(t["import_rate_source"]))
    check("(6a) 'accepted_default' -> installer_accepted_default (fit, type, export)",
          t["fit_source"] == "installer_accepted_default"
          and t["tariff_type_source"] == "installer_accepted_default"
          and t["export_meta"]["source"] == "installer_accepted_default",
          f"{t['fit_source']!r}/{t['tariff_type_source']!r}/{t['export_meta'].get('source')!r}")
    check("(6a) key ABSENT (supply_charge) -> installer_unrecorded",
          t["supply_charge_source"] == "installer_unrecorded",
          repr(t["supply_charge_source"]))
    check("(6a) row-level state 'recorded'",
          t["tariff_provenance_state"] == "recorded",
          repr(t["tariff_provenance_state"]))
    check("(6a) THE NUMBERS: 0.42 / 0.05 / 5.0 / flat vector — labels moved, "
          "values did not",
          t["import_rate"] == 0.42 and t["fit"] == 0.05
          and t["export_limit_kw"] == 5.0 and t["rate_24"] == [0.42] * 24
          and t["is_tou"] is False and t["supply_charge"] == 1.05,
          f"{t['import_rate']}/{t['fit']}/{t['export_limit_kw']}")

    # (6b) NULL vs {} — the prompt-1 inbox item: same FIELD answer, DIFFERENT
    # row state. Collapsing them is the specific error being guarded.
    t_null, _ = _resolve({"tariffs": [_flat_row(field_sources=None)], "bills": []})
    t_empty, _ = _resolve({"tariffs": [_flat_row(field_sources={})], "bills": []})
    check("(6b) field_sources NULL -> every stored field installer_unrecorded",
          all(t_null[k] == "installer_unrecorded" for k in _PER_FIELD_KEYS
              if k != "import_rate_source")
          and t_null["import_rate_source"] == "installer_unrecorded",
          str({k: t_null[k] for k in _PER_FIELD_KEYS}))
    check("(6b) NULL -> state 'absent'",
          t_null["tariff_provenance_state"] == "absent",
          repr(t_null["tariff_provenance_state"]))
    check("(6b) {} -> installer_unrecorded too, but state 'recorded'",
          t_empty["fit_source"] == "installer_unrecorded"
          and t_empty["tariff_provenance_state"] == "recorded",
          f"{t_empty['fit_source']!r}/{t_empty['tariff_provenance_state']!r}")
    check("(6b) NULL and {} produce DIFFERENT row-level states",
          t_null["tariff_provenance_state"] != t_empty["tariff_provenance_state"],
          f"{t_null['tariff_provenance_state']!r} == {t_empty['tariff_provenance_state']!r}")

    # (6c) no tariffs row at all: today's behaviour, state "no_row".
    t_none, _ = _resolve({"tariffs": [], "bills": []})
    check("(6c) no row -> state 'no_row', labels default / not stated as before",
          t_none["tariff_provenance_state"] == "no_row"
          and t_none["import_rate_source"] == "default"
          and t_none["tariff_type_source"] == "not stated",
          f"{t_none['tariff_provenance_state']!r}/{t_none['import_rate_source']!r}")

    # (6d) fallback behaviour: junk field_sources and unknown labels degrade,
    # never raise, never guess.
    t_junk, _ = _resolve({"tariffs": [_flat_row(field_sources="garbage")], "bills": []})
    check("(6d) field_sources a bare string -> treated as absent, unrecorded, no raise",
          t_junk["fit_source"] == "installer_unrecorded"
          and t_junk["tariff_provenance_state"] == "absent",
          f"{t_junk['fit_source']!r}/{t_junk['tariff_provenance_state']!r}")
    t_unknown, _ = _resolve(
        {"tariffs": [_flat_row(field_sources={"fit_aud_per_kwh": "guessed"})],
         "bills": []})
    check("(6d) a label outside prompt 1's vocabulary -> that FIELD unrecorded, "
          "state still 'recorded' (the dict was present)",
          t_unknown["fit_source"] == "installer_unrecorded"
          and t_unknown["tariff_provenance_state"] == "recorded",
          f"{t_unknown['fit_source']!r}/{t_unknown['tariff_provenance_state']!r}")

    # (6e) "installer" IS GONE FROM THE EMITTER — over the full stub matrix,
    # no per-field source and no export_meta.source is ever the bare word.
    matrix = [
        ({"tariffs": [], "bills": []}, {}),
        ({"tariffs": [_flat_row()], "bills": []}, {}),
        ({"tariffs": [_flat_row(field_sources=None)], "bills": []}, {}),
        ({"tariffs": [_flat_row(field_sources={})], "bills": []}, {}),
        ({"tariffs": [recorded], "bills": []}, {}),
        ({"tariffs": [_flat_row(field_sources="garbage")], "bills": []}, {}),
        ({"tariffs": [_flat_row(tariff_type="tou", import_rate=None,
                                tou_windows=[{"label": "peak", "rate": 0.55,
                                              "start": "07:00", "end": "21:00",
                                              "days": "all"}],
                                field_sources={"tou_windows": "typed"})],
          "bills": []}, {}),
        ({"tariffs": [_flat_row()], "bills": []},
         {"import_rate": 0.55, "fit": 0.09, "export_limit_kw": 3.0}),
    ]
    leaked = []
    for tables, body_kw in matrix:
        r, _ = _resolve(tables, **body_kw)
        for key in _PER_FIELD_KEYS:
            if r.get(key) == "installer":
                leaked.append(key)
        if (r.get("export_meta") or {}).get("source") == "installer":
            leaked.append("export_meta.source")
    check("(6e) the bare 'installer' is deleted from the emitter — zero "
          "occurrences over the full matrix (the word that claims 'the "
          "installer chose this', which was the false claim)",
          not leaked, str(leaked))

    # (6f) the live read actually FETCHES the column. The stubs above ignore
    # select lists, so a column-scoped _read_tariff_row that omits
    # field_sources passes every stub check while every LIVE row reads
    # "absent" — the exact miss the results-contract U checks caught on this
    # gate's first run. Asserted on CODE with comments stripped: the first
    # version of this check matched its own explanatory comment and could not
    # trip (proven red only after the strip).
    import inspect  # noqa: PLC0415
    code_only = "\n".join(
        line.split("#", 1)[0]
        for line in inspect.getsource(sizing_route._read_tariff_row).splitlines()
    )
    check("(6f) _read_tariff_row's select includes field_sources (comments "
          "stripped, so a comment naming the column cannot satisfy this)",
          "field_sources" in code_only, "column missing from the select")


def t7_export_and_gaps() -> None:
    print("\nT7. the export limit's explicit source, and the gap fill's count")

    # (7a) BOTH branches carry a source string.
    cases = [
        ("given-and-typed", _flat_row(field_sources={"export_limit_kw": "typed"}),
         "installer_typed"),
        ("given-and-accepted",
         _flat_row(field_sources={"export_limit_kw": "accepted_default"}),
         "installer_accepted_default"),
        ("given-unrecorded", _flat_row(), "installer_unrecorded"),
    ]
    for name, row, expected in cases:
        t, _ = _resolve({"tariffs": [row], "bills": []})
        check(f"(7a) {name}: export_meta.source == {expected!r}, value 5.0 kept",
              t["export_meta"].get("source") == expected
              and t["export_meta"]["export_limit_kw"] == 5.0
              and t["export_limit_kw"] == 5.0,
              str(t["export_meta"]))
    t_req, _ = _resolve({"tariffs": [_flat_row()], "bills": []}, export_limit_kw=3.0)
    check("(7a) request: export_meta.source 'request', value 3.0",
          t_req["export_meta"].get("source") == "request"
          and t_req["export_limit_kw"] == 3.0, str(t_req["export_meta"]))
    t_dnsp, _ = _resolve({"tariffs": [_flat_row(export_limit_kw=None)], "bills": []})
    check("(7a) dnsp-found (SA): source 'dnsp_standard', is_default False kept "
          "as DETAIL, dnsp named",
          t_dnsp["export_meta"].get("source") == "dnsp_standard"
          and t_dnsp["export_meta"].get("is_default") is False
          and isinstance(t_dnsp["export_meta"].get("dnsp"), str),
          str(t_dnsp["export_meta"]))
    t_def, flags_def = _resolve({"tariffs": [_flat_row(export_limit_kw=None)],
                                 "bills": []}, state=None, postcode=None)
    check("(7a) dnsp-not-found: source 'default', is_default True, flag unchanged",
          t_def["export_meta"].get("source") == "default"
          and t_def["export_meta"].get("is_default") is True
          and any("export_limit defaulted" in f for f in flags_def),
          f"{t_def['export_meta']} / {flags_def}")

    # (7b) the gap fill carries its count — windows covering 20 of 24 hours
    # (07-21 and 21-03) leave hours 03-06 to the flat rate: 4, with _FLAG_GAPS
    # still firing (the flag is not the mechanism replaced; the silence about
    # HOW MANY is).
    twenty = [
        {"label": "peak", "rate": 0.55, "start": "07:00", "end": "21:00", "days": "all"},
        {"label": "offpeak", "rate": 0.22, "start": "21:00", "end": "03:00", "days": "all"},
    ]
    row20 = _flat_row(tariff_type="tou", import_rate=0.40, tou_windows=twenty,
                      field_sources={"tou_windows": "typed"})
    t20, flags20 = _resolve({"tariffs": [row20], "bills": []})
    check("(7b) 20 of 24 hours covered -> rate_24_gap_filled_hours == 4",
          t20["rate_24_gap_filled_hours"] == 4,
          repr(t20["rate_24_gap_filled_hours"]))
    check("(7b) ...the four uncovered hours (03-06) took the flat 0.40",
          t20["rate_24"][3:7] == [0.40] * 4 and t20["rate_24"][7] == 0.55,
          str(t20["rate_24"]))
    check("(7b) ...and the gap-fill flag STILL fires, unchanged",
          sizing_route._FLAG_GAPS in flags20, str(flags20))
    full = [
        {"label": "peak", "rate": 0.55, "start": "07:00", "end": "21:00", "days": "all"},
        {"label": "offpeak", "rate": 0.22, "start": "21:00", "end": "07:00", "days": "all"},
    ]
    rowf = _flat_row(tariff_type="tou", import_rate=0.40, tou_windows=full,
                     field_sources={"tou_windows": "typed"})
    tf, flagsf = _resolve({"tariffs": [rowf], "bills": []})
    check("(7b) full coverage -> 0, and no gap flag",
          tf["rate_24_gap_filled_hours"] == 0
          and sizing_route._FLAG_GAPS not in flagsf,
          f"{tf['rate_24_gap_filled_hours']} / {flagsf}")

    # (7c) _build_rate_24 directly: the 3-tuple on all three branches.
    fl: list[str] = []
    r, tou, gaps = sizing_route._build_rate_24([0.3] * 24, None, None, 0.4, fl)
    check("(7c) explicit 24 rates -> gaps 0", gaps == 0 and tou is True, str(gaps))
    fl2: list[str] = []
    r2, tou2, gaps2 = sizing_route._build_rate_24(None, None, None, 0.4, fl2)
    check("(7c) flat fallback -> gaps 0 (a flat vector IS the flat rate by "
          "design, not a gap)", gaps2 == 0 and tou2 is False, str(gaps2))
    fl3: list[str] = []
    r3, tou3, gaps3 = sizing_route._build_rate_24(
        None, [{"label": "peak", "rate": 0.5, "start": "07:00", "end": "21:00"}],
        None, 0.4, fl3)
    check("(7c) 14-hour window -> gaps 10, flag fires",
          gaps3 == 10 and sizing_route._FLAG_GAPS in fl3, f"{gaps3} / {fl3}")


def main() -> int:
    print("verify_tariff_provenance.py — 3.18 prompts 1+2 (writes nothing)\n")
    t1_allowlists()
    t2_vocabulary()
    t3_refusals()
    t4_carry_forward()
    t5_cross_language()
    t6_founding_case()
    t7_export_and_gaps()
    print(f"\n{'-' * 60}")
    if SKIPS:
        print(f"SKIPPED (uncounted, never a pass): {len(SKIPS)}")
        for name in SKIPS:
            print(f"  ~ {name}")
    if FAILURES:
        print(f"FAIL: {len(FAILURES)} of {CHECKS_RUN} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    tail = f" ({len(SKIPS)} skipped, not counted)" if SKIPS else ""
    print(f"OK: all {CHECKS_RUN} checks passed{tail}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
