/**
 * R-2415 — Razorpay `payment_link.paid` for an invoice / statement pay link (Send reminder).
 *
 * Called by webhook.server.ts AFTER the signature check (the same HMAC as every other event).
 *   1. Read the link id, payment id and the paise Razorpay captured (parsePaymentLinkPaid).
 *   2. Our row (invoice_payment_links) → its tenant; the S24 tenant gate must allow it.
 *   3. settle_invoice_payment_link books it ONCE: the link row is locked, an already-paid link
 *      answers already_recorded, anything that no longer matches the frozen link goes to review
 *      (the owner is told; nothing is booked — never another bill's money, never a quiet credit).
 *   4. Razorpay's fee + who bore it on the payment rows (fee once per payment), owner notified.
 * No email to the customer from here — the reminder already went from us, and Razorpay's own
 * notifications are off on the link.
 *
 * The same payment also fires payment.captured / order.paid. `isInvoiceLinkCapture` recognises
 * those (our tag in the notes, the order's receipt = our row id, or the order id stored here) so
 * the quote checkout path does not look for a quote that does not exist.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import { logDbError, safeDbMessage } from "@/lib/errors/db-error";
import { recordFeeBearer } from "@/lib/payments/online-fee.server";
import { isInvoiceLinkPayment, parsePaymentLinkPaid } from "@/lib/payments/payment-link";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { flagPaymentForReview } from "./review.server";
import type { RazorpayPayment } from "./webhook.server";

type Admin = ReturnType<typeof createAdminClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentLinkPaidDeps {
  mayActOn: (tenantId: string) => Promise<boolean>;
  eventId: string | null;
  /** webhook.server's recordGatewayFee — passed in so this file does not import its caller. */
  recordGatewayFee: (admin: Admin, tenantId: string, quoteId: string, reference: string, payment: RazorpayPayment) => Promise<void>;
}

interface SettleResult {
  found?: boolean;
  recorded?: boolean;
  already_recorded?: boolean;
  review?: boolean;
  why?: string | null;
  tenant_id?: string;
  customer_id?: string;
  lines?: { invoice_id: string; quote_id: string; amount: number; payment_id: string | null; invoice_paid: boolean }[];
}

/**
 * Is this payment.captured / order.paid the capture of one of OUR invoice links? Then
 * payment_link.paid books it and the quote path must leave it alone.
 */
export async function isInvoiceLinkCapture(
  admin: Admin,
  payment: { order_id?: string | null; notes?: Record<string, unknown> } | undefined,
  order: { id?: string; receipt?: string | null; notes?: Record<string, unknown> } | undefined,
): Promise<boolean> {
  if (isInvoiceLinkPayment(payment?.notes, order?.notes)) return true;
  const db = admin as unknown as SupabaseClient;
  const receipt = order?.receipt?.trim() ?? "";
  if (UUID.test(receipt)) {
    const { data } = await db.from("invoice_payment_links").select("id").eq("id", receipt).maybeSingle();
    if (data) return true;
  }
  const orderId = (payment?.order_id ?? order?.id ?? "").trim();
  if (orderId.startsWith("order_")) {
    const { data } = await db.from("invoice_payment_links").select("id").eq("razorpay_order_id", orderId).limit(1).maybeSingle();
    if (data) return true;
  }
  return false;
}

