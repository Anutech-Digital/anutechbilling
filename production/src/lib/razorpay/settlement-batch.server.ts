/**
 * R-2654 — Razorpay settlements month batch: read the month ONCE, pair, plan, and book every ready line.
 *
 *   loadMonthBatch  — the account's open Razorpay money-in lines of one month (YYYY-MM), the month's
 *                     settlements from Razorpay (one /v1/settlements list; each recon day read once,
 *                     cached — never one round per line), paired (settlement-batch.ts, fail closed)
 *                     and each paired line planned by R-2099's own planForSettlement. Nothing saved.
 *   runMonthBatch   — rebuilds that batch on the server (never the browser's numbers), starts ONE run
 *                     (razorpay_batch_run_start) and books each ready line through
 *                     reconcile_razorpay_settlement_in_run (R-2099's booking + the run record, one
 *                     transaction per line). A line refused at booking stays as it was and comes back
 *                     with the database's own message; the other lines still book.
 *   undoMonthRun    — undo_bank_recon_run: every line of the run back through the plain un-reconcile.
 *
 * Razorpay is read only (GET). App reads and every booking run on the signed-in user's own client
 * (RLS + the functions' owner/accountant gate); the service role only reads the sealed keys.
 */
import type { createAdminClient, createClient } from "@/lib/supabase/server";
import { isRazorpaySettlementLine, type BankLine, type RzpSettlement, type SettlementPlan } from "./settlement-match";
import { listSettlements, razorpayGetter, RazorpayApiError, settlementItems, type RazorpayGet } from "./settlement-api.server";
import { loadSettlementKeys, NO_KEYS_MESSAGE, planForSettlement } from "./settlement.server";
import { monthWindow, pairMonth, summarise, type BatchRow, type MonthBatchLookup } from "./settlement-batch";

type UserDb = ReturnType<typeof createClient>;
type AdminDb = ReturnType<typeof createAdminClient>;

/** Most open Razorpay lines one month can hold before the batch asks for a smaller account/month. */
export const MAX_LINES = 300;

