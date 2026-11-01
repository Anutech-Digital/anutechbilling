/**
 * R-2323 — Banking → Reconcile → Loan / EMI → "Set up this loan".
 *
 * record_emi_loan_taken (migration 20261101025326_r2323_emi_loan_setup.sql) is newer than the
 * generated types, so it goes through an untyped client (as customer-refund-query.ts does).
 * One transaction on the server: the loan + its schedule (+ the money-in line) and, when asked,
 * this statement line reconciled as EMI 1. Undo = Un-reconcile the line (R-1864 trigger).
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import { rupee } from "@/lib/utils";
import type { loanSetupPayload } from "@/lib/accounting/loan-setup";

const untyped = () => createClient() as unknown as SupabaseClient;

export type LoanSetupResult = {
  purchase_id: string;
  reconciled: { seq: number; principal: number; interest: number } | null;
};

export function useSetUpEmiLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ReturnType<typeof loanSetupPayload>): Promise<LoanSetupResult> => {
      const { data, error } = await untyped().rpc("record_emi_loan_taken", { p: payload });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The loan was not confirmed — refresh Banking to see whether it was saved.");
      return data as LoanSetupResult;
    },
    onSuccess: (r) => {
      for (const k of ["emi-purchases", "emi-matches", "bank_transactions", "bank_accounts", "balance-sheet", "expenses"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      qc.invalidateQueries({ queryKey: queryKeys.pnl() });
      toast.success(r.reconciled
        ? `Loan set up · EMI 1 reconciled — ${rupee(r.reconciled.principal)} principal, ${rupee(r.reconciled.interest)} interest`
        : "Loan set up — its EMIs will be suggested on the bank lines");
    },
    onError: (err) => toastError(err),
  });
}
