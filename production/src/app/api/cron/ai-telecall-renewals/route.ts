/**
 * AI renewal calls — ring the customers whose subscription renews in five days.
 *
 * Schedule: once daily, via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh). NOT
 * vercel.json — the live deployment is Cloud Run, where Vercel crons do not exist and that
 * file is inert.
 * Local dev: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/ai-telecall-renewals`.
 *
 * ─── EXACTLY FIVE DAYS OUT, NOT "WITHIN FIVE DAYS" ──────────────────────────
 * The brief says "expiring in 5 days" and both readings are defensible, so the reason for
 * choosing one is written down. A `<= 5 days` window makes every customer eligible on five
 * consecutive days. `decideTelecall`'s 24-hour gap would then let four of those five calls
 * through, and the customer's phone rings on Monday, Tuesday, Wednesday and Thursday about the
 * same renewal. Four automated calls in four days is how a business gets its number blocked,
 * and the fourth is not more persuasive than the first.
 *
 * An exact date means each subscription is a candidate exactly once. A run that is missed —
 * scheduler outage, deploy window — skips that day's cohort rather than calling them late; the
 * renewal EMAIL cadence (api/cron/renewals) still covers them, and a phone call about a
 * renewal that already lapsed is worse than no phone call.
 *
 * ─── WHAT THIS CRON DOES NOT DECIDE ─────────────────────────────────────────
 * Whether to dial. `dispatchTelecall` owns the autonomy dial, the calling-hours rule, the
 * 24-hour gap and the attempt ceiling. Today `telecall.place` defaults to `hold`, so a healthy
 * run of this cron writes `held` rows and rings nobody — and the operator's queue is the
 * result. That is the intended steady state until Pardeep moves the dial at /automation.
 */
import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { istParts } from "@/lib/mastery/quiet-hours";
/* addDaysISO: calendar arithmetic on a DATE column, UTC parts — ek hi copy lib/dates/ist me (S21). */
import { addDaysISO } from "@/lib/dates/ist";
import { loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchTelecall } from "@/lib/ai/actions/telecall-dispatcher";
import { loadSubscriptionSubject } from "@/lib/telecall/subject.server";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How far ahead of the renewal this call goes out. */
const DAYS_AHEAD = 5;

/**
 * Bounded so one run cannot become an unbounded fan-out of calls.
 *
 * Lower than the SLA sweep's 100 on purpose: that cron's unit of work is a database update and
 * this one's is a phone call that costs money per minute and rings a real person. If a day's
 * cohort ever exceeds this, the overflow is REPORTED rather than silently dropped — see
 * `skipped_over_cap` below.
 */
const MAX_PER_RUN = 40;

interface CallOutcome {
  subscription_id: string;
  customer: string;
  result: string;
}

