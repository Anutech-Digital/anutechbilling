/**
 * R-2044 — the billing cron's second half: send each new part payment request with its Pay link,
 * chase the unpaid ones inside the company's grace (Day 1, Day 3, final on the grace's last day —
 * tenants.grace_period_days, default 7), and after the grace pause the subscription — only for a
 * company that switched that pause on (tenants.auto_suspend_on_overdue), the same opt-in as unpaid
 * invoices. The request stays open until it is paid or "Customer stopped".
 * Pure rules: ./part-requests.ts. Paying the request turns the pause back off (database trigger
 * tg_payments_part_request_invoice).
 *
 * Never touches an invoice: an unpaid request has none. `dryRun` decides and reports, sends and
 * writes nothing. Every send goes through sendCustomerEmail with `automated: dunning.send`, so the
 * workspace kill switch and dial stop it like every other payment chase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { sendCustomerEmail } from "@/lib/messaging";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { rupee, formatDate } from "@/lib/utils";
import { cronTenantAllowed } from "@/lib/automation/cron-gate";
import {
  requestReminderStep, requestReminderText, requestPauseDue, requestPauseReason,
  type RequestReminderStep,
} from "./part-requests";

type Admin = ReturnType<typeof createAdminClient>;

/** The step written when the request itself was mailed (ranks 0 in the dunning ladder). */
export const REQUEST_SENT_STEP = "request_sent";

export interface PartRequestChaseResult {
  open_requests: number;
  sent: { quote_id: string; step: string; status: string }[];
  paused: { subscription_id: string; quote_id: string }[];
  /** Dry run: what would be sent / paused. */
  would: { quote_id: string; step: string }[];
  errors: { quote_id: string; message: string }[];
}

interface ReqRow {
  id: string; tenant_id: string; customer_id: string | null; customer_name: string;
  amount: number | null; payment_amount: number | null; public_token: string | null;
  line_items: { name?: string }[] | null;
  subscription_billing_id: string;
}
interface BillRow {
  id: string; subscription_id: string; bill_on: string; period_start: string; period_end: string;
  period_index: number; request_reminder_step: string | null;
}
interface TenantRow { id: string; name: string; email: string | null; auto_suspend_on_overdue: boolean | null; grace_period_days: number | null }

export async function chasePartRequests(
  supabase: Admin,
  opts: { todayISO: string; dryRun: boolean },
): Promise<PartRequestChaseResult> {
  const out: PartRequestChaseResult = { open_requests: 0, sent: [], paused: [], would: [], errors: [] };
  /* Untyped: the R-2044 columns are newer than the generated types. */
  const db = supabase as unknown as SupabaseClient;

  /* Open = sent/viewed/accepted, no invoice yet, not fully paid. A stopped request is 'rejected'. */
  const reqs = (await fetchAllRows((from, to) => db
    .from("quotes")
    .select("id, tenant_id, customer_id, customer_name, amount, payment_amount, public_token, line_items, subscription_billing_id")
    .not("subscription_billing_id", "is", null)
    .is("invoice_id", null)
    .in("status", ["sent", "viewed", "accepted"])
    .order("id", { ascending: true })
    .range(from, to))) as unknown as ReqRow[];
  const open = reqs.filter((q) => cronTenantAllowed(q.tenant_id) && (q.amount ?? 0) - (q.payment_amount ?? 0) > 0);
  out.open_requests = open.length;
  if (open.length === 0) return out;

  const [bills, tenants] = await Promise.all([
    fetchAllRowsIn(open.map((q) => q.subscription_billing_id), (ids, from, to) => db
      .from("subscription_billings")
      .select("id, subscription_id, bill_on, period_start, period_end, period_index, request_reminder_step")
      .in("id", ids).order("id", { ascending: true }).range(from, to)) as unknown as Promise<BillRow[]>,
    fetchAllRowsIn(open.map((q) => q.tenant_id), (ids, from, to) => db
      .from("tenants")
      .select("id, name, email, auto_suspend_on_overdue, grace_period_days")
      .in("id", ids).order("id", { ascending: true }).range(from, to)) as unknown as Promise<TenantRow[]>,
  ]);
  const billById = new Map(bills.map((b) => [b.id, b]));
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  for (const q of open) {
    const b = billById.get(q.subscription_billing_id);
    const t = tenantById.get(q.tenant_id);
    if (!b || !t) continue;
    const amountDue = (q.amount ?? 0) - (q.payment_amount ?? 0);
    /* The request's own wording, "Advance payment for Q2 · 28 Jan–27 Apr 2027" (its first line). */
    const partLabel = q.line_items?.[0]?.name ?? `Advance payment for part ${b.period_index}`;
    try {
      const step: RequestReminderStep | "new" | null = !b.request_reminder_step
        ? "new"
        : requestReminderStep({ dueOn: b.bill_on, todayISO: opts.todayISO, lastStep: b.request_reminder_step, open: true, amountDue, graceDays: t.grace_period_days ?? 0 });
      if (step) {
        const stepName = step === "new" ? REQUEST_SENT_STEP : step;
        if (opts.dryRun) {
          out.would.push({ quote_id: q.id, step: stepName });
        } else {
          const contact = q.customer_id ? await primaryContactEmail(supabase, q.customer_id) : { email: null };
          if (!contact.email) {
            out.errors.push({ quote_id: q.id, message: `${q.customer_name} has no email on its primary contact — the payment request was not sent.` });
          } else {
            const tpl = requestReminderText({
              step, customerName: q.customer_name, companyName: t.name, quoteId: q.id,
              part: partLabel,
              amount: rupee(amountDue), dueOn: formatDate(b.bill_on),
              payUrl: q.public_token ? quoteAcceptUrl(appUrl, q.id, q.public_token) : null,
            });
            const r = await sendCustomerEmail({
              to: contact.email, subject: tpl.subject, text: tpl.body,
              from: t.email ?? undefined,
              route: { tenantId: q.tenant_id },
              kind: "part_payment_request",
              automated: { tenantId: q.tenant_id, action: "dunning.send" },
            });
            out.sent.push({ quote_id: q.id, step: stepName, status: r.status });
            if (r.status === "sent" || r.status === "stubbed") {
              const { error } = await db.from("subscription_billings")
                .update({ request_reminder_step: stepName, request_reminded_at: new Date().toISOString() })
                .eq("id", b.id);
              if (error) throw new Error(error.message);
              b.request_reminder_step = stepName;
            } else {
              out.errors.push({ quote_id: q.id, message: r.errorMessage ?? "send failed" });
            }
          }
        }
      }

      /* Pause after grace — the company's own opt-in, after the final reminder went out. */
      if (requestPauseDue({
        companyOn: t.auto_suspend_on_overdue === true,
        graceDays: t.grace_period_days ?? 0,
        dueOn: b.bill_on, todayISO: opts.todayISO,
        lastStep: b.request_reminder_step, open: true,
      })) {
        if (opts.dryRun) {
          out.would.push({ quote_id: q.id, step: "pause" });
        } else {
          const { data, error } = await db.from("subscriptions")
            .update({
              status: "paused", suspended_by: "automation", suspended_at: new Date().toISOString(),
              suspend_reason: requestPauseReason(q.id, b.bill_on, opts.todayISO),
            })
            .eq("id", b.subscription_id).eq("status", "active")
            .select("id");
          if (error) throw new Error(error.message);
          if ((data as unknown[] | null)?.length) out.paused.push({ subscription_id: b.subscription_id, quote_id: q.id });
        }
      }
    } catch (e) {
      out.errors.push({ quote_id: q.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
