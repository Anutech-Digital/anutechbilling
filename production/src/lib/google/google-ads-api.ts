/**
 * Google Ads API — token, accessible accounts, daily campaign spend, and the sync that
 * writes ad_accounts / ad_spend_daily (migration 20260927260000).
 *
 * Needs, beyond the OAuth client every Google flow shares:
 *   GOOGLE_ADS_DEVELOPER_TOKEN — OPTIONAL since R-1884. Google sunset developer tokens on
 *   9 Sep 2026: the API access level (Test / Explorer / Basic / Standard) now belongs to the
 *   Google Cloud project of the OAuth client, and the header is ignored. Sent only when set,
 *   so older setups keep working; an access-level refusal names the Cloud project.
 *   GOOGLE_ADS_API_VERSION    — optional, e.g. "v21". Google retires a version roughly
 *   every year; when calls start returning 404 with "version", bump this env, not the code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { googleOAuthCreds, refreshAccessToken } from "@/lib/google/oauth";
import { resealIfPlain } from "@/lib/google/token-vault";
import { hasGoogleAdsScope } from "@/lib/google/scope-union";
import { gaqlCampaignSpend, googleRowsFromSearchStream, type AdSpendRow, type GoogleSearchStreamChunk } from "@/lib/marketing/ad-platforms";

type Admin = SupabaseClient<Database>;

export const GOOGLE_ADS_SCOPE_MISSING_MESSAGE =
  "Google did not grant permission to read the Ads account. Click Reconnect and keep \"Manage your AdWords campaigns\" ticked.";

export function googleAdsDeveloperToken(): string | null {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || null;
}
function apiVersion(): string { return process.env.GOOGLE_ADS_API_VERSION?.trim() || "v21"; }
const BASE = () => `https://googleads.googleapis.com/${apiVersion()}`;

/** Google's page on API access levels (Cloud project based since 9 Sep 2026). */
export const GOOGLE_ADS_ACCESS_LEVELS_URL = "https://developers.google.com/google-ads/api/docs/api-policy/access-levels";
const ACCESS_LEVEL_MESSAGE =
  "Google Ads API access is not approved for this Google Cloud project (test accounts only, or the API is off) — "
  + "in the Google Cloud project of the OAuth client, enable the Google Ads API and apply for Explorer/Basic access level: "
  + GOOGLE_ADS_ACCESS_LEVELS_URL;

export function explainGoogleAdsError(status: number, body: string): string {
  // R-1884: access level now sits on the Cloud project — not on a developer token.
  if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts|has not been used in project|SERVICE_DISABLED|access level/i.test(body)) {
    return ACCESS_LEVEL_MESSAGE;
  }
  if (/DEVELOPER_TOKEN_INVALID/i.test(body)) return "Google rejected the developer token — developer tokens were retired on 9 Sep 2026: remove GOOGLE_ADS_DEVELOPER_TOKEN from env (access now comes from the Google Cloud project).";
  if (status === 404 && /version/i.test(body)) return `Google Ads API ${apiVersion()} is retired — put the new version in env GOOGLE_ADS_API_VERSION.`;
  if (/PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(body)) return "This Google login has no access to this Ads account — connect with the email that opens ads.google.com.";
  if (status === 401) return "Google token expired or was revoked — click Reconnect.";
  return `Google Ads ne ${status} diya: ${body.slice(0, 200)}`;
}

// ── Token ─────────────────────────────────────────────────────────────────
export async function getFreshGoogleAdsAccessToken(admin: Admin, userId: string): Promise<string> {
  const { data: tok } = await admin
    .from("user_google_tokens").select("access_token, refresh_token, token_expiry, scopes").eq("user_id", userId).maybeSingle();
  if (!tok || (!tok.access_token && !tok.refresh_token)) throw new Error("Google Ads not connected");
  if (!hasGoogleAdsScope(tok.scopes)) throw new Error(GOOGLE_ADS_SCOPE_MISSING_MESSAGE);
  const exp = tok.token_expiry ? Date.parse(tok.token_expiry) : 0;
  if (tok.access_token && exp > Date.now() + 60_000) return tok.access_token;
  if (!tok.refresh_token) throw new Error("No refresh token — please reconnect Google Ads");
  const creds = googleOAuthCreds();
  if (!creds) throw new Error("Google OAuth not configured");
  const r = await refreshAccessToken(tok.refresh_token, creds);
  // A legacy plaintext refresh token is sealed on this write (R-051).
  await admin.from("user_google_tokens").update({ access_token: r.access_token, token_expiry: new Date(Date.now() + (r.expires_in ?? 3600) * 1000).toISOString(), ...resealIfPlain(tok.refresh_token) }).eq("user_id", userId);
  return r.access_token;
}

function headers(token: string, loginCustomerId?: string | null): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  // R-1884: optional since the 9 Sep 2026 sunset — sent only when an older setup still has it.
  const dev = googleAdsDeveloperToken();
  if (dev) h["developer-token"] = dev;
  if (loginCustomerId) h["login-customer-id"] = loginCustomerId;
  return h;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  if (!res.ok) throw new Error(explainGoogleAdsError(res.status, await res.text().catch(() => "")));
  return (await res.json()) as T;
}

// ── Accounts ──────────────────────────────────────────────────────────────
export interface GoogleAdsAccount { id: string; name: string; currency: string; manager: boolean; loginCustomerId: string | null }

async function searchStream(token: string, customerId: string, query: string, loginCustomerId?: string | null): Promise<GoogleSearchStreamChunk[]> {
  return call<GoogleSearchStreamChunk[]>(`${BASE()}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST", headers: headers(token, loginCustomerId), body: JSON.stringify({ query }),
  });
}

/** Every non-manager account the login can reach: direct ones and clients under any manager it sees. */
export async function listAdAccounts(token: string): Promise<GoogleAdsAccount[]> {
  const acc = await call<{ resourceNames?: string[] }>(`${BASE()}/customers:listAccessibleCustomers`, { method: "GET", headers: headers(token) });
  const out = new Map<string, GoogleAdsAccount>();
  for (const rn of acc.resourceNames ?? []) {
    const id = rn.replace("customers/", "");
    type CustRow = { customer?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean } };
    const chunks = await searchStream(token, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer", id);
    const c = ((chunks[0]?.results ?? []) as CustRow[])[0]?.customer;
    if (!c) continue;
    if (!c.manager) { out.set(id, { id, name: c.descriptiveName ?? id, currency: c.currencyCode ?? "INR", manager: false, loginCustomerId: null }); continue; }
    type ClientRow = { customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean } };
    const clients = await searchStream(token, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'", id);
    for (const ch of clients) for (const r of (ch.results ?? []) as ClientRow[]) {
      const cc = r.customerClient; if (!cc?.id) continue;
      const cid = String(cc.id);
      if (!out.has(cid)) out.set(cid, { id: cid, name: cc.descriptiveName ?? cid, currency: cc.currencyCode ?? "INR", manager: false, loginCustomerId: id });
    }
  }
  return [...out.values()];
}

export async function fetchCampaignSpend(token: string, customerId: string, loginCustomerId: string | null, from: string, to: string, accountRowId: string): Promise<AdSpendRow[]> {
  const chunks = await searchStream(token, customerId, gaqlCampaignSpend(from, to), loginCustomerId);
  return googleRowsFromSearchStream(chunks, accountRowId);
}
