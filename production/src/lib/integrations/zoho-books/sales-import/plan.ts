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
 * R-2530 — customer matching when the GSTINs differ. An invoice WITH a GSTIN keeps its own GSTIN,
 * place of supply and GST head (the SQL import writes them from the scan) — GSTR-1 for FY 25-26 was
 * filed from Zoho with them. R-2536: an invoice with NO GSTIN stays without one (B2C as filed) and
 * keeps Zoho's own billing address — the party-snapshot trigger no longer fills an imported sale's
 * buyer facts from the customer (invoices.party_from_source). So:
 *   - exactly one customer with the same name and the same PAN (valid GSTINs, characters 3–12) → the
 *     same legal entity at another branch → imported onto it (matchedBy "pan");
 *   - same name, a different PAN → skipped with "Name matches … but the GSTIN differs", unless the
 *     owner ticks "Use this customer anyway" for that Zoho customer (ctx.useAnyway; matchedBy "chosen");
 *   - an archived (inactive) customer does not block: when only one of the matches is active, it is used.
 *
 * The SQL import (import_zoho_fy_sales) checks the same money rules again — this is the preview.
 * Pure: no I/O.
 */
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { panFromGstin } from "@/lib/gst/customer-gst-treatment";
import type { ZohoSaleFacts } from "./normalise";

/** `active` false = archived (customers.is_active false); missing = active. */
export interface AppCustomer { id: string; name: string; gstin: string | null; active?: boolean }
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
  /** R-2530: the owner's "Use this customer anyway" ticks — gstinChoiceKey (normalised Zoho name +
   *  the invoice's PAN, R-2536) → app customer id. Honoured only when that customer is the one the
   *  name matched. */
  useAnyway?: Readonly<Record<string, string>>;
}

export type Verdict = "import" | "already" | "skip";

export interface PlannedSale {
  facts: ZohoSaleFacts;
  verdict: Verdict;
  reason: string | null;
  customerId: string | null;
  /** gstin = same GSTIN; name = same name, GSTIN equal or missing on one side; pan = same name +
   *  same PAN, another state's GSTIN; chosen = same name, other PAN, owner ticked it (R-2530). */
  matchedBy: "gstin" | "name" | "pan" | "chosen" | null;
  /** Catalogue item per line (same order as facts.lines), null when none matched. */
  itemIds: (string | null)[];
}

/** R-2530: one per Zoho customer whose name matches one app customer with a different PAN. */
export interface GstinChoice {
  /** gstinChoiceKey(Zoho name, invoice GSTIN) — the key of PlanContext.useAnyway. */
  key: string;
  zohoName: string;
  customerId: string;
  customerName: string;
  customerGstin: string;
  /** The GSTINs on this customer's Zoho invoices (each invoice keeps its own). */
  invoiceGstins: string[];
  count: number;
  amount: number;
  chosen: boolean;
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
  /** R-2530: name matches with a different PAN — the owner decides each. */
  gstinChoices: GstinChoice[];
}

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** R-2536: one "Use this customer anyway" tick = one Zoho buyer — its normalised name AND the
 *  invoice's PAN (the full GSTIN when it has no valid PAN), so two near-same names with different
 *  PANs never share a tick. */
export function gstinChoiceKey(zohoName: string, invoiceGstin: string): string {
  const g = invoiceGstin.trim().toUpperCase();
  return `${normName(zohoName)}|${panFromGstin(g) ?? g}`;
}
const reasonKey = (r: string) => r.replace(/₹[\d,.]+|\d{2}(?=\))|"[^"]*"/g, "…");

