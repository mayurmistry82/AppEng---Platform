import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Solar-sizing hop (3.11 prompt 2) — forwards to POST /api/sizing/optimise,
 * which 1b just authenticated. Same pattern as app/api/equipment/[kind]/
 * route.ts: session token from the server Supabase client, 401 when absent,
 * token never logged, POST the only verb.
 *
 * THERE IS NO FIELD WHITELIST HERE, AND THAT IS CORRECT — do not "fix" it.
 * The backend's OptimiseRequest IS the whitelist: pydantic drops unknown keys
 * silently, and a second list here would be a second thing to keep in step.
 * (The screen's own restraint — job_id and at most a fix_solar_kwp constraint,
 * never objective/budget/equipment/tariff fields — is asserted by the
 * two-sided gate verify_sizing_request_contract.py, not by this proxy.)
 *
 * THE UPSTREAM STATUS AND BODY PASS THROUGH UNALTERED. Load-bearing, and the
 * reason 1b exists: the backend answers 404 for a job that is not yours (a
 * body byte-identical to the absent case, so existence never leaks), 403 for
 * a caller with no company, 503 when it could not check. Collapsing those
 * into a generic 500 — or worse, a 200 — would undo that work.
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
    const upstream = await fetch(`${API_BASE}/api/sizing/optimise`, {
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
