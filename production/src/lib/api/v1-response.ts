/**
 * Shared JSON responses for the public integration API (/api/v1/*).
 * Error body shape matches the integration spec: { error, code }.
 */
import { NextResponse, type NextRequest } from "next/server";

/**
 * Absolute base URL for building customer-facing links (pdf_url, payment_url)
 * from the ACTUAL host the request came in on — robust against a mis-set
 * NEXT_PUBLIC_APP_URL (a custom domain that isn't live yet would produce dead
 * links). Honours the Cloud Run proxy's x-forwarded-* headers.
 */
export function requestBaseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host  = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

export const unauthorized = () =>
  apiError(401, "unauthorized", "Invalid or missing API key");

export const notFound = (message = "Not found") =>
  apiError(404, "not_found", message);

/**
 * A database error. Until 26 Sep 2026 these routes answered 404 "Could not load …" on a
 * failed query, and a caller cannot tell that from "there is nothing": DMS's billing page
 * shows "No bills yet" on a 404, so an outage would have read as an empty account
 * (AGENTS §2). 500 says "try again", which is the truth.
 */
export const serverError = (message: string) =>
  apiError(500, "server_error", message);

export const badRequest = (message: string) =>
  apiError(400, "bad_request", message);

/**
 * Scopes an API key can carry (`api_keys.scopes`, default `{read}`).
 *
 *   read        — every GET under /api/v1/customers/* (billing status for DMS).
 *   telecalling — POST /api/v1/telecalling/make-call. It places a paid phone call in the
 *                 workspace's name, so a read-only key must not be able to reach it.
 *
 * R-050 (7 Oct 2026): until then no /api/v1 route read `scopes` at all — any key, including
 * one minted only to read billing, could ask the telecaller to ring a customer.
 */
export type ApiScope = "read" | "telecalling";

/**
 * The ONE scope gate for /api/v1. Call it right after `authenticateApiKey`:
 *
 *   const denied = requireScope(auth, "read");
 *   if (denied) return denied;
 *
 * Returns null when the key holds the scope, else a 403 that names the missing scope, so the
 * integrator knows what to ask the workspace owner for instead of guessing.
 */
export function requireScope(
  auth: { scopes?: readonly string[] | null },
  scope: ApiScope,
): NextResponse | null {
  if ((auth.scopes ?? []).includes(scope)) return null;
  return apiError(
    403,
    "insufficient_scope",
    `This API key does not have the "${scope}" scope. Ask the workspace owner for a key with the "${scope}" scope.`,
  );
}
