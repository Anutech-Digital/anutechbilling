/**
 * R-1569 / R-1575 / R-1574 — Razorpay money that does not settle a quote the normal way.
 *
 * Moved out of route.ts (max-lines). Every function here records the payment through
 * record_payment (so its overpayment branch makes customer credit in the same transaction)
 * or, when there is nowhere honest to put it, tells the owner once per payment id. None of
 * them issues an invoice, queues an activation or emails the customer.
 */
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";

type Admin = ReturnType<typeof createAdminClient>;

/** The Razorpay payment fields this needs. */
export interface LatePayment {
  id: string;
  amount: number; // paise
  method: string;
}

export type RecordFee = (admin: Admin, tenantId: string, quoteId: string, reference: string, payment: LatePayment) => Promise<void>;

/** R-1569: rupees already received on a quote — the payments ledger, refunded rows left out. */
export async function receivedOnQuote(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  quoteId: string,
): Promise<number> {
  const { data } = await admin
    .from("payments")
    .select("amount, status")
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId)
    .eq("status", "received");
  return ((data ?? []) as { amount: number | null; status: string | null }[])
    .filter((p) => p.status === "received")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

export interface SettledQuote {
  id: string;
  tenant_id: string;
  customer_name: string | null;
  lead_id: string | null;
  status: string | null;
  superseded_by: string | null;
}
export interface LateArgs {
  quote: SettledQuote;
  payment: LatePayment;
  event: string;
  orderId: string;
  /** route.ts recordGatewayFee — R-045 fee on the payment row (best-effort). */
  recordFee: RecordFee;
}

/** record_payment for a payment that is not a normal sale; null result = already recorded. */
async function recordOutOfBandPayment(
  admin: ReturnType<typeof createAdminClient>,
  quoteId: string,
  payment: LatePayment,
  notes: string,
): Promise<{ ok: true; replay: boolean; overpaidCredit: number } | { ok: false; res: NextResponse }> {
  const amount = Math.round((payment.amount ?? 0) / 100);
  if (amount <= 0) {
    return { ok: false, res: NextResponse.json({ error: "Invalid payment amount" }, { status: 400 }) };
  }
  const { data, error } = await admin.rpc("record_payment", {
    p_quote_id:  quoteId,
    p_amount:    amount,
    p_method:    payment.method === "upi" ? "upi" : "razorpay",
    p_reference: payment.id,
    p_notes:     notes,
  });
  if (error) {
    /* 500 so Razorpay retries — the money must land somewhere, never be acknowledged and lost. */
    logDbError("webhooks/razorpay:record_payment(late)", error);
    return { ok: false, res: NextResponse.json({ error: safeDbMessage(error, "Payment processing failed") }, { status: 500 }) };
  }
  const r = (data ?? {}) as { already_recorded?: boolean; overpaid_credit?: number };
  return { ok: true, replay: Boolean(r.already_recorded), overpaidCredit: Number(r.overpaid_credit) || 0 };
}

/**
 * R-1569: the quote was already paid in full (the desk recorded a bank transfer while the
 * customer still had the pay page open, or the customer paid twice). The money is recorded
 * through record_payment — its overpayment branch turns the excess into customer credit in
 * the same transaction — and the owner is told to refund it or keep it as credit. No invoice,
 * no activation, no "thank you" email: the sale was settled by the first payment.
 * Replay-safe: record_payment answers already_recorded for a payment id it holds, and the
 * alert is sent only by the delivery that wrote the row.
 */
export async function settleLatePayment(
  admin: ReturnType<typeof createAdminClient>,
  { quote, payment, event, orderId, recordFee }: LateArgs,
): Promise<NextResponse> {
  const rec = await recordOutOfBandPayment(admin, quote.id, payment,
    `Razorpay ${event} · order ${orderId} · quote was already paid — customer paid again (R-1569)`);
  if (!rec.ok) return rec.res;
  if (rec.replay) return NextResponse.json({ received: true, alreadyProcessed: true });

  await recordFee(admin, quote.tenant_id, quote.id, payment.id, payment);
  const amount = Math.round(payment.amount / 100);
  await notifyTenantOwners({
    tenantId: quote.tenant_id,
    kind: "payment.received", // R-1569 alert — entityId is the Razorpay payment id
    title: `Customer paid again — ${rupee(amount)} on ${quote.id}`,
    body:
      `${quote.customer_name ?? "Customer"} paid ${rupee(amount)} through Razorpay (${payment.id}), but the quote was already paid. ` +
      (rec.overpaidCredit > 0 ? `${rupee(rec.overpaidCredit)} is now customer credit. ` : "") +
      `Refund it (Razorpay dashboard) or apply the credit to the next bill.`,
    href: `/quotes/${quote.id}`,
    entityId: payment.id,
  });
  console.warn(`[webhooks/razorpay] ${payment.id}: ${quote.id} was already paid — recorded as a late payment, credit ₹${rec.overpaidCredit}`);
  return NextResponse.json({ received: true, latePayment: true, quoteId: quote.id, overpaidCredit: rec.overpaidCredit });
}

