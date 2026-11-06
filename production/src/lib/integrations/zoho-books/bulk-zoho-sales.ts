/**
 * R-2518 — the bulk "Reconcile from Zoho" plan for a Zoho payment applied to SEVERAL Zoho invoices:
 * one app sale per Zoho invoice (each with its own lines, GST, subscriptions and Zoho number), booked
 * in ONE reconcile_bank_credit_split call (zoho-bulk-book.ts). Pure; split out of bulk-reconcile-plan.ts.
 */
import { salePreview, type SaleLine } from "@/lib/banking/credit-pay-for";
import { zohoSalesPlan } from "@/lib/banking/zoho-sales-split";
import type { SplitRest } from "@/lib/banking/credit-pay-for-multi";
import { rupee } from "@/lib/utils";
import { planAll, type BookSpec, type BulkMatchRow, type PlanContext, type PlanRow } from "./bulk-reconcile-plan";
import type { ZohoPaymentMatch } from "./payment-match";

/** The part of a plan line this needs (bulk-reconcile-plan's PlanLine). */
interface PlanLineLite {
  name: string;
  qty: number;
  domain: string | null;
  start: string | null;
  renewal: string | null;
  invoiceNumber: string;
  action: string;
}
interface DateFixLite { name: string; qty: number; domain: string | null; start: string; renewal: string }

/** R-2518: one app sale for one Zoho invoice. */
export interface BookSale {
  externalNumber: string;
  lines: SaleLine[];
  /** The sale's total (GST included). */
  total: number;
  /** What the bank line puts on it (zohoSalesPlan). */
  amount: number;
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  billingCycle: "monthly" | null;
  dateFixes: DateFixLite[];
}

export interface ZohoSalesBook {
  sales: BookSale[];
  rest: SplitRest | null;
  problems: string[];
  notes: string[];
}

const key = (n: string) => n.trim().toUpperCase();

/**
 * The plan's lines (`lines[i]` ↔ `bookLines[i]`) grouped by their Zoho invoice, first-seen order, with
 * each sale's subscription dates and the bank money split over them (zohoSalesPlan).
 */
export function planZohoSales(
  lines: readonly PlanLineLite[], bookLines: readonly SaleLine[],
  o: { createSubscription: boolean; gstRate: number; credit: number; rupees: (n: number) => string },
): ZohoSalesBook {
  const order: string[] = [];
  for (const pl of lines) if (!order.includes(key(pl.invoiceNumber))) order.push(key(pl.invoiceNumber));
  const sales: BookSale[] = order.map((no) => {
    const idx = lines.map((pl, i) => (key(pl.invoiceNumber) === no ? i : -1)).filter((i) => i >= 0);
    const gl = idx.map((i) => bookLines[i]);
    const gNew = idx.map((i) => lines[i]).filter((pl) => pl.action === "new_sub");
    const sub = o.createSubscription && gNew.length > 0;
    const dated = gNew.filter((pl) => pl.start && pl.renewal && pl.renewal > pl.start);
    const first = dated[0] ?? null;
    return {
      externalNumber: lines[idx[0]].invoiceNumber.trim(),
      lines: gl,
      total: salePreview(gl, o.gstRate).total,
      amount: 0,
      createSubscription: sub,
      subStart: sub && first ? first.start : null,
      subRenewal: sub && first ? first.renewal : null,
      billingCycle: gl.some((l) => l.cycle === "monthly") && !gl.some((l) => l.cycle === "annual_yearly") ? "monthly" : null,
      dateFixes: sub && first ? dated.slice(1).filter((l) => l.start !== first.start || l.renewal !== first.renewal)
        .map((l) => ({ name: l.name, qty: l.qty, domain: l.domain, start: l.start!, renewal: l.renewal! })) : [],
    };
  });
  const sp = zohoSalesPlan(sales.map((s) => s.total), o.credit);
  const out = sales.map((s, k) => ({ ...s, amount: sp.amounts[k] }));
  const notes = [`One app invoice per Zoho invoice: ${out.map((s) => `${s.externalNumber} ${o.rupees(s.total)}`).join(", ")} — each keeps its Zoho number.`];
  if (sp.shortOnLast > 0) notes.push(`${o.rupees(sp.shortOnLast)} stays due on ${out[out.length - 1].externalNumber} (the money is short of the invoices).`);
  return { sales: out, rest: sp.rest, problems: sp.problem ? [sp.problem] : [], notes };
}

/** R-2518: BookSpec's extra fields when the row books several Zoho invoices. */
export interface ZohoSalesSpec { sales?: BookSale[]; salesRest?: SplitRest | null }

/**
 * One plan row → the same row booking one app sale per Zoho invoice when its Zoho payment was applied
 * to SEVERAL invoices (all read, ₹ sale). Zoho TDS on such a payment → not booked (the sheet records it).
 */
export function withZohoSales(row: PlanRow, match: ZohoPaymentMatch): PlanRow {
  const book = row.book;
  const nos = new Set(match.invoices.map((i) => key(i.number)).filter(Boolean));
  if (row.kind !== "match" || !book || book.kind !== "new_sale" || book.fx || nos.size < 2 || match.moreInvoices.length || !row.lines.length) return row;
  if (row.tds > 0) {
    const problems = [...row.problems, `Zoho records TDS ${rupee(row.tds)} on a payment for ${nos.size} invoices — book it in the line's Reconcile (one sale per Zoho invoice), then record the TDS on the invoice.`];
    return { ...row, book: null, problems, ticked: false };
  }
  /* The plan's GST rate: its sale total at 0% or 18% (planRow: no GST / foreign → 0). */
  const gstRate = row.saleTotal !== null && salePreview(book.lines, 0).total === row.saleTotal ? 0 : 18;
  const zs = planZohoSales(row.lines, book.lines, { createSubscription: book.createSubscription, gstRate, credit: row.credit, rupees: (n) => rupee(Math.round(n)) });
  const problems = [...row.problems, ...zs.problems];
  const next: BookSpec & ZohoSalesSpec = { ...book, externalNumber: null, dateFixes: [], sales: zs.sales, salesRest: zs.rest };
  return { ...row, book: next, problems, notes: [...row.notes, ...zs.notes], ticked: row.ticked && problems.length === 0 };
}

/** planAll + withZohoSales for each row (the screen's plan). */
export function planAllWithZohoSales(rows: readonly BulkMatchRow[], ctx: PlanContext): PlanRow[] {
  const byTxn = new Map(rows.map((r) => [r.line.id, r]));
  return planAll(rows, ctx).map((p) => {
    const r = byTxn.get(p.txnId);
    return r && r.result.kind === "match" ? withZohoSales(p, r.result.match) : p;
  });
}
