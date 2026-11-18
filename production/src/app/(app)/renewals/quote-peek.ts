/**
 * R-2866 (Pardeep 16 Nov 2026: "quotation ka pop up window khulna chahiye" + "quote number par mouse le jao
 * to saare product unke subscription period ke saath") — the rules behind the Renewals row's quote hover
 * card and quote pop-up. Pure; the read is ./quote-peek-data.ts, the screens ./row-quote.tsx and
 * ./quote-peek-dialog.tsx.
 *
 * One line per product line of the quote: "Google Workspace Business Starter · 473 seats · 1 Oct–31 Oct 2026".
 * A Bill together quote has one line per subscription (each line names its own part / subscription), so it
 * gets one line each. The period is never a guess:
 *   1. a part proforma's line → its part's stored period (subscription_billings; period_end is exclusive);
 *      a line with no billing_id on a part proforma is the proforma's own (lead) part;
 *   2. any other line → the quote paper's own "Subscription period" (lineServicePeriod, R-1764 / R-2727 /
 *      R-2849 — the same rule the quote page and the PDF print);
 *   3. not certain (one-time line, a renewal quote with no term date, …) → no period on that line.
 *
 * Said ONCE (review, 16 Nov): a part request's line is named by the database (part_request_line_name, R-2423) —
 * "Google Workspace Business Starter · ravi.in · 473 seats · 1 Oct–31 Oct 2026 (part 1 of 12)" — so its seats and
 * period are already in the name: nothing is added after it (`periodInName`; a name with a seat count gets no
 * second one — plan-seats.ts planNamesSeats, the row's own R-2857 rule). The period is still kept on the line for
 * the pop-up's overall period.
 *
 * R-2922 (Pardeep 18 Nov 2026, the same quote: "ye renewal quotation ki tarah jaye") — the pop-up's line reads
 * like a renewal quotation's: the product, seats × the rate a seat, the period.
 *   - a line whose qty IS seats (a subscription line, a part request's per-seat line) keeps its stored rate a
 *     seat (`seatRate`): "2 seats × ₹1,656"; when the name already says the seats, "₹135 a seat" (said once).
 *     A one-time or lump line has none — its amount is not a rate a seat;
 *   - the oldest part requests are named by their short label ("Payment for month 1 · …") with the product in
 *     the description: on a part request the product is shown (part-requests.ts partLineProductName).
 */
import { lineServicePeriod, quoteLinePeriodContext, addDaysIso, isoDateOf, type LinePeriodLine, type RenewedSubscriptionFacts } from "@/lib/quotes/service-period";
import { periodText } from "@/lib/billing/proforma";
import { partLineProductName } from "@/lib/billing/part-requests";
import { rupee } from "@/lib/utils";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { taxableAfterDiscount } from "@/lib/quotes/amounts";
import { quoteTotal } from "@/app/(app)/quotes/[id]/pay-intent";
import { planNamesSeats } from "./plan-seats";

/** What the batched read returns for a quote (quote-peek-data.ts PEEK_QUOTE_COLS). */
export interface PeekQuoteRow {
  id: string;
  line_items: unknown;
  is_renewal: boolean | null;
  is_extension: boolean | null;
  is_add_seats: boolean | null;
  is_one_off: boolean | null;
  extension_months: number | null;
  renewal_term_date: string | null;
  created_date: string | null;
  domain: string | null;
  subscription_billing_id: string | null;
  renewal_subscription_id: string | null;
}

/** A billed part's stored period; period_end exclusive, as subscription_billings keeps it. */
export interface PeekBilling { id: string; subscription_id: string; period_start: string | null; period_end: string | null }

/** The subscription facts a period needs (where its next term starts) + its domain. */
export interface PeekSub { id: string; domain?: string | null; start_date?: string | null; term_months?: number | null }

export interface PeekLine {
  name: string;
  /** "473 seats" / "1 seat"; null for a one-time line or no quantity. */
  seats: string | null;
  /** "1 Oct–31 Oct 2026"; null = not certain (never a guess). */
  period: string | null;
  /** YYYY-MM-DD, both inclusive — for the pop-up's overall period; null with `period`. */
  from: string | null;
  to: string | null;
  domain: string | null;
  /** The line's name already says its period (a part request's R-2423 name) — never print it a second time. */
  periodInName?: boolean;
  /** R-2922: ₹ a seat as stored on the line — only when its qty IS seats and a rate is stored; else null. */
  seatRate?: number | null;
}

