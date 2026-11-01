/**
 * R-2339 — edit / delete a loan set up from an EMI line (Accounting › Business Loans).
 *
 * edit_emi_loan / delete_emi_loan (migration 20261101092000_r2339_emi_loan_edit_delete.sql) are
 * newer than the generated types, so they go through an untyped client (as loan-setup-query.ts
 * does). Each is one transaction on the server; the server refuses a delete once an EMI is
 * reconciled and any schedule that does not follow the rate or clear what is owed.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import type { loanEditPayload } from "@/lib/accounting/loan-edit";

const untyped = () => createClient() as unknown as SupabaseClient;

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ["emi-purchases", "emi-matches", "bank_transactions", "bank_accounts", "balance-sheet", "expenses"]) {
    qc.invalidateQueries({ queryKey: [k] });
  }
  qc.invalidateQueries({ queryKey: queryKeys.pnl() });
}

export function useEditEmiLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ReturnType<typeof loanEditPayload>) => {
      const { data, error } = await untyped().rpc("edit_emi_loan", { p: payload });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The change was not confirmed — refresh Business Loans to see whether it was saved.");
      return data as { from_seq: number; emis_left: number };
    },
    onSuccess: (r) => {
      invalidate(qc);
      toast.success(`Loan updated — EMI ${r.from_seq} onwards recomputed (${r.emis_left} EMIs left); paid EMIs unchanged`);
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteEmiLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (purchaseId: string) => {
      const { data, error } = await untyped().rpc("delete_emi_loan", { p_purchase_id: purchaseId });
      if (error) throw new Error(error.message);
      return data as { money_in_line: "line_unmatched" | "manual_line_removed" | "none" };
    },
    onSuccess: (r) => {
      invalidate(qc);
      toast.success(r?.money_in_line === "line_unmatched"
        ? "Loan deleted — its money-in line is back to unmatched on the bank page"
        : r?.money_in_line === "manual_line_removed"
          ? "Loan deleted — the money-in line it added is removed too"
          : "Loan deleted");
    },
    onError: (err) => toastError(err),
  });
}
