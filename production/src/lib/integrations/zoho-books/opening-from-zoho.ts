/**
 * R-2474 — Reconcile from Zoho: last year's invoice the app has no opening invoice for. Its opening
 * invoice is made from Zoho's OWN invoice as it stood on the books' start (1 Apr): total − the Zoho
 * receipts (+ TDS) and credit notes dated before it. Pure, no I/O. The plan (bulk-reconcile-plan.ts)
 * uses it; the Book step makes the invoice through import_opening_invoices (R-1739: no GST, no revenue).
 */
import { formatDate, rupee } from "@/lib/utils";
import type { ZohoMatchInvoice } from "./payment-match";

/** R-2474: one of last year's invoices the bank line settles. */
export interface OpeningPart {
  /** The opening invoice in the app; null = made from Zoho (create) in the Book step first. */
  invoiceId: string | null;
  number: string;
  /** Cash applied to it (whole rupees). */
  amount: number;
  tds: number;
  create: OpeningCreate | null;
}

/** R-2474: an opening invoice made from Zoho's own invoice — import_opening_invoices' row (R-1739:
 *  no GST, no revenue — they were filed from Zoho). Keyed by the Zoho number: a re-run skips it. */
export interface OpeningCreate {
  zohoId: string;
  number: string;
  invoiceDate: string;
  dueDate: string | null;
  total: number;
  /** Due as at the FY start (books' start): total − Zoho receipts / TDS / credits dated before it. */
  balance: number;
  gstin: string | null;
  posStateCode: string | null;
}

export const fmtDay = (iso: string) => formatDate(iso);
const rupees = (n: number) => rupee(Math.round(n));
export const whole = (n: number) => Math.abs(n - Math.round(n)) < 0.005;

/**
 * R-2474: Zoho's invoice as it stood on `cutoff` (the books' start / 1 Apr) → the opening invoice to
 * make. Refused (with the reason) when Zoho's own history does not add up to its balance today, when
 * a write-off / paise / a foreign currency is involved, or when nothing was due on the cutoff.
 */
export function openingFromZoho(
  inv: ZohoMatchInvoice, cutoff: string,
): { ok: true; create: OpeningCreate } | { ok: false; problem: string } {
  const h = inv.history;
  const no = inv.number;
  if (!h) return { ok: false, problem: `Zoho's invoice ${no} was not read with its payments — press Start again.` };
  if (h.currency && h.currency !== "INR") return { ok: false, problem: `Zoho's invoice ${no} is in ${h.currency} — only a rupee invoice becomes an opening invoice. Reconcile this line by hand.` };
  const total = inv.total;
  if (total === null || !(total > 0) || !inv.date) return { ok: false, problem: `Zoho's invoice ${no} has no total or date. Reconcile this line by hand.` };
  if (h.writeOff > 0) return { ok: false, problem: `Zoho's invoice ${no} has ${rupees(h.writeOff)} written off — Zoho does not say when, so its 1 Apr balance is not certain. Reconcile this line by hand.` };
  const paidAll = h.payments.reduce((s, p) => s + p.amount + p.tds, 0) + h.credits.reduce((s, c) => s + c.amount, 0);
  if (h.balance === null || Math.abs(total - paidAll - h.balance) > 0.5) {
    return { ok: false, problem: `Zoho's invoice ${no} does not add up: total ${rupees(total)}, receipts and credits ${rupees(paidAll)}, balance ${rupees(h.balance ?? 0)}. Check it in Zoho, or reconcile this line by hand.` };
  }
  if ([...h.payments, ...h.credits].some((x) => !x.date)) return { ok: false, problem: `A receipt on Zoho's invoice ${no} has no date. Reconcile this line by hand.` };
  const before = h.payments.filter((p) => p.date! < cutoff).reduce((s, p) => s + p.amount + p.tds, 0)
    + h.credits.filter((c) => c.date! < cutoff).reduce((s, c) => s + c.amount, 0);
  const balance = total - before;
  if (!whole(total) || !whole(balance)) return { ok: false, problem: `Zoho's invoice ${no} has paise (total ${total}, due on ${fmtDay(cutoff)} ${Math.round(balance * 100) / 100}) — an opening invoice is in whole rupees. Reconcile this line by hand.` };
  if (Math.round(balance) <= 0) return { ok: false, problem: `Zoho's invoice ${no} was paid before ${fmtDay(cutoff)} — nothing was due on ${fmtDay(cutoff)}, so this line is not for its opening balance. Reconcile this line by hand.` };
  return {
    ok: true,
    create: {
      zohoId: inv.zohoId, number: no, invoiceDate: inv.date.slice(0, 10), dueDate: h.dueDate,
      total: Math.round(total), balance: Math.round(balance), gstin: h.gstin, posStateCode: h.placeOfSupply,
    },
  };
}

