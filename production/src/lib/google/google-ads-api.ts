/**
 * Google Ads API — token, accessible accounts, daily campaign spend, and the sync that
 * writes ad_accounts / ad_spend_daily (migration 20260927260000).
 *
 * Needs, beyond the OAuth client every Google flow shares:
 *   GOOGLE_ADS_DEVELOPER_TOKEN — from the Google Ads manager account (API Center). Until
 *   Google grants "Basic access" it only works on test accounts; the status route says so.
 *   GOOGLE_ADS_API_VERSION     — optional, e.g. "v21". Google retires a version roughly
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
  "Google ne Ads account padhne ki permission nahi di. Reconnect kariye aur \"Manage your AdWords campaigns\" tick rehne dijiye.";

export function googleAdsDeveloperToken(): string | null {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || null;
}
function apiVersion(): string { return process.env.GOOGLE_ADS_API_VERSION?.trim() || "v21"; }
const BASE = () => `https://googleads.googleapis.com/${apiVersion()}`;

export function explainGoogleAdsError(status: number, body: string): string {
  if (/DEVELOPER_TOKEN_NOT_APPROVED|developer token is only approved for use with test accounts/i.test(body)) {
    return "Google Ads developer token abhi sirf test accounts ke liye approved hai — API Center mein \"Basic access\" apply karo (Google 1–3 din leta hai).";
  }
  if (/DEVELOPER_TOKEN_INVALID|developer-token/i.test(body)) return "GOOGLE_ADS_DEVELOPER_TOKEN galat ya khaali hai — Google Ads manager account → Tools → API Center se lo.";
  if (status === 404 && /version/i.test(body)) return `Google Ads API ${apiVersion()} retire ho gaya — env GOOGLE_ADS_API_VERSION mein nayi version daalo.`;
  if (/PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(body)) return "Is Google login ke paas is Ads account par access nahi hai — jis email se ads.google.com khulta hai, usi se connect karo.";
  if (status === 401) return "Google token expire/revoke ho gaya — Reconnect karo.";
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
  const dev = googleAdsDeveloperToken();
  if (!dev) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN env mein nahi hai.");
  const h: Record<string, string> = { authorization: `Bearer ${token}`, "developer-token": dev, "content-type": "application/json" };
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
