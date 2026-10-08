/**
 * Assets bought on EMI / financing — TanStack Query hooks (migration 0092).
 *
 * A purchase = a fixed asset (total cost) + a down payment (cash out) + a loan
 * (financed = total − down) repaid via EMIs. Each EMI's principal reduces the
 * loan; its interest is an expense. Everything money-moving goes through the
 * record_emi_purchase / record_emi_payment RPCs. Balance-sheet.ts surfaces the
 * asset + the outstanding loan.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { Database } from "@/lib/supabase/database.types";

export type EmiPurchaseRow = Database["public"]["Tables"]["emi_purchases"]["Row"];
export type EmiPaymentRow  = Database["public"]["Tables"]["emi_payments"]["Row"];
export type EmiCategory    = EmiPurchaseRow["category"];

export const EMI_CATEGORY_LABEL: Record<EmiCategory, string> = {
  vehicle: "Vehicle", equipment: "Equipment", furniture: "Furniture", property: "Property", other: "Other",
};

export type EmiPurchase = EmiPurchaseRow & {
  principalPaid: number;   // sum of principal parts
  outstanding:   number;   // financed − principalPaid
  emisPaid:      number;   // count of payments
};

export function useEmiPurchases() {
  return useQuery({
    queryKey: ["emi-purchases"],
    queryFn: async (): Promise<EmiPurchase[]> => {
      const supabase = createClient();
      const { data: purchases, error } = await supabase
        .from("emi_purchases").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      const { data: pays, error: pErr } = await supabase
        .from("emi_payments").select("purchase_id, principal_part");
      if (pErr) throw pErr;

      const paidByP = new Map<string, { prin: number; count: number }>();
      for (const p of pays ?? []) {
        const cur = paidByP.get(p.purchase_id) ?? { prin: 0, count: 0 };
        cur.prin += p.principal_part ?? 0; cur.count += 1;
        paidByP.set(p.purchase_id, cur);
      }
      return (purchases ?? []).map((p) => {
        const agg = paidByP.get(p.id) ?? { prin: 0, count: 0 };
        return { ...(p as EmiPurchaseRow), principalPaid: agg.prin, outstanding: (p.financed ?? 0) - agg.prin, emisPaid: agg.count };
      });
    },
    staleTime: 30_000,
  });
}

export function useEmiPayments(purchaseId: string | undefined) {
  return useQuery({
    queryKey: ["emi-purchases", "payments", purchaseId],
    enabled: Boolean(purchaseId),
    queryFn: async (): Promise<EmiPaymentRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("emi_payments").select("*").eq("purchase_id", purchaseId!).order("paid_on", { ascending: true });
      if (error) throw error;
      return (data ?? []) as EmiPaymentRow[];
    },
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["emi-purchases"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
}

export function useRecordEmiPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string; category: EmiCategory; totalCost: number; downPayment: number;
      emiCount: number; emiAmount: number; purchasedOn: string; downAccountId: string | null;
      lender?: string | null; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("record_emi_purchase", {
        p_name:         input.name,
        p_category:     input.category,
        p_total_cost:   input.totalCost,
        p_down_payment: input.downPayment,
        p_emi_count:    input.emiCount,
        p_emi_amount:   input.emiAmount,
        p_purchased_on: input.purchasedOn,
        p_down_account: input.downPayment > 0 ? input.downAccountId : null,
        p_lender:       input.lender ?? null,
        p_notes:        input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => { invalidate(qc); toast.success("Purchase recorded"); },
    onError: (err) => toastError(err),
  });
}

export function useRecordEmiPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purchaseId: string; amount: number; interest: number; paidOn: string; bankAccountId: string; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_emi_payment", {
        p_purchase_id:     input.purchaseId,
        p_amount:          input.amount,
        p_interest:        input.interest,
        p_paid_on:         input.paidOn,
        p_bank_account_id: input.bankAccountId,
        p_notes:           input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("EMI paid"); },
    onError: (err) => toastError(err),
  });
}
