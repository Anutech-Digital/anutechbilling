/**
 * R-1523 (Pardeep, 17 Oct 2026) — which paper a quote goes out as, and why the pay QR may be missing.
 *
 * A quote can be sent as a "Quotation" (the default) or as a "Proforma Invoice". The choice is
 * made per download / per send (`?template=proforma`, or `template` in the send body) — there is
 * no column for it, so nothing is remembered on the quote and no migration is needed.
 *
 * A Proforma Invoice is NOT a tax invoice (§17a): it carries the QUOTE's own number, printed as
 * "Proforma No.", and never draws from the gapless GST invoice series. That document comes from
 * generate_invoice, on payment.
 */

export type QuoteTemplate = "quotation" | "proforma";

/** Anything that is not exactly "proforma" is the default Quotation — a typo never changes the paper. */
export function parseQuoteTemplate(v: unknown): QuoteTemplate {
  return typeof v === "string" && v.trim().toLowerCase() === "proforma" ? "proforma" : "quotation";
}

export const PROFORMA_TITLE = "Proforma Invoice";

/** Printed under the title of every Proforma — the one line that keeps it from being mistaken for a tax invoice. */
export const PROFORMA_NOTICE = "This is not a tax invoice. A GST tax invoice will be issued on payment.";

/** The word for the document in an email subject / body. */
export function quoteTemplateNoun(t: QuoteTemplate): string {
  return t === "proforma" ? PROFORMA_TITLE : "Quotation";
}

/** Attachment / download file name. */
export function quoteTemplateFileName(t: QuoteTemplate, quoteId: string): string {
  return t === "proforma" ? `Proforma-${quoteId}.pdf` : `Quote-${quoteId}.pdf`;
}

/** Bank block on a Proforma — the tenant's remit_* fields. Null when no account number is set. */
export interface ProformaBank {
  bankName:      string | null;
  accountName:   string | null;
  accountNumber: string;
  ifsc:          string | null;
  branch:        string | null;
}

export function proformaBank(t: {
  name?: string | null;
  remit_bank_name?: string | null;
  remit_account_name?: string | null;
  remit_account_number?: string | null;
  remit_ifsc?: string | null;
  remit_branch?: string | null;
} | null | undefined): ProformaBank | null {
  const acct = t?.remit_account_number?.trim();
  if (!acct) return null;
  return {
    bankName:      t?.remit_bank_name?.trim() || null,
    accountName:   t?.remit_account_name?.trim() || t?.name?.trim() || null,
    accountNumber: acct,
    ifsc:          t?.remit_ifsc?.trim() || null,
    branch:        t?.remit_branch?.trim() || null,
  };
}

/** Where the UPI ID is typed in — Settings → Company → Payment details. */
export const UPI_SETTINGS_HREF = "/settings?tab=company#payment-details";

/**
 * §24: why the quote PDF will carry NO scan-to-pay QR, in words the owner can act on.
 * Null → a QR will be printed (or the quote no longer asks for money, so a QR is not expected).
 *
 * Non-INR is checked first: adding a UPI ID would not help a dollar quote, so telling the owner
 * to go and add one would send them on a pointless trip.
 */
export interface PayQrNotice {
  reason: "no-upi" | "non-inr";
  text:   string;
  /** Present only when the fix is in Settings. */
  action?: { label: string; href: string };
}

export function payQrNotice(args: {
  upiVpa:   string | null | undefined;
  currency: string | null | undefined;
}): PayQrNotice | null {
  const cur = (args.currency ?? "INR").trim().toUpperCase() || "INR";
  if (cur !== "INR") {
    return { reason: "non-inr", text: "UPI works only for INR quotes — this quote PDF will not show a Pay QR." };
  }
  if (!args.upiVpa || !args.upiVpa.trim()) {
    return {
      reason: "no-upi",
      text:   "Add your UPI ID in Settings to show a Pay QR — every quote PDF will then carry a scan-to-pay QR.",
      action: { label: "Open Settings", href: UPI_SETTINGS_HREF },
    };
  }
  return null;
}
