/**
 * GET /api/v1/documents/quote/{id}/pdf?token=<hmac>
 *
 * Public capability URL (see the invoice PDF route for the token model).
 * Renders the quotation PDF server-side (same QuotePDF component the app uses).
 */
import { type NextRequest } from "next/server";
import { createElement } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyPdfToken } from "@/lib/pdf/pdf-token";
import { logoDataUri } from "@/lib/pdf/logo";
import { buildQuotePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { buildQuoteUpiQr } from "@/lib/pdf/upi-qr";
import { quoteAmountDue } from "@/lib/payments/amount-due";
import type { Quote, Customer } from "@/lib/supabase/database.types";
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

  const { data: quote } = await admin.from("quotes").select("*").eq("id", id).maybeSingle();
  if (!quote) return deny(404, "Quote not found");
  if (!verifyPdfToken("quote", id, (quote as Quote).tenant_id, token)) {
    return deny(403, "Invalid or missing token");
  }

  const q = quote as Quote;
  const [{ data: customer }, { data: tenant }, udyamNumber] = await Promise.all([
    q.customer_id
      ? admin.from("customers").select("*").eq("id", q.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("tenants").select("name, gstin, email, phone, address, state, state_code, upi_vpa, upi_payee_name, logo_url, remit_bank_name, remit_account_name, remit_account_number, remit_ifsc, remit_branch").eq("id", q.tenant_id).maybeSingle(),
    /* R-368: read on its own — never fails the PDF, null before its migration. */
    readTenantUdyam(admin, q.tenant_id),
  ]);

  /* Fetched here, not inside the renderer: `logoDataUri` carries a 4s deadline and swallows
     every failure, so a slow or missing logo costs the monogram and never the document. */
  const logo = await logoDataUri((tenant as { logo_url?: string | null } | null)?.logo_url);

  const props = buildQuotePdfProps({
    logoDataUri: logo,
    quote:    q,
    customer: (customer as Customer) ?? null,
    tenant:   tenant ? { ...(tenant as TenantPdfInfo), udyam_number: udyamNumber } : {
      name: q.customer_name, gstin: null, email: null, phone: null, address: null,
      state: null, state_code: null, logo_url: null, upi_vpa: null,
      /* A quote PDF prints no bank block (R-038 is the invoice footer), but the shared
         TenantPdfInfo is what forces every caller to think about these — see its
         comment. Nulls here, not an omission. */
      remit_bank_name: null, remit_account_name: null, remit_account_number: null,
      remit_ifsc: null, remit_branch: null, udyam_number: udyamNumber,
    },
  });

  // Scan-to-pay. quoteAmountDue() decides whether this quote can be collected at
  // all — it refuses a non-INR quote (UPI settles only in rupees) and refuses one
  // already invoiced (the invoice owns that ask, at its own balance).
  const t = tenant as { name?: string; upi_vpa?: string | null; upi_payee_name?: string | null } | null;
  const upi = await buildQuoteUpiQr({
    vpa:       t?.upi_vpa,
    payeeName: t?.upi_payee_name ?? t?.name,
    quoteId:   q.id,
    amountDue: quoteAmountDue(q),
  });

  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { QuotePDF } = await import("@/lib/pdf/QuotePDF");
  const buffer = await renderToBuffer(
    createElement(QuotePDF, {
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
