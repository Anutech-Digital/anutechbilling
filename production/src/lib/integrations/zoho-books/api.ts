/**
 * R-1749 — the few Zoho calls this app makes. All READ, all server-side.
 *
 *   exchangeCode       authorization code → refresh token (once, at connect)
 *   mintAccessToken    refresh token → short-lived access token + expiry (R-1757: cached per tenant
 *                      by token-cache.ts — Zoho allows ~10 mints per 10 minutes)
 *   revokeToken        refresh token → revoked at Zoho (disconnect)
 *   listOrganizations  the Zoho Books organizations this login can see
 *   previewCounts      counts only: contacts, invoices (total / open), invoices carrying the
 *                      Subs Period / Service Expiry custom fields
 *
 * Errors carry a plain message and a code, NEVER a token, a code or the client secret —
 * route handlers may show `.message` to the person.
 */
import {
  ZOHO_BOOKS_API_BASE, ZOHO_REVOKE_URL, ZOHO_TOKEN_URL, type ZohoCreds,
} from "./config";

const TIMEOUT_MS = 15_000;
/** 200 per page × 50 pages = 10,000 records counted before we say "10,000+". */
export const PAGE_SIZE = 200;
export const MAX_PAGES = 50;

export class ZohoApiError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "ZohoApiError";
  }
}

type Fetch = typeof fetch;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

async function postToken(params: Record<string, string>, f: Fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(ZOHO_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ZohoApiError("Could not reach Zoho. Check the internet connection and try again.", "network");
  }
  const body = await readJson(res);
  // Zoho answers token errors with HTTP 200 and {"error": "..."}.
  if (!res.ok || typeof body.error === "string") {
    const err = typeof body.error === "string" ? body.error : `http_${res.status}`;
    const message = err === "invalid_code"
      ? "Zoho did not accept the sign-in (the code expired or was already used). Press Connect Zoho Books again."
      : err === "invalid_client" || err === "invalid_client_secret"
        ? "Zoho did not accept this server's Zoho Books app settings. The ResellerOS admin needs to check them."
        : "Zoho refused the sign-in. Press Connect Zoho Books again.";
    throw new ZohoApiError(message, err, res.status);
  }
  return body;
}

export async function exchangeCode(
  code: string, redirectUri: string, creds: ZohoCreds, f: Fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const body = await postToken({
    grant_type: "authorization_code",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    code,
  }, f);
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!refreshToken || !accessToken) {
    throw new ZohoApiError("Zoho did not give long-term access. Press Connect Zoho Books again and allow access.", "no_refresh_token");
  }
  return { refreshToken, accessToken };
}

/** Zoho's token endpoint saying "too many token requests" — NOT a sign that access ended (R-1757). */
export function isTokenRateLimit(status: number | undefined, body: Record<string, unknown>): boolean {
  if (status === 429) return true;
  const text = `${String(body.error ?? "")} ${String(body.error_description ?? "")}`.toLowerCase();
  return /access denied|too many|rate limit|try again after/.test(text);
}

export const ZOHO_BUSY_MESSAGE = "Zoho is busy — wait a minute, then press Continue.";
export const ZOHO_ACCESS_ENDED_MESSAGE =
  "Zoho Books access has ended (it was removed in Zoho, or expired). Disconnect and connect Zoho Books again.";

/**
 * Refresh token → a new access token and how long it lives. Mint sparingly: Zoho allows only
 * about ten per refresh token in ten minutes (R-1757). Callers go through token-cache.ts.
 *
 * Errors: "busy" (rate limit — wait and retry), "reconnect" (the refresh token is invalid or
 * revoked — the ONLY case that says access has ended), "network", or "token_error" (anything
 * else — try again, no disconnect advice).
 */
