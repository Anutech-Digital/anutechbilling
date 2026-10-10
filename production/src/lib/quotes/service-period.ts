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
