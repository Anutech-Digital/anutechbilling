/**
 * Renewal automation cron — runs daily.
 *
 * Schedule: 09:00 IST, via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh).
 * NOT vercel.json — the live deployment is Cloud Run, where Vercel crons do not
 * exist. That file is inert here and its presence is misleading. Local dev can
 * trigger by hitting `curl http://localhost:3000/api/cron/renewals` with
 * Authorization: Bearer <CRON_SECRET>.
 *
 * What it does, for every active subscription with a renewal_date:
 *
 *   1. Compute today's cadence step (decideCadence).
 *   2. If a NEW step is triggered today:
 *        a. Auto-generate a renewal quote when entering 'notice_sent'
 *           (T-15) and the sub doesn't already have one.
 *        b. Render the appropriate tone template.
 *        c. Render the renewal Quote PDF as attachment.
 *        d. Send via lib/email/send.ts (real Resend if key configured;
 *           stub mode otherwise — both paths log to renewal_email_log).
 *   3. If shouldSuspend → flip status='paused' + stamp suspended_at +
 *      set renewal_state='suspended'.
 *   4. Update renewal_state + reminder_count + last_reminder_sent_at_v2.
 *
 * Auth: Vercel adds `Authorization: Bearer <CRON_SECRET>` to its cron
 * requests when CRON_SECRET env var is set. We accept that OR a manual
 * override matching the same secret. Without a secret env, the route
 * is open in dev — production should always set it.
 *
 * Idempotency: a given (subscription_id, cadence_step) pair only ever
 * gets one 'sent' / 'stubbed' row in renewal_email_log. Re-running the
 * cron the same day is a no-op for sends, but it WILL re-attempt
 * suspend if the previous run failed mid-flight.
 */

import { NextResponse } from "next/server";
import { replyToAddress } from "@/lib/email/reply-to";
import { createAdminClient } from "@/lib/supabase/server";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { decideCadence, CADENCE_TRIGGERS } from "@/lib/renewals/cadence";
import { renderTemplate } from "@/lib/renewals/templates";
import { createOrGetRenewalQuote } from "@/lib/renewals/create-renewal-quote";
import { splitBilledRenewalStep } from "@/lib/renewals/split-billed-renewal";
import { createDomainRenewalQuote } from "@/lib/domains/renewal";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { reportCron } from "@/lib/ops/cron-report";
import { mapLimit, chunk, uniq } from "@/lib/ops/p-limit";
import { fetchAllRows, fetchAllRowsIn, errorMessage } from "@/lib/ops/fetch-all";
import { createReminderSender } from "@/lib/marketing/whatsapp-reminders.server";
import { renewalReminderKind } from "@/lib/marketing/whatsapp-reminders";
import { rupee } from "@/lib/utils";
import { istToday, toIstDate, addDaysISO } from "@/lib/dates/ist";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** S22: subscriptions processed at once (PDF + email per row). */
const RENEWALS_CONCURRENCY = 5;
/** S22: ids per `.in()` prefetch — keeps each request URL and response well bounded. */
const PREFETCH_CHUNK = 200;

/** Every subscription the live pass may remind about — paged past PostgREST's 1000-row cap. */
function readRenewableSubs(supabase: ReturnType<typeof createAdminClient>) {
  return fetchAllRows((from, to) => supabase
    .from("subscriptions")
    .select(`
      id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr,
      renewal_date, status, renewal_state, reminder_count, renewal_quote_id, term_months, domain,
      billing_cycle, start_date
    `)
    .eq("status", "active")
    .eq("auto_renew", true)
    .not("renewal_date", "is", null)
    .order("id", { ascending: true })
    .range(from, to));
}

