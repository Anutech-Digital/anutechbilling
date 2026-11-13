/**
 * R-2746 — the small "Renewal · 13 Nov 2026 – 12 Nov 2027" label above a renewal (or extension)
 * quote's lines, so the reader sees WHICH period the quote buys before reading the lines.
 *
 * One fact, one place: the dates are the lines' own period — lineServicePeriod with the quote's
 * LinePeriodContext (R-1764, billing's next-term start since R-2727) — never recomputed here. The
 * label shows only when every subscription line of the quote names the SAME period; otherwise
 * (no period known — an old renewal row without renewal_term_date, lines that disagree, a
 * non-renewal quote) it says nothing. No date is better than a wrong one (never today's date).
 *
 * Used by the quote preview (quote page, quotes list preview, builder preview), the builder's line
 * card, the customer accept page and the quote PDF — all say the same words.
 */
import { lineServicePeriod, periodDate, type LinePeriodContext, type LinePeriodLine, type LinePeriod } from "./service-period";

export interface RenewalPeriodLabel {
  /** "Renewal" or "Extension" (create-extension-quote: the UI says "Extension", not "Renewal"). */
  word: "Renewal" | "Extension";
  from: string;
  to: string;
  /** "Renewal · 13 Nov 2026 – 12 Nov 2027" */
  text: string;
}

/** The renewal period every subscription line of the quote covers, or null when it is not one
 *  certain period (or the quote is not a renewal / extension). */
export function renewalPeriodLabel(
  lines: readonly LinePeriodLine[] | null | undefined,
  ctx: LinePeriodContext | null | undefined,
): RenewalPeriodLabel | null {
  if (!ctx || (ctx.isRenewal !== true && ctx.isExtension !== true)) return null;
  const periods = (lines ?? [])
    .map((l) => lineServicePeriod(l, ctx))
    .filter((p): p is LinePeriod => p != null);
  if (periods.length === 0) return null;
  const { from, to } = periods[0];
  if (periods.some((p) => p.from !== from || p.to !== to)) return null;
  const word = ctx.isExtension === true ? "Extension" : "Renewal";
  return { word, from, to, text: `${word} · ${periodDate(from)} – ${periodDate(to)}` };
}

/**
 * R-2746 (doneWhen 4): the editor's read-only "Starts" on a renewal line repeats the label's start.
 * Show it only when it adds something — the line's fixed start differs from the label's. No label
 * → keep Starts as R-2727 made it.
 */
export function lineStartsAddsInfo(
  lineStart: { kind: "fixed"; date: string | null } | { kind: "editable" },
  label: RenewalPeriodLabel | null,
): boolean {
  if (lineStart.kind !== "fixed" || !label) return true;
  return lineStart.date != null && lineStart.date !== label.from;
}
