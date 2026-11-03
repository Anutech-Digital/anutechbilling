/**
 * R-2433 (G-NETWORK N1) — what one business shares with a connected business.
 *
 * The list must match public.network_scope_list() in
 * supabase/migrations/20261103193313_r2433_tenant_connections.sql (a test reads it).
 * Each side of a connection chooses its own scopes; revoke stops all of them.
 */

export const NETWORK_SCOPES = ["invoices", "payments", "statements", "pos", "catalogue", "partner_metrics"] as const;
export type NetworkScope = (typeof NETWORK_SCOPES)[number];

export const SCOPE_LABEL: Record<NetworkScope, string> = {
  invoices: "Invoices",
  payments: "Payments",
  statements: "Statements",
  pos: "Purchase orders",
  catalogue: "Catalogue (wholesale prices)",
  partner_metrics: "Partner metrics",
};

export const SCOPE_HINT: Record<NetworkScope, string> = {
  invoices: "Invoices you raise on them reach them as draft bills.",
  payments: "Payments you make to them reach them as payment advice.",
  statements: "They can compare your ledger with theirs.",
  pos: "Purchase orders you send them reach them as orders.",
  catalogue: "Items you mark for partners, at your partner price.",
  partner_metrics: "Your active subscriptions, seats, MRR, invoiced and paid this month, renewals due — never your customers' names.",
};

/** Scopes that already do something today; the rest start working in the next G-NETWORK parts. */
export const LIVE_SCOPES: readonly NetworkScope[] = ["partner_metrics"];

export function isNetworkScope(s: string): s is NetworkScope {
  return (NETWORK_SCOPES as readonly string[]).includes(s);
}

/** Known scopes only, each once, in NETWORK_SCOPES order (what the database stores, sorted). */
export function cleanScopes(list: readonly string[] | null | undefined): NetworkScope[] {
  const set = new Set((list ?? []).map((s) => s.trim().toLowerCase()).filter(isNetworkScope));
  return NETWORK_SCOPES.filter((s) => set.has(s));
}

export function toggleScope(list: readonly string[], scope: NetworkScope, on: boolean): NetworkScope[] {
  const cur = cleanScopes(list);
  return on ? cleanScopes([...cur, scope]) : cur.filter((s) => s !== scope);
}

/** "Invoices, Payments" — or "Nothing yet". */
export function scopesSentence(list: readonly string[] | null | undefined): string {
  const c = cleanScopes(list);
  return c.length ? c.map((s) => SCOPE_LABEL[s]).join(", ") : "Nothing yet";
}

/** GSTIN as typed → the form the database matches on. 15 characters, upper case. */
export function normalizeGstinInput(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function looksLikeGstin(raw: string): boolean {
  return /^[0-9]{2}[A-Z0-9]{13}$/.test(normalizeGstinInput(raw));
}
