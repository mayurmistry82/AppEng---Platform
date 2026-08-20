#!/usr/bin/env python3
"""
verify_sizing_request_contract.py — the two-sided gate (2Q.1): the request keys
each SIZING SCREEN can send versus the backend model it posts to. BOTH SIDES
RUN, NEITHER IS PARSED (F148): the Python side imports routes.sizing and reads
the model's model_fields; the TypeScript side runs the screen's key constant
out of lib/worksheet.ts over node.

Two screens, one rule (3.11 prompt 2 solar, 3.12 prompt 2 battery):
  SOLAR_SIZING_REQUEST_KEYS   vs OptimiseRequest
  BATTERY_SIZING_REQUEST_KEYS vs BatteryRequest

Two assertions per screen, and the second is D29 made mechanical:
  (a) every key the screen can send is a REAL field on that model — a
      screen-only key would be dropped silently by pydantic;
  (b) the screen's key set contains NONE of the stored-on-the-job fields
      (objective, custom_weight, budget, the equipment ids, installer_id, and
      for the battery endpoint also battery_ids and tou_windows) — those are
      read server-side by the resolvers, and sending them would be a second
      source of truth for values 3.8/3.9/3.10 exist to hold.

Offline apart from the node bridge. WRITES NOTHING.

Run:  /opt/anaconda3/bin/python3 backend/scripts/verify_sizing_request_contract.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import traceback

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

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


FORBIDDEN = {
    "objective", "custom_weight", "budget",
    "equipment_panel_id", "equipment_inverter_id", "equipment_battery_id",
    "installer_id",
}

# 3.12 — the battery endpoint can ALSO be told which batteries to consider and
# what the tariff is. Both are stored on the job (3.8's tariffs row, 3.10's
# equipment) and resolved server-side, so the screen must send neither.
# import_rates_24 is the SAME tariff fact in its other accepted shape: leaving
# it out would let the one field 3.8 exists to hold travel from the browser
# under a different name.
FORBIDDEN_BATTERY = FORBIDDEN | {"battery_ids", "tou_windows", "import_rates_24"}


def _screen_keys(constant: str) -> tuple[set[str] | None, str]:
    """Run one screen's key constant out of lib/worksheet.ts over node.
    Returns (keys, ""), (None, "skip") for the missing-export signature only,
    or (None, <stderr>) for any other failure — which FAILS, so the bridge
    cannot rot silently."""
    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    script = (f'import {{ {constant} }} from "./lib/worksheet.ts"; '
              f"console.log(JSON.stringify([...{constant}].sort()))")
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
        return None, stderr.strip()[:200]
    return set(json.loads(proc.stdout.strip())), ""


def check_screen(label: str, constant: str, model, forbidden: set[str]) -> int:
    """One screen against its own model. Returns the number of SKIPPED checks
    (0 or 1) — a skip is printed, uncounted, and NEVER a pass (2Q.1)."""
    print(f"\n{label} — {constant} vs {model.__name__}")
    keys, err = _screen_keys(constant)
    if keys is None:
        if err == "skip":
            print(f"  SKIP  {constant} is not exported yet — pending the "
                  "frontend half. NOT counted as a pass.")
            return 1
        check(f"({label}) node import of lib/worksheet.ts", False, err)
        return 0

    model_fields = set(model.model_fields.keys())
    print(f"        screen keys : {sorted(keys)}")
    print(f"        model fields: {sorted(model_fields)}")
    print(f"        screen-only : {sorted(keys - model_fields)}")
    check(f"({label} a) every key the screen can send is a REAL "
          f"{model.__name__} field (a screen-only key is dropped silently "
          "by pydantic)",
          keys <= model_fields, f"silently dropped: {sorted(keys - model_fields)}")
    overlap = keys & forbidden
    check(f"({label} b) the screen sends NONE of the stored-on-the-job "
          f"fields — {'/'.join(sorted(forbidden))} (D29)",
          not overlap, f"second source of truth: {sorted(overlap)}")
    # Sanity that the guard bites: the forbidden names that ARE request fields
    # must exist on the model — a rename would blunt (b) silently. The three
    # equipment ids are deliberately NOT model fields: they are jobs columns
    # read server-side, and their absence is itself part of the design.
    on_model = {"objective", "custom_weight", "budget", "installer_id"} & forbidden
    check(f"({label} b) ...the forbidden request-field names are real model fields",
          on_model <= model_fields, str(on_model - model_fields))
    check(f"({label} b) ...and the equipment ids are NOT request fields at all "
          "(they live on jobs, read server-side)",
          not ({"equipment_panel_id", "equipment_inverter_id",
                "equipment_battery_id"} & model_fields), "")
    return 0


def main() -> int:
    print("verify_sizing_request_contract.py — two-sided, both sides run "
          "(3.11 solar + 3.12 battery)\n")
    skipped = 0
    skipped += check_screen("T2/solar", "SOLAR_SIZING_REQUEST_KEYS",
                            sizing_route.OptimiseRequest, FORBIDDEN)
    # 3.12 — the battery screen posts to a DIFFERENT model, so its keys are
    # checked against BatteryRequest, never against OptimiseRequest. Asserting
    # one screen's keys against the other's model would pass while the real
    # contract drifted.
    skipped += check_screen("T2/battery", "BATTERY_SIZING_REQUEST_KEYS",
                            sizing_route.BatteryRequest, FORBIDDEN_BATTERY)
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
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("\nFAIL: the verifier itself crashed")
        sys.exit(2)
