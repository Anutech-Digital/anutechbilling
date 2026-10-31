/**
 * R-2095 (30 Oct 2026, September reconcile) — two bank-line bookings that had no way in:
 *   - interest credited by the bank (FD / savings) → OTHER INCOME (book_bank_credit_as_other_income),
 *     shown in the P&L by report_pnl_other_income;
 *   - an FD sweep-in / sweep-out → a TRANSFER with another of the company's accounts
 *     (reconcile_bank_txn_as_transfer), so the FD account's balance moves too.
 * Migration r2095_other_income_fd_transfer. Untyped client: newer than database.types.ts.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";

const untyped = () => createClient() as unknown as SupabaseClient;

export type OtherIncomeHead = "interest" | "other";

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: queryKeys.pnl() });
}

export function useBookOtherIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; head: OtherIncomeHead; note?: string | null }) => {
      const { data, error } = await untyped().rpc("book_bank_credit_as_other_income", {
        p_txn_id: input.transactionId, p_head: input.head, p_note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (_d, input) => {
      invalidate(qc);
      toast.success(input.head === "interest" ? "Booked as interest received (other income) & reconciled" : "Booked as other income & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this line as income" }),
  });
}

export function useReconcileAsTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; otherAccountId: string }) => {
      const { data, error } = await untyped().rpc("reconcile_bank_txn_as_transfer", {
        p_txn_id: input.transactionId, p_other_account: input.otherAccountId,
      });
      if (error) throw new Error(error.message);
      return data as { pair_id: string; added: boolean; other_account: string };
    },
    onSuccess: (r) => {
      invalidate(qc);
      toast.success(r?.added
        ? `Transfer posted — the matching line was added to ${r.other_account}`
        : `Transfer matched with ${r?.other_account ?? "the other account"}'s own line`);
    },
    onError: (err) => toastError(err, { fallback: "Couldn't post the transfer" }),
  });
}
