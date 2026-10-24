/**
 * POST /api/public/checkout/verify — R-1596.
 *
 * Called by the checkout right after Razorpay's success handler, and by /done on load, with
 * {orderId, paymentId, signature}. Confirms the payment server-side and completes the order
 * through the webhook's own settlement, so an order no longer waits on the webhook. The
 * rules (signature, Razorpay's own record, amount from the quote) are in
 * lib/checkout/verify-payment.server.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifyCheckoutPayment } from "@/lib/checkout/verify-payment.server";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const r = await verifyCheckoutPayment(request, body);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
