/**
 * R-806 — the period a quote's payment really covers, in words a customer reads.
 *
 * The public accept page printed "covers full 12 months of service" on every single-invoice
 * quote, and the builder said "pay once for full year". An add-seats quote for 1 seat over
 * 340 days (Q-F588-27-0007) carried that promise too — more than the customer pays for.
 *
 * Where the period comes from, most specific first:
 *   1. Line dates. Add-seats lines name their window — "(pro-rata from X to Y)",
 *      "(previous term, pro-rata from X to Y)", "(current term X to Y)" (R-800, R-543).
 *      Every term line must carry one; otherwise we do not know the whole period.
 *   2. Renewal / extension quotes: `extension_months` — the field record_payment rolls the
 *      subscription forward by, so it is what the money really buys.
 *   3. No flags (the builder editing it): "· 2-year extension" in the line name.
 *   4. A new quote: the lines' commitment — "monthly" (flex) is 1 month, any annual
 *      commitment is 12 months.
 * Anything else (one-off sale, add-seats without dates, mixed terms) → null, and the
 * caller drops the claim instead of guessing.
 */
import { utcDateISO } from "@/lib/dates/ist";

export type QuoteServicePeriod =
  | { kind: "range"; from: string; to: string }
  | { kind: "months"; months: number };

export interface QuotePeriodLine {
  name?: string | null;
  commitment?: string | null;
}

export interface QuotePeriodInput {
  lines: QuotePeriodLine[];
  isAddSeats?: boolean | null;
  isRenewal?: boolean | null;
  isExtension?: boolean | null;
  isOneOff?: boolean | null;
  extensionMonths?: number | null;
}

const EXT_RE = /\b(\d{1,2})-(year|month) extension\b/i;
const RANGE_RE = /(?:pro-rata from|current term)\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i;

