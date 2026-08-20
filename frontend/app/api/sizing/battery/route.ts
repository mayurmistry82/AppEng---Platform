import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Battery-sizing hop (3.12 prompt 2) — forwards to POST /api/sizing/battery,
 * which 3.11b authenticated. A structural copy of app/api/sizing/optimise/
 * route.ts: session token from the server Supabase client, 401 when absent,
 * token never logged, POST the only verb.
 *
 * THE ENDPOINT SIZES SOLAR AND BATTERY IN ONE RUN and stores one result
 * labelled solar_battery. It does not read a stored solar result and there is
 * no ordering to encode here (D33) — this proxy carries a body and a status,
 * nothing about sequence.
 *
 * THERE IS NO FIELD WHITELIST HERE, AND THAT IS CORRECT — do not "fix" it.
 * The backend's BatteryRequest IS the whitelist: pydantic drops unknown keys
 * silently, and a second list here would be a second thing to keep in step.
 * (The screen's own restraint — job_id and at most a constraints object, never
 * objective/budget/equipment/tariff/battery_ids — is asserted by the two-sided
 * gate verify_sizing_request_contract.py, not by this proxy.)
 *
 * THE UPSTREAM STATUS AND BODY PASS THROUGH UNALTERED. Load-bearing, and the
 * reason 3.11b exists: the backend answers 404 for a job that is not yours (a
 * body byte-identical to the absent case, so existence never leaks), 403 for a
 * caller with no company, 503 when it could not check. Collapsing those into a
 * generic 500 — or worse, a 200 — would undo that work.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function POST(request: Request): Promise<NextResponse> {
  let token: string | null;
  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    token = session?.access_token ?? null;
  } catch {
    token = null;
  }
  if (!token) {
    return NextResponse.json({ detail: "No active session" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${API_BASE}/api/sizing/battery`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
