import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Roof confirmation hop (3.4c prompt 4, D24) — same pattern as
 * app/api/roof/manual/route.ts: session token from the server client, Bearer
 * forwarded, backend's status and body returned verbatim, token never logged
 * or returned.
 *
 * THE SOURCE IS ALWAYS "installer" HERE, set by this handler and never read
 * from the client. The person at this screen is the installer; "customer"
 * exists in the backend's CONFIRMED_SOURCES for row 8.4, where the homeowner
 * answers on their own phone. A chooser would be a control storing a claim
 * nothing can check — the shape D29 rejected.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface ConfirmBody {
  job_id?: unknown;
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

  let raw: ConfirmBody;
  try {
    raw = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const body = {
    job_id: raw.job_id,
    source: "installer",
  };

  try {
    const upstream = await fetch(`${API_BASE}/api/roof/confirm`, {
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
