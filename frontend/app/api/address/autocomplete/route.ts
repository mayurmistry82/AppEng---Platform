import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Address autocomplete proxy hop (checklist 3.2) — the project's first Route
 * Handler. Exists because the browser must never hold the Supabase access
 * token and lib/api-server.ts is `server-only` (and GET-shaped): this handler
 * reads the session server-side, attaches the Bearer token, and forwards to
 * the authenticated FastAPI proxy, which in turn holds the Google key.
 *
 * The token is never logged and never returned. No session → 401.
 * Upstream failures return an empty suggestion list — the New Job address
 * field must keep working as plain text, never blocked by the suggester.
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
    return NextResponse.json({ suggestions: [] }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ suggestions: [] }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${API_BASE}/api/address/autocomplete`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) {
      return NextResponse.json({ suggestions: [] }, { status: upstream.status });
    }
    return NextResponse.json(await upstream.json());
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
