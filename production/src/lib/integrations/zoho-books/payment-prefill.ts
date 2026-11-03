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
import { rupee } from "@/lib/utils";
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
  /** R-2440: Zoho billed in a foreign currency and no bank rate fitting Zoho's was found, so the
   *  prices were left in that currency — each line's key, name and foreign price. Save stays blocked
   *  (zohoUnconvertedProblem) until each is typed in ₹. Null = nothing left unconverted. */
  unconverted: { currency: string; lines: Array<{ key?: string; name: string; rate: number }> } | null;
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

/**
 * R-2402: one Zoho invoice line → the sale line the Reconcile sheet books (catalogue product by sku /
 * name, else a typed line), Zoho's seats and rate kept as a typed price. Null for a blank line or
 * one with no quantity. Shared by zohoPrefill (the sheet) and the bulk "Reconcile from Zoho" plan.
 */
export function zohoSaleLine(zl: ZohoMatchLine, catalog: readonly CatalogLite[]): { line: SaleLine; cycle: SaleCycle; inCatalog: boolean } | null {
  if (!zl.name.trim() || !(zl.qty > 0)) return null;
  const item = matchCatalogItem(zl, catalog) as CatalogLite | null;
  const cycle = cycleFor(zl, item);
  const base: SaleLine = item
    ? saleLineFromItem(item, cycle, zl.qty)
    : { key: `zoho-line-${++typedSeq}`, itemId: null, name: zl.name.trim(), qty: zl.qty, rate: 0, cost: 0, cycle, perSeat: true, monthPriced: false };
  const rate = zl.rate ?? (zl.itemTotal !== null && zl.qty > 0 ? zl.itemTotal / zl.qty : base.rate);
  return {
    line: {
      ...base,
      qty: zl.qty,
      rate: Math.round(rate * 100) / 100,
      priceTyped: true,
      typedFor: cycle,
      ...(zl.domain ? { domain: zl.domain } : {}),
    },
    cycle,
    inCatalog: Boolean(item),
  };
}

export function zohoPrefill(
  match: ZohoPaymentMatch,
  /** R-2425: `credit` = the bank line's ₹ — a Zoho payment in a foreign currency is filled in ₹ at
   *  the rate the bank converted at (credit ÷ Zoho's foreign amount). */
  ctx: { customers: readonly AppCustomerLite[]; catalog: readonly CatalogLite[]; txnDate: string; credit?: number },
): ZohoPrefill {
  const lines: SaleLine[] = [];
  const unmatched: string[] = [];
  const notes: string[] = [];
  const code = match.payment.currency ?? null;
  const cur = code && code !== "INR" ? code : null;
  const implied = cur && ctx.credit && ctx.credit > 0 && match.payment.amount > 0 ? ctx.credit / match.payment.amount : null;
  /* A rate more than 2% off Zoho's own means the bank received less (charges kept abroad) or a
     different payment — never absorbed into the price silently. */
  const zr = match.payment.exchangeRate ?? null;
  const fxRate = implied && (!zr || Math.abs(implied - zr) / zr <= 0.02) ? implied : null;
  if (cur && implied && !fxRate) {
    notes.push(`Zoho billed in ${cur} at ${rupee(zr ?? 0, { decimals: 2 })} but the money received works out to ${rupee(implied, { decimals: 2 })} per ${cur} — the remitting bank may have kept charges. Prices are left in ${cur} as Zoho has them: type each price in ₹ before saving, or use Reconcile from Zoho.`);
  }
  if (cur && fxRate) {
    notes.push(`Zoho billed in ${cur}: prices are filled in ₹ at the bank's rate (${rupee(fxRate, { decimals: 4 })} per ${cur}), so the sale equals the money received. 0% GST — export of services under LUT. To book it in ${cur} on the invoice, use Reconcile from Zoho.`);
  }
  const starts: string[] = [];
  const ends: string[] = [];
  for (const inv of match.invoices) {
    for (const zl of inv.lines) {
      const made = zohoSaleLine(zl, ctx.catalog);
      if (!made) continue;
      const { cycle } = made;
      if (!made.inCatalog) unmatched.push(zl.name.trim());
      lines.push(fxRate ? { ...made.line, rate: Math.round(made.line.rate * fxRate * 100) / 100 } : made.line);
      if (zl.start && zl.end) { starts.push(zl.start); ends.push(zl.end); }
      if (cycle === "annual_yearly" && zl.months !== null && zl.months !== 12) {
        notes.push(`${zl.name.trim()}: Zoho billed ${zl.months} month${zl.months === 1 ? "" : "s"} — check the price per year.`);
      }
    }
  }
  starts.sort(); ends.sort();
  const subStart = starts[0] ?? null;
  const subRenewal = subStart && ends.length ? nextDay(ends[ends.length - 1]) : null;
  /* R-2440: a foreign bill not converted (no bank rate that fits Zoho's) has its prices in that
     currency — Save is blocked until each is typed in ₹ (review 2: ₹1,024 sale + ₹94,822 advance). */
  const unconverted = cur && !fxRate && lines.length
    ? { currency: cur, lines: lines.map((l) => ({ key: l.key, name: l.name, rate: l.rate })) }
    : null;
  return {
    customer: mapZohoCustomer(match.customer, ctx.customers),
    lines,
    unmatched,
    subStart,
    subRenewal,
    invoiceNumbers: [...match.invoices.map((i) => i.number), ...match.moreInvoices],
    notes,
    unconverted,
  };
}

/**
 * R-2440: why Save is blocked — a line Find in Zoho filled in a foreign currency still has that
 * foreign price (same line, same rate). Null once every such line has a ₹ price typed (or was
 * removed), or when nothing was left unconverted.
 */
export function zohoUnconvertedProblem(
  prefill: Pick<ZohoPrefill, "unconverted"> | null | undefined,
  lines: ReadonlyArray<{ key?: string; name: string; rate: number }>,
): string | null {
  const u = prefill?.unconverted;
  if (!u) return null;
  const still = u.lines.filter((o) => lines.some((l) => (o.key ? l.key === o.key : l.name === o.name) && l.rate === o.rate));
  if (still.length === 0) return null;
  return `Prices are still in ${u.currency} as Zoho has them (${still.map((o) => o.name).join(", ")}) — type each price in ₹ before saving.`;
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
export function zohoKeptLines(r: object): Array<{ text: string; tone: "ok" | "warn"; href?: string }> {
  const line = zohoKeptLine(r as Parameters<typeof zohoKeptLine>[0]);
  return line ? [line] : [];
}
