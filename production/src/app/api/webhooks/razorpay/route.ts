/**
 * POST /api/webhooks/razorpay — the handler lives in webhook.server.ts (R-1596), so the
 * capture settlement inside it can be shared with POST /api/public/checkout/verify, which
 * completes a website order when the buyer returns from Razorpay. A route file may export
 * only its HTTP handlers, hence the split.
 */
export { POST } from "./webhook.server";
