/**
 * R-1530 — composition scheme returns: CMP-08 (every quarter) and GSTR-4 (the year).
 *
 * A composition business (tenants.gst_registration = 'composition', R-1529) issues Bills of
 * Supply with no GST and pays tax on its own turnover instead: the quarter's outward supplies
 * × tenants.gst_composition_rate (services 6%, Section 10(2A)), half CGST and half SGST —
 * a composition dealer makes no inter-state outward supplies, so there is no IGST. The
 * business pays it; nothing is collected from customers.
 *
 * What counts: issued (pending / paid / overdue) Bills of Supply frozen as
 * supplier_gst_status = 'composition'. Bills from an unregistered period and Tax Invoices
 * are not composition turnover. Credit notes on those bills reduce the quarter, debit notes
 * add to it, by the note's own date.
 *
 * Rounding: each head to the nearest rupee (Section 170). A quarter whose notes exceed its
 * bills pays 0, never a negative tax.
 *
 * Due dates: CMP-08 on the 18th of the month after the quarter (Rule 62); GSTR-4 on 30 June
 * after the year from FY 2024-25 (Notification 12/2024-CT), 30 April before that.
 *
 * Pure: no React, no client. The loader is app/(app)/accounting/gst/composition-report.ts.
 */
import { addDaysISO, fyLabelOfYear } from "@/lib/dates/ist";
import { isBillOfSupply, supplierGstStatusOf, type DocumentKindFields } from "@/lib/invoices/document-kind";

export interface CompositionDoc extends DocumentKindFields {
  id: string;
  invoice_date: string;
  amount: number | null;
  taxable_value: number | null;
  status: string | null;
}

export interface CompositionNote {
  kind: "credit" | "debit";
  /** credit_date / debit_date (YYYY-MM-DD). */
  date: string;
  /** Value of the note (taxable value; a Bill of Supply has no tax). */
  value: number;
  /** The bill the note is against — null when it could not be read (then it is not counted). */
  invoice: DocumentKindFields | null;
}

export interface CompositionQuarter {
  key: "Q1" | "Q2" | "Q3" | "Q4";
  label: string;
  from: string;
  to: string;
  /** CMP-08 due date. */
  due: string;
}

export interface Cmp08 extends CompositionQuarter {
  bills: number;
  grossTurnover: number;
  creditNotes: number;
  debitNotes: number;
  netTurnover: number;
  rate: number;
  cgst: number;
  sgst: number;
  tax: number;
}

export interface Gstr4 {
  fyStartYear: number;
  fyLabel: string;
  due: string;
  rate: number;
  quarters: Cmp08[];
  bills: number;
  grossTurnover: number;
  creditNotes: number;
  debitNotes: number;
  netTurnover: number;
  cgst: number;
  sgst: number;
  tax: number;
}

