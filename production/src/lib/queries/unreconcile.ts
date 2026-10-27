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
 * R-1999: a project-receipt line gets the same — every kist the line paid (bank + TDS), before and
 * after, from project_receipt_undo_preview; un-reconciling takes the whole booking back, and each
 * invoice stays, due again (Pardeep's D3: no credit note).
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
  /** R-1999: a project receipt — every kist it paid, worked out by the server (project_receipt_undo_preview). */
  | { kind: "project"; preview: ProjectUndoPreview }
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

/** R-1999: one kist the project-receipt line paid, before / after the undo (from the server's dry run). */
export type ProjectUndoRow = {
  milestone_id: string;
  label: string;
  project_id: string;
  project_title: string;
  customer_name: string | null;
  total: number;
  /** What this line put on the kist: the bank part and the customer's TDS. */
  bank: number;
  tds: number;
  before_paid: number;
  before_status: string;
  invoice_id: string | null;
  invoice_status_before: string | null;
  /** After the dry run — absent when the undo is refused (the dry run stopped). */
  after_paid?: number;
  after_status?: string;
  invoice_status_after?: string | null;
  href: string;
};

/** R-1999: the server's dry run of un-reconciling a project-receipt line (always rolled back). */
export type ProjectUndoPreview = {
  txn_id: string;
  credit: number;
  txn_date: string;
  customer_name: string | null;
  project_title: string | null;
  rows: ProjectUndoRow[];
  bank_total: number;
  tds_total: number;
  blocked: boolean;
  block_message: string | null;
  block_href: string | null;
};

const KIST_STATUS: Record<string, string> = { pending: "Pending", invoiced: "Invoiced", paid: "Paid" };

/**
 * R-1999: one plain line per kist — what un-reconciling does to it. D3: the invoice stays (never a
 * credit note) and is due again for what is no longer paid.
 */
export function projectUndoRowLine(row: ProjectUndoRow): string {
  const money = `${rupee(row.bank)} payment${row.tds > 0 ? ` + ${rupee(row.tds)} TDS` : ""}`;
  const head = `${row.label} (${row.project_title}): ${money} removed`;
  if (!row.after_status) return head;
  const kist = ` — back to ${KIST_STATUS[row.after_status] ?? row.after_status}`;
  if (!row.invoice_id) return head + kist;
  const due = Math.max(0, row.total - (row.after_paid ?? 0));
  const inv = row.invoice_status_after === "paid"
    ? `; invoice ${row.invoice_id} stays paid`
    : `; invoice ${row.invoice_id} stays, ${rupee(due)} due again`;
  return head + kist + inv;
}

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
  if (href.startsWith("/accounting/tds-receivable")) return "Open TDS receivable";
  if (href.startsWith("/referrals")) return "Open Referrals";
  if (href.startsWith("/projects")) return "Open project";
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
        /* R-1999: every kist the line paid (R-1995 shares one line across several) — not just
           the payment matched_to_id names. */
        const { data, error } = await supabase.rpc("project_receipt_undo_preview" as never, { p_txn_id: txn.id } as never);
        if (error) throw error;
        return { kind: "project", preview: data as unknown as ProjectUndoPreview };
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
      return data as {
        invoice_voided: string | null; invoice_credited: string | null; credit_note_id: string | null; receipt_removed: string | null; advance_removed?: number | null;
        /* R-1999: a project-receipt line */
        project_payments_removed?: number; project_amount_removed?: number; project_tds_removed?: number; invoices_due_again?: string[];
      };
    },
    onSuccess: (res) => {
      for (const k of ["bank_transactions", "bank_accounts",
                       "salary-payments", "expenses", "vendor_bills", "prepaid_advances", "balance-sheet", "tax-payments", "project_sales", "accounting", "itr-pack",
                       "project_payments", "project_milestones", "tds_receivable"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      /* R-1634: a receipt removed / invoice credited changes what the customer owes. */
      invalidateReceivables(qc);
      toast.success(
        res?.project_payments_removed ? projectUndoneToast(res.project_amount_removed ?? 0, res.project_tds_removed ?? 0, res.invoices_due_again ?? [])
        : res?.advance_removed ? `Un-reconciled · advance of ${rupee(res.advance_removed)} and its receipt removed`
        : res?.invoice_credited ? `Un-reconciled · credit note ${res.credit_note_id ?? ""} raised on invoice ${res.invoice_credited}, receipt removed`
        : res?.invoice_voided ? `Un-reconciled · draft invoice ${res.invoice_voided} voided, receipt removed`
        : "Un-reconciled",
      );
    },
    onError: (err) => toastError(err, { fallback: "Un-reconcile failed" }),
  });
}

/** R-1999: the toast after a project-receipt line is un-reconciled. */
export function projectUndoneToast(amount: number, tds: number, invoicesDue: string[]): string {
  const money = `${rupee(amount)}${tds > 0 ? ` + ${rupee(tds)} TDS` : ""}`;
  const inv = invoicesDue.length === 0 ? ""
    : invoicesDue.length === 1 ? ` · invoice ${invoicesDue[0]} is due again`
    : ` · ${invoicesDue.length} invoices are due again`;
  return `Un-reconciled · project payment ${money} removed${inv}`;
}