/** The same GET twice (a recon day two settlements share) goes to Razorpay once. */
export function cachedGetter(get: RazorpayGet): RazorpayGet {
  const memo = new Map<string, Promise<unknown>>();
  return (path, params) => {
    const key = `${path}?${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&")}`;
    let hit = memo.get(key);
    if (!hit) {
      hit = get(path, params);
      memo.set(key, hit);
      hit.catch(() => memo.delete(key));
    }
    return hit;
  };
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export interface MonthArgs {
  db: UserDb;
  admin: AdminDb;
  tenantId: string;
  accountId: string;
  month: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** The table, nothing saved. */
export async function loadMonthBatch(args: MonthArgs): Promise<MonthBatchLookup> {
  return (await buildMonth(args)).lookup;
}

/** The table plus each ready line's booking argument (kept on the server — the run books from these). */
async function buildMonth(args: MonthArgs): Promise<{ lookup: MonthBatchLookup; plans: Map<string, SettlementPlan> }> {
  const plans = new Map<string, SettlementPlan>();
  const done = (lookup: MonthBatchLookup) => ({ lookup, plans });
  const { db, tenantId, accountId, month } = args;
  const win = monthWindow(month);

  const { data: rows, error } = await db
    .from("bank_transactions")
    .select("id, credit, txn_date, reference, description")
    .eq("tenant_id", tenantId)
    .eq("bank_account_id", accountId)
    .is("matched_to_type", null)
    .gt("credit", 0)
    .ilike("description", "%razorpay%")
    .gte("txn_date", win.first)
    .lte("txn_date", win.last)
    .order("txn_date", { ascending: true })
    .limit(MAX_LINES + 1);
  fail("bank lines", error);
  const lines: BankLine[] = ((rows ?? []) as Array<BankLine & { description: string | null }>)
    .map((r) => ({ id: r.id, credit: Number(r.credit), txn_date: r.txn_date, reference: r.reference, description: r.description ?? "" }))
    .filter((l) => isRazorpaySettlementLine(l));
  if (lines.length > MAX_LINES) {
    return done({ state: "error", message: `More than ${MAX_LINES} open Razorpay lines in ${month} — reconcile some one by one first.` });
  }
  if (!lines.length) return done({ state: "batch", batch: summarise(month, []) });

  const creds = await loadSettlementKeys(args.admin, tenantId, args.env);
  if (!creds) return done({ state: "no_keys", message: NO_KEYS_MESSAGE });
  const get = cachedGetter(razorpayGetter(creds, args.fetchImpl));

  const { data: recons, error: doneErr } = await db
    .from("razorpay_settlement_recons")
    .select("settlement_id")
    .eq("tenant_id", tenantId);
  fail("settlements", doneErr);
  const already = new Set(((recons ?? []) as { settlement_id: string }[]).map((r) => r.settlement_id));

  let settlements: RzpSettlement[];
  try {
    settlements = await listSettlements(get, win.from, win.to);
  } catch (e) {
    if (e instanceof RazorpayApiError) return done({ state: "error", message: e.message });
    throw e;
  }

  const out: BatchRow[] = [];
  for (const p of pairMonth(lines, settlements, already)) {
    const base: BatchRow = {
      txnId: p.line.id, txnDate: p.line.txn_date, amount: Number(p.line.credit) || 0, narration: p.line.description,
      settlementId: p.settlement?.id ?? null, utr: p.settlement?.utr ?? null, pairedBy: p.by,
      ready: false, blockers: p.problem ? [p.problem] : [], payments: 0, gross: 0, fee: 0, feeGst: 0,
    };
    if (!p.settlement) { out.push(base); continue; }
    try {
      const items = await settlementItems(get, p.settlement);
      const plan = await planForSettlement({ db, tenantId, line: p.line, settlement: p.settlement, items });
      if (plan.ready && plan.rpcArg) plans.set(p.line.id, plan);
      out.push({
        ...base, ready: plan.ready, blockers: plan.blockers,
        payments: plan.payments.length, gross: plan.totals.gross, fee: plan.totals.fee, feeGst: plan.totals.feeGst,
      });
    } catch (e) {
      if (e instanceof RazorpayApiError) {
        /* Razorpay stopped answering part way: this line and the rest are not ready — say so, book nothing for them. */
        out.push({ ...base, blockers: [e.message] });
        continue;
      }
      throw e;
    }
  }
  return done({ state: "batch", batch: summarise(month, out) });
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
const rpcOf = (db: UserDb): Rpc => (db as unknown as { rpc: Rpc }).rpc.bind(db);

export interface RunResult {
  runId: string | null;
  booked: Array<{ txnId: string; settlementId: string; amount: number; fee: number }>;
  refused: Array<{ txnId: string; message: string }>;
  /** lines that were not ready (blocked) when the run was planned */
  blocked: number;
}

export async function runMonthBatch(args: MonthArgs & {
  /** only these lines (the ones the owner saw as ready); omitted = every ready line */
  txnIds?: string[];
}): Promise<{ state: "done"; result: RunResult } | { state: "no_keys" | "error"; message: string }> {
  /* Re-planned here from Razorpay and the app's rows — the browser sends only the account, month and line ids. */
  const { lookup, plans } = await buildMonth(args);
  if (lookup.state !== "batch") return lookup;
  const want = args.txnIds ? new Set(args.txnIds) : null;
  const ready = lookup.batch.rows.filter((r) => r.ready && plans.has(r.txnId) && (!want || want.has(r.txnId)));
  const result: RunResult = { runId: null, booked: [], refused: [], blocked: lookup.batch.blocked };
  if (!ready.length) return { state: "done", result };

  const rpc = rpcOf(args.db);
  const { data: runId, error: startErr } = await rpc("razorpay_batch_run_start", { p_account_id: args.accountId });
  if (startErr) return { state: "error", message: startErr.message };
  result.runId = runId as string;

  for (const r of ready) {
    const plan = plans.get(r.txnId) as SettlementPlan;
    const { data, error } = await rpc("reconcile_razorpay_settlement_in_run", { p_run_id: result.runId, p_txn_id: r.txnId, p_settlement: plan.rpcArg });
    if (error) { result.refused.push({ txnId: r.txnId, message: error.message }); continue; }
    const d = (data ?? {}) as { settlement_id?: string; fee?: number };
    result.booked.push({ txnId: r.txnId, settlementId: d.settlement_id ?? plan.settlement.id, amount: r.amount, fee: Number(d.fee) || 0 });
  }
  return { state: "done", result };
}

export async function undoMonthRun(db: UserDb, runId: string): Promise<{ undone: number; left: Array<{ txn_id: string; txn_date: string; credit: number; reason: string }> }> {
  const { data, error } = await rpcOf(db)("undo_bank_recon_run", { p_run_id: runId });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const d = (data ?? {}) as { undone?: number; left?: Array<{ txn_id: string; txn_date: string; credit: number; reason: string }> };
  return { undone: Number(d.undone) || 0, left: d.left ?? [] };
}
