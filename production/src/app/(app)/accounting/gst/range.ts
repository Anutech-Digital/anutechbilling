/**
 * R-257 (7 Oct 2026): which date range the GST page opens on, and the link the
 * Accounting Overview "GST to pay" tile uses so the page headline equals the tile.
 *
 * The tile's figure is `report_balance_sheet`'s gstPayable: CUMULATIVE output − input −
 * GST paid, for everything dated on or before today (migration 20261006140000 — "GST
 * CUMULATIVE (≤ as_of)"). It was labelled "GST due · FY 2026-27" and linked to plain
 * /accounting/gst, which opened on the current month (6 Oct = an empty October) — two
 * different numbers. The calculation is untouched; the tile now links to the same span
 * the figure covers ("All to date", from the day GST began) and the page reads it.
 *
 * Default when no range is given: on the 1st–20th the return being filed is LAST month's
 * (GSTR-3B is due on the 20th), so that is what opens; from the 21st, this month.
 */
import { gstLastMonth, gstThisMonth, type GstPeriod } from "@/lib/gst/periods";
import { istParts, istToday } from "@/lib/dates/ist";

/** GST began in India on 1 July 2017 — nothing taxable under it is dated earlier. */
export const GST_START = "2017-07-01";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The range the page opens on when the URL names none. */
export function gstDefaultRange(now: Date = new Date()): GstPeriod {
  return istParts(now).day <= 20 ? gstLastMonth(now) : gstThisMonth(now);
}

/** The current Indian financial year, April → March (to its 31 March, not today). */
export function gstThisFy(now: Date = new Date()): GstPeriod {
  const { year, month } = istParts(now);
  const start = month < 4 ? year - 1 : year;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}` };
}

/** Everything since GST began up to today — the span the Overview tile's figure covers. */
export function gstAllToDate(now: Date = new Date()): GstPeriod {
  return { from: GST_START, to: istToday(now), label: "All to date" };
}

/** The GST page opened on "All to date" (the cumulative span the Balance Sheet GST line covers). */
export function gstAllToDateHref(now: Date = new Date()): string {
  return gstRangeHref(gstAllToDate(now));
}

/**
 * The range from `?from=&to=`. A missing, malformed or backwards pair falls back to the
 * default — a bad link must never open the page on a nonsense span. A pair that matches a
 * named range keeps that range's label, so the quick-range chip lights up.
 */
export function gstRangeFromParams(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date = new Date(),
): GstPeriod {
  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return gstDefaultRange(now);
  const named = [gstAllToDate(now), gstThisFy(now), gstThisMonth(now), gstLastMonth(now)].find((r) => r.from === from && r.to === to);
  return named ?? { from, to, label: `${from} to ${to}` };
}

/**
 * R-394: a link that opens the GST page on exactly `r`. The Overview "GST cash to pay" tile
 * uses it with `gstDefaultRange()` — the span its number covers — so a click across the
 * day-20 switch, or at midnight, still lands on the month the tile showed.
 */
export function gstRangeHref(r: Pick<GstPeriod, "from" | "to">): string {
  return `/accounting/gst?from=${r.from}&to=${r.to}`;
}
