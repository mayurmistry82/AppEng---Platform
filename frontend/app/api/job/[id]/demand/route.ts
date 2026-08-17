import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Demand characterisation hop (3.6 prompt 3) — same pattern as
 * app/api/roof/geometry/route.ts: session read server-side, Bearer attached,
 * explicit field whitelist, upstream status passed through, token never logged
 * or returned. The whitelist matches routes/load.py's LoadCharacteriseRequest
 * exactly; nothing else is forwarded, and the job id comes from the ROUTE
 * PATH, never the body.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface DemandBody {
  annual_kwh?: unknown;
  daily_avg_kwh?: unknown;
  household_size?: unknown;
  hot_water?: unknown;
  appliances?: unknown;
  occupancy?: unknown;
  tariff_type?: unknown;
  occupancy_grid?: unknown;
  interval_profile?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ detail: "A job id is required" }, { status: 400 });
  }

  let raw: DemandBody;
  try {
    raw = (await request.json()) as DemandBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const body = {
    annual_kwh: raw.annual_kwh ?? null,
    daily_avg_kwh: raw.daily_avg_kwh ?? null,
    household_size: raw.household_size ?? null,
    hot_water: raw.hot_water ?? null,
    appliances: raw.appliances ?? null,
    occupancy: raw.occupancy ?? null,
    tariff_type: raw.tariff_type ?? null,
    occupancy_grid: raw.occupancy_grid ?? null,
    interval_profile: raw.interval_profile ?? null,
  };

  try {
    const upstream = await fetch(
      `${API_BASE}/api/job/${encodeURIComponent(id)}/demand`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
