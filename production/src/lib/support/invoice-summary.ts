/**
 * R-2079 — support revenue from Billing's own GST tax invoices, for DSP.
 *
 * DSP used to show support revenue from its own payments ("From DSP payments — not GST
 * invoices", R-2075). The true figure is what Billing invoiced: issued Tax Invoices whose
 * lines are support SKUs (`SUP-…`, lib/support/tiers.ts isSupportSkuId), less the credit
 * notes raised against them.
 *
 * Same rules as the GST report (app/(app)/accounting/gst/report.ts), so DSP and GSTR-1 agree:
 *   · issued = status pending / paid / overdue (no draft, no void = cancelled);
 *   · Tax Invoices only — no Bill of Supply, no Zoho opening invoice (isTaxInvoiceRow);
 *   · an invoice's taxable / GST is its stored figure, split across its lines by qty × rate
 *     (after the line's discount); a credit note has no lines and is split like its invoice;
 *   · a credit note counts in the period of ITS date (credit_date), as GSTR-1 files it.
 *
 * All sums are in integer paise and only turned into rupees at the end, so the totals are
 * exact to the paisa and by_plan / by_month always add up to the totals.
 *
 * Pure: no I/O. The route reads the rows (tenant-scoped) and hands them here.
 */
import { isSupportSkuId, SUPPORT_TIERS } from "./tiers";
import { isTaxInvoiceRow } from "@/lib/invoices/document-kind";

/** Invoice statuses that are an issued document (the GST report's list). */
export const ISSUED_INVOICE_STATUSES = ["pending", "paid", "overdue"] as const;

export interface SummaryLine {
  item_id?: string | null;
  qty?: number | null;
  rate?: number | null;
  discount_pct?: number | null;
}
export interface SummaryInvoice {
  id: string;
  invoice_date: string;
  status: string;
  document_kind?: string | null;
  amount: number | null;
  taxable_value: number | null;
  tax_amount: number | null;
  line_items: unknown;
}
export interface SummaryCreditNote {
  id: string;
  invoice_id: string | null;
  credit_date: string;
  amount: number | null;
  taxable_value: number | null;
  tax_amount: number | null;
}

export interface SupportInvoiceSummary {
  currency: "INR";
  from: string;
  to: string;
  total_taxable: number;
  total_gst: number;
  total_with_gst: number;
  count: number;
  by_plan: { plan_key: string; taxable: number; gst: number; total: number; count: number }[];
  by_month: { month: string; taxable: number; total: number; count: number }[];
}

const KNOWN_TIERS = new Set<string>(SUPPORT_TIERS.map((t) => t.id));

/**
 * The plan a support line sells: `SUP-STANDARD-YR-<tenant>` → "standard". A product-wise
 * add-on (`SUP-<product id>-MO`) is not a tier → "addon".
 */
export function supportPlanKey(itemId: string): string {
  const seg = (itemId.split("-")[1] ?? "").toLowerCase();
  return KNOWN_TIERS.has(seg) ? seg : "addon";
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD (an IST date, as invoice_date is). */
export function isIsoDate(s: string | null | undefined): s is string {
  const m = DATE_RE.exec(s ?? "");
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** from / to, both required, real dates, from ≤ to. Returns an error sentence or the range. */
export function parseSummaryRange(from: string | null, to: string | null): { from: string; to: string } | { error: string } {
  if (!from || !to) return { error: "Give both from and to as YYYY-MM-DD (IST dates)." };
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: "from and to must be real dates written YYYY-MM-DD." };
  if (from > to) return { error: "from must be on or before to." };
  return { from, to };
}

const paise = (rupees: number | null | undefined) => Math.round((rupees ?? 0) * 100);
const rupees = (p: number) => p / 100;

/** The invoice's taxable and GST in paise — stored figures first, like the GST report. */
function docPaise(d: { amount: number | null; taxable_value: number | null; tax_amount: number | null }) {
  const amount = paise(d.amount);
  if (d.taxable_value != null && d.tax_amount != null) return { taxable: paise(d.taxable_value), gst: paise(d.tax_amount) };
  if (d.taxable_value != null) return { taxable: paise(d.taxable_value), gst: amount - paise(d.taxable_value) };
  if (d.tax_amount != null) return { taxable: amount - paise(d.tax_amount), gst: paise(d.tax_amount) };
  return { taxable: amount, gst: 0 };
}

/** Split `total` paise across weights; the last share takes the rounding rest, so it adds up. */
function prorate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  let assigned = 0;
  return weights.map((w, i) => {
    const share = i === weights.length - 1 ? total - assigned : Math.round((total * w) / sum);
    assigned += share;
    return share;
  });
}

