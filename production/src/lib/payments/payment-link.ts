/**
 * Building a Razorpay payment link — the decision and the request body.
 *
 * R-1608 built the quote half (not wired yet). R-2415 adds the INVOICE half used by Send
 * reminder: one link per open invoice / statement total (invoice_payment_links), reused,
 * replaced when the amount changes, booked once by the payment_link.paid webhook.
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

// ─── R-2415: one Razorpay link per open invoice / statement total ───────────

/** Tag on every invoice link's notes — payment.captured leaves such a payment to payment_link.paid. */
export const INVOICE_LINK_PURPOSE = "invoice_payment_link";

/** An invoice link lives 30 days; the next Send reminder after that makes a fresh one. */
export const INVOICE_LINK_TTL_DAYS = 30;

/** A link that expires within a day is replaced rather than sent. */
const EXPIRING_MS = 24 * 60 * 60 * 1000;

/** A "creating" row older than this was left by a crash — replace it. */
const CREATING_STUCK_MS = 2 * 60 * 1000;

export type InvoiceLinkScope = "invoice" | "statement";

/** One bill the link pays, frozen when the link is made (invoice_payment_links.allocations). */
export interface LinkAllocation {
  invoice_id: string;
  quote_id: string;
  /** Whole rupees. */
  amount: number;
}

/**
 * THE SEAM FOR R-2417. What the link asks for, in whole rupees.
 *
 * Today: the bill amount only — the business bears the online fee, and the webhook records the
 * bearer as before (recordFeeBearer). R-2417 changes THIS function to add `onlineFeeFor(...)`'s
 * fee + GST when the customer bears it (and books it on a debit note); invoice_payment_links
 * keeps `bill_amount` and `amount` apart for that, and settle_invoice_payment_link books only
 * the bill amounts.
 */
export function linkAmountFor(input: { billAmount: number }): number {
  return Math.round(input.billAmount);
}

export function invoiceLinkKey(scope: InvoiceLinkScope, id: string): string {
  return `${scope}:${id}`;
}

export interface ExistingInvoiceLink {
  status: string;
  amount: number;
  allocations: readonly LinkAllocation[];
  created_at: string;
  expires_at: string | null;
}

export type InvoiceLinkPlan =
  | { action: "create" }
  | { action: "reuse" }
  | { action: "wait" }
  | { action: "replace"; reason: "amount changed" | "bills changed" | "expiring" | "stuck" };

function allocationKey(a: readonly LinkAllocation[]): string {
  return a.map((x) => `${x.invoice_id}=${Math.round(x.amount)}`).sort().join("|");
}

/**
 * The live link (status creating/active) for this bill, against what the bill needs now.
 * Never a second live link: the unique index refuses one, and this says what to do instead.
 */
export function planInvoiceLink(
  existing: ExistingInvoiceLink | null,
  want: { amount: number; allocations: readonly LinkAllocation[] },
  nowMs: number,
): InvoiceLinkPlan {
  if (!existing) return { action: "create" };
  if (existing.status === "creating") {
    const age = nowMs - Date.parse(existing.created_at);
    return Number.isFinite(age) && age < CREATING_STUCK_MS ? { action: "wait" } : { action: "replace", reason: "stuck" };
  }
  if (Math.round(existing.amount) !== Math.round(want.amount)) return { action: "replace", reason: "amount changed" };
  if (allocationKey(existing.allocations) !== allocationKey(want.allocations)) return { action: "replace", reason: "bills changed" };
  if (existing.expires_at) {
    const left = Date.parse(existing.expires_at) - nowMs;
    if (Number.isFinite(left) && left < EXPIRING_MS) return { action: "replace", reason: "expiring" };
  }
  return { action: "reuse" };
}

export type NoCardLinkReason =
  | "nothing_due"
  | "not_invoice"
  | "no_own_quote"
  | "non_inr"
  | "not_open"
  | "not_configured"
  | "live_key_on_staging"
  | "busy"
  | "gateway_error"
  /** R-2439: a read (GET) found no live link that fits the bills — reads never make one. */
  | "not_made";

/**
 * Which bills may carry a Razorpay link, and for how much each.
 *
 * Only an open INR invoice of THIS customer with a quote of its own — the webhook books it with
 * record_payment on that quote (the same call as the desk's Record payment). A subscription line
 * has no invoice yet, and an instalment invoice is booked by record_instalment_payment, which needs
 * a signed-in company — those keep the UPI link only.
 */
export function invoiceLinkAllocations(input: {
  customerId: string;
  lines: readonly { kind: "invoice" | "subscription"; id: string; amountDue: number }[];
  invoices: readonly { id: string; customer_id: string | null; quote_id: string | null; currency: string | null; status: string }[];
  quotes: readonly { id: string; invoice_id: string | null }[];
}): { ok: true; allocations: LinkAllocation[] } | { ok: false; reason: NoCardLinkReason } {
  const lines = input.lines.filter((l) => Math.round(l.amountDue) > 0);
  if (lines.length === 0) return { ok: false, reason: "nothing_due" };
  const out: LinkAllocation[] = [];
  for (const l of lines) {
    if (l.kind !== "invoice") return { ok: false, reason: "not_invoice" };
    const inv = input.invoices.find((i) => i.id === l.id);
    if (!inv || inv.customer_id !== input.customerId || (inv.status !== "pending" && inv.status !== "overdue")) {
      return { ok: false, reason: "not_open" };
    }
    if ((inv.currency ?? "INR").trim().toUpperCase() !== "INR") return { ok: false, reason: "non_inr" };
    const q = inv.quote_id ? input.quotes.find((x) => x.id === inv.quote_id) : undefined;
    if (!q || q.invoice_id !== inv.id) return { ok: false, reason: "no_own_quote" };
    out.push({ invoice_id: inv.id, quote_id: q.id, amount: Math.round(l.amountDue) });
  }
  return { ok: true, allocations: out };
}

export interface CardLinkNotice {
  reason: NoCardLinkReason;
  text: string;
  action?: { label: string; href: string };
}

/** CLAUDE.md §24: why the message has no card / net-banking link, and the next step. */
export function cardLinkNotice(reason: NoCardLinkReason, detail?: string | null): CardLinkNotice | null {
  switch (reason) {
    case "nothing_due":
      return null;
    case "not_configured":
      return {
        reason,
        text: "No card / net-banking link — Razorpay is not connected. Save the Razorpay key in Settings → Integrations and the message will carry one.",
        action: { label: "Open Settings", href: "/settings?tab=integrations" },
      };
    case "live_key_on_staging":
      return { reason, text: detail?.trim() || "No card / net-banking link — a live Razorpay key cannot make links on this test copy." };
    case "not_invoice":
      return { reason, text: "No card / net-banking link — a subscription not yet invoiced has no bill to book it on. The UPI link still works; raise the invoice to get a card link." };
    case "no_own_quote":
      return { reason, text: "No card / net-banking link for an instalment bill — the UPI link still works. Record the payment when it comes." };
    case "non_inr":
      return { reason, text: "No card / net-banking link — Razorpay links here are in INR and this bill is in another currency." };
    case "not_open":
      return { reason, text: "No card / net-banking link — a bill on this message is paid or closed now. Reload Payment Follow-up and try again." };
    case "busy":
      return { reason, text: "The card / net-banking link is being made by someone else right now — press Draft again in a few seconds." };
    case "not_made":
      return { reason, text: "No card / net-banking link yet — it is made (or brought up to date) when you open Send reminder for this customer." };
    case "gateway_error":
      return { reason, text: `Could not make the card / net-banking link${detail ? ` (${detail.slice(0, 160)})` : ""}. The UPI link is in the message — try Draft again later.` };
  }
}

/**
 * The Razorpay request body for an invoice / statement link. Same rules as paymentLinkRequest:
 * paise via toPaise, Razorpay sends NO SMS / email / reminder (we send the reminder), and the
 * tenant travels in notes. `reference_id` is our invoice_payment_links row id (36 chars, under
 * Razorpay's 40) — Razorpay refuses a second link with the same reference.
 */