const normNo = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

/**
 * R-2474: what one bank line does to last year's invoices of its Zoho payment — per invoice the
 * opening invoice the app has (by Zoho number) or one made from Zoho (openingFromZoho), and the cash
 * on it: the whole line for one invoice (with its TDS), Zoho's amount applied for several (no TDS —
 * Zoho does not say which invoice it is on). `problems` empty = bookable.
 */
export function openingParts(
  invoices: readonly ZohoMatchInvoice[], credit: number, tds: number,
  openings: ReadonlyArray<{ id: string; number: string | null; due: number }>, cutoff: string,
): { parts: OpeningPart[]; problems: string[]; notes: string[]; dueSum: number } {
  const several = invoices.length > 1;
  const nos = invoices.map((i) => i.number).join(", ");
  const problems: string[] = [];
  const notes: string[] = [];
  const parts: OpeningPart[] = [];
  let dueSum = 0;
  if (!whole(credit)) problems.push(`The bank line has paise (${credit}) — a receipt is in whole rupees. Reconcile this line by hand.`);
  if (several && tds > 0) {
    problems.push(`The Zoho payment settles several of last year's invoices (${nos}) with TDS ${rupees(tds)} — Zoho does not say which invoice the TDS is on. Record it in Record payment against those invoices, then match the line by hand.`);
  }
  for (const zi of invoices) {
    const amount = several ? zi.amountApplied ?? 0 : Math.round(credit);
    const partTds = several ? 0 : tds;
    if (several && (!(amount > 0) || !whole(amount))) {
      problems.push(`Zoho applied ${zi.amountApplied ?? 0} to ${zi.number} — not whole rupees. Reconcile this line by hand.`);
      continue;
    }
    const have = openings.find((o) => normNo(o.number) === normNo(zi.number)) ?? null;
    let due: number;
    let create: OpeningCreate | null = null;
    if (have) {
      due = have.due;
    } else {
      const made = openingFromZoho(zi, cutoff);
      if (!made.ok) { problems.push(made.problem); continue; }
      create = made.create;
      due = made.create.balance;
      notes.push(`Opening invoice ${zi.number} is made from Zoho: total ${rupees(made.create.total)}, ${rupees(made.create.balance)} due on ${fmtDay(cutoff)} — GST and revenue stay in Zoho's books, not counted again.`);
    }
    dueSum += due;
    if (Math.round(amount) + partTds > due) {
      problems.push(`${zi.number} ${have ? "has" : "had"} only ${rupees(due)} due${have ? "" : ` on ${fmtDay(cutoff)}`}, but the bank line${partTds ? " + TDS" : ""}${several ? " puts" : " is"} ${rupees(Math.round(amount) + partTds)}${several ? " on it" : ""}. Reconcile this line by hand.`);
    }
    parts.push({ invoiceId: have?.id ?? null, number: zi.number, amount: Math.round(amount), tds: partTds, create });
  }
  if (several && problems.length === 0) {
    const applied = parts.reduce((s, p) => s + p.amount, 0);
    if (applied !== Math.round(credit)) problems.push(`Zoho applied ${rupees(applied)} to ${nos}, but the bank line is ${rupees(credit)}. Reconcile this line by hand.`);
  }
  return { parts, problems, notes, dueSum };
}
