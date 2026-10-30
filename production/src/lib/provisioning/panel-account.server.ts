/**
 * R-2103 (29 Oct 2026) — every buyer gets a customer panel account (the DMS panel,
 * app.anutech.in). Pardeep: "anutech digital se koi bhi kuch kharidta hai to ... customer ka
 * customer panel hona chahiye jo hamne already bana rakha hai".
 *
 * ONE PLACE. A received payment — whichever path wrote it — queues the customer in
 * `panel_account_outbox` (trigger trg_queue_panel_account, migration 20261029114000). This
 * module sends DMS `customer.ensure` for those rows: DMS finds the user by email or creates it
 * and mails "Your Customer Portal is ready" with a one-time password (DMS
 * lib/integrations/engine-handlers-customer.ts). An existing DMS user is only linked — no
 * second mail.
 *
 * Callers: the cron /api/cron/panel-accounts (every 5 min) and the Razorpay webhook right after
 * a payment settles (so a card buyer has the login within seconds). Both go through the same
 * claim → send → finish, so the lease stops them sending one customer twice in parallel.
 *
 * NOTHING IS SENT unless all of these are on:
 *   - PANEL_ACCOUNTS_LIVE=1 on this server (exact "1");
 *   - DMS_ENGINE_URL + DMS_ENGINE_COMMAND_KEY (commandsConfigured);
 *   - the company's "Customer panel accounts" automation switch (cron gate / automationState);
 *   - DMS's own gate ENGINE_CUSTOMER_ACCOUNT_LIVE (closed → the row waits an hour, no attempt used).
 *
 * Built on Pawan's unmerged 90c8ddcf9 (lib/provisioning/portal-account.server.ts), keyed by
 * CUSTOMER instead of order and without its hosting/domain-only filter.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { commandsConfigured, sendEngineCommand, type CommandOutcome, type EngineCommand } from "@/lib/dms-engine/commands";
import { billingCustomerId } from "@/lib/api/v1-mappers";
import { normalisePhone, splitName } from "@/lib/provisioning/domain-registration";
import { automationState } from "@/lib/automation/gate.server";

export const PANEL_ACCOUNTS_JOB = "panel-accounts" as const;

/** This server's own switch, exact "1" only (like HOSTING_PROVISIONING_LIVE). */
export function panelAccountsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PANEL_ACCOUNTS_LIVE === "1";
}

/** Everything this server needs before it may send: its flag and the DMS command key. */
export function panelAccountsReady(env: Record<string, string | undefined> = process.env): boolean {
  return panelAccountsEnabled(env) && commandsConfigured();
}

/** R-2142: what a panel_account_outbox row asks DMS to do. */
export type PanelAccountOp = "ensure" | "deactivate";

/** A row as claim_panel_account_outbox returns it. */
export interface PanelAccountRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  attempts: number;
  /** R-2142: 'deactivate' = personal erase → DMS customer.deactivate. Absent/'ensure' = customer.ensure. */
  op?: PanelAccountOp;
  email: string | null;
  customer_name: string | null;
  contact_name: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  phone: string | null;
  gstin: string | null;
  state: string | null;
  address: string | null;
  city: string | null;
  pin_code: string | null;
  country: string | null;
  customer_number: string | null;
}

/** Same test DMS's parseCustomer applies — an address it would refuse is never sent. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** IST yyyymmdd. */
function istDay(now: Date): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * One commandId per customer per IST day. The engine replays a stored outcome for a repeated
 * id, so a "held" or "refused" answer would otherwise be replayed for ever; customer.ensure
 * finds the user by email, so a new id the next day can never make a second account or mail.
 * Same idea as provision-hosting's provisionCommandId.
 */
export function panelAccountCommandId(customerId: string, now: Date = new Date()): string {
  return `rsos-acct-${customerId}-${istDay(now)}`;
}

