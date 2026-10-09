/**
 * R-116 — the read/write half of the overdue pause. Called from /api/cron/invoice-dunning
 * after the reminder ladder, with the same service-role client and the same `?dry=1` rules.
 * Pure decisions live in ./overdue-suspension.ts.
 *
 * Writes, per subscription that reached its step today:
 *   notice  → email to the customer's primary contact (through the same autonomy switch as
 *             dunning: `dunning.send`) + an invoice_dunning_log row, step 'suspend_notice'.
 *             A refused or failed send is logged 'failed' and does NOT count as notice, so
 *             the pause never happens without the notice actually having gone out.
 *   suspend → subscriptions.status 'paused' + suspended_at / suspend_reason /
 *             suspended_by 'automation' / suspended_invoice_id, a row in ai_action_log, and an
 *             email to the company (not gated — it is the app telling its own user).
 * Turning the service back on is a database trigger (trg_invoices_overdue_resume).
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { istToday, toIstDate } from "@/lib/dates/ist";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { payInstruction, upiPayLink } from "@/lib/invoices/pay-link";
import { dunningLogStatus } from "@/lib/invoices/dunning-log-status";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { rupee, formatDate } from "@/lib/utils";
import {
  SUSPEND_NOTICE_STEP,
  decideOverdueSuspension,
  oldestOverdueInvoice,
  suspendThreshold,
  suspensionNoticeMessage,
  type OverdueInvoice,
  type SuspensionAction,
} from "./overdue-suspension";

type Admin = ReturnType<typeof createAdminClient>;

export interface OverdueSuspensionResult {
  companies_on: number;
  subscriptions_checked: number;
  notices: number;
  suspends: number;
  details: { subscription_id: string; invoice_id: string; action: SuspensionAction; days_overdue: number; pause_on: string | null; reason: string }[];
  errors: { subscription_id: string; message: string }[];
}

interface TenantRow {
  id: string; name: string; email: string | null; overdue_suspend_days: number;
  upi_vpa: string | null; upi_payee_name: string | null;
}
interface SubRow {
  id: string; tenant_id: string; customer_id: string | null; customer_name: string;
  plan: string; domain: string | null; quote_id: string | null; status: string;
}
interface InvRow extends OverdueInvoice {
  tenant_id: string; customer_name: string; quote_id: string | null; amount: number;
}

export async function runOverdueSuspension(
  supabase: Admin,
  opts: { asOf: Date; dryRun: boolean; creditQuoteIds: ReadonlySet<string> },
): Promise<OverdueSuspensionResult> {
  const result: OverdueSuspensionResult = {
    companies_on: 0, subscriptions_checked: 0, notices: 0, suspends: 0, details: [], errors: [],
  };
  const today = istToday(opts.asOf);

  const tenants = await fetchAllRows<TenantRow>((from, to) => supabase
    .from("tenants")
    .select("id, name, email, overdue_suspend_days, upi_vpa, upi_payee_name")
    .eq("auto_suspend_on_overdue", true)
    .order("id", { ascending: true }).range(from, to));
  result.companies_on = tenants.length;
  if (tenants.length === 0) return result;
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const tenantIds = tenants.map((t) => t.id);

  const [subs, invoices] = await Promise.all([
    fetchAllRowsIn(tenantIds, (ids, from, to) => supabase
      .from("subscriptions")
      .select("id, tenant_id, customer_id, customer_name, plan, domain, quote_id, status")
      .in("tenant_id", ids).eq("status", "active")
      .order("id", { ascending: true }).range(from, to)) as Promise<SubRow[]>,
    fetchAllRowsIn(tenantIds, (ids, from, to) => supabase
      .from("invoices")
      .select("id, tenant_id, customer_name, amount, net_payable, paid_amount, status, due_date, quote_id")
      .in("tenant_id", ids).in("status", ["pending", "overdue"]).not("due_date", "is", null)
      .order("id", { ascending: true }).range(from, to)) as Promise<InvRow[]>,
  ]);
  /* R-346: "activate now, pay later" invoices are the owner's to follow up — never paused. */
  const chaseable = invoices.filter((i) => !(i.quote_id && opts.creditQuoteIds.has(i.quote_id)));
  const invById = new Map(chaseable.map((i) => [i.id, i]));

  const [billings, notices] = await Promise.all([
    fetchAllRowsIn(subs.map((s) => s.id), (ids, from, to) => supabase
      .from("subscription_billings")
      .select("subscription_id, invoice_id")
      .in("subscription_id", ids).not("invoice_id", "is", null)
      .order("id", { ascending: true }).range(from, to)) as Promise<{ subscription_id: string; invoice_id: string | null }[]>,
    fetchAllRowsIn(chaseable.map((i) => i.id), (ids, from, to) => supabase
      .from("invoice_dunning_log")
      .select("invoice_id, sent_at, status")
      .in("invoice_id", ids).eq("dunning_step", SUSPEND_NOTICE_STEP).neq("status", "failed")
      .order("id", { ascending: true }).range(from, to)) as Promise<{ invoice_id: string | null; sent_at: string; status: string }[]>,
  ]);

  /* Earliest delivered notice per invoice, as an IST date. */
  const noticeOn = new Map<string, string>();
  for (const n of notices) {
    if (!n.invoice_id) continue;
    const d = toIstDate(n.sent_at);
    const prev = noticeOn.get(n.invoice_id);
    if (!prev || d < prev) noticeOn.set(n.invoice_id, d);
  }

  /* Invoices that bill each subscription: its source quote (only when that quote has ONE
     active subscription — suspending the wrong one of two is worse than none) + its billings. */
  const subsPerQuote = new Map<string, number>();
  for (const s of subs) if (s.quote_id) subsPerQuote.set(s.quote_id, (subsPerQuote.get(s.quote_id) ?? 0) + 1);
  const invByQuote = new Map<string, InvRow[]>();
  for (const i of chaseable) if (i.quote_id) invByQuote.set(i.quote_id, [...(invByQuote.get(i.quote_id) ?? []), i]);
  const billedInv = new Map<string, InvRow[]>();
  for (const b of billings) {
    const inv = b.invoice_id ? invById.get(b.invoice_id) : undefined;
    if (inv) billedInv.set(b.subscription_id, [...(billedInv.get(b.subscription_id) ?? []), inv]);
  }

  const noticedThisRun = new Set<string>();

  for (const sub of subs) {
    const tenant = tenantById.get(sub.tenant_id);
    if (!tenant) continue;
    result.subscriptions_checked++;
    const linked = new Map<string, InvRow>();
    if (sub.quote_id && subsPerQuote.get(sub.quote_id) === 1) {
      for (const i of invByQuote.get(sub.quote_id) ?? []) linked.set(i.id, i);
    }
    for (const i of billedInv.get(sub.id) ?? []) linked.set(i.id, i);

    const oldest = oldestOverdueInvoice([...linked.values()], today);
    const decision = decideOverdueSuspension({
      enabled: true,
      thresholdDays: tenant.overdue_suspend_days,
      subscriptionStatus: sub.status,
      oldest,
      noticeSentOn: oldest ? noticeOn.get(oldest.invoiceId) ?? (noticedThisRun.has(oldest.invoiceId) ? today : null) : null,
    }, today);
    if (decision.action === "none" || !oldest) continue;
    if (decision.action === "notice" && noticedThisRun.has(oldest.invoiceId)) continue;

    result.details.push({
      subscription_id: sub.id, invoice_id: oldest.invoiceId, action: decision.action,
      days_overdue: decision.daysOverdue, pause_on: decision.pauseOn, reason: decision.reason,
    });
    if (opts.dryRun) continue;

    const inv = linked.get(oldest.invoiceId)!;
    const service = `${sub.plan}${sub.domain ? ` for ${sub.domain}` : ""}`;
    try {
      if (decision.action === "notice") {
        noticedThisRun.add(oldest.invoiceId);
        const amountDue = invoiceAmountDue(inv);
        const resolved = sub.customer_id
          ? await primaryContactEmail(supabase, sub.customer_id)
          : { email: null, name: null, fromLegacy: false };
        const msg = suspensionNoticeMessage({
          customerName: inv.customer_name,
          invoiceId: inv.id,
          amountDue: rupee(amountDue),
          dueDate: formatDate(oldest.dueDate),
          pauseOn: formatDate(decision.pauseOn!),
          service,
          sellerName: tenant.name,
          payInstruction: payInstruction(upiPayLink({
            upiVpa: tenant.upi_vpa, payeeName: tenant.upi_payee_name ?? tenant.name, amountDue, invoiceId: inv.id,
          })),
        });
        let status: string = dunningLogStatus({ recipient: resolved.email, hasMessage: true, emailConfigured: isEmailConfigured() });
        let errorMessage: string | null = null;
        if (resolved.email) {
          const r = await sendEmail({
            route: { tenantId: sub.tenant_id },
            to: resolved.email, subject: msg.subject, text: msg.text,
            kind: "invoice_dunning",
            automated: { tenantId: sub.tenant_id, action: "dunning.send" },
          });
          if (r.status === "failed") { status = "failed"; errorMessage = (r.errorMessage ?? "not sent").slice(0, 500); }
        }
        const { error: logErr } = await supabase.from("invoice_dunning_log").insert({
          tenant_id: sub.tenant_id, invoice_id: inv.id, dunning_step: SUSPEND_NOTICE_STEP,
          days_overdue: decision.daysOverdue, action_taken: "email",
          recipient_email: resolved.email, subject: msg.subject, status, error_message: errorMessage,
        });
        if (logErr) throw logErr;
        if (status !== "failed") result.notices++;
        continue;
      }

      // ── suspend ──
      /* Guarded on status 'active': a subscription somebody changed since the read above is
         left alone. Read a moment ago in this same run, so the race window is seconds. */
      const { error: updErr } = await supabase
        .from("subscriptions")
        .update({
          status: "paused",
          suspended_at: opts.asOf.toISOString(),
          suspend_reason: decision.reason,
          suspended_by: "automation",
          suspended_invoice_id: inv.id,
        })
        .eq("id", sub.id).eq("tenant_id", sub.tenant_id).eq("status", "active");
      if (updErr) throw updErr;
      result.suspends++;

      const { error: logErr } = await supabase.from("ai_action_log").insert({
        tenant_id: sub.tenant_id,
        action: "subscription.overdue_suspend",
        outcome: "did",
        mode: "auto",
        reason: decision.reason,
        entity: "subscription",
        entity_id: sub.id,
        facts: {
          invoice_id: inv.id, days_overdue: decision.daysOverdue,
          threshold_days: suspendThreshold(tenant.overdue_suspend_days), actor: "automation",
        },
      });
      if (logErr) console.error("[overdue-suspension] ai_action_log insert failed:", logErr.message);

      if (tenant.email) {
        await sendEmail({
          route: { tenantId: sub.tenant_id },
          to: tenant.email,
          subject: `Paused: ${sub.customer_name} — ${service}`,
          text:
`${service} for ${sub.customer_name} was paused in ResellerOS today because invoice ${inv.id} is ${decision.daysOverdue} days overdue.

  Amount outstanding  ${rupee(invoiceAmountDue(inv))}
  Final notice sent   ${formatDate(noticeOn.get(inv.id) ?? today)}

Only the status in ResellerOS changed. Nothing was changed at Google or Microsoft.
When the invoice is paid it turns back on by itself. To turn it back on now, open the subscription and set it to Active.
To stop automatic pauses, open Accounting > Aging and switch off "Auto-pause on overdue".`,
        });
      }
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      result.errors.push({ subscription_id: sub.id, message });
    }
  }
  return result;
}