/** "1 Oct–31 Oct 2026" (the owner's words); across a year end "1 Nov 2026–31 Oct 2027". Both ends inclusive.
    The part request paper's own wording (lib/billing/proforma.ts periodText). */
export function dayRange(from: string, toInclusive: string): string {
  return periodText(from, toInclusive);
}

/** A day range written in a name: "1 Oct–31 Oct 2026" / "1 Nov 2026–31 Oct 2027" (en dash or hyphen). */
/* R-2922: this pattern had lost its backslashes (a backspace character, plain d and s), so it never matched —
   only the exact-period check beside it worked. Restored as the comment above describes it. */
const RANGE_IN_NAME = /\b\d{1,2} [A-Z][a-z]{2}(?: \d{4})?\s*[–-]\s*\d{1,2} [A-Z][a-z]{2} \d{4}\b/;

type RawLine = LinePeriodLine & { qty?: unknown; rate?: unknown; billing_id?: unknown; per_seat?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The line's seat count when its qty IS seats; null for a one-time / lump line or no quantity. */
function seatQty(line: RawLine): number | null {
  /* a part request's line is stored one_time; per_seat says its qty IS the seats (R-2519) */
  const oneTime = line.per_seat !== true && (line.one_time === true || !text(line.commitment) || text(line.commitment) === "one_time");
  const n = Number(line.qty);
  return oneTime || !Number.isFinite(n) || n <= 0 ? null : n;
}

function seatsOf(line: RawLine, name: string): string | null {
  const n = seatQty(line);
  if (n == null || planNamesSeats(name)) return null;
  return `${n.toLocaleString("en-IN")} seat${n === 1 ? "" : "s"}`;
}

/** R-2922: the stored ₹ a seat of a line whose qty is seats; null = not a seat line, or no rate stored. */
function seatRateOf(line: RawLine): number | null {
  if (seatQty(line) == null || typeof line.rate !== "number" || !Number.isFinite(line.rate) || line.rate < 0) return null;
  return line.rate;
}

/**
 * The quote's product lines, in the quote's own order. `rowSub`: the Renewals row's subscription — the one a
 * renewal quote renews when the quote does not name it (quotes made before R-1574).
 */
export function peekLines(
  q: PeekQuoteRow,
  billings: ReadonlyMap<string, PeekBilling>,
  subs: ReadonlyMap<string, PeekSub>,
  rowSub?: PeekSub | null,
): PeekLine[] {
  const raw = (Array.isArray(q.line_items) ? (q.line_items as RawLine[]) : []).filter((l) => !!l && typeof l === "object");
  const facts = (s: PeekSub | null | undefined): RenewedSubscriptionFacts | null =>
    (s ? { domain: s.domain ?? null, start_date: s.start_date ?? null, term_months: s.term_months ?? null } : null);
  const renewed = (q.renewal_subscription_id ? subs.get(q.renewal_subscription_id) : null) ?? rowSub ?? null;
  const lineSubs: Record<string, RenewedSubscriptionFacts> = {};
  for (const l of raw) {
    const sid = text(l.subscription_id);
    const f = sid ? facts(subs.get(sid) ?? (rowSub?.id === sid ? rowSub : null)) : null;
    if (f) lineSubs[sid] = f;
  }
  const ctx = quoteLinePeriodContext(q, { ...(facts(renewed) ?? {}), ...(Object.keys(lineSubs).length ? { lines: lineSubs } : {}) });
  return raw.map((l): PeekLine => {
    const part = billings.get(text(l.billing_id) || (q.subscription_billing_id ?? ""));
    let from: string | null = null;
    let to: string | null = null;
    if (q.subscription_billing_id) {
      /* a part proforma: only the part's stored period — never a term worked out from the line */
      const a = isoDateOf(part?.period_start);
      const b = isoDateOf(part?.period_end);
      if (a && b && b > a) { from = a; to = addDaysIso(b, -1); }
    } else {
      const p = lineServicePeriod(l, ctx);
      if (p) { from = p.from; to = p.to; }
    }
    const partSub = part ? subs.get(part.subscription_id) : undefined;
    /* R-2922: the oldest part lines are named by their short label — show the product they are for */
    const name = (q.subscription_billing_id ? partLineProductName(l as { name?: string | null; description?: string | null }) : null)
      || text(l.name) || text(l.description) || "Item";
    const period = from && to ? dayRange(from, to) : null;
    return {
      name,
      seats: seatsOf(l, name),
      period,
      from, to,
      periodInName: RANGE_IN_NAME.test(name) || (!!period && name.includes(period)),
      seatRate: seatRateOf(l),
      domain: text(l.domain) || text(partSub?.domain) || text(subs.get(text(l.subscription_id))?.domain) || null,
    };
  });
}

/** "Google Workspace Business Starter · 473 seats · 1 Oct–31 Oct 2026" — a missing piece is left out. */
export function peekLineText(l: PeekLine): string {
  return [l.name, l.seats, l.periodInName ? null : l.period].filter(Boolean).join(" · ");
}

/** The pop-up's small line under a product name: what the name does not already say. Null = nothing to add.
    R-2922: seats × the rate a seat, as on a renewal quotation ("2 seats × ₹1,656"); "₹135 a seat" when the name
    already says the seats. `money` = the quote's own money words (the pop-up passes its currency's). */
export function peekLineDetail(l: PeekLine, money: (inr: number) => string = (n) => rupee(n)): string | null {
  const domain = l.domain && !l.name.toLowerCase().includes(l.domain.toLowerCase()) ? l.domain : null;
  const period = l.periodInName ? null : l.period ?? "No period on this line";
  const price = l.seatRate == null ? l.seats : l.seats ? `${l.seats} × ${money(l.seatRate)}` : `${money(l.seatRate)} a seat`;
  return [price, domain, period].filter(Boolean).join(" · ") || null;
}

/** The hover card shows at most this many lines, then "+N more". */
export const HOVER_MAX_LINES = 6;

export function hoverLines(lines: readonly PeekLine[], max = HOVER_MAX_LINES): { shown: string[]; more: number } {
  return { shown: lines.slice(0, max).map(peekLineText), more: Math.max(0, lines.length - max) };
}

/** The whole quote's period — the range its lines cover; null when no line has a certain period. */
export function peekPeriod(lines: readonly PeekLine[]): string | null {
  const withP = lines.filter((l): l is PeekLine & { from: string; to: string } => !!l.from && !!l.to);
  if (!withP.length) return null;
  return dayRange(withP.map((l) => l.from).sort()[0], withP.map((l) => l.to).sort().at(-1)!);
}

/** The billing parts and subscriptions a quote's lines need (the second round of the read). */
export function peekNeeds(quotes: readonly PeekQuoteRow[]): { billingIds: string[]; subIds: string[] } {
  const billingIds = new Set<string>();
  const subIds = new Set<string>();
  for (const q of quotes) {
    if (q.subscription_billing_id) billingIds.add(q.subscription_billing_id);
    if (q.renewal_subscription_id) subIds.add(q.renewal_subscription_id);
    for (const l of Array.isArray(q.line_items) ? (q.line_items as RawLine[]) : []) {
      if (!l || typeof l !== "object") continue;
      if (text(l.billing_id)) billingIds.add(text(l.billing_id));
      if (text(l.subscription_id)) subIds.add(text(l.subscription_id));
    }
  }
  return { billingIds: [...billingIds].sort(), subIds: [...subIds].sort() };
}

/** The pop-up's money lines from the quote's stored figures (₹, as the books hold them) — the quote page's own
    rules: total = pay-intent.ts quoteTotal; GST = quote-tax.ts quoteDisplayTax (a stored total that is not
    taxable + GST beyond ₹1 rounding shows the worked GST, so the mismatch stays visible — as on the quote page). */
export function peekTotals(q: { subtotal?: number | null; discount_pct?: number | null; tax_rate?: number | null; amount?: number | null }): {
  subtotal: number; discount: number; taxable: number; gst: number; gstRate: number; total: number;
} {
  const subtotal = Number(q.subtotal ?? 0);
  /* the one home of the quote-level discount (lib/quotes/amounts.ts — the figure generate_invoice puts on the invoice) */
  const taxable = taxableAfterDiscount(subtotal, Number(q.discount_pct ?? 0));
  const discount = Math.round(subtotal) - taxable;
  const gstRate = Number(q.tax_rate ?? 0);
  const total = quoteTotal({ amount: q.amount ?? null, subtotal, discount_pct: Number(q.discount_pct ?? 0), tax_rate: gstRate });
  return { subtotal, discount, taxable, gst: quoteDisplayTax(taxable, gstRate, q.amount), gstRate, total };
}
