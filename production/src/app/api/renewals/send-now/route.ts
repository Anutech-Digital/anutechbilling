/**
 * Manual "Send now" override for a single subscription's renewal email.
 *
 * Used by the Renewals page row action ("Send now"). Differs from the daily
 * cron in three ways:
 *
 *   1. Tenant-scoped — authenticates with the user's session cookie, then
 *      checks the target subscription belongs to that tenant. No CRON_SECRET.
 *   2. Single subscription — body { subscription_id } picks one row.
 *   3. Force-send — even between cadence triggers, picks the most-recent
 *      applicable tone from CADENCE_TRIGGERS (or 'grace' if past renewal)
 *      and re-sends. Useful when a customer says "I didn't get the email"
 *      or operator wants to nudge ahead of schedule.
 *
 * Body: { subscription_id: string }
 * Returns: { status, providerId?, errorMessage?, step, daysUntil }
 *
 * Suspend/renewed states are NOT force-sendable — caller gets a friendly
 * error explaining why.
 */

import { NextResponse } from "next/server";
import { replyToAddress } from "@/lib/email/reply-to";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { primaryContactEmail } from "@/lib/contacts/primary";
import {
  triggersForTerm,
  decideCadence,
  type CadenceTone,
} from "@/lib/renewals/cadence";
import { renderTemplate } from "@/lib/renewals/templates";
import { createOrGetRenewalQuote } from "@/lib/renewals/create-renewal-quote";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // ── Authn ────────────────────────────────────────────────────────
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Body
  let body: { subscription_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  if (!body.subscription_id) {
    return NextResponse.json({ error: "subscription_id required" }, { status: 400 });
  }

  // Resolve tenant_id from auth user
  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  // Admin client for the cross-table reads/writes (RLS would already protect,
  // but service role keeps the logic identical to the cron path).
  const supabase = createAdminClientFor(authData.user.id);

  // ── Load subscription + verify tenant ownership ─────────────────
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select(
      `id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr,
       renewal_date, status, renewal_state, reminder_count, renewal_quote_id, term_months`
    )
    .eq("id", body.subscription_id)
    .single();

  if (subErr || !sub) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }
  if (sub.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!sub.renewal_date) {
    return NextResponse.json({ error: "subscription has no renewal_date" }, { status: 400 });
  }
  if (sub.renewal_state === "suspended" || sub.renewal_state === "renewed") {
    return NextResponse.json(
      { error: `cannot send — subscription is ${sub.renewal_state}` },
      { status: 400 }
    );
  }

  // ── Tenant + customer info ──────────────────────────────────────
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, email, phone, gstin, address, grace_period_days, state_code, logo_url")
    .eq("id", sub.tenant_id)
    .single();
  /* Wo mailbox jise app PADHTI hai. Reply-To wahi hona chahiye — 31 Aug 2026 ko
     tenants.email par bheja gaya jawab kisi ko dikha hi nahi. lib/email/reply-to.ts. */
  const { data: ingestBoxes } = await supabase
    .from("user_google_tokens").select("google_email").eq("tenant_id", sub.tenant_id);

  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { data: customer } = sub.customer_id
    ? await supabase
        .from("customers")
        .select("name, contact_name, contact_email, gstin, contact_phone, state_code")
        .eq("id", sub.customer_id)
        .single()
    : { data: null };

  // ── Decide cadence; if off-trigger, pick closest tone ───────────
  const decision = decideCadence({
    renewalDate:  sub.renewal_date,
    graceDays:    tenant.grace_period_days ?? 0,
    currentState: (sub.renewal_state ?? "pending") as never,
    /* The cron passes this and this route did not, so a monthly subscription force-sent
       from the screen was judged against the ANNUAL ladder while the same subscription in
       the nightly run was judged against the monthly one — one decision, two answers,
       depending on which button reached it. */
    termMonths:   sub.term_months,
  });

  // Pick effective tone for the manual send:
  //   - On a trigger / past-renewal: use decision.tone directly
  //   - Otherwise: pick the most-imminent upcoming trigger (smallest daysOut >= today's daysUntil)
  let tone: CadenceTone | null = decision.tone;
  if (!tone) {
    const daysUntil = decision.daysUntilRenewal;
    if (daysUntil < 0) {
      tone = "grace";
    } else {
      // Find the next trigger whose daysOut <= current daysUntil (sorted desc by daysOut)
      const candidates = [...triggersForTerm(sub.term_months)].sort((a, b) => b.daysOut - a.daysOut);
      const match = candidates.find((t) => t.daysOut <= daysUntil) ?? candidates[candidates.length - 1];
      tone = match?.tone ?? "soft";
    }
  }
  const step = decision.targetState === "pending" ? "notice_sent" : decision.targetState;

  // ── Ensure renewal quote exists (shared helper — idempotent) ─────
  const quoteResult = await createOrGetRenewalQuote({
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
  });
  const renewalQuoteId = quoteResult?.quoteId ?? null;
  const renewalQuote = quoteResult
    ? {
        amount:       quoteResult.amount,
        subtotal:     quoteResult.subtotal,
        discount_pct: quoteResult.discountPct,
        tax_rate:     quoteResult.taxRate,
      }
    : null;
  const lineItems: QuoteLineItem[] = quoteResult?.lineItems ?? [];

  // Public accept-link token (SEC-1) — the link needs the quote's opaque token.
  let renewalToken: string | null = null;
  if (renewalQuoteId) {
    const { data: tok } = await userClient
      .from("quotes").select("public_token").eq("id", renewalQuoteId).maybeSingle();
    renewalToken = tok?.public_token ?? null;
  }

  // ── Recipient ───────────────────────────────────────────────────
  /* The customer's PRIMARY CONTACT. customers.contact_email stopped being the truth on
     10 Sep 2026 — a customer's people live in `contacts`, one marked primary. The
     resolver keeps the old column as a floor so nobody becomes unreachable. */
  const resolvedContact = sub?.customer_id
    ? await primaryContactEmail(supabase, sub.customer_id)
    : { email: null, name: null, fromLegacy: false };
  const recipient = resolvedContact.email;
  if (!recipient) {
    await supabase.from("renewal_email_log").insert({
      tenant_id:       sub.tenant_id,
      subscription_id: sub.id,
      cadence_step:    step,
      recipient_email: "(missing)",
      subject:         "(skipped — manual)",
      status:          "skipped",
      error_message:   "Customer has no contact on file (no contacts row and no legacy contact_email)",
    });
    return NextResponse.json(
      { error: "This customer has no contact — add one on the customer page, then retry." },
      { status: 400 }
    );
  }

  // ── Render template ─────────────────────────────────────────────
  const tpl = renderTemplate(tone, {
    customerName:    customer?.contact_name || customer?.name || sub.customer_name,
    customerCompany: customer?.name,
    tenantName:      tenant.name,
    tenantEmail:     tenant.email,
    tenantPhone:     tenant.phone,
    planName:        sub.plan,
    seats:           sub.seats,
    amount:          renewalQuote?.amount ?? (sub.mrr ?? 0) * 12,
    renewalDate:     new Date(sub.renewal_date).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    }),
    daysUntil:       Math.abs(decision.daysUntilRenewal),
    graceDays:       tenant.grace_period_days ?? 0,
    acceptLink:      renewalQuoteId && renewalToken
      /* `?? undefined` because quoteAcceptUrl now returns null when NEXT_PUBLIC_APP_URL is
         missing or has no scheme. NO LINK is the right outcome there — the template omits
         it — and it beats what happened before: an empty base produced a RELATIVE path,
         which in an email is a link no mail client can resolve. Renewal reminders went out
         with an unclickable accept link and nothing errored. */
      ? (quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL, renewalQuoteId, renewalToken) ?? undefined)
      : undefined,
  });

  // ── PDF attachment ──────────────────────────────────────────────
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  if (renewalQuote && lineItems.length > 0) {
    try {
      const blob = await renderQuotePDF({
        tenantLogo:    await logoDataUri((tenant as { logo_url?: string | null }).logo_url),
        tenantName:    tenant.name,
        tenantGstin:   tenant.gstin,
        tenantEmail:   tenant.email,
        tenantPhone:   tenant.phone,
        tenantAddress: tenant.address,
        quoteId:       renewalQuoteId!,
        customerName:  sub.customer_name,
        contactName:   customer?.contact_name ?? null,
        contactEmail:  customer?.contact_email ?? null,
        contactPhone:  customer?.contact_phone ?? null,
        lineItems,
        subtotal:      renewalQuote.subtotal ?? renewalQuote.amount,
        discountPct:   renewalQuote.discount_pct ?? 0,
        discount:      0,
        taxable:       renewalQuote.subtotal ?? renewalQuote.amount,
        taxRate:       renewalQuote.tax_rate ?? 18,
        tax:           quoteDisplayTax(renewalQuote.subtotal ?? renewalQuote.amount, renewalQuote.tax_rate ?? 18, renewalQuote.amount), // R-804
        total:         renewalQuote.amount,
        interState:    isInterStateSupply(customer?.state_code, tenant.state_code, { customerGstin: customer?.gstin, sellerGstin: tenant.gstin }),
        validityDays:  30,
        notes:         "Renewal quote. Reply or call us with any questions.",
        isRenewal:     true,
      });
      const arrBuf = await blob.arrayBuffer();
      attachments = [{
        filename:    `Renewal-${renewalQuoteId}.pdf`,
        content:     Buffer.from(arrBuf),
        contentType: "application/pdf",
      }];
    } catch (pdfErr) {
      // Non-fatal — send without attachment
      // eslint-disable-next-line no-console
      console.warn(`[send-now] PDF render failed for ${sub.id}:`, (pdfErr as Error).message);
    }
  }

  // ── Send ────────────────────────────────────────────────────────
  const sendResult = await sendEmail({
    to:      recipient,
    subject: tpl.subject,
    text:    tpl.body,
    from:    tenant.email ?? undefined,
    replyTo: replyToAddress(ingestBoxes, tenant.email),
    route:   { tenantId: me.tenant_id },
    attachments,
  });

  // ── Log + update sub ────────────────────────────────────────────
  await supabase.from("renewal_email_log").insert({
    tenant_id:       sub.tenant_id,
    subscription_id: sub.id,
    cadence_step:    step,
    recipient_email: recipient,
    subject:         tpl.subject,
    status:          sendResult.status,
    provider_id:     sendResult.providerId,
    error_message:   sendResult.errorMessage,
  });

  if (sendResult.status === "sent" || sendResult.status === "stubbed") {
    await supabase
      .from("subscriptions")
      .update({
        renewal_state:           step,
        reminder_count:          (sub.reminder_count ?? 0) + 1,
        last_reminder_sent_at_v2: new Date().toISOString(),
      })
      .eq("id", sub.id);
  }

  return NextResponse.json({
    status:       sendResult.status,
    email_mode:   isEmailConfigured() ? "real" : "stub",
    providerId:   sendResult.providerId,
    errorMessage: sendResult.errorMessage,
    step,
    tone,
    daysUntil:    decision.daysUntilRenewal,
  });
}
