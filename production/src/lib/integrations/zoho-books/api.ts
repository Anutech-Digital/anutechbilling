/**
 * R-1749 — the few Zoho calls this app makes. All READ, all server-side.
 *
 *   exchangeCode       authorization code → refresh token (once, at connect)
 *   accessToken        refresh token → short-lived access token (every use; never stored)
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

export async function accessToken(refreshToken: string, creds: ZohoCreds, f: Fetch = fetch): Promise<string> {
  try {
    const body = await postToken({
      grant_type: "refresh_token",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
    }, f);
    const t = typeof body.access_token === "string" ? body.access_token : "";
    if (!t) throw new ZohoApiError("Zoho did not return access.", "no_access_token");
    return t;
  } catch (e) {
    if (e instanceof ZohoApiError && e.code !== "network") {
      throw new ZohoApiError(
        "Zoho Books access has ended (it was removed in Zoho, or expired). Disconnect and connect Zoho Books again.",
        "reconnect", e.status,
      );
    }
    throw e;
  }
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
