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
 *
 * R-1632 (weekly audit 19 Oct 2026) — the same closing as /collections (invoiceAmountDue per
 * invoice) minus the customer's open credit:
 *   - a VOID or DRAFT invoice is not owed: no line (and no line for a note against it);
 *   - a WRITTEN-OFF invoice (R-1635) stays on as issued, and a "Written off" credit line on
 *     the write-off date clears what was still due on it (invoiceAmountDue before the
 *     write-off) — /collections asks for nothing on it;
 *   - a payment counts the CASH that came in (cashReceived: amount − credit_applied, R-1565);
 *     the credit it spent was already counted on the payment that created it. A refund gives
 *     back that same cash;
 *   - payments belong to the customer by the /payments rule (paymentBelongsTo: own
 *     customer_id, else the customer on its quote) — statementPayments().
 */
import { rupee } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isOpeningInvoice } from "@/lib/accounting/sale-documents";
import { cashReceived } from "@/lib/payments/cash-received";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { paymentBelongsTo, type ScopablePayment } from "@/app/(app)/payments/customer-scope";

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

export interface StatementProjectPayment {
  received_at: string; amount: number | null; reference?: string | null; project_title: string; invoice_id?: string | null; project_id: string;
  /** R-2029: what ties several instalments to ONE bank receipt (the bank line it was reconciled to). */
  bank_txn_id?: string | null;
  /** 'tds' = the TDS part of an instalment (no bank line of its own). */
  method?: string | null;
  milestone_id?: string | null;
  /** "Kist 1 — advance" → shown as "Kist 1". */
  milestone_label?: string | null;
}

const KIST_SHOWN = 2;

