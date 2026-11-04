/**
 * R-2323 — Banking → Reconcile → Loan / EMI → "Set up this loan".
 *
 * record_emi_loan_taken (migration 20261101025326_r2323_emi_loan_setup.sql) is newer than the
 * generated types, so it goes through an untyped client (as customer-refund-query.ts does).
 * One transaction on the server: the loan + its schedule (+ the money-in line) and, when asked,
 * this statement line reconciled as EMI 1. Undo = Un-reconcile the line (R-1864 trigger).
 *
 * R-2341: `received_txn_id` = the imported money-in line that IS the loan money (no new line);
 * useLoanDisbursalLines lists the lines that can be it (lib/banking/loan-disbursal-lines.ts).
 * Un-reconciling that line on the bank page removes the loan again (refused while an EMI of it
 * is reconciled).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import { rupee } from "@/lib/utils";
import type { loanSetupPayload } from "@/lib/accounting/loan-setup";
import { DISBURSAL_AMOUNT_SLACK, type MoneyInLine } from "@/lib/banking/loan-disbursal-lines";

const untyped = () => createClient() as unknown as SupabaseClient;

export type LoanSetupResult = {
  purchase_id: string;
  reconciled: { seq: number; principal: number; interest: number } | null;
};

export type LoanSetupRpcPayload = ReturnType<typeof loanSetupPayload> & { received_txn_id?: string | null };

/** R-2341: unmatched money-in lines on the account for the loan amount (±₹1) in the date window. */
export function useLoanDisbursalLines(
  accountId: string | null, principal: number, window: { from: string; to: string } | null,
) {
  const ready = Boolean(accountId && principal > 0 && window);
  return useQuery({
    queryKey: ["bank_transactions", "loan-disbursal", accountId, principal, window?.from, window?.to],
    enabled: ready,
    queryFn: async (): Promise<MoneyInLine[]> => {
      if (!accountId || !window) return [];
      const { data, error } = await createClient()
        .from("bank_transactions")
        .select("id, txn_date, credit, debit, description, matched_to_type")
        .eq("bank_account_id", accountId)
        .is("matched_to_type", null)
        .eq("debit", 0)
        .gte("credit", principal - DISBURSAL_AMOUNT_SLACK)
        .lte("credit", principal + DISBURSAL_AMOUNT_SLACK)
        .gte("txn_date", window.from)
        .lte("txn_date", window.to)
        .order("txn_date", { ascending: true })
        .limit(20);
      if (error) throw new Error(error.message);
      return (data ?? []) as MoneyInLine[];
    },
  });
}

export function useSetUpEmiLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: LoanSetupRpcPayload): Promise<LoanSetupResult> => {
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
