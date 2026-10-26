/**
 * Un-reconcile — and say what un-reconciling leaves behind.
 *
 * Freeing a bank line used to be one silent click. When the line had been booked with
 * "Invoice banao & reconcile", its invoice and receipt stayed, and rebooking the line
 * counted the same money twice (INV-1111-2026-27-0001). `useUnreconcileImpact` reads what
 * the line points to so the confirm step can say it; `useUnreconcileBankTxn` runs
 * unreconcile_bank_receipt (migration 20260925210000), which can also undo that sale.
 * R-1920: a vendor-payment line gets the server's preview of every leg it reverses, and a
 * refusal (later payment, used advance, deposited TDS) with the page to fix it on.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";

/** The receipt note useBookCreditAsInvoice writes — how a sale raised FROM a bank line is recognised. */
export const BANK_RECEIPT_NOTE = "Reconciled from bank receipt";

/** R-1863: the receipt note reconcile_bank_credit_as_advance writes — a line booked as a customer's advance. */
export const BANK_ADVANCE_NOTE_PREFIX = "Advance on account — bank credit of ";

export type UnreconcileImpact =
  | { kind: "bank-sale"; amount: number; invoiceId: string | null; quoteId: string }
  /** R-1863: un-reconciling takes the advance back (receipt + credit); refused once any is used. */
  | { kind: "advance"; amount: number; customerName: string | null; voucherNo: string | null; usedOrRefunded: number }
  | { kind: "receipt"; amount: number; invoiceId: string | null }
  | { kind: "project"; amount: number; projectTitle: string; milestoneLabel: string; invoiceId: string | null; projectId: string }
  /** R-1920: a vendor payment — what goes back, worked out by the server (vendor_payment_undo_preview). */
  | { kind: "vendor-payment"; preview: VendorUndoPreview }
  | { kind: "other" };

/** R-1920: one row of bank_vendor_payment_lines, with its document before / after the undo. */
export type VendorUndoLeg = {
  id: string;
  kind: "bill" | "expense" | "new_bill" | "new_expense" | "advance" | "bank_charge" | "recorded_payment";
  cash: number;
  tds_amount: number;
  tds_section: string | null;
  doc_type: "vendor_bill" | "expense" | "advance";
  doc_id: string;
  doc_no: string | null;
  doc_total: number | null;
  before_paid: number | null;
  before_status: string | null;
  /** After the dry run — absent when the undo is refused (the dry run stopped). */
  after_paid?: number | null;
  after_status?: string | null;
  removed?: boolean;
  href: string;
};

/** R-1920: the server's dry run of un-reconciling a vendor-payment line (always rolled back). */
export type VendorUndoPreview = {
  txn_id: string;
  debit: number;
  txn_date: string;
  vendor_name: string | null;
  legs: VendorUndoLeg[];
  blocked: boolean;
  block_message: string | null;
  block_href: string | null;
};

const STATUS_LABEL: Record<string, string> = { unpaid: "Unpaid", partial: "Part paid", paid: "Paid" };

/**
 * R-1920: one plain line per leg — what un-reconciling does to it. The numbers come from the
 * server's dry run, so the sentence says what the trigger will really do.
 */
export function vendorUndoLegLine(leg: VendorUndoLeg): string {
  const doc = `${leg.doc_type === "vendor_bill" ? "Bill" : "Expense bill"} ${leg.doc_no ?? leg.doc_id}`;
  const tds = leg.tds_amount > 0 ? `; TDS ${rupee(leg.tds_amount)}${leg.tds_section ? ` (${leg.tds_section})` : ""} taken off` : "";
  if (leg.kind === "advance") return `Advance of ${rupee(leg.cash)} to the vendor is removed`;
  if (leg.kind === "bank_charge") return `Bank charge of ${rupee(leg.cash)} is removed`;
  if (leg.kind === "recorded_payment") return `${doc}: the payment recorded earlier comes back, waiting for its bank line`;
  const created = leg.kind === "new_bill" || leg.kind === "new_expense";
  if (leg.removed) {
    return created
      ? `${doc} (${rupee(leg.doc_total ?? leg.cash + leg.tds_amount)}), created from this line, is deleted${tds}`
      : `${doc} is deleted${tds}`;
  }
  // A refused preview has no "after" — say only what this line's money is.
  if (!leg.after_status) return `${doc}${created ? ", created from this line" : ""}: ${rupee(leg.cash)} from this line comes off${tds}`;
  const status = STATUS_LABEL[leg.after_status] ?? leg.after_status;
  const due = leg.after_status === "unpaid" && leg.doc_total != null ? `, ${rupee(leg.doc_total)} due again`
    : leg.after_status === "partial" && leg.after_paid != null ? ` (${rupee(leg.after_paid)} paid stays)` : "";
  return `${doc} goes back to ${status}${due} — ${rupee(leg.cash)} from this line comes off${tds}`;
}

