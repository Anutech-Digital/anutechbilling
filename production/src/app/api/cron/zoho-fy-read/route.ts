/**
 * Cron: R-2607 — the FY read from Zoho (Invoices → "FY 2025-26 receipts from Zoho" → Read from Zoho)
 * runs here, on the server, with the browser closed. Every minute (Cloud Scheduler
 * "resellersos-zoho-fy-read", scripts/setup-cloud-scheduler.sh).
 *
 * Works ONLY on reads an owner / accountant asked for (zoho_fy_scan_runs.bg_requested_at); each
 * company's pass uses that company's own Zoho connection and scan (fy-import/read-job.server.ts),
 * takes the run's lease (never two passes at once — the open dialog's pass included), reads under
 * Zoho's pace, saves after every call and lets go. Zoho is only READ; nothing is imported (Check +
 * Import stay the owner's buttons). Nothing asked for → nothing is read.
 *
 * Default ON (jobs.ts SAFETY_JOBS_DEFAULT_ON, R-2607): the owner's button is the ask; a switch
 * that is off by default would leave the read stuck with nobody knowing why. It can still be
 * turned off on /automation by the platform company (scope "platform": one switch for the app; then
 * only the dialog's own pass reads, while it is open).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { reportCron } from "@/lib/ops/cron-report";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import { listRequestedReads } from "@/lib/integrations/zoho-books/fy-import/bg-store";
import { companyReadPass } from "@/lib/integrations/zoho-books/fy-import/read-job.server";
import type { FyImportDb } from "@/lib/integrations/zoho-books/fy-import/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** All passes of one tick together stay well under maxDuration (the scheduler fires every minute anyway). */
const TICK_BUDGET_MS = 240_000;
const MIN_PASS_MS = 20_000;

async function handle(req: NextRequest) {
  /* Fail closed like the other crons (the gate checks it first too). */
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const started = Date.now();
  let reads;
  try { reads = await listRequestedReads(admin as unknown as FyImportDb); }
  catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }

  let processed = 0, synced = 0, failed = 0, skipped = 0;
  const errors: string[] = [];
  const mine = reads.filter((r) => cronTenantAllowed(r.tenantId));
  for (let i = 0; i < mine.length; i++) {
    const left = TICK_BUDGET_MS - (Date.now() - started);
    if (left < MIN_PASS_MS) { skipped += mine.length - i; break; }
    const r = mine[i];
    /* Share what is left between the reads still waiting (one big company never starves the rest). */
    const budgetMs = Math.max(MIN_PASS_MS, Math.floor(left / (mine.length - i)));
    try {
      const res = await companyReadPass(admin, r.tenantId, r.kind, r.fy, { budgetMs, requireRequest: true });
      if (!res || res.outcome === "locked" || res.outcome === "not-requested") { skipped++; continue; }
      processed++;
      if (res.outcome === "complete") synced++;
      if (res.outcome === "stopped" || res.outcome === "retry") { failed++; errors.push(`${r.tenantId} ${r.kind} ${r.fy}: ${res.error ?? res.outcome}`); }
    } catch (e) {
      failed++;
      errors.push(`${r.tenantId} ${r.kind} ${r.fy}: ${(e as Error).message}`);
    }
  }
  return NextResponse.json(reportCron("zoho-fy-read", { ok: true, considered: mine.length, processed, synced, skipped, failed, errors }));
}

const gated = gatedCron("zoho-fy-read", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
