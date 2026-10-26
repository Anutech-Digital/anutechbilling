/**
 * R-045: the refund.processed handler, moved out of webhook.server.ts unchanged (R-1985 —
 * that file sits at the max-lines ratchet). Only its imports moved with it; the body is the
 * same code, still reached from POST /api/webhooks/razorpay after the signature check.
 */
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import { parseRefund, refundAdvice } from "@/lib/razorpay/gateway-money";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";

/** The part of a verified webhook body this handler reads. */
export interface RefundWebhookBody {
  payload: { refund?: { entity: unknown } };
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
export async function handleRefundProcessed(
  admin: ReturnType<typeof createAdminClient>,
  body: RefundWebhookBody,
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