/** "Kist 1 + Kist 2" — the short part of each label (before " — "), at most two, then "+ N more". */
function kistList(labels: readonly string[]): string {
  const short = [...new Set(labels.map((l) => l.split(" — ")[0].trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const head = short.slice(0, KIST_SHOWN).join(" + ");
  return short.length > KIST_SHOWN ? `${head} + ${short.length - KIST_SHOWN} more` : head;
}

/**
 * R-2029 (27 Oct 2026, SCN Bharat Apps): one ₹2,12,400 bank receipt paid Kist 1 and Kist 2 and
 * showed as two identical "Payment received · SCN-… ₹1,06,200" rows, plus two "TDS 194J …
 * ₹11,800" rows. Now ONE row per bank receipt (instalments sharing a bank_txn_id), amounts
 * summed, instalments named — and ONE TDS row for the TDS of those instalments (same project,
 * same day, a milestone in the receipt). A receipt for a single instalment reads as before.
 * Only the rows are merged: every rupee stays, so the running and closing balance do not move.
 */
export function groupProjectReceipts(
  list: readonly StatementProjectPayment[],
): { date: string; desc: string; credit: number; link: StatementLink }[] {
  const byBank = new Map<string, StatementProjectPayment[]>();
  for (const p of list) {
    if (p.bank_txn_id && p.method !== "tds") byBank.set(p.bank_txn_id, [...(byBank.get(p.bank_txn_id) ?? []), p]);
  }
  const used = new Set<StatementProjectPayment>();
  const out: { date: string; desc: string; credit: number; link: StatementLink }[] = [];
  const day = (d: string) => (d ?? "").slice(0, 10);
  for (const group of byBank.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const ms = new Set(group.map((p) => p.milestone_id).filter(Boolean));
    const tds = list.filter((p) => p.method === "tds" && p.milestone_id && ms.has(p.milestone_id)
      && p.project_id === first.project_id && day(p.received_at) === day(first.received_at));
    const kists = kistList(group.map((p) => p.milestone_label ?? ""));
    const invoices = new Set(group.map((p) => p.invoice_id ?? null));
    const link: StatementLink = { kind: "projectPayment", invoiceId: invoices.size === 1 ? first.invoice_id ?? null : null, projectId: first.project_id };
    const ref = first.reference?.trim() || first.project_title;
    out.push({
      date: first.received_at, desc: `Payment received · ${ref}${kists ? ` · ${kists}` : ""}`,
      credit: group.reduce((s, p) => s + (p.amount ?? 0), 0), link,
    });
    group.forEach((p) => used.add(p));
    if (tds.length >= 2) {
      const section = (tds[0].reference ?? "").split(" @")[0].trim() || "TDS";
      out.push({
        date: tds[0].received_at, desc: `${section}${kists ? ` · ${kistList(tds.map((p) => p.milestone_label ?? ""))}` : ""}`,
        credit: tds.reduce((s, p) => s + (p.amount ?? 0), 0), link,
      });
      tds.forEach((p) => used.add(p));
    }
  }
  for (const p of list) {
    if (used.has(p)) continue;
    out.push({
      date: p.received_at, desc: `Payment received · ${p.reference?.trim() || p.project_title}`,
      credit: p.amount ?? 0,
      link: { kind: "projectPayment", invoiceId: p.invoice_id ?? null, projectId: p.project_id },
    });
  }
  return out;
}

export interface StatementInput {
  /** R-1739: an invoice imported from Zoho Books (document_kind opening_invoice) is the
   *  customer's opening balance — only what was still due when it came in (opening_balance);
   *  its earlier Zoho receipts were never recorded here. */
  invoices: ReadonlyArray<{
    id: string; invoice_date: string; amount: number | null; document_kind?: string | null; opening_balance?: number | null;
    /** R-1632: void / draft → not on the statement. Omitted = issued (older callers). */
    status?: string | null;
    /** R-1632: what invoiceAmountDue reads — the write-off line clears exactly that. */
    net_payable?: number | null; paid_amount?: number | null; written_off_at?: string | null;
  }>;
  payments: ReadonlyArray<{
    id: string; quote_id: string | null; invoice_id?: string | null; amount: number | null; status: string;
    /** R-1565: the part of `amount` paid from the customer's credit, not new money. */
    credit_applied?: number | null;
    received_at: string; refunded_at?: string | null;
    receipt_voucher_no?: string | null; refund_voucher_no?: string | null;
  }>;
  creditNotes: ReadonlyArray<{ id: string; invoice_id: string | null; credit_date: string; amount: number | null; reason?: string | null }>;
  debitNotes: ReadonlyArray<{ id: string; invoice_id: string | null; debit_date: string; amount: number | null; reason?: string | null }>;
  projectPayments: ReadonlyArray<StatementProjectPayment>;
  /** Optional "— ₹X bank + ₹Y TDS" tail for a payment row (R-523). */
  paymentSplit?: (paymentId: string, amount: number) => string | null;
  /** R-2029: is this quote an R-1863 customer-advance holder (isCustomerAdvanceQuote)? Its
   *  payment reads "Advance (RV-…)" — the same credit, the same balance, only the label. */
  isAdvanceQuote?: (quoteId: string) => boolean;
}

/**
 * R-1680: a running balance below zero is money the customer has with us — "₹5,000 credit",
 * the closing line's own words. rupee(-5000) printed "₹-5,000" in the Balance column.
 */
export function statementBalanceText(balance: number): string {
  return balance < 0 ? `${rupee(-balance)} credit` : rupee(balance);
}

export function buildCustomerStatement(input: StatementInput): { rows: StatementRow[]; closing: number } {
  type Raw = Omit<StatementRow, "balance"> & { order: number };
  const raw: Raw[] = [];
  /* R-1632: a void invoice was never a supply (only drafts are voided — an issued one is
     reversed with a credit note, 20260927140000) and a draft is not issued yet. */
  const offStatement = new Set(
    input.invoices.filter((i) => i.status === "void" || i.status === "draft").map((i) => i.id),
  );
  for (const i of input.invoices) {
    if (offStatement.has(i.id)) continue;
    const opening = isOpeningInvoice(i);
    raw.push({
      date: i.invoice_date,
      desc: opening ? `Opening balance · ${i.id} (imported from Zoho Books)` : `Invoice ${i.id}`,
      debit: opening ? i.opening_balance ?? 0 : i.amount ?? 0, credit: 0, link: { kind: "invoice", invoiceId: i.id }, order: 0,
    });
    if (i.written_off_at) {
      /* R-1635: the invoice stays issued; what was still due on it is no longer asked for. */
      const due = invoiceAmountDue({ ...i, written_off_at: null });
      if (due > 0) {
        raw.push({
          date: i.written_off_at, desc: `Written off · ${i.id} (not collected)`,
          debit: 0, credit: due, link: { kind: "invoice", invoiceId: i.id }, order: 5,
        });
      }
    }
  }
  for (const d of input.debitNotes) {
    if (d.invoice_id && offStatement.has(d.invoice_id)) continue;
    raw.push({
      date: d.debit_date, desc: `Debit note ${d.id}${d.invoice_id ? ` · on ${d.invoice_id}` : ""}`,
      debit: d.amount ?? 0, credit: 0,
      link: d.invoice_id ? { kind: "invoice", invoiceId: d.invoice_id } : { kind: "invoice", invoiceId: d.id }, order: 1,
    });
  }
  for (const p of input.payments) {
    /* R-1632: the cash that came in — credit spent here was counted when it was received. */
    const amount = cashReceived({ amount: p.amount ?? 0, credit_applied: p.credit_applied });
    /* R-1739: a payment on an imported Zoho invoice has no quote — it opens that invoice. */
    const link: StatementLink = p.quote_id ? { kind: "payment", quoteId: p.quote_id } : { kind: "invoice", invoiceId: p.invoice_id ?? "" };
    const split = input.paymentSplit?.(p.id, amount) ?? null;
    const advance = !!p.quote_id && (input.isAdvanceQuote?.(p.quote_id) ?? false);
    raw.push({
      date: p.received_at,
      desc: advance
        ? `Advance${p.receipt_voucher_no ? ` (${p.receipt_voucher_no})` : ""}${split ? ` — ${split}` : ""}`
        : `Payment received${p.receipt_voucher_no ? ` · ${p.receipt_voucher_no}` : ""}${split ? ` — ${split}` : ""}`,
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
    if (c.invoice_id && offStatement.has(c.invoice_id)) continue;
    raw.push({
      date: c.credit_date, desc: `Credit note ${c.id}${c.invoice_id ? ` · on ${c.invoice_id}` : ""}`,
      debit: 0, credit: c.amount ?? 0,
      link: c.invoice_id ? { kind: "invoice", invoiceId: c.invoice_id } : { kind: "invoice", invoiceId: c.id }, order: 3,
    });
  }
  for (const g of groupProjectReceipts(input.projectPayments)) {
    raw.push({ ...g, debit: 0, order: 2 });
  }
  /* Day first (YYYY-MM-DD of the stored value), then invoice → debit note → payment →
     credit note → refund, so a same-day refund never dips below what it reverses. */
  raw.sort((a, b) => (a.date ?? "").slice(0, 10).localeCompare((b.date ?? "").slice(0, 10)) || a.order - b.order
    || (a.date ?? "").localeCompare(b.date ?? ""));
  let bal = 0;
  const rows = raw.map(({ order: _order, ...r }) => { bal += r.debit - r.credit; return { ...r, balance: bal }; });
  return { rows, closing: bal };
}

/**
 * R-1632: this customer's payments by the /payments rule (paymentBelongsTo) — its own
 * customer_id, or, when that is empty (taken before the lead was converted), the customer
 * on its quote. `quoteIds` = this customer's quotes.
 */
export function statementPayments<P extends ScopablePayment>(
  payments: readonly P[],
  customerId: string,
  quoteIds: Iterable<string>,
): P[] {
  const mine = new Set(quoteIds);
  return payments.filter((p) => paymentBelongsTo(p, customerId, (id) => (mine.has(id) ? customerId : null)));
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
