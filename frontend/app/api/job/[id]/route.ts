import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Job-field update hop (3.4b) — forwards to PATCH /api/job/{id}, the backend's
 * ONE job-field writer. Same pattern as app/api/job/create/route.ts: session
 * token from the server Supabase client, 401 when absent, explicit whitelist of
 * the same sixteen fields the backend accepts, upstream status passed through,
 * token never logged.
 *
 * ABSENT vs NULL is preserved through the whitelist: a key is forwarded only
 * when the client actually sent it, and an explicit null travels as null — the
 * backend clears that column. Forwarding all sixteen unconditionally would
 * turn every partial save into a sixteen-field wipe.
 *
 * The dynamic segment is the job id — validated non-empty and forwarded, no
 * further: the backend does the ownership check (404 absent/foreign, F88 503).
 *
 * The POST alias is GONE (3.3c): client-api.ts now speaks every method via
 * requestJson (F100 closed), so PATCH is the only verb this route answers and
 * both browser callers — the site-details section and the job-edit dialog —
 * use it.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const FIELDS = [
  "storeys",
  "roof_material",
  "dwelling_type",
  "year_built",
  "bedrooms",
  "floor_area_m2",
  "electrical_phase",
  // 3.3c — the job-bar edit fields. customer_name and address land on
  // job_customers server-side; the proxy just whitelists and forwards.
  "customer_name",
  "has_existing_solar",
  "existing_solar_kw",
  "existing_inverter_kw",
  "intent",
  "address",
  // 3.9 — the optimisation inputs. Same absent-vs-null rule as the rest.
  "objective",
  "custom_weight",
  "budget_aud",
] as const;

async function forward(
  request: Request,
  params: Promise<{ id: string }>,
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
  if (typeof id !== "string" || id.trim() === "") {
    return NextResponse.json({ detail: "Missing job id" }, { status: 400 });
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  // Whitelist, preserving absent-vs-null: only keys the client actually sent.
  const body: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      body[field] = raw[field];
    }
  }

  try {
    const upstream = await fetch(
      `${API_BASE}/api/job/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const payload = await upstream
      .json()
      .catch(() => ({ detail: "Unreadable response" }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch {
    return NextResponse.json(
      { detail: "Could not reach the backend" },
      { status: 502 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return forward(request, context.params);
}

