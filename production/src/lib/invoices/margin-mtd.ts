/**
 * R-405 — the "Margin MTD" tile on /invoices, from the invoice lines' own cost.
 *
 * ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * The tile was `Math.round(paidThisMonth * 0.17)` — a flat 17% of what was collected,
 * printed as a fact with no "estimate" anywhere. On a local sales-flow test the quote
 * said ₹19,200 margin (₹32,400 sale, ₹13,200 cost) and the tile said ₹6.5K. An owner
 * reads that tile as real profit.
 *
 * ─── THE RULE NOW ───────────────────────────────────────────────────────────
 * · Set: invoices ISSUED this IST month (invoice_date), not void or draft. Margin is
 *   earned when the sale is invoiced, not when the cash lands.
 * · Sale value of a line = its share of the invoice's taxable value (ex-GST, after any
 *   invoice-level discount), split across lines by qty × rate.
 * · Cost of a line = qty × cost, exactly as the quote builder's line margin does.
 * · A line whose cost is unknown (lib/quotes/line-cost.ts — null, or 0 on a resold
 *   product) is NOT guessed. Its sale value is counted in `sales` but not in
 *   `costedSales`, and the line is counted in `missingLines` so the tile can say so.
 * · An invoice with no lines at all (old rows) is wholly uncosted, counted as 1 line.
 *
 * Whole rupees in and out (AGENTS.md §1).
 */
import { istMonth } from "@/lib/dates/ist";
import { lineCostUnknown } from "@/lib/quotes/line-cost";

export interface MarginInvoice {
  status: string;
  invoice_date: string;
  amount: number;
  taxable_value?: number | null;
  tax_amount?: number | null;
  line_items?: unknown;
}

interface Line {
  qty: number;
  rate: number;
  cost?: number | null;
  item_id?: string | null;
}

export interface MarginMtd {
  /** Invoices counted (issued this IST month, not void / draft). */
  invoiceCount: number;
  /** Ex-GST sale value of every counted invoice. */
  sales: number;
  /** The part of `sales` whose cost is known. Margin is over this part only. */
  costedSales: number;
  /** Cost of the costed part. */
  cost: number;
  /** costedSales − cost. */
  margin: number;
  /** Lines with no cost recorded — their margin is not in `margin`. */
  missingLines: number;
}

const COUNTED_OUT = new Set(["void", "draft"]);

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseLines(raw: unknown): Line[] {
  if (!Array.isArray(raw)) return [];
  const out: Line[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    out.push({
      qty: num(o.qty),
      rate: num(o.rate),
      cost: typeof o.cost === "number" ? o.cost : null,
      item_id: typeof o.item_id === "string" ? o.item_id : null,
    });
  }
  return out;
}

/** Ex-GST value of an invoice: taxable_value when stored, else amount − tax. */
function taxableOf(inv: MarginInvoice, lines: Line[]): number {
  if (typeof inv.taxable_value === "number") return inv.taxable_value;
  if (typeof inv.tax_amount === "number") return inv.amount - inv.tax_amount;
  const gross = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  return gross > 0 ? gross : inv.amount;
}

export function invoiceMarginMtd(invoices: readonly MarginInvoice[], now: Date = new Date()): MarginMtd {
  const month = istMonth(now);
  const res: MarginMtd = { invoiceCount: 0, sales: 0, costedSales: 0, cost: 0, margin: 0, missingLines: 0 };

  for (const inv of invoices) {
    if (COUNTED_OUT.has(inv.status)) continue;
    if (!inv.invoice_date || inv.invoice_date.slice(0, 7) !== month) continue;
    const lines = parseLines(inv.line_items);
    const taxable = taxableOf(inv, lines);
    res.invoiceCount += 1;
    res.sales += taxable;

    const gross = lines.reduce((s, l) => s + l.qty * l.rate, 0);
    if (lines.length === 0 || gross <= 0) {
      if (taxable > 0) res.missingLines += Math.max(1, lines.length);
      continue;
    }
    for (const l of lines) {
      const lineGross = l.qty * l.rate;
      if (lineGross <= 0) continue;
      if (lineCostUnknown(l)) { res.missingLines += 1; continue; }
      res.costedSales += Math.round((taxable * lineGross) / gross);
      res.cost += Math.round(l.qty * (l.cost ?? 0));
    }
  }
  res.margin = res.costedSales - res.cost;
  return res;
}
