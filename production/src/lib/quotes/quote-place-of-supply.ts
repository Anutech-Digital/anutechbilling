import { isExportSupply, isInterStateSupply, placeOfSupplyLabel } from "@/lib/gst/place-of-supply";
import { resolveStateCode } from "@/lib/gst/gstin-state";

/**
 * Where a QUOTE is supplied to, and the line that names it (R-376 f, 7 Oct 2026).
 *
 * The AI flow test (Q-FBB9-27-0010) found the preview and the emailed PDF printing
 * "Inter-state (IGST applies)" with no state — or, for a quote raised on a LEAD, the PDF
 * computed the head from the customer alone and, finding none, printed "Intra-state" for
 * a Haryana buyer of a Delhi seller. CGST Rule 46(n) wants the state NAME and CODE.
 *
 * The buyer is whoever the quote is for, in this order — the same order record_payment
 * uses when it creates the customer on payment:
 *   1. the picked customer,
 *   2. else the lead the quote was raised on (its state / GSTIN),
 *   3. else the typed-prospect state saved on the quote (prospect_state_code).
 * Within that party an entered state code wins over the one its GSTIN proves.
 *
 * @example
 * quotePlaceOfSupply({ lead: { state_code: "06" }, seller: { state_code: "07" } }).label
 * // "Haryana (06) · IGST"
 */
export interface BuyerPlace {
  state_code?: string | null;
  gstin?: string | null;
  country?: string | null;
}

export interface QuotePlace {
  /** Two-digit GST state code of the buyer, or null when nobody knows it. */
  posCode: string | null;
  interState: boolean;
  isExport: boolean;
  /** "Haryana (06) · IGST", "Delhi (07) · CGST + SGST", or the old wording when no state is known. */
  label: string;
}

export function quotePlaceOfSupply(a: {
  customer?: BuyerPlace | null;
  lead?: BuyerPlace | null;
  quote?: { prospect_state_code?: string | null; prospect_country?: string | null } | null;
  seller: { state_code?: string | null; gstin?: string | null };
}): QuotePlace {
  const buyer: BuyerPlace | null =
    a.customer
      ? a.customer
      : a.lead
        ? a.lead
        : a.quote
          ? { state_code: a.quote.prospect_state_code ?? null, country: a.quote.prospect_country ?? null }
          : null;
  const isExport = isExportSupply(buyer?.country);
  const raw = isExport ? null : resolveStateCode({ stateCode: buyer?.state_code, gstin: buyer?.gstin });
  // A hand-typed "6" is Haryana too — pad so the name lookup finds it.
  const posCode = raw && /^\d{1,2}$/.test(raw) ? raw.padStart(2, "0") : raw;
  const interState = !isExport && isInterStateSupply(posCode, a.seller.state_code, { sellerGstin: a.seller.gstin });
  return {
    posCode,
    interState,
    isExport,
    label: placeOfSupplyLabel({ posCode, interState, isExport, country: buyer?.country }),
  };
}

/**
 * R-389 (F9) — the tax head named the way the invoice will split it.
 *
 * The Add-seats dialog and its pro-rata quote said "GST 18%" for an inter-state customer,
 * where the invoice charges IGST 18%; an intra-state one is CGST 9% + SGST 9%.
 *
 * @example gstHeadLabel({ ratePct: 18, interState: true })  // "IGST 18%"
 * @example gstHeadLabel({ ratePct: 18, interState: false }) // "CGST 9% + SGST 9%"
 */
export function gstHeadLabel(a: { ratePct: number; interState: boolean; isExport?: boolean }): string {
  if (a.isExport) return "GST 0% (export)";
  if (a.ratePct <= 0) return "GST 0%";
  if (a.interState) return `IGST ${a.ratePct}%`;
  const half = a.ratePct / 2;
  return `CGST ${half}% + SGST ${half}%`;
}
