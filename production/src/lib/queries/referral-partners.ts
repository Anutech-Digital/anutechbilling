/**
 * Referral partners + agreements (migration 0156).
 *
 * A referral partner is someone who refers or helps close a deal; an agreement
 * ties a partner to ONE customer's deal with commission terms (percent | fixed,
 * one_time | recurring, TDS on/off). When a payment lands for that customer, a
 * DB trigger auto-accrues the commission — see referral-commissions.ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { ReferralPartnerRow, ReferralAgreementRow } from "@/lib/supabase/database.types";

export interface CreatePartnerInput {
  name:                  string;
  phone?:                string | null;
  email?:                string | null;
  pan?:                  string | null;
  gstin?:                string | null;
  default_basis?:        "percent" | "fixed";
  default_percent?:      number | null;
  default_fixed_amount?: number | null;
  deduct_tds?:           boolean;
  tds_rate?:             number;
  notes?:                string | null;
}

export interface CreateAgreementInput {
  partner_id:    string;
  customer_id:   string | null;
  quote_id?:     string | null;
  label?:        string | null;
  basis:         "percent" | "fixed";
  percent?:      number | null;
  fixed_amount?: number | null;
  scope:         "one_time" | "recurring";
  deduct_tds?:   boolean;
  tds_rate?:     number;
  notes?:        string | null;
}

export function useReferralPartners() {
  return useQuery({
    queryKey: ["referral-partners"],
    queryFn: async (): Promise<ReferralPartnerRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("referral_partners")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReferralPartnerRow[];
    },
  });
}

/**
 * Leads that came in through each partner's share link — utm_source 'referral' and
 * utm_campaign = the partner's code (migration 20260926210000). Keyed by code.
 */
export function useReferralLeadCounts(codes: string[]) {
  return useQuery({
    queryKey: ["referral-lead-counts", [...codes].sort()],
    enabled: codes.length > 0,
    queryFn: async (): Promise<Record<string, { leads: number; won: number }>> => {
      const { data, error } = await createClient()
        .from("leads")
        .select("utm_campaign, stage")
        .eq("utm_source", "referral")
        .in("utm_campaign", codes);
      if (error) throw error;
      const out: Record<string, { leads: number; won: number }> = {};
      for (const l of (data ?? []) as { utm_campaign: string | null; stage: string | null }[]) {
        if (!l.utm_campaign) continue;
        const c = out[l.utm_campaign] ?? { leads: 0, won: 0 };
        c.leads++; if (l.stage === "won") c.won++;
        out[l.utm_campaign] = c;
      }
      return out;
    },
  });
}

/** All agreements, optionally scoped to one customer. */
export function useReferralAgreements(customerId?: string | null) {
  return useQuery({
    queryKey: ["referral-agreements", customerId ?? "all"],
    queryFn: async (): Promise<ReferralAgreementRow[]> => {
      const supabase = createClient();
      let q = supabase.from("referral_agreements").select("*").order("created_at", { ascending: false });
      if (customerId) q = q.eq("customer_id", customerId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ReferralAgreementRow[];
    },
  });
}

export function useCreatePartner() {
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  return useMutation({
    mutationFn: async (input: CreatePartnerInput): Promise<ReferralPartnerRow> => {
      const supabase = createClient();
      if (!me?.tenantId) throw new Error("No tenant context");
      const { data, error } = await supabase
        .from("referral_partners")
        .insert({
          tenant_id:            me.tenantId,
          name:                 input.name,
          phone:                input.phone ?? null,
          email:                input.email ?? null,
          pan:                  input.pan ?? null,
          gstin:                input.gstin ?? null,
          default_basis:        input.default_basis ?? "percent",
          default_percent:      input.default_percent ?? 10,
          default_fixed_amount: input.default_fixed_amount ?? 0,
          deduct_tds:           input.deduct_tds ?? false,
          tds_rate:             input.tds_rate ?? 2,
          notes:                input.notes ?? null,
          created_by:           me.userId,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as ReferralPartnerRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["referral-partners"] });
      toast.success("Referral partner added");
    },
    onError: (e) => toastError(e),
  });
}

export function useCreateAgreement() {
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  return useMutation({
    mutationFn: async (input: CreateAgreementInput): Promise<ReferralAgreementRow> => {
      const supabase = createClient();
      if (!me?.tenantId) throw new Error("No tenant context");
      const { data, error } = await supabase
        .from("referral_agreements")
        .insert({
          tenant_id:    me.tenantId,
          partner_id:   input.partner_id,
          customer_id:  input.customer_id,
          quote_id:     input.quote_id ?? null,
          label:        input.label ?? null,
          basis:        input.basis,
          percent:      input.basis === "percent" ? (input.percent ?? 0) : null,
          fixed_amount: input.basis === "fixed" ? (input.fixed_amount ?? 0) : null,
          scope:        input.scope,
          deduct_tds:   input.deduct_tds ?? false,
          tds_rate:     input.tds_rate ?? 2,
          status:       "active",
          notes:        input.notes ?? null,
          created_by:   me.userId,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as ReferralAgreementRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["referral-agreements"] });
      toast.success("Referral tagged to this deal");
    },
    onError: (e) => {
      const msg = (e as Error).message;
      // Friendly message for the one-active-agreement-per-customer unique index.
      if (msg.includes("referral_agreements_one_active_per_customer")) {
        toast.error("This customer already has an active referral.", {
          description: "Close the existing referral first, then tag this deal again.",
        });
      } else {
        toastError(e);
      }
    },
  });
}

/** Close an agreement (stops future recurring accrual). */
export function useCloseAgreement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agreementId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("referral_agreements")
        .update({ status: "closed" })
        .eq("id", agreementId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["referral-agreements"] });
      toast.success("Referral agreement closed");
    },
    onError: (e) => toastError(e),
  });
}
