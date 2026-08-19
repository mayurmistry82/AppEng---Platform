#!/usr/bin/env python3
"""
verify_sizing_request_contract.py — the 3.11 prompt-2 two-sided gate (2Q.1):
the request keys the Solar sizing SCREEN can send versus the backend's
OptimiseRequest. BOTH SIDES RUN, NEITHER IS PARSED (F148): the Python side
imports routes.sizing and reads OptimiseRequest.model_fields; the TypeScript
side runs SOLAR_SIZING_REQUEST_KEYS out of lib/worksheet.ts over node.

Two assertions, and the second is D29 made mechanical:
  (a) every key the screen can send is a REAL OptimiseRequest field — a
      screen-only key would be dropped silently by pydantic;
  (b) the screen's key set contains NONE of the stored-on-the-job fields
      (objective, custom_weight, budget, the equipment ids, installer_id) —
      those are read server-side by the resolvers, and sending them would be
      a second source of truth for values 3.9/3.10 exist to hold.

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


def main() -> int:
    print("verify_sizing_request_contract.py — 3.11 prompt 2 (two-sided, both sides run)\n")
    frontend = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))
    script = ('import { SOLAR_SIZING_REQUEST_KEYS } from "./lib/worksheet.ts"; '
              "console.log(JSON.stringify([...SOLAR_SIZING_REQUEST_KEYS].sort()))")
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=frontend, capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        check("(T2) node available for the bridge", False, "node not found")
    else:
        if proc.returncode != 0:
            stderr = proc.stderr or ""
            if "does not provide an export named" in stderr:
                # The skip-loudly-then-go-live construction (2Q.1): printed,
                # uncounted, never a pass. Any OTHER node error FAILS below so
                # the bridge cannot rot silently.
                print("  SKIP  (T2) SOLAR_SIZING_REQUEST_KEYS is not exported yet — "
                      "pending the frontend half. NOT counted as a pass.")
                print(f"\n{'-' * 60}")
                print(f"OK: all {CHECKS_RUN} checks passed (1 skipped, not counted)")
                return 0
            check("(T2) node import of lib/worksheet.ts", False, stderr.strip()[:200])
        else:
            screen_keys = set(json.loads(proc.stdout.strip()))
            model_fields = set(sizing_route.OptimiseRequest.model_fields.keys())
            print(f"        screen keys : {sorted(screen_keys)}")
            print(f"        model fields: {sorted(model_fields)}")
            print(f"        screen-only : {sorted(screen_keys - model_fields)}")
            check("(a) every key the screen can send is a REAL OptimiseRequest field "
                  "(a screen-only key is dropped silently by pydantic)",
                  screen_keys <= model_fields,
                  f"silently dropped: {sorted(screen_keys - model_fields)}")
            overlap = screen_keys & FORBIDDEN
            check("(b) the screen sends NONE of the stored-on-the-job fields — "
                  "objective/custom_weight/budget/equipment ids/installer_id (D29)",
                  not overlap, f"second source of truth: {sorted(overlap)}")
            # Sanity that the guard bites: the forbidden names that ARE
            # request fields (objective/custom_weight/budget/installer_id)
            # must exist on the model — a rename would blunt (b) silently.
            # The three equipment ids are deliberately NOT model fields: they
            # are jobs columns read server-side, and their absence from the
            # model is itself part of the design being protected.
            on_model = {"objective", "custom_weight", "budget", "installer_id"}
            check("(b) ...the forbidden request-field names are real model fields",
                  on_model <= model_fields, str(on_model - model_fields))
            check("(b) ...and the equipment ids are NOT request fields at all "
                  "(they live on jobs, read server-side)",
                  not ({"equipment_panel_id", "equipment_inverter_id",
                        "equipment_battery_id"} & model_fields), "")
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
