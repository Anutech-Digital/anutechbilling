/**
 * PDF utilities — browser-side download helpers built on @react-pdf/renderer.
 *
 * Usage from a "use client" component:
 *
 *   import { downloadQuotePDF } from "@/lib/pdf";
 *   await downloadQuotePDF({ ...quoteProps });
 *
 * The pdf() function is dynamically imported so the heavy renderer is only
 * loaded when the user actually triggers a download — keeps initial bundle
 * small.
 */
import type { QuotePDFProps } from "./QuotePDF";
import type { InvoicePDFProps } from "./InvoicePDF";
import type { ReceiptVoucherPDFProps } from "./ReceiptVoucherPDF";
import type { PayslipPDFProps } from "./PayslipPDF";
/* R-525: every BROWSER entry point (download / preview) races the render against 20 s and
   turns any failure into "Could not make the PDF — try again", so a button spinner always
   stops. The render* functions stay untimed — server routes call them and own their limits. */
import { withPdfTimeout } from "./pdf-timeout";
export { PdfGenerationError, PDF_FAILED_MESSAGE, PDF_FAILED_DESCRIPTION } from "./pdf-timeout";

/* ─── FONT PEHLE, COMPONENT BAAD ME ─────────────────────────────────────────
   Har render function ke andar `await ensurePdfFonts()` component ke dynamic import se
   PEHLE aata hai, aur ye tarteeb maayne rakhti hai: component ka module load hote hi uska
   `StyleSheet.create` chal jata hai, aur wo `PDF_FONT` ki JO value us waqt hai wahi
   hamesha ke liye pakad leta hai. Font baad me register karne se style purani hi rehti —
   flag "haan" kehta aur document Helvetica par bana rehta. Wahi galti aaj ek baar ho chuki
   hai (`fonts.ts` ka header).

   Server par ye sirf sync `registerPdfFonts()` bulata hai; browser par `/fonts/…` ko
   HEAD se jaanch kar register karta hai. Dono jagah asset gayab hone par chitthi "Rs" par
   wapas chali jati hai — render fail nahi hota.

   `./fonts` ko bhi DYNAMIC import kiya gaya hai, static nahi. Wajah bundle hai: `fonts.ts`
   `Font` ko seedha `@react-pdf/renderer` se leta hai (usko sync hona hi hai — `fonts.ts`
   ka header dekho), aur is file ko client page import karte hain. Static hota to 500 KB ka
   renderer initial bundle me aa jata — theek wahi cheez jise ye file bachati hai. */

// ─── Quote ────────────────────────────────────────────────────────────────

export async function downloadQuotePDF(props: QuotePDFProps): Promise<Blob> {
  const blob = await withPdfTimeout(renderQuotePDF(props));
  triggerDownload(blob, `${props.quoteId}.pdf`);
  return blob;
}

export async function renderQuotePDF(props: QuotePDFProps): Promise<Blob> {
  // Lazy import keeps the ~500 KB renderer out of the initial bundle.
  const { pdf } = await import("@react-pdf/renderer");
  const { ensurePdfFonts } = await import("./fonts");
  await ensurePdfFonts();
  const { QuotePDF } = await import("./QuotePDF");
  return await pdf(<QuotePDF {...props} />).toBlob();
}

/**
 * Render + open the quote PDF in a new browser tab WITHOUT triggering
 * a download. Used by the WhatsApp attach card so visitors can review
 * what will land in the customer's inbox before pressing Send.
 */
export async function previewQuotePDF(props: QuotePDFProps): Promise<void> {
  const blob = await withPdfTimeout(renderQuotePDF(props));
  const url  = URL.createObjectURL(blob);
  // _blank with a noopener tab so the preview doesn't share state with
  // the dialog window (and accidental Cmd+W stays scoped).
  const win = window.open(url, "_blank", "noopener,noreferrer");
  // Revoke the object URL once the new tab has had time to grab it.
  // (Revoke immediately and Safari sometimes shows a broken page.)
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (!win) {
    // Pop-up blocked — fall back to opening in the same tab.
    window.location.href = url;
  }
}

// ─── Invoice ──────────────────────────────────────────────────────────────

export async function downloadInvoicePDF(props: InvoicePDFProps): Promise<Blob> {
  const blob = await withPdfTimeout(renderInvoicePDF(props));
  triggerDownload(blob, `${props.invoice.id}.pdf`);
  return blob;
}

export async function renderInvoicePDF(props: InvoicePDFProps): Promise<Blob> {
  const { pdf } = await import("@react-pdf/renderer");
  const { ensurePdfFonts } = await import("./fonts");
  await ensurePdfFonts();
  const { InvoicePDF } = await import("./InvoicePDF");
  return await pdf(<InvoicePDF {...props} />).toBlob();
}

// ─── Receipt Voucher ──────────────────────────────────────────────────────

export async function downloadReceiptVoucherPDF(props: ReceiptVoucherPDFProps): Promise<Blob> {
  const blob = await withPdfTimeout(renderReceiptVoucherPDF(props));
  const name = props.payment.receipt_voucher_no ?? `RV-${props.payment.id.slice(0, 8)}`;
  triggerDownload(blob, `${name}.pdf`);
  return blob;
}

export async function renderReceiptVoucherPDF(props: ReceiptVoucherPDFProps): Promise<Blob> {
  const { pdf } = await import("@react-pdf/renderer");
  const { ensurePdfFonts } = await import("./fonts");
  await ensurePdfFonts();
  const { ReceiptVoucherPDF } = await import("./ReceiptVoucherPDF");
  return await pdf(<ReceiptVoucherPDF {...props} />).toBlob();
}

// ─── Payslip ──────────────────────────────────────────────────────────────

export async function downloadPayslipPDF(props: PayslipPDFProps, filename: string): Promise<Blob> {
  const blob = await withPdfTimeout(renderPayslipPDF(props));
  triggerDownload(blob, filename);
  return blob;
}

export async function renderPayslipPDF(props: PayslipPDFProps): Promise<Blob> {
  const { pdf } = await import("@react-pdf/renderer");
  const { ensurePdfFonts } = await import("./fonts");
  await ensurePdfFonts();
  const { PayslipPDF } = await import("./PayslipPDF");
  return await pdf(<PayslipPDF {...props} />).toBlob();
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick to let the browser commit the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type { QuotePDFProps } from "./QuotePDF";
