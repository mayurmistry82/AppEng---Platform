import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Custom-equipment save hop (3.10 prompt 3) — forwards to POST
 * /api/equipment/{kind}, the backend's "Other / New" write path. Same pattern
 * as app/api/job/[id]/route.ts: session token from the server Supabase client,
 * 401 when absent, dynamic segment validated, upstream status passed through
 * unaltered, token never logged.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE JOB PROXY:
 *
 * 1. THERE IS NO FIELD WHITELIST HERE, AND THAT IS CORRECT — do not "fix" it.
 *    The backend's three per-kind pydantic models ARE the whitelist: they drop
 *    unknown keys silently, which is exactly how the server-fixed fields
 *    (origin, owner_company_id, verified, status, promoted_from, id) are
 *    protected. A second list here would be a second place to keep in step
 *    with three models that differ per kind — the drift this project keeps
 *    finding. The job proxy needs its array because ONE backend model backs it
 *    and the absent-vs-null distinction has to survive the hop; neither is
 *    true here.
 *
 * 2. `kind` is checked against the same three values the backend accepts, so
 *    a typo costs no network round trip. It is a CHEAP GUARD, NOT A SECURITY
 *    BOUNDARY — the backend validates the segment independently and answers
 *    404 on its own. verify_equipment_contract.py check 8d asserts this list
 *    equals the backend's EQUIPMENT_KINDS in both directions.
 *
 * POST is the only verb. There is deliberately no GET: the catalogue is read
 * server-side through apiGet, which already attaches the session token, so a
 * GET proxy would be a second unused path to keep working.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const KINDS = ["panels", "inverters", "batteries"] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
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

  const { kind } = await params;
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ detail: "Unknown equipment kind" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${API_BASE}/api/equipment/${encodeURIComponent(kind)}`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        // Forwarded as received — see the docstring.
        body: JSON.stringify(body),
      },
    );
    // 409 / 422 / 503 details are written for the installer to read; pass them
    // through intact rather than replacing them with a generic sentence.
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
