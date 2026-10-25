/**
 * R-1913 — set a vendor's advance off against an expense bill already in the books, and undo it.
 *
 *   apply_vendor_advance(p_source, p_doc_id, p_amount?, p_date?) — ONE transaction (migration
 *     20261025164002): takes up to min(advance left, bill due) from the vendor's advances, oldest
 *     first; no new expense row (the bill is the cost). Settled in full → the bill is paid.
 *   undo_vendor_advance(p_expense_id) — gives the advance back and reopens the bill.
 * The amounts the toast shows are what the database did.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";

/* The generated types do not list the R-1913 functions. */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

export interface ApplyAdvanceResult {
  expense_id: string; bill_no: string | null; vendor_name: string;
  applied: number; still_due: number; settled: boolean; advance_left: number;
}

/** The toast sentence after Apply advance. */
export function applyAdvanceWords(r: ApplyAdvanceResult): string {
  const bill = r.bill_no ? `bill ${r.bill_no}` : "the bill";
  return r.settled
    ? `${rupee(r.applied)} of ${r.vendor_name}'s advance applied — ${bill} is paid.${r.advance_left > 0 ? ` ${rupee(r.advance_left)} advance left.` : ""}`
    : `${rupee(r.applied)} of ${r.vendor_name}'s advance applied — ${rupee(r.still_due)} still due on ${bill}.`;
}

function useInvalidateMoney() {
  const qc = useQueryClient();
  return () => {
    for (const key of [["expenses"], ["prepaid_advances"], ["vendors"], ["vendor-payments"], ["balance-sheet"], ["bank_debit_vendor_open_items"]]) {
      qc.invalidateQueries({ queryKey: key });
    }
  };
}

export function useApplyVendorAdvance() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (input: { expenseId: string; amount?: number | null }): Promise<ApplyAdvanceResult> => {
      const { data, error } = await rpc("apply_vendor_advance", {
        p_source: "expense", p_doc_id: input.expenseId, p_amount: input.amount ?? null,
      });
      if (error) throw new Error(error.message);
      const r = data as Record<string, unknown>;
      return {
        expense_id: String(r.expense_id), bill_no: (r.bill_no as string | null) ?? null, vendor_name: String(r.vendor_name ?? ""),
        applied: Number(r.applied) || 0, still_due: Number(r.still_due) || 0, settled: Boolean(r.settled), advance_left: Number(r.advance_left) || 0,
      };
    },
    onSuccess: (r) => { invalidate(); toast.success(applyAdvanceWords(r)); },
    onError: (err) => toastError(err),
  });
}

export function useUndoVendorAdvance() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (expenseId: string): Promise<{ given_back: number; bill_no: string | null }> => {
      const { data, error } = await rpc("undo_vendor_advance", { p_expense_id: expenseId });
      if (error) throw new Error(error.message);
      const r = data as Record<string, unknown>;
      return { given_back: Number(r.given_back) || 0, bill_no: (r.bill_no as string | null) ?? null };
    },
    onSuccess: (r) => {
      invalidate();
      toast.success(`Advance undone — ${rupee(r.given_back)} is back with the vendor and ${r.bill_no ? `bill ${r.bill_no}` : "the bill"} is open again.`);
    },
    onError: (err) => toastError(err),
  });
}