/** One customer from several: the only one, else the only ACTIVE one, else none (no guess). */
function onlyOne(list: AppCustomer[]): AppCustomer | null {
  if (list.length === 1) return list[0];
  const active = list.filter((c) => c.active !== false);
  return active.length === 1 ? active[0] : null;
}

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
  /* A Zoho number is taken when any invoice carries it as its number or its id — an opening
     invoice first (same order as the SQL import), so its R-2504 reason wins. */
  const take = (k: string, i: AppInvoiceRef) => {
    const prev = byNumber.get(k);
    if (!prev || (prev.documentKind !== "opening_invoice" && i.documentKind === "opening_invoice")) byNumber.set(k, i);
  };
  for (const i of ctx.invoices) {
    if (i.zohoInvoiceId) byZohoId.set(i.zohoInvoiceId, i);
    if (i.externalNumber) take(i.externalNumber.toUpperCase(), i);
    take(i.id.toUpperCase(), i);
  }

  const seen = new Set<string>();
  const zoho = new Map<string, MonthTotals>();
  const imp = new Map<string, MonthTotals>();
  const reasons = new Map<string, { reason: string; count: number }>();
  const counts = { scanned: all.length, import: 0, already: 0, skip: 0, voidOrDraft: 0 };
  const choices = new Map<string, GstinChoice>();

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
      const key = normName(f.customerName);
      const gHits = g ? byGstin.get(g) ?? [] : [];
      const nHits = byName.get(key) ?? [];
      const nOne = onlyOne(nHits);
      /* Same GSTIN: the only (active) one, else the only (active) one with this name. */
      const gHit = gHits.length ? onlyOne(gHits) ?? onlyOne(gHits.filter((c) => normName(c.name) === key)) : null;
      /* An ARCHIVED GSTIN match loses to the one active customer with this name (R-2530). */
      const archivedOnly = !!gHit && gHit.active === false && !!nOne && nOne.active !== false && nOne.id !== gHit.id;
      if (gHits.length && !archivedOnly) {
        if (gHit) { out.customerId = gHit.id; out.matchedBy = "gstin"; }
        else out.reason = `${gHits.length} customers carry GSTIN ${g} — keep one, then preview again.`;
      } else if (nOne) {
        const cg = (nOne.gstin ?? "").trim().toUpperCase();
        const pan = panFromGstin(g);
        if (!g || !cg || cg === g) { out.customerId = nOne.id; out.matchedBy = "name"; }
        /* Valid GSTINs only — a typo never invents a PAN (lib/gst/customer-gst-treatment.ts). */
        else if (pan && pan === panFromGstin(cg)) { out.customerId = nOne.id; out.matchedBy = "pan"; }
        else {
          /* Another PAN: never on its own — the owner ticks "Use this customer anyway". */
          /* R-2536: keyed by name + the invoice's PAN — one tick never covers another PAN's buyer. */
          const ck = gstinChoiceKey(f.customerName, g);
          const chosen = ctx.useAnyway?.[ck] === nOne.id;
          const ch = choices.get(ck) ?? { key: ck, zohoName: f.customerName, customerId: nOne.id, customerName: nOne.name,
            customerGstin: cg, invoiceGstins: [], count: 0, amount: 0, chosen };
          if (!ch.invoiceGstins.includes(g)) ch.invoiceGstins.push(g);
          ch.count += 1; ch.amount += f.amount;
          choices.set(ck, ch);
          if (chosen) { out.customerId = nOne.id; out.matchedBy = "chosen"; }
          else out.reason = `Name matches "${nOne.name}" but the GSTIN differs (invoice "${g}" vs customer "${cg}") — tick "Use this customer anyway" if it is the same buyer.`;
        }
      } else if (nHits.length > 1) {
        out.reason = `${nHits.length} customers are named "${f.customerName}" — add the GSTIN to the right one, then preview again.`;
      }
      if (!out.customerId && !out.reason) {
        out.reason = `No app customer is named "${f.customerName}"${g ? ` or has GSTIN "${g}"` : ""} — import customers from Zoho first, then preview again.`;
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
    gstinChoices: [...choices.values()].sort((a, b) => b.amount - a.amount),
  };
}

/**
 * What the SQL import takes per invoice (import_zoho_fy_sales p_picks): the Zoho id and the
 * customer / catalogue items the preview matched. NO money — the SQL reads every amount from the
 * server's own scan of Zoho (zoho_sale_import_scan), so nothing sent here can change a figure.
 */
export function toPick(p: PlannedSale) {
  return { zoho_invoice_id: p.facts.zohoId, customer_id: p.customerId, item_ids: p.itemIds };
}

/** Who may import FY sales (import_zoho_fy_sales checks the same roles). */
export const SALES_IMPORT_ROLES = ["owner", "accountant"] as const;
export function canImportFySales(role: string | null | undefined): boolean {
  return (SALES_IMPORT_ROLES as readonly string[]).includes(role ?? "");
}
