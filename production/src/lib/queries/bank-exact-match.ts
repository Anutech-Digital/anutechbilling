/**
 * R-2677 (17 Nov 2026, G-RECON) — "Match all exact (N)" on Banking → an account. Three RPCs of
 * migration 20261117145227_r2677_match_all_exact (owner / accountant only, own company only):
 *   bank_exact_match_candidates(account, from, to, dir)  the preview (read only);
 *   book_bank_exact_matches(account, rows)               matches only what the SERVER finds exact now;
 *   undo_bank_exact_match_run(run)                       un-reconciles that run's lines.
 * Untyped client: the RPCs are newer than database.types.ts (as lib/queries/bank-pairs).
 * Keys start with "bank_transactions", so any reconcile anywhere refreshes the preview too.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { BookExactResult, ExactRow, ExactScope, ExactToBook, UndoExactResult } from "@/lib/banking/exact-match";

const untyped = () => createClient() as unknown as SupabaseClient;

export const exactKeys = {
  candidates: (accountId: string, s: ExactScope) => ["bank_transactions", "exact-candidates", accountId, s.from, s.to, s.dir] as const,
  lastRun: (accountId: string) => ["bank_transactions", "exact-last-run", accountId] as const,
};

export function useExactCandidates(accountId: string, scope: ExactScope, enabled: boolean) {
  return useQuery({
    queryKey: exactKeys.candidates(accountId, scope),
    enabled,
    queryFn: async (): Promise<ExactRow[]> => {
      const { data, error } = await untyped().rpc("bank_exact_match_candidates", {
        p_account_id: accountId, p_from: scope.from, p_to: scope.to, p_dir: scope.dir,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ExactRow[];   // the server orders by date
    },
    staleTime: 10_000,
  });
}

export interface ExactRun { id: string; created_at: string; lines: number }

/**
 * This account's newest run that is not undone yet, with the lines it still holds — its Undo stays
 * on the sheet after a reload. Two plain reads (the data gateway has no embedded count aggregate).
 */
export function useLastExactRun(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: exactKeys.lastRun(accountId),
    enabled,
    queryFn: async (): Promise<ExactRun | null> => {
      const { data, error } = await untyped()
        .from("bank_exact_match_runs")
        .select("id, created_at")
        .eq("bank_account_id", accountId)
        .is("undone_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const r = (data ?? [])[0] as { id: string; created_at: string } | undefined;
      if (!r) return null;
      const lines = await untyped()
        .from("bank_exact_match_run_lines")
        .select("id")
        .eq("run_id", r.id)
        .is("undone_at", null);
      if (lines.error) throw new Error(lines.error.message);
      const n = (lines.data ?? []).length;
      return n > 0 ? { id: r.id, created_at: r.created_at, lines: n } : null;
    },
    staleTime: 10_000,
  });
}

function refresh(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["payments"] });
}

export function useBookExactMatches(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: ExactToBook[]): Promise<BookExactResult> => {
      const { data, error } = await untyped().rpc("book_bank_exact_matches", { p_account_id: accountId, p_rows: rows });
      if (error) throw new Error(error.message);
      return data as BookExactResult;
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't match the lines" }),
  });
}

export function useUndoExactRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string): Promise<UndoExactResult> => {
      const { data, error } = await untyped().rpc("undo_bank_exact_match_run", { p_run_id: runId });
      if (error) throw new Error(error.message);
      return data as UndoExactResult;
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't undo the run" }),
  });
}