function validIso(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The dated window a line names, or null. */
export function lineDateRange(name: string | null | undefined): { from: string; to: string } | null {
  const m = RANGE_RE.exec(name ?? "");
  if (!m || !validIso(m[1]) || !validIso(m[2]) || m[2] < m[1]) return null;
  return { from: m[1], to: m[2] };
}

export function quoteServicePeriod(input: QuotePeriodInput): QuoteServicePeriod | null {
  const lines = input.lines ?? [];
  if (input.isOneOff || lines.length === 0) return null;

  // 1. Dated lines (add-seats). A line with no term (one-time service) is not a period.
  const termLines = lines.filter((l) => l.commitment != null || lineDateRange(l.name));
  const ranges = termLines.map((l) => lineDateRange(l.name));
  if (ranges.some(Boolean)) {
    if (ranges.some((r) => !r)) return null; // some term lines dated, some not: no one answer
    const all = ranges as { from: string; to: string }[];
    const from = all.reduce((a, r) => (r.from < a ? r.from : a), all[0].from);
    const to   = all.reduce((a, r) => (r.to > a ? r.to : a), all[0].to);
    return { kind: "range", from, to };
  }
  if (input.isAddSeats) return null; // pro-rata quote without its dates: do not guess

  const commitments = new Set(termLines.map((l) => l.commitment as string));
  const allMonthly = commitments.size === 1 && commitments.has("monthly");
  const allAnnual  = commitments.size > 0 && [...commitments].every((c) => c.startsWith("annual_"));

  // 2. Renewal / extension: the months record_payment adds.
  if (input.isRenewal || input.isExtension) {
    const m = input.extensionMonths;
    if (typeof m !== "number" || !Number.isInteger(m) || m <= 0) return null;
    if (allMonthly && m !== 1) return null;  // lines say monthly, field says more: conflict
    /* R-811: a month extension (R-805) carries the seats' annual commitment on its line but
       buys only extension_months — that IS the period. A plain renewal with odd months on an
       annual line is still a conflict. */
    if (allAnnual && m % 12 !== 0 && !input.isExtension) return null;
    return { kind: "months", months: m };
  }

  // 3. No flags (the builder): an extension line names its length — "· 2-year extension",
  //    "· 3-month extension" (R-805).
  const lens = termLines.map((l) => {
    const m = EXT_RE.exec(l.name ?? "");
    return m ? Number(m[1]) * (m[2].toLowerCase() === "year" ? 12 : 1) : null;
  });
  if (lens.length > 0 && lens.every((n) => n && n === lens[0])) {
    return { kind: "months", months: lens[0] as number };
  }

  // 4. New quote: the commitment.
  if (allMonthly) return { kind: "months", months: 1 };
  if (allAnnual) return { kind: "months", months: 12 };
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-25" → "25 Sep 2026". Read as a calendar date — no timezone shift. */
export function periodDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** 1 → "1 month", 12 → "12 months", 24 → "2 years", 18 → "18 months". */
export function monthsWords(months: number): string {
  if (months === 1) return "1 month";
  if (months > 12 && months % 12 === 0) return `${months / 12} years`;
  return `${months} months`;
}

/** "covers 25 Sep 2026 to 31 Aug 2027" / "covers 12 months" — null when unknown. */
export function servicePeriodText(period: QuoteServicePeriod | null): string | null {
  if (!period) return null;
  if (period.kind === "range") return `covers ${periodDate(period.from)} to ${periodDate(period.to)}`;
  return `covers ${monthsWords(period.months)}`;
}

/**
 * R-809 — a quote paid once has no billing schedule. Add-seats (pro-rata) and one-off quotes
 * still carry the seats' "annual_yearly" commitment on their lines, so the accept page and the
 * PDF printed "Annual commit · billed yearly" on a one-time charge (Q-F588-27-0007).
 */
export function isOneTimeQuote(q: {
  isAddSeats?: boolean | null;
  isOneOff?: boolean | null;
  /** R-811: a MONTH extension is paid once for N months, not "billed per year". */
  isExtension?: boolean | null;
  extensionMonths?: number | null;
}): boolean {
  return q.isAddSeats === true || q.isOneOff === true || isMonthExtension(q);
}

type ExtensionFlags = { isExtension?: boolean | null; extensionMonths?: number | null };

/** Whole, positive extension_months on an extension quote — else null. */
function extensionMonthsOf(q: ExtensionFlags): number | null {
  const m = q.extensionMonths;
  if (q.isExtension !== true || typeof m !== "number" || !Number.isInteger(m) || m <= 0) return null;
  return m;
}

/**
 * R-811 — an extension that adds MONTHS (R-805: 1–11, or any count that is not whole years).
 * Its line keeps the seats' annual commitment, which printed "Annual commitment · billed per
 * year · ₹810/yr" on a 3-month extension. Whole-year extensions are not this.
 */
export function isMonthExtension(q: ExtensionFlags): boolean {
  const m = extensionMonthsOf(q);
  return m != null && m % 12 !== 0;
}

/**
 * R-811 — the heading an extension quote carries, from extension_months: 3 → "3-month
 * extension", 12 → "1-year extension", 24 → "2-year extension". The badge printed
 * round(months / 12) + " yr", i.e. "Extension · 0 yr" for 3 months. Null when the quote is
 * not an extension or its months are unknown.
 */
export function extensionTitle(q: ExtensionFlags): string | null {
  const m = extensionMonthsOf(q);
  if (m == null) return null;
  return m % 12 === 0 ? `${m / 12}-year extension` : `${m}-month extension`;
}

/** R-811: the line's sub-text on a one-time quote, e.g. "3-month extension · one-time charge". */
export function oneTimeLineNote(q: ExtensionFlags & { isAddSeats?: boolean | null }): string {
  if (q.isAddSeats === true) return "Pro-rata · one-time charge for the rest of the term";
  const title = isMonthExtension(q) ? extensionTitle(q) : null;
  return title ? `${title[0].toUpperCase()}${title.slice(1)} · one-time charge` : "One-time charge";
}

/** What the "Billing schedule" line says on a one-time quote. */
export const ONE_TIME_SCHEDULE = "One-time charge";

/* ───────────────────────── R-1764 — per-line Domain + Subscription period ─────────────────────────
 * Zoho printed, under every subscription line of a quote and an invoice, the domain and
 * "Subscription Period: 1 Year (27/10/2026 - 26/10/2027)". The customer and the CA read the
 * money's period from it. Ours said only "Annual commit". One helper, used by the builder
 * preview, the quote PDF, the accept page, the quote email and the tax invoice raised from the
 * quote, so all of them say the same dates.
 *
 * Where a line's dates come from, most certain first:
 *   1. Add-seats: the window its name carries — "(pro-rata from X to Y)" (R-800) → X – Y.
 *   2. Renewal (and extension) quotes: quotes.renewal_term_date (R-1574) is the subscription's
 *      renewal date the quote was made for — the last day of the current term. The quote buys
 *      the NEXT term: the day after it, for extension_months.
 *      "renewal 26 Oct 2026, 12 months" → 27/10/2026 – 26/10/2027.
 *   3. A new sale: the line's start_date, else the quote's date (record_payment starts the
 *      subscription on the line's start_date, else on the payment date) → + the line's term.
 * Anything else — a one-time line, a one-off quote, a renewal without its term date, an
 * add-seats line without its dates, a commitment we do not know — prints NO period line: no
 * date is better than a wrong one.
 */

export interface LinePeriodLine {
  name?: string | null;
  description?: string | null;
  commitment?: string | null;
  one_time?: boolean | null;
  start_date?: string | null;
  domain?: string | null;
  bulk?: boolean | null;
  domains?: Array<{ domain: string; seats: number }> | null;
}

export interface LinePeriodContext {
  isRenewal?: boolean | null;
  isExtension?: boolean | null;
  isAddSeats?: boolean | null;
  isOneOff?: boolean | null;
  extensionMonths?: number | null;
  /** quotes.renewal_term_date — the renewal date of the term a renewal quote was made for. */
  renewalTermDate?: string | null;
  /** The date a new sale's term starts on when its line has no start_date (the quote's date). */
  startFallback?: string | null;
  /** quotes.domain, else the renewed subscription's domain. A line's own domain wins. */
  domain?: string | null;
}

export interface LinePeriod { from: string; to: string; months: number | null }

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoOf(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim().slice(0, 10);
  return ISO_RE.test(s) && validIso(s) ? s : null;
}

/** A Date built from UTC parts back to its calendar date (never a timezone shift). */
const toIso = utcDateISO;

/** Calendar date + n days (no timezone shift). */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toIso(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Calendar date + n months, the day clamped to the month's end (31 Jan + 1 → 28/29 Feb). */
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}

/** Is this line a subscription (renews), as quote_line_is_subscription reads it? */
function isTermLine(line: LinePeriodLine): boolean {
  if (line.one_time === true) return false;
  if (lineDateRange(line.name)) return true;
  const c = (line.commitment ?? "").trim().toLowerCase();
  return c !== "" && c !== "one_time";
}

/** Months one term of this line runs: monthly (flex) 1, any annual commitment 12, else null. */
function lineTermMonths(commitment: string | null | undefined): number | null {
  const c = (commitment ?? "").trim().toLowerCase();
  if (c === "monthly") return 1;
  if (c.startsWith("annual_")) return 12;
  return null;
}

function validMonths(m: number | null | undefined): m is number {
  return typeof m === "number" && Number.isInteger(m) && m > 0;
}

/** The dates one line's money covers, or null when they are not certain. */
export function lineServicePeriod(line: LinePeriodLine, ctx: LinePeriodContext): LinePeriod | null {
  if (ctx.isOneOff === true || !isTermLine(line)) return null;

  // 1. Add-seats: the window the line names.
  const range = lineDateRange(line.name);
  if (range) return { from: range.from, to: range.to, months: null };
  if (ctx.isAddSeats === true) return null;

  const termMonths = lineTermMonths(line.commitment);

  // 2. Renewal / extension: the next term after the one the quote was made for.
  if (ctx.isRenewal === true || ctx.isExtension === true) {
    const rtd = isoOf(ctx.renewalTermDate);
    const m = ctx.extensionMonths;
    if (!rtd || !validMonths(m)) return null;
    if (termMonths === 1 && m !== 1) return null; // monthly line, longer field: conflict
    return { from: addDaysIso(rtd, 1), to: addMonthsIso(rtd, m), months: m };
  }

  // 3. New sale: start_date (else the quote's date) + one term.
  if (termMonths == null) return null;
  const from = isoOf(line.start_date) ?? isoOf(ctx.startFallback);
  if (!from) return null;
  return { from, to: addDaysIso(addMonthsIso(from, termMonths), -1), months: termMonths };
}

/** "2026-10-27" → "27/10/2026". A calendar date — no timezone shift. */
export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** 1 → "1 Month", 3 → "3 Months", 12 → "1 Year", 24 → "2 Years", 18 → "18 Months". */
export function termWords(months: number): string {
  if (months % 12 === 0) return months === 12 ? "1 Year" : `${months / 12} Years`;
  return months === 1 ? "1 Month" : `${months} Months`;
}

/** "Subscription period: 1 Year (27/10/2026 – 26/10/2027)", or null when not certain. */
export function linePeriodText(line: LinePeriodLine, ctx: LinePeriodContext): string | null {
  const p = lineServicePeriod(line, ctx);
  if (!p) return null;
  const dates = `${ddmmyyyy(p.from)} – ${ddmmyyyy(p.to)}`;
  return p.months ? `Subscription period: ${termWords(p.months)} (${dates})` : `Subscription period: ${dates}`;
}

/** "Domain: x.in" on a subscription line, when the domain is known. A bulk line lists its
 *  domains already ("Covering N domains"), so it gets none. */
export function lineDomainText(line: LinePeriodLine, ctx: LinePeriodContext): string | null {
  if (!isTermLine(line)) return null;
  if (line.bulk && (line.domains?.length ?? 0) > 0) return null;
  const d = ((line.domain ?? "").trim() || (ctx.domain ?? "").trim()).toLowerCase();
  if (!d) return null;
  // The name or detail already says it (lineDomainNote's rule): once is enough.
  if (`${line.name ?? ""} ${line.description ?? ""}`.toLowerCase().includes(d)) return null;
  return `Domain: ${d}`;
}

/** What goes under a line's name: Domain, then Subscription period — each only when known. */
export function lineSubscriptionNotes(line: LinePeriodLine, ctx: LinePeriodContext | null | undefined): string[] {
  if (!ctx) return [];
  return [lineDomainText(line, ctx), linePeriodText(line, ctx)].filter((s): s is string => !!s);
}

/** The domain of the subscription a renewal / extension quote renews: the one named by
 *  quotes.renewal_subscription_id (R-1574), else the one whose renewal_quote_id is this quote. */
export function renewedSubscriptionDomain(
  q: { id: string; renewal_subscription_id?: string | null },
  subs: ReadonlyArray<{ id: string; renewal_quote_id?: string | null; domain?: string | null }> | null | undefined,
): string | null {
  const list = subs ?? [];
  const sub = (q.renewal_subscription_id ? list.find((s) => s.id === q.renewal_subscription_id) : undefined)
    ?? list.find((s) => s.renewal_quote_id === q.id);
  return (sub?.domain ?? "").trim() || null;
}

/** The context from a stored quote row (snake_case). `subscriptionDomain`: the renewed
 *  subscription's domain, for a quote that stores none (renewal quotes do not). */
export function quoteLinePeriodContext(
  q: {
    is_renewal?: boolean | null; is_extension?: boolean | null; is_add_seats?: boolean | null;
    is_one_off?: boolean | null; extension_months?: number | null;
    renewal_term_date?: string | null; created_date?: string | null; domain?: string | null;
  },
  subscriptionDomain?: string | null,
): LinePeriodContext {
  return {
    isRenewal: q.is_renewal, isExtension: q.is_extension, isAddSeats: q.is_add_seats,
    isOneOff: q.is_one_off, extensionMonths: q.extension_months,
    renewalTermDate: q.renewal_term_date ?? null,
    startFallback: q.created_date ?? null,
    domain: (q.domain ?? "").trim() || (subscriptionDomain ?? "").trim() || null,
  };
}
