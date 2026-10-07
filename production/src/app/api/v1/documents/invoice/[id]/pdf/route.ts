/**
 * GET /api/v1/documents/invoice/{id}/pdf?token=<hmac>
 *
 * Public capability URL (no Bearer — the browser opens it). The token is an
 * HMAC bound to (invoice, tenant); we fetch the invoice by its globally-unique
 * id, read its tenant, and verify the token. Then render the GST Tax Invoice
 * PDF server-side (same InvoicePDF component the app uses).
 */
import { type NextRequest } from "next/server";
import { createElement } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyPdfToken } from "@/lib/pdf/pdf-token";
import { logoDataUri } from "@/lib/pdf/logo";
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { buildInvoiceUpiQr } from "@/lib/pdf/upi-qr";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";
import { readTenantUdyam } from "@/lib/compliance/udyam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deny(status: number, msg: string) {
  return new Response(msg, { status, headers: { "content-type": "text/plain" } });
}

export async function GET(req: NextRequest, props0: { params: Promise<{ id: string }> }) {
  const params = await props0.params;
  const id = params.id;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const admin = createAdminClient();

  const { data: invoice } = await admin.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!invoice) return deny(404, "Invoice not found");
  if (!verifyPdfToken("invoice", id, (invoice as Invoice).tenant_id, token)) {
    return deny(403, "Invalid or missing token");
  }

  const inv = invoice as Invoice;
  const [{ data: quote }, { data: customer }, { data: tenant }, udyamNumber] = await Promise.all([
    admin.from("quotes").select("*").eq("invoice_id", id).maybeSingle(),
    inv.customer_id
      ? admin.from("customers").select("*").eq("id", inv.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("tenants").select("name, gstin, email, phone, address, state, state_code, upi_vpa, upi_payee_name, logo_url, remit_bank_name, remit_account_name, remit_account_number, remit_ifsc, remit_branch, lut_number").eq("id", inv.tenant_id).maybeSingle(),
    /* R-368: read on its own — never fails the PDF, null before its migration. */
    readTenantUdyam(admin, inv.tenant_id),
  ]);

  /* R-038. Whether this seller can take a Razorpay payment at all. Read here rather
     than in the pure prop builder, and the answer is FALSE when the row is unreadable:
     the bug being fixed is an invoice promising a gateway that does not exist, so an
     unknown must not resolve to "yes" (AGENTS.md §2). */
  const { data: secrets } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", inv.tenant_id)
    .maybeSingle();
  const razorpayConfigured = Boolean(secrets?.razorpay_key_id && secrets?.razorpay_key_secret);

  /* Fetched here, not inside the renderer: logoDataUri carries a 4s deadline and swallows
     every failure, so a slow or missing logo costs the mark and never the document. */
  const logo = await logoDataUri((tenant as { logo_url?: string | null } | null)?.logo_url);

  const props = buildInvoicePdfProps({
    logoDataUri: logo,
    razorpayConfigured,
    invoice:  inv,
    quote:    (quote as Quote) ?? null,
    customer: (customer as Customer) ?? null,
    tenant:   tenant ? { ...(tenant as TenantPdfInfo), udyam_number: udyamNumber } : {
      name: inv.customer_name, gstin: null, email: null, phone: null, address: null,
      state: null, state_code: null, logo_url: null, upi_vpa: null,
      remit_bank_name: null, remit_account_name: null, remit_account_number: null,
      remit_ifsc: null, remit_branch: null, lut_number: null, udyam_number: udyamNumber,
    },
  });

  // Scan-to-pay QR — see invoiceAmountDue(): advances AND receipts both reduce
  // the balance, and asking for the gross would bill money already collected.
  const t = tenant as { name?: string; upi_vpa?: string | null; upi_payee_name?: string | null } | null;
  const upi = await buildInvoiceUpiQr({
    vpa:       t?.upi_vpa,
    payeeName: t?.upi_payee_name ?? t?.name,
    invoiceId: inv.id,
    amountDue: invoiceAmountDue(inv),
  });

  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { InvoicePDF } = await import("@/lib/pdf/InvoicePDF");
  const buffer = await renderToBuffer(
    createElement(InvoicePDF, {
      ...props, upiQrDataUrl: upi?.dataUrl ?? null, upiVpa: upi?.vpa ?? null,
    }) as unknown as Parameters<typeof renderToBuffer>[0],
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${id}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  });
}