export async function handlePaymentLinkPaid(admin: Admin, body: unknown, deps: PaymentLinkPaidDeps): Promise<NextResponse> {
  const paid = parsePaymentLinkPaid(body);
  if (!paid) {
    console.warn("[webhooks/razorpay] payment_link.paid without a captured payment — ignored");
    return NextResponse.json({ received: true, ignored: "payment_link.paid (no captured payment)" });
  }
  const db = admin as unknown as SupabaseClient;

  const { data: row, error: rowErr } = await db
    .from("invoice_payment_links")
    .select("id, tenant_id, customer_id, razorpay_order_id")
    .eq("razorpay_link_id", paid.linkId)
    .maybeSingle();
  if (rowErr) {
    logDbError("webhooks/razorpay:payment_link.find", rowErr);
    return NextResponse.json({ error: "Payment link lookup failed" }, { status: 500 });
  }
  const link = row as { id: string; tenant_id: string; customer_id: string; razorpay_order_id: string | null } | null;
  if (!link) {
    /* Not an invoice link of ours (a link made by hand in the Razorpay dashboard, say). */
    console.warn("[webhooks/razorpay] payment_link.paid for a link the app did not make:", paid.linkId);
    return NextResponse.json({ received: true, ignored: "payment_link.paid (not an app invoice link)" });
  }
  if (!(await deps.mayActOn(link.tenant_id))) {
    console.error("[webhooks/razorpay] payment_link.paid tenant mismatch", { linkTenant: link.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  /* Remember the order, so a payment.captured that arrives (or is retried) without our notes
     is still recognised as this link's. */
  if (paid.orderId && !link.razorpay_order_id) {
    const { error } = await db.from("invoice_payment_links")
      .update({ razorpay_order_id: paid.orderId })
      .eq("tenant_id", link.tenant_id).eq("id", link.id);
    if (error) logDbError("webhooks/razorpay:payment_link.order", error);
  }

  const payEntity = (body as { payload: { payment: { entity: RazorpayPayment } } }).payload.payment.entity;
  const reviewPayment = { id: paid.paymentId, amount: paid.paidPaise, currency: paid.currency, email: payEntity.email, contact: payEntity.contact };
  const review = (why: string) =>
    flagPaymentForReview(admin, {
      tenantId: link.tenant_id, quoteId: null, leadId: null, payment: reviewPayment, orderId: paid.orderId,
      event: "payment_link.paid",
      title: "Razorpay pay-link payment needs a check",
      why: `it came through the reminder pay link but ${why}`,
      nextStep: `Open Payment Follow-up → this customer. If the bill is still open, use Record payment with reference ${paid.paymentId}; if it was already paid, refund the customer from the Razorpay dashboard.`,
    });

  if (paid.currency.toUpperCase() !== "INR") return review(`it was paid in ${paid.currency}, not INR`);

  const { data, error } = await admin.rpc("settle_invoice_payment_link" as never, {
    p_link_id: paid.linkId,
    p_payment_id: paid.paymentId,
    p_paid_paise: paid.paidPaise,
    p_event_id: deps.eventId,
  } as never);
  if (error) {
    logDbError("webhooks/razorpay:settle_invoice_payment_link", error);
    return NextResponse.json({ error: safeDbMessage(error, "Payment processing failed") }, { status: 500 });
  }
  const r = (data ?? {}) as SettleResult;
  if (!r.found) return NextResponse.json({ received: true, ignored: "payment_link.paid (link not found)" });
  if (r.already_recorded) return NextResponse.json({ received: true, alreadyProcessed: true });
  if (r.review) return review(r.why ?? "it no longer matches the bill");

  const lines = r.lines ?? [];
  /* Razorpay's fee belongs to the ONE payment — on the first bill's row only; every row gets
     who bore the fee (business, today — R-2417 charges it). */
  for (const [i, l] of lines.entries()) {
    if (i === 0) await deps.recordGatewayFee(admin, link.tenant_id, l.quote_id, paid.paymentId, payEntity);
    else await recordFeeBearer(admin, link.tenant_id, l.quote_id, paid.paymentId);
  }

  const total = lines.reduce((s, l) => s + l.amount, 0);
  const which = lines.map((l) => l.invoice_id).join(", ");
  await notifyTenantOwners({
    tenantId: link.tenant_id,
    kind: "payment.received",
    title: `Paid by reminder pay link — ${rupee(total)} · ${which}`,
    body: `Razorpay payment ${paid.paymentId}${paid.method ? ` (${paid.method})` : ""} booked on ${which}.`,
    href: lines.length === 1 ? invoiceHref(lines[0].invoice_id) : "/collections",
    entityId: paid.paymentId,
  });

  return NextResponse.json({ received: true, recorded: true, invoices: lines.map((l) => l.invoice_id) });
}
