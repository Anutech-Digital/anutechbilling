/**
 * S34 — Tally XML for the whole company: Sales, Receipt and Payment vouchers for a period.
 *
 * The ledger page already exports ONE party's khata to Tally (ledger-export.ts), with a
 * generic "Sundry Debtors" counter-ledger. A CA closing the books wants the day book instead:
 * every invoice as a Sales voucher with its GST heads, every receipt against a bank, every
 * vendor payment. That is this file.
 *
 * ─── LEDGER NAMES MUST MATCH THE CA'S TALLY ─────────────────────────────────
 * Tally rejects a voucher whose <LEDGERNAME> does not exist in the target company, silently
 * for that row. So the counter-ledgers ("Sales", "Output CGST", the bank) are PARAMETERS with
 * sensible defaults, and the party ledgers are the names as we hold them. The UI says so.
 *
 * ─── SIGNS ──────────────────────────────────────────────────────────────────
 * Same convention as ledger-export.ts: negative AMOUNT = Debit (ISDEEMEDPOSITIVE Yes),
 * positive = Credit. Every voucher's AMOUNTs sum to zero — tested.
 *
 * ─── NOTHING IS GUESSED ─────────────────────────────────────────────────────
 * An invoice with no stored GST breakdown (issued before migration 0116) is LEFT OUT and
 * reported, not exported as "all Sales, no tax" — that would under-state output GST in the
 * CA's books with nothing to flag it (AGENTS.md §2). Money is whole rupees throughout.
 */
import { gstSplit } from "@/lib/gst/gstr1";
import { tallyDate, xmlEscape } from "./ledger-export";
import { toIstDate } from "@/lib/dates/ist";
import { cashReceived } from "@/lib/payments/cash-received";

export interface TallyLedgerNames {
  sales: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  /** Where receipts land and payments leave from. */
  bank: string;
}

export const DEFAULT_TALLY_LEDGERS: TallyLedgerNames = {
  sales: "Sales",
  cgst: "Output CGST",
  sgst: "Output SGST",
  igst: "Output IGST",
  roundOff: "Round Off",
  bank: "Bank",
};

export interface TallySale {
  date: string;          // YYYY-MM-DD
  number: string;        // INV-…
  party: string;
  taxable: number;
  tax: number;
  interState: boolean;
  /** Gross document value. When it differs from taxable + tax, the gap goes to Round Off. */
  total: number;
  narration?: string | null;
}

export interface TallyMoneyMove {
  date: string;
  number: string;
  party: string;
  amount: number;
  narration?: string | null;
}

interface Entry { ledger: string; amount: number }

function entriesXml(entries: Entry[]): string {
  return entries
    .filter((e) => e.amount !== 0)
    .map((e) => `        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${xmlEscape(e.ledger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${e.amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
          <AMOUNT>${e.amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`)
    .join("\n");
}

function voucherXml(type: "Sales" | "Receipt" | "Payment", v: { date: string; number: string; party: string; narration?: string | null }, entries: Entry[]): string {
  return `      <VOUCHER VCHTYPE="${type}" ACTION="Create">
        <DATE>${tallyDate(v.date)}</DATE>
        <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME>
        <NARRATION>${xmlEscape(v.narration ?? v.number)}</NARRATION>
${entriesXml(entries)}
      </VOUCHER>`;
}

/** Sales: party Dr total; Sales Cr taxable; GST heads Cr; any rupee gap to Round Off. */
export function salesEntries(s: TallySale, L: TallyLedgerNames): Entry[] {
  const heads = gstSplit({ gst: s.tax, interState: s.interState });
  const roundOff = s.total - (s.taxable + s.tax);
  return [
    { ledger: s.party, amount: -s.total },
    { ledger: L.sales, amount: s.taxable },
    { ledger: L.cgst, amount: heads.cgst },
    { ledger: L.sgst, amount: heads.sgst },
    { ledger: L.igst, amount: heads.igst },
    { ledger: L.roundOff, amount: roundOff },
  ];
}

/** Receipt: bank Dr, customer Cr. */
export function receiptEntries(r: TallyMoneyMove, L: TallyLedgerNames): Entry[] {
  return [{ ledger: L.bank, amount: -r.amount }, { ledger: r.party, amount: r.amount }];
}

/** Payment: vendor Dr, bank Cr. */
export function paymentEntries(p: TallyMoneyMove, L: TallyLedgerNames): Entry[] {
  return [{ ledger: p.party, amount: -p.amount }, { ledger: L.bank, amount: p.amount }];
}

