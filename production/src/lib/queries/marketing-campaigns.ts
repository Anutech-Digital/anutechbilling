/**
 * Marketing campaigns (migration 20260926240000) — list with actuals, save, delete.
 * Spend = expenses.campaign_id; leads = leads.utm_campaign = campaign code.
 * Arithmetic is in lib/marketing/campaign-metrics.ts.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";
import type { CampaignActuals } from "@/lib/marketing/campaign-metrics";

/* Newer than the generated types (database.types.ts is shared, kept minimal). */
const db = () => createClient() as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = ["marketing-campaigns"] as const;

export interface MarketingCampaign {
  id: string; name: string; code: string; start_date: string; end_date: string;
  budget: number; target_leads: number | null; target_won: number | null;
  cancelled: boolean; notes: string | null;
}
export interface CampaignExpense { id: string; expense_date: string; vendor_name: string | null; description: string | null; amount: number; category: string | null; channel: string | null }
export interface CampaignLead { id: string; company: string; stage: string; value: number | null; utm_source: string | null; created_at: string }
export interface CampaignRow extends MarketingCampaign {
  actuals: CampaignActuals;
  expenses: CampaignExpense[];
  leadList: CampaignLead[];
}

/** Every campaign with its spend and leads. Two queries for all campaigns, not two per campaign. */
export function useMarketingCampaigns() {
  return useQuery({
    /* Under "expenses" too, so tagging an expense anywhere refreshes the numbers. */
    queryKey: ["expenses", ...KEY],
    queryFn: async (): Promise<CampaignRow[]> => {
      const { data, error } = await db().from("marketing_campaigns")
        .select("id, name, code, start_date, end_date, budget, target_leads, target_won, cancelled, notes")
        .order("start_date", { ascending: false });
      if (error) throw error;
      const camps = (data ?? []) as MarketingCampaign[];
      if (camps.length === 0) return [];

      const supabase = createClient();
      const { data: ex, error: eErr } = await supabase.from("expenses")
        .select("id, expense_date, vendor_name, description, amount, category, channel, campaign_id")
        .in("campaign_id", camps.map((c) => c.id));
      if (eErr) throw eErr;
      const { data: ld, error: lErr } = await supabase.from("leads")
        .select("id, company, stage, value, utm_source, utm_campaign, created_at")
        .in("utm_campaign", camps.map((c) => c.code));
      if (lErr) throw lErr;

      return camps.map((c) => {
        const expenses = ((ex ?? []) as (CampaignExpense & { campaign_id: string })[]).filter((e) => e.campaign_id === c.id);
        const leadList = ((ld ?? []) as (CampaignLead & { utm_campaign: string | null })[]).filter((l) => l.utm_campaign === c.code);
        const won = leadList.filter((l) => l.stage === "won");
        return {
          ...c, expenses, leadList,
          actuals: {
            spend: expenses.reduce((s, e) => s + (e.amount ?? 0), 0),
            leads: leadList.length,
            won: won.length,
            wonValue: won.reduce((s, l) => s + Math.max(0, l.value ?? 0), 0),
          },
        };
      });
    },
  });
}

export function useSaveCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...c }: Omit<MarketingCampaign, "id"> & { id?: string }) => {
      if (id) {
        const { error } = await db().from("marketing_campaigns").update({ ...c, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw friendly(error);
        return;
      }
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db().from("marketing_campaigns").insert({ ...c, tenant_id: tenantId, created_by: auth?.user?.id ?? null });
      if (error) throw friendly(error);
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["expenses"] }); qc.invalidateQueries({ queryKey: KEY }); toast.success(v.id ? "Campaign updated" : "Campaign bana"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from("marketing_campaigns").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["expenses"] }); qc.invalidateQueries({ queryKey: KEY }); toast.success("Campaign removed — its expenses are kept, just no longer linked to the campaign"); },
    onError: (err) => toastError(err),
  });
}

/** A duplicate code is the one error a person can fix; say so in their words. */
function friendly(err: { code?: string; message: string }): Error {
  if (err.code === "23505") return new Error("A campaign with this code already exists — change the name or code.");
  return new Error(err.message);
}

export interface CampaignOption { id: string; name: string; code: string; start_date: string; end_date: string; cancelled: boolean }

/** Light list for pickers (expense dialog, Spend page, tracking links) — no actuals. */
export function useCampaignOptions() {
  return useQuery({
    queryKey: [...KEY, "options"],
    staleTime: 60_000,
    queryFn: async (): Promise<CampaignOption[]> => {
      const { data, error } = await db().from("marketing_campaigns")
        .select("id, name, code, start_date, end_date, cancelled").order("start_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CampaignOption[];
    },
  });
}
