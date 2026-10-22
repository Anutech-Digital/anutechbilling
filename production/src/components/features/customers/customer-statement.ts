/**
 * The customer Statement tab (Zoho "Statement") — a running balance of what the customer owes.
 *
 * R-1682 (staging T-19, 19 Oct 2026): INV ₹7,646 billed, ₹7,646 paid, cancelled, credit note
 * ₹6,372. The Statement showed only +7,646 and −7,646 (closing ₹0) while the overview said
 * "₹6,372 credit": credit notes and debit notes were not on it at all, and a refunded payment
 * showed only the refund (its receipt vanished), so a refund made the customer look as if they
 * owed it again.
 *
 * Now, the same entries the books' customer ledger uses (src/lib/accounting/reports-reference.ts,
 * referenceCustomerLedgerEntries):
 *   invoice        debit (owed)
 *   debit note     debit
 *   payment        credit — every payment, refunded or not (the money did come in)
 *   credit note    credit
 *   refund         debit  — on the refund date (money went back)
 *   project receipt credit
 * closing = invoices + debit notes − payments − credit notes + refunds. Positive = the customer
 * owes; negative = the company owes the customer (open credit to use or refund).
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isOpeningInvoice } from "@/lib/accounting/sale-documents";

export type StatementLink =
  | { kind: "invoice"; invoiceId: string }
  | { kind: "payment"; quoteId: string }
  | { kind: "projectPayment"; invoiceId: string | null; projectId: string };

export interface StatementRow {
  date: string;
  desc: string;
  debit: number;
  credit: number;
  balance: number;
  link: StatementLink;
}

export interface StatementInput {
  /** R-1739: an invoice imported from Zoho Books (document_kind opening_invoice) is the
   *  customer's opening balance — only what was still due when it came in (opening_balance);
   *  its earlier Zoho receipts were never recorded here. */
  invoices: ReadonlyArray<{ id: string; invoice_date: string; amount: number | null; document_kind?: string | null; opening_balance?: number | null }>;
  payments: ReadonlyArray<{
    id: string; quote_id: string | null; invoice_id?: string | null; amount: number | null; status: string;
    received_at: string; refunded_at?: string | null;
    receipt_voucher_no?: string | null; refund_voucher_no?: string | null;
  }>;
  creditNotes: ReadonlyArray<{ id: string; invoice_id: string | null; credit_date: string; amount: number | null; reason?: string | null }>;
  debitNotes: ReadonlyArray<{ id: string; invoice_id: string | null; debit_date: string; amount: number | null; reason?: string | null }>;
  projectPayments: ReadonlyArray<{ received_at: string; amount: number | null; reference?: string | null; project_title: string; invoice_id?: string | null; project_id: string }>;
  /** Optional "— ₹X bank + ₹Y TDS" tail for a payment row (R-523). */
  paymentSplit?: (paymentId: string, amount: number) => string | null;
}

export function buildCustomerStatement(input: StatementInput): { rows: StatementRow[]; closing: number } {
  type Raw = Omit<StatementRow, "balance"> & { order: number };
  const raw: Raw[] = [];
  for (const i of input.invoices) {
    const opening = isOpeningInvoice(i);
    raw.push({
      date: i.invoice_date,
      desc: opening ? `Opening balance · ${i.id} (imported from Zoho Books)` : `Invoice ${i.id}`,
      debit: opening ? i.opening_balance ?? 0 : i.amount ?? 0, credit: 0, link: { kind: "invoice", invoiceId: i.id }, order: 0,
    });
  }
  for (const d of input.debitNotes) {
    raw.push({
      date: d.debit_date, desc: `Debit note ${d.id}${d.invoice_id ? ` · on ${d.invoice_id}` : ""}`,
      debit: d.amount ?? 0, credit: 0,
      link: d.invoice_id ? { kind: "invoice", invoiceId: d.invoice_id } : { kind: "invoice", invoiceId: d.id }, order: 1,
    });
  }
  for (const p of input.payments) {
    const amount = p.amount ?? 0;
    /* R-1739: a payment on an imported Zoho invoice has no quote — it opens that invoice. */
    const link: StatementLink = p.quote_id ? { kind: "payment", quoteId: p.quote_id } : { kind: "invoice", invoiceId: p.invoice_id ?? "" };
    const split = input.paymentSplit?.(p.id, amount) ?? null;
    raw.push({
      date: p.received_at,
      desc: `Payment received${p.receipt_voucher_no ? ` · ${p.receipt_voucher_no}` : ""}${split ? ` — ${split}` : ""}`,
      debit: 0, credit: amount, link, order: 2,
    });
    if (p.status === "refunded") {
      raw.push({
        date: p.refunded_at ?? p.received_at,
        desc: `Refund${p.refund_voucher_no ? ` · ${p.refund_voucher_no}` : ""}`,
        debit: amount, credit: 0, link, order: 4,
      });
    }
  }
  for (const c of input.creditNotes) {
    raw.push({
      date: c.credit_date, desc: `Credit note ${c.id}${c.invoice_id ? ` · on ${c.invoice_id}` : ""}`,
      debit: 0, credit: c.amount ?? 0,
      link: c.invoice_id ? { kind: "invoice", invoiceId: c.invoice_id } : { kind: "invoice", invoiceId: c.id }, order: 3,
    });
  }
  for (const p of input.projectPayments) {
    raw.push({
      date: p.received_at, desc: `Payment received · ${p.reference?.trim() || p.project_title}`,
      debit: 0, credit: p.amount ?? 0,
      link: { kind: "projectPayment", invoiceId: p.invoice_id ?? null, projectId: p.project_id }, order: 2,
    });
  }
  /* Day first (YYYY-MM-DD of the stored value), then invoice → debit note → payment →
     credit note → refund, so a same-day refund never dips below what it reverses. */
  raw.sort((a, b) => (a.date ?? "").slice(0, 10).localeCompare((b.date ?? "").slice(0, 10)) || a.order - b.order
    || (a.date ?? "").localeCompare(b.date ?? ""));
  let bal = 0;
  const rows = raw.map(({ order: _order, ...r }) => { bal += r.debit - r.credit; return { ...r, balance: bal }; });
  return { rows, closing: bal };
}

export interface CustomerNotes {
  creditNotes: { id: string; invoice_id: string | null; credit_date: string; amount: number; reason: string | null }[];
  debitNotes: { id: string; invoice_id: string | null; debit_date: string; amount: number; reason: string | null }[];
}

/** Credit + debit notes of one customer (RLS keeps it to the signed-in company). */
export function useCustomerNotes(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["credit-notes", "by-customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<CustomerNotes> => {
      const supabase = createClient();
      const [cn, dn] = await Promise.all([
        supabase.from("credit_notes").select("id, invoice_id, credit_date, amount, reason").eq("customer_id", customerId!),
        supabase.from("debit_notes").select("id, invoice_id, debit_date, amount, reason").eq("customer_id", customerId!),
      ]);
      if (cn.error) throw cn.error;
      if (dn.error) throw dn.error;
      return {
        creditNotes: (cn.data ?? []) as CustomerNotes["creditNotes"],
        debitNotes: (dn.data ?? []) as CustomerNotes["debitNotes"],
      };
    },
  });
}
