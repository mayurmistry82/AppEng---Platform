import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Tariff & network hop (3.8 prompt 2) — the same pattern as
 * app/api/job/[id]/demand/route.ts: session read server-side, Bearer attached,
 * explicit field whitelist, upstream status passed through, token never logged
 * or returned. The whitelist matches routes/demand.py's TariffSaveRequest
 * exactly — seven fields, nothing else forwarded — and the job id comes from
 * the ROUTE PATH, never the body.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface TariffBody {
  tariff_type?: unknown;
  import_rate?: unknown;
  tou_windows?: unknown;
  supply_charge?: unknown;
  fit_aud_per_kwh?: unknown;
  export_limit_kw?: unknown;
  source?: unknown;
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

  let raw: TariffBody;
  try {
    raw = (await request.json()) as TariffBody;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const body = {
    tariff_type: raw.tariff_type ?? null,
    import_rate: raw.import_rate ?? null,
    tou_windows: raw.tou_windows ?? null,
    supply_charge: raw.supply_charge ?? null,
    fit_aud_per_kwh: raw.fit_aud_per_kwh ?? null,
    export_limit_kw: raw.export_limit_kw ?? null,
    source: raw.source ?? null,
  };

  try {
    const upstream = await fetch(
      `${API_BASE}/api/job/${encodeURIComponent(id)}/tariff`,
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
