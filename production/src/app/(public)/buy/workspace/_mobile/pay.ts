/**
 * R-2021 (R-2019 decision 7): Pay on the phone — the SAME server route and Razorpay window as the
 * desktop (_parts/submit-order.ts payOrder), returning what happened instead of toasting, so the
 * phone can show Processing → Success / Failed screens.
 *
 * The charge is ALWAYS the server's: /api/public/checkout/workspace prices the order from the
 * catalogue and sends `amount` (paise); Razorpay opens with exactly that. The phone never sends
 * or computes a charge. If the server's amount differs from the total the Review screen showed
 * (a price edited in the catalogue meanwhile, a coupon that ran out), the phone stops and shows
 * the server's amount before any payment window opens (serverAmountDiffers).
 */
import { fromRazorpayHandler } from "@/lib/checkout/confirm-payment";
import { landingForForm } from "@/site/lib/ad-attribution";
import { fbpCookie, metaConsent } from "@/site/lib/meta-pixel";
import { consentAnonId } from "@/site/lib/consent";
import { formConsent } from "@/lib/consent/data-notice";
import { postJson, NOT_REACHED } from "../post-json";
import { thanksUrl } from "../thanks/thanks-url";
import { saveWorkspacePayment } from "../thanks/payment-handoff";
import { loadRazorpayCheckout, type RazorpayCtor } from "../_parts/submit-order";

/** The order the server created — every number in it is the server's. */
export interface ServerOrder {
  orderId: string;
  /** What Razorpay charges, in paise (server). */
  amountPaise: number;
  currency: string;
  keyId: string;
  quoteId: string;
  publicToken: string | undefined;
  tierName: string | undefined;
  seats: number | undefined;
}

export type StartResult =
  | { kind: "not-reached"; message: string }
  | { kind: "error"; message: string }
  | { kind: "simulated"; url: string; totalRupees: number | null }
  | { kind: "razorpay"; order: ServerOrder };

interface CheckoutApiResponse {
  error?: string; simulated?: boolean; orderId?: string; amount?: number; currency?: string;
  razorpayKeyId?: string; quoteId?: string; publicToken?: string; tierName?: string; seats?: number; totalRupees?: number;
}

/** Create the order on the server (lead → quote → Razorpay order, or the simulated payment). */
export async function startOrder(body: Record<string, unknown>, headers: Record<string, string>, marketingOptIn: boolean): Promise<StartResult> {
  const r = await postJson<CheckoutApiResponse>(
    "/api/public/checkout/workspace",
    /* R-1978 the ad; R-1979 Meta consent + _fbp; R-2010 consent record id; R-2011 the offers box */
    { ...body, ...landingForForm(), metaConsent: metaConsent(), fbp: fbpCookie(), consentAnonId: consentAnonId(), ...formConsent("buy_checkout", marketingOptIn) },
    headers,
  );
  if (!r.reached) return { kind: "not-reached", message: `${NOT_REACHED} No money was taken.` };
  const j = r.json;
  if (!r.ok || j.error) return { kind: "error", message: `${j.error ?? "Could not start checkout."} No money was taken.` };
  if (j.simulated) return { kind: "simulated", url: thanksUrl(j.quoteId, j.publicToken, true), totalRupees: typeof j.totalRupees === "number" ? j.totalRupees : null };
  if (!j.orderId || !j.razorpayKeyId || !j.amount || !j.quoteId) {
    return { kind: "error", message: "Could not open the payment window — our server did not send the payment details. No money was taken." };
  }
  return {
    kind: "razorpay",
    order: { orderId: j.orderId, amountPaise: j.amount, currency: j.currency ?? "INR", keyId: j.razorpayKeyId, quoteId: j.quoteId, publicToken: j.publicToken, tierName: j.tierName, seats: j.seats },
  };
}

/** True when the server's charge is not the total the buyer was shown (whole rupees). */
export function serverAmountDiffers(order: ServerOrder, shownRupees: number): boolean {
  return order.amountPaise !== Math.round(shownRupees) * 100;
}

export interface PayHandlers {
  onPaid: () => void;
  onFailed: (reason: string) => void;
  onDismiss: () => void;
}

/** Open Razorpay for the server's order. false = the window could not be loaded (nothing taken). */
export async function openRazorpay(
  order: ServerOrder,
  ctx: { sellerName: string; buyer: { name: string; email: string; phone: string }; planName: string; billing: string; domain: string },
  h: PayHandlers,
): Promise<boolean> {
  let Rzp: RazorpayCtor;
  try {
    Rzp = await loadRazorpayCheckout();
  } catch {
    return false;
  }
  const rzp = new Rzp({
    key: order.keyId,
    amount: order.amountPaise,
    currency: order.currency,
    name: ctx.sellerName,
    description: `Google Workspace ${order.tierName ?? ctx.planName} · ${order.seats ?? ""} users (${ctx.billing})`,
    order_id: order.orderId,
    prefill: { name: ctx.buyer.name, email: ctx.buyer.email, contact: ctx.buyer.phone },
    notes: { quoteId: order.quoteId, domain: ctx.domain },
    theme: { color: "#1668E3" },
    handler: (resp) => {
      // R-1625: keep {order, payment, signature} for THIS order; the thanks page confirms it.
      saveWorkspacePayment(order.quoteId, fromRazorpayHandler(resp));
      h.onPaid();
      window.location.href = thanksUrl(order.quoteId, order.publicToken, false);
    },
    modal: { ondismiss: () => h.onDismiss(), escape: true },
  });
  rzp.on("payment.failed", (resp) => h.onFailed(resp.error?.description ?? ""));
  rzp.open();
  return true;
}
