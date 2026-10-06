/**
 * Buy-now dialog form schema (moved out of buy-workspace-client.tsx so it can be tested).
 *
 * R-226 (6 Oct 2026): Pay had no terms / refund agreement, and nothing told the buyer the
 * Workspace licence is annual and cannot be cancelled mid-term (Google rule; refund policy
 * "Licences"). The box must be ticked before the order is created, so Razorpay never opens
 * without it — the same rule as /checkout's TermsCheckbox.
 */
import { z } from "zod";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { gstinProblem } from "@/site/lib/checkout-details";

export const BUY_TERMS_ERROR = "Tick the box to agree to the terms and refund policy before you pay";
export const BUY_ANNUAL_NOTE = "Annual plan — billed for 12 months; Google does not allow mid-term cancellation.";

export const buyNowSchema = z.object({
  fullName:    z.string().min(2, "Your name"),
  companyName: z.string().min(2, "Company name"),
  email:       z.string().email("Valid work email"),
  phone:       z.string().min(10, "10-digit phone"),
  seats:       z.coerce.number().int().min(1).max(10000),
  domain:      z.string().min(3, "Your business domain (e.g. acme.in)"),
  tierId:      z.string(),
  gstin:       z.string().optional(),
  couponCode:  z.string().optional(),
  stateCode:   z.string().optional(),
  agreeTerms:  z.boolean().optional(),
}).superRefine((v, ctx) => {
  /* R-173: the GST invoice needs a place of supply; a valid GSTIN carries one. */
  if (!v.stateCode && !stateCodeFromGstin(v.gstin)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stateCode"], message: "Select your state — the GST invoice needs it" });
  }
  /* R-227: the server drops a GSTIN that fails the checksum without a word (the buyer then
     loses input tax credit) — refuse it here, before Pay. Blank is fine. */
  const gstinMsg = gstinProblem(v.gstin);
  if (gstinMsg) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gstin"], message: gstinMsg });
  }
  /* R-226: no tick → no order, no Razorpay window. */
  if (v.agreeTerms !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agreeTerms"], message: BUY_TERMS_ERROR });
  }
});
export type BuyNowForm = z.infer<typeof buyNowSchema>;
