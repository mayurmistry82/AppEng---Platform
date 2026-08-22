import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Sizing-history hop (3.14 prompt 7) — forwards to GET /api/sizing/runs, which
 * is authenticated by the same dependency and the same ownership check as the
 * two sizing endpoints. A structural copy of app/api/sizing/battery/route.ts:
 * session token from the server Supabase client, 401 when absent, token never
 * logged. GET rather than POST, so the query string carries the arguments and
 * there is no body at all.
 *
 * THERE IS NO FIELD WHITELIST HERE, AND THAT IS CORRECT — do not "fix" it. The
 * backend's own signature IS the whitelist: FastAPI ignores unknown query
 * parameters and clamps limit/offset itself, and a second list here would be a
 * second thing to keep in step.
 *
 * THE UPSTREAM STATUS AND BODY PASS THROUGH UNALTERED, for the same reason the
 * battery hop does: the backend answers 404 for a job that is not yours (a body
 * byte-identical to the absent case, so existence never leaks), 403 for a caller
 * with no company, 503 when it could not check. Collapsing those into a generic
 * 500 — or worse, a 200 — would undo 3.11b.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the evaluated options, any cost
 * breakdown, and the run assumptions. Those are the heavy half; the compare
 * screen fetches them for the two runs a person actually opens.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function GET(request: Request): Promise<NextResponse> {
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

  // The caller's query string, forwarded whole — job_id, limit, offset. The
  // backend validates and clamps; this hop carries, it does not judge.
  const query = new URL(request.url).searchParams.toString();

  try {
    const upstream = await fetch(
      `${API_BASE}/api/sizing/runs${query ? `?${query}` : ""}`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
