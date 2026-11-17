/**
 * R-2677 (17 Nov 2026, G-RECON) — "Match all exact" on Banking → an account. Three RPCs of
 * migration 20261117145227_r2677_match_all_exact (owner / accountant only, own company only):
 *   bank_exact_match_candidates(account, from, to, dir, after, limit)  the preview, a page at a time;
 *   book_bank_exact_matches(account, rows, run, scope)                 matches only what the SERVER finds exact now;
 *   undo_bank_exact_match_run(run, limit)                              un-reconciles that run's lines.
 * Each call is kept small (pages / chunks) so it stays inside the signed-in role's statement timeout;
 * one press of Match is still ONE run (later chunks pass the run id the first one returned).
 * Untyped client: the RPCs are newer than database.types.ts (as lib/queries/bank-pairs).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import {
  EXACT_BOOK_CHUNK, EXACT_LINE_CAP, EXACT_PAGE, EXACT_UNDO_PAGE, mergeBookResults, sortExactRows,
  type BookExactResult, type ExactRow, type ExactScope, type ExactToBook, type UndoExactResult,
} from "@/lib/banking/exact-match";

const untyped = () => createClient() as unknown as SupabaseClient;

/* Not under "bank_transactions": the preview is the heaviest read on the page, so it is refreshed
   only by this sheet's own Match / Undo (the server re-checks every row anyway). */
export const exactKeys = {
  all: ["bank_exact_match"] as const,
  candidates: (accountId: string, s: ExactScope) => ["bank_exact_match", "candidates", accountId, s.from, s.to, s.dir] as const,
  lastRun: (accountId: string) => ["bank_exact_match", "last-run", accountId] as const,
};

export function useExactCandidates(accountId: string, scope: ExactScope, enabled: boolean) {
  return useQuery({
    queryKey: exactKeys.candidates(accountId, scope),
    enabled,
    queryFn: async (): Promise<ExactRow[]> => {
      const rows: ExactRow[] = [];
      let after: string | null = null;
      while (rows.length < EXACT_LINE_CAP) {
        const { data, error } = await untyped().rpc("bank_exact_match_candidates", {
          p_account_id: accountId, p_from: scope.from, p_to: scope.to, p_dir: scope.dir,
          p_after: after, p_limit: EXACT_PAGE,
        });
        if (error) throw new Error(error.message);
        const page = (data ?? []) as ExactRow[];
        rows.push(...page);
        if (page.length < EXACT_PAGE) break;
        after = page[page.length - 1].txn_id;   // the server pages by line id
      }
      return sortExactRows(rows.slice(0, EXACT_LINE_CAP));
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
  qc.invalidateQueries({ queryKey: exactKeys.all });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["payments"] });
}

export function useBookExactMatches(accountId: string, scope: ExactScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: ExactToBook[]): Promise<BookExactResult> => {
      const parts: BookExactResult[] = [];
      let runId: string | null = null;
      for (let i = 0; i < rows.length; i += EXACT_BOOK_CHUNK) {
        const { data, error } = await untyped().rpc("book_bank_exact_matches", {
          p_account_id: accountId, p_rows: rows.slice(i, i + EXACT_BOOK_CHUNK), p_run_id: runId, p_scope: scope,
        });
        if (error) {
          // A later chunk failing leaves the earlier ones matched (and undoable) — say so.
          if (parts.length > 0) return { ...mergeBookResults(parts), stoppedEarly: error.message };
          throw new Error(error.message);
        }
        const part = data as BookExactResult;
        parts.push(part);
        runId = runId ?? part.run_id;
      }
      return mergeBookResults(parts);
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't match the lines" }),
  });
}

export function useUndoExactRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string): Promise<UndoExactResult> => {
      const total: UndoExactResult = { run_id: runId, undone: 0, left: [], remaining: 0 };
      // Pages until nothing is left, or a page changes nothing (only refused lines left).
      for (let guard = 0; guard < 100; guard += 1) {
        const { data, error } = await untyped().rpc("undo_bank_exact_match_run", { p_run_id: runId, p_limit: EXACT_UNDO_PAGE });
        if (error) throw new Error(error.message);
        const r = data as UndoExactResult;
        total.undone += r.undone;
        total.left.push(...r.left);
        total.remaining = r.remaining;
        if (r.remaining === 0 || r.undone + r.left.length === 0) break;
      }
      return total;
    },
    onSuccess: () => refresh(qc),
    onError: (err) => toastError(err, { fallback: "Couldn't undo the run" }),
  });
}
