/**
 * R-1971: what the inline checkout's last button does — pay (Razorpay, or the simulated path on
 * a test site), start the free trial, or send a GST quote request. Moved out of the old Buy now
 * / Trial / Quote dialogs unchanged in behaviour: the server prices the order, the bot check
 * token goes with each post (R-737 / R-020), a failure says what did NOT happen (R-1110/R-1137).
 */
import { toast } from "sonner";
import { describeError } from "@/lib/errors/toast-error";
import { fromRazorpayHandler } from "@/lib/checkout/confirm-payment";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { COMPANY, SLA, WHATSAPP_NUMBER, WHATSAPP_READY } from "@/site/lib/config";
import { postJson, NOT_REACHED } from "../post-json";
import { landingForForm } from "@/site/lib/ad-attribution";
import { thanksUrl } from "../thanks/thanks-url";
import { saveWorkspacePayment } from "../thanks/payment-handoff";
import { buyerStateCode, domainValue, orderCompany, type BuyerDetails, type DomainChoice, type PayMethod } from "./checkout-form";
import type { Billing, BuyPlan } from "./plans";

/** R-1137: the server's sentence, why nothing happened, and a way to reach us. */
export function buyFail(apiError: string | undefined, fallback: string, why: string): void {
  const d = describeError(apiError ? { message: apiError } : null, fallback);
  toast.error(d.message, {
    description: `${why} ${d.translated && d.description ? d.description : "Try again, or contact us and we'll finish it for you."}`,
    action: WHATSAPP_READY
      ? { label: "WhatsApp us", onClick: () => { window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi, I got "${d.message}" on the Google Workspace buy page.`)}`, "_blank", "noopener,noreferrer"); } }
      : { label: "Email us", onClick: () => { window.location.href = `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent("Help with Google Workspace purchase")}`; } },
    duration: 10_000,
  });
}

/** R-1110: our server was not reached — say so, say what did NOT happen, offer the same step. */
export function notReached(nothingDone: string, retry: () => void): void {
  toast.error(NOT_REACHED, {
    description: `${nothingDone} Check your internet connection and try again.`,
    action: { label: "Try again", onClick: retry },
    duration: 15_000,
  });
}

// ── Razorpay Checkout JS — loaded the first time someone pays ────────────────────────────────
interface RazorpayCheckoutResponse { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }
interface RazorpayCheckoutOptions {
  key: string; amount: number; currency: string; name: string; description?: string; order_id: string;
  handler?: (resp: RazorpayCheckoutResponse) => void;
  prefill?: { name?: string; email?: string; contact?: string; method?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  modal?: { ondismiss?: () => void; escape?: boolean };
}
interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: "payment.failed", handler: (resp: { error: { description?: string } }) => void) => void;
}
type RazorpayCtor = new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const rzpGlobal = () => (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;

function loadRazorpayCheckout(): Promise<RazorpayCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("Razorpay Checkout requires a browser"));
    const have = rzpGlobal();
    if (have) return resolve(have);
    const done = () => { const r = rzpGlobal(); if (r) resolve(r); else reject(new Error("Razorpay loaded but global is missing")); };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () => reject(new Error("Razorpay script failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = RAZORPAY_CHECKOUT_SRC;
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error("Razorpay script failed to load"));
    document.body.appendChild(s);
  });
}

interface CheckoutApiResponse {
  error?: string; simulated?: boolean; orderId?: string; amount?: number; currency?: string;
  razorpayKeyId?: string; quoteId?: string; publicToken?: string; leadId?: string;
  tierName?: string; seats?: number;
}

export interface SubmitContext {
  plan: BuyPlan; seats: number; billing: Billing; domain: DomainChoice; buyer: BuyerDetails;
  /** The bot-check widget (useTurnstile): its token header, and a reset after each post. */
  ts: { headers: Record<string, string>; reset: () => void };
  /** Name on the Razorpay window — the website tenant (falls back to the site config). */
  sellerName: string;
}

/**
 * Pay: the server creates the order (lead → quote → Razorpay order, or the simulated payment)
 * from the catalogue; the browser only opens Razorpay with what the server sent.
 */
