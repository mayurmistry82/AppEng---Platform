import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Roof lookup hop (3.4-B) — same pattern as app/api/job/create/route.ts:
 * session read server-side, Bearer attached, explicit field whitelist, upstream
 * status passed through, token never logged or returned.
 *
 * `persist` is DELIBERATELY not forwardable: the server always persists a real
 * user action, and a client must not be able to ask for a silent no-op.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface GeometryBody {
  address?: unknown;
  job_id?: unknown;
  panel_id?: unknown;
  usability_factor?: unknown;
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

  let raw: GeometryBody;
  try {
    raw = (await request.json()) as GeometryBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  // Explicit whitelist — persist is never forwarded, whatever the client sent.
  const body = {
    address: raw.address,
    job_id: raw.job_id ?? null,
    panel_id: raw.panel_id ?? null,
    usability_factor: raw.usability_factor ?? null,
  };

  try {
    const upstream = await fetch(`${API_BASE}/api/roof/geometry`, {
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
