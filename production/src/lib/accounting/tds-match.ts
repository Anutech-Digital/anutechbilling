/**
 * R-1520 — "is the rupees still due exactly the TDS the customer withheld?"
 *
 * Pardeep, staging 17 Oct (INV-A378-27-0001): invoice ₹3,00,900, customer paid ₹2,75,400.
 * The ₹25,500 left was exactly 10% TDS (194J) on the pre-GST ₹2,55,000, but nobody ticked
 * "Customer deducted TDS", so the invoice stayed Partial with a wrong outstanding.
 *
 * Pure suggestion maths, shared by the Record payment sheet, the invoice page and the
 * collections list. It never records anything — the caller only shows a hint and, on a
 * click, prefills the existing TDS fields. The base is `tdsBase` (GST stripped at the
 * invoice's own rate, R-1119) and the rates are the common ones in TDS_SECTIONS
 * (tds-split.ts: 194J 10% / 2%, 194C 2% / 1%), so no second formula exists.
 */
import { tdsBase } from "./tds-receipt";
import { TDS_SECTIONS } from "./tds-split";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export interface TdsShortfallMatch {
  section: string;
  ratePct: number;
  /** base × rate, whole rupees — what would be recorded as TDS. */
  tds: number;
  /** Pre-GST value the TDS is taken on. */
  base: number;
  /** total − received, as passed in. */
  shortfall: number;
}

export interface TdsShortfallInput {
  /** The invoice / quote total, GST included. */
  totalInclGst: number;
  /** Everything settled so far, including the amount being entered now. */
  received: number;
  /** The invoice's own GST rate; null → 18% (same fallback as tdsBase). */
  gstRatePct: number | null | undefined;
  /** The customer's usual section — wins when its rate also fits (e.g. 194C at 2%). */
  preferredSection?: string | null;
}

/** ±₹1: the customer rounds the TDS their own way. */
const TOLERANCE = 1;

/**
 * The common TDS the shortfall equals, or null. Null when nothing was received yet (an
 * unpaid invoice is not a TDS case), when nothing is short, or when the gap fits no rate.
 */
export function matchTdsShortfall(i: TdsShortfallInput): TdsShortfallMatch | null {
  const total = Math.round(i.totalInclGst || 0);
  const received = Math.round(i.received || 0);
  const shortfall = total - received;
  if (total <= 0 || received <= 0 || shortfall <= 0) return null;
  const base = tdsBase(total, i.gstRatePct);
  if (base <= 0) return null;

  const fits = TDS_SECTIONS
    .map((s) => ({ section: s.section, ratePct: s.ratePct, tds: Math.round((base * s.ratePct) / 100) }))
    .filter((c) => c.tds > 0 && Math.abs(shortfall - c.tds) <= TOLERANCE);
  if (fits.length === 0) return null;

  const pref = (i.preferredSection ?? "").trim().toUpperCase();
  const pick = fits.find((c) => c.section === pref) ?? fits[0];
  return { ...pick, base, shortfall };
}

/** "Baaki ₹25,500 shayad TDS hai (194J 10%)" — the one wording both screens use. */
export function tdsShortfallLine(m: TdsShortfallMatch): string {
  return `Baaki ${inr(m.shortfall)} shayad TDS hai (${m.section} ${m.ratePct}%)`;
}