interface CronResult {
  ran_at: string;
  /** IST calendar date this run belongs to. */
  ran_on: string;
  /** The renewal date this run targeted. */
  targeting: string;
  examined: number;
  queued: number;
  held: number;
  refused: number;
  failed: number;
  /** Subscriptions in today's cohort that this run did not reach because of MAX_PER_RUN. */
  skipped_over_cap: number;
  outcomes: CallOutcome[];
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("ai-telecall-renewals", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

async function handle(req: Request): Promise<NextResponse<CronResult | { error: string }>> {
  /* ── Auth — FAIL CLOSED ──────────────────────────────────────────────────
     503, not 401, when the secret is absent: "this deployment has no cron secret" is a
     missing-infrastructure fact for whoever is deploying, and reporting it as "unauthorized"
     sends them looking for a wrong credential instead of an unset one. Matches the nine
     existing crons. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  /* IST, via `istParts`, not `new Date().toISOString().slice(0,10)`. Cloud Run runs in UTC, so
     the plain form returns YESTERDAY's date for every run before 05:30 IST — and this cron is
     scheduled in the morning. `renewal_date` is a DATE column filled in by people working in
     IST, so the comparison has to be made in their calendar. */
  const todayIST = istParts(now).ymd;
  const target = addDaysISO(todayIST, DAYS_AHEAD);

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("subscriptions")
    .select("id, tenant_id, customer_name")
    .eq("status", "active")
    .eq("renewal_date", target)
    /* Cap + 1, so the response can say honestly whether anything was left behind. A silent
       truncation reads as "covered everything" when it did not. */
    .limit(MAX_PER_RUN + 1);

  if (error) {
    console.error("[ai-telecall-renewals] could not read subscriptions:", error.message);
    return NextResponse.json({ error: "could not read subscriptions" }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ id: string; tenant_id: string; customer_name: string | null }>;
  const overCap = Math.max(0, rows.length - MAX_PER_RUN);
  const batch = rows.slice(0, MAX_PER_RUN);

  const result: CronResult = {
    ran_at: now.toISOString(),
    ran_on: todayIST,
    targeting: target,
    examined: batch.length,
    queued: 0,
    held: 0,
    refused: 0,
    failed: 0,
    skipped_over_cap: overCap,
    outcomes: [],
  };

  if (overCap > 0) {
    console.warn(
      `[ai-telecall-renewals] ${overCap} subscription(s) renewing on ${target} were not reached ` +
      `this run — the per-run cap is ${MAX_PER_RUN}. They will not be picked up tomorrow, ` +
      "because the cohort is keyed on an exact date. Raise the cap or call them by hand.",
    );
  }

  /* Catalogues are per tenant and a run usually touches one or two. Cached for the run rather
     than read per subscription: forty identical `items` reads is the N+1 this cron would
     otherwise be, and the catalogue cannot change mid-run in a way anybody wants to see. */
  const catalogues = new Map<string, Awaited<ReturnType<typeof loadSalesCatalog>>>();
  const tenants = new Map<string, { name: string | null; phone: string | null }>();

  /* Sequential, not Promise.all. Each iteration places a phone call; forty at once would be
     forty simultaneous rings out of one caller ID, which is what a vendor's abuse detection is
     built to stop. Slower is the correct shape here. */
  for (const sub of batch) {
    /* R-897 */ if (!cronTenantAllowed(sub.tenant_id)) continue;
    let catalogue = catalogues.get(sub.tenant_id);
    if (!catalogue) {
      catalogue = await loadSalesCatalog(admin, sub.tenant_id);
      catalogues.set(sub.tenant_id, catalogue);
    }

    let tenant = tenants.get(sub.tenant_id);
    if (!tenant) {
      const { data: t } = await admin
        .from("tenants").select("name, phone").eq("id", sub.tenant_id).maybeSingle();
      tenant = { name: t?.name ?? null, phone: t?.phone ?? null };
      tenants.set(sub.tenant_id, tenant);
    }

    const subject = await loadSubscriptionSubject(admin, sub.tenant_id, sub.id);
    if (!subject) {
      result.failed += 1;
      result.outcomes.push({
        subscription_id: sub.id,
        customer: sub.customer_name ?? "",
        result: "the subscription could not be read back",
      });
      continue;
    }

    const dispatched = await dispatchTelecall({
      admin,
      tenantId: sub.tenant_id,
      callType: "renewal_reminder",
      leadId: null,
      subscriptionId: sub.id,
      rawPhone: subject.rawPhone,
      customerName: subject.customerName,
      currentPlan: subject.currentPlan,
      seats: subject.seats,
      renewalDate: subject.renewalDate,
      pendingAmount: subject.pendingAmount,
      catalogue,
      sellerName: tenant.name?.trim() || process.env.SELLER_LEGAL_NAME?.trim() || "our team",
      ourNumbers: [tenant.phone, process.env.RETELL_FROM_NUMBER, process.env.VAPI_FROM_NUMBER]
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      doNotCall: false,
      subjectIsOpen: subject.isOpen,
      subjectClosedReason: subject.closedReason,
      now,
    });

    if (dispatched.outcome === "queued") result.queued += 1;
    else if (dispatched.outcome === "held") result.held += 1;
    else if (dispatched.outcome === "refused") result.refused += 1;
    else result.failed += 1;

    /* Every subscription reports a line, including the refusals. A cron that lists only what it
       DID makes "nothing happened" and "nothing was eligible" look identical, which is the
       failure the SLA sweep's `skipped` counter was added for. */
    result.outcomes.push({
      subscription_id: sub.id,
      customer: subject.company ?? sub.customer_name ?? "",
      result: dispatched.detail,
    });
  }

  return NextResponse.json(reportCron("ai-telecall-renewals", result));
}
