import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Bill upload hop (3.6 prompt 3) — the multipart sibling of
 * app/api/interval/upload/route.ts: session read server-side, Bearer attached,
 * token never logged or returned, upstream status passed through, 502 when the
 * backend is unreachable.
 *
 * The FormData is REBUILT with a whitelist of `file` ONLY. The job id comes
 * from the ROUTE PATH, never from the body — a job id a client can put in the
 * payload is a job id it can change.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return NextResponse.json({ detail: "Invalid multipart body" }, { status: 400 });
  }
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "A file is required" }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.append("file", file, file.name);

  try {
    const upstream = await fetch(
      `${API_BASE}/api/job/${encodeURIComponent(id)}/bill`,
      {
        method: "POST",
        cache: "no-store",
        // No Content-Type: fetch derives the multipart boundary from the body.
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        body: outgoing,
      },
    );
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
