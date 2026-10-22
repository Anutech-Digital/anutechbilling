/**
 * R-747 — a captured Razorpay payment the webhook will not settle by itself.
 *
 * The security audit (9 Oct 2026) found the webhook recorded whatever amount Razorpay sent,
 * in whatever currency, against whatever quote the event named. Now:
 *  - `captureMismatch` says, before anything is written, why a payment cannot be settled
 *    automatically (wrong currency, a foreign-currency quote, no payment in the event);
 *  - `flagPaymentForReview` puts it in front of the owner — the bell notification and a note
 *    on the lead, the same place R-1569/R-1575 report unapplied money — once per Razorpay
 *    payment id, and logs it with the buyer's contact masked.
 *
 * Neither ever records a payment: the money stays visible, a person decides where it goes.
 */
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { isForeignCurrency } from "@/lib/currency";
import { logDbError } from "@/lib/errors/db-error";
import { maskContactValue } from "@/lib/security/redact-contact";

type Admin = ReturnType<typeof createAdminClient>;

/** The fields of a Razorpay payment this needs (paise, Razorpay's currency code). */
export interface ReviewPayment {
  id: string;
  amount: number;
  currency?: string | null;
  email?: string | null;
  contact?: string | null;
}

/**
 * Why this capture cannot be settled on this quote, or null when it can. Razorpay settles
 * rupees only and every order we create is INR (lib/checkout/quote-order.ts), so anything
 * else is not a payment this quote asked for.
 */
export function captureMismatch(
  payment: Pick<ReviewPayment, "currency">,
  quote: { currency?: string | null },
): string | null {
  const paid = String(payment.currency ?? "").trim().toUpperCase();
  if (paid !== "INR") {
    return `the payment is in ${paid || "(no currency)"}, not INR — Razorpay orders are always created in INR`;
  }
  if (isForeignCurrency(quote.currency)) {
    return `the quote is in ${String(quote.currency).toUpperCase()} but the payment came in INR — rupees cannot be recorded as that currency`;
  }
  return null;
}

/** Whole rupees from Razorpay paise, as shown in an alert ("₹1,180"); foreign codes as-is. */
function shown(paise: number, currency: string | null | undefined): string {
  const c = String(currency ?? "").trim().toUpperCase() || "INR";
  const major = (Number(paise) || 0) / 100;
  return c === "INR" ? `₹${Math.round(major).toLocaleString("en-IN")}` : `${c} ${major.toFixed(2)}`;
}

export interface ReviewArgs {
  tenantId: string;
  quoteId: string | null;
  leadId: string | null;
  payment: ReviewPayment;
  orderId: string | null;
  event: string;
  /** Why it was not settled — Hinglish, one clause. */
  why: string;
  /** What the owner does next — Hinglish, click-level. */
  nextStep: string;
  /** Title prefix — "Razorpay payment needs a check" by default. */
  title?: string;
  /** True when the money WAS recorded (as a part-payment) and only the rest of the sale was held. */
  recorded?: boolean;
}

/**
 * Tell the owner once per Razorpay payment id (the notification row is the fact a replay is
 * recognised by). Answers 200: a retry from Razorpay cannot change the answer, so it must
 * not loop for a day.
 */
export async function flagPaymentForReview(admin: Admin, a: ReviewArgs): Promise<NextResponse> {
  const { data: told } = await admin
    .from("notifications")
    .select("id")
    .eq("tenant_id", a.tenantId)
    .eq("kind", "payment.received")
    .eq("entity_id", a.payment.id)
    .limit(1);
  if (told && told.length) return NextResponse.json({ received: true, alreadyProcessed: true, needsReview: true });

  const amount = shown(a.payment.amount, a.payment.currency);
  const where = a.quoteId ? `on quote ${a.quoteId}` : "without a matching quote";
  const detail =
    `Razorpay payment ${a.payment.id} (${amount}, order ${a.orderId ?? "—"}, ${a.event}) came in ${where}, but ${a.why}. ` +
    (a.recorded
      ? "The app recorded it as a part-payment — the quote/invoice is NOT treated as fully paid; activation and the 'order confirmed' mail are on hold. "
      : "The app did NOT record it. ") +
    a.nextStep;
  await notifyTenantOwners({
    tenantId: a.tenantId,
    kind: "payment.received", // R-747 review — entityId is the Razorpay payment id
    title: `${a.title ?? "Razorpay payment needs a check"} — ${amount}${a.quoteId ? ` · ${a.quoteId}` : ""}`,
    body: detail,
    href: a.quoteId ? `/quotes/${a.quoteId}` : "/payments",
    entityId: a.payment.id,
  });
  if (a.leadId) {
    const { error } = await admin.from("lead_activities").insert({
      tenant_id: a.tenantId, lead_id: a.leadId, kind: "note", detail,
    });
    if (error) logDbError("webhooks/razorpay:review-note", error);
  }
  console.error(
    `[webhooks/razorpay] NEEDS REVIEW ${a.payment.id} ${amount} on ${a.quoteId ?? "(no quote)"} — ${a.why}`,
    { tenant: a.tenantId, order: a.orderId, email: maskContactValue(a.payment.email), contact: maskContactValue(a.payment.contact) },
  );
  return NextResponse.json({ received: true, needsReview: true, quoteId: a.quoteId });
}

/**
 * LESS than was due. The caller has ALREADY recorded the money through record_payment at what
 * was captured (so the quote is 'partial', never 'received', and no invoice can be issued off
 * it) and stops there: no activation, no domain subscriptions, no "order confirmed" mail. The
 * owner is told what came, what was due and what to do.
 */
export async function flagUnderpaid(
  admin: Admin,
  base: Omit<ReviewArgs, "why" | "nextStep" | "title" | "recorded">,
  expectedRupees: number,
): Promise<NextResponse> {
  const paidPaise = Number(base.payment.amount) || 0;
  const paid = Math.round(paidPaise / 100);
  const short = shown(expectedRupees * 100 - paidPaise, "INR");
  await flagPaymentForReview(admin, {
    ...base,
    title: "Short payment received",
    recorded: true,
    why: `${shown(expectedRupees * 100, "INR")} was due, only ${shown(paidPaise, "INR")} came in (${short} short)`,
    nextStep:
      `Collect the balance ${short} from the customer (the pay link of quote ${base.quoteId ?? ""} will ask for that amount), or refund it. ` +
      "The invoice and activation happen only after the full amount is received.",
  });
  return NextResponse.json({ received: true, quoteId: base.quoteId, underpaid: true, paid, expected: expectedRupees });
}
