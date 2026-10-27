/**
 * R-1596 — confirm a website payment when the buyer comes back from Razorpay.
 *
 * Until this card the order was completed ONLY by Razorpay's webhook. The checkout's success
 * handler cleared the cart and opened /done, and nothing on our server looked at the
 * payment — so wherever the webhook is not set up (local, staging) or arrives late or not at
 * all (live), the buyer had paid and the quote stayed "awaiting": no customer, no invoice,
 * no activation, while /done said "Payment received".
 *
 * POST /api/public/checkout/verify calls this with what Razorpay's checkout hands the
 * browser: {orderId, paymentId, signature}. Nothing in that body is trusted as a fact:
 *   1. the signature must be HMAC-SHA256("<order_id>|<payment_id>", key secret) with the
 *      SAME key the order was created with (loadCheckoutRazorpayKeys) — checked before
 *      anything else, so a forged body costs one HMAC and never reaches Razorpay;
 *   2. the order must be one of OUR quotes (quotes.payment_reference, set by cart-checkout);
 *   3. the payment is fetched from Razorpay's API server-side, and its order id, currency
 *      and amount must match the quote — an amount the browser sends is ignored;
 *   4. only a CAPTURED payment is settled, through the webhook's own settleCapturedPayment
 *      (record_payment, GST invoice, activation, emails). That function is idempotent per
 *      Razorpay payment id, so verify and the webhook can arrive in either order, and a
 *      reload of /done calls this again harmlessly.
 *
 * The answer is a state the page can show honestly: paid · confirming (authorised but not
 * captured yet, or our side failed — the webhook may still land) · failed · refused.
 */
import crypto from "node:crypto";
import Razorpay from "razorpay";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { settleCapturedPayment, type RazorpayPayment } from "@/app/api/webhooks/razorpay/webhook.server";
import { loadCheckoutRazorpayKeys } from "./razorpay-keys.server";
import { buyPageTenantId, BuyPageTenantMissingError } from "./live-guards";
import { DOMAIN_QUOTE_PLAN, splitOrderParts } from "./split-order";
import type { VerifyBody } from "./confirm-payment";

export interface VerifyResult {
  status: number;
  body: VerifyBody;
}

const bodySchema = z.object({
  orderId: z.string().min(1).max(64).regex(/^order_[A-Za-z0-9]+$/),
  paymentId: z.string().min(1).max(64).regex(/^pay_[A-Za-z0-9]+$/),
  signature: z.string().min(1).max(128).regex(/^[a-f0-9]+$/i),
});

const SUPPORT_NEXT = "Please don't pay again — email support with your order number and we'll finish it for you.";

/** Razorpay's documented checkout signature: HMAC-SHA256 of "order_id|payment_id". */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!keySecret || !signature) return false;
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function out(status: number, body: VerifyBody): VerifyResult {
  return { status, body };
}

