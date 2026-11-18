/**
 * R-2923 (18 Nov 2026) — a part (month / quarter / half-year) payment request was paid at Razorpay.
 *
 * Such a request (Bill next part / Bill together: quotes.subscription_billing_id, lines "part-2" / "part-2-1")
 * asks payment for a period of a subscription that is ALREADY running. Until this card the capture settlement
 * (webhook.server.ts settleCapturedPayment) went on as for a new sale after recording the money: it read a
 * vendor off the plan's wording and queued provisioning, could file a domain subscription, and mailed the
 * buyer "Thanks for your purchase … WHAT HAPPENS NEXT" with set-up steps and the desk "ACTION REQUIRED —
 * provision N licenses".
 *
 * Now the settlement stops here once the money and the part's tax invoice are done — the same two things
 * Record payment on that request does (record_payment, then the part's own instalment invoice through
 * issueInvoiceForOnlinePayment → raise_subscription_billing). Nothing of a sale runs: no provisioning, no
 * domain subscription, no panel login, no set-up mail. The buyer gets a plain receipt that names the period
 * and links the invoice; the owner an alert with no set-up steps.
 */
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/server";
import { rupee } from "@/lib/utils";
import { sendCustomerEmail, sendInternalEmail } from "@/lib/messaging";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { ownerPaymentAlertAllowed, storefrontVoice } from "@/lib/email/storefront-voice";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";
import type { OnlineInvoiceResult } from "@/lib/checkout/online-invoice.server";
import { isPartRequest } from "@/lib/billing/part-requests";
import { isPartRequestLine } from "./quote-vendor.server";

type Admin = ReturnType<typeof createAdminClient>;

/** Every line is a database-made part line ("part-2" / "part-2-1", one-time) — and there is at least one. */
export function allPartRequestLines(lineItems: unknown): boolean {
  return Array.isArray(lineItems) && lineItems.length > 0 && lineItems.every(isPartRequestLine);
}

/**
 * Is the paid quote a part payment request — and were its seats / rate changed before it was paid?
 * The one rule for "a part request" is lib/billing/part-requests.ts isPartRequest (its link to the part, kept
 * on a cancelled one too); a row that cannot be read is still known by its lines. Null = an ordinary quote.
 */
