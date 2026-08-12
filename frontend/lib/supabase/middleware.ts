import {
  createServerClient,
  type CookieMethodsServer,
} from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables — copy .env.local.example to .env.local and fill in values",
    );
  }

  // Explicit CookieMethodsServer annotation collapses the CookieMethodsServer |
  // CookieMethodsServerDeprecated union createServerClient's `cookies` option accepts —
  // TypeScript won't contextually type a method param inside an object literal against a
  // union, so without this `cookiesToSet` falls back to implicit `any` under strict.
  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return request.cookies.getAll();
    },
    setAll(cookiesToSet) {
      cookiesToSet.forEach(({ name, value }) =>
        request.cookies.set(name, value),
      );
      supabaseResponse = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) =>
        supabaseResponse.cookies.set(name, value, options),
      );
    },
  };

  const supabase = createServerClient(url, key, { cookies: cookieMethods });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // DENY BY DEFAULT (2026-08-11). Every route requires a session unless it is
  // explicitly listed here. The previous guard protected an allowlist of paths
  // (`pathname.startsWith("/dashboard")`), which meant every route added later
  // shipped publicly reachable by default — that is exactly how the /jobs tree
  // would have gone out unprotected. With deny-by-default, a future /settings
  // cannot silently ship open: forgetting this file leaves it locked, not exposed.
  // (Static assets never reach here — the matcher in middleware.ts excludes them.)
  const PUBLIC_PATHS = new Set<string>(["/login"]);

  if (!user && !PUBLIC_PATHS.has(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  // Authenticated home is /jobs, NOT /dashboard — deliberate change, 2026-08-11.
  // The old /dashboard tree stays reachable by direct URL (and via the rail's
  // Legacy item) until 3.16 retires it.
  if (user && pathname === "/") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/jobs";
    return NextResponse.redirect(redirectUrl);
  }

  // Authenticated user landing on /login → push to /jobs.
  if (user && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/jobs";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
