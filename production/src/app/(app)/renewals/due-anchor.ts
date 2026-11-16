/**
 * R-2817 (Renewals 12-question audit 14 Nov, Q2 "one day count"): the Due column shows the row's ONE
 * anchor (lib/renewals/stage.ts rowAnchor) — the same date and day count as the chip. Greentin Check
 * reads "1 Oct 26 · 44d ago" (its part due 1 Oct), no longer its renewal date "31 Oct 26 · 14d ago"
 * next to a chip saying "Overdue 44d". The tooltip names both dates. Before the stage is read (the
 * documents still loading) it is the renewal date with its own IST day count — never a guessed part date.
 * Pure — tested in lib/renewals/stage-anchor-r2817.test.ts.
 */
import { formatDate } from "@/lib/utils";
import type { RenewalStage } from "@/lib/renewals/stage";
import { termEndInclusive } from "@/lib/billing/schedule";
import { addDaysIso, addMonthsIso, isoDateOf } from "@/lib/quotes/service-period";
import { periodWords, type DocPart, type LastDocs } from "./last-docs";
import { renewalTermStart } from "./stage-input";

export interface DueFacts {
  /** The date the Due column shows (YYYY-MM-DD); null = no date. */
  date: string | null;
  /** IST days to it — the chip's own count; null = no date. */
  days: number | null;
  /** The tooltip: "Part due 1 Oct 2026 · renews 31 Oct 2026" / "Renews 12 Nov 2026 · part due 14 Nov 2026". */
  title: string | null;
}

export function dueCellFacts(
  stage: Pick<RenewalStage, "anchorDate" | "anchorKind" | "days" | "partDueDate"> | null,
  sub: { renewal_date: string | null },
  daysUntil: number,
): DueFacts {
  const renews = sub.renewal_date ? formatDate(sub.renewal_date) : null;
  if (!stage || !stage.anchorDate) {
    return sub.renewal_date ? { date: sub.renewal_date.slice(0, 10), days: daysUntil, title: `Renews ${renews}` } : { date: null, days: null, title: null };
  }
  const title = stage.anchorKind === "part"
    ? [`Part due ${formatDate(stage.anchorDate)}`, renews ? `renews ${renews}` : null].filter(Boolean).join(" · ")
    : [`Renews ${formatDate(stage.anchorDate)}`, stage.partDueDate ? `part due ${formatDate(stage.partDueDate)}` : null].filter(Boolean).join(" · ");
  return { date: stage.anchorDate, days: stage.days, title };
}

/**
 * R-2858 (Pardeep, 16 Nov 2026 — staging Chrome test): the Due column's day count as ONE number — the
 * tab is picked by it too (classify.ts `dueDays`, queue-items.ts), so a row that reads "Overdue 5d · part
 * due 11 Nov" can no longer sit under "≤7 days" because its renewal date is today. While the stage is not
 * read yet it is the renewal date's count (the Due column shows that, too).
 */
export function dueDaysOf(
  stage: Pick<RenewalStage, "anchorDate" | "days"> | null,
  daysUntil: number,
): number {
  /* dueCellFacts' `days`, without building its tooltip words (once per row, before the rows are grouped) */
  return stage?.anchorDate ? stage.days ?? daysUntil : daysUntil;
}

/**
 * R-2858: the period the row is ABOUT — the Product line's period. Before, it was always the next term
 * counted from renewal_date, so Ravi Shankar read "Due 1 Oct · Overdue 46d · part due 1 Oct" next to
 * "1 Nov 26 – 30 Nov 26", and Supreme Media's quote covered 3 Oct – 2 Nov while the row said 3 Nov – 2 Dec:
 * nobody could tell which month is unpaid.
 *
 *   source "part"  the stored period of the part the stage is about — the part proforma / part invoice the
 *                  chip and the Due date count from (subscription_billings period, the paper's own);
 *   source "term"  no part document → the next term from the renewal date, as before.
 * `running`: that unpaid part's period is over and a later one has started — "Oct unpaid · Nov running".
 */
export interface DuePeriod {
  /** Both ends inclusive, YYYY-MM-DD. */
  start: string;
  end: string;
  /** "Oct 2026" / "3 Oct 2026 – 2 Nov 2026" — the same words the quote / invoice line shows (last-docs.ts periodWords). */
  words: string;
  /** The table's short form: "1 Oct 26 – 31 Oct 26". */
  short: string;
  source: "part" | "term";
  running: string | null;
  /** The Product line's tooltip: "Renews for Nov 2026" / "Billed part Oct 2026" / "Oct unpaid · Nov running (billed part Oct 2026)". */
  title: string;
}