/** Body shape returned to the caller — useful for ad-hoc inspection. */
interface CronResult {
  ran_at:           string;
  email_mode:       "real" | "stub";
  total_active:     number;
  emails_sent:      number;
  emails_skipped:   number;
  suspends:         number;
  /** RN-24: subscriptions lapsed to 'expired' because they're not renewing and the term ended. */
  lapsed:           number;
  /** R-808: split-billed subscriptions whose term rolled on this run (no renewal quote). */
  split_rolled?:    number;
  errors:           { subscription_id: string; message: string }[];
  details:          { subscription_id: string; customer: string; step: string; daysUntil: number; emailStatus?: string }[];
  /** S28 — WhatsApp copy of each reminder. `disabled` = switch OFF (the default). */
  whatsapp?:        { sent: number; skipped: number; failed: number; disabled: number };
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse<CronResult | DryRunResult | { error: string }>> {
  // ── Auth check — FAIL CLOSED (SEC-3) ─────────────────────────────
  // This job lapses/suspends subscriptions and sends emails under the
  // service-role client, so it must never run unauthenticated. If the secret
  // isn't configured we refuse rather than allow (was: fail-open).
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();  // service role — bypasses RLS for the cron

  // ── Dry run ────────────────────────────────────────────────────────────
  // WHY THIS EXISTS. Production's earliest renewal is 2027-07-22, and the
  // cadence opens at T-15 — so the first real email is ~11 months out. Until
  // then this job runs daily and does nothing, which is correct but proves
  // nothing: an empty renewal_email_log looks identical whether the engine is
  // healthy or completely broken. Without a dry run its first proof of life
  // would be the day it emails real customers, and a wrong template or a
  // missed address would be discovered by the customer.
  //
  // `?on=YYYY-MM-DD` time-travels the decision so the whole 11-month schedule
  // can be rehearsed in seconds. It is accepted ONLY on a dry run: a live pass
  // for a pretend date would suspend and email against a calendar that isn't
  // real.
  //
  // This returns BEFORE any mutation rather than threading an `if (!dry)`
  // through the ~300 lines below. Guards get missed when code is added later;
  // an early return cannot be.
  const url    = new URL(req.url);
  const isDry  = url.searchParams.get("dry") === "1" || url.searchParams.get("dryRun") === "1";
  const onParam = url.searchParams.get("on");
  if (onParam && !isDry) {
    return NextResponse.json(
      { error: "`on` is only allowed with dry=1 — a live run must use today's date" },
      { status: 400 },
    );
  }
  if (isDry) return NextResponse.json(await planOnly(supabase, onParam));

  const result: CronResult = {
    ran_at:        new Date().toISOString(),
    email_mode:    isEmailConfigured() ? "real" : "stub",
    total_active:  0,
    emails_sent:   0,
    emails_skipped:0,
    suspends:      0,
    lapsed:        0,
    errors:        [],
    details:       [],
  };

  // ── RN-24: lapse NON-renewing subscriptions whose paid term has ended ──
  // auto_renew=false subs are skipped by the renewal cadence below, so without
  // this they'd sit 'active' forever past their renewal_date. Once the term has
  // ended (renewal_date strictly in the past) and the customer/operator chose
  // not to renew, the subscription lapses to 'expired'. Idempotent (only touches
  // 'active' rows) and non-destructive — a later renewal payment still revives
  // it via record_payment's roll-forward (which sets status='active').
  const todayIso = istToday();
  const { data: lapsedRows, error: lapseErr } = await supabase
    .from("subscriptions")
    .update({ status: "expired" })
    .eq("status", "active")
    .eq("auto_renew", false)
    .lt("renewal_date", todayIso)
    .select("id");
  if (lapseErr) {
    result.errors.push({ subscription_id: "(lapse-step)", message: lapseErr.message });
  } else {
    result.lapsed = lapsedRows?.length ?? 0;
  }

  // ── Fetch all active subscriptions across tenants with a renewal_date ─
  // Filters out auto_renew=false — customer chose to let it expire.
  /* WC-scale: paged (lib/ops/fetch-all.ts). One select stopped at PostgREST's 1000-row cap
     without saying so — subscription 1001 never got a renewal reminder. */
  let allSubs: Awaited<ReturnType<typeof readRenewableSubs>>;
  try {
    allSubs = await readRenewableSubs(supabase);
  } catch (e) {
    return cronDbFailure("renewals", e, `subs fetch failed: ${errorMessage(e)}`);
  }
  result.total_active = allSubs.length;

  /* ── S22: look-ups fetched ONCE, not three round trips per subscription ──
     This loop used to read the tenant, the tenant's ingest mailboxes and the customer
     afresh for every subscription — three queries per row, for every active sub, on
     every run, even though a run touches a handful of tenants. Same columns, same rows,
     now keyed in maps. A failed prefetch fails the run (500, so Scheduler retries and
     the health digest sees it) rather than silently skipping every subscription, which
     is what a null tenant per row used to do. */
  const tenantIds   = uniq(allSubs.map((s) => s.tenant_id));
  const customerIds = uniq(allSubs.map((s) => s.customer_id).filter((x): x is string => Boolean(x)));

  type TenantRow = { id: string; name: string; email: string | null; phone: string | null; gstin: string | null; address: string | null; grace_period_days: number | null; state_code: string | null; logo_url: string | null };
  type CustomerRow = { id: string; name: string; contact_name: string | null; contact_email: string | null; gstin: string | null; contact_phone: string | null; state_code: string | null };

  const tenantById = new Map<string, TenantRow>();
  const ingestByTenant = new Map<string, { google_email: string | null }[]>();
  const customerById = new Map<string, CustomerRow>();
  try {
    for (const ids of chunk(tenantIds, PREFETCH_CHUNK)) {
      const [{ data: ts, error: tErr }, { data: boxes, error: bErr }] = await Promise.all([
        supabase.from("tenants")
          .select("id, name, email, phone, gstin, address, grace_period_days, state_code, logo_url")
          .in("id", ids),
        /* Wo mailbox jise app PADHTI hai. Reply-To wahi hona chahiye — 31 Aug 2026 ko
           tenants.email par bheja gaya jawab kisi ko dikha hi nahi. lib/email/reply-to.ts. */
        supabase.from("user_google_tokens").select("tenant_id, google_email").in("tenant_id", ids),
      ]);
      if (tErr) throw new Error(`tenants: ${tErr.message}`);
      if (bErr) throw new Error(`user_google_tokens: ${bErr.message}`);
      for (const t of (ts ?? []) as TenantRow[]) tenantById.set(t.id, t);
      for (const b of boxes ?? []) {
        const list = ingestByTenant.get(b.tenant_id) ?? [];
        list.push({ google_email: b.google_email });
        ingestByTenant.set(b.tenant_id, list);
      }
    }
    for (const ids of chunk(customerIds, PREFETCH_CHUNK)) {
      const { data: cs, error: cErr } = await supabase.from("customers")
        .select("id, name, contact_name, contact_email, gstin, contact_phone, state_code")
        .in("id", ids);
      if (cErr) throw new Error(`customers: ${cErr.message}`);
      for (const c of (cs ?? []) as CustomerRow[]) customerById.set(c.id, c);
    }
  } catch (e) {
    return NextResponse.json({ error: `prefetch failed: ${(e as Error).message}` }, { status: 500 });
  }

  /* The logo is the same image for every renewal PDF a tenant sends in a run. */
  const logoByTenant = new Map<string, ReturnType<typeof logoDataUri>>();
  const tenantLogo = (tenantId: string, url: string | null | undefined) => {
    let p = logoByTenant.get(tenantId);
    if (!p) { p = logoDataUri(url); logoByTenant.set(tenantId, p); }
    return p;
  };

  /* S22: RENEWALS_CONCURRENCY subscriptions at a time instead of strictly one by one.
     Each row's own steps stay in order; rows never share state except the counters on
     `result`, which JS mutates on one thread. Quote numbers come from
     next_document_number(), an atomic upsert, so two rows of one tenant cannot collide. */
  /* S28: ek sender poore run ke liye. Default OFF — kuch nahi bhejta jab tak switch ON na ho.
     Tenant config ek shared promise me cache hota hai, isliye 5-at-a-time bhi ek hi read. */
  const wa = createReminderSender();

  await mapLimit(allSubs, RENEWALS_CONCURRENCY, async (sub) => {
    try {
      const tenant = tenantById.get(sub.tenant_id) ?? null;
      const ingestBoxes = ingestByTenant.get(sub.tenant_id) ?? [];

      if (!tenant) return;

      /* ── R-808: billed in parts → no whole-term renewal quote, the term rolls itself ──
         A monthly/quarterly/half-yearly subscription pays by instalment. A whole-year renewal
         quote on top was proven (local DB) to bill the renewed year twice: once as the paid
         quote's whole-year invoice, again as four PENDING instalment invoices. So no quote,
         no reminder ladder and no grace suspension here (unpaid instalments are chased by
         collections). On the new term's first day renewal_date moves one term on and the
         billing cron invoices the new term's parts on their dates. lib/renewals/split-billed-renewal.ts */
      const split = splitBilledRenewalStep(
        { billing_cycle: sub.billing_cycle, term_months: sub.term_months, start_date: sub.start_date,
          renewal_date: sub.renewal_date, renewal_quote_id: sub.renewal_quote_id },
        todayIso,
      );
      if (split.kind !== "not_split_billed") {
        if (split.kind === "held_open_quote") {
          result.errors.push({
            subscription_id: sub.id,
            message: `Billed in parts, and renewal quote ${split.quoteId} is still open. Paying it would bill the new term twice, so the term was not rolled. Cancel or unlink that quote; the next run rolls the term.`,
          });
        } else if (split.kind === "roll") {
          /* Guarded on the date read: two overlapping runs roll once, not twice. */
          const { data: rolled, error: rollErr } = await supabase
            .from("subscriptions")
            .update({
              renewal_date:  split.newRenewalDate,
              renewal_state: "renewed",
              reminder_count: 0,
              last_reminder_sent_at_v2: null,
            })
            .eq("id", sub.id)
            .eq("status", "active")
            .eq("renewal_date", sub.renewal_date!)
            .is("renewal_quote_id", null)
            .select("id");
          if (rollErr) {
            result.errors.push({ subscription_id: sub.id, message: `Could not roll the term: ${rollErr.message}` });
          } else if ((rolled ?? []).length > 0) {
            result.split_rolled = (result.split_rolled ?? 0) + 1;
            result.details.push({
              subscription_id: sub.id,
              customer:        sub.customer_name,
              step:            `renewed (billed in parts) → ${split.newRenewalDate}`,
              daysUntil:       0,
            });
          }
        }
        return;
      }

      // ── Per-customer info — need email to actually send ──
      const customer = sub.customer_id ? customerById.get(sub.customer_id) ?? null : null;

      // Decide cadence
      const decision = decideCadence({
        renewalDate:  sub.renewal_date!,
        graceDays:    tenant.grace_period_days ?? 0,
        currentState: sub.renewal_state ?? "pending",
        /* The TERM picks the ladder, not the invoice frequency. An annual plan paid
           monthly is invoiced twelve times and renews once, and it needs the 30-day
           runway; a flex-monthly plan renews every month and would be buried by it. */
        termMonths:   sub.term_months,
      });

      const detail = {
        subscription_id: sub.id,
        customer:        sub.customer_name,
        step:            decision.targetState,
        daysUntil:       decision.daysUntilRenewal,
        emailStatus:    undefined as string | undefined,
      };

      // ── Suspend path ─────────────────────────────────────────────
      if (decision.shouldSuspend) {
        await supabase
          .from("subscriptions")
          .update({
            status:        "paused",
            renewal_state: "suspended",
            suspended_at:  new Date().toISOString(),
          })
          .eq("id", sub.id);
        result.suspends += 1;
        detail.emailStatus = "(suspended)";
        result.details.push(detail);
        return;
      }

      // ── Daily idempotency: did we already attempt this (sub,step) today? ──
      // Without this, a broken Resend key burns one API call per sub per day,
      // and re-runs (manual triggers, retries) duplicate-attempt every step.
      if (decision.shouldSendEmail) {
        const { count: attemptsToday } = await supabase
          .from("renewal_email_log")
          .select("id", { count: "exact", head: true })
          .eq("subscription_id", sub.id)
          .eq("cadence_step", decision.targetState)
          .gte("sent_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
        if ((attemptsToday ?? 0) > 0) {
          detail.emailStatus = "(already attempted today)";
          result.emails_skipped += 1;
          // Still sync renewal_state so UI reflects current cadence position
          if (sub.renewal_state !== decision.targetState) {
            await supabase
              .from("subscriptions")
              .update({ renewal_state: decision.targetState })
              .eq("id", sub.id);
          }
          result.details.push(detail);
          return;
        }
      }

      // ── Email path ───────────────────────────────────────────────
      if (decision.shouldSendEmail && decision.tone) {
        // 1. Ensure renewal quote exists (only matters at T-15 entry)
        // Ensure renewal quote exists for ANY cadence step where we're emailing.
        // Helper is idempotent — returns the existing quote if one is linked.
        // Originally restricted to T-15 ('notice_sent'); that meant freshly
        // created subs or those whose renewal_date got edited could fire a
        // 'FINAL NOTICE' email at T-0 with no quote attached. Now we always
        // try to ensure a quote exists before sending.
        /* A DOMAIN renews at ResellerClub's live renewal price, read now (owner, 25 Sep
           2026), not from the stored mrr — which is 0 for a domain that came free with
           yearly hosting. Everything else keeps the shared helper. */
        const quoteResult = sub.vendor === "domain" && sub.domain
          ? await createDomainRenewalQuote({
              supabase,
              subscriptionId:  sub.id,
              tenantId:        sub.tenant_id,
              customerId:      sub.customer_id,
              customerName:    sub.customer_name,
              domain:          sub.domain,
              renewalDate:     sub.renewal_date!,
              graceDays:       tenant.grace_period_days ?? 0,
              existingQuoteId: sub.renewal_quote_id,
            })
          : await createOrGetRenewalQuote({
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
          renewalDate:     sub.renewal_date!,
          graceDays:       tenant.grace_period_days ?? 0,
          existingQuoteId: sub.renewal_quote_id,
          notes:           `Auto-generated renewal quote for subscription ${sub.id}`,
        });

        /* A domain whose live renewal price could not be read gets no email this run: a
           reminder with no price and no way to pay is worse than one a day later. The
           reason is logged by createDomainRenewalQuote and the step is retried next run,
           because nothing was logged as sent. */
        if (sub.vendor === "domain" && !quoteResult) {
          detail.emailStatus = "(held: live domain renewal price unavailable — retried next run)";
          result.emails_skipped += 1;
          result.errors.push({ subscription_id: sub.id, message: `No renewal quote for domain ${sub.domain}: the live renewal price could not be read.` });
          result.details.push(detail);
          return;
        }

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

        // Public accept-link token (SEC-1)
        let renewalToken: string | null = null;
        if (renewalQuoteId) {
          const { data: tok } = await supabase
            .from("quotes").select("public_token").eq("id", renewalQuoteId).maybeSingle();
          renewalToken = tok?.public_token ?? null;
        }

        /* 2. Recipient — the customer's PRIMARY CONTACT.
           customers.contact_email stopped being the truth on 10 Sep 2026: a
           customer's people live in `contacts` now, one marked primary, and that is
           who a renewal notice goes to. The resolver keeps the old column as a floor,
           so a customer created without contacts is still reached rather than skipped
           — this cron's own log calls that case "(missing)", and a renewal nobody was
           told about is a renewal that lapses. */
        const resolvedContact = sub.customer_id
          ? await primaryContactEmail(supabase, sub.customer_id)
          : { email: null, name: null, fromLegacy: false };
        if (resolvedContact.fromLegacy) {
          console.warn(
            `[renewals] subscription ${sub.id}: no contact row for customer ${sub.customer_id} — used the legacy customers.contact_email`,
          );
        }
        const recipient = resolvedContact.email;

        /* ── S28: WhatsApp copy — email ke "no recipient" skip se PEHLE ───────────
           Jiska email nahi hai uska WhatsApp ho sakta hai, isliye ye yahan hai. Sender kabhi
           throw nahi karta, aur (subscription, step) par ek hi baar bhejta hai — to kal ka
           email-retry isse dobara nahi bhejega. */
        const waOut = await wa.send({
          tenantId:    sub.tenant_id,
          kind:        renewalReminderKind(decision.tone),
          subjectType: "subscription",
          subjectId:   sub.id,
          step:        decision.targetState,
          customerId:  sub.customer_id,
          values: {
            customer_name: resolvedContact.name || customer?.contact_name || customer?.name || sub.customer_name,
            seller_name:   tenant.name,
            plan:          sub.plan,
            amount:        renewalQuote ? rupee(renewalQuote.amount) : null,
            due_date:      new Date(sub.renewal_date!).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
            days:          Math.abs(decision.daysUntilRenewal),
            link:          renewalQuoteId && renewalToken
              ? quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL, renewalQuoteId, renewalToken)
              : null,
          },
        });
        if (waOut.status === "failed") {
          result.errors.push({ subscription_id: sub.id, message: `whatsapp: ${waOut.error}` });
        }

        if (!recipient) {
          await supabase.from("renewal_email_log").insert({
            tenant_id:       sub.tenant_id,
            subscription_id: sub.id,
            cadence_step:    decision.targetState,
            recipient_email: "(missing)",
            subject:         "(skipped)",
            status:          "skipped",
            error_message:   "Customer has no contact on file (no contacts row and no legacy contact_email)",
          });
          result.emails_skipped += 1;
          detail.emailStatus = "skipped — no email";
          result.details.push(detail);
          return;
        }

        // 3. Render template
        const tpl = renderTemplate(decision.tone, {
          customerName:    resolvedContact.name || customer?.contact_name || customer?.name || sub.customer_name,
          customerCompany: customer?.name,
          tenantName:      tenant.name,
          tenantEmail:     tenant.email,
          tenantPhone:     tenant.phone,
          planName:        sub.plan,
          seats:           sub.seats,
          amount:          renewalQuote?.amount ?? (sub.mrr ?? 0) * 12,
          renewalDate:     new Date(sub.renewal_date!).toLocaleDateString("en-IN", {
            day: "numeric", month: "short", year: "numeric",
          }),
          daysUntil:       Math.abs(decision.daysUntilRenewal),
          graceDays:       tenant.grace_period_days ?? 0,
          acceptLink:      renewalQuoteId && renewalToken
            /* `?? undefined` because quoteAcceptUrl now returns null when NEXT_PUBLIC_APP_URL
               is missing or has no scheme. NO LINK is the right outcome — the template omits
               it — and it beats the previous behaviour: an empty base produced a RELATIVE
               path, which in an email no mail client can resolve. Renewal reminders were
               going out with an unclickable accept link and nothing errored. */
            ? (quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL, renewalQuoteId, renewalToken) ?? undefined)
            : undefined,
        });

        // 4. Render PDF attachment (only when we have a quote)
        let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
        if (renewalQuote && lineItems.length > 0) {
          try {
            const blob = await renderQuotePDF({
              tenantLogo:    await tenantLogo(sub.tenant_id, tenant.logo_url),
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
              // Use the quote's actual rate (0 for a zero-rated export renewal) —
              // never a hardcoded 18% (which taxed foreign auto-renewals wrongly).
              tax:           Math.round((renewalQuote.subtotal ?? renewalQuote.amount) * (renewalQuote.tax_rate ?? 18) / 100),
              total:         renewalQuote.amount,
              interState:    isInterStateSupply(customer?.state_code, tenant.state_code, { customerGstin: customer?.gstin, sellerGstin: tenant.gstin }),
              validityDays:  30,
              notes:         "Renewal quote — auto-generated. Reply or call us with any questions.",
              isRenewal:     true,
            });
            const arrBuf = await blob.arrayBuffer();
            attachments = [{
              filename:    `Renewal-${renewalQuoteId}.pdf`,
              content:     Buffer.from(arrBuf),
              contentType: "application/pdf",
            }];
          } catch (pdfErr) {
            // PDF gen failure shouldn't block the email — just send without attachment
            // and note in the audit log via error_message at end.
            // eslint-disable-next-line no-console
            console.warn(`[cron/renewals] PDF render failed for ${sub.id}:`, (pdfErr as Error).message);
          }
        }

        // 5. Send
        const sendResult = await sendEmail({
          to:      recipient,
          subject: tpl.subject,
          text:    tpl.body,
          from:    tenant.email ?? undefined,
          /* Wahi bug jo 31 Aug ko quote par tha: jawab us mailbox me girta tha jise app
       padhti hi nahi. Renewal recurring revenue hai — wahan jawab sabse zaroori. */
    replyTo: replyToAddress(ingestBoxes, tenant.email),
              route:   { tenantId: sub.tenant_id },
          attachments,
          kind:    "renewal_reminder",
          /* Gated by the workspace kill switch + dial (23 Aug 2026). Before that there was
             no way to stop this cron mailing customers short of disabling a Cloud Scheduler
             job in a Google console. A refusal returns status "failed" carrying the reason,
             and the renewal_email_log write below records it — so a silenced reminder shows
             up as silenced rather than as absent. */
          automated: { tenantId: sub.tenant_id, action: "renewal.send" },
        });

        // 6. Log + update sub state
        await supabase.from("renewal_email_log").insert({
          tenant_id:       sub.tenant_id,
          subscription_id: sub.id,
          cadence_step:    decision.targetState,
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
              renewal_state:           decision.targetState,
              reminder_count:          (sub.reminder_count ?? 0) + 1,
              last_reminder_sent_at_v2: new Date().toISOString(),
            })
            .eq("id", sub.id);
          result.emails_sent += 1;
          detail.emailStatus = sendResult.status;
        } else {
          result.errors.push({ subscription_id: sub.id, message: sendResult.errorMessage ?? "send failed" });
          detail.emailStatus = `failed: ${sendResult.errorMessage}`;
        }

        result.details.push(detail);
        return;
      }

      // ── No-op path: sync renewal_state if it drifted ─────────────
      // Guard against REGRESSING from terminal states:
      //   - 'renewed': sub was just paid for this cycle. decideCadence
      //     would return 'pending' for far-future renewal_dates, which
      //     would wipe the "just renewed" signal until next T-15.
      //   - 'suspended': sub was auto-suspended. Don't quietly revive it.
      // Both states must be cleared explicitly (operator action or new
      // renewal payment via record_payment).
      const isTerminalState =
        sub.renewal_state === "renewed" ||
        sub.renewal_state === "suspended";
      if (!isTerminalState && sub.renewal_state !== decision.targetState) {
        await supabase
          .from("subscriptions")
          .update({ renewal_state: decision.targetState })
          .eq("id", sub.id);
      }
      // Don't push to details unless something happened — keeps the result body small
    } catch (err) {
      result.errors.push({
        subscription_id: sub.id,
        message:         (err as Error).message,
      });
    }
  });

  result.whatsapp = { ...wa.totals };
  return NextResponse.json(reportCron("renewals", result));
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry run — read-only rehearsal of the cadence.
//
// Nothing in here writes, sends, or creates. It answers one question: if the
// cron ran on this date, what would it actually do, and to whom?
// ─────────────────────────────────────────────────────────────────────────────

