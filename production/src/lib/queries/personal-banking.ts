/**
 * R-2394 — Private Vault → Banking account page: one account's lines, the entries a statement
 * line can be matched to, and the reconcile / undo RPCs (migration
 * 20261103012000_r2394_personal_banking.sql). Same owner-only RLS as every vault table; the
 * RPCs are SECURITY INVOKER and take owner/tenant from the session — nothing here sends a
 * user id.
 *
 * Its own module so a screen test can mock it in one line. The new columns are newer than the
 * generated DB types, so the row shape is written here and the client is used untyped.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireIdentity, invalidateAll } from "@/lib/queries/personal-vault";
import type { LedgerTx, ReconcileAction } from "@/lib/vault/personal/bank-ledger";

const db = () => createClient() as unknown as SupabaseClient;

export type AccountTx = LedgerTx & { tenant_id: string; owner_user_id: string; import_batch_id: string | null };

/** Every line on one account, oldest first (a personal account has hundreds, not lakhs). */
export function useAccountTransactions(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["personal-vault", "account-transactions", accountId],
    enabled: !!accountId,
    queryFn: async (): Promise<AccountTx[]> => {
      const { data, error } = await db()
        .from("personal_transactions")
        .select("*")
        .eq("account_id", accountId!)
        .order("occurred_on", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as AccountTx[];
    },
    staleTime: 15_000,
  });
}

/**
 * Entries typed on another page (Loans, Income & Expenses) with this amount, on this account
 * or on no account — what a statement line may already be.
 */
export function useMatchableEntries(accountId: string | null | undefined, amount: number | null | undefined) {
  return useQuery({
    queryKey: ["personal-vault", "matchable", accountId, amount],
    enabled: !!accountId && !!amount,
    queryFn: async (): Promise<AccountTx[]> => {
      const { data, error } = await db()
        .from("personal_transactions")
        .select("*")
        .eq("source", "manual")
        .is("dedupe_hash", null)
        .eq("amount", amount!)
        .or(`account_id.eq.${accountId},account_id.is.null`)
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AccountTx[];
    },
    staleTime: 15_000,
  });
}

export interface ReconcileInput {
  txId: string;
  action: ReconcileAction;
  payload: Record<string, string | number | null | undefined>;
}

export interface ReconcileResult { tx_id: string; action: ReconcileAction; pair_tx_id: string | null; suggested: number }

/** ONE RPC per line: the line, its other leg / loan rows / owe-hold entry and the rule land together (§17b). */
export function useReconcileLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReconcileInput): Promise<ReconcileResult> => {
      await requireIdentity();
      const payload = Object.fromEntries(
        Object.entries(input.payload).filter(([, v]) => v !== undefined && v !== null && v !== ""),
      );
      const { data, error } = await db().rpc("personal_bank_reconcile", {
        p_tx_id: input.txId, p_action: input.action, p: payload,
      });
      if (error) throw error;
      return data as ReconcileResult;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not match the line." }),
  });
}

export function useUnreconcileLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (txId: string) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_bank_unreconcile", { p_tx_id: txId });
      if (error) throw error;
      return data as { tx_id: string; removed_pair: boolean };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not undo the match." }),
  });
}
