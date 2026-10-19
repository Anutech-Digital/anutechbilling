// Not wired yet — R-1608 (built, kept for later)
/**
 * Building a Razorpay payment link for a quote — the decision and the request body.
 *
 * Pure. The HTTP call is in payment-link.server.ts; what may be charged, to whom, and in what
 * unit is decided here where it can be tested against a table.
 *
 * ─── THE ×100 BOUNDARY, WHICH IS THE MOST DANGEROUS LINE IN THIS FILE ───────
 * This schema stores money in WHOLE RUPEES. AGENTS.md and CLAUDE.md §13 both say so, and §13
 * says it in a correction because the file used to claim paise — "the most dangerous kind of
 * false: acting on it puts a × 100 or ÷ 100 into money code".
 *
 * Razorpay's API takes PAISE. So this is a genuine unit boundary and it is crossed in exactly
 * one function, `toPaise`, with a test that pins a real quote total. Get it wrong in one
 * direction and we ask a customer for ₹1,46,811 when we meant ₹1,468; in the other, for
 * ₹1,46,81,100. Both are a payment link sent to a real person with a real number on it.
 *
 * ─── AND A TEST-MODE KEY MUST NEVER LOOK LIKE A SALE ────────────────────────
 * Measured on production 25 Aug 2026: `razorpay_key_id` starts `rzp_test_`. A test-mode link
 * accepts a payment, fires `payment.captured`, and settles nothing. The link itself is fine to
 * generate — that is what a sandbox is for — but it must be LABELLED, so nobody reads a test
 * receipt as money in the bank. `decidePaymentLink` says so in the refusal reason rather than
 * quietly proceeding.
 */

/** Razorpay's own cap on a payment-link description. */
const MAX_DESCRIPTION = 255;

/**
 * Whole rupees → paise, the only place this conversion happens.
 *
 * `Math.round` on a value that is already an integer is belt and braces: `quotes.amount` is an
 * integer column, and a non-integer arriving here would mean something upstream is already
 * wrong. Rounding is the safe response — a fractional paisa is not a thing Razorpay accepts.
 */
export function toPaise(rupees: number): number {
  return Math.round(rupees) * 100;
}

export type LinkRefusal =
  | "no_amount"
  | "already_paid"
  | "not_sendable"
  | "no_contact"
  | "not_configured";

export type PaymentLinkDecision =
  | { create: true; mode: "live" | "test"; note: string | null }
  | { create: false; reason: LinkRefusal; detail: string };

export interface PaymentLinkInput {
  /** From `razorpayMode(key_id)` — the key is the single source of truth. */
  mode: "live" | "test";
  /** True when key_id AND key_secret are both present. */
  configured: boolean;
  /** ₹ still owed on this quote, whole rupees. From lib/payments/amount-due. */
  amountDue: number;
  /** `quotes.status`. */
  quoteStatus: string;
  /** Where the link would go — an email address or an E.164 number. */
  contact: string | null;
}

/**
 * May we create a payment link for this quote?
 *
 * Ordered so the reason an operator reads is the one that needs dealing with. "Already paid"
 * outranks "no contact" because fixing the address would not make a second link correct — and
 * a second link for a settled quote is how a customer pays twice, which is the failure
 * `quoteAmountDue` exists to prevent on the QR path.
 */
export function decidePaymentLink(input: PaymentLinkInput): PaymentLinkDecision {
  if (!input.configured) {
    return {
      create: false,
      reason: "not_configured",
      detail:
        "Razorpay is not connected for this workspace — save the key id and secret in " +
        "Settings → Integrations before a payment link can be created",
    };
  }

  if (input.quoteStatus === "draft") {
    return {
      create: false,
      reason: "not_sendable",
      detail: "this quote is still a draft — a customer has never seen it, so nothing is owed yet",
    };
  }

  if (input.amountDue <= 0) {
    /* Covers both "settled" and "already invoiced": `quoteAmountDue` returns 0 for money
       already collected or already asked for elsewhere. Two documents collecting the same
       amount is how a customer pays twice. */
    return {
      create: false,
      reason: "already_paid",
      detail: "nothing is outstanding on this quote — a second payment link could collect it twice",
    };
  }

  if (!input.contact?.trim()) {
    return {
      create: false,
      reason: "no_contact",
      detail: "no email address or phone number to send the link to",
    };
  }

  return {
    create: true,
    mode: input.mode,
    /* Named, not hidden. A test link takes a payment, fires payment.captured, and settles
       nothing — so anything downstream that treats it as revenue is wrong, and the operator
       needs to know which kind of link they just sent. */
    note:
      input.mode === "test"
        ? "TEST MODE — this link accepts a payment and settles no money. Nothing it reports is revenue."
        : null,
  };
}

