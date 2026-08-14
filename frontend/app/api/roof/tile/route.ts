import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Satellite tile hop (3.4-B). Streams the backend's proxied Maps Static bytes
 * with the upstream content type and cache header. The Google key lives ONLY
 * in backend/.env (F40) — it never appears here, in an <img> src, or anywhere
 * the browser can see. 401 with no session; 502 on upstream failure, never a
 * zero-byte 200 (the browser renders that as a broken image).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function GET(request: Request): Promise<Response> {
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

  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of ["lat", "lng", "zoom"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }

  try {
    const upstream = await fetch(`${API_BASE}/api/roof/tile?${params.toString()}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!upstream.ok) {
      return NextResponse.json({ detail: "map tile unavailable" }, { status: 502 });
    }
    const contentType = upstream.headers.get("Content-Type") ?? "image/png";
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ detail: "map tile unavailable" }, { status: 502 });
  }
}
