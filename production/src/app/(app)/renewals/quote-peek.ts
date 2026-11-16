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
 */
import { lineServicePeriod, quoteLinePeriodContext, addDaysIso, isoDateOf, type LinePeriodLine, type RenewedSubscriptionFacts } from "@/lib/quotes/service-period";

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
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMon = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

/** "1 Oct–31 Oct 2026" (the owner's words); across a year end "1 Nov 2026–31 Oct 2027". Both ends inclusive. */
export function dayRange(from: string, toInclusive: string): string {
  const sameYear = from.slice(0, 4) === toInclusive.slice(0, 4);
  return `${dayMon(from)}${sameYear ? "" : ` ${from.slice(0, 4)}`}–${dayMon(toInclusive)} ${toInclusive.slice(0, 4)}`;
}

type RawLine = LinePeriodLine & { qty?: unknown; billing_id?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function seatsOf(line: RawLine): string | null {
  const oneTime = line.one_time === true || !text(line.commitment) || text(line.commitment) === "one_time";
  const n = Number(line.qty);
  if (oneTime || !Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString("en-IN")} seat${n === 1 ? "" : "s"}`;
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
    return {
      name: text(l.name) || text(l.description) || "Item",
      seats: seatsOf(l),
      period: from && to ? dayRange(from, to) : null,
      from, to,
      domain: text(l.domain) || text(partSub?.domain) || text(subs.get(text(l.subscription_id))?.domain) || null,
    };
  });
}

/** "Google Workspace Business Starter · 473 seats · 1 Oct–31 Oct 2026" — a missing piece is left out. */
export function peekLineText(l: PeekLine): string {
  return [l.name, l.seats, l.period].filter(Boolean).join(" · ");
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

/** The pop-up's money lines from the quote's stored figures (₹, as the books hold them). */
export function peekTotals(q: { subtotal?: number | null; discount_pct?: number | null; tax_rate?: number | null; amount?: number | null }): {
  subtotal: number; discount: number; taxable: number; gst: number; gstRate: number; total: number;
} {
  const subtotal = Number(q.subtotal ?? 0);
  const discount = Math.round(subtotal * (Number(q.discount_pct ?? 0) / 100));
  const taxable = subtotal - discount;
  const gstRate = Number(q.tax_rate ?? 0);
  const computed = Math.round(taxable * (gstRate / 100));
  /* the stored amount is the quote's total (pay-intent.ts quoteTotal) — GST is what it adds to the taxable value */
  const total = q.amount ?? taxable + computed;
  return { subtotal, discount, taxable, gst: q.amount == null ? computed : Math.max(0, total - taxable), gstRate, total };
}
