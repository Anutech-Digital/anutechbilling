/**
 * Invoice dunning cron — runs daily.
 *
 * Chases invoices that have gone PAST their due date. This is a different job from
 * /api/cron/renewals, which counts DOWN to a subscription's renewal_date — see the
 * header of lib/invoices/dunning.ts for why running one engine on both clocks would
 * chase the wrong customers.
 *
 * Per unpaid invoice with a due date:
 *   1. decideDunning() → which step is due today (with a catch-up rule for a missed day)
 *   2. Already logged? do nothing.
 *   3. action 'email'    → send the customer the step's message
 *      action 'escalate' → tell the RESELLER; the customer is emailed the final notice too
 *      action 'suspend'  → pause the linked subscription (opt-in only; see below)
 *   4. Log what was actually done, which is not always what the step implies.
 *
 * AUTH FAILS CLOSED. This job emails customers and can pause subscriptions under the
 * service-role client. No CRON_SECRET configured means 503, not "run anyway".
 *
 * DRY RUN. `?dry=1` decides and reports without sending, suspending or logging, and
 * `?on=YYYY-MM-DD` time-travels the decision — accepted ONLY on a dry run, because a
 * live pass against a pretend calendar would email real customers about dates that
 * have not happened. Same reasoning as the renewals cron, and the same reason: a
 * quiet log looks identical whether the engine is healthy or completely broken.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { decideDunning, dunningMessage, dunningRank, type DunningStep } from "@/lib/invoices/dunning";
import { upiPayLink } from "@/lib/invoices/pay-link";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { dunningLogStatus, reachedNobody } from "@/lib/invoices/dunning-log-status";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { rupee, formatDate } from "@/lib/utils";
import { reportCron } from "@/lib/ops/cron-report";
import { fetchAllRows, fetchAllRowsIn, errorMessage } from "@/lib/ops/fetch-all";
import type { Invoice, Tenant } from "@/lib/supabase/database.types";
import { createReminderSender } from "@/lib/marketing/whatsapp-reminders.server";
import { dunningReminderKind } from "@/lib/marketing/whatsapp-reminders";
import { isMissingDbObject } from "@/lib/credit/activate-on-credit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * quote_id → the ONE subscription billed from it. Same answer the old per-invoice
 * `.eq("quote_id", …).maybeSingle()` gave: a quote with two subscriptions made maybeSingle
 * error, `data` came back null, and the invoice was treated as having no subscription to
 * suspend. Ambiguous stays "none" here — suspending the wrong one of two is worse.
 */
function subscriptionIdByQuote(subs: readonly { id: string; quote_id: string | null }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const s of subs) {
    if (!s.quote_id) continue;
    out.set(s.quote_id, out.has(s.quote_id) ? null : s.id);
  }
  return out;
}

interface DunningResult {
  ran_at: string;
  dry_run: boolean;
  email_mode: "real" | "stub";
  considered: number;
  emails_sent: number;
  /**
   * Steps that reached NOBODY because the customer has no email on file.
   *
   * Reported separately from `emails_sent` because the two were previously
   * indistinguishable in the log: `invoice_dunning_log.status` was set from
   * `isEmailConfigured()`, so a step with no recipient was recorded as "sent". Two such
   * rows exist for INV-3BBD-2026-27-0002 (19 and 21 Aug 2026) and no email was sent for
   * either. A missing customer address is the reseller's to fix, and they cannot fix what
   * the cron reports as done.
   */
  no_recipient: number;
  escalations: number;
  suspends: number;
  skipped: number;
  details: { invoice_id: string; step: DunningStep; action: string; days_overdue: number; reason: string }[];
  errors: { invoice_id: string; message: string }[];
  /** S28 — WhatsApp copy of each step. `disabled` = company ne switch ON nahi kiya (default). */
  whatsapp?: { sent: number; skipped: number; failed: number; disabled: number };
}

