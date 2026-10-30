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
import { createAdminClientFor } from "@/lib/supabase/server";
import { withRoute } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { createOrGetRenewalQuote } from "@/lib/renewals/create-renewal-quote";
import { renewalQuoteBlockedReason } from "@/lib/renewals/split-billed-renewal";
import { renewalIsSettled, firstReminderDaysOut } from "@/lib/renewals/cadence";
import { rolledRenewalDate, nextPartMessage } from "@/lib/renewals/split-billed-next-part";
import { syncSubscriptionInstalments, readQuotePaymentFacts, INSTALMENT_SUB_SELECT, type InstalmentSub } from "@/lib/billing/sync-instalments.server";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* R-732: raising a renewal quote is a money action — owner / manager / accountant / billing
   (R-718), the same roles the Record-payment buttons follow. */
export const POST = withRoute({
  route: "api/subscriptions/[id]/generate-renewal-quote",
  roles: MONEY_RECORD_ROLES,
  roleHint: "Only an owner, manager, accountant or billing user can create a renewal quote.",
}, async ({ user, tenantId, params }) => {
  // ── 2. Load subscription + verify tenant scope ──────────────────
  const supabase = createAdminClientFor(user.id);
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select(
      `id, tenant_id, customer_id, customer_name, plan, item_id, seats, mrr,
       renewal_date, status, renewal_state, renewal_quote_id, term_months, billing_cycle, start_date`
    )
    .eq("id", params.id)
    .single();
  if (subErr || !sub) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }
  if (sub.tenant_id !== tenantId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!sub.renewal_date) {
    return NextResponse.json({ error: "subscription has no renewal_date set" }, { status: 400 });
  }
  /* R-808: billed in parts → no whole-term renewal quote (it was proven to bill the renewed
     year twice). The renewals cron rolls the term and the instalments keep coming. */
  const splitReason = renewalQuoteBlockedReason(sub.billing_cycle);
  if (splitReason) {
    /* R-2095 (staging, 30 Oct): a monthly sub whose month ended had NO part bill and Generate only
       refused — month 2 could not be billed. Generate now bills the NEXT PART: the term rolls on
       (as the renewals cron does on the new term's first day) and the due part goes the billing
       job's way — a payment request, or its tax invoice when it is already paid. */
    if (sub.status !== "active") {
      return NextResponse.json({ error: `cannot bill the next part — subscription is ${sub.status}` }, { status: 400 });
    }
    const today = istToday();
    const roll = rolledRenewalDate({
      billing_cycle: sub.billing_cycle, term_months: sub.term_months ?? 12, start_date: sub.start_date,
      renewal_date: sub.renewal_date, renewal_quote_id: sub.renewal_quote_id,
    }, today);
    if (roll.heldBy) {
      return NextResponse.json({ error: `Renewal quote ${roll.heldBy} is still open — paying it would bill the new term twice. Cancel it first, then Generate the next part.`, code: "split_billed" }, { status: 400 });
    }
    if (roll.rolls > 0 && roll.renewalDate) {
      const { error: rollErr } = await supabase.from("subscriptions")
        .update({ renewal_date: roll.renewalDate, renewal_state: "renewed", reminder_count: 0, last_reminder_sent_at_v2: null })
        .eq("id", sub.id).eq("status", "active").eq("renewal_date", sub.renewal_date).is("renewal_quote_id", null);
      if (rollErr) return NextResponse.json({ error: `Could not roll the term: ${rollErr.message}` }, { status: 500 });
    }
    const { data: fresh, error: fErr } = await supabase.from("subscriptions").select(INSTALMENT_SUB_SELECT).eq("id", sub.id).single();
    if (fErr || !fresh) return NextResponse.json({ error: fErr?.message ?? "subscription not found" }, { status: 500 });
    const facts = fresh.quote_id ? await readQuotePaymentFacts(supabase, fresh.quote_id) : undefined;
    const r = await syncSubscriptionInstalments({ supabase, sub: fresh as InstalmentSub, quote: facts, todayISO: today, rebillCredited: true });
    const msg = nextPartMessage(sub.customer_name, r, r.skip?.reason ?? null);
    return NextResponse.json(
      { split: true, rolledTo: roll.rolls > 0 ? roll.renewalDate : null, message: msg.text, href: msg.href,
        error: msg.ok ? undefined : msg.text, subscriptionId: sub.id },
      { status: msg.ok ? 200 : 400 },
    );
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `cannot generate quote — subscription is ${sub.status}` },
      { status: 400 }
    );
  }
  /* R-1562: 'renewed' blocks only while the NEW term's first reminder is still ahead — a
     quote right after the payment is almost always a mistake. The bare-state check blocked
     the renewal quote of every term after the first paid one, for good. */
  if (renewalIsSettled(sub.renewal_state, sub.renewal_date, sub.term_months)) {
    return NextResponse.json(
      { error: `Already renewed — the next term's renewal quote opens ${firstReminderDaysOut(sub.term_months)} days before ${sub.renewal_date}.` },
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
});
