import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Manual roof entry hop (3.4-B, OI-10) — same pattern as
 * app/api/job/create/route.ts. Explicit field whitelist; `persist` is never
 * forwarded (the server always persists a real user action); token never
 * logged or returned.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface ManualBody {
  job_id?: unknown;
  basis?: unknown;
  planes?: unknown;
  panel_id?: unknown;
  usability_factor?: unknown;
  note?: unknown;
  prefilled_from_lookup?: unknown;
}

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

  let raw: ManualBody;
  try {
    raw = (await request.json()) as ManualBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const body = {
    job_id: raw.job_id,
    basis: raw.basis,
    planes: raw.planes,
    panel_id: raw.panel_id ?? null,
    usability_factor: raw.usability_factor ?? null,
    note: raw.note ?? null,
    // 3.4-D provenance. `planes` is forwarded WHOLE (not field-picked), so each
    // plane's `label` already travels with it.
    prefilled_from_lookup: raw.prefilled_from_lookup === true,
  };

  try {
    const upstream = await fetch(`${API_BASE}/api/roof/manual`, {
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
