/**
 * R-2359 — a Zoho payment match → what the Reconcile sheet's EXISTING "A new sale" form is filled
 * with. Pure (no I/O); the sheet calls it with the tenant's own customers and catalogue, which it
 * has already loaded. Nothing is saved here — the owner checks the form and presses Save.
 *
 *   customer  GSTIN first (exact, case ignored), then the normalised company name; exactly one app
 *             customer or none — two with the same name is never guessed.
 *   products  catalogue sku, then the exact (normalised) name; a line with no catalogue product
 *             stays as a typed line (its name, Zoho's rate) and is listed in `unmatched`.
 *   seats / rate  Zoho's quantity and rate, kept as a TYPED price (R-2053/R-2178: a Commitment
 *             change never converts it silently).
 *   term      1 month → Monthly flex; One-Time / no catalogue term → One-time; else Annual.
 *   dates     the earliest line start → renews the day after the latest line end.
 */
import { defaultCycle, saleLineFromItem, type SaleCycle, type SaleLine } from "@/lib/banking/credit-pay-for";
import type { ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

export interface AppCustomerLite { id: string; name: string; gstin?: string | null }
type CatalogLite = Parameters<typeof saleLineFromItem>[0] & { sku?: string | null; is_active?: boolean | null };

export interface CustomerMapping { id: string; name: string; by: "gstin" | "name" }

export interface ZohoPrefill {
  customer: CustomerMapping | null;
  lines: SaleLine[];
  /** Zoho product names with no catalogue product (typed lines). */
  unmatched: string[];
  subStart: string | null;
  subRenewal: string | null;
  invoiceNumbers: string[];
  /** Plain notes for the owner (e.g. a part-year term). */
  notes: string[];
}

const SUFFIXES = /\b(private limited|pvt ltd|pvt limited|private ltd|limited|ltd|llp|opc)\b/g;

/** "SUPREME MEDIA & STUDIOS PRIVATE LIMITED" and "Supreme Media and Studios Pvt. Ltd." → one key. */
export function normCompanyName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bp\s*v\s*t\b/g, "pvt")
    .replace(SUFFIXES, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapZohoCustomer(
  zoho: { name: string; gstin: string | null }, customers: readonly AppCustomerLite[],
): CustomerMapping | null {
  const g = (zoho.gstin ?? "").trim().toUpperCase();
  if (g) {
    const byG = customers.filter((c) => (c.gstin ?? "").trim().toUpperCase() === g);
    if (byG.length >= 1) {
      const same = byG.find((c) => normCompanyName(c.name) === normCompanyName(zoho.name)) ?? byG[0];
      return { id: same.id, name: same.name, by: "gstin" };
    }
  }
  const key = normCompanyName(zoho.name);
  if (!key) return null;
  const byN = customers.filter((c) => normCompanyName(c.name) === key);
  return byN.length === 1 ? { id: byN[0].id, name: byN[0].name, by: "name" } : null;
}

const normItem = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function matchCatalogItem<T extends { id: string; name: string; sku?: string | null; is_active?: boolean | null }>(
  line: Pick<ZohoMatchLine, "name" | "sku">, catalog: readonly T[],
): T | null {
  const active = catalog.filter((c) => c.is_active !== false);
  const sku = (line.sku ?? "").trim().toUpperCase();
  if (sku) {
    const bySku = active.filter((c) => (c.sku ?? "").trim().toUpperCase() === sku);
    if (bySku.length === 1) return bySku[0];
  }
  const n = normItem(line.name);
  if (!n) return null;
  const byName = active.filter((c) => normItem(c.name) === n);
  return byName.length === 1 ? byName[0] : null;
}

function cycleFor(line: ZohoMatchLine, item: CatalogLite | null): SaleCycle {
  if (line.months === 0) return "one_time";
  if (line.months === 1) return "monthly";
  if (line.months === null && !line.start) return item ? defaultCycle(item) : "one_time";
  return "annual_yearly";
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

let typedSeq = 0;

export function zohoPrefill(
  match: ZohoPaymentMatch,
  ctx: { customers: readonly AppCustomerLite[]; catalog: readonly CatalogLite[]; txnDate: string },
): ZohoPrefill {
  const lines: SaleLine[] = [];
  const unmatched: string[] = [];
  const notes: string[] = [];
  const starts: string[] = [];
  const ends: string[] = [];
  for (const inv of match.invoices) {
    for (const zl of inv.lines) {
      if (!zl.name.trim() || !(zl.qty > 0)) continue;
      const item = matchCatalogItem(zl, ctx.catalog) as CatalogLite | null;
      const cycle = cycleFor(zl, item);
      const base: SaleLine = item
        ? saleLineFromItem(item, cycle, zl.qty)
        : { key: `zoho-line-${++typedSeq}`, itemId: null, name: zl.name.trim(), qty: zl.qty, rate: 0, cost: 0, cycle, perSeat: true, monthPriced: false };
      if (!item) unmatched.push(zl.name.trim());
      const rate = zl.rate ?? (zl.itemTotal !== null && zl.qty > 0 ? zl.itemTotal / zl.qty : base.rate);
      lines.push({
        ...base,
        qty: zl.qty,
        rate: Math.round(rate * 100) / 100,
        priceTyped: true,
        typedFor: cycle,
        ...(zl.domain ? { domain: zl.domain } : {}),
      });
      if (zl.start && zl.end) { starts.push(zl.start); ends.push(zl.end); }
      if (cycle === "annual_yearly" && zl.months !== null && zl.months !== 12) {
        notes.push(`${zl.name.trim()}: Zoho billed ${zl.months} month${zl.months === 1 ? "" : "s"} — check the price per year.`);
      }
    }
  }
  starts.sort(); ends.sort();
  const subStart = starts[0] ?? null;
  const subRenewal = subStart && ends.length ? nextDay(ends[ends.length - 1]) : null;
  return {
    customer: mapZohoCustomer(match.customer, ctx.customers),
    lines,
    unmatched,
    subStart,
    subRenewal,
    invoiceNumbers: [...match.invoices.map((i) => i.number), ...match.moreInvoices],
    notes,
  };
}

/**
 * R-2360: the Zoho invoice number the sale keeps on its app invoice (invoices.external_number) —
 * only when the Zoho payment was applied to exactly ONE invoice. Several (or none) → null: one app
 * sale cannot be several Zoho invoices, so the numbers are only shown.
 */
export function zohoSaleNumber(p: Pick<ZohoPrefill, "invoiceNumbers"> | null | undefined): string | null {
  const nums = (p?.invoiceNumbers ?? []).map((n) => n.trim()).filter(Boolean);
  return nums.length === 1 ? nums[0] : null;
}

/** R-2360: the result line about the Zoho number after Save (null = no Zoho number on this sale). */
export function zohoKeptLine(r: {
  external_number?: string | null; external_number_saved?: boolean; external_number_error?: string | null;
  invoice_issued?: string | null; invoice_id?: string | null;
}): { text: string; tone: "ok" | "warn" } | null {
  if (!r.external_number) return null;
  if (r.external_number_error) {
    return { text: `Zoho invoice ${r.external_number} was not kept on the invoice: ${r.external_number_error}`, tone: "warn" };
  }
  if (r.external_number_saved) {
    const inv = r.invoice_issued ?? r.invoice_id ?? null;
    return { text: `Zoho invoice ${r.external_number} is kept on ${inv ?? "the invoice"}.`, tone: "ok" };
  }
  return { text: `Zoho invoice ${r.external_number} is not on an invoice yet — the first part's invoice was not raised now.`, tone: "warn" };
}

/** R-2360: zohoKeptLine as a list for the result panel (empty when the sale had no Zoho number). */
export function zohoKeptLines(r: object): Array<{ text: string; tone: "ok" | "warn" }> {
  const line = zohoKeptLine(r as Parameters<typeof zohoKeptLine>[0]);
  return line ? [line] : [];
}
