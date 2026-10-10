/**
 * TDS on a payment we make (26Q) — the default rate per section, so the amount fills itself
 * the moment a section is picked instead of sitting at ₹0.
 *
 * Rates for a resident payee with PAN, as they stand for FY 2026-27. Where a section has two
 * rates, the default is the common case for this business and the other is said beside it —
 * the operator can overwrite the amount, and the CA has the last word:
 *   194C contractor 2% (individual / HUF 1%) · 194J professional 10% (technical services 2%)
 *   194I rent of land / building 10% (plant & machinery 2%) · 194H commission 2% (since
 *   1 Oct 2024) · 194A interest 10% · 194Q purchase of goods 0.1% (on the part above ₹50L).
 *
 * TDS is on the value BEFORE GST when GST is shown separately on the bill (CBDT Circular
 * 23/2017) — so the base is the amount less the GST entered.
 */

export interface TdsSectionRate { section: string; ratePct: number; note: string | null }

export const TDS_SECTION_RATES: Readonly<Record<string, TdsSectionRate>> = {
  "194C": { section: "194C", ratePct: 2,   note: "Individual / HUF contractor ho to 1%." },
  "194J": { section: "194J", ratePct: 10,  note: "Technical services (professional nahi) ho to 2%." },
  "194I": { section: "194I", ratePct: 10,  note: "Plant / machinery ka kiraya ho to 2%." },
  "194H": { section: "194H", ratePct: 2,   note: null },
  "194A": { section: "194A", ratePct: 10,  note: null },
  "194Q": { section: "194Q", ratePct: 0.1, note: "Sirf ₹50 lakh se upar ki saal ki kharid par lagta hai." },
};

/** TDS base: the amount less the GST shown on the bill (never below 0). */
export function tdsBase(amount: number, gst: number): number {
  return Math.max(0, Math.round((amount || 0) - (gst || 0)));
}

/** The default TDS for a section on a base, whole rupees; null for an unknown section. */
export function defaultTds(section: string, base: number): number | null {
  const r = TDS_SECTION_RATES[section];
  if (!r) return null;
  return Math.round((Math.max(0, base) * r.ratePct) / 100);
}

/** R-523: the other lawful rate a section can carry, named in its `note` above — a
 *  194C individual / HUF contractor (1%), 194J technical services (2%), 194I plant /
 *  machinery rent (2%). A rate here is not wrong, only not the default, so it warns
 *  softly; any other rate warns firmly. Kept beside the table so the two never drift. */
export const TDS_RATE_VARIANTS: Readonly<Record<string, readonly { ratePct: number; when: string }[]>> = {
  "194C": [{ ratePct: 1, when: "an individual / HUF contractor" }],
  "194J": [{ ratePct: 2, when: "technical services (not professional fees)" }],
  "194I": [{ ratePct: 2, when: "rent of plant / machinery" }],
};

/** The section's default rate (%), or null for a section the table does not know. */
export function tdsDefaultRatePct(section: string | null | undefined): number | null {
  const r = TDS_SECTION_RATES[(section ?? "").trim().toUpperCase()];
  return r ? r.ratePct : null;
}

export interface TdsRateCheck {
  /** Rate equals the section default (or the section is unknown — nothing to compare). */
  matches: boolean;
  defaultPct: number | null;
  /** Not the default, but the section's other lawful rate. */
  knownVariant: boolean;
  /** One line for the form / report; null when the rate matches. */
  message: string | null;
}

/** Does the rate used fit the section? Never blocks — the operator can always override. */
export function checkTdsRate(section: string | null | undefined, ratePct: number | null | undefined): TdsRateCheck {
  const sec = (section ?? "").trim().toUpperCase();
  const def = tdsDefaultRatePct(sec);
  const rate = Number(ratePct ?? 0);
  if (def === null) return { matches: true, defaultPct: null, knownVariant: false, message: null };
  if (Math.abs(rate - def) < 0.005) return { matches: true, defaultPct: def, knownVariant: false, message: null };
  const variant = (TDS_RATE_VARIANTS[sec] ?? []).find((v) => Math.abs(v.ratePct - rate) < 0.005);
  const message = variant
    ? `${sec} is usually ${def}%. ${rate}% is right only for ${variant.when}.`
    : `${sec} is ${def}%, not ${rate}%. Check the section or the rate before saving.`;
  return { matches: false, defaultPct: def, knownVariant: !!variant, message };
}
