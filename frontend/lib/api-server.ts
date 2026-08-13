import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { ApiErrorKind } from "@/lib/jobs";

/**
 * Authenticated server-to-backend fetch (checklist 3.1) — the pattern every
 * later Stage 3/4 screen inherits.
 *
 * Server components only: the `server-only` import makes a client-component
 * import fail the build instead of leaking the access token into the browser
 * bundle.
 *
 * getSession() is correct here for the TOKEN: the backend independently
 * re-validates every JWT remotely via auth.get_user, and the (app) layout
 * already calls getUser() for authentication.
 *
 * NEVER THROWS. Every failure resolves to { ok: false, kind, status, message }.
 * The token is never logged, returned or embedded in any message.
 *
 * F55 — `kind` exists because status alone conflated two unrelated faults.
 * lib/supabase/server.ts throws EXACTLY when NEXT_PUBLIC_SUPABASE_URL or
 * NEXT_PUBLIC_SUPABASE_ANON_KEY is unset, and the old catch turned that into
 * 401 "No active session" — telling an installer to re-authenticate when the
 * real fault was a missing env var (the most likely failure at 9.4, Vercel
 * deploy). `config` and `auth` are separate code paths below: one is the catch
 * around createClient()/getSession(), the other is a null token AFTER that call
 * returned normally. Neither is inferred from the other's status code.
 *
 * `ApiErrorKind` is DEFINED in lib/jobs.ts — the pure module — and re-exported
 * here, so the error copy can be unit-tested under --experimental-strip-types
 * without this server-only module ever being loaded. Consumers can import the
 * type from either place.
 */

export type { ApiErrorKind };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; status: number; message: string };

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function apiGet<T>(
  path: string,
  params?: URLSearchParams,
): Promise<ApiResult<T>> {
  // `config` path: the Supabase client could not even be constructed.
  let token: string | null;
  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    token = session?.access_token ?? null;
  } catch {
    return {
      ok: false,
      kind: "config",
      status: 500,
      message:
        "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set",
    };
  }

  // `auth` path: the client worked, there is simply nobody signed in.
  if (!token) {
    return {
      ok: false,
      kind: "auth",
      status: 401,
      message: "No active session",
    };
  }

  const query = params?.toString();
  const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    return {
      ok: false,
      kind: "network",
      status: 0, // 0 = the request never reached the server
      message: `Could not reach the backend at ${API_BASE}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      message: `${path} responded ${response.status}`,
    };
  }

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return {
      ok: false,
      kind: "parse",
      status: response.status,
      message: `${path} returned unparseable JSON`,
    };
  }
}
