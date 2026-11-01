/**
 * R-2325 — Banking → Reconcile → "Suggested matches" never offers an expense that is already
 * reconciled to a bank line.
 *
 * suggest_bank_transaction_matches (SQL) picks expenses by amount and date only, so an expense
 * that another bank line already paid (expenses.reconciled_txn_id set by reconcile_bank_txn /
 * reconcile_bank_debit_to_vendor, or an older bank line matched to it) came back as a "Match"
 * on the next line with the same amount — matching it again would count one bill twice
 * (staging money-out reconcile, 31 Oct). The RPC returns at most 5 expenses, so the check is
 * one small read of those ids.
 */
"use client";

import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";

export interface SuggestionLike {
  match_type: string;
  match_id: string;
}

/** The expense ids among the suggestions — the only kind this check reads. */
export function expenseSuggestionIds(list: readonly SuggestionLike[] | null | undefined): string[] {
  return [...new Set((list ?? []).filter((s) => s.match_type === "expense").map((s) => s.match_id))].sort();
}

/**
 * Which of these expenses are reconciled to a bank line OTHER than `txnId` — from the expense's
 * own `reconciled_txn_id`, and from a bank line matched to it (`matched_to_type = 'expense'`).
 * A match to this same line is not "already reconciled elsewhere".
 */
export function reconciledElsewhere(
  txnId: string,
  expenses: readonly { id: string; reconciled_txn_id: string | null }[],
  bankLines: readonly { id: string; matched_to_id: string | null }[],
): Set<string> {
  const out = new Set<string>();
  for (const e of expenses) if (e.reconciled_txn_id && e.reconciled_txn_id !== txnId) out.add(e.id);
  for (const b of bankLines) if (b.matched_to_id && b.id !== txnId) out.add(b.matched_to_id);
  return out;
}

/** The suggestions without the expenses already reconciled elsewhere. Other kinds pass through. */
export function dropReconciledExpenses<T extends SuggestionLike>(list: readonly T[] | null | undefined, reconciled: ReadonlySet<string>): T[] {
  return (list ?? []).filter((s) => !(s.match_type === "expense" && reconciled.has(s.match_id)));
}

/** The expense ids among `ids` that are already reconciled to another bank line. */
export function useReconciledExpenseIds(txnId: string | null | undefined, ids: readonly string[]) {
  return useQuery({
    queryKey: ["bank_txn_matches", txnId, "reconciled-expenses", ids.join(",")],
    enabled: Boolean(txnId) && ids.length > 0,
    queryFn: async (): Promise<Set<string>> => {
      if (!txnId || ids.length === 0) return new Set();
      const supabase = createClient();
      const [exp, lines] = await Promise.all([
        supabase.from("expenses").select("id, reconciled_txn_id").in("id", [...ids]),
        supabase.from("bank_transactions").select("id, matched_to_id").eq("matched_to_type", "expense").in("matched_to_id", [...ids]),
      ]);
      if (exp.error) throw exp.error;
      if (lines.error) throw lines.error;
      return reconciledElsewhere(txnId, exp.data ?? [], lines.data ?? []);
    },
    staleTime: 30_000,
  });
}
