/**
 * One tenant's ad spend sync — every enabled ad account on both platforms.
 * Writes ad_spend_daily in chunks, records the run, and never lets one account's failure
 * stop the others (the reason lands on that account's last_error, where the page shows it).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { AD_REFRESH_DAYS, AD_BACKFILL_DAYS, type AdSpendRow } from "@/lib/marketing/ad-platforms";
import { getFreshGoogleAdsAccessToken, fetchCampaignSpend } from "@/lib/google/google-ads-api";
import { fetchMetaCampaignSpend } from "@/lib/meta/meta-ads-api";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Admin = SupabaseClient<Database>;

export interface AdSyncResult { accounts: number; rowsWritten: number; errors: string[] }

function addDays(iso: string, n: number): string { return addDaysISO(iso, n); }

export async function syncTenantAds(admin: Admin, tenantId: string, trigger: "manual" | "cron" | "connect"): Promise<AdSyncResult> {
  const { data: run } = await admin.from("ad_sync_runs").insert({ tenant_id: tenantId, trigger }).select("id").single();
  const result: AdSyncResult = { accounts: 0, rowsWritten: 0, errors: [] };
  const today = istToday();
  try {
    const { data: accounts, error } = await admin.from("ad_accounts").select("*").eq("tenant_id", tenantId).eq("enabled", true);
    if (error) throw new Error(error.message);

    for (const acc of accounts ?? []) {
      try {
        const { count } = await admin.from("ad_spend_daily").select("day", { count: "exact", head: true }).eq("ad_account_id", acc.id);
        const from = addDays(today, -((count ? AD_REFRESH_DAYS : AD_BACKFILL_DAYS) - 1));
        let rows: AdSpendRow[] = [];
        if (acc.platform === "google-ads") {
          if (!acc.connected_user_id) throw new Error("Google Ads account has no connected user — reconnect it.");
          const token = await getFreshGoogleAdsAccessToken(admin, acc.connected_user_id);
          rows = await fetchCampaignSpend(token, acc.account_id, acc.login_customer_id, from, today, acc.id);
        } else {
          if (!acc.access_token) throw new Error("Meta token missing — reconnect it.");
          if (acc.token_expires_at && Date.parse(acc.token_expires_at) < Date.now()) throw new Error("Meta token expired (60 days) — reconnect it.");
          rows = await fetchMetaCampaignSpend(acc.access_token, acc.account_id.startsWith("act_") ? acc.account_id : `act_${acc.account_id}`, from, today, acc.id);
        }
        // Days the platform now reports as zero must not keep yesterday's number.
        await admin.from("ad_spend_daily").delete().eq("ad_account_id", acc.id).gte("day", from);
        const payload = rows.map((r) => ({ tenant_id: tenantId, ad_account_id: acc.id, day: r.day, campaign_id: r.campaign_id, campaign_name: r.campaign_name, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversion_value: r.conversion_value }));
        for (let i = 0; i < payload.length; i += 1000) {
          const { error: e } = await admin.from("ad_spend_daily").upsert(payload.slice(i, i + 1000), { onConflict: "ad_account_id,day,campaign_id" });
          if (e) throw new Error(e.message);
        }
        result.rowsWritten += payload.length;
        result.accounts++;
        await admin.from("ad_accounts").update({ last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", acc.id);
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
