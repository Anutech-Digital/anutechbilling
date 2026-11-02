/**
 * R-2370 (2 Nov 2026): the TDS a CUSTOMER deducts from our receipts — set by hand on the
 * customer form (it used to change only as a side effect of recording a TDS receipt, so a
 * customer that deducts 194C @ 1% kept showing "194J @ 10%" and every receipt suggested it).
 *
 * Stored on customers.tds_default_section / tds_default_rate_pct; the receipt dialog
 * (record-payment-dialog) reads them to pre-fill "Customer deducted TDS". The sections are
 * the SAME list that dialog offers (TDS_SECTIONS, receivable side) — one list, never two.
 * Rates come from the one rate table (tds-rates.ts); the rate box stays editable.
 */
import { tdsDefaultRatePct } from "@/lib/accounting/tds-rates";

/** "" = the customer does not deduct TDS (both columns saved as null). */
export const CUSTOMER_TDS_NONE = "";

export interface CustomerTdsFormValue {
  /** A receivable TDS section ("194C"), or "" for none. */
  section: string;
  /** The rate box as typed ("1", "0.1"); "" when none. */
  ratePct: string;
}

/** What the form opens with for a saved customer. A rate with no section (old rows) reads
 *  as plain 194J — the receipt dialog's own fallback — so the screen shows what receipts do. */
export function customerTdsPrefill(c: {
  tds_default_section?: string | null; tds_default_rate_pct?: number | string | null;
} | null | undefined): CustomerTdsFormValue {
  const sec = (c?.tds_default_section ?? "").trim().toUpperCase();
  const rate = c?.tds_default_rate_pct;
  const hasRate = rate !== null && rate !== undefined && String(rate).trim() !== "";
  if (!sec && !hasRate) return { section: CUSTOMER_TDS_NONE, ratePct: "" };
  const section = sec || "194J";
  const ratePct = hasRate ? String(Number(rate)) : String(tdsDefaultRatePct(section) ?? "");
  return { section, ratePct };
}

/** A section picked → the rate box fills with that section's default (194C → 2). None → "". */
export function rateForPickedSection(section: string): string {
  if (!section) return "";
  const def = tdsDefaultRatePct(section);
  return def === null ? "" : String(def);
}

/** Problem with the typed rate, or null. Only checked when a section is picked. */
export function customerTdsRateProblem(v: CustomerTdsFormValue): string | null {
  if (!v.section) return null;
  const t = (v.ratePct ?? "").trim();
  if (!t) return "Enter the TDS rate (%) this customer deducts";
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return "TDS rate is a % between 0 and 100";
  return null;
}

/** The two columns to save. None → both null (the Overview then shows no TDS). */
export function customerTdsPayload(v: CustomerTdsFormValue): {
  tds_default_section: string | null; tds_default_rate_pct: number | null;
} {
  if (!v.section) return { tds_default_section: null, tds_default_rate_pct: null };
  const n = Number((v.ratePct ?? "").trim());
  return {
    tds_default_section: v.section.trim().toUpperCase(),
    tds_default_rate_pct: Number.isFinite(n) ? Math.round(n * 100) / 100 : null,
  };
}

/** The customer Overview's text for the saved values ("194C @ 1%"), null when none. */
export function customerTdsLabel(v: CustomerTdsFormValue): string | null {
  return v.section ? `${v.section} @ ${Number(v.ratePct)}%` : null;
}
