import type { ApiErrorKind } from "@/lib/jobs";

/**
 * The shared client-side POST for every user-initiated call (3.4-E).
 *
 * Mirrors lib/api-server.ts's result shape deliberately, so the server half and
 * the client half of the app fail in the same vocabulary and one `kind` switch
 * covers both. `ApiErrorKind` is imported, never redefined — a second copy of
 * that union is how the two halves would drift apart.
 *
 * NEVER THROWS, for any response. Before F97 was fixed, an expired session came
 * back as a 307 to an HTML login page: `res.ok` was true, the caller parsed HTML
 * as JSON, threw, and the button appeared to do nothing at all. The middleware
 * now answers 401 for /api/* — the `parse` branch below is belt and braces for
 * the day something else (a proxy, a future change) puts HTML on the wire again.
 *
 * Client-side only: uses fetch, imports nothing server-only.
 */

export type ClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; status: number; message: string };

/** `detail` from a JSON error body, when it is actually a string. */
function detailOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" && detail ? detail : null;
}

/**
 * The general JSON request (3.3c, F100 closed) — postJson's never-throws
 * contract, byte-for-byte, with the method as a parameter: read the body ONCE
 * as text, the 401 branch, the parse branch with the REAL status, the !ok
 * branch, the same ClientResult shape. postJson below is now a one-line
 * delegation to this, so the two cannot drift.
 */
export async function requestJson<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: unknown,
): Promise<ClientResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // status 0 — the request never reached the server.
    return { ok: false, kind: "network", status: 0, message: `Could not reach ${path}` };
  }

  // Read the body ONCE, as text, so an HTML response cannot throw on .json().
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  let parsed: unknown;
  let parseFailed = false;
  if (raw === "") {
    parsed = null; // an empty body is not a parse failure
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseFailed = true;
    }
  }

  if (response.status === 401) {
    // Auth regardless of what the body turned out to be — the copy never depends
    // on parsing it, so an empty or HTML 401 still reads as an expired session.
    return {
      ok: false,
      kind: "auth",
      status: 401,
      message: detailOf(parsed) ?? "No active session",
    };
  }

  if (parseFailed) {
    return {
      ok: false,
      kind: "parse",
      status: response.status, // the REAL status, not a synthetic one
      message: `${path} returned a response that could not be read`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      message: detailOf(parsed) ?? `${path} responded ${response.status}`,
    };
  }

  return { ok: true, data: parsed as T };
}

export async function postJson<T>(
  path: string,
  body: unknown,
): Promise<ClientResult<T>> {
  return requestJson<T>("POST", path, body);
}

/**
 * Multipart POST (3.6) — same ClientResult shape and the same never-throws
 * contract as postJson, including the 401 branch and the read-body-once-as-
 * text protection. Added ALONGSIDE postJson (F100): postJson and ApiErrorKind
 * are untouched, so 3.3c's planned requestJson cannot collide with this.
 *
 * DELIBERATELY SETS NO Content-Type HEADER: the browser must generate the
 * multipart boundary itself. Setting Content-Type by hand omits the boundary,
 * and the server then silently fails to parse the form — the classic multipart
 * bug, asserted against in verify-worksheet-logic.ts.
 */
export async function postFormData<T>(
  path: string,
  form: FormData,
): Promise<ClientResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", body: form });
  } catch {
    return { ok: false, kind: "network", status: 0, message: `Could not reach ${path}` };
  }

  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  let parsed: unknown;
  let parseFailed = false;
  if (raw === "") {
    parsed = null;
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseFailed = true;
    }
  }

  if (response.status === 401) {
    return {
      ok: false,
      kind: "auth",
      status: 401,
      message: detailOf(parsed) ?? "No active session",
    };
  }

  if (parseFailed) {
    return {
      ok: false,
      kind: "parse",
      status: response.status,
      message: `${path} returned a response that could not be read`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      message: detailOf(parsed) ?? `${path} responded ${response.status}`,
    };
  }

  return { ok: true, data: parsed as T };
}