export async function payOrder(
  ctx: SubmitContext,
  body: Record<string, unknown>,
  method: PayMethod,
  onRazorpay: (open: boolean) => void,
  retry: () => void,
): Promise<void> {
  const { ts } = ctx;
  const r = await postJson<CheckoutApiResponse>("/api/public/checkout/workspace", { ...body, ...landingForForm() }, ts.headers); // R-1978: the ad, with the order
  ts.reset(); // R-737: a token works once
  if (!r.reached) { notReached("No money was taken.", retry); return; }
  const json = r.json;
  if (!r.ok || json.error) { buyFail(json.error, "Could not start checkout.", "No money was taken."); return; }
  if (json.simulated) { window.location.href = thanksUrl(json.quoteId, json.publicToken, true); return; }
  if (!json.orderId || !json.razorpayKeyId || !json.amount) {
    buyFail(undefined, "Could not open the payment window.", "No money was taken — our server did not send the payment details.");
    return;
  }
  let Rzp: RazorpayCtor;
  try {
    Rzp = await loadRazorpayCheckout();
  } catch {
    buyFail(undefined, "Could not load the payment window.", "No money was taken. Check your internet connection and press Pay again.");
    return;
  }
  const rzp = new Rzp({
    key: json.razorpayKeyId,
    amount: json.amount,
    currency: json.currency ?? "INR",
    name: ctx.sellerName,
    description: `Google Workspace ${json.tierName ?? ctx.plan.name} · ${json.seats ?? ctx.seats} users (${ctx.billing})`,
    order_id: json.orderId,
    prefill: { name: ctx.buyer.name, email: ctx.buyer.email, contact: ctx.buyer.phone, method },
    notes: { quoteId: json.quoteId ?? "", leadId: json.leadId ?? "", domain: domainValue(ctx.domain) },
    /* R-1116: the storefront blue — site.css --primary, like /checkout (Razorpay takes a hex). */
    theme: { color: "#1668E3" },
    handler: (resp) => {
      // R-1625: keep {order, payment, signature} for THIS order; the thanks page confirms it.
      saveWorkspacePayment(json.quoteId, fromRazorpayHandler(resp));
      window.location.href = thanksUrl(json.quoteId, json.publicToken, false);
    },
    modal: {
      ondismiss: () => {
        onRazorpay(false);
        toast.message("Payment cancelled. We've saved your order details — our team will follow up.");
      },
      escape: true,
    },
  });
  rzp.on("payment.failed", (resp) => {
    buyFail(undefined, `Payment failed${resp.error?.description ? `: ${resp.error.description}` : "."}`, "No money was taken.");
  });
  onRazorpay(true);
  rzp.open();
}

/** Free trial: the existing trial route; no payment details. */
export async function startTrial(ctx: SubmitContext, retry: () => void): Promise<boolean> {
  const { ts } = ctx;
  const values = {
    fullName: ctx.buyer.name.trim(), companyName: orderCompany(ctx.buyer), email: ctx.buyer.email.trim(),
    phone: ctx.buyer.phone.trim(), seats: Math.min(ctx.seats, 300), domain: domainValue(ctx.domain), tierId: ctx.plan.id,
    message: ctx.domain.mode === "new" ? `New domain to register: ${domainValue(ctx.domain)}` : undefined,
  };
  const r = await postJson<{ success: boolean; error: string }>("/api/public/trial/workspace", { ...values, ...landingForForm() }, ts.headers);
  ts.reset();
  if (!r.reached) { notReached("Your trial was not requested.", retry); return false; }
  if (!r.ok || r.json.error) { buyFail(r.json.error, "Could not start the trial.", "Your trial was not requested yet."); return false; }
  /* R-1116: the company answers, not one named person; WhatsApp only when the number is live. */
  toast.success(`Trial requested! Our team will ${WHATSAPP_READY ? "WhatsApp" : "call or email"} you ${SLA.firstReply}.`);
  return true;
}

/** GST quote request (Plus, Enterprise, monthly-not-offered, payment off): the enquiry route. */
export async function requestQuote(ctx: SubmitContext, retry: () => void): Promise<boolean> {
  const { ts } = ctx;
  const stateCode = buyerStateCode(ctx.buyer) ?? undefined;
  const state = stateCode ? `${(GST_STATE_BY_CODE as Record<string, string>)[stateCode]} (${stateCode})` : undefined;
  const domain = domainValue(ctx.domain);
  const values = {
    fullName: ctx.buyer.name.trim(), companyName: orderCompany(ctx.buyer), email: ctx.buyer.email.trim(),
    phone: ctx.buyer.phone.trim(), seats: ctx.seats, tierId: ctx.plan.id, billing: ctx.billing, stateCode, state,
    message: domain ? `Domain: ${domain}${ctx.domain.mode === "new" ? " (new — please register it)" : ""}` : undefined,
  };
  const r = await postJson<{ success: boolean; error: string }>("/api/public/enquiry/workspace", { ...values, ...landingForForm() }, ts.headers);
  ts.reset();
  if (!r.reached) { notReached("We did not receive your enquiry.", retry); return false; }
  if (!r.ok || r.json.error) { buyFail(r.json.error, "Could not send your enquiry.", "We did not receive it yet."); return false; }
  toast.success(`Got it! We'll call you ${SLA.firstReply}.`);
  return true;
}
