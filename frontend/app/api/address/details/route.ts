import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Place-details proxy hop (checklist 3.2) — companion to
 * app/api/address/autocomplete. One call per completed address lookup,
 * carrying the same session token that the keystroke requests used, which is
 * what closes the Google billing session.
 *
 * The Supabase token is never logged and never returned. No session → 401.
 * Any failure returns nulls — selection then simply keeps the suggestion's
 * description text as the address, and the job stays creatable.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const EMPTY = { formatted_address: null, lat: null, lng: null };

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
    return NextResponse.json(EMPTY, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(EMPTY, { status: 400 });
  }

  try {
    const upstream = await fetch(`${API_BASE}/api/address/details`, {
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
      return NextResponse.json(EMPTY, { status: upstream.status });
    }
    return NextResponse.json(await upstream.json());
  } catch {
    return NextResponse.json(EMPTY);
  }
}
