/**
 * Creating a Razorpay payment link for a quote and sending it — the IO half.
 *
 * The decisions are in payment-link.ts: what may be charged, in what unit, and whether a link
 * is allowed at all. This resolves credentials, calls the API, and sends the message through
 * the one chokepoint every customer-facing message in this codebase goes through.
 *
 * ─── THE SEND IS GATED, AND THAT IS WHY THIS FILE EXISTS ────────────────────
 * `autonomy-chokepoint.test.ts` refused the `payment.link.send` registry entry until something
 * actually passed it to `sendEmail`, on the grounds that "a registry entry nobody enforces is
 * worse than no entry — it reads as a control the operator does not have". It was right: the
 * dial was declared before the wiring existed, and the test caught it in the same minute.
 *
 * So the message goes through `sendEmail` with `automated`, which resolves the dial, records
 * the outcome in `email_log`, and refuses when the kill switch is on. Razorpay's own SMS and
 * email notifications are switched OFF in the request body for the same reason — see
 * `paymentLinkRequest`.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { razorpayMode } from "./razorpay-readiness";
import { sendCustomerEmail } from "@/lib/messaging";
import {
  decidePaymentLink,
  paymentLinkMessage,
  paymentLinkRequest,
} from "./payment-link";

const RAZORPAY_LINKS_URL = "https://api.razorpay.com/v1/payment_links";

/** A gateway call must not hold a request open indefinitely. */
const TIMEOUT_MS = 15_000;

export interface CreatePaymentLinkResult {
  ok: boolean;
  /** The short URL, when one was created. */
  url: string | null;
  /** One sentence a non-engineer can act on. */
  detail: string;
  /** Which gateway made it — so nothing downstream mistakes a sandbox link for revenue. */
  mode: "live" | "test" | null;
}

/**
 * Create a payment link for a quote and send it to the customer.
 *
 * Never throws: every caller is a route, a cron or an agent dispatcher, and none of them may
 * fail because a gateway was slow.
 */
export async function createAndSendPaymentLink(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  quoteId: string;
  /** The lead this quote belongs to, when there is one — the timeline note needs it, and
   *  `lead_activities.lead_id` is NOT NULL so there is nowhere to put an orphan note. */
  leadId?: string | null;
  /** ₹ outstanding, from lib/payments/amount-due — never recomputed here. */
  amountDue: number;
  quoteStatus: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  sellerName: string;
  fromEmail: string;
  expiresOn: string | null;
  callbackUrl?: string;
}): Promise<CreatePaymentLinkResult> {
  try {
    const { data: raw } = await args.admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret")
      .eq("tenant_id", args.tenantId)
      .maybeSingle();

    const secrets = decryptTenantSecrets(raw);
    const keyId = secrets?.razorpay_key_id?.trim() ?? "";
    const keySecret = secrets?.razorpay_key_secret?.trim() ?? "";
    const mode = razorpayMode(keyId);

    const decision = decidePaymentLink({
      mode,
      configured: Boolean(keyId && keySecret),
      amountDue: args.amountDue,
      quoteStatus: args.quoteStatus,
      contact: args.customerEmail ?? args.customerPhone,
    });

    if (!decision.create) {
      return { ok: false, url: null, detail: decision.detail, mode: null };
    }

    const body = paymentLinkRequest({
      quoteId: args.quoteId,
      amountDue: args.amountDue,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      sellerName: args.sellerName,
      tenantId: args.tenantId,
      expiresOn: args.expiresOn,
      callbackUrl: args.callbackUrl,
    });

    const res = await fetch(RAZORPAY_LINKS_URL, {
      method: "POST",
      headers: {
        /* Basic auth, key_id as the user and key_secret as the password — Razorpay's scheme. */
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      /* Razorpay's own message, truncated. It is the only thing distinguishing "amount below
         the minimum" from "key revoked", and both arrive as a 400. */
      return {
        ok: false,
        url: null,
        mode,
        detail: `Razorpay refused the payment link (${res.status}): ${text.slice(0, 300)}`,
      };
    }

    const parsed = JSON.parse(text) as { short_url?: string; id?: string };
    const url = parsed.short_url?.trim();
    if (!url) {
      return { ok: false, url: null, mode, detail: "Razorpay returned no link URL" };
    }

    /* On the quote's timeline BEFORE the send, so a link that was created but could not be
       mailed is still recoverable by hand rather than lost. */
    if (args.leadId) {
      await args.admin.from("lead_activities").insert({
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        kind: "note",
        detail:
          `Payment link created for ${args.quoteId} — ${url}` +
          (decision.note ? ` · ${decision.note}` : ""),
      }).then(() => undefined, () => undefined);
    }

    if (!args.customerEmail?.trim()) {
      /* No address: the link exists and is on the record, and the operator sends it on
         WhatsApp by hand. CLAUDE.md §24 — say what is missing and who can supply it. */
      return {
        ok: true,
        url,
        mode,
        detail: `Link created but not emailed — this customer has no email address. Copy it from the timeline. ${decision.note ?? ""}`.trim(),
      };
    }

    const sent = await sendCustomerEmail({
      to: args.customerEmail.trim(),
      from: args.fromEmail,
      subject: `Payment link for quote ${args.quoteId}`,
      text: paymentLinkMessage({
        customerName: args.customerName,
        quoteId: args.quoteId,
        amountDue: args.amountDue,
        url,
        mode,
      }),
      route: { tenantId: args.tenantId },
      kind: "quote_payment_link",
      /* THE GATE. Resolves `payment.link.send`, logs the outcome in email_log, and refuses when
         the kill switch is on — the same chokepoint every other customer-facing message uses. */
      automated: { tenantId: args.tenantId, action: "payment.link.send" },
    });

    return {
      ok: sent.status === "sent",
      url,
      mode,
      detail:
        sent.status === "sent"
          ? `Payment link sent to ${args.customerEmail}. ${decision.note ?? ""}`.trim()
          : `Link created but not sent (${sent.status}) — it is on the quote's timeline. ${decision.note ?? ""}`.trim(),
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    console.error("[payment-link] crashed:", err);
    return { ok: false, url: null, mode: null, detail: `Payment link failed — ${why}` };
  }
}