/**
 * R-1575: the quote was replaced (revised or combined — superseded_by) or rejected. An old
 * Razorpay checkout paid after that used to settle the CLOSED quote — activating it — while
 * the new quote kept asking for the same money. Now the money follows the replacement chain
 * to the live quote and is recorded there (a part-payment, or credit if that one is already
 * paid), with no automatic invoice or activation; the owner is told to check it. A rejected
 * quote with no live replacement has nowhere honest to put the money: nothing is recorded and
 * the owner is told, once per payment id, to refund it or raise a new quote.
 */
export async function settleOnReplacedQuote(
  admin: ReturnType<typeof createAdminClient>,
  { quote, payment, event, orderId, recordFee }: LateArgs,
): Promise<NextResponse> {
  const amount = Math.round(payment.amount / 100);

  let target: SettledQuote | null = null;
  let next = quote.superseded_by;
  for (let hop = 0; next && hop < 5; hop++) {
    const { data } = await admin
      .from("quotes")
      .select("id, tenant_id, customer_name, lead_id, status, superseded_by")
      .eq("id", next)
      .eq("tenant_id", quote.tenant_id)
      .maybeSingle();
    const row = data as SettledQuote | null;
    if (!row) break;
    if (row.superseded_by) { next = row.superseded_by; continue; }
    if (row.status !== "rejected" && row.status !== "draft") target = row;
    break;
  }

  if (target) {
    const rec = await recordOutOfBandPayment(admin, target.id, payment,
      `Razorpay ${event} · order ${orderId} · paid on replaced quote ${quote.id} (R-1575)`);
    if (!rec.ok) return rec.res;
    if (rec.replay) return NextResponse.json({ received: true, alreadyProcessed: true });
    await recordFee(admin, quote.tenant_id, target.id, payment.id, payment);
    await notifyTenantOwners({
      tenantId: quote.tenant_id,
      kind: "payment.received", // R-1575 alert — entityId is the Razorpay payment id
      title: `${rupee(amount)} received on old quote ${quote.id} — recorded on ${target.id}`,
      body:
        `${quote.customer_name ?? "Customer"} paid the old Razorpay link of replaced quote ${quote.id} (${payment.id}). ` +
        `The money was applied to the new quote ${target.id}` +
        (rec.overpaidCredit > 0 ? `; ${rupee(rec.overpaidCredit)} extra became customer credit` : "") +
        `. Open ${target.id} — collect any balance due; if paid in excess, decide refund or credit. No invoice or activation was done automatically.`,
      href: `/quotes/${target.id}`,
      entityId: payment.id,
    });
    console.warn(`[webhooks/razorpay] ${payment.id}: ${quote.id} was replaced — recorded on ${target.id}`);
    return NextResponse.json({ received: true, appliedTo: target.id, replacedQuote: quote.id });
  }

  const why = quote.status === "rejected" ? "is rejected" : `was replaced (${quote.superseded_by}) and no new quote is live`;
  return reportUnapplied(admin, { quote, payment, event, orderId, recordFee }, why,
    `Refund the customer (Razorpay dashboard), or create a new quote and record this payment on it (reference ${payment.id}).`);
}

/** R-1574's refusal: "Renewal quote … that term was already renewed (or its date was changed) …". */
export const STALE_RENEWAL_RE = /term was already renewed/i;

/**
 * R-1569 × R-1574: a Razorpay payment on a renewal quote made for a term that has since been
 * renewed (or whose date was changed). record_payment refuses it — booking it there would
 * renew nothing. The money goes to the subscription's CURRENT renewal quote (a part-payment,
 * or credit if that one is already paid), no automatic invoice or activation, owner told.
 * No current renewal quote → nothing honest to record it on: the owner is told, once.
 */
export async function settleStaleRenewal(
  admin: ReturnType<typeof createAdminClient>,
  args: LateArgs,
): Promise<NextResponse> {
  const { quote, payment, event, orderId, recordFee } = args;
  const amount = Math.round(payment.amount / 100);
  const { data: q } = await admin
    .from("quotes")
    .select("renewal_subscription_id")
    .eq("id", quote.id)
    .eq("tenant_id", quote.tenant_id)
    .maybeSingle();
  const subId = (q as { renewal_subscription_id?: string | null } | null)?.renewal_subscription_id ?? null;
  let current: SettledQuote | null = null;
  if (subId) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("renewal_quote_id")
      .eq("id", subId)
      .eq("tenant_id", quote.tenant_id)
      .maybeSingle();
    const curId = (sub as { renewal_quote_id?: string | null } | null)?.renewal_quote_id ?? null;
    if (curId && curId !== quote.id) {
      const { data: cur } = await admin
        .from("quotes")
        .select("id, tenant_id, customer_name, lead_id, status, superseded_by")
        .eq("id", curId)
        .eq("tenant_id", quote.tenant_id)
        .maybeSingle();
      const row = cur as SettledQuote | null;
      if (row && !row.superseded_by && row.status !== "rejected" && row.status !== "draft") current = row;
    }
  }

  if (current) {
    const rec = await recordOutOfBandPayment(admin, current.id, payment,
      `Razorpay ${event} · order ${orderId} · paid on old-term renewal quote ${quote.id} (R-1569)`);
    if (!rec.ok) return rec.res;
    if (rec.replay) return NextResponse.json({ received: true, alreadyProcessed: true });
    await recordFee(admin, quote.tenant_id, current.id, payment.id, payment);
    await notifyTenantOwners({
      tenantId: quote.tenant_id,
      kind: "payment.received", // R-1569 alert — entityId is the Razorpay payment id
      title: `${rupee(amount)} received on old quote ${quote.id} — recorded on ${current.id}`,
      body:
        `${quote.customer_name ?? "Customer"} paid old-term renewal quote ${quote.id} (${payment.id}); that term was already renewed. ` +
        `The money was applied to the subscription's current renewal quote ${current.id}` +
        (rec.overpaidCredit > 0 ? `; ${rupee(rec.overpaidCredit)} extra became customer credit` : "") +
        `. Open ${current.id} — decide refund or credit. No invoice or activation was done automatically.`,
      href: `/quotes/${current.id}`,
      entityId: payment.id,
    });
    console.warn(`[webhooks/razorpay] ${payment.id}: ${quote.id} is an old-term renewal — recorded on ${current.id}`);
    return NextResponse.json({ received: true, appliedTo: current.id, staleRenewal: quote.id });
  }

  return reportUnapplied(admin, args, "is an old-term renewal quote (that term was already renewed) and there is no current renewal quote",
    `Refund the customer (Razorpay dashboard), or create a new renewal quote on the subscription and record this payment on it (reference ${payment.id}) — any excess there becomes customer credit.`);
}

/**
 * Money with nowhere honest to be recorded: the owner is told, with every detail needed to
 * refund it or book it by hand, once per Razorpay payment id (the notification row is the
 * fact), plus a note on the lead. 200 — a retry cannot change the answer.
 */
async function reportUnapplied(
  admin: ReturnType<typeof createAdminClient>,
  { quote, payment, orderId }: LateArgs,
  why: string,
  nextStep: string,
): Promise<NextResponse> {
  const amount = Math.round(payment.amount / 100);
  const { data: told } = await admin
    .from("notifications")
    .select("id")
    .eq("tenant_id", quote.tenant_id)
    .eq("kind", "payment.received")
    .eq("entity_id", payment.id)
    .limit(1);
  if (told && told.length) return NextResponse.json({ received: true, alreadyProcessed: true });

  const detail =
    `Razorpay payment ${payment.id} (${rupee(amount)}, order ${orderId}) came in on quote ${quote.id}, but this quote ${why} — it was NOT recorded in the app. ` +
    nextStep;
  await notifyTenantOwners({
    tenantId: quote.tenant_id,
    kind: "payment.received", // R-1575 alert — entityId is the Razorpay payment id
    title: `${rupee(amount)} received but not recorded — quote ${quote.id}`,
    body: detail,
    href: `/quotes/${quote.id}`,
    entityId: payment.id,
  });
  if (quote.lead_id) {
    const { error } = await admin.from("lead_activities").insert({
      tenant_id: quote.tenant_id, lead_id: quote.lead_id, kind: "note", detail,
    });
    if (error) logDbError("webhooks/razorpay:unapplied-note", error);
  }
  console.error(`[webhooks/razorpay] UNAPPLIED ${payment.id} ₹${amount} on closed quote ${quote.id} — owner alerted`);
  return NextResponse.json({ received: true, unapplied: true, quoteId: quote.id });
}
