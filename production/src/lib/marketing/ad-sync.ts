/**
 * One tenant's ad spend sync — every enabled ad account on both platforms.
 * Writes ad_spend_daily in chunks, records the run, and never lets one account's failure
 * stop the others (the reason lands on that account's last_error, where the page shows it).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { AD_REFRESH_DAYS, AD_BACKFILL_DAYS, type AdPlatform, type AdSpendRow } from "@/lib/marketing/ad-platforms";
import { getFreshGoogleAdsAccessToken, fetchCampaignSpend } from "@/lib/google/google-ads-api";
import { fetchMetaCampaignSpend } from "@/lib/meta/meta-ads-api";
import { openMetaToken, resealMetaTokenIfPlain } from "@/lib/meta/meta-token-vault";
import { fetchLinkedInCampaignSpend } from "@/lib/linkedin/linkedin-ads-api";
import { openLinkedInAdsToken, resealLinkedInAdsTokenIfPlain } from "@/lib/linkedin/linkedin-ads-token-vault";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Admin = SupabaseClient<Database>;

export interface AdSyncResult { accounts: number; rowsWritten: number; errors: string[] }
export interface AdSyncWindow { platform: AdPlatform; from: string; to: string; granularity: "DAILY" | "MONTHLY"; accountId?: string }

function addDays(iso: string, n: number): string { return addDaysISO(iso, n); }

export async function syncTenantAds(admin: Admin, tenantId: string, trigger: "manual" | "cron" | "connect", window?: AdSyncWindow, accountId?: string): Promise<AdSyncResult> {
  const { data: run } = await admin.from("ad_sync_runs").insert({ tenant_id: tenantId, trigger }).select("id").single();
  const result: AdSyncResult = { accounts: 0, rowsWritten: 0, errors: [] };
  const today = istToday();
  try {
    let accountQuery = admin.from("ad_accounts").select("*").eq("tenant_id", tenantId).eq("enabled", true).is("archived_at", null);
    if (window) accountQuery = accountQuery.eq("platform", window.platform);
    const targetAccountId = window?.accountId ?? accountId;
    if (targetAccountId) accountQuery = accountQuery.eq("id", targetAccountId);
    const { data: accounts, error } = await accountQuery;
    if (error) throw new Error(error.message);

    for (const acc of accounts ?? []) {
      try {
        const { count } = window ? { count: 0 } : await admin.from("ad_spend_daily").select("day", { count: "exact", head: true }).eq("ad_account_id", acc.id);
        const from = window?.from ?? addDays(today, -((count ? AD_REFRESH_DAYS : AD_BACKFILL_DAYS) - 1));
        const to = window?.to ?? today;
        let rows: AdSpendRow[] = [];
        // R-1884: a legacy plaintext Meta token is sealed on this account's success write.
        let reseal: { access_token?: string } = {};
        if (acc.platform === "google-ads") {
          if (!acc.connected_user_id) throw new Error("Google Ads account has no connected user — reconnect it.");
          const token = await getFreshGoogleAdsAccessToken(admin, acc.connected_user_id);
          rows = await fetchCampaignSpend(token, acc.account_id, acc.login_customer_id, from, to, acc.id);
        } else if (acc.platform === "meta-ads") {
          if (!acc.access_token) throw new Error("Meta token missing — reconnect it.");
          if (acc.token_expires_at && Date.parse(acc.token_expires_at) < Date.now()) throw new Error("Meta token expired (60 days) — reconnect it.");
          // Opened server-side only; throws (naming SECRETS_MASTER_KEY) if a sealed row cannot be read.
          const token = openMetaToken(acc.access_token);
          if (!token) throw new Error("Meta token missing — reconnect it.");
          reseal = resealMetaTokenIfPlain(acc.access_token);
          rows = await fetchMetaCampaignSpend(token,acc.account_id.startsWith("act_") ? acc.account_id : `act_${acc.account_id}`, from, to, acc.id);
        } else if (acc.platform === "linkedin-ads") {
          if (!acc.access_token) throw new Error("LinkedIn Ads token missing — reconnect it.");
          if (acc.token_expires_at && Date.parse(acc.token_expires_at) < Date.now()) throw new Error("LinkedIn Ads access expired — reconnect it.");
          const token = openLinkedInAdsToken(acc.access_token);
          if (!token) throw new Error("LinkedIn Ads token missing — reconnect it.");
          reseal = resealLinkedInAdsTokenIfPlain(acc.access_token);
          rows = await fetchLinkedInCampaignSpend(token, acc.account_id, from, to, acc.id, window?.granularity ?? "DAILY");
        } else {
          throw new Error("This ad platform is not supported.");
        }
        // Days the platform now reports as zero must not keep yesterday's number.
        const { error: deleteError } = await admin.from("ad_spend_daily").delete().eq("ad_account_id", acc.id).gte("day", from).lte("day", to);
        if (deleteError) throw new Error(deleteError.message);
        const payload = rows.map((r) => ({ tenant_id: tenantId, ad_account_id: acc.id, day: r.day, campaign_id: r.campaign_id, campaign_name: r.campaign_name, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversion_value: r.conversion_value }));
        for (let i = 0; i < payload.length; i += 1000) {
          const { error: e } = await admin.from("ad_spend_daily").upsert(payload.slice(i, i + 1000), { onConflict: "ad_account_id,day,campaign_id" });
          if (e) throw new Error(e.message);
        }
        result.rowsWritten += payload.length;
        result.accounts++;
        await admin.from("ad_accounts").update({ last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(), ...reseal }).eq("id", acc.id);
      } catch (e) {
        const why = (e as Error).message;
        result.errors.push(`${acc.name}: ${why}`);
        await admin.from("ad_accounts").update({ last_error: why, updated_at: new Date().toISOString() }).eq("id", acc.id);
      }
    }
    if (run?.id) await admin.from("ad_sync_runs").update({ finished_at: new Date().toISOString(), ok: result.errors.length === 0, accounts: result.accounts, rows_written: result.rowsWritten, error: result.errors.join(" | ") || null }).eq("id", run.id);
    return result;
  } catch (e) {
    if (run?.id) await admin.from("ad_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, error: (e as Error).message }).eq("id", run.id);
    throw e;
  }
}
