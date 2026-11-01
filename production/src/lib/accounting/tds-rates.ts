/**
 * TDS on a payment we make (26Q) — the default rate per section, so the amount fills itself
 * the moment a section is picked instead of sitting at ₹0.
 *
 * Rates for a resident payee with PAN, as they stand for FY 2026-27. Where a section has two
 * rates, the default is the common case for this business and the other is said beside it —
 * the operator can overwrite the amount, and the CA has the last word:
 *   194C contractor 2% (individual / HUF 1%) · 194J(a) technical services 2% · 194J(b)
 *   professional fees 10% · 194J royalty (software licence) 10% (R-2338; old rows say plain 194J = (b))
 *   194I rent of land / building 10% (plant & machinery 2%) · 194H commission 2% (since
 *   1 Oct 2024) · 194A interest 10% · 194Q purchase of goods 0.1% (on the part above ₹50L).
 *
 * TDS is on the value BEFORE GST when GST is shown separately on the bill (CBDT Circular
 * 23/2017) — so the base is the amount less the GST entered.
 */

export interface TdsSectionRate {
  section: string; ratePct: number; note: string | null;
  /** R-2338: what the picker says, in the CA's words ("194J(a) Technical services"). */
  label?: string;
  /** R-2338: the Income-tax Act 2025 number (s.393(1) Table) — a label only, never a rule. */
  act2025?: string | null;
  /** R-2338: an old code kept so stored rows still work — never offered in a picker. */
  legacy?: boolean;
}

export const TDS_SECTION_RATES: Readonly<Record<string, TdsSectionRate>> = {
  "194C":  { section: "194C",  ratePct: 2,   note: "1% if the contractor is an individual / HUF.", label: "194C Contractor", act2025: "s.393(1) Sl. 6(i)" },
  /* R-2338 (1 Nov 2026, owner + CA): 194J split three ways — the section the CA used in Zoho.
     The three share ONE yearly threshold for a vendor (tdsThresholdSection). */
  "194JA": { section: "194JA", ratePct: 2,   note: null, label: "194J(a) Technical services", act2025: "s.393(1) Sl. 6(iii)(a)" },
  "194JB": { section: "194JB", ratePct: 10,  note: null, label: "194J(b) Professional fees", act2025: "s.393(1) Sl. 6(iii)(b)" },
  "194JR": { section: "194JR", ratePct: 10,  note: null, label: "194J Royalty – software licence", act2025: "s.393(1) Sl. 6(iii)(d)" },
  /* Before R-2338 every 194J row was stored as plain "194J" — it keeps working and reads as
     professional fees 10% (no data rewrite); the pickers offer the three above instead. */
  "194J":  { section: "194J",  ratePct: 10,  note: "2% for technical services (not professional).", label: "194J(b) Professional fees", act2025: "s.393(1) Sl. 6(iii)(b)", legacy: true },
  "194I":  { section: "194I",  ratePct: 10,  note: "2% for rent of plant / machinery.", label: "194I Rent" },
  "194H":  { section: "194H",  ratePct: 2,   note: null, label: "194H Commission / brokerage", act2025: "s.393(1) Sl. 1(ii)" },
  "194A":  { section: "194A",  ratePct: 10,  note: null, label: "194A Interest" },
  "194Q":  { section: "194Q",  ratePct: 0.1, note: "Applies only to yearly purchases above ₹50 lakh.", label: "194Q Purchase of goods", act2025: "s.393(1) Sl. 8(ii)" },
};

/** R-2338: the sections a TDS picker offers (the old plain 194J is not one of them). */
export const TDS_PICK_SECTIONS: readonly string[] = Object.keys(TDS_SECTION_RATES).filter((k) => !TDS_SECTION_RATES[k].legacy);

/** R-2338: a stored section as the picker shows it — old plain "194J" = 194J(b) professional. */
export function normalizeTdsSection(section: string | null | undefined): string {
  const s = (section ?? "").trim().toUpperCase();
  return s === "194J" ? "194JB" : s;
}

/** R-2338: one picker option — "194J(a) Technical services · 2% — s.393(1) Sl. 6(iii)(a)". */
export function tdsSectionOption(section: string): string {
  const r = TDS_SECTION_RATES[normalizeTdsSection(section)];
  if (!r) return section;
  return `${r.label ?? r.section} · ${r.ratePct}%${r.act2025 ? ` — ${r.act2025}` : ""}`;
}

/** R-2338: a section's short name in text ("194J(a) Technical services"); the code when unknown. */
export function tdsSectionName(section: string | null | undefined): string {
  const s = (section ?? "").trim().toUpperCase();
  return TDS_SECTION_RATES[s]?.label ?? s;
}

/** R-2338: the section whose threshold applies — the three 194J choices (and old 194J) share 194J's. */
export function tdsThresholdSection(section: string | null | undefined): string {
  const s = (section ?? "").trim().toUpperCase();
  return s.startsWith("194J") ? "194J" : s;
}

/** R-2338: do two sections count towards the same yearly threshold for one vendor? */
export function sameTdsThreshold(a: string | null | undefined, b: string | null | undefined): boolean {
  return tdsThresholdSection(a) === tdsThresholdSection(b);
}

/** R-2338: the section as the 26Q working shows it — 194J's sub-section: (a) technical services,
 *  (b) professional fees / royalty (the return's 94J-A / 94J-B). Old plain 194J = (b). */
export function tds26qSection(section: string | null | undefined): string {
  const s = (section ?? "").trim().toUpperCase();
  if (s === "194JA") return "194J(a)";
  if (s === "194JB" || s === "194J") return "194J(b)";
  if (s === "194JR") return "194J(b) royalty";
  return s;
}

/** R-2338: offer "Remember for this vendor" (never ticked by itself) when the picked section is
 *  not already the vendor's saved one. Nothing picked → nothing to remember. */
export function rememberTdsOffer(vendorDefault: string | null | undefined, picked: string | null | undefined): boolean {
  const p = normalizeTdsSection(picked);
  return p !== "" && normalizeTdsSection(vendorDefault) !== p;
}

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
