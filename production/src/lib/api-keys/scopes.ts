/**
 * The scopes an owner can give an API key (R-327).
 *
 * The names are exactly what `requireScope()` in `src/lib/api/v1-response.ts` (R-050)
 * checks — `ApiScope` is the source of truth, and the assertion below fails the
 * type-check if a scope is added there and not here (or the other way round).
 *
 * Client-safe: only a type is imported from v1-response, so nothing server-side ships.
 */
import type { ApiScope } from "@/lib/api/v1-response";

export const API_SCOPES = ["read", "telecalling"] as const satisfies readonly ApiScope[];

/** Compile-time: every ApiScope is listed in API_SCOPES. */
type MissingScope = Exclude<ApiScope, (typeof API_SCOPES)[number]>;
const _everyScopeListed: [MissingScope] extends [never] ? true : never = true;
void _everyScopeListed;

export const SCOPE_LABEL: Record<ApiScope, { name: string; hint: string }> = {
  read:        { name: "Read",        hint: "Customers, subscriptions, invoices, quotes, payments" },
  telecalling: { name: "Telecalling", hint: "Place AI phone calls (paid) via make-call" },
};

/** Default for a new key when the request names no scopes — same as the column default. */
export const DEFAULT_SCOPES: ApiScope[] = ["read"];

/**
 * Validate scopes from a request body. Returns them de-duplicated in canonical order,
 * or null when the input is not a non-empty array of known scope names.
 */
export function parseScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const known = new Set<string>(API_SCOPES);
  if (!input.every((s) => typeof s === "string" && known.has(s))) return null;
  return API_SCOPES.filter((s) => input.includes(s));
}
