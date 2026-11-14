/**
 * R-2746 — the small "Renewal · 13 Nov 2026 – 12 Nov 2027" label above a renewal (or extension)
 * quote's lines, so the reader sees WHICH period the quote buys before reading the lines.
 *
 * One fact, one place: the dates are the lines' own period — lineServicePeriod with the quote's
 * LinePeriodContext (R-1764, billing's next-term start since R-2727) — never recomputed here. The
 * label shows only when EVERY subscription line of the quote has a known period and they are all
 * the same; otherwise (an old renewal row without renewal_term_date, a line whose period is unknown
 * or in conflict, lines that disagree, a non-renewal quote) it says nothing. No date is better than
 * a wrong one (never today's date).
 *
 * Used by the quote preview (quote page, quotes list preview, builder preview), the quote page's and
 * the builder's line-items header, the customer accept page and the quote PDF — all say the same words.
 */
import { lineDateRange, lineServicePeriod, periodDate, type LinePeriodContext, type LinePeriodLine } from "./service-period";

export interface RenewalPeriodLabel {
  /** "Renewal" or "Extension" (create-extension-quote: the UI says "Extension", not "Renewal"). */
  word: "Renewal" | "Extension";
  from: string;
  to: string;
  /** "Renewal · 13 Nov 2026 – 12 Nov 2027" */
  text: string;
}

/** A subscription (renewing) line — service-period's isTermLine rule (quote_line_is_subscription). */
function isSubscriptionLine(line: LinePeriodLine): boolean {
  if (line.one_time === true) return false;
  if (lineDateRange(line.name)) return true;
  const c = (line.commitment ?? "").trim().toLowerCase();
  return c !== "" && c !== "one_time";
}

/** The renewal period every subscription line of the quote covers, or null when it is not one
 *  certain period (or the quote is not a renewal / extension). */
export function renewalPeriodLabel(
  lines: readonly LinePeriodLine[] | null | undefined,
  ctx: LinePeriodContext | null | undefined,
): RenewalPeriodLabel | null {
  if (!ctx || (ctx.isRenewal !== true && ctx.isExtension !== true)) return null;
  const periods = (lines ?? []).filter(isSubscriptionLine).map((l) => lineServicePeriod(l, ctx));
  if (periods.length === 0) return null;
  const first = periods[0];
  if (!first || periods.some((p) => !p || p.from !== first.from || p.to !== first.to)) return null;
  const word = ctx.isExtension === true ? "Extension" : "Renewal";
  return { word, from: first.from, to: first.to, text: `${word} · ${periodDate(first.from)} – ${periodDate(first.to)}` };
}

/**
 * R-2746 (doneWhen 4): the editor's read-only "Starts" on a renewal line only repeats the label's
 * start. A label exists only when every subscription line starts on label.from (renewalLineStart
 * reads the same lineServicePeriod), and a one-time line's fixed Starts is "—" — so with a label the
 * fixed Starts adds nothing and is hidden. No label (unknown / conflicting period) → Starts stays as
 * R-2727 made it, "—" included, so a line with no known period still says so.
 */
export function lineStartsAddsInfo(
  lineStart: { kind: "fixed"; date: string | null } | { kind: "editable" },
  label: RenewalPeriodLabel | null,
): boolean {
  return lineStart.kind !== "fixed" || !label;
}
