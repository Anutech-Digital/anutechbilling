/**
 * POST /api/subscriptions/[id]/generate-renewal-quote
 *
 * Operator-initiated renewal-quote creation — fires the same flow the
 * daily cron runs at T-15, but on demand. Common reasons:
 *
 *   - Customer's finance team wants the quote 60-90 days in advance
 *     for budgeting / PO approval.
 *   - Operator wants to lock in a price ahead of time (renewal
 *     negotiation, plan upgrade conversation, etc.).
 *   - Customer asked for a fresh quote to compare against a competitor.
 *
 * Behaviour:
 *   - Idempotent — if subscription.renewal_quote_id is already set,
 *     returns that quote unchanged. Operator can then open it in the
 *     builder to edit (seats, plan, discount, billing cycle, etc.).
 *   - Sets subscription.renewal_state to 'notice_sent' so the cron
 *     skips re-creating the quote. Cadence reminders (T-12 onwards)
 *     still fire normally.
 *   - Does NOT send the email — operator decides when to send via
 *     the existing "Send via email" flow on the quote detail page.
 *
 * Returns: { quoteId, created (bool), amount, alreadyExisted (bool) }
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { createOrGetRenewalQuote } from "@/lib/renewals/create-renewal-quote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // ── 1. Authn ─────────────────────────────────────────────────────
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  // ── 2. Load subscription + verify tenant scope ──────────────────
  const supabase = createAdminClientFor(authData.user.id);
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select(
      `id, tenant_id, customer_id, customer_name, plan, item_id, seats, mrr,
       renewal_date, status, renewal_state, renewal_quote_id, term_months`
    )
    .eq("id", params.id)
    .single();
  if (subErr || !sub) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }
  if (sub.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!sub.renewal_date) {
    return NextResponse.json({ error: "subscription has no renewal_date set" }, { status: 400 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `cannot generate quote — subscription is ${sub.status}` },
      { status: 400 }
    );
  }
  if (sub.renewal_state === "renewed") {
    return NextResponse.json(
      { error: "this subscription has already been renewed" },
      { status: 400 }
    );
  }

  // ── 3. Tenant info (grace_period_days drives validity) ──────────
  const { data: tenant } = await supabase
    .from("tenants")
    .select("grace_period_days")
    .eq("id", sub.tenant_id)
    .single();
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  // ── 4. Create or return existing quote ──────────────────────────
  const result = await createOrGetRenewalQuote({
    supabase,
    subscriptionId:  sub.id,
    tenantId:        sub.tenant_id,
    customerId:      sub.customer_id,
    customerName:    sub.customer_name,
    plan:            sub.plan,
    itemId:            sub.item_id ?? null,
    seats:           sub.seats,
    mrr:             sub.mrr ?? 0,
    termMonths:      sub.term_months ?? null,
    renewalDate:     sub.renewal_date,
    graceDays:       tenant.grace_period_days ?? 0,
    existingQuoteId: sub.renewal_quote_id,
    notes:           sub.renewal_quote_id
      ? undefined
      : `Renewal quote (operator-generated) for subscription ${sub.id}`,
  });

  if (!result) {
    return NextResponse.json(
      { error: "could not create renewal quote — document numbering may be misconfigured" },
      { status: 500 }
    );
  }

  // ── 5. Advance renewal_state so cron skips re-creation ──────────
  // Only bump if currently in 'pending' — we don't want to regress
  // a sub that's already past T-15 in the cadence.
  if (result.created && sub.renewal_state === "pending") {
    await supabase
      .from("subscriptions")
      .update({ renewal_state: "notice_sent" })
      .eq("id", sub.id);
  }

  return NextResponse.json({
    quoteId:         result.quoteId,
    created:         result.created,
    alreadyExisted:  !result.created,
    amount:          result.amount,
    subscriptionId:  sub.id,
  });
}
