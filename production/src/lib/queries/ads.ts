/**
 * Ad platforms — reads for /marketing/ads. Tables from migration 20260927260000 are
 * server-written; the browser reads rows and calls the sync / toggle routes.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toastError } from "@/lib/errors/toast-error";
import { isMarketingCategory } from "@/lib/marketing/ad-channels";
import type { AdPlatform, AdSpendRow } from "@/lib/marketing/ad-platforms";

export const ADS_KEY = ["ads"] as const;

export interface AdsStatus {
  google: { configured: boolean; devToken: boolean; connected: boolean; email: string | null; lastError: string | null };
  meta: { configured: boolean; connected: boolean; tokenExpiresAt: string | null };
  accounts: { id: string; platform: AdPlatform; account_id: string; name: string; currency: string; enabled: boolean; last_synced_at: string | null; last_error: string | null }[];
}

export function useAdsStatus() {
  return useQuery({
    queryKey: [...ADS_KEY, "status"],
    queryFn: async (): Promise<AdsStatus> => {
      const res = await fetch("/api/marketing/ads");
      if (!res.ok) throw new Error("Could not load status");
      return res.json();
    },
  });
}

/** Spend rows from `fromDay`, with the platform resolved from the account. */
export function useAdSpend(fromDay: string) {
  return useQuery({
    queryKey: [...ADS_KEY, "spend", fromDay],
    queryFn: () => fetchAdSpend(createClient(), fromDay),
    staleTime: 60_000,
  });
}

/**
 * R-1588: every spend row from `fromDay`. The old `.limit(50000)` came back as 1000 rows
 * (the gateway caps every answer), and 90 days x 12 campaigns is already 1,080 — spend and
 * ROAS were short. Paged; the primary key (ad_account_id, day, campaign_id) after `day`
 * makes the order total.
 */
export async function fetchAdSpend(supabase: SupabaseClient<Database>, fromDay: string): Promise<AdSpendRow[]> {
  const [{ data: accounts }, data] = await Promise.all([
    supabase.from("ad_accounts").select("id, platform"),
    fetchAllRows((from, to) => supabase.from("ad_spend_daily")
      .select("ad_account_id, day, campaign_id, campaign_name, spend, impressions, clicks, conversions, conversion_value")
      .gte("day", fromDay)
      .order("day", { ascending: true }).order("ad_account_id", { ascending: true }).order("campaign_id", { ascending: true })
      .range(from, to)),
  ]);
  const platform = new Map((accounts ?? []).map((a) => [a.id, a.platform as AdPlatform]));
  return data.flatMap((r) => {
    const p = platform.get(r.ad_account_id); if (!p) return [];
    return [{ platform: p, account_id: r.ad_account_id, day: r.day, campaign_id: r.campaign_id, campaign_name: r.campaign_name, spend: Number(r.spend), impressions: r.impressions, clicks: r.clicks, conversions: Number(r.conversions), conversion_value: Number(r.conversion_value) }];
  });
}

/** Marketing-category expenses by month per channel — the books side of the reconciliation. */
export function useBookedAdSpendByMonth(fromDay: string) {
  return useQuery({
    queryKey: [...ADS_KEY, "booked", fromDay],
    queryFn: async (): Promise<Record<string, Map<string, number>>> => {
      const supabase = createClient();
      /* R-1588: paged — more than 1000 tagged expenses were cut silently. */
      const data = await fetchAllRows((from, to) => supabase.from("expenses").select("channel, amount, expense_date, category")
        .gte("expense_date", fromDay).not("channel", "is", null)
        .order("id", { ascending: true }).range(from, to));
      const out: Record<string, Map<string, number>> = {};
      for (const r of data) {
        if (!r.channel || !isMarketingCategory(r.category)) continue;
        const m = (out[r.channel] ??= new Map());
        const month = r.expense_date.slice(0, 7);
        m.set(month, (m.get(month) ?? 0) + (r.amount ?? 0));
      }
      return out;
    },
  });
}

/** Leads per utm_campaign since `fromDay` — for cost per lead on the campaign table. */
export function useLeadsByCampaign(fromDay: string) {
  return useQuery({
    queryKey: [...ADS_KEY, "leads-by-campaign", fromDay],
    queryFn: async (): Promise<Map<string, number>> => {
      const supabase = createClient();
      /* R-1588: paged — a count of the first 1000 leads is not a count. */
      const data = await fetchAllRows((from, to) => supabase.from("leads").select("utm_campaign")
        .gte("created_at", fromDay).not("utm_campaign", "is", null)
        .order("id", { ascending: true }).range(from, to));
      const m = new Map<string, number>();
      for (const r of data as { utm_campaign: string | null }[]) if (r.utm_campaign) m.set(r.utm_campaign, (m.get(r.utm_campaign) ?? 0) + 1);
      return m;
    },
  });
}

export interface AdSyncRun { id: string; started_at: string; finished_at: string | null; trigger: string; accounts: number; rows_written: number; ok: boolean | null; error: string | null }
export function useAdSyncRuns() {
  return useQuery({
    queryKey: [...ADS_KEY, "runs"],
    queryFn: async (): Promise<AdSyncRun[]> => {
      const { data, error } = await createClient().from("ad_sync_runs").select("*").order("started_at", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as AdSyncRun[];
    },
  });
}

export function useAdsSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/marketing/ads/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Sync failed");
      return body as { accounts: number; rowsWritten: number; errors: string[] };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ADS_KEY });
      if (r.errors?.length) toast.warning(`Synced, but: ${r.errors[0]}`);
      else toast.success(`Synced — ${r.accounts} account, ${r.rowsWritten} rows`);
    },
    onError: (e) => { qc.invalidateQueries({ queryKey: ADS_KEY }); toastError(e); },
  });
}

export function useToggleAdAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { accountId: string; enabled: boolean }) => {
      const res = await fetch("/api/marketing/ads", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Save failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ADS_KEY, "status"] }),
    onError: (e) => toastError(e),
  });
}