async function handle(req: Request): Promise<NextResponse<DunningResult | { error: string }>> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const onParam = url.searchParams.get("on");
  if (onParam && !dryRun) {
    return NextResponse.json(
      { error: "?on= is only accepted with ?dry=1 — a live pass against a pretend date would email real customers." },
      { status: 400 },
    );
  }
  const asOf = onParam ? new Date(`${onParam}T12:00:00+05:30`) : new Date();

  const supabase = createAdminClient();
  const result: DunningResult = {
    ran_at: asOf.toISOString(),
    dry_run: dryRun,
    email_mode: isEmailConfigured() ? "real" : "stub",
    considered: 0, emails_sent: 0, no_recipient: 0, escalations: 0, suspends: 0, skipped: 0,
    details: [], errors: [],
  };

  /* Only invoices that could possibly be chased. 'paid'/'void'/'draft' and
     due-date-less rows are excluded in SQL rather than filtered in JS, so a tenant
     with thousands of settled invoices does not pay to load them. */
  /* WC-scale: every read below is PAGED (lib/ops/fetch-all.ts) and every `.in()` list is
     sent 200 ids a request. Before, the invoice select stopped at PostgREST's 1000-row cap
     without a word — invoice 1001 was never chased — and the log read sent every invoice id
     in ONE url. Worse, a dunning-log read that came back short or failed (its error was
     never checked) made steps that already went out look unsent, so they went out again.
     A failed prefetch now stops the run with a 500 instead of emailing on partial history. */
  type InvoiceRow = Pick<Invoice, "id" | "tenant_id" | "customer_id" | "customer_name" | "amount" | "paid_amount" | "status" | "due_date" | "quote_id">;
  let invoices: InvoiceRow[];
  let tenants: Pick<Tenant, "id" | "name" | "email" | "auto_suspend_on_overdue" | "upi_vpa" | "upi_payee_name">[];
  let logs: { invoice_id: string | null; dunning_step: string }[];
  let subs: { id: string; quote_id: string | null }[];
  try {
    invoices = await fetchAllRows<InvoiceRow>((from, to) => supabase
      .from("invoices")
      .select("id, tenant_id, customer_id, customer_name, amount, paid_amount, status, due_date, quote_id")
      .in("status", ["pending", "overdue"])
      .not("due_date", "is", null)
      .order("id", { ascending: true })
      .range(from, to));

    /* Tenant settings, the per-invoice dunning history and the subscription behind each
       invoice, fetched once. A query per invoice would turn a 200-invoice pass into 600
       round trips. */
    [tenants, logs, subs] = await Promise.all([
      fetchAllRowsIn(invoices.map((i) => i.tenant_id), (ids, from, to) => supabase
        /* R-018: the UPI details come along so the reminder can carry a way to pay. They
           were already on the tenant for the invoice QR — the dunning cron simply never
           read them, and sent "pay using the link below" with no link, every run. */
        .from("tenants").select("id, name, email, auto_suspend_on_overdue, upi_vpa, upi_payee_name")
        .in("id", ids).order("id", { ascending: true }).range(from, to)),
      fetchAllRowsIn(invoices.map((i) => i.id), (ids, from, to) => supabase
        .from("invoice_dunning_log")
        .select("invoice_id, dunning_step")
        .in("invoice_id", ids).order("id", { ascending: true }).range(from, to)),
      /* Was one `maybeSingle()` per invoice inside the loop below (the N+1). */
      fetchAllRowsIn(invoices.map((i) => i.quote_id), (ids, from, to) => supabase
        .from("subscriptions").select("id, quote_id")
        .in("quote_id", ids).order("id", { ascending: true }).range(from, to)),
    ]);
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const subscriptionByQuote = subscriptionIdByQuote(subs);

  /* R-346 (Pardeep, 7 Oct 2026): an invoice raised by "Activate now, pay later" is followed up
     by the owner's tasks — never by this cron. No message to the customer, and never an
     automatic suspension. Before the migration the column does not exist: nothing is on
     credit then, so the run goes on unchanged. Any OTHER read failure stops the run, like the
     prefetches above — emailing a credit customer by mistake is the worse error. */
  let creditQuoteIds = new Set<string>();
  try {
    const rows = await fetchAllRowsIn(invoices.map((i) => i.quote_id), (ids, from, to) => supabase
      .from("quotes").select("id")
      .in("id", ids).not("credit_activated_at", "is", null)
      .order("id", { ascending: true }).range(from, to));
    creditQuoteIds = new Set((rows as { id: string }[]).map((r) => r.id));
  } catch (e) {
    if (!isMissingDbObject(e)) return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }

  /* dunningRank() is IMPORTED, not redeclared. This block used to keep its own copy of
     the ordering, and the copy is exactly how adding `pre_due` would have broken it:
     an unknown key returns undefined, `undefined > 0` is false, so a nudge already in
     the log looks unsent and goes out again every morning until the invoice falls due.
     One definition, in the module that owns the ladder. */
  const lastStepByInvoice = new Map<string, DunningStep>();
  for (const l of logs) {
    /* `invoice_id` became nullable on 10 Sep 2026 (migration 20260910070000) so the
       same log can record a POSTPAID SUBSCRIPTION chase, which has no invoice. Those
       rows are skipped here rather than coerced: keying a subscription chase into the
       by-invoice map would make one subject's history mask another's, and the whole
       purpose of this map is not re-sending a step that already went out. This loop
       still reads only invoice rows; the subscription source is a separate pass. */
    if (!l.invoice_id) continue;
    const prev = lastStepByInvoice.get(l.invoice_id) ?? "none";
    if (dunningRank(l.dunning_step) > dunningRank(prev)) {
      lastStepByInvoice.set(l.invoice_id, l.dunning_step as DunningStep);
    }
  }

  /* S28: ek sender poore run ke liye — tenant ka switch/template ek hi baar padha jaata hai. */
  const wa = createReminderSender();

  for (const inv of invoices) {
    result.considered++;
    if (inv.quote_id && creditQuoteIds.has(inv.quote_id)) { result.skipped++; continue; }  // R-346
    const tenant = tenantById.get(inv.tenant_id);

    /* A subscription is found through the invoice's source quote. No quote means no
       subscription, which decideDunning treats as "nothing to suspend". */
    const subscriptionId: string | null = inv.quote_id ? subscriptionByQuote.get(inv.quote_id) ?? null : null;

    const amountDue = Math.max(0, (inv.amount ?? 0) - (inv.paid_amount ?? 0));
    const decision = decideDunning({
      dueDate: inv.due_date,
      status: inv.status,
      amountDue,
      lastStepSent: lastStepByInvoice.get(inv.id) ?? null,
      subscriptionId,
      autoSuspend: tenant?.auto_suspend_on_overdue ?? false,
    }, asOf);

    if (!decision.shouldSend || decision.action === "none") { result.skipped++; continue; }

    result.details.push({
      invoice_id: inv.id, step: decision.step, action: decision.action,
      days_overdue: decision.daysOverdue, reason: decision.reason,
    });

    if (dryRun) continue;

    try {
      // ── Customer email. Every step tells the customer something. ──────────
      /* The PRIMARY CONTACT, not customers.contact_email. That column stopped being
         the truth on 10 Sep 2026 — a customer's people live in `contacts` now, one of
         them marked primary, and that is who gets chased for money. The resolver
         keeps the old column as a floor so a customer created without contacts is
         still reachable rather than silently emailed to nobody. */
      const resolved = inv.customer_id
        ? await primaryContactEmail(supabase, inv.customer_id)
        : { email: null, name: null, fromLegacy: false };
      const to = resolved.email;
      if (resolved.fromLegacy) {
        /* Visible, not swallowed: the floor is a safety net, not the design. A run
           full of these means customers are arriving without contacts. */
        console.warn(
          `[invoice-dunning] ${inv.id}: no contact row for customer ${inv.customer_id} — used the legacy customers.contact_email`,
        );
      }

      const msg = dunningMessage({
        step: decision.step,
        invoiceId: inv.id,
        customerName: inv.customer_name,
        amountDue: rupee(amountDue),
        dueDate: formatDate(inv.due_date!),
        sellerName: tenant?.name ?? "your reseller",
        /* R-018 (Pardeep, 27 Sep 2026). This was a hardcoded `null` on every run while
           three of the message branches promised "the link below". A tenant with a UPI
           VPA on file now gets a real `upi://pay` link with the amount filled in; one
           without gets no link AND no sentence claiming there is one — `dunningMessage`
           takes both from the same place now, so they cannot disagree.

           Not a Razorpay link, deliberately: this cron runs daily against the same
           invoice, so minting one per run would leave an invoice holding a fistful of
           live links and `createAndSendPaymentLink` would also send its own email on
           top of this one. Doing that properly needs somewhere to store the link per
           invoice, which is a schema change and is on the board, not smuggled in here. */
        payLink: upiPayLink({
          upiVpa:     tenant?.upi_vpa ?? null,
          payeeName:  tenant?.upi_payee_name ?? tenant?.name ?? null,
          amountDue,
          invoiceId:  inv.id,
        }),
        /* The REAL days remaining, from the decision — not the nominal 3. A pre-due
           nudge that fired late on day -1 must say "tomorrow"; "in 3 days" would be a
           false statement about money. Negative daysOverdue is the pre-due case. */
        daysUntilDue: decision.daysOverdue < 0 ? -decision.daysOverdue : null,
      });

      if (to && msg) {
        /* `automated` subjects this to the workspace's kill switch and dial (23 Aug 2026).
           Until then there was no way to stop this cron chasing customers except disabling
           a Cloud Scheduler job in a Google console.

           `emails_sent` is incremented only on a real send now — a refusal returns status
           "failed" with the reason, and counting it as sent would make the switch look
           broken in the very summary somebody checks after flipping it.

           The ESCALATION mail below is deliberately NOT gated: it goes to the reseller, not
           to a customer, and a switch that silenced the app's own alarms would turn one bad
           afternoon into a missed suspension. */
        const r = await sendEmail({
          /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
          route: { tenantId: inv.tenant_id },
          to, subject: msg.subject, text: msg.text,
          kind: "invoice_dunning",
          automated: { tenantId: inv.tenant_id, action: "dunning.send" },
        });
        if (r.status !== "failed") result.emails_sent++;
      }

      // ── Reseller-side action ─────────────────────────────────────────────
      if (decision.action === "suspend" && subscriptionId) {
        const { error: suspErr } = await supabase
          .from("subscriptions")
          .update({ status: "paused", suspended_at: asOf.toISOString() })
          .eq("id", subscriptionId);
        if (suspErr) throw suspErr;
        result.suspends++;
      } else if (decision.action === "escalate") {
        /* The reseller decides. The email carries everything needed to decide
           without opening anything — §24: a notification that only says
           "something needs attention" costs a login to find out what. */
        if (tenant?.email) {
          await sendEmail({
            /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                  me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
            route: { tenantId: inv.tenant_id },
            to: tenant.email,
            subject: `${inv.customer_name} — invoice ${inv.id} is ${decision.daysOverdue} days overdue`,
            text:
`Invoice ${inv.id} for ${inv.customer_name} is ${decision.daysOverdue} days past due.

  Amount outstanding  ${rupee(amountDue)}
  Due date            ${formatDate(inv.due_date!)}
  Subscription        ${subscriptionId ?? "none — this invoice does not bill a subscription"}

${decision.reason}

The customer has had the full reminder sequence. Nothing further will be sent
automatically. Decide whether to call them, agree a plan, or pause the service.`,
          });
        }
        result.escalations++;
      }

      const logStatus = dunningLogStatus({
        recipient: to, hasMessage: Boolean(msg), emailConfigured: isEmailConfigured(),
      });
      if (reachedNobody(logStatus)) result.no_recipient++;

      await supabase.from("invoice_dunning_log").insert({
        tenant_id: inv.tenant_id,
        invoice_id: inv.id,
        dunning_step: decision.step,
        days_overdue: decision.daysOverdue,
        action_taken: decision.action,
        recipient_email: to,
        subject: msg?.subject ?? null,
        /* Truthful, not optimistic. See lib/invoices/dunning-log-status.ts: this used to be
           isEmailConfigured(), which answers whether Resend is set up rather than whether
           THIS message reached anybody — so a step with no customer address was logged as
           "sent". */
        status: logStatus,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ invoice_id: inv.id, message });
      /* Logged as failed so the next run RETRIES this step rather than treating it as
         delivered. A failure recorded as a success is a customer who is never chased. */
      await supabase.from("invoice_dunning_log").insert({
        tenant_id: inv.tenant_id, invoice_id: inv.id, dunning_step: decision.step,
        days_overdue: decision.daysOverdue, action_taken: decision.action,
        status: "failed", error_message: message.slice(0, 500),
      });
    }

    /* ── S28: WhatsApp copy, try/catch ke BAHAR ───────────────────────────────
       Email step upar log ho chuka. WhatsApp ka koi bhi failure email ko dobara bhejne ya
       dunning step ko "failed" likhne ka kaaran nahi banna chahiye — sender kabhi throw
       nahi karta. Default OFF: switch ON + approved template ke bina ye kuch nahi bhejta. */
    const waOut = await wa.send({
      tenantId: inv.tenant_id,
      kind: dunningReminderKind(decision.step),
      subjectType: "invoice",
      subjectId: inv.id,
      step: decision.step,
      customerId: inv.customer_id,
      values: {
        customer_name: inv.customer_name,
        seller_name: tenant?.name ?? null,
        invoice_id: inv.id,
        amount: rupee(amountDue),
        due_date: formatDate(inv.due_date!),
        days: Math.abs(decision.daysOverdue),
        link: null,
      },
    });
    if (waOut.status === "failed") {
      result.errors.push({ invoice_id: inv.id, message: `whatsapp: ${waOut.error}` });
    }
  }
  result.whatsapp = { ...wa.totals };

  return NextResponse.json(reportCron("invoice-dunning", result));
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }
