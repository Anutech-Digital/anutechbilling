/**
 * Meta (Facebook / Instagram) Marketing API — OAuth, ad accounts, daily campaign insights.
 *
 * Needs a Meta app (developers.facebook.com) with the Marketing API product and the
 * `ads_read` permission: META_APP_ID + META_APP_SECRET in env. The user token is
 * exchanged for a long-lived one (~60 days) and stored per tenant on ad_accounts; the page
 * says when it is about to expire so the owner reconnects before the cron starts failing.
 *
 * META_GRAPH_VERSION — optional, e.g. "v21.0". Meta retires versions after ~2 years.
 */
import { META_LEAD_ACTIONS, metaRowsFromInsights, type AdSpendRow, type MetaInsightRow } from "@/lib/marketing/ad-platforms";

export function metaAppCreds(): { appId: string; appSecret: string } | null {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}
function v(): string { return process.env.META_GRAPH_VERSION?.trim() || "v21.0"; }
const GRAPH = () => `https://graph.facebook.com/${v()}`;

export const META_ADS_PERMISSIONS = "ads_read";

export function metaAdsRedirectUri(origin: string): string { return `${origin}/api/integrations/meta-ads/callback`; }

export function buildMetaAuthUrl(appId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: META_ADS_PERMISSIONS, response_type: "code" });
  return `https://www.facebook.com/${v()}/dialog/oauth?${p.toString()}`;
}

export function explainMetaError(status: number, body: string): string {
  if (/\(#200\)|permission|ads_read/i.test(body)) return "Meta did not grant the ads_read permission — \"ads_read\" must be approved in app review, or the permission was left unticked while connecting.";
  if (/\(#190\)|OAuthException.*expired|Session has expired/i.test(body)) return "Meta token expired (60 days) — click Reconnect.";
  if (/\(#17\)|\(#4\)|rate limit|User request limit reached/i.test(body)) return "Meta ne rate limit lagayi — agla sync apne aap chalega.";
  return `Meta ne ${status} diya: ${body.slice(0, 200)}`;
}

async function gget<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(explainMetaError(res.status, await res.text().catch(() => "")));
  return (await res.json()) as T;
}

/** code → short-lived token → long-lived token (≈60 days). */
export async function exchangeMetaCode(code: string, redirectUri: string, creds: { appId: string; appSecret: string }): Promise<{ accessToken: string; expiresAt: string | null }> {
  const short = await gget<{ access_token: string; expires_in?: number }>(
    `${GRAPH()}/oauth/access_token?${new URLSearchParams({ client_id: creds.appId, redirect_uri: redirectUri, client_secret: creds.appSecret, code })}`,
  );
  const long = await gget<{ access_token: string; expires_in?: number }>(
    `${GRAPH()}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: creds.appId, client_secret: creds.appSecret, fb_exchange_token: short.access_token })}`,
  );
  const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
  return { accessToken: long.access_token, expiresAt };
}

export interface MetaAdAccount { id: string; accountId: string; name: string; currency: string; status: number }
export async function listMetaAdAccounts(token: string): Promise<MetaAdAccount[]> {
  const out: MetaAdAccount[] = [];
  let url: string | undefined = `${GRAPH()}/me/adaccounts?${new URLSearchParams({ fields: "id,name,account_id,currency,account_status", limit: "100", access_token: token })}`;
  while (url) {
    const r: { data?: { id: string; name?: string; account_id?: string; currency?: string; account_status?: number }[]; paging?: { next?: string } } = await gget(url);
    for (const a of r.data ?? []) out.push({ id: a.id, accountId: a.account_id ?? a.id.replace(/^act_/, ""), name: a.name ?? a.id, currency: a.currency ?? "INR", status: a.account_status ?? 1 });
    url = r.paging?.next;
  }
  return out;
}

/** `actId` = "act_123". Daily, per campaign, inclusive range (Meta allows ≤ 37 months back). */
export async function fetchMetaCampaignSpend(token: string, actId: string, from: string, to: string, accountRowId: string): Promise<AdSpendRow[]> {
  const rows: MetaInsightRow[] = [];
  let url: string | undefined = `${GRAPH()}/${actId}/insights?${new URLSearchParams({
    level: "campaign", time_increment: "1", limit: "500",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    time_range: JSON.stringify({ since: from, until: to }),
    access_token: token,
  })}`;
  while (url) {
    const r: { data?: MetaInsightRow[]; paging?: { next?: string } } = await gget(url);
    rows.push(...(r.data ?? []));
    url = r.paging?.next;
  }
  return metaRowsFromInsights(rows, accountRowId);
}

export { META_LEAD_ACTIONS };
