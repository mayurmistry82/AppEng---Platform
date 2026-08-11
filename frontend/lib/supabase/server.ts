import {
  createServerClient,
  type CookieMethodsServer,
} from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables — copy .env.local.example to .env.local and fill in values",
    );
  }

  const cookieStore = await cookies();

  // Explicit CookieMethodsServer annotation collapses the CookieMethodsServer |
  // CookieMethodsServerDeprecated union createServerClient's `cookies` option accepts —
  // TypeScript won't contextually type a method param inside an object literal against a
  // union, so without this `cookiesToSet` falls back to implicit `any` under strict.
  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return cookieStore.getAll();
    },
    setAll(cookiesToSet) {
      try {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options),
        );
      } catch {
        // Called from a Server Component — cookies are read-only here.
        // The session is refreshed in middleware, so this is safe to ignore.
      }
    },
  };

  return createServerClient(url, key, { cookies: cookieMethods });
}
