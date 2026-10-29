/**
 * Cron (every 5 min): tell the support desk (DSP) when a support plan is sold, renewed or
 * cancelled — R-2067, 29 Oct 2026.
 *
 * ─── THE GAP ────────────────────────────────────────────────────────────────
 * trg_queue_support_sync writes a `support_sync_outbox` row whenever a support subscription
 * (vendor 'support') is created or its plan / status / renewal date changes, and
 * trg_queue_support_sync_on_customer_status does the same when the customer is archived or
 * restored. Nothing ever sent those rows, so a support plan sold on a quote never reached DSP
 * and the customer stayed on Free there. This route is the sender.
 *
 * ─── WHAT IT DOES ───────────────────────────────────────────────────────────
 *   1. claim_support_sync_outbox: up to 50 due 'pending' rows, FOR UPDATE SKIP LOCKED and
 *      leased for 5 minutes, ONE row per customer (oldest first — each row is the customer's
 *      full state, so an older row must never land after a newer one), only for companies
 *      the automation switch is on for.
 *   2. POST each row's payload, exactly as the trigger built it, to
 *      `${DSP_SUPPORT_URL}/api/sync/customer` with header `X-Webhook-Secret: DSP_WEBHOOK_SECRET`
 *      (DSP checks it in syncController.receiveBillingWebhook).
 *   3. finish_support_sync_outbox: 2xx → 'sent'; anything else (non-2xx, timeout, network) →
 *      attempts + 1, last_error, back-off; the 5th failure → 'failed'. Rows given up on this
 *      run are counted as `failed`, which reportCron puts on stderr as a `[cron/support-sync]`
 *      line — the health digest picks those up.
 *
 * DSP_SUPPORT_URL or DSP_WEBHOOK_SECRET missing → nothing is claimed or sent; one log line and
 * 200 { skipped: "not_configured" }, so the rows wait until it is configured.
 *
 * At-least-once: if this run dies after DSP answered but before finish, the lease runs out and
 * the row is sent again. DSP's sync is an upsert of the customer's current state, so a repeat
 * is harmless.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { reportCron } from "@/lib/ops/cron-report";
import { mapLimit } from "@/lib/ops/p-limit";
import { errorMessage } from "@/lib/ops/fetch-all";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";
import { gatedCron, cronTenantAllowed, currentCronRun } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JOB = "support-sync";
/** The claim RPC caps at 50 too. */
export const BATCH = 50;
/** Sends in flight at once — DSP is one small server. */
const CONCURRENCY = 5;
const SEND_TIMEOUT_MS = 10_000;

interface OutboxRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  payload: unknown;
  attempts: number;
  created_at: string;
}

export interface SupportSyncResult {
  ok: boolean;
  claimed: number;
  sent: number;
  /** Failed this time, will be tried again (back-off). */
  retrying: number;
  /** Failed for the 5th time this run — given up, status 'failed'. */
  failed: number;
  errors: string[];
  skipped?: "not_configured";
}

/** The companies this pass may work on, for the claim; null = every company. */
function allowedTenants(): string[] | null {
  const run = currentCronRun();
  if (!run || run.allTenants) return null;
  return [...run.tenants];
}

async function send(url: string, secret: string, payload: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) return { ok: true };
    let text = "";
    try { text = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    return { ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (e) {
    return { ok: false, error: errorMessage(e) || "send failed" };
  }
}

async function handle(_req: Request): Promise<Response> {
  const base = process.env.DSP_SUPPORT_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.DSP_WEBHOOK_SECRET?.trim();
  if (!base || !secret) {
    console.warn(`[cron/${JOB}] DSP_SUPPORT_URL or DSP_WEBHOOK_SECRET is not set — nothing sent; queued rows wait.`);
    const skipped: SupportSyncResult = { ok: true, skipped: "not_configured", claimed: 0, sent: 0, retrying: 0, failed: 0, errors: [] };
    return NextResponse.json(skipped);
  }
  const url = `${base}/api/sync/customer`;

  /* The two RPCs are newer than the generated types (database.generated.ts). */
  const db = createAdminClient() as unknown as SupabaseClient;

  const { data, error } = await db.rpc("claim_support_sync_outbox", { p_limit: BATCH, p_tenant_ids: allowedTenants() });
  if (error) return cronDbFailure(JOB, error, error.message);

  /* Oldest first; the claim already holds at most one row per customer. A row of a company
     this pass may not touch is left alone — its lease runs out and it waits for its own switch. */
  const rows = ((data ?? []) as OutboxRow[])
    .filter((r) => cronTenantAllowed(r.tenant_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const result: SupportSyncResult = { ok: true, claimed: rows.length, sent: 0, retrying: 0, failed: 0, errors: [] };

  await mapLimit(rows, CONCURRENCY, async (row) => {
    const out = await send(url, secret, row.payload);
    const { data: status, error: finErr } = await db.rpc("finish_support_sync_outbox", {
      p_id: row.id,
      p_ok: out.ok,
      p_error: out.ok ? null : out.error,
    });
    if (finErr) {
      result.errors.push(`outbox ${row.id}: could not record the send (${finErr.message}) — it is retried after the lease`);
      return;
    }
    if (out.ok) result.sent++;
    else if (status === "failed") result.failed++;
    else result.retrying++;
  });

  if (result.errors.length > 0) result.ok = false;
  if (result.retrying > 0) {
    console.info(`[cron/${JOB}] ${result.retrying} send(s) failed and will be retried`);
  }
  return NextResponse.json(reportCron("support-sync", result));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("support-sync", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }
