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
  "ZohoBooks.settings.READ",
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
