/**
 * Start paying an existing quote: the state guards, the amount to charge, and the Razorpay
 * order. Settlement is never here — the webhook finds the quote by `receipt` and records it
 * through `record_payment`, so a quote paid this way is treated exactly like one paid from
 * its public page (including a renewal: the webhook matches `renewal_quote_id` / `is_renewal`).
 *
 * Moved out of `api/public/quote/[id]/pay` on 28 Sep 2026, verbatim, so the DMS panel's
 * renewal payment (`api/dms/renewal-order`) charges by the same rules instead of a copy.
 * `route.test.ts` beside the pay route pinned the behaviour before the move. Callers do their
 * own authorisation first — the public page by the quote's token, the panel by its key plus
 * the customer's email.
 */
import Razorpay from "razorpay";
import type { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { isQuoteExpired } from "@/lib/utils";
import { quoteDueNow, type QuoteDueNow, type QuoteDueNowFields } from "@/lib/payments/quote-due-now";
import { isQuoteAmountConsistent } from "@/lib/quotes/amounts";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { platformEnvRazorpayKeys } from "./platform-razorpay";
import { liveKeyCheckoutRefusal } from "./live-guards";

/** The quote columns this needs — the pay route's select. */
export const QUOTE_ORDER_COLUMNS =
  "id, status, payment_status, expires_date, amount, currency, customer_name, tenant_id, public_token, invoice_id, billing_cycle, subtotal, discount_pct, tax_rate, created_date, line_items, superseded_by";

export interface QuoteForOrder {
  id: string;
  status: string | null;
  payment_status: string | null;
  expires_date: string | null;
  amount: number | null;
  currency: string | null;
  customer_name: string | null;
  tenant_id: string;
  invoice_id: string | null;
  billing_cycle: BillingCycle | null;
  subtotal: number | null;
  discount_pct: number | null;
  tax_rate: number | null;
  line_items: unknown;
  /** R-1569/R-1575: set when the quote was revised or combined into another. */
  superseded_by?: string | null;
}

/**
 * R-1569: rupees already received on the quote — the payments ledger, not the quote's
 * `payment_status` label. A TDS settlement is recorded as one payment whose amount includes
 * the TDS (record_payment_with_tds), so it counts here too. Refunded / deleted rows are
 * not money in hand and are left out.
 */
export async function quoteAmountReceived(
  admin: ReturnType<typeof createAdminClient>,
  quote: { id: string; tenant_id: string },
): Promise<number> {
  const { data, error } = await admin
    .from("payments")
    .select("amount, status")
    .eq("tenant_id", quote.tenant_id)
    .eq("quote_id", quote.id)
    .eq("status", "received");
  if (error) throw new Error(`payments read failed: ${error.message}`);
  return ((data ?? []) as { amount: number | null; status: string | null }[])
    .filter((p) => p.status === "received")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

/**
 * R-1613: what is due on the quote NOW, read the way the order reads it (ledger + quoteDueNow).
 * For the accept page's Pay button / UPI QR and every quote-PDF QR, so none of them can ask
 * for a figure the order would not charge. A ledger read failure → "nothing" (no QR, no
 * button): asking for nothing is the safe direction; the customer can still pay via the link.
 */
export async function readQuoteDueNow(
  admin: ReturnType<typeof createAdminClient>,
  quote: QuoteDueNowFields & { id: string; tenant_id: string },
): Promise<QuoteDueNow> {
  try {
    return quoteDueNow(quote, await quoteAmountReceived(admin, quote));
  } catch (err) {
    console.error(`[quote-due-now] ${quote.id}: ${(err as Error).message}`);
    return { state: "nothing" };
  }
}

export interface QuoteOrderOptions {
  /** Settle through record_payment when no Razorpay keys exist. The public page allows it outside production. */
  allowSimulation: boolean;
  /** Added to the Razorpay order's notes (e.g. the channel). Cannot replace kind/quoteId/tenantId. */
  extraNotes?: Record<string, string>;
  /** Log prefix, e.g. "[public/quote/pay]". */
  logTag: string;
}

export interface QuoteOrderResult {
  status: number;
  body: Record<string, unknown>;
}

export async function startQuotePayment(
  admin: ReturnType<typeof createAdminClient>,
  quote: QuoteForOrder,
  opts: QuoteOrderOptions,
): Promise<QuoteOrderResult> {
  // ── 2. State guards ─────────────────────────────────────────────────────
  if (quote.status === "draft") {
    return { status: 400, body: { error: "This quote hasn't been sent yet." } };
  }
  if (quote.status === "rejected") {
    return { status: 400, body: { error: "This quote was rejected — please contact the reseller." } };
  }
  /* R-1575: a quote revised or combined into another takes no money — the replacing quote
     does. Named, so the customer knows which one to ask for. */
  if (quote.superseded_by) {
    return {
      status: 400,
      body: {
        error: `This quote was replaced by ${quote.superseded_by} — it can't be paid any more.`,
        nextStep: `Please pay quote ${quote.superseded_by} instead; ask the reseller to send you its link if you don't have it.`,
      },
    };
  }
  /* R-448: 'expired' is also a replaced quote (superseded_by) — never take money on it. */
  if (quote.status === "expired") {
    return { status: 400, body: { error: "This quote is closed or was replaced — ask the reseller for the latest one." } };
  }
  // Already settled — never let the customer pay twice.
  if (quote.invoice_id || quote.payment_status === "received" || quote.payment_status === "invoiced") {
    return { status: 409, body: { error: "This quote is already paid." } };
  }
  if (isQuoteExpired(quote.expires_date)) {
    return { status: 400, body: { error: "This quote has expired — ask the reseller for a fresh one." } };
  }
  // ── 2a. Refuse a quote whose own total disagrees with its own GST ──────────
  // Everything below charges from `quote.amount` and then invoices it. One production
  // quote stores ₹45,360 where its 18% rate says ₹53,525 (Q-2026-9776 — migration
  // 20260817100000 never ran). Left open, this path would take ₹8,165 too LITTLE and then
  // issue a tax invoice for the short amount — a wrong tax invoice cannot be undone, a
  // failed payment can. Measured 21 Aug 2026: 26 of 27 production quotes pass this.
  // Wording stays customer-facing — the arithmetic is the reseller's problem, not the buyer's.
  const taxRate  = quote.tax_rate ?? 18;
  const subtotal = quote.subtotal ?? 0;
  if (!isQuoteAmountConsistent(subtotal, taxRate, quote.amount ?? 0, quote.discount_pct ?? 0)) {
    return {
      status: 409,
      body: {
        error: "This quote's total needs to be corrected before it can be paid.",
        nextStep: "Please ask the reseller to re-send it — the GST on it does not add up, and paying now would leave you with an invoice that understates the tax.",
      },
    };
  }

  // ── 2b. What is due NOW — R-1613: one helper for this order, the accept page's Pay
  // button / UPI QR and the PDF QR (lib/payments/quote-due-now.ts), so the customer is
  // never shown one figure and charged another. Its rules are R-1569's and R-234's:
  //  - split billing (quarterly ₹28,320 → instalment 1 ₹7,080) charges the FIRST
  //    instalment; once anything is paid the rest is collected from instalment invoices;
  //  - otherwise quote total − money already received (ledger, TDS in, refunds out) —
  //    a ₹50,000 quote with ₹20,000 recorded orders ₹30,000, never ₹50,000 again.
  const quoteTotal = quote.amount ?? 0;
  let alreadyPaid = 0;
  try {
    alreadyPaid = await quoteAmountReceived(admin, quote);
  } catch (err) {
    console.error(`${opts.logTag} ${(err as Error).message}`);
    return { status: 500, body: { error: "Could not start payment. Please retry." } };
  }
  const due = quoteDueNow(quote, alreadyPaid);
  if (due.state === "instalment-paid") {
    const monthly = (quote.billing_cycle ?? "") === "monthly";
    return {
      status: 409,
      body: {
        error: `The first ${monthly ? "month" : "instalment"} on this quote is already paid.`,
        nextStep: "The rest is invoiced one period at a time — pay those from the invoice you receive on each billing date.",
      },
    };
  }
  if (due.state === "paid" || due.state === "invoiced") {
    return {
      status: 409,
      body: {
        error: "This quote is already paid in full.",
        nextStep: "Nothing more is due on it. If you need a receipt or think this is wrong, please contact the reseller.",
      },
    };
  }
  if (due.state === "nothing") {
    return { status: 400, body: { error: "Nothing to pay on this quote." } };
  }
  // Razorpay (Indian account) charges INR. A foreign-currency quote shows a
  // non-₹ total to the customer, so charging ₹ here would mismatch what they
  // see — route those to offline settlement instead.
  if (!due.inr) {
    return {
      status: 400,
      body: { error: "Online payment is available for ₹ invoices only — please contact the reseller to pay.", notConfigured: true },
    };
  }
  const amountInr = due.amount;
  const instalments = due.instalment;

  // ── 3. Resolve the tenant's Razorpay creds (tenant_secrets → env, platform only: R-1923) ────────
  let rzKeyId = "";
  let rzKeySecret = "";
  let rzMode: "test" | "live" = "test";
  {
    const { data: rawSecrets } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
      .eq("tenant_id", quote.tenant_id)
      .maybeSingle();
    // Sealed at rest (rosv1:…) — decrypt or Razorpay rejects the ciphertext.
    const secrets = decryptTenantSecrets(rawSecrets);
    if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
      rzKeyId = secrets.razorpay_key_id;
      rzKeySecret = secrets.razorpay_key_secret;
      rzMode = secrets.razorpay_mode === "live" ? "live" : "test";
    } else {
      /* R-1923: the env pair is the PLATFORM's own Razorpay account — only the platform
         tenant's quotes may use it. Another company without its own keys gets the 503
         below (or a laptop simulation), never Anutech's account. */
      const platform = platformEnvRazorpayKeys(quote.tenant_id);
      if (platform) {
        rzKeyId = platform.keyId;
        rzKeySecret = platform.keySecret;
        rzMode = platform.mode;
      }
    }
  }
  const razorpayConfigured = Boolean(rzKeyId) && Boolean(rzKeySecret);

  /* R-2155: a live key on staging may read settlements, never take a payment. */
  const stagingLive = liveKeyCheckoutRefusal(rzKeyId);
  if (stagingLive) return { status: 403, body: { error: stagingLive, stagingLiveKey: true } };

  // ── 3a. SIMULATION (no creds) — record_payment directly, gated by the caller ─
  // record_payment on a first-payment quote converts the lead → customer +
  // subscription (the intended accept-and-pay outcome). Never settle a REAL
  // quote for ₹0 in production without keys.
  if (!razorpayConfigured) {
    if (!opts.allowSimulation) {
      return {
        status: 503,
        body: {
          error: "Online payment isn't available yet — please contact the reseller to pay by bank transfer / UPI.",
          notConfigured: true,
        },
      };
    }
    const simRef = `SIM-QUOTEPAY-${quote.id}`;
    const { error: rpcErr } = await admin.rpc("record_payment", {
      p_quote_id: quote.id,
      p_amount: amountInr,
      p_method: "razorpay",
      p_reference: simRef,
      p_notes: instalments
        ? `[SIMULATION] Quote online payment · ${quote.id} · instalment 1 of ${instalments.count}`
        : `[SIMULATION] Quote online payment · ${quote.id}`,
    });
    if (rpcErr) {
      console.error(`${opts.logTag} sim record_payment:`, rpcErr.message);
      return { status: 500, body: { error: rpcErr.message } };
    }
    return {
      status: 200,
      body: {
        success: true, simulated: true, quoteId: quote.id, amountRupees: amountInr,
        instalmentOf: instalments?.count ?? null,
      },
    };
  }

  // ── 3b. LIVE — create a Razorpay Order; the webhook records on capture ────
  try {
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: amountInr * 100, // paise
      currency: "INR",
      receipt: quote.id, // webhook reverse-looks-up the quote by receipt
      notes: {
        ...(opts.extraNotes ?? {}),
        kind: "quote",
        quoteId: quote.id,
        tenantId: quote.tenant_id,
        customerName: quote.customer_name ?? "",
        /* So a ₹2,360 capture against a ₹28,320 quote is self-explaining in the
           gateway dashboard rather than looking like an underpayment. */
        ...(instalments ? { instalment: `1 of ${instalments.count}`, cycle: instalments.cycle } : {}),
        /* R-1569: a part-paid quote's order is the remainder — say so in the gateway too. */
        ...(alreadyPaid > 0 ? { quoteTotal: String(quoteTotal), alreadyPaid: String(alreadyPaid) } : {}),
      },
    });
    return {
      status: 200,
      body: {
        success: true,
        orderId: order.id,
        amount: amountInr * 100,
        amountRupees: amountInr,
        quoteTotal,
        alreadyPaid,
        currency: "INR",
        razorpayKeyId: rzKeyId,
        razorpayMode: rzMode,
        quoteId: quote.id,
        customerName: quote.customer_name ?? "",
        instalmentOf: instalments?.count ?? null,
      },
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error(`${opts.logTag} order create failed:`, m);
    return { status: 500, body: { error: "Could not start payment. Please retry." } };
  }
}
