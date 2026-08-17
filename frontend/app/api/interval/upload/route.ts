import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Interval upload hop (3.6 prompt 2) — the multipart sibling of
 * app/api/roof/geometry/route.ts: session read server-side, Bearer attached,
 * explicit field whitelist, upstream status passed through, token never logged
 * or returned, 502 when the backend is unreachable.
 *
 * The whitelist is `file`, `job_id`, `include_controlled_load` and NOTHING
 * else. `installer_id` no longer exists on the backend (identity comes from
 * the validated token, never the payload) — if a client still sends one it is
 * dropped silently, not forwarded.
 *
 * The backend REQUIRES job_id, so a missing one is answered HERE with a
 * readable 400 rather than a forwarded 422.
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
    return NextResponse.json({ detail: "No active session" }, { status: 401 });
  }

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return NextResponse.json({ detail: "Invalid multipart body" }, { status: 400 });
  }

  const file = incoming.get("file");
  const jobId = incoming.get("job_id");
  const includeControlledLoad = incoming.get("include_controlled_load");

  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "A file is required" }, { status: 400 });
  }
  if (typeof jobId !== "string" || jobId === "") {
    return NextResponse.json(
      { detail: "job_id is required — the upload must belong to a job" },
      { status: 400 },
    );
  }

  // Rebuilt from scratch: only whitelisted fields ever reach the backend.
  const outgoing = new FormData();
  outgoing.append("file", file, file.name);
  outgoing.append("job_id", jobId);
  if (typeof includeControlledLoad === "string" && includeControlledLoad !== "") {
    outgoing.append("include_controlled_load", includeControlledLoad);
  }

  try {
    const upstream = await fetch(`${API_BASE}/api/interval/upload`, {
      method: "POST",
      cache: "no-store",
      // No Content-Type header: fetch derives the multipart boundary from the
      // FormData body. Setting it by hand would strip the boundary.
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: outgoing,
    });
    const payload = await upstream.json().catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json({ detail: "Could not reach the backend" }, { status: 502 });
  }
}
