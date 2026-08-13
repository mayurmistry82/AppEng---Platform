import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Job creation hop (checklist 3.2). NOT in the prompt's file list — created
 * because submission must go "via a Route Handler or server action carrying
 * the Bearer token", and no listed file can serve all three triggers: the
 * AppRail trigger lives under the frozen (app) layout, so a page-level server
 * action cannot reach it. Reported as a deviation.
 *
 * Forwards ONLY the whitelisted JobCreateRequest fields to POST /api/job.
 * `path`, `company_id`, `installer_id` are never sent — path is a GENERATED
 * column and identity comes from the token (backend/routes/job.py). The
 * Supabase token is never logged and never returned.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface CreateBody {
  address?: unknown;
  customer_name?: unknown;
  has_existing_solar?: unknown;
  existing_solar_kw?: unknown;
  existing_inverter_kw?: unknown;
  intent?: unknown;
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

  let raw: CreateBody;
  try {
    raw = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  // Explicit whitelist — nothing else crosses, whatever the client sent.
  const body = {
    address: raw.address,
    customer_name: raw.customer_name ?? null,
    has_existing_solar: raw.has_existing_solar ?? null,
    existing_solar_kw: raw.existing_solar_kw ?? null,
    existing_inverter_kw: raw.existing_inverter_kw ?? null,
    intent: raw.intent ?? null,
  };

  try {
    const upstream = await fetch(`${API_BASE}/api/job`, {
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
    return NextResponse.json(
      { detail: "Could not reach the backend" },
      { status: 502 },
    );
  }
}