/** The customer.ensure command for a claimed row; null when the row has no usable email. */
export function buildEnsureCommand(row: PanelAccountRow, now: Date = new Date()): EngineCommand | null {
  const email = (row.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;

  const first = (row.contact_first_name ?? "").trim();
  const last = (row.contact_last_name ?? "").trim();
  const name = first
    ? { firstName: first, lastName: last || first }
    : splitName(row.contact_name || row.customer_name || email.split("@")[0]);

  const line1 = (row.address ?? "").trim();
  const city = (row.city ?? "").trim();
  const zipcode = (row.pin_code ?? "").trim();
  const country = (row.country ?? "").trim();
  const customer: Record<string, unknown> = {
    ...name,
    email,
    ...normalisePhone(row.phone ?? ""),
    companyName: row.customer_name?.trim() || undefined,
    billingCustomerId: billingCustomerId({ id: row.customer_id, customer_number: row.customer_number }),
  };
  if (row.gstin?.trim()) customer.gstin = row.gstin.trim();
  if (row.state?.trim()) customer.state = row.state.trim();
  if (line1 && city && zipcode) {
    customer.address = { line1, city, zipcode, country: !country || /^india$/i.test(country) ? "IN" : country.slice(0, 2).toUpperCase() };
  }

  return {
    commandId: panelAccountCommandId(row.customer_id, now),
    command: "customer.ensure",
    subject: email,
    mode: "live",
    payload: { customer, sourceRef: row.customer_id },
  };
}

/** R-2142: one deactivate commandId per customer per IST day (a retry the same day is replayed). */
export function panelDeactivateCommandId(customerId: string, now: Date = new Date()): string {
  return `rsos-deact-${customerId}-${istDay(now)}`;
}

/**
 * R-2142 (GP-D3): the customer.deactivate command for a claimed 'deactivate' row — the personal
 * account was erased, so DMS turns the login off and clears its link to this customer (paid
 * services stay). customerId is the same billing_customer_id DMS stores as resellerosCustomerId;
 * DMS refuses when the account is linked to a different one. Null when the row has no usable email.
 */
export function buildDeactivateCommand(row: PanelAccountRow, now: Date = new Date()): EngineCommand | null {
  const email = (row.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  return {
    commandId: panelDeactivateCommandId(row.customer_id, now),
    command: "customer.deactivate",
    subject: email,
    mode: "live",
    payload: {
      customerId: billingCustomerId({ id: row.customer_id, customer_number: row.customer_number }),
      reason: "personal-erase",
      sourceRef: row.customer_id,
    },
  };
}

export type FinishResult = "done" | "wait" | "retry" | "needs_email";

/** How an engine answer is recorded on the row. */
export function finishFor(outcome: CommandOutcome): { result: FinishResult; dmsUserId: string | null; error: string | null } {
  switch (outcome.kind) {
    case "done": {
      const id = outcome.result.userId;
      return { result: "done", dmsUserId: typeof id === "string" && id ? id : null, error: null };
    }
    /* Nobody is broken: DMS's gate is shut, a person must decide, or the subject is busy.
       Try again in an hour without using up an attempt. */
    case "gate_closed":
    case "held":
    case "busy":
      return { result: "wait", dmsUserId: null, error: `${outcome.kind}: ${outcome.reason}` };
    default:
      return { result: "retry", dmsUserId: null, error: `${outcome.kind}: ${outcome.reason}` };
  }
}

type Db = SupabaseClient;

export interface ProcessResult {
  done: number;
  waiting: number;
  retrying: number;
  failed: number;
  needsEmail: number;
  errors: string[];
}

export function emptyProcessResult(): ProcessResult {
  return { done: 0, waiting: 0, retrying: 0, failed: 0, needsEmail: 0, errors: [] };
}

/** Send customer.ensure (or, for an erased personal account, customer.deactivate) for one claimed row and record the answer. */
export async function processPanelAccountRow(db: Db, row: PanelAccountRow, out: ProcessResult, now: Date = new Date()): Promise<void> {
  const cmd = row.op === "deactivate" ? buildDeactivateCommand(row, now) : buildEnsureCommand(row, now);
  const fin = cmd
    ? finishFor(await sendEngineCommand(cmd))
    : { result: "needs_email" as const, dmsUserId: null, error: "The customer has no valid email address." };

  const { data: status, error } = await db.rpc("finish_panel_account_outbox", {
    p_id: row.id,
    p_result: fin.result,
    p_dms_user_id: fin.dmsUserId,
    p_error: fin.error,
  });
  if (error) {
    out.errors.push(`panel account ${row.id}: could not record the send (${error.message}) — retried after the lease`);
    return;
  }
  if (status === "done") out.done++;
  else if (status === "needs_email") out.needsEmail++;
  else if (status === "failed") out.failed++;
  else if (fin.result === "wait") out.waiting++;
  else out.retrying++;
}

export type EnsureOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "linked" }
  | { kind: "sent"; result: ProcessResult };

/**
 * Right after a payment settles (Razorpay webhook). Best-effort: never throws, and the
 * payment is already recorded either way — the cron picks up anything left.
 *
 * `dmsUserId`: the order came from inside the DMS panel (channel dms-panel), so the buyer
 * already IS a DMS user — the row is marked done with that id instead of sending anything.
 */
export interface PanelAccountInput {
  tenantId: string;
  /** The customer, when the caller knows it … */
  customerId?: string | null;
  /** … else the paid quote, whose customer it is (read only when something will be done). */
  quoteId?: string | null;
  dmsUserId?: string | null;
}

export async function ensurePanelAccount(
  adminClient: unknown,
  input: PanelAccountInput,
  opts: { timeoutMs?: number } = {},
): Promise<EnsureOutcome> {
  /* The webhook and the buyer's checkout/verify wait on this, so it is capped. Past the cap
     the send carries on; the row stays leased and its answer is recorded when it comes, or the
     cron sends it again after the 5-minute lease (same commandId the same day: replayed). */
  const timeoutMs = opts.timeoutMs ?? ENSURE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<EnsureOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "skipped", reason: `no answer from DMS within ${timeoutMs} ms — the cron finishes it` }), timeoutMs);
  });
  try {
    return await Promise.race([ensureNow(adminClient, input), cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How long the webhook waits for the panel account before moving on. */
export const ENSURE_TIMEOUT_MS = 6_000;

async function ensureNow(
  adminClient: unknown,
  input: PanelAccountInput,
): Promise<EnsureOutcome> {
  try {
    const db = adminClient as Db;
    if (!input.dmsUserId) {
      if (!panelAccountsReady()) return { kind: "skipped", reason: "PANEL_ACCOUNTS_LIVE or the DMS command key is not set" };
      if ((await automationState(input.tenantId, PANEL_ACCOUNTS_JOB)) !== "on") {
        return { kind: "skipped", reason: "the Customer panel accounts switch is not on for this company" };
      }
    }

    let customerId = input.customerId ?? null;
    if (!customerId && input.quoteId) {
      const { data } = await db
        .from("quotes").select("customer_id").eq("id", input.quoteId).eq("tenant_id", input.tenantId).maybeSingle();
      customerId = (data as { customer_id?: string | null } | null)?.customer_id ?? null;
    }
    if (!customerId) return { kind: "skipped", reason: "no customer on the order" };

    if (input.dmsUserId) {
      const { error } = await db.rpc("mark_panel_account_linked", {
        p_tenant_id: input.tenantId,
        p_customer_id: customerId,
        p_dms_user_id: input.dmsUserId,
      });
      if (error) return { kind: "skipped", reason: `could not link the DMS user: ${error.message}` };
      return { kind: "linked" };
    }

    const { data, error } = await db.rpc("claim_panel_account_outbox", {
      p_limit: 1,
      p_tenant_ids: [input.tenantId],
      p_customer_id: customerId,
    });
    if (error) return { kind: "skipped", reason: `claim failed: ${error.message}` };
    const rows = (data ?? []) as PanelAccountRow[];
    if (rows.length === 0) return { kind: "skipped", reason: "nothing due for this customer" };

    const result = emptyProcessResult();
    for (const row of rows) await processPanelAccountRow(db, row, result);
    return { kind: "sent", result };
  } catch (e) {
    return { kind: "skipped", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * R-2142 (GP-D3): the personal account erase (GP-22/23) calls this to turn the customer's DMS
 * panel login off. It only queues (queue_panel_account_deactivate, service_role); the cron
 * /api/cron/panel-accounts sends customer.deactivate. Idempotent: 'queued' | 'already' |
 * 'no_email' (no DMS user to find) | null (customer not in that company). Throws on a DB error so
 * the erase never reports success without the queue. Call it BEFORE the customer's email is
 * scrubbed (the email is captured on the row), and keep the customers row (anonymise, not delete):
 * the outbox row cascades with it.
 */
export async function queuePanelAccountDeactivate(
  db: Db,
  input: { tenantId: string; customerId: string },
): Promise<"queued" | "already" | "no_email" | null> {
  const { data, error } = await db.rpc("queue_panel_account_deactivate", {
    p_tenant_id: input.tenantId,
    p_customer_id: input.customerId,
  });
  if (error) throw new Error(`Could not queue the DMS panel deactivate: ${error.message}`);
  return (data ?? null) as "queued" | "already" | "no_email" | null;
}
