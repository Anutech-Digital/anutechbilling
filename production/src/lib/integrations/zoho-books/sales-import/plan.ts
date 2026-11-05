/**
 * R-2499 (G-FY2526) — which scanned Zoho invoices become FY 2025-26 sales, and why the others do not.
 *
 * Input: the Zoho facts (normalise.ts, whole rupees) + what the app already has (customers,
 * catalogue items, invoices carrying a Zoho number, the books start). Output: one verdict per
 * invoice and the month-by-month totals (taxable, IGST, CGST, SGST) — Zoho side and the part that
 * will come in, so the owner compares them with Zoho before pressing Import.
 *
 * Safe defaults (card needsDecision): no customer in the app → skip and report (never create one
 * here — Import customers from Zoho first); a Zoho number that is already an OPENING invoice → skip
 * (that conversion is R-2504's data repair, never a second copy); a Zoho number an app sale already
 * carries (bank-credit new sale, R-2360) → skip.
 *
 * The SQL import (import_zoho_fy_sales) checks the same money rules again — this is the preview.
 * Pure: no I/O.
 */
import { splitTaxHeads } from "@/lib/gst/tax-split";
import type { ZohoSaleFacts } from "./normalise";

export interface AppCustomer { id: string; name: string; gstin: string | null }
export interface AppItem { id: string; name: string }
export interface AppInvoiceRef { id: string; externalNumber: string | null; documentKind: string; zohoInvoiceId: string | null }

export interface PlanContext {
  /** FY range, inclusive (YYYY-MM-DD). */
  fyStart: string;
  fyEnd: string;
  /** The company's books start (R-2496), null = not set. */
  booksStart: string | null;
  /** books_locked_until, null = not locked. */
  lockedUntil: string | null;
  customers: AppCustomer[];
  items: AppItem[];
  invoices: AppInvoiceRef[];
}

export type Verdict = "import" | "already" | "skip";

export interface PlannedSale {
  facts: ZohoSaleFacts;
  verdict: Verdict;
  reason: string | null;
  customerId: string | null;
  matchedBy: "gstin" | "name" | null;
  /** Catalogue item per line (same order as facts.lines), null when none matched. */
  itemIds: (string | null)[];
}

export interface MonthTotals { month: string; count: number; taxable: number; igst: number; cgst: number; sgst: number; amount: number }

export interface SalesPlan {
  rows: PlannedSale[];
  counts: { scanned: number; import: number; already: number; skip: number; voidOrDraft: number };
  /** Every Zoho invoice that IS a sale (not void / draft) — what Zoho's GSTR-1 had. */
  zohoByMonth: MonthTotals[];
  /** The ones that will come in now. */
  importByMonth: MonthTotals[];
  /** Skip reasons, most common first. */
  skipReasons: { reason: string; count: number }[];
}

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const reasonKey = (r: string) => r.replace(/₹[\d,.]+|\d{2}(?=\))|"[^"]*"/g, "…");

export function heads(f: Pick<ZohoSaleFacts, "tax" | "head">) {
  return splitTaxHeads(f.tax, f.head === "igst");
}

function addTo(map: Map<string, MonthTotals>, f: ZohoSaleFacts) {
  const month = f.date.slice(0, 7);
  const m = map.get(month) ?? { month, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, amount: 0 };
  const h = heads(f);
  m.count += 1; m.taxable += f.taxable; m.igst += h.igst; m.cgst += h.cgst; m.sgst += h.sgst; m.amount += f.amount;
  map.set(month, m);
}