/** R-1920: the page a refusal's link opens, as a button label. */
export function blockHrefLabel(href: string): string {
  if (href.startsWith("/accounting/banking")) return "Open Banking";
  if (href.startsWith("/accounting/expenses")) return "Open Expenses";
  if (href.startsWith("/accounting/bills")) return "Open Bills";
  if (href.startsWith("/accounting/prepaid")) return "Open Prepaid";
  return "Open";
}

export function useUnreconcileImpact(txn: BankTransactionRow | null) {
  return useQuery({
    queryKey: ["bank_transactions", "unreconcile-impact", txn?.id, txn?.matched_to_type, txn?.matched_to_id],
    enabled: !!txn?.matched_to_id,
    queryFn: async (): Promise<UnreconcileImpact> => {
      const supabase = createClient();
      if (!txn?.matched_to_id) return { kind: "other" };

      if (txn.matched_to_type === "payment") {
        const { data: pay, error } = await supabase
          .from("payments").select("id, amount, notes, quote_id, invoice_id, customer_id, receipt_voucher_no").eq("id", txn.matched_to_id).maybeSingle();
        if (error) throw error;
        if (!pay) return { kind: "other" };
        if (pay.notes?.startsWith(BANK_ADVANCE_NOTE_PREFIX)) {
          const [{ data: credits, error: cErr }, { data: cust }] = await Promise.all([
            supabase.from("customer_credits").select("amount, status").eq("source_payment_id", pay.id),
            pay.customer_id
              ? supabase.from("customers").select("name").eq("id", pay.customer_id).maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          if (cErr) throw cErr;
          const open = (credits ?? []).filter((c) => c.status === "open").reduce((s, c) => s + (c.amount ?? 0), 0);
          return {
            kind: "advance", amount: pay.amount, customerName: cust?.name ?? null,
            voucherNo: pay.receipt_voucher_no ?? null, usedOrRefunded: Math.max(0, pay.amount - open),
          };
        }
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

      if (txn.matched_to_type === "vendor_payment") {
        const { data, error } = await supabase.rpc("vendor_payment_undo_preview" as never, { p_txn_id: txn.id } as never);
        if (error) throw error;
        return { kind: "vendor-payment", preview: data as unknown as VendorUndoPreview };
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
      return data as { invoice_voided: string | null; invoice_credited: string | null; credit_note_id: string | null; receipt_removed: string | null; advance_removed?: number | null };
    },
    onSuccess: (res) => {
      for (const k of ["bank_transactions", "bank_accounts",
                       "salary-payments", "expenses", "vendor_bills", "prepaid_advances", "balance-sheet", "tax-payments", "project_sales", "accounting", "itr-pack"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      /* R-1634: a receipt removed / invoice credited changes what the customer owes. */
      invalidateReceivables(qc);
      toast.success(
        res?.advance_removed ? `Un-reconciled · advance of ${rupee(res.advance_removed)} and its receipt removed`
        : res?.invoice_credited ? `Un-reconciled · credit note ${res.credit_note_id ?? ""} raised on invoice ${res.invoice_credited}, receipt removed`
        : res?.invoice_voided ? `Un-reconciled · draft invoice ${res.invoice_voided} voided, receipt removed`
        : "Un-reconciled",
      );
    },
    onError: (err) => toastError(err, { fallback: "Un-reconcile failed" }),
  });
}
