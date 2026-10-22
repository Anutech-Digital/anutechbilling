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
import { quotePayQr, type QuotePayQrTenant } from "@/lib/pdf/quote-pay-qr";
import { readQuoteDueNow } from "@/lib/checkout/quote-order";
import type { Quote, Customer } from "@/lib/supabase/database.types";
import { readTenantUdyam } from "@/lib/compliance/udyam";
import { parseQuoteTemplate, proformaBank, quoteTemplateFileName } from "@/lib/pdf/quote-template";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { trustedOrigin } from "@/lib/app-url";
import { customerCopyBlock } from "@/lib/quotes/customer-copy-gate";
import { loadRenewedSubscriptionDomain } from "@/lib/quotes/line-period-context";

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
  /* R-1669: this link is a customer copy. A quote still waiting for (or refused) discount /
     margin approval is not rendered — the button is disabled too, but a link can be shared. */
  const block = customerCopyBlock(q);
  if (block) return deny(409, `This quote needs approval before it can go to the customer. ${block.reason} ${block.nextStep}`);
  const [{ data: customer }, { data: lead }, { data: tenant }, udyamNumber] = await Promise.all([
    q.customer_id
      ? admin.from("customers").select("*").eq("id", q.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    /* R-376 (f): a lead quote's place of supply is the lead's state. */
    !q.customer_id && q.lead_id
      ? admin.from("leads").select("state_code, gstin, country").eq("id", q.lead_id).eq("tenant_id", q.tenant_id).maybeSingle()
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
    /* R-1764: a renewal quote's "Domain:" comes from the subscription it renews. */
    subscriptionDomain: await loadRenewedSubscriptionDomain(admin, q),
    quote:    q,
    customer: (customer as Customer) ?? null,
    lead,
    tenant:   tenant ? { ...(tenant as TenantPdfInfo), udyam_number: udyamNumber } : {
      name: q.customer_name, gstin: null, email: null, phone: null, address: null,
      state: null, state_code: null, logo_url: null, upi_vpa: null,
      /* No tenant row → no bank details to print (a Proforma's bank block, R-1523, is then
         simply left out). Nulls here, not an omission — see TenantPdfInfo's comment. */
      remit_bank_name: null, remit_account_name: null, remit_account_number: null,
      remit_ifsc: null, remit_branch: null, udyam_number: udyamNumber,
    },
  });

  // Scan-to-pay. R-1613: the QR asks for exactly what the online Pay button charges —
  // readQuoteDueNow (total − money received, instalment 1 on a split quote). No QR on a
  // non-INR quote (UPI settles only in rupees), a paid one, or one already invoiced (the
  // invoice owns that ask, at its own balance). R-1694: one shared rule (quotePayQr) so the
  // staff preview shows the same QR the customer's PDF carries.
  const upi = await quotePayQr({
    tenant:  tenant as QuotePayQrTenant | null,
    quoteId: q.id,
    due:     await readQuoteDueNow(admin, q),
  });

  /* R-1523: ?template=proforma → the same quote as a "Proforma Invoice" (quote number, no GST
     series — §17a). Chosen per download; nothing is stored on the quote. */
  const template = parseQuoteTemplate(req.nextUrl.searchParams.get("template"));
  const payLinkUrl = q.public_token ? quoteAcceptUrl(trustedOrigin(req.headers), q.id, q.public_token) : null;

  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { QuotePDF } = await import("@/lib/pdf/QuotePDF");
  const buffer = await renderToBuffer(
    createElement(QuotePDF, {
      ...props, upiQrDataUrl: upi?.dataUrl ?? null, upiVpa: upi?.vpa ?? null,
      template,
      bank: template === "proforma" ? proformaBank(tenant as Parameters<typeof proformaBank>[0]) : null,
      payLinkUrl,
    }) as unknown as Parameters<typeof renderToBuffer>[0],
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${template === "proforma" ? quoteTemplateFileName(template, id) : `${id}.pdf`}"`,
      "cache-control": "private, max-age=300",
    },
  });
}