export function buildSalesPlan(all: ZohoSaleFacts[], ctx: PlanContext): SalesPlan {
  const byGstin = new Map<string, AppCustomer[]>();
  const byName = new Map<string, AppCustomer[]>();
  for (const c of ctx.customers) {
    const g = (c.gstin ?? "").trim().toUpperCase();
    if (g) byGstin.set(g, [...(byGstin.get(g) ?? []), c]);
    const n = normName(c.name);
    if (n) byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const itemByName = new Map<string, string | null>();
  for (const it of ctx.items) {
    const n = normName(it.name);
    /* Two catalogue items with one name → no guess. */
    itemByName.set(n, itemByName.has(n) ? null : it.id);
  }
  const byZohoId = new Map<string, AppInvoiceRef>();
  const byNumber = new Map<string, AppInvoiceRef>();
  for (const i of ctx.invoices) {
    if (i.zohoInvoiceId) byZohoId.set(i.zohoInvoiceId, i);
    if (i.externalNumber) byNumber.set(i.externalNumber.toUpperCase(), i);
    if (i.documentKind === "opening_invoice") byNumber.set(i.id.toUpperCase(), byNumber.get(i.id.toUpperCase()) ?? i);
  }

  const seen = new Set<string>();
  const zoho = new Map<string, MonthTotals>();
  const imp = new Map<string, MonthTotals>();
  const reasons = new Map<string, { reason: string; count: number }>();
  const counts = { scanned: all.length, import: 0, already: 0, skip: 0, voidOrDraft: 0 };

  const rows = all.map((f): PlannedSale => {
    const out: PlannedSale = { facts: f, verdict: "skip", reason: null, customerId: null, matchedBy: null, itemIds: f.lines.map(() => null) };
    const isVoidDraft = f.status === "void" || f.status === "draft";
    if (isVoidDraft) counts.voidOrDraft += 1;
    else if (f.date >= ctx.fyStart && f.date <= ctx.fyEnd) addTo(zoho, f);

    const existing = byZohoId.get(f.zohoId);
    const sameNumber = byNumber.get(f.number.toUpperCase());
    if (existing) {
      out.verdict = "already"; out.reason = `Already imported as ${existing.id}.`;
    } else if (seen.has(f.zohoId)) {
      out.reason = "Listed twice by Zoho.";
    } else if (f.problems.length) {
      out.reason = f.problems[0];
    } else if (f.date < ctx.fyStart || f.date > ctx.fyEnd) {
      out.reason = `Dated ${f.date}, outside the financial year.`;
    } else if (!ctx.booksStart) {
      out.reason = "The books start date is not set (Accounting → Overview → Books start).";
    } else if (f.date < ctx.booksStart) {
      out.reason = `Dated ${f.date}, before the books start (${ctx.booksStart}).`;
    } else if (ctx.lockedUntil && f.date <= ctx.lockedUntil) {
      out.reason = `Dated ${f.date}, inside the books lock (till ${ctx.lockedUntil}).`;
    } else if (sameNumber && sameNumber.documentKind === "opening_invoice") {
      out.reason = `${f.number} is already an opening invoice — it is converted by the data repair (R-2504), not imported again.`;
    } else if (sameNumber) {
      out.reason = `${f.number} is already on app invoice ${sameNumber.id}.`;
    } else {
      const g = f.gstin.trim().toUpperCase();
      const gHits = g ? byGstin.get(g) ?? [] : [];
      const nHits = byName.get(normName(f.customerName)) ?? [];
      if (gHits.length === 1) { out.customerId = gHits[0].id; out.matchedBy = "gstin"; }
      else if (gHits.length > 1) {
        const pick = gHits.filter((c) => normName(c.name) === normName(f.customerName));
        if (pick.length === 1) { out.customerId = pick[0].id; out.matchedBy = "gstin"; }
        else out.reason = `${gHits.length} customers carry GSTIN ${g} — keep one, then preview again.`;
      } else if (nHits.length === 1 && (!g || !nHits[0].gstin || nHits[0].gstin.toUpperCase() === g)) {
        out.customerId = nHits[0].id; out.matchedBy = "name";
      } else if (nHits.length > 1) {
        out.reason = `${nHits.length} customers are named "${f.customerName}" — add the GSTIN to the right one, then preview again.`;
      }
      if (!out.customerId && !out.reason) {
        out.reason = `No customer "${f.customerName}" in the app — import customers from Zoho first, then preview again.`;
      }
      if (out.customerId) {
        out.verdict = "import";
        out.itemIds = f.lines.map((l) => itemByName.get(normName(l.name)) ?? null);
      }
    }
    seen.add(f.zohoId);
    if (out.verdict === "import") { counts.import += 1; addTo(imp, f); }
    else if (out.verdict === "already") counts.already += 1;
    else {
      counts.skip += 1;
      const k = reasonKey(out.reason ?? "");
      const r = reasons.get(k) ?? { reason: out.reason ?? "", count: 0 };
      r.count += 1; reasons.set(k, r);
    }
    return out;
  });

  const sorted = (m: Map<string, MonthTotals>) => [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
  return {
    rows,
    counts,
    zohoByMonth: sorted(zoho),
    importByMonth: sorted(imp),
    skipReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
  };
}

/** The row the SQL import takes (import_zoho_fy_sales p_rows) — whole rupees only. */
export function toSqlRow(p: PlannedSale) {
  const f = p.facts;
  return {
    zoho_invoice_id: f.zohoId,
    number: f.number,
    invoice_date: f.date,
    due_date: f.dueDate,
    zoho_status: f.status,
    customer_id: p.customerId,
    customer_gstin: f.gstin || null,
    pos_state_code: f.posStateCode,
    inter_state: f.head === "igst",
    currency: f.currency === "INR" ? null : f.currency,
    fx_rate: f.fxRate,
    taxable_value: f.taxable,
    tax_amount: f.tax,
    tax_rate: f.taxRate,
    amount: f.amount,
    line_items: f.lines.map((l, i) => ({
      name: l.name,
      description: l.description || undefined,
      hsn: l.hsn || undefined,
      qty: l.qty,
      rate: l.rate,
      amount: l.taxable,
      item_id: p.itemIds[i] ?? undefined,
      zoho_item_id: l.zohoItemId || undefined,
    })),
  };
}
