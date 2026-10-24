/**
 * Un-reconcile — and say what un-reconciling leaves behind.
 *
 * Freeing a bank line used to be one silent click. When the line had been booked with
 * "Invoice banao & reconcile", its invoice and receipt stayed, and rebooking the line
 * counted the same money twice (INV-1111-2026-27-0001). `useUnreconcileImpact` reads what
 * the line points to so the confirm step can say it; `useUnreconcileBankTxn` runs
 * unreconcile_bank_receipt (migration 20260925210000), which can also undo that sale.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";

/** The receipt note useBookCreditAsInvoice writes — how a sale raised FROM a bank line is recognised. */
export const BANK_RECEIPT_NOTE = "Reconciled from bank receipt";

export type UnreconcileImpact =
  | { kind: "bank-sale"; amount: number; invoiceId: string | null; quoteId: string }
  | { kind: "receipt"; amount: number; invoiceId: string | null }
  | { kind: "project"; amount: number; projectTitle: string; milestoneLabel: string; invoiceId: string | null; projectId: string }
  | { kind: "other" };

export function useUnreconcileImpact(txn: BankTransactionRow | null) {
  return useQuery({
    queryKey: ["bank_transactions", "unreconcile-impact", txn?.id, txn?.matched_to_type, txn?.matched_to_id],
    enabled: !!txn?.matched_to_id,
    queryFn: async (): Promise<UnreconcileImpact> => {
      const supabase = createClient();
      if (!txn?.matched_to_id) return { kind: "other" };

      if (txn.matched_to_type === "payment") {
        const { data: pay, error } = await supabase
          .from("payments").select("id, amount, notes, quote_id, invoice_id").eq("id", txn.matched_to_id).maybeSingle();
        if (error) throw error;
        if (!pay) return { kind: "other" };
        /* R-1739: a payment on an imported Zoho invoice carries the invoice, not a quote. */
        const { data: q } = pay.quote_id
          ? await supabase.from("quotes").select("invoice_id").eq("id", pay.quote_id).maybeSingle()
          : { data: null };
        const invoiceId = q?.invoice_id ?? pay.invoice_id ?? null;
        return pay.notes === BANK_RECEIPT_NOTE && pay.quote_id
          ? { kind: "bank-sale", amount: pay.amount, invoiceId, quoteId: pay.quote_id }
          : { kind: "receipt", amount: pay.amount, invoiceId };
      }

      if (txn.matched_to_type === "project") {
        const { data: pp, error } = await supabase
          .from("project_payments").select("amount, project_id, milestone_id").eq("id", txn.matched_to_id).maybeSingle();
        if (error) throw error;
        if (!pp) return { kind: "other" };
        const [{ data: proj }, { data: ms }] = await Promise.all([
          supabase.from("project_sales").select("title").eq("id", pp.project_id).maybeSingle(),
          pp.milestone_id
            ? supabase.from("project_milestones").select("label, invoice_id").eq("id", pp.milestone_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        return {
          kind: "project", amount: pp.amount, projectId: pp.project_id,
          projectTitle: proj?.title ?? "project", milestoneLabel: ms?.label ?? "milestone", invoiceId: ms?.invoice_id ?? null,
        };
      }

      return { kind: "other" };
    },
  });
}

export function useUnreconcileBankTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { txnId: string; undoSale: boolean }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("unreconcile_bank_receipt", {
        p_txn_id: input.txnId,
        p_undo_sale: input.undoSale,
      });
      if (error) throw error;
      return data as { invoice_voided: string | null; invoice_credited: string | null; credit_note_id: string | null; receipt_removed: string | null };
    },
    onSuccess: (res) => {
      for (const k of ["bank_transactions", "bank_accounts",
                       "salary-payments", "expenses", "balance-sheet", "tax-payments", "project_sales", "accounting", "itr-pack"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      /* R-1634: a receipt removed / invoice credited changes what the customer owes. */
      invalidateReceivables(qc);
      toast.success(
        res?.invoice_credited ? `Un-reconciled · credit note ${res.credit_note_id ?? ""} raised on invoice ${res.invoice_credited}, receipt removed`
        : res?.invoice_voided ? `Un-reconciled · draft invoice ${res.invoice_voided} voided, receipt removed`
        : "Un-reconciled",
      );
    },
    onError: (err) => toastError(err, { fallback: "Un-reconcile failed" }),
  });
}
