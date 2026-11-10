/**
 * R-2656 (10 Nov 2026, G-RECON N3) — "Find transfer & reversal pairs" on Banking. Three RPCs of
 * migration 20261110081000_r2656_bank_pair_detector (owner / accountant only, own company only):
 *   bank_pair_candidates()   the preview (read only);
 *   book_bank_pairs(pairs)   books the pairs the SERVER finds sure right now, under a run id;
 *   undo_bank_pair_run(run)  un-reconciles that run's pairs (through the line's own un-reconcile).
 * Untyped client: the RPCs are newer than database.types.ts (as lib/queries/bank-other-income).
 * Keys start with "bank_transactions", so any reconcile anywhere refreshes the preview too.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { type BookPairsResult, type PairRow, type PairToBook, type UndoPairsResult } from "@/lib/banking/transfer-pair";

const untyped = () => createClient() as unknown as SupabaseClient;

export const pairKeys = {
  candidates: ["bank_transactions", "pair-candidates"] as const,
  lastRun: ["bank_transactions", "pair-last-run"] as const,
};

export function usePairCandidates(enabled: boolean) {
  return useQuery({
    queryKey: pairKeys.candidates,
    enabled,
    queryFn: async (): Promise<PairRow[]> => {
      const { data, error } = await untyped().rpc("bank_pair_candidates", {});
      if (error) throw new Error(error.message);
      return (data ?? []) as PairRow[];   // the server orders: sure first, then by date
    },
    staleTime: 10_000,
  });
}

export interface PairRun { id: string; created_at: string; pairs: number }

/**
 * The newest run that is not undone yet, with the pairs it still holds — its Undo stays on the sheet
 * after a reload. Two plain reads: the data gateway (DATA_GATEWAY=1 on staging / live) has no
 * embedded `(count)` aggregate.
 */
export function useLastPairRun(enabled: boolean) {
  return useQuery({
    queryKey: pairKeys.lastRun,
    enabled,
    queryFn: async (): Promise<PairRun | null> => {
      const { data, error } = await untyped()
        .from("bank_pair_runs")
        .select("id, created_at")
        .is("undone_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const r = (data ?? [])[0] as { id: string; created_at: string } | undefined;
      if (!r) return null;
      const lines = await untyped()
        .from("bank_pair_run_lines")
        .select("id")
        .eq("run_id", r.id)
        .is("undone_at", null);
      if (lines.error) throw new Error(lines.error.message);
      const pairs = (lines.data ?? []).length;
      return pairs > 0 ? { id: r.id, created_at: r.created_at, pairs } : null;
    },
    staleTime: 10_000,
  });
}

function refresh(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
}

export function useBookPairs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pairs: PairToBook[]): Promise<BookPairsResult> => {
      const { data, error } = await untyped().rpc("book_bank_pairs", { p_pairs: pairs });
      if (error) throw new Error(error.message);
      return data as BookPairsResult;
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't book the pairs" }),
  });
}

export function useUndoPairRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string): Promise<UndoPairsResult> => {
      const { data, error } = await untyped().rpc("undo_bank_pair_run", { p_run_id: runId });
      if (error) throw new Error(error.message);
      return data as UndoPairsResult;
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't undo the run" }),
  });
}
