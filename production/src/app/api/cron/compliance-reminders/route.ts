/**
 * Statutory-compliance reminder cron — T-15 / T-7 / T-3.
 *
 * Runs daily at 09:30 IST via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh)
 * — half an hour after the renewals job and inside working hours, so a due-date
 * mail can be acted on the moment it is read rather than sitting overnight.
 *
 * NOT vercel.json. The live deployment is Cloud Run, where Vercel crons do not
 * exist; that file schedules nothing here.
 *
 * For every tenant it computes which statutory obligations are approaching, and
 * emails the OWNER and any user with the `accountant` role — the CA already sits
 * in the team list, so no separate contact field is needed that could drift out
 * of date.
 *
 * Auth: CRON_SECRET, FAIL CLOSED. This job emails on the tenant's behalf under
 * the service role, so it must never run unauthenticated. No secret configured
 * → 503, not "allow".
 *
 * Idempotency is in the database, not here. compliance_reminder_log (0229) has a
 * unique index on (tenant, obligation, period, days_before, lower(email)), so a
 * manual re-run, a retry after a deploy, or two overlapping instances cannot send
 * the same "GSTR-3B due in 7 days" twice. The pre-check below is an optimisation;
 * the constraint is the guarantee.
 *
 * `?dry=1[&on=YYYY-MM-DD]` rehearses without sending or writing — the same shape
 * as the renewals cron, and for the same reason: a scheduler whose first proof of
 * life is the day it emails real people is not a scheduler anyone should trust.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, errorMessage, type PageQuery } from "@/lib/ops/fetch-all";
import { buildComplianceRows } from "@/lib/compliance/obligations";
import { isMissingColumnError, profileFromRow, type PgErrorLike } from "@/lib/compliance/profile-row";
import { dueReminders, renderReminder, type PlannedReminder } from "@/lib/compliance/reminders";
import { noTdsDeductedPredicate, tdsLookbackFrom, tdsMonthsFrom } from "@/lib/compliance/tds-not-applicable";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { toIstDate } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

/** business_type / gst_filing are newer than database.types.ts — absent before the migration. */
interface TenantRow { id: string; name: string; business_type?: unknown; gst_filing?: unknown; lut_number?: unknown }

interface Sent { tenant: string; obligation: string; period: string; daysBefore: number; to: string; status: string }