interface PlannedAction {
  subscription_id: string;
  customer:        string;
  renewal_date:    string;
  days_until:      number;
  step:            string;
  tone:            string | null;
  action:          "email" | "suspend";
  /** Where the email would land — or why it would go nowhere. */
  recipient:       string;
  /** True when the action is planned but cannot actually be delivered. */
  blocked:         boolean;
}

interface DryRunResult {
  dry_run:            true;
  evaluated_for:      string;
  email_mode:         "real" | "stub";
  subscriptions_seen: number;
  /** Active + auto_renew + has a renewal date — what the cron would look at. */
  eligible:           number;
  would_email:        number;
  would_suspend:      number;
  /** Planned sends with no usable customer email — these fail silently in a real run. */
  blocked_no_email:   number;
  next_action_on:     string | null;
  actions:            PlannedAction[];
  notes:              string[];
}

async function planOnly(
  supabase: ReturnType<typeof createAdminClient>,
  onParam: string | null,
): Promise<DryRunResult | { error: string }> {
  let asOf = new Date();
  if (onParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(onParam)) {
      return { error: "`on` must be YYYY-MM-DD" };
    }
    // Midday IST — far enough from either midnight that the date can't slip.
    asOf = new Date(`${onParam}T12:00:00+05:30`);
    if (Number.isNaN(asOf.getTime())) return { error: "`on` is not a real date" };
  }

  /* WC-scale: the dry run read EVERY subscription (any status) in one select and filtered
     in JS — past 1000 rows it planned for whichever thousand came back. Filtered in SQL and
     paged now, and the look-ups read 200 ids a request. */
  const eligible = (await fetchAllRows((from, to) => supabase
    .from("subscriptions")
    .select("id, tenant_id, customer_id, customer_name, renewal_date, status, renewal_state, auto_renew, term_months, billing_cycle, start_date, renewal_quote_id")
    .eq("status", "active")
    .eq("auto_renew", true)
    .not("renewal_date", "is", null)
    .order("id", { ascending: true })
    .range(from, to))).filter(
    (s) => s.status === "active" && s.auto_renew === true && s.renewal_date,
  );

  /* "Seen" meant every subscription, any status — a count, not a download. */
  const { count: subsSeen } = await supabase.from("subscriptions").select("id", { count: "exact", head: true });

  const tenants = await fetchAllRowsIn(eligible.map((s) => s.tenant_id), (ids, from, to) => supabase
    .from("tenants").select("id, grace_period_days").in("id", ids).order("id", { ascending: true }).range(from, to));
  const graceByTenant = new Map(tenants.map((t) => [t.id, t.grace_period_days ?? 0]));

  // One fetch for every customer involved, rather than per-subscription — a dry
  // run should be cheap enough that nobody hesitates to use it.
  const customers = await fetchAllRowsIn(eligible.map((s) => s.customer_id), (ids, from, to) => supabase
    .from("customers").select("id, contact_email").in("id", ids).order("id", { ascending: true }).range(from, to));
  const emailByCustomer = new Map(
    customers.map((c) => [c.id, (c as { contact_email?: string | null }).contact_email ?? null]),
  );

  const actions: PlannedAction[] = [];
  let blockedNoEmail = 0;
  let nextActionOn: string | null = null;

  let splitRolls = 0;
  let splitHeld = 0;
  for (const sub of eligible) {
    /* R-808: billed in parts → no reminder, no quote; the term rolls on its first day. */
    const split = splitBilledRenewalStep(sub, toIstDate(asOf));
    if (split.kind !== "not_split_billed") {
      if (split.kind === "roll") splitRolls += 1;
      if (split.kind === "held_open_quote") splitHeld += 1;
      continue;
    }
    const decision = decideCadence({
      renewalDate:  sub.renewal_date!,
      graceDays:    graceByTenant.get(sub.tenant_id) ?? 0,
      currentState: (sub.renewal_state ?? "pending") as never,
      termMonths:   sub.term_months,
      today:        asOf,
    });

    if (!decision.shouldSendEmail && !decision.shouldSuspend) {
      // Track when this subscription NEXT wakes up, so a quiet run still tells
      // the operator the engine is alive and when it will speak.
      const firstTrigger = CADENCE_TRIGGERS[0].daysOut;
      if (decision.daysUntilRenewal > firstTrigger) {
        const iso = addDaysISO(sub.renewal_date!, -firstTrigger);
        if (!nextActionOn || iso < nextActionOn) nextActionOn = iso;
      }
      continue;
    }

    const email   = sub.customer_id ? emailByCustomer.get(sub.customer_id) ?? null : null;
    const blocked = decision.shouldSendEmail && !email;
    if (blocked) blockedNoEmail += 1;

    actions.push({
      subscription_id: sub.id,
      customer:        sub.customer_name ?? "(unnamed)",
      renewal_date:    sub.renewal_date!,
      days_until:      decision.daysUntilRenewal,
      step:            decision.targetState,
      tone:            decision.tone,
      action:          decision.shouldSuspend ? "suspend" : "email",
      recipient:       email ?? "— no customer email on file —",
      blocked,
    });
  }

  const notes: string[] = [];
  if (splitRolls > 0) {
    notes.push(`${splitRolls} subscription(s) billed in parts would renew today: the term rolls on and the billing cron invoices the next parts. No renewal quote.`);
  }
  if (splitHeld > 0) {
    notes.push(`${splitHeld} subscription(s) billed in parts are due to renew but still have an open renewal quote. They would not roll until a person cancels or unlinks that quote.`);
  }
  if (!isEmailConfigured()) {
    notes.push("Email is in STUB mode — a real run would log to renewal_email_log without delivering anything.");
  }
  if (blockedNoEmail > 0) {
    notes.push(`${blockedNoEmail} planned reminder(s) have no customer email address and would go nowhere.`);
  }
  if (actions.length === 0) {
    notes.push(
      nextActionOn
        ? `Nothing due. The first reminder falls on ${nextActionOn} — re-run with ?dry=1&on=${nextActionOn} to rehearse it.`
        : "Nothing due, and no upcoming reminder could be dated from the current subscriptions.",
    );
  }

  return {
    dry_run:            true,
    evaluated_for:      toIstDate(asOf),
    email_mode:         isEmailConfigured() ? "real" : "stub",
    subscriptions_seen: subsSeen ?? eligible.length,
    eligible:           eligible.length,
    would_email:        actions.filter((a) => a.action === "email").length,
    would_suspend:      actions.filter((a) => a.action === "suspend").length,
    blocked_no_email:   blockedNoEmail,
    next_action_on:     nextActionOn,
    actions,
    notes,
  };
}