type PeriodSub = { renewal_date: string | null; term_months?: number | null; start_date?: string | null };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monOf = (iso: string) => MON[Number(iso.slice(5, 7)) - 1];
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${monOf(iso)} ${iso.slice(2, 4)}`;

/** "Oct" / "Oct – Dec" for whole calendar months, else "3 Oct – 2 Nov"; the year only when it is not today's. */
function shortPeriodLabel(start: string, end: string, todayIst: string): string {
  const yr = (iso: string) => (iso.slice(0, 4) === todayIst.slice(0, 4) ? "" : ` ${iso.slice(0, 4)}`);
  if (start.slice(8, 10) === "01" && addDaysIso(end, 1).slice(8, 10) === "01") {
    const a = `${monOf(start)}${yr(start)}`;
    const b = `${monOf(end)}${yr(end)}`;
    return a === b ? a : `${a} – ${b}`;
  }
  return `${Number(start.slice(8, 10))} ${monOf(start)}${yr(start)} – ${Number(end.slice(8, 10))} ${monOf(end)}${yr(end)}`;
}

/** The part of the same length that today falls in, counted on from an ended part; null = not a whole-month part. */
function partRunningNow(start: string, endExclusive: string, todayIst: string): { start: string; end: string } | null {
  let months = 0;
  for (let m = 1; m <= 12 && !months; m++) if (addMonthsIso(start, m) === endExclusive) months = m;
  if (!months) return null;
  for (let k = 1; k <= 240; k++) {
    const next = addMonthsIso(start, (k + 1) * months);
    if (todayIst < next) return { start: addMonthsIso(start, k * months), end: addDaysIso(next, -1) };
  }
  return null;
}

/** Stages whose document is with the customer and unpaid — only these say "<part> unpaid". */
const UNPAID_STAGE = new Set<RenewalStage["key"]>(["sent", "invoiced"]);

export function duePeriodFacts(
  stage: Pick<RenewalStage, "key" | "quoteId" | "invoiceId"> | null,
  docs: LastDocs | undefined,
  sub: PeriodSub,
  todayIst: string,
): DuePeriod | null {
  const part = stage && docs ? stagePart(stage, docs) : null;
  const start = isoDateOf(part?.start);
  const endExclusive = isoDateOf(part?.endExclusive);
  if (start && endExclusive && endExclusive > start) {
    const end = addDaysIso(endExclusive, -1);
    const today = todayIst.slice(0, 10);
    let running: string | null = null;
    if (stage && UNPAID_STAGE.has(stage.key) && today > end) {
      const now = partRunningNow(start, endExclusive, today);
      running = `${shortPeriodLabel(start, end, today)} unpaid · ${now ? `${shortPeriodLabel(now.start, now.end, today)} running` : "a later part is running"}`;
    }
    const words = periodWords(start, end);
    const title = running ? `${running} (billed part ${words})` : `Billed part ${words}`;
    return { start, end, words, short: `${shortDate(start)} – ${shortDate(end)}`, source: "part", running, title };
  }
  const termStart = renewalTermStart(sub);
  if (!termStart) return null;
  const months = sub.term_months && sub.term_months > 0 ? sub.term_months : 12;
  const termEnd = termEndInclusive(termStart, months);
  const termWords = periodWords(termStart, termEnd, months);
  return { start: termStart, end: termEnd, words: termWords, short: `${shortDate(termStart)} – ${shortDate(termEnd)}`, source: "term", running: null, title: `Renews for ${termWords}` };
}

/** The billed part of the document the stage is about: its part proforma (quoteId), else its part invoice. */
function stagePart(stage: Pick<RenewalStage, "quoteId" | "invoiceId">, docs: LastDocs): DocPart | null {
  if (stage.quoteId) {
    const q = docs.quote?.id === stage.quoteId ? docs.quote : docs.allQuotes?.find((x) => x.id === stage.quoteId);
    return q?.part ?? null;
  }
  if (!stage.invoiceId) return null;
  const all = [...docs.invoices, ...(docs.invoice ? [docs.invoice] : []), ...(docs.allInvoices ?? [])];
  return all.find((i) => i.id === stage.invoiceId)?.part ?? null;
}
