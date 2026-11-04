/**
 * R-2423 (Pardeep, 3 Nov 2026 — staging Q-A378-27-0930) — WHAT a quote is, in one big word.
 *
 * A renewal part's payment request read only "Sent · Payment request · Awaiting payment": nothing
 * said it was a RENEWAL, for which subscription, or which part of the term. The team could not
 * tell what a received payment was for. This is the one rule for the stamp on the quote page,
 * the chip on the Quotes list and the word on the invoice page header.
 *
 * Only stored facts decide it — never a guess. When the facts do not say, there is NO stamp:
 *   • a part's payment request (quotes.subscription_billing_id, R-2044) → its part
 *     (subscription_billings) decides: a later term of the subscription = RENEWAL, the first term
 *     of a subscription sold by a quote in this app = NEW SALE; "Part n of N · <months>".
 *     Part not loaded → no stamp (the page keeps its "Payment request" badge).
 *   • is_add_seats → ADD SEATS · is_extension → EXTENSION
 *   • support-plan upgrade (quoteDocumentKind, R-2093 — stored as is_renewal) → UPGRADE
 *   • is_renewal / renewal_subscription_id → RENEWAL
 *   • is_one_off, or every line one-time → ONE-TIME
 *   • any other quote with lines → NEW SALE; no lines → no stamp.
 * PROJECT quotes live in project_sales (their own page), never in `quotes`, so no quote here is one.
 * Paid (quoteIsPaid — the PDF's own rule) adds "· PAID <date>" in green.
 */
import { quoteDocumentKind, quoteIsPaid } from "@/lib/pdf/quote-document-kind";
import { CYCLE_MONTHS, periodLastDay } from "@/lib/billing/schedule";
import { formatMonthLabel, toIstDate } from "@/lib/dates/ist";
import type { BillingCycle, Quote } from "@/lib/supabase/database.types";

export type QuoteKind = "renewal" | "new_sale" | "add_seats" | "extension" | "upgrade" | "one_time";

const WORD: Record<QuoteKind, string> = {
  renewal: "RENEWAL", new_sale: "NEW SALE", add_seats: "ADD SEATS",
  extension: "EXTENSION", upgrade: "UPGRADE", one_time: "ONE-TIME",
};
/** The list chip / invoice header word (sentence case). */
const CHIP: Record<QuoteKind, string> = {
  renewal: "Renewal", new_sale: "New sale", add_seats: "Add seats",
  extension: "Extension", upgrade: "Upgrade", one_time: "One-time",
};

export interface QuoteKindQuote {
  is_renewal?: boolean | null;
  is_add_seats?: boolean | null;
  is_extension?: boolean | null;
  extension_months?: number | null;
  is_one_off?: boolean | null;
  renewal_subscription_id?: string | null;
  subscription_billing_id?: string | null;
  line_items?: unknown;
  payment_status?: string | null;
  amount?: number | null;
  payment_amount?: number | null;
  payment_received_at?: string | null;
}

/** The part a payment request bills (subscription_billings) and its subscription. */
export interface QuotePartFacts {
  periodIndex: number;
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD, exclusive (schedule.ts). */
  periodEnd: string;
  termStart: string;
  /** The subscription's start_date (null = not recorded). */
  subStartDate: string | null;
  /** The subscription's earliest laid term_start. */
  firstTermStart: string | null;
  /** subscriptions.quote_id — the sale quote in this app, if any. */
  subQuoteId: string | null;
  billingCycle: BillingCycle | string | null;
  termMonths: number | null;
}

