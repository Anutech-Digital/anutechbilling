/**
 * Renders a UPI intent into a PNG data-URL for embedding in a PDF.
 *
 * Server-only: `qrcode` is imported dynamically so it never reaches a client
 * bundle, and only loads when a PDF is actually rendered.
 *
 * DESIGN RULE: a QR is a nice-to-have on a tax invoice; the invoice itself is a
 * legal document. So every failure path here returns null and the PDF renders
 * without the QR — never throws. A missing QR costs a scan; a thrown error
 * costs the customer their invoice.
 */
import { invoiceUpiIntent, quoteUpiIntent } from "@/lib/payments/upi";
import { statementUpiUri } from "@/lib/collections/pending-dues";

export interface UpiQr {
  dataUrl: string;
  /** Shown under the QR so the payer can type it if their camera struggles. */
  vpa: string;
}

/**
 * Build the QR for an invoice. Returns null when the tenant has no UPI ID, the
 * VPA is malformed, or encoding fails — all of which mean "print no QR".
 */
export async function buildInvoiceUpiQr(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  invoiceId: string;
  amountDue: number | null | undefined;
}): Promise<UpiQr | null> {
  return encodeQr(invoiceUpiIntent(args), args.vpa);
}

/**
 * Build the QR for a QUOTE. Same never-throws contract as the invoice version.
 *
 * Pass `quoteAmountDue()` as `amountDue`, not the raw `amount` column. That helper
 * refuses two cases this function cannot see: a quote billed in a currency other
 * than INR (UPI settles only in rupees, so `am=500.00` on a $500 quote collects
 * ₹500), and a quote already turned into an invoice (the invoice carries its own
 * QR at its own outstanding balance, and two documents asking for the same money
 * is how a customer pays twice).
 */
export async function buildQuoteUpiQr(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  quoteId: string;
  amountDue: number | null | undefined;
}): Promise<UpiQr | null> {
  return encodeQr(quoteUpiIntent(args), args.vpa);
}

/**
 * R-1526: the QR for a customer's PENDING-DUES STATEMENT — one QR for the whole total. Same
 * never-throws contract. statementUpiUri() refuses nothing-due, a non-INR bill and a missing
 * or malformed UPI ID, so each of those prints no QR.
 */
export async function buildStatementUpiQr(args: Parameters<typeof statementUpiUri>[0]): Promise<UpiQr | null> {
  return encodeQr(statementUpiUri(args), args.vpa);
}

/** Shared encoder. Returns null on every failure path — never throws. */
async function encodeQr(uri: string | null, vpa: string | null | undefined): Promise<UpiQr | null> {
  if (!uri || !vpa) return null;
  try {
    const QRCode = await import("qrcode");
    const dataUrl = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",   // survives a phone camera at an angle
      margin: 1,                   // quiet zone; 0 makes some scanners fail
      width: 320,                  // crisp when printed at ~28mm
      color: { dark: "#1A1815", light: "#FFFFFF" },  // --ink on white
    });
    return { dataUrl, vpa: vpa.trim() };
  } catch {
    // Encoding failed — print the document anyway.
    return null;
  }
}