export function tallyVouchersXml(input: {
  company: string;
  sales: readonly TallySale[];
  receipts: readonly TallyMoneyMove[];
  payments: readonly TallyMoneyMove[];
  ledgers?: Partial<TallyLedgerNames>;
}): string {
  const L: TallyLedgerNames = { ...DEFAULT_TALLY_LEDGERS, ...(input.ledgers ?? {}) };
  const byDate = <T extends { date: string; number: string }>(a: T, b: T) =>
    a.date.localeCompare(b.date) || a.number.localeCompare(b.number);
  const vouchers = [
    ...[...input.sales].sort(byDate).map((s) => voucherXml("Sales", s, salesEntries(s, L))),
    ...[...input.receipts].sort(byDate).map((r) => voucherXml("Receipt", r, receiptEntries(r, L))),
    ...[...input.payments].sort(byDate).map((p) => voucherXml("Payment", p, paymentEntries(p, L))),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(input.company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${vouchers}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/* ─── From our rows to vouchers ──────────────────────────────────────────── */

const inPeriod = (d: string | null | undefined, from: string, to: string) =>
  !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;

/**
 * The IST calendar day of a timestamptz (AGENTS.md §6). A receipt at 00:30 IST is the
 * PREVIOUS day in UTC; slicing the ISO string would put it in the wrong day — and, on the
 * 1st, in the wrong month's day book. A bare YYYY-MM-DD passes through.
 */
export function istDay(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts.slice(0, 10) : toIstDate(t);
}

export interface InvoiceForTally {
  id: string; customer_name: string; invoice_date: string | null; status: string;
  amount: number | null; taxable_value: number | null; tax_amount: number | null; inter_state: boolean | null;
}

/** Non-void invoices in the period. No GST breakdown → skipped with the reason. */
export function salesFromInvoices(rows: readonly InvoiceForTally[], from: string, to: string) {
  const sales: TallySale[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const r of rows) {
    if (r.status === "void" || r.status === "draft" || !inPeriod(r.invoice_date, from, to)) continue;
    if (r.taxable_value == null || r.tax_amount == null || r.inter_state == null || r.amount == null) {
      skipped.push({ id: r.id, reason: "GST breakdown not stored on this invoice — enter it in Tally by hand" });
      continue;
    }
    sales.push({
      date: r.invoice_date!.slice(0, 10), number: r.id, party: r.customer_name,
      taxable: r.taxable_value, tax: r.tax_amount, interState: r.inter_state, total: r.amount,
    });
  }
  return { sales, skipped };
}

export interface PaymentForTally {
  id: string; receipt_voucher_no: string | null; customer_id: string | null; amount: number | null;
  /** R-1565: advance credit applied — no money moved, so no Receipt voucher for that part. */
  credit_applied?: number | null;
  received_at: string | null; method: string | null; reference: string | null;
}

/** Receipts received in the period. A payment with no customer name we can print is skipped. */
export function receiptsFromPayments(
  rows: readonly PaymentForTally[], customerName: ReadonlyMap<string, string>, from: string, to: string,
) {
  const receipts: TallyMoneyMove[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const p of rows) {
    const day = p.received_at ? istDay(p.received_at) : null;
    if (!inPeriod(day, from, to)) continue;
    const cash = cashReceived({ amount: p.amount ?? 0, credit_applied: p.credit_applied });
    if (cash <= 0) continue;   // paid wholly from advance credit: no money moved
    const party = p.customer_id ? customerName.get(p.customer_id) : undefined;
    if (!party) { skipped.push({ id: p.id, reason: "payment is not linked to a customer" }); continue; }
    receipts.push({
      date: day!, number: p.receipt_voucher_no ?? p.id, party,
      amount: cash,
      narration: [p.receipt_voucher_no ?? p.id, p.method, p.reference].filter(Boolean).join(" · "),
    });
  }
  return { receipts, skipped };
}

export interface BillForTally {
  id: string; vendor_name: string | null; bill_no: string | null; amount: number | null;
  paid: boolean | null; paid_date: string | null; payment_method: string | null; category: string | null;
}

/** Vendor bills PAID in the period — the same source as the vendor khata's Payment lines. */
export function paymentsFromBills(rows: readonly BillForTally[], from: string, to: string) {
  const payments: TallyMoneyMove[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const e of rows) {
    if (!e.paid || !inPeriod(e.paid_date, from, to)) continue;
    if (!e.vendor_name?.trim()) { skipped.push({ id: e.id, reason: "bill has no vendor name" }); continue; }
    payments.push({
      date: e.paid_date!.slice(0, 10), number: e.bill_no ?? e.id, party: e.vendor_name.trim(),
      amount: e.amount ?? 0,
      narration: [e.bill_no ? `Bill ${e.bill_no}` : null, e.category, e.payment_method].filter(Boolean).join(" · ") || null,
    });
  }
  return { payments, skipped };
}
