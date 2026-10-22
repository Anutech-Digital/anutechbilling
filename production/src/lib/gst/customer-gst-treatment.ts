/**
 * R-1736 (22 Oct 2026) — a customer's GST treatment, Zoho Books style.
 *
 * Before this the app guessed silently: GSTIN → registered, none → unregistered/consumer,
 * country not India → export. There was no way to say "this customer is an SEZ unit", so
 * a Delhi SEZ customer of a Delhi seller was billed CGST+SGST — wrong: a supply to an SEZ
 * is always inter-state (IGST Act §7(5)(b)).
 *
 * The stored value is customers.gst_treatment (migration ..._r1736_customer_gst_treatment).
 * The database fills it with the SAME rule as suggestGstTreatment() below when a path
 * inserts a customer without one (lead conversion, imports), so it is never null.
 *
 * The TAX rule (SEZ → IGST) lives in ONE place: place-of-supply.ts
 * (treatmentIsAlwaysInterState). This file is the words, the auto-pick and the PAN.
 *
 * LUT (needsDecision, Hitesh): SEZ without payment and exports are zero-rated only under a
 * valid LUT. Until Hitesh confirms the rule, sez_without_payment is taxed like
 * sez_with_payment (IGST at the normal rate) and overseas keeps today's export behaviour
 * (0% with the "no LUT number saved" warning, lib/gst/export-lut.ts). See
 * LUT_ZERO_RATING_PENDING.
 */
import { isValidGstin } from "@/lib/utils";

export const CUSTOMER_GST_TREATMENTS = [
  "registered_regular",
  "registered_composition",
  "unregistered_business",
  "consumer",
  "overseas",
  "sez_with_payment",
  "sez_without_payment",
  "deemed_export",
] as const;

export type CustomerGstTreatment = (typeof CUSTOMER_GST_TREATMENTS)[number];

/** TODO(R-1736, Hitesh): zero-rate sez_without_payment / overseas only under a valid LUT. */
export const LUT_ZERO_RATING_PENDING = true;

export function isCustomerGstTreatment(v: unknown): v is CustomerGstTreatment {
  return typeof v === "string" && (CUSTOMER_GST_TREATMENTS as readonly string[]).includes(v);
}

export interface GstTreatmentOption {
  value: CustomerGstTreatment;
  label: string;
  /** One line under the select: what the treatment means for the invoice. */
  meaning: string;
}

/** Zoho Books names, in Zoho's order. */
export const GST_TREATMENT_OPTIONS: readonly GstTreatmentOption[] = [
  { value: "registered_regular",     label: "Registered Business – Regular",     meaning: "Has a GSTIN under the regular scheme. GST is charged by state: CGST + SGST in your state, IGST outside it." },
  { value: "registered_composition", label: "Registered Business – Composition", meaning: "Has a GSTIN under the Composition Scheme. GST is charged as usual; they cannot claim input credit." },
  { value: "unregistered_business",  label: "Unregistered Business",             meaning: "A business with no GSTIN. GST is charged by state." },
  { value: "consumer",               label: "Consumer",                          meaning: "A person buying for their own use, with no GSTIN. GST is charged by state." },
  { value: "overseas",               label: "Overseas",                          meaning: "Outside India — the supply is an export (no Indian GST when your LUT is on file)." },
  { value: "sez_with_payment",       label: "SEZ (with payment)",                meaning: "An SEZ unit or developer. Always IGST, even in your own state." },
  { value: "sez_without_payment",    label: "SEZ (without payment)",             meaning: "An SEZ unit or developer supplied under LUT. Charged IGST for now — zero-rating under LUT is not set up yet." },
  { value: "deemed_export",          label: "Deemed Export",                     meaning: "Supply to an EOU or against an Advance Authorisation. GST is charged by state; the buyer claims the refund." },
] as const;

export function gstTreatmentOption(v: string | null | undefined): GstTreatmentOption | undefined {
  return GST_TREATMENT_OPTIONS.find((o) => o.value === v);
}

const DOMESTIC = new Set(["india", "in", "ind", "bharat"]);
/** Empty country = India, the same conservative reading as isExportSupply(). */
function outsideIndia(country: string | null | undefined): boolean {
  const c = (country ?? "").trim().toLowerCase();
  return c !== "" && !DOMESTIC.has(c);
}

/**
 * The treatment the facts point to. The SAME rule backfills existing customers and fills a
 * customer inserted without one (SQL: public.customer_gst_treatment_default).
 *
 * @example suggestGstTreatment({ country: "India", gstin: "07AAACR5055K1Z9", customerType: "business" }) // "registered_regular"
 */
export function suggestGstTreatment(a: {
  country: string | null | undefined;
  gstin: string | null | undefined;
  customerType: string | null | undefined;
}): CustomerGstTreatment {
  if (outsideIndia(a.country)) return "overseas";
  if ((a.gstin ?? "").trim() !== "") return "registered_regular";
  return a.customerType === "individual" ? "consumer" : "unregistered_business";
}

/**
 * The form's select: it follows the suggestion until the user picks one by hand. A hand
 * pick survives typing a GSTIN (SEZ units have one), but not a move across the border —
 * an Indian treatment on a foreign customer, or Overseas on an Indian one, is never right.
 */
export function nextGstTreatment(a: {
  current: CustomerGstTreatment | null | undefined;
  manual: boolean;
  suggestion: CustomerGstTreatment;
}): CustomerGstTreatment {
  if (!a.manual || !a.current) return a.suggestion;
  const crossed = (a.current === "overseas") !== (a.suggestion === "overseas");
  return crossed ? a.suggestion : a.current;
}

const NEEDS_GSTIN = new Set<CustomerGstTreatment>([
  "registered_regular", "registered_composition", "sez_with_payment", "sez_without_payment", "deemed_export",
]);

/** Why this treatment cannot be saved with these facts, or null when it can. */
export function gstTreatmentProblem(a: {
  treatment: string | null | undefined;
  country: string | null | undefined;
  gstin: string | null | undefined;
}): string | null {
  if (!isCustomerGstTreatment(a.treatment)) return "Pick a GST treatment";
  const foreign = outsideIndia(a.country);
  if (a.treatment === "overseas" && !foreign) return "Overseas is only for a customer outside India — change the country or the treatment";
  if (a.treatment !== "overseas" && foreign) return "A customer outside India is Overseas";
  if (NEEDS_GSTIN.has(a.treatment) && (a.gstin ?? "").trim() === "") {
    return `${gstTreatmentOption(a.treatment)?.label ?? "This treatment"} needs the customer's GSTIN`;
  }
  return null;
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function isValidPan(pan: string | null | undefined): boolean {
  return PAN_RE.test((pan ?? "").trim().toUpperCase());
}

/**
 * Characters 3–12 of a GSTIN are the holder's PAN. Only a checksum-valid GSTIN is read, so
 * a typo never invents a PAN (the TDS / 26AS match depends on it).
 *
 * @example panFromGstin("07AAACR5055K1Z9") // "AAACR5055K"
 */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (g.length !== 15 || !isValidGstin(g)) return null;
  const pan = g.slice(2, 12);
  return PAN_RE.test(pan) ? pan : null;
}
