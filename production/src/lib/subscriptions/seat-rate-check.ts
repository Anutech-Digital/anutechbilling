/**
 * R-2292 — which ₹/seat/year a Manage seats quote uses, where it came from, and whether it
 * matches what the customer was last invoiced for the same item.
 *
 * June reconcile on staging (31 Oct 2026): three add-seats quotes for one customer came out
 * ₹3,147 / ₹2,886 / ₹2,756 where the vendor-of-record billed ₹3,055 / ₹2,803 / ₹2,667. The
 * subscription's rate (mrr × 12 ÷ seats, seat-increase-charge.ts) was off and nothing on the
 * screen said so. The preview now names the rate and its source, compares it with the last GST
 * invoice line for the item, and lets the operator type the rate for THIS quote only.
 *
 * Pure — the invoice read happens in the caller (use-expected-seat-rate.ts), so the rule is
 * testable without a client.
 */
import { isTaxInvoiceRow } from "@/lib/invoices/document-kind";
import { rupee } from "@/lib/utils";

/** ₹/seat/year a rate may differ from the last invoiced one before the preview warns. */
export const SEAT_RATE_TOLERANCE = 5;
/** Highest ₹/seat/year a typed rate may be — a typo guard, far above any real seat price. */
export const MAX_TYPED_SEAT_RATE = 10_000_000;

export interface RateInvoice {
  id: string;
  invoice_date: string | null;
  status: string;
  document_kind?: string | null;
  quote_id: string | null;
  line_items: unknown;
}

export interface RateSubject {
  plan: string;
  item_id: string | null;
  domain: string | null;
  quote_id: string | null;
  renewal_quote_id?: string | null;
}

export interface ExpectedSeatRate {
  /** ₹/seat/year on that invoice line, after the line's own discount. */
  annualPerSeat: number;
  invoiceId: string;
  invoiceDate: string | null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

type RawLine = {
  item_id?: unknown; name?: unknown; qty?: unknown; rate?: unknown; commitment?: unknown;
  one_time?: unknown; discount_pct?: unknown; domain?: unknown;
};

/** The ₹/seat/year a line bills, or null when it is not a full-term seat line of this item. */
function lineAnnualRate(l: RawLine, sub: RateSubject, own: boolean): number | null {
  if (!l || typeof l !== "object") return null;
  if (l.one_time === true) return null;
  const rate = Number(l.rate);
  if (!(rate > 0) || !(Number(l.qty) > 0)) return null;
  /* An add-seats line is a PRO-RATA rate for part of a term — never the full-year price. */
  if (/pro-?\s?rata/i.test(String(l.name ?? ""))) return null;
  const sameItem = sub.item_id && typeof l.item_id === "string" && l.item_id
    ? l.item_id === sub.item_id
    : norm(l.name) === norm(sub.plan);
  if (!sameItem) return null;
  /* Another subscription's invoice (same customer) counts only for the same domain. */
  if (!own) {
    const d = norm(l.domain);
    if (!d || d !== norm(sub.domain)) return null;
  }
  const annual = l.commitment === "monthly" ? rate * 12 : rate;   // R-369: monthly lines are ₹/month
  const disc = Number(l.discount_pct) || 0;
  return Math.round(annual * (1 - Math.min(Math.max(disc, 0), 100) / 100));
}

/**
 * The subscription's expected rate: the newest live GST tax invoice line for its item — first
 * among the invoices of its own sale / renewal quotes, else among the customer's other invoices
 * for the same domain. Void, draft and opening (Zoho-imported) invoices and pro-rata lines are
 * skipped. Null = nothing to compare with (no warning).
 */
export function expectedSeatRate(sub: RateSubject, invoices: readonly RateInvoice[]): ExpectedSeatRate | null {
  const ownQuotes = new Set([sub.quote_id, sub.renewal_quote_id].filter((x): x is string => !!x));
  const live = invoices
    .filter((i) => i.status !== "void" && i.status !== "draft" && isTaxInvoiceRow(i))
    .slice()
    .sort((a, b) => String(b.invoice_date ?? "").localeCompare(String(a.invoice_date ?? "")) || b.id.localeCompare(a.id));
  for (const ownPass of [true, false]) {
    for (const inv of live) {
      const own = !!inv.quote_id && ownQuotes.has(inv.quote_id);
      if (own !== ownPass) continue;
      const lines = Array.isArray(inv.line_items) ? (inv.line_items as RawLine[]) : [];
      for (const l of lines) {
        const r = lineAnnualRate(l, sub, own);
        if (r !== null) return { annualPerSeat: r, invoiceId: inv.id, invoiceDate: inv.invoice_date };
      }
    }
  }
  return null;
}

export interface SeatRateWarning {
  used: number;
  expected: number;
  /** used − expected, ₹/seat/year. */
  diff: number;
  message: string;
}

/** A warning when the rate used is more than ₹5/seat/year away from the last invoiced one. */
export function seatRateWarning(used: number, expected: ExpectedSeatRate | null): SeatRateWarning | null {
  if (!expected || !(used > 0)) return null;
  const diff = used - expected.annualPerSeat;
  if (Math.abs(diff) <= SEAT_RATE_TOLERANCE) return null;
  return {
    used, expected: expected.annualPerSeat, diff,
    message: `This quote uses ${rupee(used)}/seat/year, but the last invoice ${expected.invoiceId} billed ${rupee(expected.annualPerSeat)}/seat/year (${rupee(Math.abs(diff))} ${diff > 0 ? "more" : "less"}). Check the rate before adding.`,
  };
}

/** The "Rate for this quote" box: blank = the subscription's rate; else whole rupees > 0. */
export function parseTypedSeatRate(s: string): { ok: true; rate: number | null } | { ok: false; message: string } {
  const t = s.replace(/[,\s₹]/g, "");
  if (t === "") return { ok: true, rate: null };
  if (!/^\d+$/.test(t)) return { ok: false, message: "Enter the rate in whole rupees per seat per year, e.g. 3055." };
  const n = Number(t);
  if (!(n >= 1) || n > MAX_TYPED_SEAT_RATE) return { ok: false, message: "Enter a rate above ₹0 per seat per year." };
  return { ok: true, rate: n };
}

/** One line under the rate in the preview: where the ₹/seat/year came from. */
export function seatRateSourceText(a: { typed: number | null; storedAnnualPerSeat: number; currentMrr: number; currentSeats: number }): string {
  if (a.typed !== null) return `Typed for this quote only (subscription rate ${rupee(a.storedAnnualPerSeat)} stays)`;
  return `From this subscription (${rupee(a.currentMrr)}/mo ÷ ${a.currentSeats} seats × 12)`;
}