interface RunResult {
  ran_at: string;
  evaluated_for: string;
  dry_run: boolean;
  email_mode: "real" | "stub";
  tenants: number;
  reminders_due: number;
  sent: number;
  skipped_already_sent: number;
  no_recipients: number;
  errors: { tenant: string; message: string }[];
  details: Sent[];
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url  = new URL(req.url);
  const dry  = url.searchParams.get("dry") === "1";
  const on   = url.searchParams.get("on");
  if (on && !dry) {
    return NextResponse.json(
      { error: "`on` is only allowed with dry=1 — a live run must use today's date" },
      { status: 400 },
    );
  }
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return NextResponse.json({ error: "`on` must be YYYY-MM-DD" }, { status: 400 });
  }
  // Midday IST — far enough from either midnight that the date cannot slip.
  const today = on ? new Date(`${on}T12:00:00+05:30`) : new Date();

  const supabase = createAdminClient();
  const result: RunResult = {
    ran_at: new Date().toISOString(),
    evaluated_for: toIstDate(today),
    dry_run: dry,
    email_mode: isEmailConfigured() ? "real" : "stub",
    tenants: 0, reminders_due: 0, sent: 0, skipped_already_sent: 0, no_recipients: 0,
    errors: [], details: [],
  };

  /* WC-scale: every list read here is paged (lib/ops/fetch-all.ts). The reminder log is the
     one that mattered: it grows by obligations × periods × rungs × recipients, and a tenant
     past 1000 rows had its OLDEST sends cut off the read — which looked like "not sent yet". */
  /* R-325: each tenant's business type + GST mode (R-262) decides WHICH obligations it is
     reminded about — a proprietor gets no AOC-4 / MGT-7 mail, a QRMP filer no monthly
     GSTR-3B. Before the columns exist (migration 20261007030000 not applied) the read falls
     back to id + name and every tenant gets the original Pvt Ltd / monthly-GST list. */
  let tenants: TenantRow[];
  try {
    try {
      tenants = await fetchAllRows<TenantRow>((from, to) => supabase
        .from("tenants").select("id, name, business_type, gst_filing, lut_number")
        .order("id", { ascending: true }).range(from, to) as unknown as PageQuery<TenantRow>);
    } catch (e) {
      if (!isMissingColumnError(e as PgErrorLike)) throw e;
      tenants = await fetchAllRows((from, to) => supabase
        .from("tenants").select("id, name, lut_number").order("id", { ascending: true }).range(from, to));
    }
  } catch (e) {
    return NextResponse.json({ error: `tenants fetch failed: ${errorMessage(e)}` }, { status: 500 });
  }
  result.tenants = tenants.length;

  for (const tenant of tenants) {
    try {
      // Recipients: the owner(s) and the CA. `accountant` is an existing role, so
      // the CA is whoever the operator already invited as one — no shadow contact
      // field that drifts out of date.
      const { data: people } = await supabase
        .from("users")
        .select("email, role, is_active")
        .eq("tenant_id", tenant.id)
        .in("role", ["owner", "accountant"]);
      const recipients = [...new Set(
        (people ?? []).filter((p) => p.is_active !== false && p.email).map((p) => p.email.trim().toLowerCase()),
      )];
      if (recipients.length === 0) { result.no_recipients += 1; continue; }

      // What is already filed, so a filed period is neither chased nor counted.
      const filedRows = await fetchAllRows((from, to) => supabase
        .from("compliance_log")
        .select("obligation_key, period_key, filed_date")
        .eq("tenant_id", tenant.id)
        .order("id", { ascending: true })
        .range(from, to));
      const filed = new Map<string, string>(
        (filedRows ?? []).map((r) => [`${r.obligation_key}|${r.period_key}`, r.filed_date as string]),
      );

      // What has already been reminded, keyed exactly as the unique index is.
      //
      // FAIL CLOSED IF THIS CANNOT BE READ. Migration 0229 creates the table; if
      // it has not been applied, or a permission changes, this query errors and
      // an unguarded `?? []` would read as "nothing has been sent yet" — so the
      // job would email every owner and CA about every approaching deadline,
      // every single day, and never record a thing. Sending nothing is a missed
      // reminder the operator can still catch on the page; sending daily is how
      // they mute the sender for good.
      let sentRows: { obligation_key: string; period_key: string; days_before: number; recipient_email: string }[];
      try {
        sentRows = await fetchAllRows((from, to) => supabase
          .from("compliance_reminder_log")
          .select("obligation_key, period_key, days_before, recipient_email")
          .eq("tenant_id", tenant.id)
          .order("id", { ascending: true })
          .range(from, to));
      } catch (sentErr) {
        result.errors.push({
          tenant: tenant.id,
          message: `reminder log unreadable (${errorMessage(sentErr)}) — skipped without sending, since idempotency cannot be guaranteed. Apply migration 0229.`,
        });
        continue;
      }
      const sentKey = (o: string, p: string, d: number, to: string) => `${o}|${p}|${d}|${to.toLowerCase()}`;
      const alreadySentAll = new Set(
        (sentRows ?? []).map((r) => sentKey(r.obligation_key, r.period_key, r.days_before, r.recipient_email)),
      );

      // R-181: a finished month with no TDS deducted has no TDS to deposit, so
      // its "Deposit TDS" reminder is not sent. If the TDS read fails, every
      // month counts as before — a stray reminder beats a missed deadline.
      const lookback = tdsLookbackFrom(today);
      const [tdsSal, tdsExp] = await Promise.all([
        supabase.from("salary_payments").select("period, tds")
          .eq("tenant_id", tenant.id).gte("period", lookback.slice(0, 7)).gt("tds", 0),
        supabase.from("expenses").select("expense_date, tds_amount")
          .eq("tenant_id", tenant.id).gte("expense_date", lookback).gt("tds_amount", 0),
      ]);
      const notApplicable = tdsSal.error || tdsExp.error
        ? undefined
        : noTdsDeductedPredicate(tdsMonthsFrom(tdsSal.data, tdsExp.data), today);

      const rows = buildComplianceRows(today, filed, undefined, notApplicable, profileFromRow(tenant, null));
      // A rung counts as done for the tenant only once EVERY recipient has it —
      // otherwise adding a CA halfway through a window would never reach them.
      const plans: PlannedReminder[] = dueReminders(rows, (o, p, d) =>
        recipients.every((to) => alreadySentAll.has(sentKey(o, p, d, to))));
      result.reminders_due += plans.length;

      for (const plan of plans) {
        const msg = renderReminder(plan, APP_URL);
        for (const to of recipients) {
          if (alreadySentAll.has(sentKey(plan.obligationKey, plan.periodKey, plan.daysBefore, to))) {
            result.skipped_already_sent += 1;
            continue;
          }
          if (dry) {
            result.details.push({ tenant: tenant.name ?? tenant.id, obligation: plan.obligationKey, period: plan.periodKey, daysBefore: plan.daysBefore, to, status: "(dry run)" });
            continue;
          }

          let status: "sent" | "stubbed" | "failed" = "sent";
          let providerId: string | null = null;
          let errorMessage: string | null = null;
          try {
            /* `route` ke bina default Resend — test mode. Tenant ka apna transport chahiye. */
            const r = await sendEmail({
              to, subject: msg.subject, text: msg.body,
              route: { tenantId: tenant.id },
            });
            providerId = (r as { id?: string } | undefined)?.id ?? null;
            if (!isEmailConfigured()) status = "stubbed";
          } catch (err) {
            status = "failed";
            errorMessage = (err as Error).message;
          }

          // Logged whatever happened. A failed send that leaves no trace is a
          // reminder nobody knows was lost.
          await supabase.from("compliance_reminder_log").insert({
            tenant_id: tenant.id, obligation_key: plan.obligationKey, period_key: plan.periodKey,
            days_before: plan.daysBefore, recipient_email: to,
            status, provider_id: providerId, error_message: errorMessage,
          });
          if (status === "sent" || status === "stubbed") result.sent += 1;
          result.details.push({ tenant: tenant.name ?? tenant.id, obligation: plan.obligationKey, period: plan.periodKey, daysBefore: plan.daysBefore, to, status });
        }
      }
    } catch (err) {
      // One tenant's failure must not stop every other tenant's reminders.
      result.errors.push({ tenant: tenant.id, message: (err as Error).message });
    }
  }

  return NextResponse.json(reportCron("compliance-reminders", result));
}