export async function mintAccessToken(refreshToken: string, creds: ZohoCreds, f: Fetch = fetch): Promise<{ token: string; expiresInSec: number }> {
  let res: Response;
  try {
    res = await f(ZOHO_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ZohoApiError("Could not reach Zoho. Check the internet connection and try again.", "network");
  }
  const body = await readJson(res);
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (res.ok && !body.error && token) {
    const exp = Number(body.expires_in ?? body.expires_in_sec ?? 3600);
    return { token, expiresInSec: Number.isFinite(exp) && exp > 0 ? exp : 3600 };
  }
  if (isTokenRateLimit(res.status, body)) throw new ZohoApiError(ZOHO_BUSY_MESSAGE, "busy", 429);
  const err = typeof body.error === "string" ? body.error : "";
  if (err === "invalid_code" || err === "invalid_token" || err === "invalid_grant") {
    throw new ZohoApiError(ZOHO_ACCESS_ENDED_MESSAGE, "reconnect", res.status);
  }
  if (err === "invalid_client" || err === "invalid_client_secret") {
    throw new ZohoApiError("Zoho did not accept this server's Zoho Books app settings. The ResellerOS admin needs to check them.", "invalid_client", res.status);
  }
  throw new ZohoApiError("Zoho did not give access just now. Wait a minute, then press Continue.", "token_error", res.status);
}

/** Just the token (kept for callers that do not cache). Prefer token-cache.ts getAccessToken. */
export async function accessToken(refreshToken: string, creds: ZohoCreds, f: Fetch = fetch): Promise<string> {
  return (await mintAccessToken(refreshToken, creds, f)).token;
}

/** Revoke at Zoho. Returns false instead of throwing — the local copy is removed either way. */
export async function revokeToken(refreshToken: string, f: Fetch = fetch): Promise<boolean> {
  try {
    const u = new URL(ZOHO_REVOKE_URL);
    u.searchParams.set("token", refreshToken);
    const res = await f(u.toString(), { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function booksGet(path: string, token: string, f: Fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(`${ZOHO_BOOKS_API_BASE}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ZohoApiError("Could not reach Zoho Books. Try again in a minute.", "network");
  }
  const body = await readJson(res);
  if (!res.ok || (typeof body.code === "number" && body.code !== 0)) {
    const message = res.status === 429
      ? "Zoho Books is limiting requests right now. Try again in a few minutes."
      : res.status === 401
        ? "Zoho Books refused access. Disconnect and connect Zoho Books again."
        : "Zoho Books returned an error. Try again; if it repeats, disconnect and connect again.";
    throw new ZohoApiError(message, `books_${typeof body.code === "number" ? body.code : res.status}`, res.status);
  }
  return body;
}

export interface ZohoOrg { id: string; name: string }

export async function listOrganizations(token: string, f: Fetch = fetch): Promise<ZohoOrg[]> {
  const body = await booksGet("/organizations", token, f);
  const rows = Array.isArray(body.organizations) ? (body.organizations as Array<Record<string, unknown>>) : [];
  return rows
    .map((o) => ({ id: String(o.organization_id ?? ""), name: String(o.name ?? "").trim() }))
    .filter((o) => o.id);
}

/** Letters and digits only, lower case: "CF.Subs Period" / "cf_subs_period" → "subsperiod". */
function squash(s: string): string {
  return s.toLowerCase().replace(/^cf[._]/, "").replace(/[^a-z0-9]/g, "");
}

const SUBS_PERIOD = new Set(["subsperiod", "subscriptionperiod"]);
const SERVICE_EXPIRY = new Set(["serviceexpiry", "serviceexpirydate"]);

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/**
 * Does this invoice carry a non-empty custom field whose name is one of `names`?
 * Zoho sends custom fields two ways — a `custom_fields` array ({label, api_name, value}) and
 * flat `cf_<api_name>` keys — so both are read.
 */
export function invoiceHasField(inv: Record<string, unknown>, names: Set<string>): boolean {
  const arr = Array.isArray(inv.custom_fields) ? (inv.custom_fields as Array<Record<string, unknown>>) : [];
  for (const cf of arr) {
    const n1 = squash(String(cf.label ?? ""));
    const n2 = squash(String(cf.api_name ?? ""));
    if ((names.has(n1) || names.has(n2)) && hasValue(cf.value ?? cf.value_formatted)) return true;
  }
  for (const [k, v] of Object.entries(inv)) {
    if (!k.startsWith("cf_") || k.endsWith("_unformatted")) continue;
    if (names.has(squash(k)) && hasValue(v)) return true;
  }
  return false;
}

/** An invoice that still has money owed: balance > 0 and not void / draft / written off. */
export function isOpenInvoice(inv: Record<string, unknown>): boolean {
  const status = String(inv.status ?? "").toLowerCase();
  if (["void", "draft", "writtenoff", "written_off"].includes(status)) return false;
  return Number(inv.balance ?? 0) > 0;
}

async function eachPage(
  path: string, listKey: string, orgId: string, token: string, f: Fetch,
  onRows: (rows: Array<Record<string, unknown>>) => void,
): Promise<{ capped: boolean }> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ organization_id: orgId, page: String(page), per_page: String(PAGE_SIZE) });
    const body = await booksGet(`${path}?${q}`, token, f);
    const rows = Array.isArray(body[listKey]) ? (body[listKey] as Array<Record<string, unknown>>) : [];
    onRows(rows);
    const more = Boolean((body.page_context as { has_more_page?: boolean } | undefined)?.has_more_page);
    if (!more) return { capped: false };
  }
  return { capped: true };
}

export interface ZohoPreview {
  contacts: number;
  invoices: number;
  openInvoices: number;
  withSubsPeriod: number;
  withServiceExpiry: number;
  /** True when a list had more than MAX_PAGES × PAGE_SIZE rows — the numbers are "at least". */
  capped: boolean;
}

export async function previewCounts(orgId: string, token: string, f: Fetch = fetch): Promise<ZohoPreview> {
  let contacts = 0;
  const c = await eachPage("/contacts", "contacts", orgId, token, f, (rows) => { contacts += rows.length; });

  let invoices = 0, openInvoices = 0, withSubsPeriod = 0, withServiceExpiry = 0;
  const i = await eachPage("/invoices", "invoices", orgId, token, f, (rows) => {
    for (const inv of rows) {
      invoices += 1;
      if (isOpenInvoice(inv)) openInvoices += 1;
      if (invoiceHasField(inv, SUBS_PERIOD)) withSubsPeriod += 1;
      if (invoiceHasField(inv, SERVICE_EXPIRY)) withServiceExpiry += 1;
    }
  });
  return { contacts, invoices, openInvoices, withSubsPeriod, withServiceExpiry, capped: c.capped || i.capped };
}

// ── R-1753: the import reads (still read-only) ────────────────────────────────────────────

export interface ZohoPage { rows: Array<Record<string, unknown>>; more: boolean }

async function listPage(path: string, listKey: string, orgId: string, token: string, page: number, f: Fetch,
  extra: Record<string, string> = {}): Promise<ZohoPage> {
  const q = new URLSearchParams({ organization_id: orgId, page: String(page), per_page: String(PAGE_SIZE), ...extra });
  const body = await booksGet(`${path}?${q}`, token, f);
  const rows = Array.isArray(body[listKey]) ? (body[listKey] as Array<Record<string, unknown>>) : [];
  const more = Boolean((body.page_context as { has_more_page?: boolean } | undefined)?.has_more_page);
  return { rows, more };
}

/** One page (200) of the organization's contacts (vendors are dropped by the caller: contact_type). */
export function listContactsPage(orgId: string, token: string, page: number, f: Fetch = fetch): Promise<ZohoPage> {
  return listPage("/contacts", "contacts", orgId, token, page, f);
}

/** One page (200) of the organization's invoices, newest first. */
export function listInvoicesPage(orgId: string, token: string, page: number, f: Fetch = fetch): Promise<ZohoPage> {
  return listPage("/invoices", "invoices", orgId, token, page, f, { sort_column: "date", sort_order: "D" });
}

/** One invoice with its line items. */
export async function getInvoiceDetail(orgId: string, token: string, invoiceId: string, f: Fetch = fetch): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ organization_id: orgId });
  const body = await booksGet(`/invoices/${encodeURIComponent(invoiceId)}?${q}`, token, f);
  return (body.invoice as Record<string, unknown> | undefined) ?? {};
}

/** The value of a custom field whose name is one of `names` (both Zoho shapes), or null. */
export function invoiceFieldValue(inv: Record<string, unknown>, names: Set<string>): string | null {
  const arr = Array.isArray(inv.custom_fields) ? (inv.custom_fields as Array<Record<string, unknown>>) : [];
  for (const cf of arr) {
    const n1 = squash(String(cf.label ?? ""));
    const n2 = squash(String(cf.api_name ?? ""));
    const v = cf.value_formatted ?? cf.value;
    if ((names.has(n1) || names.has(n2)) && hasValue(v)) return String(v).trim();
  }
  for (const [k, v] of Object.entries(inv)) {
    if (!k.startsWith("cf_") || k.endsWith("_unformatted")) continue;
    if (names.has(squash(k)) && hasValue(v)) return String(v).trim();
  }
  return null;
}

export const CF_SUBS_PERIOD = SUBS_PERIOD;
export const CF_SERVICE_EXPIRY = SERVICE_EXPIRY;
export const CF_NEW_BUSINESS = new Set(["newbusiness"]);
