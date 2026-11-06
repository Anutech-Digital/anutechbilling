/**
 * R-1742 — the SEZ endorsement an invoice to an SEZ unit / developer must carry (CGST Rule 46,
 * proviso). Same pattern as the export LUT endorsement (export-lut.ts): WORDS only, never a
 * tax amount. The treatment comes from invoices.gst_treatment, frozen at issue (R-1736).
 *
 * Which line prints follows the tax ACTUALLY charged on the invoice — the same rule GSTR-1
 * uses for SEWP / SEWOP (gstr1.ts b2bInvType). Since R-2515 an "SEZ without payment" sale is
 * billed at 0% under the LUT, but an older invoice of such a customer may carry IGST — then it
 * says "on payment of integrated tax": the document must never claim no tax next to IGST.
 */
import { treatmentIsAlwaysInterState } from "./place-of-supply";

export const SEZ_WITH_PAYMENT_ENDORSEMENT =
  "SUPPLY MEANT FOR SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX";

export const SEZ_WITHOUT_PAYMENT_ENDORSEMENT =
  "SUPPLY MEANT FOR SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";

/** What the invoice prints under the totals, or null (not a supply to an SEZ). The LUT ARN
 *  appears only on the without-payment line, and only when the seller has one saved. */
export function sezEndorsement(args: {
  treatment: string | null | undefined;
  tax: number;
  lutNumber?: string | null;
}): { text: string; lutArn: string | null } | null {
  if (!treatmentIsAlwaysInterState(args.treatment)) return null;
  if (args.tax !== 0) return { text: SEZ_WITH_PAYMENT_ENDORSEMENT, lutArn: null };
  const lut = (args.lutNumber ?? "").trim();
  return { text: SEZ_WITHOUT_PAYMENT_ENDORSEMENT, lutArn: lut || null };
}