export async function verifyCheckoutPayment(request: { headers: Headers }, raw: unknown): Promise<VerifyResult> {
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return out(400, { state: "refused", message: "We couldn't read the payment details from Razorpay. " + SUPPORT_NEXT });
  }
  const { orderId, paymentId, signature } = parsed.data;

  let tenantId: string;
  try {
    tenantId = buyPageTenantId();
  } catch (e) {
    if (e instanceof BuyPageTenantMissingError) {
      console.error("[checkout/verify] BUY_PAGE_TENANT_ID is not set — cannot confirm", orderId);
      return out(503, { state: "confirming", message: "We couldn't confirm your payment just now. " + SUPPORT_NEXT });
    }
    throw e;
  }

  const admin = createAdminClient();
  const keys = await loadCheckoutRazorpayKeys(admin, tenantId);
  if (!keys) {
    return out(503, { state: "confirming", message: "Online payment isn't set up on our side, so we couldn't confirm it. " + SUPPORT_NEXT });
  }

  // 1. The signature, before anything else is looked up or asked.
  if (!checkoutSignatureValid(orderId, paymentId, signature, keys.keySecret)) {
    console.warn("[checkout/verify] signature mismatch", { orderId, paymentId });
    return out(400, { state: "refused", message: "This payment confirmation didn't check out. " + SUPPORT_NEXT });
  }

  // 2. Our quote for this order.
  /* R-1985: a monthly order with a new domain is TWO quotes paid by this one order (both carry the
     order id until paid, then the payment id) — the Workspace quote is the one settled, and the
     amount due is both quotes' together (lib/checkout/split-order.ts). */
  type OrderQuote = { id: string; tenant_id: string; amount: number | null; lead_id: string | null; plan: string | null };
  const { data: quoteRows } = await admin
    .from("quotes")
    .select("id, tenant_id, amount, lead_id, plan")
    .eq("tenant_id", tenantId)
    .in("payment_reference", [orderId, paymentId])
    .limit(5);
  const rank = (q: OrderQuote) => (q.plan === DOMAIN_QUOTE_PLAN ? 1 : 0);
  const quote = ((quoteRows ?? []) as OrderQuote[]).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0] ?? null;
  if (!quote) {
    console.error("[checkout/verify] no quote for order", orderId);
    return out(404, { state: "refused", message: "We couldn't find the order this payment belongs to. " + SUPPORT_NEXT });
  }

  // 3. Razorpay's own record of the payment.
  let payment: RazorpayPayment;
  try {
    const rzp = new Razorpay({ key_id: keys.keyId, key_secret: keys.keySecret });
    payment = (await rzp.payments.fetch(paymentId)) as unknown as RazorpayPayment;
  } catch (err) {
    const why = (err as { error?: { description?: string } })?.error?.description ?? (err instanceof Error ? err.message : "unknown");
    console.error("[checkout/verify] Razorpay payment fetch failed", { orderId, paymentId, why });
    return out(502, { state: "confirming", quoteId: quote.id, message: "We're still confirming your payment with Razorpay." });
  }

  const parts = await splitOrderParts(admin, { quote, orderId, paymentId });
  const expectedPaise = Math.round((parts ? parts.reduce((s, p) => s + p.amount, 0) : Number(quote.amount ?? 0)) * 100);
  if (payment.order_id !== orderId || (payment.currency ?? "INR") !== "INR" || Number(payment.amount) !== expectedPaise) {
    console.error("[checkout/verify] payment does not match the order", {
      orderId, paymentId, paymentOrder: payment.order_id, paid: payment.amount, expected: expectedPaise,
    });
    return out(409, { state: "refused", quoteId: quote.id, message: "The amount paid doesn't match your order. " + SUPPORT_NEXT });
  }

  if (payment.status === "failed") {
    return out(200, {
      state: "failed", quoteId: quote.id,
      message: "Razorpay says this payment didn't go through. If money left your account, your bank refunds it automatically.",
    });
  }
  if (payment.status !== "captured") {
    // "authorized" (or "created"): Razorpay captures within moments; the page asks again.
    return out(202, { state: "confirming", quoteId: quote.id, message: "Your bank has approved the payment and Razorpay is completing it." });
  }

  // 4. The webhook's own settlement — idempotent per payment id.
  const res = await settleCapturedPayment(admin, {
    request,
    event: "checkout.verify",
    payment,
    order: { id: orderId, receipt: quote.id, amount: expectedPaise },
    keyIdForMode: keys.keyId,
    mayActOn: async (t) => t === tenantId,
  });
  const settled = (await res.json().catch(() => ({}))) as { invoiceId?: string | null; alreadyProcessed?: boolean };
  if (res.status >= 300) {
    console.error("[checkout/verify] settlement failed", { orderId, paymentId, status: res.status });
    return out(502, { state: "confirming", quoteId: quote.id, message: "Your payment reached us and we're still recording it." });
  }

  // The webhook may have settled it first — read the invoice from the quote either way.
  let invoiceId = settled.invoiceId ?? null;
  if (!invoiceId) {
    const { data: q } = await admin.from("quotes").select("invoice_id").eq("id", quote.id).eq("tenant_id", tenantId).maybeSingle();
    invoiceId = (q as { invoice_id?: string | null } | null)?.invoice_id ?? null;
  }
  return out(200, { state: "paid", quoteId: quote.id, invoiceId, message: "Payment received — your order is confirmed." });
}
