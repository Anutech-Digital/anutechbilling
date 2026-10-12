/**
 * Monthly MRR snapshot — the history NRR is computed from.
 *
 * Runs on the 1st. For every tenant it records each customer's MRR for the month, so
 * that next month there is something to compare against.
 *
 * ─── IT IS AN UPSERT, NOT AN INSERT ─────────────────────────────────────────
 * One row per customer per month, enforced by a unique constraint. Re-running the job
 * — a retry, a missed day caught up by hand — must not create a second version of a
 * month, because a comparison would then depend on which one a query happened to
 * pick. Later runs overwrite; the month is described by whatever the last run saw.
 *
 * ─── IT SNAPSHOTS THE MONTH IT RUNS IN, AND CAN BE BACK-DATED ONLY DRY ──────
 * `?on=YYYY-MM-DD` moves the period for a dry run so the shape can be checked. A live
 * back-dated run is refused: writing August's figures into July's row would silently
 * rewrite history, and retention is the one number where that is indistinguishable
 * from a real change.
 *
 * AUTH FAILS CLOSED, like every other cron here.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { fetchAllRows, errorMessage } from "@/lib/ops/fetch-all";
import { chunk } from "@/lib/ops/p-limit";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UPSERT_CHUNK = 500;

interface SnapshotResult {
  ran_at: string;
  dry_run: boolean;
  period: string;
  tenants: number;
  customers: number;
  total_mrr: number;
  skipped_no_customer: number;
  errors: string[];
}

/** First day of the month containing `d`, as YYYY-MM-DD. */
function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function handle(req: Request): Promise<NextResponse<SnapshotResult | { error: string }>> {
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
      { error: "?on= is only accepted with ?dry=1 — writing this month's figures into an earlier period would rewrite history, and retention is the one number where that looks exactly like a real change." },
      { status: 400 },
    );
  }

  const now = onParam ? new Date(`${onParam}T12:00:00Z`) : new Date();
  const period = periodOf(now);

  const supabase = createAdminClient();
  const result: SnapshotResult = {
    ran_at: now.toISOString(), dry_run: dryRun, period,
    tenants: 0, customers: 0, total_mrr: 0, skipped_no_customer: 0, errors: [],
  };

  /* WC-scale: paged. One select stopped at PostgREST's 1000-row cap without saying so, and
     every subscription past the thousandth was simply missing from the month — NRR then
     reads that as churn. Ordered by id so the offset pages cannot overlap or skip. */
  let subs: { tenant_id: string; customer_id: string | null; mrr: number | null }[];
  try {
    subs = await fetchAllRows((from, to) => supabase
      .from("subscriptions")
      .select("tenant_id, customer_id, mrr")
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }

  /* Aggregated per (tenant, customer). A customer with three subscriptions is ONE
     retention data point — see the migration header on why the grain is the
     customer. */
  const byCustomer = new Map<string, { tenantId: string; customerId: string; mrr: number; count: number }>();
  const tenantIds = new Set<string>();

  for (const s of subs) {
    /* R-897 */ if (!cronTenantAllowed(s.tenant_id)) continue;
    if (!s.customer_id) {
      /* A subscription with no customer cannot be attributed, and guessing would put
         revenue against the wrong retention cohort. Counted so the gap is visible. */
      result.skipped_no_customer++;
      continue;
    }
    tenantIds.add(s.tenant_id);
    const key = `${s.tenant_id}:${s.customer_id}`;
    const prev = byCustomer.get(key) ?? { tenantId: s.tenant_id, customerId: s.customer_id, mrr: 0, count: 0 };
    prev.mrr += Math.max(0, Math.round(s.mrr ?? 0));
    prev.count += 1;
    byCustomer.set(key, prev);
  }

  result.tenants = tenantIds.size;
  result.customers = byCustomer.size;
  result.total_mrr = [...byCustomer.values()].reduce((a, x) => a + x.mrr, 0);

  if (dryRun) return NextResponse.json(result);

  const rows = [...byCustomer.values()].map((x) => ({
    tenant_id: x.tenantId,
    customer_id: x.customerId,
    period,
    mrr: x.mrr,
    subscription_count: x.count,
  }));

  /* UPSERT_CHUNK rows a request — one body holding every customer grows with the business
     until it hits the request-size limit. Each chunk is an idempotent upsert, so a failure
     part-way is repaired by re-running the job. */
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error: upErr } = await supabase
      .from("mrr_snapshots")
      .upsert(part, { onConflict: "tenant_id,customer_id,period" });
    if (upErr) {
      result.errors.push(upErr.message);
      return NextResponse.json(result, { status: 500 });
    }
  }

  console.info(`[mrr-snapshot] ${period}: ${rows.length} customers, ₹${result.total_mrr}/mo across ${result.tenants} tenants`);
  return NextResponse.json(reportCron("mrr-snapshot", result));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("mrr-snapshot", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }
