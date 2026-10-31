/**
 * Cron (every 5 min): every buyer gets a customer panel (DMS) account — R-2103, 29 Oct 2026.
 *
 * ─── THE GAP ────────────────────────────────────────────────────────────────
 * No ResellerOS path asked DMS for the customer's panel account: it appeared only as a side
 * effect of hosting.provision / domain.register. Workspace and support buyers, staff sales,
 * desk payments and bank-reconcile sales never got a login.
 *
 * ─── WHAT IT DOES ───────────────────────────────────────────────────────────
 * trg_queue_panel_account queues one panel_account_outbox row per customer on their first
 * received payment (any path). This route:
 *   1. claim_panel_account_outbox: up to 50 due 'pending' rows (SKIP LOCKED, 5-min lease) with
 *      the customer's details, only for companies the automation switch is on for. A row whose
 *      customer lost their email turns 'needs_email' (staff see it on Hosting & Domains).
 *   2. sends DMS `customer.ensure` for each (lib/provisioning/panel-account.server.ts): DMS
 *      finds the user by email or creates it and mails the one-time password.
 *   3. finish_panel_account_outbox: done (dms_user_id kept) / wait 1 h (DMS gate shut, held,
 *      busy — no attempt used) / retry with back-off, the 5th failure → 'failed'.
 *
 * R-2142 (GP-D3): a row with op 'deactivate' (a personal account erase, queued by
 * queue_panel_account_deactivate) goes through the same claim → send → finish, but sends DMS
 * `customer.deactivate` (login off, link cleared, services kept) — processPanelAccountRow picks
 * the command by op. DMS's own gate for it is ENGINE_CUSTOMER_DEACTIVATE_LIVE.
 *
 * PANEL_ACCOUNTS_LIVE ≠ "1" or no DMS command key → nothing is claimed or sent; one log line
 * and 200 { skipped: "not_configured" }, so the rows wait until it is configured.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { reportCron } from "@/lib/ops/cron-report";
import { mapLimit } from "@/lib/ops/p-limit";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";
import { cronAuthFailure } from "@/app/api/cron/_lib/cron-auth";
import { gatedCron, cronTenantAllowed, currentCronRun } from "@/lib/automation/cron-gate";
import {
  emptyProcessResult,
  panelAccountsReady,
  processPanelAccountRow,
  type PanelAccountRow,
  type ProcessResult,
} from "@/lib/provisioning/panel-account.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JOB = "panel-accounts";
/** The claim RPC caps at 50 too. */
export const BATCH = 50;
/** Commands in flight at once — DMS is one server. */
const CONCURRENCY = 3;

export interface PanelAccountsResult extends ProcessResult {
  ok: boolean;
  claimed: number;
  skipped?: "not_configured";
}

/** The companies this pass may work on, for the claim; null = every company. */
function allowedTenants(): string[] | null {
  const run = currentCronRun();
  if (!run || run.allTenants) return null;
  return [...run.tenants];
}

async function handle(req: Request): Promise<Response> {
  /* The gate already checked the bearer; checked again here like provision-hosting (R-1552). */
  const denied = cronAuthFailure(req, process.env.CRON_SECRET);
  if (denied) return denied;

  if (!panelAccountsReady()) {
    console.warn(`[cron/${JOB}] PANEL_ACCOUNTS_LIVE is not 1 or the DMS command key is not set — nothing sent; queued rows wait.`);
    const skipped: PanelAccountsResult = { ok: true, skipped: "not_configured", claimed: 0, ...emptyProcessResult() };
    return NextResponse.json(skipped);
  }

  /* The RPCs are newer than the generated types (database.generated.ts). */
  const db = createAdminClient() as unknown as SupabaseClient;

  const { data, error } = await db.rpc("claim_panel_account_outbox", { p_limit: BATCH, p_tenant_ids: allowedTenants(), p_customer_id: null });
  if (error) return cronDbFailure(JOB, error, error.message);

  /* A row of a company this pass may not touch is left alone — its lease runs out. */
  const rows = ((data ?? []) as PanelAccountRow[]).filter((r) => cronTenantAllowed(r.tenant_id));

  const result: PanelAccountsResult = { ok: true, claimed: rows.length, ...emptyProcessResult() };
  await mapLimit(rows, CONCURRENCY, (row) => processPanelAccountRow(db, row, result));

  if (result.errors.length > 0) result.ok = false;
  if (result.retrying > 0) console.info(`[cron/${JOB}] ${result.retrying} customer.ensure send(s) failed and will be retried`);
  if (result.needsEmail > 0) console.info(`[cron/${JOB}] ${result.needsEmail} customer(s) need an email address before their panel account can be made`);
  return NextResponse.json(reportCron("panel-accounts", result));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("panel-accounts", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }
