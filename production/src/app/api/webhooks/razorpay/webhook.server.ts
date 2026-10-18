/**
 * POST /api/webhooks/razorpay
 *
 * Razorpay webhook handler. Razorpay POSTs payment lifecycle events here
 * (configured in Razorpay dashboard → Settings → Webhooks).
 *
 * Events we care about:
 *   - `payment.captured`  — money actually moved into our settlement balance
 *   - `order.paid`        — Razorpay considers the order complete
 *   - `payment.failed`    — note on the lead + a retry link to the SAME quote (R-079);
 *                           never a new charge
 *   - `refund.processed`  — R-045: a note on the lead + an owner notification saying what to
 *                           book (credit note first if invoiced). Once per refund id. Never
 *                           refunds, credit-notes or changes a payment's status by itself.
 *
 * R-045: on a capture we also keep Razorpay's fee + GST on the fee (whole rupees) on the
 * payment row, so cash settled = amount − gateway_fee and the bank line can be matched.
 *
 * For each successful capture, we:
 *   1. Verify the HMAC signature using RAZORPAY_WEBHOOK_SECRET (must be set!)
 *   2. Look up the quote via the order's `receipt` (we stored quote ID there)
 *   3. Call record_payment RPC — flips quote/lead/customer atomically
 *   4. Issue the GST tax invoice through generate_invoice (R-079), once, idempotently
 *   5. Send order-confirmation email to the customer, with the invoice link
 *
 * Security: this route is PUBLIC (no auth). Signature verification is the
 * ONLY thing that protects against forged payment events. If the secret
 * isn't set in env, we reject every request — fail closed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import { sendCustomerEmail, sendInternalEmail } from "@/lib/messaging";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { ownerPaymentAlertAllowed, storefrontVoice } from "@/lib/email/storefront-voice";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { razorpayMode } from "@/lib/payments/razorpay-readiness";
import { decideProvisioning, testPaymentProvisioningAllowed } from "@/lib/provisioning/provisioning";
import { queueProvisioning } from "@/lib/provisioning/provisioning.server";
import { provisioningProducts, productAmountPaid } from "@/lib/provisioning/products";
import { domainRegistrationEnabled, hostingProvisioningEnabled } from "@/lib/provisioning/domain-registration";
import {
  DOMAIN_RENEWAL_PLAN,
  domainRenewalEnabled,
  domainSubscriptionInsert,
  domainSubscriptionsToCreate,
} from "@/lib/domains/renewal";
import { HOSTING_RENEWAL_PLAN, hostingRenewalEnabled } from "@/lib/hosting/renewal";
import { commandsConfigured } from "@/lib/dms-engine/commands";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";
import { issueInvoiceForOnlinePayment } from "@/lib/checkout/online-invoice.server";
import { isProductionDeployment } from "@/lib/checkout/live-guards";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { gatewayFeeFromPayment, parseRefund, refundAdvice } from "@/lib/razorpay/gateway-money";
import { bookGatewayFeeExpense } from "@/lib/razorpay/fee-expense.server";
import {
  receivedOnQuote, settleLatePayment, settleOnReplacedQuote, settleStaleRenewal, STALE_RENEWAL_RE, type LateArgs,
} from "./late-payment.server";
import { domainItemIdsForQuote, vendorForQuote } from "./quote-vendor.server";

import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import { applyGatewayEvent, type MandateStatus } from "@/lib/payments/mandate";
import type { PaymentMandateInsertT as PaymentMandateInsert } from "@/lib/supabase/database.types";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";
import { customerSetupSteps, leadOwnerNextSteps } from "@/lib/email/workspace-onboarding";
import { loadLeadOwner } from "@/lib/email/lead-owner.server";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

/*
 * There is deliberately NO fallback recipient here any more.
 *
 * A `FALLBACK_OWNER_EMAIL = "Pardeep@example.test"` used to sit at this
 * line, reached via `seller.email?.trim() || FALLBACK_OWNER_EMAIL`. Its comment
 * argued it was better than "silently dropping" the alert. That reasoning does not
 * survive being written down: the alert was not dropped, it was DELIVERED — to a
 * third party, on a domain the company no longer uses (CLAUDE.md §1), carrying
 * another tenant's customer name, email, domain and amount. A misdirected alert is
 * worse than a missing one, because the missing one gets noticed.
 *
 * It also hid from the guard test. `lib/email/no-hardcoded-recipient.test.ts`
 * scans for a literal at `to:`; this one reached `to:` through a variable, so the
 * route looked clean while the other four looked guilty. Removing the constant is
 * what makes the guard true here, not just green.
 *
 * The payment itself is already committed by `record_payment` before this point,
 * so an unaddressable alert loses a notification and never the money. It is
 * logged loudly and counted in the response instead.
 */

export interface RazorpayPayment {
  id:         string;
  order_id:   string;
  amount:     number;            // paise
  currency:   string;
  status:     string;
  method:     string;
  email?:     string;
  contact?:   string;
  notes?:     Record<string, string>;
  /** R-045: Razorpay's fee INCLUDING GST on it, and the GST part — paise, on captured payments. */
  fee?:       number | null;
  tax?:       number | null;
  /** payment.failed only — Razorpay's own words for why. */
  error_code?:        string | null;
  error_description?: string | null;
  error_reason?:      string | null;
}

export interface RazorpayOrder {
  id:         string;
  receipt:    string;             // We set this to the quote ID
  amount:     number;
  notes?:     Record<string, string>;
}

interface RazorpayWebhookBody {
  event:    string;
  payload:  {
    payment?: { entity: RazorpayPayment };
    order?:   { entity: RazorpayOrder };
    /** refund.* only — read through parseRefund, never trusted as typed. */
    refund?:  { entity: unknown };
  };
  created_at: number;
}

/** Verify Razorpay's HMAC SHA256 signature header against a given secret. */
/**
 * S24 (2 Oct 2026): which tenant's records may a VERIFIED event act on?
 *
 * Verified with a tenant's OWN secret (the ?tenant= URL we hand out) → only that tenant.
 * Verified with the GLOBAL env secret → only a tenant that has NO secret of its own: the
 * env keys are the checkout fallback for exactly those tenants (api/public/checkout).
 *
 * Before this, a global-secret event — no ?tenant=, or a ?tenant= whose tenant has no
 * secret, which silently fell back to the global one — skipped the cross-check entirely,
 * so one signing key could settle any tenant's quote or mandate.
 */
function makeTenantGate(
  admin: ReturnType<typeof createAdminClient>,
  tenantParam: string | null,
  verifiedWithOwnSecret: boolean,
) {
  return async (recordTenant: string): Promise<boolean> => {
    if (verifiedWithOwnSecret) return recordTenant === tenantParam;
    if (tenantParam && recordTenant !== tenantParam) return false;
    const { data: ts } = await admin
      .from("tenant_secrets")
      .select("razorpay_webhook_secret")
      .eq("tenant_id", recordTenant)
      .maybeSingle();
    return !decryptTenantSecrets(ts)?.razorpay_webhook_secret;
  };
}

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // timingSafeEqual avoids leaking timing info to attackers
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Always read the raw body for signature verification BEFORE parsing JSON.
  const rawBody   = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  const admin = createAdminClient();

  // Resolve the signing secret. Razorpay is configured PER TENANT (the webhook
  // URL we hand out carries ?tenant=<id>), so verify against THAT tenant's
  // stored webhook secret. Fall back to a global env secret for legacy setups.
  const tenantParam = request.nextUrl.searchParams.get("tenant");
  let signingSecret = WEBHOOK_SECRET;
  let verifiedWithOwnSecret = false;
  let keyIdForMode: string | null = null;
  if (tenantParam) {
    const { data: ts } = await admin
      .from("tenant_secrets")
      .select("razorpay_webhook_secret, razorpay_key_id")
      .eq("tenant_id", tenantParam)
      .maybeSingle();
    // Decrypt before use — an envelope string would never match the HMAC and the
    // failure would look like Razorpay sending bad signatures.
    const tsPlain = decryptTenantSecrets(ts);
    if (tsPlain?.razorpay_webhook_secret) { signingSecret = tsPlain.razorpay_webhook_secret; verifiedWithOwnSecret = true; }
    /* The KEY, not a stored mode column. Razorpay encodes live-vs-test in the key prefix and a
       separate column can drift from the key it describes — razorpay-readiness.ts says so. */
    keyIdForMode = tsPlain?.razorpay_key_id ?? null;
  }

  if (!verifySignature(rawBody, signature, signingSecret)) {
    console.error("[webhooks/razorpay] signature verification FAILED", { tenant: tenantParam ?? "(none)", hadSecret: Boolean(signingSecret) });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const mayActOn = makeTenantGate(admin, tenantParam, verifiedWithOwnSecret);

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.event;
  console.log("[webhooks/razorpay] event:", event);

  /* ── Mandate lifecycle ────────────────────────────────────────────────────
     Handled BEFORE the payment filter below, because this is the only place in the
     whole system entitled to write `active` on a payment mandate. The signature has
     already been verified against THIS tenant's secret above; nothing downstream of
     that check can be forged. See lib/payments/mandate.ts. */
  if (event.startsWith("subscription.")) {
    return handleMandateEvent(admin, event, rawBody, tenantParam, mayActOn);
  }

  /* R-079: a failed payment is no longer only a log line — the lead gets a note and the
     buyer gets a link back to the SAME quote. Nothing is charged again from here. */
  if (event === "payment.failed") {
    return handlePaymentFailed(admin, body, tenantParam, trustedOrigin(request.headers), mayActOn);
  }

  /* R-045: the money already went back to the buyer at Razorpay — tell the desk what to book. */
  if (event === "refund.processed") {
    return handleRefundProcessed(admin, body, tenantParam, mayActOn);
  }

  // Only act on payment-success events — ignore authorized / etc.
  if (event !== "payment.captured" && event !== "order.paid") {
    return NextResponse.json({ received: true, ignored: event });
  }

  return settleCapturedPayment(admin, {
    request,
    event,
    payment: body.payload.payment?.entity,
    order: body.payload.order?.entity,
    keyIdForMode,
    mayActOn,
  });
}

/** What settleCapturedPayment needs — from a verified webhook or from checkout/verify. */
export interface CaptureInput {
  /** For the public origin of the invoice link in the confirmation email (R-723). */
  request: { headers: Headers };
  /** "payment.captured" / "order.paid" from Razorpay, or "checkout.verify" (R-1596). */
  event: string;
  payment?: RazorpayPayment;
  order?: RazorpayOrder;
  /** The tenant's Razorpay key id — its prefix says test or live. */
  keyIdForMode: string | null;
  /** May this verified caller act on a record of that tenant? */
  mayActOn: (tenantId: string) => Promise<boolean>;
}

/**
 * Settle one captured Razorpay payment on its quote: record_payment, the GST invoice,
 * activation, the domain subscriptions and the confirmation emails.
 *
 * R-1596: shared by the webhook and by POST /api/public/checkout/verify (the buyer back from
 * Razorpay), so an order is completed by whichever arrives first. It is idempotent per
 * Razorpay payment id — the payments-ledger lookup below, then record_payment's own
 * already_recorded under its row lock — so the second caller is a no-op. The caller must
 * already have proved the payment genuine (webhook signature, or checkout signature plus
 * Razorpay's own API record).
 */