/**
 * The support part of a document, per plan, in paise. Lines are weighted qty × rate less
 * the line discount (the same weights the GST HSN split uses, plus the discount). An
 * invoice with no support line answers an empty map.
 */
export function supportShares(
  doc: { taxable: number; gst: number },
  rawLines: unknown,
): Map<string, { taxable: number; gst: number }> {
  const lines = (Array.isArray(rawLines) ? rawLines : []) as SummaryLine[];
  const out = new Map<string, { taxable: number; gst: number }>();
  if (!lines.some((l) => isSupportSkuId(l?.item_id ?? null))) return out;
  const weights = lines.map((l) => {
    const w = (Number(l?.qty) || 0) * (Number(l?.rate) || 0) * (1 - (Number(l?.discount_pct) || 0) / 100);
    return w > 0 ? w : 0;
  });
  const anyWeight = weights.some((w) => w > 0);
  /* No usable weights (a line with no rate): every line counts the same. */
  const ws = anyWeight ? weights : lines.map(() => 1);
  const tx = prorate(doc.taxable, ws);
  const gs = prorate(doc.gst, ws);
  lines.forEach((l, i) => {
    const id = l?.item_id ?? null;
    if (!isSupportSkuId(id)) return;
    const key = supportPlanKey(id as string);
    const cur = out.get(key) ?? { taxable: 0, gst: 0 };
    out.set(key, { taxable: cur.taxable + tx[i], gst: cur.gst + gs[i] });
  });
  return out;
}

/** An invoice that is in the summary: issued, a Tax Invoice, with a support line. */
export function isSupportTaxInvoice(inv: SummaryInvoice): boolean {
  return (ISSUED_INVOICE_STATUSES as readonly string[]).includes(inv.status)
    && isTaxInvoiceRow(inv)
    && (Array.isArray(inv.line_items) ? inv.line_items as SummaryLine[] : []).some((l) => isSupportSkuId(l?.item_id ?? null));
}

/**
 * The summary. `invoices` are the period's invoices; `creditNotes` the period's credit
 * notes; `parents` every invoice a credit note points at (the period's or older). All rows
 * must already be the caller's tenant — this function does not see tenants.
 */
export function summariseSupportInvoices(args: {
  from: string;
  to: string;
  invoices: SummaryInvoice[];
  creditNotes: SummaryCreditNote[];
  parents: SummaryInvoice[];
}): SupportInvoiceSummary {
  const { from, to } = args;
  const plan = new Map<string, { taxable: number; gst: number; count: number }>();
  const month = new Map<string, { taxable: number; gst: number; count: number }>();
  let count = 0;
  const add = (m: typeof plan, key: string, taxable: number, gst: number, n: number) => {
    const cur = m.get(key) ?? { taxable: 0, gst: 0, count: 0 };
    m.set(key, { taxable: cur.taxable + taxable, gst: cur.gst + gst, count: cur.count + n });
  };

  for (const inv of args.invoices) {
    if (inv.invoice_date < from || inv.invoice_date > to || !isSupportTaxInvoice(inv)) continue;
    const shares = supportShares(docPaise(inv), inv.line_items);
    count += 1;
    let t = 0, g = 0;
    for (const [key, s] of shares) { add(plan, key, s.taxable, s.gst, 1); t += s.taxable; g += s.gst; }
    add(month, inv.invoice_date.slice(0, 7), t, g, 1);
  }

  const parentById = new Map(args.parents.map((p) => [p.id, p]));
  for (const cn of args.creditNotes) {
    if (cn.credit_date < from || cn.credit_date > to || !cn.invoice_id) continue;
    const parent = parentById.get(cn.invoice_id);
    if (!parent || !isSupportTaxInvoice(parent)) continue;
    const shares = supportShares(docPaise(cn), parent.line_items);
    let t = 0, g = 0;
    for (const [key, s] of shares) { add(plan, key, -s.taxable, -s.gst, 0); t += s.taxable; g += s.gst; }
    add(month, cn.credit_date.slice(0, 7), -t, -g, 0);
  }

  let tt = 0, tg = 0;
  for (const v of plan.values()) { tt += v.taxable; tg += v.gst; }
  return {
    currency: "INR",
    from,
    to,
    total_taxable: rupees(tt),
    total_gst: rupees(tg),
    total_with_gst: rupees(tt + tg),
    count,
    by_plan: [...plan.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([plan_key, v]) => ({
      plan_key, taxable: rupees(v.taxable), gst: rupees(v.gst), total: rupees(v.taxable + v.gst), count: v.count,
    })),
    by_month: [...month.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({
      month: m, taxable: rupees(v.taxable), total: rupees(v.taxable + v.gst), count: v.count,
    })),
  };
}
