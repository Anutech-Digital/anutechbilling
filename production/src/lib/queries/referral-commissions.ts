/**
 * Referral commissions (migration 0156) — the earned entries.
 *
 * Rows are auto-created by a DB trigger when a payment lands for a customer with
 * an active agreement (see 0156). This module reads them and pays them out via
 * the atomic `pay_referral_commission` RPC (debits a bank account + marks paid).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { ReferralCommissionRow } from "@/lib/supabase/database.types";

/** A commission row joined with its partner name (for list display). */
export type CommissionWithPartner = ReferralCommissionRow & { partner_name: string | null };

export function useReferralCommissions() {
  return useQuery({
    queryKey: ["referral-commissions"],
    queryFn: async (): Promise<CommissionWithPartner[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("referral_commissions")
        .select("*, referral_partners(name)")
        .order("earned_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r) => {
        const rec = r as unknown as ReferralCommissionRow & {
          referral_partners?: { name: string | null } | null;
        };
        return {
          ...(rec as ReferralCommissionRow),
          partner_name: rec.referral_partners?.name ?? null,
        };
      });
    },
  });
}

export interface PayCommissionInput {
  commissionId: string;
  bankAccountId: string;
  paidOn?: string | null;
  method?: string | null;
}

export function usePayCommission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PayCommissionInput) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("pay_referral_commission", {
        p_commission_id:   input.commissionId,
        p_bank_account_id: input.bankAccountId,
        p_paid_on:         input.paidOn ?? null,
        p_method:          input.method ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["referral-commissions"] });
      qc.invalidateQueries({ queryKey: ["banking"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
      toast.success("Commission paid");
    },
    onError: (e) => toastError(e),
  });
}

/** Cancel an earned commission (e.g. deal reversed). Does not touch banking. */
export function useCancelCommission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (commissionId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("referral_commissions")
        .update({ status: "cancelled" })
        .eq("id", commissionId)
        .eq("status", "earned"); // only earned (never a paid) can be cancelled
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["referral-commissions"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
      toast.success("Commission cancelled");
    },
    onError: (e) => toastError(e),
  });
}