export async function settleCapturedPayment(
  admin: ReturnType<typeof createAdminClient>,
  { request, event, payment, order, keyIdForMode, mayActOn }: CaptureInput,
): Promise<NextResponse> {
  if (!payment && !order) {
    console.error("[webhooks/razorpay] no payment or order in payload");
    return NextResponse.json({ error: "No payment or order in payload" }, { status: 400 });
  }

  const orderId = payment?.order_id ?? order?.id;
  const receipt = order?.receipt ?? payment?.notes?.quoteId;
  const notes   = payment?.notes ?? order?.notes ?? {};

  if (!orderId || !receipt) {
    console.error("[webhooks/razorpay] missing orderId or receipt", { orderId, receipt });
    return NextResponse.json({ error: "Missing orderId or receipt" }, { status: 400 });
  }

  // ── Look up the quote we created at checkout time ─────────────────────
  const { data: quote, error: qErr } = await admin
    .from("quotes")
    .select("id, tenant_id, customer_name, amount, payment_status, lead_id, seats, plan, line_items, is_renewal, status, superseded_by")
    .eq("id", receipt)
    .single();

  if (qErr || !quote) {
    console.error("[webhooks/razorpay] quote not found:", receipt, qErr);
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // Defense: the quote must belong to the tenant whose secret verified this
  // event (prevents a valid-for-tenant-A signature acting on tenant-B's quote).
  // S24: checked for EVERY event now, including ones verified by the global secret.
  if (!(await mayActOn(quote.tenant_id))) {
    console.error("[webhooks/razorpay] tenant mismatch", { event, quoteTenant: quote.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  /* Idempotency — Razorpay delivers the same payment more than once (payment.captured AND
     order.paid, plus retries). R-079: the payment row is the durable fact. R-1569: it is the
     ONLY test now. Until 18 Oct a quote already marked 'received' answered alreadyProcessed
     for ANY event — a NEW payment id included — so a customer who paid online after the desk
     had recorded their bank transfer paid real money the app never recorded. The lookup is
     tenant-wide (not this quote only) because R-1575 records a payment on a replaced quote
     against the quote that replaced it. The order id is matched too: an order.paid that
     carried no payment entity was recorded under it. */
  {
    const refs = payment?.id ? [payment.id, orderId] : [orderId];
    const { data: seen } = await admin
      .from("payments")
      .select("id, quote_id")
      .eq("tenant_id", quote.tenant_id)
      .in("reference", refs)
      .eq("status", "received")
      .limit(1);
    if (seen && seen.length) {
      const seenQuote = (seen[0] as { quote_id?: string | null }).quote_id ?? quote.id;
      console.log("[webhooks/razorpay] payment already recorded:", refs[0], "on", seenQuote);
      /* An order.paid that landed first may have carried no fee; the payment.captured that
         follows does. Writing the same numbers twice is harmless. */
      if (payment?.id) await recordGatewayFee(admin, quote.tenant_id, seenQuote, payment.id, payment);
      return NextResponse.json({ received: true, alreadyProcessed: true });
    }
  }

  /* R-1569 / R-1575: a quote that is replaced, rejected, or already paid in full takes no
     NORMAL settlement (no invoice, no activation, no "thank you" mail) — but the money is
     real and is always recorded or reported to the owner. */
  const lateArgs = (p: RazorpayPayment): LateArgs => ({
    quote, payment: p, event, orderId,
    recordFee: (a, t, q, ref) => recordGatewayFee(a, t, q, ref, p),
  });
  const closedQuote = Boolean(quote.superseded_by) || quote.status === "rejected";
  const priorReceived = await receivedOnQuote(admin, quote.tenant_id, quote.id);
  const alreadySettled =
    quote.payment_status === "received" || (priorReceived > 0 && priorReceived >= (quote.amount ?? 0));
  if (closedQuote || alreadySettled) {
    if (!payment?.id) {
      /* An order-only event names no payment: there is nothing to tell a new payment from a
         repeat by. The payment.captured for the same money carries the id and lands below. */
      console.log("[webhooks/razorpay] order-only event on a settled/closed quote:", receipt);
      return NextResponse.json({ received: true, alreadyProcessed: true });
    }
    return closedQuote
      ? settleOnReplacedQuote(admin, lateArgs(payment))
      : settleLatePayment(admin, lateArgs(payment));
  }

  // ── Call record_payment RPC — atomically:
  //   • mark quote as paid
  //   • flip lead stage to 'won'
  //   • upsert customer + subscription
  //   • roll forward renewal_date
  const paymentAmount = payment?.amount
    ? Math.round(payment.amount / 100)
    : (quote.amount ?? 0);
  // Razorpay's `method` values (card/upi/netbanking/wallet/emi) don't map 1:1
  // to our enum (upi/razorpay/bank_transfer/cheque/cash/other). UPI passes
  // through, everything else collapses to 'razorpay' so the RPC accepts it.
  const paymentMethod: "upi" | "razorpay" =
    payment?.method === "upi" ? "upi" : "razorpay";
  const paymentRef    = payment?.id ?? orderId;

  if (paymentAmount <= 0) {
    console.error("[webhooks/razorpay] zero/negative payment amount — refusing to record");
    return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 });
  }

  /* Which subscription does this quote RENEW, if any? Read BEFORE record_payment, which
     rolls it forward and clears the link. Until 25 Sep 2026 every paid quote was read as a
     sale, so a paid domain renewal was queued as a REGISTRATION of a domain the customer
     already owns, and a paid hosting renewal as a NEW account, with DMS's expiry never
     moved. */
  const { data: renewedSub } = await admin
    .from("subscriptions")
    .select("id, domain, vendor")
    .eq("tenant_id", quote.tenant_id)
    .eq("renewal_quote_id", quote.id)
    .maybeSingle();

  const { data: recorded, error: rpcErr } = await admin.rpc("record_payment", {
    p_quote_id:  quote.id,
    p_amount:    paymentAmount,
    p_method:    paymentMethod,
    p_reference: paymentRef,
    p_notes:     `Razorpay ${event} · order ${orderId}`,
  });

  if (rpcErr) {
    /* R-025. `detail` handed Postgres's own text back over a PUBLIC endpoint — this
       route is called by Razorpay, so anybody who can reach the URL can read it, and a
       42703/23505 there names our tables and constraints. The server log keeps the
       whole thing; the response keeps our own guard wording and nothing else. */
    logDbError("webhooks/razorpay:record_payment", rpcErr);
    /* R-1569 × R-1574: record_payment refuses the first payment on a renewal quote whose
       term was already renewed (P0001, "…that term was already renewed…"). A 500 here would
       have Razorpay retry for a day and the money would never be booked. The money goes to
       the subscription's CURRENT renewal quote, or — if there is none — the owner is told. */
    if (payment?.id && STALE_RENEWAL_RE.test(rpcErr.message ?? "")) {
      return settleStaleRenewal(admin, lateArgs(payment));
    }
    return NextResponse.json(
      { error: safeDbMessage(rpcErr, "Payment processing failed") },
      { status: 500 },
    );
  }

  /* S24: the checks above are read-then-act, so two deliveries of one payment arriving
     together (Razorpay sends payment.captured AND order.paid, and retries) both pass them.
     record_payment is the serialising point — it locks the quote row and, for a payment id
     it already holds, answers already_recorded instead of writing again. Exactly one
     delivery gets past this line; the other stops before the invoice, provisioning and
     every email below. */
  if ((recorded as { already_recorded?: boolean } | null)?.already_recorded) {
    console.log("[webhooks/razorpay] concurrent duplicate stopped at record_payment:", paymentRef, "on", receipt);
    return NextResponse.json({ received: true, alreadyProcessed: true });
  }

  /* R-045: what Razorpay kept. Best-effort — the payment is committed either way. */
  if (payment?.id) await recordGatewayFee(admin, quote.tenant_id, quote.id, paymentRef, payment);

  /* ── THE GST TAX INVOICE (R-079) ─────────────────────────────────────────
     Through generate_invoice — the desk's own issuing path — right after the payment is
     committed and before the confirmation email, which links it. A refusal (most often:
     no state on record, so the place of supply is unknown) leaves a note on the lead and
     never fails the webhook: the money is recorded either way. */
  const invoice = await issueInvoiceForOnlinePayment(admin, {
    quoteId: quote.id,
    tenantId: quote.tenant_id,
    logTag: "[webhooks/razorpay]",
  });

  /* In-app khabar (audit B4) — record_payment COMMIT ke baad, best-effort. */
  await notifyTenantOwners({
    tenantId: quote.tenant_id,
    kind: "payment.received",
    title: `Payment received — ${rupee(paymentAmount)} on ${quote.id}`,
    body: `Razorpay ${event} · ${quote.customer_name ?? ""}`,
    href: `/quotes/${quote.id}`,
    entityId: quote.id,
  });
  /* R-1569: a part-paid quote paid through an order made before the desk's part-payment
     (that order still asks for the whole amount) — the excess is credit; say so. */
  const overpaidCredit = Number((recorded as { overpaid_credit?: number } | null)?.overpaid_credit) || 0;
  if (overpaidCredit > 0) {
    await notifyTenantOwners({
      tenantId: quote.tenant_id,
      kind: "payment.received", // R-1569 alert — entityId is the Razorpay payment id
      title: `Zyada paisa aaya — ${rupee(overpaidCredit)} credit on ${quote.id}`,
      body: `${quote.customer_name ?? "Customer"} ne Razorpay se ${rupee(paymentAmount)} pay kiya (${paymentRef}); quote par pehle se paisa tha, ${rupee(overpaidCredit)} customer credit bana. Refund karo ya agle bill me lagao.`,
      href: `/quotes/${quote.id}`,
      entityId: paymentRef,
    });
  }

  /* ── QUEUE THE ACTIVATION ────────────────────────────────────────────────
     Placed after `record_payment` has committed, on purpose: the money being recorded is the
     fact this depends on, and a provisioning row written before it could outlive a failed RPC.

     `decideProvisioning` decides whether this may activate itself, and today it never can —
     the Google reseller API is not connected and this deployment's Razorpay key is a TEST key,
     which settles zero rupees while looking identical to a real payment. Auto-activating
     against that would hand out seats for free at machine speed. So the seats are QUEUED with
     the blocker in words, and the desk gets "paid, awaiting activation" instead of the nothing
     it sees today. See lib/provisioning/provisioning.ts. */
  /* Resolved from the catalogue, not from the plan's wording — a hosting tier is
     named "Starter" and says nothing about hosting. See vendorForQuote. */
  const provisioningVendor = await vendorForQuote(admin, quote.line_items, quote.plan);
  const domainItemIds = await domainItemIdsForQuote(admin, quote.line_items);
  const provisioningDomain = (notes.domain as string | undefined)?.trim() || null;

  /* One request per PRODUCT (24 Sep 2026). A cart can buy a domain and a hosting
     account in one payment; picking a single vendor left the paid domain queued for
     nobody. Each product gets the same gate as before, on its own vendor and domain. */
  const dialMode = (await loadAutonomyPolicy(quote.tenant_id)).modes?.["provisioning.activate"] ?? "off";
  /* A paid RENEWAL is never read from the lines, which would make it a new sale:
       domain  → renew that domain (DOMAIN_RENEWAL_PLAN row, renew-domains worker);
       hosting → extend that account in DMS (HOSTING_RENEWAL_PLAN row, renew-hosting worker);
       anything else (a Workspace / M365 / Zoho licence) → nothing to activate: the licence
       is already running, the payment only settles its next term.
     A quote marked as a renewal whose subscription cannot be found is not guessed at: it
     queues nothing, loudly. */
  const isRenewal = Boolean(renewedSub) || Boolean(quote.is_renewal);
  const renewalDomain = renewedSub?.domain?.trim().toLowerCase() || null;
  const renewalPlan =
    renewedSub?.vendor === "domain" ? DOMAIN_RENEWAL_PLAN : renewedSub?.vendor === "hosting" ? HOSTING_RENEWAL_PLAN : null;
  if (quote.is_renewal && !renewedSub) {
    console.error(`[webhooks/razorpay] ${quote.id} is a renewal quote but no subscription points at it, so nothing was queued. Find the subscription it renews and extend it by hand.`);
  } else if (renewedSub && !renewalPlan) {
    console.log(`[webhooks/razorpay] ${quote.id} renews a ${renewedSub.vendor} subscription — nothing to activate.`);
  }
  const products = isRenewal
    ? renewalPlan && renewalDomain
      ? [{ vendor: renewedSub!.vendor as "domain" | "hosting", domain: renewalDomain, seats: 1 }]
      : []
    : provisioningProducts({
        lineItems: quote.line_items,
        vendor: provisioningVendor,
        domain: provisioningDomain,
        seats: Number(quote.seats ?? 0),
        domainItemIds,
      });

  for (const product of products) {
    const provisioning = decideProvisioning({
      paymentMode: razorpayMode(keyIdForMode),
      /* The signature verified and the amount was checked above — those two together are what
         "verified" means here, and nothing weaker reaches this line. */
      paymentVerified: true,
      amountPaid: paymentAmount,
      amountExpected: quote.amount ?? paymentAmount,
      vendor: product.vendor,
      seats: product.seats,
      /* No adapter exists — `src/lib/google-csp/` is absent. Hardcoded false rather than a
         config read, because a config that could say "true" would be a config that can lie. */
      vendorApiConfigured: false,
      domainName: product.domain,
      /* HOSTING is provisioned by us directly on DirectAdmin (2 Sep 2026), so it IS
         connected — but only once the same explicit go-live gate the trial uses is on
         (HOSTING_TRIAL_LIVE=1 + DA credentials present).
         DOMAIN (owner decision 21, 24 Sep 2026): connected only when this side's own
         fail-closed switch DOMAIN_REGISTRATION_LIVE=1 is on AND the engine command
         key is configured. Otherwise the row is queued with `engine_not_connected`
         and the register-domains worker never picks it up. The engine has a second,
         independent gate and the spend limit (DMS engine-register-policy.ts). */
      /* HOSTING (24 Sep 2026): provisioned by the DMS engine's hosting.provision,
         so it is connected when THIS side's switch HOSTING_PROVISIONING_LIVE=1 is
         on and the engine command key is set — no longer this app's own
         DirectAdmin credentials, which only the hosting trial still uses. */
      engineConnected:
        product.vendor === "hosting"
          ? (renewalPlan ? hostingRenewalEnabled() : hostingProvisioningEnabled()) && commandsConfigured()
          : product.vendor === "domain"
            ? (renewalPlan ? domainRenewalEnabled() : domainRegistrationEnabled()) && commandsConfigured()
            : false,
      dialMode,
      allowTestPayment: testPaymentProvisioningAllowed(),
    });

    if (provisioning.action !== "refuse") {
      const queued = await queueProvisioning({
        tenantId:    quote.tenant_id,
        quoteId:     quote.id,
        vendor:      product.vendor,
        seats:       product.seats,
        domain:      product.domain,
        // Renewal rows carry their plan marker; the new-sale workers skip them. A hosting
        // account in a several-plan order carries ITS plan, not the quote's first (R-032).
        plan:        renewalPlan ?? product.plan ?? quote.plan ?? null,
        /* R-033: this product's own share of the payment, not the whole order — the
           engine's spend check (paid ≥ cost) reads it per row. A renewal is one product
           and its quote is that renewal, so its share is the whole payment. */
        amountPaid:  isRenewal ? paymentAmount : productAmountPaid(product, quote.line_items, paymentAmount, domainItemIds),
        paymentMode: razorpayMode(keyIdForMode),
        blocker:     provisioning.action === "queue" ? provisioning.blocker : null,
        note:        provisioning.reason,
        // R-031: a new domain sale carries its paid term; a renewal is one year (renew-domains).
        years:       isRenewal ? 1 : product.years,
      });
      console.log(`[webhooks/razorpay] provisioning ${queued} for ${quote.id} ${product.vendor}${product.domain ? ` ${product.domain}` : ""} — ${provisioning.reason}`);
    } else {
      console.warn(`[webhooks/razorpay] not provisioning ${quote.id} ${product.vendor} — ${provisioning.reason}`);
    }
  }

  /* ── A yearly subscription for each domain this sale bought ─────────────────
     So the domain comes up for renewal (owner, 25 Sep 2026). Only on a first sale: a
     renewal quote rolls its existing subscription forward in record_payment. Written
     here rather than through record_payment's line `commitment`, which keeps one
     subscription per (quote, domain) and would drop it when hosting shares the name.
     Best-effort and logged: the payment is already recorded. */
  if (!isRenewal) {
    const toCreate = domainSubscriptionsToCreate(quote.line_items, domainItemIds);
    if (toCreate.length) {
      const { data: paidQuote } = await admin
        .from("quotes").select("customer_id").eq("id", quote.id).eq("tenant_id", quote.tenant_id).maybeSingle();
      const customerId = (paidQuote as { customer_id?: string | null } | null)?.customer_id ?? null;
      if (!customerId) {
        console.error(`[webhooks/razorpay] ${quote.id}: paid, but no customer to hang domain subscriptions on — ${toCreate.map((d) => d.domain).join(", ")} will not come up for renewal. Add them by hand.`);
      } else {
        const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST (AGENTS.md §6)
        for (const row of toCreate) {
          const { data: existing } = await admin
            .from("subscriptions").select("id")
            .eq("tenant_id", quote.tenant_id).eq("vendor", "domain").eq("domain", row.domain).eq("status", "active")
            .limit(1);
          if (existing && existing.length) continue;
          const { error: subErr } = await admin.from("subscriptions").insert(
            domainSubscriptionInsert({ tenantId: quote.tenant_id, customerId, customerName: quote.customer_name ?? "", row, today }),
          );
          if (subErr) console.error(`[webhooks/razorpay] ${quote.id}: domain subscription for ${row.domain} NOT created — ${subErr.message}. It will not come up for renewal; add it by hand.`);
        }
      }
    }
  }

  // ── Send confirmation emails (best-effort) ────────────────────────────
  // The alert goes to the tenant that made the sale — resolved from the quote's
  // own tenant_id, so it can never be another tenant's inbox.
  const { alert: owner, tenant: sellerTenant } = await loadOwnerAlert(admin, quote.tenant_id);
  const seller = sellerTenant ?? {};
  if (!owner.ok) {
    /* The payment IS recorded — record_payment committed above. Only the alert has
       nowhere to go, and that is said out loud rather than redirected. */
    console.error(`[webhooks/razorpay] payment ${paymentRef} recorded for tenant ${quote.tenant_id}, but no owner alert: ${owner.reason}`);
  }
  const sellerName   = seller.name?.trim() || "your reseller";
  const sellerPerson = seller.contact_name?.trim() || sellerName;
  const sellerPhone  = seller.phone?.trim() || "";
  /* The storefront signs as the company and takes replies at support (lib/email/storefront-voice.ts);
     a reseller tenant signs as itself and takes replies at its owner's address. */
  const voice = storefrontVoice(quote.tenant_id);
  const customerReplyTo = voice ? voice.replyTo : owner.ok ? owner.to : null;
  const contactWho = voice ? "our team" : sellerPerson;
  const customerSignOff = voice ? voice.signOff : `— ${sellerPerson}\n   ${sellerName}`;

  const customerEmail = payment?.email ?? notes.email ?? "";
  const customerName  = notes.contact ?? notes.customerName ?? "";
  const tierName      = notes.tierName ?? "Google Workspace";
  const seats         = notes.seats   ?? String(quote.seats ?? "");
  const domain        = notes.domain  ?? "";
  const amountFmt     = `₹${paymentAmount.toLocaleString("en-IN")}`;

  // Hosting orders get hosting wording (not "live on Google Workspace") and the
  // provisioning worker sends the cPanel login separately.
  const isHostingOrder = provisioningVendor === "hosting" || (quote.plan ?? "").startsWith("hosting-");
  // The GST invoice record_payment just created — link it in the email so the
  // "you'll get your invoice" line is true, not a promise nothing keeps.
  const { data: paidQuote } = await admin.from("quotes").select("invoice_id").eq("id", quote.id).maybeSingle();
  /* The base comes from THIS REQUEST, not from WEBHOOK_APP_URL.
     That constant falls back to `https://resellersos.web.app`, which answers
     503 (measured 23 Sep 2026; L91 measured it a month earlier). This link is
     not an internal one — it goes straight into the customer's order
     confirmation under the heading "YOUR GST TAX INVOICE", after they have
     paid. With NEXT_PUBLIC_APP_URL unset at build, that is a statutory
     document link pointing at a dead host.
     Razorpay calls our public webhook URL, so this request's origin IS a
     public origin for us, needs no configuration, and stays right even though
     this service answers on more than one hostname (L18). */
  const publicBase = trustedOrigin(request.headers); // R-723: allowlisted host or NEXT_PUBLIC_APP_URL
  const leadOwner = await loadLeadOwner(admin, quote.tenant_id, quote.lead_id);
  const invoiceUrl = paidQuote?.invoice_id
    ? pdfDownloadUrl(publicBase, "invoice", String(paidQuote.invoice_id), quote.tenant_id)
    : null;
  const invoiceLine = invoiceUrl
    ? `YOUR GST TAX INVOICE\n  ${invoiceUrl}`
    : `Your GST tax invoice will reach you by email shortly.`;
  const whatNext = isHostingOrder
    ? `WHAT HAPPENS NEXT\n  • Your hosting account is being set up now\n  • You'll get a separate email with your control-panel login\n  • Moving from another host? Reply and we'll migrate you free`
    /* R-120: the whole setup, step by step — who does what, with the exact DNS values. */
    : customerSetupSteps({ domain, seats, tierName, contactName: leadOwner?.name ?? sellerPerson, contactPhone: sellerPhone });
  const productDesc = isHostingOrder ? tierName : `${seats} users of ${tierName}`;

  await Promise.allSettled([
    // Customer order confirmation
    customerEmail && customerReplyTo && sendCustomerEmail({
      to:      customerEmail,
      from:    FROM_EMAIL,
      replyTo: customerReplyTo,
      kind:    "razorpay_payment_customer",
      route:   { tenantId: quote.tenant_id },
      subject: `Payment received · ${quote.id} · ${amountFmt}`,
      text:
`Hi ${customerName.split(" ")[0] || "there"},

Thanks for your purchase! Your payment of ${amountFmt} for ${productDesc} has been received.

ORDER SUMMARY
  Order ID    ${quote.id}
  Plan        ${tierName}${isHostingOrder ? "" : `\n  Seats       ${seats}`}
  Domain      ${domain || "—"}
  Total paid  ${amountFmt} (incl 18% GST)

${whatNext}

${invoiceLine}${
  sellerPhone ? `\n\nIf you need anything, WhatsApp ${contactWho} on ${sellerPhone}.` : ""
}

${customerSignOff}`,
    }),

    // Seller alert — money in the bank (switched off on a developer machine only)
    owner.ok && ownerPaymentAlertAllowed() && sendInternalEmail({
      to:      owner.to,
      from:    FROM_EMAIL,
      kind:    "razorpay_payment_owner",
      route:   { tenantId: quote.tenant_id },
      subject: `💰 PAYMENT RECEIVED · ${quote.customer_name} · ${amountFmt}`,
      text:
`A direct-buy payment was just captured by Razorpay.

COMPANY     ${quote.customer_name}
CONTACT     ${customerName} <${customerEmail}>
PLAN        ${tierName}
SEATS       ${seats}
DOMAIN      ${domain || "—"}
TOTAL       ${amountFmt}
ORDER ID    ${quote.id}
RAZORPAY    ${paymentRef}
METHOD      ${paymentMethod}

ACTION REQUIRED
  1. Verify domain ownership (DNS TXT record)
  2. Create customer in Google Reseller Console
  3. Provision ${seats} licenses on ${domain || "the customer's domain"}
  4. Send admin credentials to ${customerEmail}

Open in app: ${publicBase}/customers
Open quote:  ${publicBase}/quotes/${quote.id}${leadOwner
  ? `\n\nLead owner: ${leadOwner.name} — they have the next-step list too.`
  : `\n\nNobody owns this lead — tick "Gets new leads" on the Team page so orders are dealt to someone.`}`,
    }),

    /* R-120: the employee who owns the lead (R-111 deals new leads round-robin) gets the
       order and the next steps — not only the tenant inbox. Skipped when that person IS the
       tenant inbox, so nobody gets the same order twice. */
    leadOwner && !isHostingOrder && leadOwner.email.toLowerCase() !== (owner.ok ? owner.to.toLowerCase() : "") && sendInternalEmail({
      to:      leadOwner.email,
      from:    FROM_EMAIL,
      kind:    "razorpay_payment_lead_owner",
      route:   { tenantId: quote.tenant_id },
      subject: `New paid order for you · ${quote.customer_name} · ${tierName} × ${seats}`,
      text: leadOwnerNextSteps({
        domain, seats, tierName, contactName: leadOwner.name, contactPhone: notes.phone ?? "",
        orderId: quote.id, company: quote.customer_name ?? "", customerName, customerEmail,
        amount: amountFmt, appBase: publicBase, quoteId: quote.id, leadId: quote.lead_id,
      }),
    }),
  ]).then((results) => {
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[webhooks/razorpay] email ${["customer", "owner", "lead owner"][i] ?? i} failed:`, r.reason);
      }
    });
  });

  return NextResponse.json({
    received: true,
    quoteId: quote.id,
    paid: paymentAmount,
    invoiceId: invoice.status === "issued" || invoice.status === "exists" ? invoice.invoiceId : null,
    invoice: invoice.status,
  });
}

/**
 * payment.failed (R-079).
 *
 * Before this the event was only logged, so a buyer whose card was declined simply
 * vanished: the lead sat at "quote" with nothing on it, and nobody knew to call.
 *
 *   1. A note on the lead: "Payment failed — <Razorpay's reason>", with the payment id, so a
 *      repeated delivery of the same event is recognised and written once.
 *   2. The buyer is sent the quote's own public pay link — the SAME quote, the same amount,
 *      priced when they checked out. Paying it goes through the normal webhook again.
 *
 * Never charges anything: no order is created and no saved method is used here. The buyer
 * chooses to retry. Outside production the email is logged and not sent.
 */
async function handlePaymentFailed(
  admin: ReturnType<typeof createAdminClient>,
  body: RazorpayWebhookBody,
  tenantParam: string | null,
  publicBase: string,
  mayActOn: (tenantId: string) => Promise<boolean>,
): Promise<NextResponse> {
  const payment = body.payload.payment?.entity;
  if (!payment?.id) {
    return NextResponse.json({ received: true, ignored: "payment.failed (no payment)" });
  }

  /* The quote is found by the ORDER id we stored on it at checkout (`payment_reference`),
     which Razorpay set server-side. The checkout's notes.quoteId is only a fallback, and
     then only for a quote whose stored order is this one or unset. */
  const cols = "id, tenant_id, lead_id, customer_name, amount, payment_status, invoice_id, public_token, payment_reference";
  type FailedQuote = {
    id: string; tenant_id: string; lead_id: string | null; customer_name: string | null; amount: number | null;
    payment_status: string | null; invoice_id: string | null; public_token: string | null; payment_reference: string | null;
  };
  let quote: FailedQuote | null = null;
  if (payment.order_id) {
    const { data } = await admin.from("quotes").select(cols).eq("payment_reference", payment.order_id).limit(1);
    quote = ((data ?? [])[0] as FailedQuote | undefined) ?? null;
  }
  const noteQuoteId = payment.notes?.quoteId?.trim();
  if (!quote && noteQuoteId) {
    const { data } = await admin.from("quotes").select(cols).eq("id", noteQuoteId).maybeSingle();
    const q = data as FailedQuote | null;
    if (q && (!q.payment_reference || q.payment_reference === payment.order_id)) quote = q;
  }
  if (!quote) {
    console.warn(`[webhooks/razorpay] payment.failed ${payment.id}: no quote for order ${payment.order_id ?? "(none)"}`);
    return NextResponse.json({ received: true, ignored: "payment.failed (unknown order)" });
  }
  if (!(await mayActOn(quote.tenant_id))) {
    console.error("[webhooks/razorpay] payment.failed tenant mismatch", { tenantParam, quoteTenant: quote.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }
  // A later attempt already succeeded — an old failure is history, not a reason to chase.
  if (quote.invoice_id || quote.payment_status === "received" || quote.payment_status === "invoiced") {
    return NextResponse.json({ received: true, ignored: "payment.failed (quote already paid)" });
  }

  const reason =
    payment.error_description?.trim() || payment.error_reason?.trim() || payment.error_code?.trim() || "no reason given by Razorpay";
  const amountFmt = `₹${Math.round((payment.amount ?? 0) / 100).toLocaleString("en-IN")}`;

  // Same event twice → one note, one email.
  if (quote.lead_id) {
    const { data: logged } = await admin
      .from("lead_activities")
      .select("id")
      .eq("tenant_id", quote.tenant_id)
      .eq("lead_id", quote.lead_id)
      .ilike("detail", `%${payment.id}%`)
      .limit(1);
    if (logged && logged.length) {
      return NextResponse.json({ received: true, alreadyProcessed: true });
    }
  }

  const retryUrl = quote.public_token ? quoteAcceptUrl(publicBase, quote.id, quote.public_token) : null;
  const to = (payment.email ?? payment.notes?.email ?? "").trim();
  const live = isProductionDeployment();

  let emailOutcome: string;
  if (!retryUrl) {
    emailOutcome = "No retry link (the quote has no public link)";
  } else if (!to) {
    emailOutcome = `No retry email (Razorpay sent no email address). Retry link: ${retryUrl}`;
  } else if (!live) {
    console.info(
      `[webhooks/razorpay] payment.failed ${payment.id}: retry email NOT sent (not production). Would send to ${to}: ${retryUrl}`,
    );
    emailOutcome = `Retry link logged, not emailed (not production): ${retryUrl}`;
  } else {
    const { alert: owner, tenant: seller } = await loadOwnerAlert(admin, quote.tenant_id);
    const sellerName = seller?.name?.trim() || "your reseller";
    const voice = storefrontVoice(quote.tenant_id);
    const r = await sendCustomerEmail({
      to,
      from: FROM_EMAIL,
      replyTo: voice ? voice.replyTo : owner.ok ? owner.to : undefined,
      kind: "razorpay_payment_failed_retry",
      route: { tenantId: quote.tenant_id },
      subject: `Your payment didn't go through · ${quote.id} · ${amountFmt}`,
      text:
`Hi,

Your payment of ${amountFmt} for order ${quote.id} did not go through, so nothing was charged.
Reason given by the bank / Razorpay: ${reason}

You can try again — same order, same price — here:
  ${retryUrl}

If it fails again, just reply to this email and we'll help.

${voice ? voice.signOff : `— ${sellerName}`}`,
    }).catch((e: unknown) => ({ status: "failed" as const, errorMessage: e instanceof Error ? e.message : String(e) }));
    emailOutcome = r.status === "failed"
      ? `Retry email to ${to} FAILED (${r.errorMessage ?? "unknown"}). Retry link: ${retryUrl}`
      : `Retry link emailed to ${to}: ${retryUrl}`;
  }

  if (quote.lead_id) {
    const { error: noteErr } = await admin.from("lead_activities").insert({
      tenant_id: quote.tenant_id,
      lead_id: quote.lead_id,
      kind: "note",
      detail:
        `Payment failed — ${reason}. ${amountFmt} on quote ${quote.id} (Razorpay ${payment.id}, order ${payment.order_id ?? "—"}). ` +
        `Nothing was charged and nothing will be charged automatically. ${emailOutcome}`,
    });
    if (noteErr) console.error(`[webhooks/razorpay] payment.failed ${payment.id}: lead note not written — ${noteErr.message}`);
  }
  console.warn(`[webhooks/razorpay] payment.failed ${payment.id} on ${quote.id}: ${reason}`);
  return NextResponse.json({ received: true, failed: true, quoteId: quote.id, retryUrl: retryUrl ?? null });
}

/**
 * A subscription.* event from Razorpay — the mandate lifecycle.
 *
 * ─── THIS FUNCTION IS THE ONLY WRITER OF `active` ───────────────────────────
 * "Autopay is on" means a bank will move money without anyone touching it. The app
 * has no path to that word; a signature-verified gateway event does. The signature
 * was checked against this tenant's own secret before we got here.
 *
 * ─── OUT-OF-ORDER DELIVERY IS ASSUMED, NOT HOPED AGAINST ────────────────────
 * Webhooks arrive late, twice, and in the wrong order. `applyGatewayEvent` refuses to
 * resurrect a cancelled mandate from a stale `subscription.charged`, and returns null
 * for a no-op so a duplicate delivery writes nothing at all.
 *
 * ─── AND IT RECORDS WHAT THE CUSTOMER APPROVED, NOT WHAT WE ASKED FOR ───────
 * `max_amount` is filled from the gateway's figure. Those are two different facts and
 * conflating them would hide a mandate approved for less than requested — which then
 * fails on the first debit that exceeds it.
 */
async function handleMandateEvent(
  admin: ReturnType<typeof createAdminClient>,
  event: string,
  rawBody: string,
  tenantParam: string | null,
  mayActOn: (tenantId: string) => Promise<boolean>,
): Promise<NextResponse> {
  let entity: { id?: string; status?: string; end_at?: number; plan_id?: string } | undefined;
  let planAmountPaise: number | undefined;
  try {
    const parsed = JSON.parse(rawBody) as {
      payload?: {
        subscription?: { entity?: typeof entity };
        plan?: { entity?: { item?: { amount?: number } } };
      };
    };
    entity = parsed.payload?.subscription?.entity;
    planAmountPaise = parsed.payload?.plan?.entity?.item?.amount;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const gatewaySubId = entity?.id;
  if (!gatewaySubId) {
    return NextResponse.json({ received: true, ignored: `${event} (no subscription id)` });
  }

  const { data: mandate } = await admin
    .from("payment_mandates")
    .select("id, tenant_id, status, requested_amount, max_amount")
    .eq("gateway_subscription_id", gatewaySubId)
    .maybeSingle();

  if (!mandate) {
    /* Not ours, or created before this table existed. Acknowledged so Razorpay stops
       retrying — a 4xx here would have it redeliver forever. */
    return NextResponse.json({ received: true, ignored: `${event} (unknown mandate)` });
  }

  /* Same defence the payment path uses: a signature valid for tenant A must not act
     on tenant B's mandate. */
  if (!(await mayActOn(mandate.tenant_id))) {
    console.error("[webhooks/razorpay] mandate tenant mismatch", { tenantParam, mandateTenant: mandate.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  const next = applyGatewayEvent(mandate.status as MandateStatus, event);
  if (!next) {
    return NextResponse.json({ received: true, noChange: true, status: mandate.status });
  }

  /* Typed against the table rather than Record<string, unknown> — a loose bag would
     let a typo'd column name through the compiler and fail silently at runtime, on
     the one write that decides whether a bank may take money. */
  const patch: Partial<PaymentMandateInsert> = {
    status: next,
    status_note: `Razorpay ${event}`,
    updated_at: new Date().toISOString(),
  };
  if (next === "active") {
    patch.authorised_at = new Date().toISOString();
    /* What the customer actually approved. Falls back to what we requested only when
       the gateway did not send an amount — recorded either way so the headroom check
       has something real to work with. */
    patch.max_amount = planAmountPaise ? Math.round(planAmountPaise / 100) : mandate.max_amount ?? mandate.requested_amount;
  }
  if (next === "cancelled") patch.cancelled_at = new Date().toISOString();
  if (entity?.end_at) patch.end_date = new Date(entity.end_at * 1000).toISOString().slice(0, 10);

  const { error } = await admin.from("payment_mandates").update(patch).eq("id", mandate.id);
  if (error) {
    // R-025 — same public endpoint, same reasoning as record_payment above.
    logDbError("webhooks/razorpay:mandate-update", error);
    return NextResponse.json(
      { error: safeDbMessage(error, "Mandate update failed") },
      { status: 500 },
    );
  }

  console.info(`[webhooks/razorpay] mandate ${mandate.id}: ${mandate.status} → ${next} (${event})`);
  return NextResponse.json({ received: true, mandate: mandate.id, status: next });
}

/**
 * R-045: keep what Razorpay KEPT on this payment — its fee and the GST on that fee, whole
 * rupees — on the payment row the capture just recorded. Cash settled = amount − gateway_fee,
 * which is the number the bank line shows.
 *
 * Best-effort by design: the payment is already committed, and a fee that cannot be written
 * (or that Razorpay did not send) stays NULL = "unknown", never a guessed zero.
 */
async function recordGatewayFee(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  quoteId: string,
  reference: string,
  payment: RazorpayPayment,
): Promise<void> {
  const fee = gatewayFeeFromPayment(payment);
  if (!fee) return;
  const { data: rows, error } = await admin
    .from("payments")
    .update({ gateway_fee: fee.fee, gateway_fee_gst: fee.gst })
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId)
    .eq("reference", reference)
    .select("id");
  if (error) {
    logDbError("webhooks/razorpay:gateway_fee", error);
    return;
  }
  console.log(`[webhooks/razorpay] ${reference}: Razorpay fee ₹${fee.fee} (GST ₹${fee.gst}), settles ₹${fee.net}`);
  /* R-045 slice 2: book the fee as a Bank Charges expense (its GST as input), once per
     payment — the expense id is derived from the payment id, so a retry or the later
     payment.captured lands on the same row and writes nothing. Best-effort: a miss is
     picked up by "Book Razorpay fees" on the Payments page. */
  for (const r of (rows ?? []) as { id: string }[]) {
    const booked = await bookGatewayFeeExpense(admin, tenantId, r.id);
    if (booked === "error") console.error(`[webhooks/razorpay] ${reference}: fee expense not booked — use Book Razorpay fees on /payments`);
  }
}

/**
 * R-045: `refund.processed` — Razorpay has ALREADY sent money back to the buyer.
 *
 * What this does: finds the payment the refund belongs to (by Razorpay payment id, which
 * the capture stored as payments.reference), checks the tenant, records the refund id on
 * the payment (once — the idempotency fact), then writes a note on the lead and notifies
 * the owners with the exact next step (refundAdvice).
 *
 * What it deliberately does NOT do: flip the payment to refunded, touch the quote, or issue
 * a credit note. A tax invoice needs a credit note first (refund_payment refuses otherwise),
 * and a partial refund needs a human to decide which lines — so the machine writes the
 * instruction and a human books it.
 *
 * Idempotency: the refund id is appended with an optimistic check on the array as read, so
 * two deliveries of the same refund racing each other write one note. The loser re-reads;
 * if its id is now there it answers alreadyProcessed, otherwise 500 so Razorpay retries.
 */
async function handleRefundProcessed(
  admin: ReturnType<typeof createAdminClient>,
  body: RazorpayWebhookBody,
  tenantParam: string | null,
  mayActOn: (tenantId: string) => Promise<boolean>,
): Promise<NextResponse> {
  const refund = parseRefund(body.payload.refund?.entity);
  if (!refund) {
    return NextResponse.json({ received: true, ignored: "refund.processed (no usable refund)" });
  }

  type PayRow = {
    id: string; tenant_id: string; quote_id: string; amount: number; status: string;
    gateway_refund_ids: string[] | null;
  };
  const cols = "id, tenant_id, quote_id, amount, status, gateway_refund_ids";
  const { data: rows } = await admin.from("payments").select(cols).eq("reference", refund.payment_id).limit(5);
  const candidates = (rows ?? []) as PayRow[];
  if (candidates.length === 0) {
    console.warn(`[webhooks/razorpay] refund.processed ${refund.id}: no payment recorded for ${refund.payment_id}`);
    return NextResponse.json({ received: true, ignored: "refund.processed (unknown payment)" });
  }
  let pay: PayRow | null = null;
  for (const r of candidates) {
    if (await mayActOn(r.tenant_id)) { pay = r; break; }
  }
  if (!pay) {
    console.error("[webhooks/razorpay] refund.processed tenant mismatch", { tenantParam, payment: refund.payment_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  const seen = pay.gateway_refund_ids ?? [];
  if (seen.includes(refund.id)) {
    return NextResponse.json({ received: true, alreadyProcessed: true });
  }

  /* Claim the refund id — only the delivery whose update matches the array AS READ wins. */
  const base = admin
    .from("payments")
    .update({ gateway_refund_ids: [...seen, refund.id] })
    .eq("id", pay.id);
  const guarded = pay.gateway_refund_ids == null
    ? base.is("gateway_refund_ids", null)
    : base.filter("gateway_refund_ids", "eq", `{${seen.join(",")}}`);
  const { data: claimed, error: claimErr } = await guarded.select("id");
  if (claimErr) {
    logDbError("webhooks/razorpay:refund_claim", claimErr);
    return NextResponse.json({ error: safeDbMessage(claimErr, "Refund processing failed") }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    const { data: again } = await admin.from("payments").select("gateway_refund_ids").eq("id", pay.id).maybeSingle();
    const now = ((again as { gateway_refund_ids?: string[] | null } | null)?.gateway_refund_ids) ?? [];
    if (now.includes(refund.id)) return NextResponse.json({ received: true, alreadyProcessed: true });
    console.error(`[webhooks/razorpay] refund.processed ${refund.id}: lost a concurrent update on ${pay.id}; asking Razorpay to retry`);
    return NextResponse.json({ error: "Busy, retry" }, { status: 500 });
  }

  const { data: q } = await admin
    .from("quotes")
    .select("id, lead_id, invoice_id")
    .eq("id", pay.quote_id)
    .eq("tenant_id", pay.tenant_id)
    .maybeSingle();
  const quote = q as { id: string; lead_id: string | null; invoice_id: string | null } | null;

  const advice = refundAdvice(refund, {
    quoteId: pay.quote_id,
    paymentAmount: pay.amount,
    paymentStatus: pay.status,
    invoiceNumber: quote?.invoice_id ?? null,
  });

  if (quote?.lead_id) {
    const { error: noteErr } = await admin.from("lead_activities").insert({
      tenant_id: pay.tenant_id,
      lead_id: quote.lead_id,
      kind: "note",
      detail: advice.note,
    });
    if (noteErr) console.error(`[webhooks/razorpay] refund.processed ${refund.id}: lead note not written — ${noteErr.message}`);
  }

  await notifyTenantOwners({
    tenantId: pay.tenant_id,
    kind: "payment.refunded",
    title: `Razorpay refund ${rupee(advice.amount)} on ${pay.quote_id} — book it`,
    body: advice.note,
    href: `/quotes/${pay.quote_id}`,
    entityId: pay.quote_id,
  });

  console.warn(`[webhooks/razorpay] refund.processed ${refund.id} on ${pay.quote_id}: ₹${advice.amount}${advice.partial ? " (partial)" : ""}`);
  return NextResponse.json({
    received: true,
    refund: refund.id,
    quoteId: pay.quote_id,
    amount: advice.amount,
    partial: advice.partial,
    nextStep: advice.nextStep,
  });
}