export interface PaymentLinkRequest {
  /** PAISE. See toPaise. */
  amount: number;
  currency: "INR";
  description: string;
  reference_id: string;
  customer: { name?: string; email?: string; contact?: string };
  notify: { sms: boolean; email: boolean };
  /** We send the link ourselves, through the gated path — Razorpay must not also send it. */
  reminder_enable: boolean;
  notes: Record<string, string>;
  callback_url?: string;
  callback_method?: "get";
  /** Unix seconds. */
  expire_by?: number;
}

/**
 * The Razorpay Payment Links request body.
 *
 * `notify` is false on both channels and `reminder_enable` is false, deliberately. Razorpay
 * will happily SMS and email the customer itself, and then the app has sent a customer-facing
 * message that never passed through `sendEmail` — so it is not in `email_log`, not gated by the
 * autonomy dial, and not visible on the lead's timeline. Every other outbound message in this
 * codebase goes through one chokepoint; a payment link is the last thing that should be the
 * exception.
 *
 * `reference_id` is the quote id, which makes the webhook's job trivial and — more useful —
 * makes a duplicate link for the same quote detectable at Razorpay's end rather than only at
 * ours.
 */
export function paymentLinkRequest(input: {
  quoteId: string;
  amountDue: number;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  sellerName: string;
  tenantId: string;
  /** `quotes.expires_date`, so the link does not outlive the price it collects. */
  expiresOn: string | null;
  /** Where the customer lands after paying. */
  callbackUrl?: string;
}): PaymentLinkRequest {
  const description = `${input.sellerName} — quote ${input.quoteId}`.slice(0, MAX_DESCRIPTION);

  const req: PaymentLinkRequest = {
    amount: toPaise(input.amountDue),
    currency: "INR",
    description,
    reference_id: input.quoteId,
    customer: {
      ...(input.customerName?.trim() ? { name: input.customerName.trim() } : {}),
      ...(input.customerEmail?.trim() ? { email: input.customerEmail.trim() } : {}),
      ...(input.customerPhone?.trim() ? { contact: input.customerPhone.trim() } : {}),
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
    /* Echoed back on the webhook. The tenant travels with the link so the webhook never has to
       take one from its own payload — a webhook that trusts a body-supplied tenant_id is a
       cross-tenant write waiting to happen, which is the same rule the telecall webhook follows. */
    notes: { tenant_id: input.tenantId, quote_id: input.quoteId },
  };

  if (input.callbackUrl) {
    req.callback_url = input.callbackUrl;
    req.callback_method = "get";
  }

  if (input.expiresOn) {
    const d = new Date(`${input.expiresOn}T23:59:59Z`);
    if (!Number.isNaN(d.getTime())) {
      /* Razorpay requires at least 15 minutes in the future; an already-expired quote would
         otherwise produce an API error rather than a readable refusal. */
      const seconds = Math.floor(d.getTime() / 1000);
      if (seconds > Math.floor(Date.now() / 1000) + 900) req.expire_by = seconds;
    }
  }

  return req;
}

/** Rs, whole rupees, Indian grouping. */
function rupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * The message that carries the link.
 *
 * States the amount and what it is for, and nothing else. No urgency, no "pay now to confirm
 * your price" — the volume rate is a published rate card and the quote's own expiry is the only
 * deadline there is.
 */
export function paymentLinkMessage(input: {
  customerName: string | null;
  quoteId: string;
  amountDue: number;
  url: string;
  mode: "live" | "test";
}): string {
  const who = input.customerName?.trim() ? `${input.customerName.trim()},` : "Hello,";
  const testWarning =
    input.mode === "test"
      ? "\n\n[TEST MODE — this link will not take a real payment. Do not send it to a customer.]"
      : "";

  return (
    `${who}\n\n` +
    `Here is the payment link for quote ${input.quoteId} — ${rupees(input.amountDue)}, ` +
    "including GST. It accepts UPI, cards and net banking.\n\n" +
    `${input.url}\n\n` +
    "The GST invoice follows automatically once the payment is confirmed." +
    testWarning
  );
}
