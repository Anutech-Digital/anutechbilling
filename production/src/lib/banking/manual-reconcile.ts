/**
 * R-2361 — "Mark reconciled manually" asks first.
 *
 * Staging, 2 Nov 2026: one click on "Mark reconciled manually" closed a ₹12,00,000 line with no
 * confirm and no note — later nobody could tell why it was reconciled. Now the button opens a
 * small confirm (ManualReconcileDialog) that needs a reason; the save is ONE RPC,
 * reconcile_bank_txn_manual (migration 20261102091144), which writes the reason on the line
 * (bank_transactions.reconcile_note — the row-change trigger puts it in the activity log too)
 * and can reconcile the line's reversal with it (a failed / returned payment), both lines
 * pointing at each other (reversal_of). Un-reconciling one line of a pair frees both (trigger).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { formatDate, rupee } from "@/lib/utils";

/** The server refuses a shorter reason (reconcile_bank_txn_manual). */
export const MIN_REASON_CHARS = 5;
export const MAX_REASON_CHARS = 500;
/** A reversal is offered when it is this close in time (the server does not limit the gap). */
export const REVERSAL_WINDOW_DAYS = 30;

/** Why Save is off, or null when the reason is fine. */
export function reasonProblem(reason: string): string | null {
  const n = reason.trim().length;
  if (n === 0) return "Write why this line needs no entry.";
  if (n < MIN_REASON_CHARS) return `Write a little more (at least ${MIN_REASON_CHARS} characters).`;
  if (n > MAX_REASON_CHARS) return `Keep it under ${MAX_REASON_CHARS} characters.`;
  return null;
}

export interface LineLike {
  id: string;
  bank_account_id: string;
  txn_date: string;
  description: string | null;
  debit: number;
  credit: number;
  matched_to_type: string | null;
}

export const lineAmount = (t: Pick<LineLike, "debit" | "credit">): number => (t.credit > 0 ? t.credit : t.debit);

const dayGap = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000;

/**
 * The lines that can be this line's reversal: same account, same amount, the other side, still
 * open, within REVERSAL_WINDOW_DAYS — nearest date first. The server checks the same pairing rules
 * (except the window) on save.
 */
export function reversalCandidates<T extends LineLike>(txn: LineLike, lines: readonly T[]): T[] {
  const amount = lineAmount(txn);
  const isIn = txn.credit > 0;
  return lines
    .filter((l) => l.id !== txn.id
      && l.bank_account_id === txn.bank_account_id
      && l.matched_to_type === null
      && (isIn ? l.debit : l.credit) === amount
      && (isIn ? l.credit : l.debit) === 0
      && dayGap(l.txn_date, txn.txn_date) <= REVERSAL_WINDOW_DAYS)
    .sort((a, b) => dayGap(a.txn_date, txn.txn_date) - dayGap(b.txn_date, txn.txn_date) || a.txn_date.localeCompare(b.txn_date));
}

/** "Reversal of 10 Oct 2026 ₹12,00,000" — the words a paired line shows. */
export function reversalLabel(partner: Pick<LineLike, "txn_date" | "debit" | "credit">): string {
  return `Reversal of ${formatDate(partner.txn_date)} ${rupee(lineAmount(partner))}`;
}

/** Open lines on this account that could be the reversal (the dialog filters them). */
export function useReversalCandidates(txn: LineLike | null, enabled: boolean) {
  return useQuery({
    queryKey: ["bank_transactions", "reversal-candidates", txn?.id ?? null],
    enabled: enabled && Boolean(txn),
    queryFn: async (): Promise<LineLike[]> => {
      if (!txn) return [];
      const amount = lineAmount(txn);
      const isIn = txn.credit > 0;
      const { data, error } = await createClient()
        .from("bank_transactions")
        .select("id, bank_account_id, txn_date, description, debit, credit, matched_to_type")
        .eq("bank_account_id", txn.bank_account_id)
        .is("matched_to_type", null)
        .eq(isIn ? "debit" : "credit", amount)
        .neq("id", txn.id)
        .limit(50);
      if (error) throw error;
      return reversalCandidates(txn, (data ?? []) as LineLike[]);
    },
    staleTime: 10_000,
  });
}

export function useReconcileManually() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; reason: string; reversalId?: string | null }) => {
      const { data, error } = await createClient().rpc("reconcile_bank_txn_manual", {
        p_txn_id: input.transactionId,
        p_reason: input.reason.trim(),
        ...(input.reversalId ? { p_reversal_txn_id: input.reversalId } : {}),
      });
      if (error) throw error;
      return data as { txn_id: string; reversal_id: string | null; bank_account_id: string };
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success(row?.reversal_id ? "Both lines reconciled as a reversal" : "Reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Reconcile failed" }),
  });
}

/**
 * The note saved with an Owner capital / drawings booking (owner_equity_movements.note), by bank
 * line — shown under the line's Reconciled badge like a manual line's reason.
 */
export function useOwnerBookingNotes(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["bank_transactions", "owner-notes", accountId ?? null],
    enabled: Boolean(accountId),
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await createClient()
        .from("owner_equity_movements")
        .select("bank_txn_id, note")
        .eq("bank_account_id", accountId as string)
        .not("bank_txn_id", "is", null)
        .not("note", "is", null);
      if (error) throw error;
      const out = new Map<string, string>();
      for (const r of (data ?? []) as { bank_txn_id: string | null; note: string | null }[]) {
        if (r.bank_txn_id && r.note?.trim()) out.set(r.bank_txn_id, r.note.trim());
      }
      return out;
    },
    staleTime: 30_000,
  });
}

/** The words under a reconciled line's badge: the manual reason or the owner booking's note. */
export function lineNote(
  txn: { id: string; matched_to_type: string | null; reconcile_note?: string | null },
  ownerNotes?: ReadonlyMap<string, string>,
): string | null {
  if (txn.reconcile_note?.trim()) return txn.reconcile_note.trim();
  if (txn.matched_to_type === "owner_equity") return ownerNotes?.get(txn.id) ?? null;
  return null;
}

export interface LineNoteLines {
  /** "Reversal of 10 Oct 2026 ₹12,00,000" for one line of a reversal pair. */
  reversal: string | null;
  /** The manual reason / owner booking note. */
  note: string | null;
}

/** What a reconciled line shows under its badge; null when there is nothing to show. */
export function lineNoteLines(
  txn: { id: string; matched_to_type: string | null; reconcile_note?: string | null; reversal_of?: string | null },
  byId: ReadonlyMap<string, Pick<LineLike, "txn_date" | "debit" | "credit">>,
  ownerNotes?: ReadonlyMap<string, string>,
): LineNoteLines | null {
  if (!txn.matched_to_type) return null;
  const partner = txn.reversal_of ? byId.get(txn.reversal_of) : undefined;
  const reversal = partner ? reversalLabel(partner) : txn.reversal_of ? "Reversal pair" : null;
  const note = lineNote(txn, ownerNotes);
  return reversal || note ? { reversal, note } : null;
}