export interface QuoteStamp {
  kind: QuoteKind | null;
  /** "RENEWAL" — null when only the part is known. */
  word: string | null;
  /** "Renewal" — for the list chip / invoice header; null when only the part is known. */
  chip: string | null;
  /** "Part 1 of 12 · Nov 2026" for a payment request. */
  part: string | null;
  /** "Part 1 of 12" — the part alone (the chip's word when the kind is not known). */
  partShort: string | null;
  /** True when the money is in. */
  paid: boolean;
  /** "3 Nov 2026" — null when unpaid or the date is not stored. */
  paidOn: string | null;
  /** The whole stamp: "RENEWAL · Part 1 of 12 · Nov 2026 · PAID 3 Nov 2026". */
  text: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}/;

/** "3 Nov 2026" from a YYYY-MM-DD date, or from a timestamp (its IST day — AGENTS.md §6). */
export function dayMonYear(iso: string | null | undefined): string | null {
  if (!iso || !ISO_RE.test(iso)) return null;
  const day = iso.length > 10 && iso[10] === "T" ? toIstDate(iso) : iso.slice(0, 10);
  if (!ISO_RE.test(day)) return null;
  return `${Number(day.slice(8, 10))} ${formatMonthLabel(day)}`;
}

/**
 * The part's span: whole calendar months → "Nov 2026", "Nov 2026–Jan 2027", "Nov–Dec 2026"; a part
 * that does not start on the 1st (anchored on the 15th, clamped on the 31st) → its days,
 * "15 Nov–14 Dec 2026", so a one-month part never reads as two months.
 */
export function partMonths(periodStart: string, periodEndExclusive: string): string {
  const last = periodLastDay(periodEndExclusive);
  const sameYear = last.slice(0, 4) === periodStart.slice(0, 4);
  if (periodStart.slice(8, 10) !== "01") {
    const from = `${Number(periodStart.slice(8, 10))} ${formatMonthLabel(periodStart).split(" ")[0]}`;
    return `${sameYear ? from : dayMonYear(periodStart)}–${dayMonYear(last)}`;
  }
  if (last.slice(0, 7) <= periodStart.slice(0, 7)) return formatMonthLabel(periodStart);
  if (sameYear) return `${formatMonthLabel(periodStart).split(" ")[0]}–${formatMonthLabel(last)}`;
  return `${formatMonthLabel(periodStart)}–${formatMonthLabel(last)}`;
}

/** Parts in one term (12-month term billed monthly → 12). Null when it does not divide evenly. */
export function partsInTerm(billingCycle: string | null | undefined, termMonths: number | null | undefined): number | null {
  const step = billingCycle ? CYCLE_MONTHS[billingCycle as BillingCycle] : undefined;
  const months = termMonths ?? null;
  if (!step || !months || months <= 0 || months % step !== 0) return null;
  return months / step;
}

/** "Part 1 of 12" ("Part 1" when the term does not divide into parts). */
export function partShortText(p: QuotePartFacts): string | null {
  if (!Number.isInteger(p.periodIndex) || p.periodIndex < 1) return null;
  const n = partsInTerm(p.billingCycle, p.termMonths);
  return `Part ${p.periodIndex}${n != null && p.periodIndex <= n ? ` of ${n}` : ""}`;
}

/** "Part 1 of 12 · Nov 2026" ("Part 1 · Nov 2026" when the term does not divide into parts). */
export function partText(p: QuotePartFacts): string | null {
  const short = partShortText(p);
  if (!short || !ISO_RE.test(p.periodStart) || !ISO_RE.test(p.periodEnd)) return null;
  return `${short} · ${partMonths(p.periodStart, p.periodEnd)}`;
}

/** Is this part in a RENEWED term (renewal) or the subscription's first, sold term (new sale)? */
function partKind(p: QuotePartFacts): QuoteKind | null {
  const first = p.subStartDate ?? p.firstTermStart;
  if (!first || !ISO_RE.test(p.termStart)) return null;
  if (p.termStart.slice(0, 10) > first.slice(0, 10)) return "renewal";
  /* The first term: a new sale only when this app sold it (the subscription has its quote). An
     imported subscription's first laid term may itself be a renewal — the facts do not say. */
  return p.subQuoteId ? "new_sale" : null;
}

