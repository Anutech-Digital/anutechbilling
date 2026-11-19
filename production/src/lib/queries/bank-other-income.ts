/**
 * R-2095 (30 Oct 2026, September reconcile) — two bank-line bookings that had no way in:
 *   - interest credited by the bank (FD / savings) → OTHER INCOME (book_bank_credit_as_other_income),
 *     shown in the P&L by report_pnl_other_income;
 *   - an FD sweep-in / sweep-out → a TRANSFER with another of the company's accounts
 *     (reconcile_bank_txn_as_transfer), so the FD account's balance moves too.
 * Migration r2095_other_income_fd_transfer. Untyped client: newer than database.types.ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  qc.invalidateQueries({ queryKey: ["interest_without_tds"] });   // R-2935: a booked interest can now take its TDS line
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

/** R-2366: interest income from a money-in line — FD / savings / other; an FD closure books the
 *  principal as money back from the FD (its balance goes down) and the rest as interest; TDS the
 *  bank deducted → TDS receivable. book_bank_credit_as_interest (migration 20261102100702). */
export type BookInterestInput = {
  transactionId: string;
  source: "fd" | "savings" | "other";
  fdAccountId: string | null;
  principal: number;
  interest: number;
  tds: number;
};

export function useBookInterestIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BookInterestInput) => {
      const { data, error } = await untyped().rpc("book_bank_credit_as_interest", {
        p_txn_id: input.transactionId, p_source: input.source, p_fd_account: input.fdAccountId,
        p_principal: input.principal, p_interest: input.interest, p_tds: input.tds, p_note: null,
      });
      if (error) throw new Error(error.message);
      return data as { interest: number; principal: number; fd_account: string | null };
    },
    onSuccess: (r) => {
      invalidate(qc);
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success((r?.principal ?? 0) > 0
        ? `FD closure booked — principal back from ${r.fd_account ?? "the FD"}, interest in Other income`
        : "Booked as interest received (other income) & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this line as interest" }),
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

/** R-2935: the booked bank interest (no TDS on it yet) a money-out TDS line can belong to —
 *  bank_interest_without_tds (migration 20261118233537), nearest date first. */
export type InterestWithoutTds = {
  id: string; income_date: string; amount: number; description: string | null; source: string | null; fd_name: string | null;
};

export function useInterestWithoutTds(transactionId: string | null) {
  return useQuery({
    queryKey: ["interest_without_tds", transactionId],
    enabled: !!transactionId,
    /* Interest is booked / un-reconciled from other screens too — always ask again when the sheet opens. */
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async (): Promise<InterestWithoutTds[]> => {
      const { data, error } = await untyped().rpc("bank_interest_without_tds", { p_txn_id: transactionId });
      if (error) throw new Error(error.message);
      return ((data ?? []) as InterestWithoutTds[]).map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });
}

/** R-2935: a money-out line that is the TDS the bank cut on that interest → TDS receivable (194A).
 *  book_bank_debit_as_interest_tds: Dr TDS receivable, Cr Bank — the income is not touched. */
export function useBookInterestTds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; otherIncomeId: string }) => {
      const { data, error } = await untyped().rpc("book_bank_debit_as_interest_tds", {
        p_txn_id: input.transactionId, p_other_income_id: input.otherIncomeId,
      });
      if (error) throw new Error(error.message);
      return data as { tds: number; interest: number; net: number; rate_pct: number };
    },
    onSuccess: () => {
      invalidate(qc);
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Booked as TDS receivable (Sec 194A) & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this line as TDS on interest" }),
  });
}