export async function paidPartRequest(
  admin: Admin,
  quote: { id: string; tenant_id: string; line_items?: unknown },
): Promise<{ termsChanged: boolean } | null> {
  const { data } = await admin
    .from("quotes").select("subscription_billing_id, cancelled_part_billing_id, proforma_terms_set_at")
    .eq("id", quote.id).eq("tenant_id", quote.tenant_id).maybeSingle();
  const row = data as unknown as
    { subscription_billing_id?: string | null; cancelled_part_billing_id?: string | null; proforma_terms_set_at?: string | null } | null;
  if (!isPartRequest(row) && !allPartRequestLines(quote.line_items)) return null;
  /* R-2519: set_part_request_terms stamps the request when its seats / per-seat rate were changed. */
  return { termsChanged: Boolean(row?.proforma_terms_set_at) };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** What the request's lines say was paid for: each line's name (product · domain · seats · period) and its period label. */
export function partRequestSummary(lineItems: unknown): { names: string[]; label: string } {
  const lines = Array.isArray(lineItems) ? lineItems.filter(isPartRequestLine) as { name?: unknown; description?: unknown }[] : [];
  const names = lines.map((l) => str(l.name)).filter(Boolean);
  const labels = [...new Set(lines.map((l) => str(l.description)).filter(Boolean))];
  return { names, label: labels.join("; ") };
}

export interface PartRequestPaidInput {
  quote: { id: string; tenant_id: string; customer_name: string | null; line_items: unknown };
  /** ₹ captured (the whole payment). */
  paid: number;
  paymentRef: string;
  paymentMethod: string;
  customerEmail: string;
  customerName: string;
  invoice: OnlineInvoiceResult;
  /** The request's seats / rate were changed before it was paid (set_part_request_terms). */
  termsChanged: boolean;
  /** trustedOrigin(request.headers) — the base of the links in the mails. */
  publicBase: string;
  fromEmail: string;
}

/** The receipt to the buyer, the alert to the owner, and the webhook's answer. Never throws on a mail failure. */
export async function finishPartRequestPayment(admin: Admin, i: PartRequestPaidInput): Promise<NextResponse> {
  const { quote, paid, invoice } = i;
  const invoiceId = invoice.status === "issued" || invoice.status === "exists" ? invoice.invoiceId : null;
  console.log(`[webhooks/razorpay] ${quote.id} is a part payment request — payment recorded${invoiceId ? `, tax invoice ${invoiceId}` : ""}; nothing to activate.`);

  const { alert: owner, tenant } = await loadOwnerAlert(admin, quote.tenant_id);
  const seller = tenant ?? {};
  if (!owner.ok) {
    console.error(`[webhooks/razorpay] payment ${i.paymentRef} recorded for tenant ${quote.tenant_id}, but no owner alert: ${owner.reason}`);
  }
  const sellerName = seller.name?.trim() || "your reseller";
  const sellerPerson = seller.contact_name?.trim() || sellerName;
  const sellerPhone = seller.phone?.trim() || "";
  const voice = storefrontVoice(quote.tenant_id);
  const replyTo = voice ? voice.replyTo : owner.ok ? owner.to : null;
  const signOff = voice ? voice.signOff : `— ${sellerPerson}\n   ${sellerName}`;
  const contactWho = voice ? "our team" : sellerPerson;

  const { names, label } = partRequestSummary(quote.line_items);
  const amountFmt = rupee(paid);
  const paidFor = [label && `  ${label}`, ...names.map((n) => `  ${n}`)].filter(Boolean).join("\n") || `  ${quote.id}`;
  const invoiceLine = invoiceId
    ? `YOUR GST TAX INVOICE\n  ${pdfDownloadUrl(i.publicBase, "invoice", invoiceId, quote.tenant_id)}`
    : `Your GST tax invoice will reach you by email shortly.`;

  const results = await Promise.allSettled([
    i.customerEmail && replyTo && sendCustomerEmail({
      to: i.customerEmail,
      from: i.fromEmail,
      replyTo,
      kind: "razorpay_payment_customer",
      route: { tenantId: quote.tenant_id },
      subject: `Payment received · ${quote.id} · ${amountFmt}`,
      text:
`Hi ${i.customerName.split(" ")[0] || "there"},

We have received your payment of ${amountFmt}. Thank you.

PAID FOR
${paidFor}

  Reference   ${quote.id}
  Total paid  ${amountFmt} (incl GST)

Your service continues as it is — there is nothing you need to do.

${invoiceLine}${sellerPhone ? `\n\nIf you need anything, WhatsApp ${contactWho} on ${sellerPhone}.` : ""}

${signOff}`,
    }),
    owner.ok && ownerPaymentAlertAllowed() && sendInternalEmail({
      to: owner.to,
      from: i.fromEmail,
      kind: "razorpay_payment_owner",
      route: { tenantId: quote.tenant_id },
      subject: `💰 PAYMENT RECEIVED · ${quote.customer_name} · ${amountFmt}`,
      text:
`A payment request for a running subscription was just paid through Razorpay.

COMPANY     ${quote.customer_name}
CONTACT     ${i.customerName} <${i.customerEmail}>
PAID FOR
${paidFor}
TOTAL       ${amountFmt}
REQUEST     ${quote.id}
RAZORPAY    ${i.paymentRef}
METHOD      ${i.paymentMethod}
TAX INVOICE ${invoiceId ?? `NOT issued yet — ${invoice.status === "failed" ? invoice.reason : "the request is not paid in full"}. The payment is recorded; the daily billing run issues the invoice once that is fixed.`}

${i.termsChanged
  ? "CHECK THE SEATS: the seats or the rate on this request were changed before it was paid, and the subscription now carries them. If the seat count changed, add or remove the licences in the vendor's console."
  : "Nothing to set up: the subscription is already running."}

Open request: ${i.publicBase}/quotes/${quote.id}`,
    }),
  ]);
  results.forEach((r, n) => {
    if (r.status === "rejected") console.error(`[webhooks/razorpay] email ${["customer", "owner"][n] ?? n} failed:`, r.reason);
  });

  return NextResponse.json({ received: true, quoteId: quote.id, paid, invoiceId, invoice: invoice.status, partRequest: true });
}