const ISSUED = new Set(["pending", "paid", "overdue"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const paise = (n: number) => Math.round(n * 100) / 100;

/** The four quarters of the FY starting 1 April `startYear`, with their CMP-08 due dates. */
export function compositionQuarters(startYear: number): CompositionQuarter[] {
  return ([4, 7, 10, 1] as const).map((m, i) => {
    const y = m === 1 ? startYear + 1 : startYear;
    const nextStart = m === 10 ? `${y + 1}-01-01` : `${y}-${pad2(m + 3)}-01`;
    const dueMonth = m === 10 ? `${y + 1}-01` : `${y}-${pad2(m + 3)}`;
    return {
      key: (["Q1", "Q2", "Q3", "Q4"] as const)[i],
      label: `${MONTHS[m - 1]}–${MONTHS[m + 1]} ${y}`,
      from: `${y}-${pad2(m)}-01`,
      to: addDaysISO(nextStart, -1),
      due: `${dueMonth}-18`,
    };
  });
}

export function gstr4DueDate(startYear: number): string {
  return startYear >= 2024 ? `${startYear + 1}-06-30` : `${startYear + 1}-04-30`;
}

/** Issued = pending / paid / overdue — not a draft, not void. Shared with R-1531's reminder. */
export function isIssuedStatus(status: string | null | undefined): boolean {
  return ISSUED.has(status ?? "");
}

/** An issued Bill of Supply made while the business was under composition. */
export function isCompositionBill(d: CompositionDoc): boolean {
  return isBillOfSupply(d) && supplierGstStatusOf(d) === "composition" && isIssuedStatus(d.status);
}

export function billOfSupplyValue(d: Pick<CompositionDoc, "amount" | "taxable_value">): number {
  const v = Number.isFinite(d.taxable_value as number) ? Number(d.taxable_value) : Number(d.amount ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function onCompositionBill(n: CompositionNote): boolean {
  return isBillOfSupply(n.invoice) && supplierGstStatusOf(n.invoice) === "composition";
}

/** §17c: a rate the Settings card could never have saved means the report would be wrong — stop. */
function checkRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10) {
    throw new Error("Composition rate must be more than 0% and at most 10%. Set it in Settings → Company → GST registration, then open this report again.");
  }
}

function headsOf(net: number, rate: number): { cgst: number; sgst: number } {
  if (net <= 0) return { cgst: 0, sgst: 0 };
  const half = Math.round((net * rate) / 200);
  return { cgst: half, sgst: half };
}

export function cmp08Quarter(args: {
  docs: readonly CompositionDoc[];
  notes: readonly CompositionNote[];
  rate: number;
  quarter: CompositionQuarter;
}): Cmp08 {
  const { docs, notes, rate, quarter: q } = args;
  checkRate(rate);
  const inQ = (d: string) => d >= q.from && d <= q.to;
  const bills = docs.filter((d) => isCompositionBill(d) && inQ(d.invoice_date));
  const qNotes = notes.filter((n) => inQ(n.date) && onCompositionBill(n));
  const grossTurnover = paise(bills.reduce((s, d) => s + billOfSupplyValue(d), 0));
  const creditNotes = paise(qNotes.filter((n) => n.kind === "credit").reduce((s, n) => s + n.value, 0));
  const debitNotes = paise(qNotes.filter((n) => n.kind === "debit").reduce((s, n) => s + n.value, 0));
  const netTurnover = paise(grossTurnover - creditNotes + debitNotes);
  const { cgst, sgst } = headsOf(netTurnover, rate);
  return { ...q, bills: bills.length, grossTurnover, creditNotes, debitNotes, netTurnover, rate, cgst, sgst, tax: cgst + sgst };
}

export function gstr4Year(args: {
  docs: readonly CompositionDoc[];
  notes: readonly CompositionNote[];
  rate: number;
  fyStartYear: number;
}): Gstr4 {
  const quarters = compositionQuarters(args.fyStartYear).map((quarter) =>
    cmp08Quarter({ docs: args.docs, notes: args.notes, rate: args.rate, quarter }));
  const sum = (k: "bills" | "grossTurnover" | "creditNotes" | "debitNotes" | "netTurnover" | "cgst" | "sgst" | "tax") =>
    paise(quarters.reduce((s, q) => s + q[k], 0));
  return {
    fyStartYear: args.fyStartYear,
    fyLabel: `FY ${fyLabelOfYear(args.fyStartYear)}`,
    due: gstr4DueDate(args.fyStartYear),
    rate: args.rate,
    quarters,
    bills: sum("bills"),
    grossTurnover: sum("grossTurnover"),
    creditNotes: sum("creditNotes"),
    debitNotes: sum("debitNotes"),
    netTurnover: sum("netTurnover"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    tax: sum("tax"),
  };
}

export const COMPOSITION_CSV_HEADERS = [
  "Return", "From", "To", "Due date", "Bills of Supply", "Bills value (₹)", "Credit notes (₹)",
  "Debit notes (₹)", "Turnover (₹)", "Rate %", "CGST (₹)", "SGST (₹)", "Tax payable (₹)", "Note",
] as const;

/** One row per CMP-08 quarter, then the GSTR-4 total — for the CA. */
export function compositionCsv(y: Gstr4): (string | number)[][] {
  const note = (q: { netTurnover: number }) => (q.netTurnover < 0 ? "Notes exceed bills — no tax for this period" : "");
  const rows: (string | number)[][] = y.quarters.map((q) => [
    `CMP-08 ${q.key} (${q.label})`, q.from, q.to, q.due, q.bills, q.grossTurnover, q.creditNotes,
    q.debitNotes, q.netTurnover, q.rate, q.cgst, q.sgst, q.tax, note(q),
  ]);
  const last = y.quarters[y.quarters.length - 1];
  rows.push([
    `GSTR-4 ${y.fyLabel}`, y.quarters[0].from, last.to, y.due, y.bills, y.grossTurnover, y.creditNotes,
    y.debitNotes, y.netTurnover, y.rate, y.cgst, y.sgst, y.tax, note(y),
  ]);
  return rows;
}