function allLinesOneTime(lines: unknown): boolean | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.every((l) => (l as { one_time?: unknown } | null)?.one_time === true);
}

/** The kind from the quote's own flags (not a part request). Null = the facts do not say. */
function flagKind(q: QuoteKindQuote): QuoteKind | null {
  if (q.is_add_seats === true) return "add_seats";
  if (q.is_extension === true) return "extension";
  const doc = quoteDocumentKind({
    is_renewal: q.is_renewal ?? null, is_extension: q.is_extension ?? null,
    extension_months: q.extension_months ?? null, line_items: q.line_items,
  });
  if (doc === "upgrade") return "upgrade";
  if (doc === "renewal" || q.renewal_subscription_id) return "renewal";
  /* No lines = nothing sold (e.g. a customer-advance holder quote, R-2023) → no stamp. */
  const oneTime = allLinesOneTime(q.line_items);
  if (oneTime == null) return null;
  return q.is_one_off === true || oneTime ? "one_time" : "new_sale";
}

/**
 * The stamp for a quote. `part` = the part a payment request bills (null/undefined = not loaded or
 * not a part request). Returns null when the facts say nothing.
 */
export function quoteKindFor(q: QuoteKindQuote | null | undefined, part?: QuotePartFacts | null): QuoteStamp | null {
  if (!q) return null;
  let kind: QuoteKind | null;
  let partLine: string | null = null;
  let partShort: string | null = null;
  if (q.subscription_billing_id) {
    if (!part) return null;
    kind = partKind(part);
    partLine = partText(part);
    partShort = partLine ? partShortText(part) : null;
    if (!kind && !partLine) return null;
  } else {
    kind = flagKind(q);
    if (!kind) return null;
  }
  const paid = quoteIsPaid({
    payment_status: (q.payment_status ?? null) as Quote["payment_status"],
    payment_amount: q.payment_amount ?? null,
    amount: q.amount ?? null,
  });
  const paidOn = paid ? dayMonYear(q.payment_received_at) : null;
  const word = kind ? WORD[kind] : null;
  const bits = [word, partLine, paid ? (paidOn ? `PAID ${paidOn}` : "PAID") : null].filter(Boolean);
  return { kind, word, chip: kind ? CHIP[kind] : null, part: partLine, partShort, paid, paidOn, text: bits.join(" · ") };
}

/** The subscription a quote is for, as one line: "Google Workspace Business Starter · acme.in · 12 seats · renews 31 Oct 2027". */
export function subscriptionForLine(s: {
  plan?: string | null; domain?: string | null; seats?: number | null; renewal_date?: string | null;
} | null | undefined): string | null {
  if (!s) return null;
  const renews = dayMonYear(s.renewal_date);
  const bits = [
    s.plan?.trim() || null,
    s.domain?.trim() || null,
    typeof s.seats === "number" && s.seats > 0 ? `${s.seats} seat${s.seats === 1 ? "" : "s"}` : null,
    renews ? `renews ${renews}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

/** Which subscription the quote is for — part's, renewed, add-seats', or the one it sold. Null = none known. */
export function quoteSubscriptionId(
  q: QuoteKindQuote & { id: string; add_seats_subscription_id?: string | null },
  subs: readonly { id: string; quote_id?: string | null; renewal_quote_id?: string | null; created_at?: string | null }[],
  partSubscriptionId?: string | null,
): string | null {
  if (q.subscription_billing_id) return partSubscriptionId ?? null;
  if (q.is_add_seats === true) return q.add_seats_subscription_id ?? null;
  if (q.renewal_subscription_id) return q.renewal_subscription_id;
  const renewed = subs.find((s) => s.renewal_quote_id === q.id);
  if (renewed) return renewed.id;
  const sold = subs.filter((s) => s.quote_id === q.id)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  return sold[0]?.id ?? null;
}