export function invoiceLinkRequest(input: {
  rowId: string;
  tenantId: string;
  scope: InvoiceLinkScope;
  /** Invoice number, or "3 bills" for a statement. */
  label: string;
  /** Whole rupees — from linkAmountFor. */
  amount: number;
  sellerName: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  nowMs: number;
}): PaymentLinkRequest {
  const what = input.scope === "invoice" ? `invoice ${input.label}` : `statement, ${input.label}`;
  return {
    amount: toPaise(input.amount),
    currency: "INR",
    description: `${input.sellerName.trim() || "Payment"} — ${what}`.slice(0, MAX_DESCRIPTION),
    reference_id: input.rowId,
    customer: {
      ...(input.customerName?.trim() ? { name: input.customerName.trim() } : {}),
      ...(input.customerEmail?.trim() ? { email: input.customerEmail.trim() } : {}),
      ...(input.customerPhone?.trim() ? { contact: input.customerPhone.trim() } : {}),
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { tenant_id: input.tenantId, purpose: INVOICE_LINK_PURPOSE, link_row: input.rowId },
    expire_by: Math.floor((input.nowMs + INVOICE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000) / 1000),
  };
}

/** True when a captured payment came through one of our invoice links (its notes carry the tag). */
export function isInvoiceLinkPayment(
  paymentNotes: Record<string, unknown> | null | undefined,
  orderNotes: Record<string, unknown> | null | undefined,
): boolean {
  return paymentNotes?.purpose === INVOICE_LINK_PURPOSE || orderNotes?.purpose === INVOICE_LINK_PURPOSE;
}

export interface PaymentLinkPaid {
  linkId: string;
  paymentId: string;
  /** What Razorpay actually captured, in paise. */
  paidPaise: number;
  currency: string;
  method: string | null;
  orderId: string | null;
  notes: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The payment_link.paid body, read defensively — null when it names no captured payment. */
export function parsePaymentLinkPaid(body: unknown): PaymentLinkPaid | null {
  if (!isObj(body) || !isObj(body.payload)) return null;
  const pl = isObj(body.payload.payment_link) && isObj(body.payload.payment_link.entity) ? body.payload.payment_link.entity : null;
  const pay = isObj(body.payload.payment) && isObj(body.payload.payment.entity) ? body.payload.payment.entity : null;
  if (!pl || !pay) return null;
  const linkId = typeof pl.id === "string" ? pl.id.trim() : "";
  const paymentId = typeof pay.id === "string" ? pay.id.trim() : "";
  const paidPaise = typeof pay.amount === "number" && Number.isInteger(pay.amount) ? pay.amount : NaN;
  if (!linkId.startsWith("plink_") || !paymentId.startsWith("pay_") || !(paidPaise > 0)) return null;
  if (pay.status !== "captured") return null;
  const notes: Record<string, string> = {};
  if (isObj(pl.notes)) for (const [k, v] of Object.entries(pl.notes)) if (typeof v === "string") notes[k] = v;
  return {
    linkId,
    paymentId,
    paidPaise,
    currency: typeof pay.currency === "string" ? pay.currency : "INR",
    method: typeof pay.method === "string" ? pay.method : null,
    orderId: typeof pay.order_id === "string" ? pay.order_id : null,
    notes,
  };
}

/**
 * Put the card / net-banking link into a reminder, next to the UPI link: right after the UPI
 * line, else before "Please ignore…", else before the "— <company> team" sign-off, else at the
 * end. Never twice.
 */
export function withCardPayLink(message: string, url: string): string {
  if (message.includes(url)) return message;
  const line = `Pay by card / UPI / net banking: ${url}`;
  const lines = message.split("\n");
  const upi = lines.findIndex((l) => l.includes("upi://"));
  if (upi >= 0) {
    lines.splice(upi + 1, 0, line);
    return lines.join("\n");
  }
  const ignore = lines.findIndex((l) => /^please ignore/i.test(l.trim()));
  if (ignore >= 0) {
    lines.splice(ignore, 0, line, "");
    return lines.join("\n");
  }
  let sign = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[—-]\s/.test(lines[i].trim())) { sign = i; break; }
  }
  if (sign > 0) {
    lines.splice(sign, 0, line);
    return lines.join("\n");
  }
  return `${message}\n\n${line}`;
}
