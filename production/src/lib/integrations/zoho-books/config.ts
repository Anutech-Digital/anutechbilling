/**
 * R-1749 — Zoho Books connection, per tenant: constants and server-side configuration.
 *
 * Each company (tenant) connects ITS OWN Zoho Books account with OAuth. The OAuth app
 * (client id + secret) belongs to this server and is read ONLY from the environment
 * (ZOHO_BOOKS_CLIENT_ID / ZOHO_BOOKS_CLIENT_SECRET). Without them the card says
 * "Zoho Books is not set up on this server" and nothing starts.
 *
 * India data centre only (accounts.zoho.in / www.zohoapis.in). Read-only scopes: this app
 * never writes to Zoho.
 */

export const ZOHO_ACCOUNTS_BASE = "https://accounts.zoho.in";
export const ZOHO_BOOKS_API_BASE = "https://www.zohoapis.in/books/v3";

export const ZOHO_AUTH_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/auth`;
export const ZOHO_TOKEN_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`;
export const ZOHO_REVOKE_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token/revoke`;

/**
 * Minimal READ scopes. contacts → customers; invoices → invoices (their custom fields come
 * with them); settings → organizations list, items and custom-field definitions (Zoho files
 * organizations and items under the settings scope).
 */
export const ZOHO_BOOKS_SCOPES = [
  "ZohoBooks.contacts.READ",
  "ZohoBooks.invoices.READ",
  /* R-2359: "Find in Zoho" on a bank credit reads the customer payment whose reference is the UTR. */
  "ZohoBooks.customerpayments.READ",
  "ZohoBooks.settings.READ",
  /* R-2498 (G-FY2526): the FY 2025-26 books — credit notes, vendor bills, expenses, payments made, and
     the accountant module (chart of accounts + each account's transactions → trial balance as at a
     date). READ only. A connection made before R-2498 lacks them: Zoho answers 401 code 57 and the
     card asks to Reconnect (Settings → Integrations → Zoho Books). */
  "ZohoBooks.creditnotes.READ",
  "ZohoBooks.bills.READ",
  "ZohoBooks.expenses.READ",
  "ZohoBooks.vendorpayments.READ",
  "ZohoBooks.accountants.READ",
] as const;

export const CALLBACK_PATH = "/api/integrations/zoho-books/callback";
export const CONNECT_PATH = "/api/integrations/zoho-books/connect";
export const SETTINGS_RETURN = "/settings?tab=integrations";
/** Query param the callback uses to tell the card what happened. */
export const ZOHO_STATUS_PARAM = "zoho";

/** Cookie holding the nonce that the signed state must carry (double-submit CSRF). */
export const STATE_COOKIE = "zb_oauth_nonce";
/** How long a started connect stays valid. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Who may connect, choose the organization, preview and disconnect. */
export const ZOHO_BOOKS_MANAGE_ROLES = ["owner", "manager", "accountant"] as const;

/** R-2359: who may press "Find in Zoho" on a bank line (it shows the company's sales records). */
export const ZOHO_FIND_ROLES = ["owner", "accountant"] as const;

export function canManageZohoBooks(role: string | null | undefined): boolean {
  return !!role && (ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(role);
}

export const NOT_CONFIGURED_MESSAGE = "Zoho Books is not set up on this server";
export const ROLE_MESSAGE = "Only an owner, manager or accountant can connect Zoho Books.";

export interface ZohoCreds { clientId: string; clientSecret: string }

/** The OAuth app credentials, or null when this server has none (never sent to a browser). */
export function zohoBooksCreds(): ZohoCreds | null {
  const clientId = process.env.ZOHO_BOOKS_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOHO_BOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The redirect URI registered in the Zoho API console. ZOHO_BOOKS_REDIRECT_URI wins when set
 * (it must match the console exactly); otherwise the app's own trusted origin + callback path,
 * e.g. http://localhost:3001/api/integrations/zoho-books/callback.
 */
export function zohoRedirectUri(origin: string): string {
  const fromEnv = process.env.ZOHO_BOOKS_REDIRECT_URI?.trim();
  return fromEnv || `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/** Zoho's consent-screen URL (offline access → refresh token; consent every time). */
export function buildZohoAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(ZOHO_AUTH_URL);
  u.searchParams.set("scope", ZOHO_BOOKS_SCOPES.join(","));
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

// ── R-2498: the FY reads (pure — the card imports these too) ───────────────────────────────

export const FY_DOC_KINDS = ["invoices", "creditnotes", "bills", "expenses", "vendorpayments"] as const;
export type FyDocKind = (typeof FY_DOC_KINDS)[number];

/** Each FY list's name on the card (one place; fy-fetch.ts and the Reconnect line use it too). */
export const FY_DOC_LABELS: Record<FyDocKind, string> = {
  invoices: "Invoices", creditnotes: "Credit notes", bills: "Bills", expenses: "Expenses", vendorpayments: "Vendor payments",
};

export interface DateRange { dateStart: string; dateEnd: string }

/** "2025-26" → 1 Apr 2025 … 31 Mar 2026. Anything else is refused (it goes into a Zoho URL). */
export function fyDateRange(fy: string): DateRange {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error("The financial year must look like 2025-26.");
  const y = Number(m[1]);
  return { dateStart: `${y}-04-01`, dateEnd: `${y + 1}-03-31` };
}

/** The card's line when the stored Zoho sign-in was made before the FY read scopes existed. */
export const ZOHO_FY_RECONNECT_MESSAGE =
  "Reconnect to allow reading credit notes, bills, expenses and vendor payments. Press Reconnect, then Allow on the Zoho screen.";

/** The Reconnect line naming only the lists Zoho refused ("… reading bills and expenses."). */
export function fyReconnectMessage(kinds: readonly FyDocKind[]): string {
  const names = FY_DOC_KINDS.filter((k) => kinds.includes(k)).map((k) => FY_DOC_LABELS[k].toLowerCase());
  if (!names.length) return ZOHO_FY_RECONNECT_MESSAGE;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Reconnect to allow reading ${list}. Press Reconnect, then Allow on the Zoho screen.`;
}

/** R-2498: Zoho calls one "Count FY" request may make; the card paces the next request (zoho-pace.ts). */
export const FY_CALLS_PER_REQUEST = 20;
