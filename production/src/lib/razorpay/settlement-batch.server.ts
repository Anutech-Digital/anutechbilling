/**
 * R-2654 — Razorpay settlements month batch: read the month ONCE, pair, plan, and book every ready line.
 *
 *   loadMonthBatch  — the account's open Razorpay money-in lines of one month (YYYY-MM), the month's
 *                     settlements from Razorpay (one /v1/settlements list; each recon day read once,
 *                     cached — never one round per line), paired (settlement-batch.ts, fail closed)
 *                     and each paired line planned by R-2099's own planForSettlement. Nothing saved.
 *   runMonthBatch   — books one chunk (≤ RUN_CHUNK) of the lines the owner saw as Ready: re-planned on
 *                     the server (never the browser's numbers), ONE run for the whole press
 *                     (razorpay_batch_run_start on the first chunk, the same run id after), each line
 *                     through reconcile_razorpay_settlement_in_run (R-2099's booking + the run record,
 *                     one transaction per line). A line refused at booking stays as it was and comes
 *                     back with the database's own message; the other lines still book.
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

/** Most open Razorpay lines around one month before the batch asks for one-by-one first. */
export const MAX_LINES = 300;

/** Lines a run books at most per request — the sheet sends the ready lines in chunks of this size (each well inside maxDuration). */
export const RUN_CHUNK = 15;

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

/** R-2099's / R-2535's own refusals (written for the user). Anything else is never shown raw. */
const GUARD_CODES = new Set(["P0001", "P0002", "22023", "23514", "23505", "42501", "28000"]);
export const userMessage = (e: { message: string; code?: string } | null | undefined, fallback: string): string =>
  e && e.code && GUARD_CODES.has(e.code) ? e.message : fallback;

const DAY = 86_400;
const dayPlus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);

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

/**
 * The table plus each ready line's booking argument (kept on the server — the run books from these).
 * `only` = plan just these lines (a run's chunk); pairing still sees every line.
 */
async function buildMonth(args: MonthArgs, only?: ReadonlySet<string>): Promise<{ lookup: MonthBatchLookup; plans: Map<string, SettlementPlan> }> {
  const plans = new Map<string, SettlementPlan>();
  const done = (lookup: MonthBatchLookup) => ({ lookup, plans });
  const { db, tenantId, accountId, month } = args;
  const win = monthWindow(month);

  /* Review: a settlement near a month edge can be wanted by a line of the next / previous month too —
     pair against every open line that could want one of this window's settlements (5 days either side),
     so "one settlement, two lines" fails closed across months; only this month's lines are shown. */
  const { data: rows, error } = await db
    .from("bank_transactions")
    .select("id, credit, txn_date, reference, description")
    .eq("tenant_id", tenantId)
    .eq("bank_account_id", accountId)
    .is("matched_to_type", null)
    .gt("credit", 0)
    .ilike("description", "%razorpay%")
    .gte("txn_date", dayPlus(win.first, -5))
    .lte("txn_date", dayPlus(win.last, 5))
    .order("txn_date", { ascending: true })
    .limit(MAX_LINES + 1);
  fail("bank lines", error);
  const all: BankLine[] = ((rows ?? []) as Array<BankLine & { description: string | null }>)
    .map((r) => ({ id: r.id, credit: Number(r.credit), txn_date: r.txn_date, reference: r.reference, description: r.description ?? "" }))
    .filter((l) => isRazorpaySettlementLine(l));
  if (all.length > MAX_LINES) {
    return done({ state: "error", message: `More than ${MAX_LINES} open Razorpay lines around ${month} — reconcile some one by one first.` });
  }
  const inMonth = (l: BankLine) => l.txn_date >= win.first && l.txn_date <= win.last;
  if (!all.some(inMonth)) return done({ state: "batch", batch: summarise(month, []) });

  const creds = await loadSettlementKeys(args.admin, tenantId, args.env);
  if (!creds) return done({ state: "no_keys", message: NO_KEYS_MESSAGE });
  const get = cachedGetter(razorpayGetter(creds, args.fetchImpl));

  let settlements: RzpSettlement[];
  try {
    settlements = await listSettlements(get, win.from - 5 * DAY, win.to + 5 * DAY);
  } catch (e) {
    if (e instanceof RazorpayApiError) return done({ state: "error", message: e.message });
    throw e;
  }

  /* Review: only the listed settlements are looked up (a company-wide list is cut at PostgREST's max rows). */
  const already = new Set<string>();
  const ids = settlements.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: recons, error: doneErr } = await (db as unknown as ReconsDb)
      .from("razorpay_settlement_recons")
      .select("settlement_id")
      .eq("tenant_id", tenantId)
      .in("settlement_id", ids.slice(i, i + 200));
    fail("settlements", doneErr);
    for (const r of (recons ?? []) as { settlement_id: string }[]) already.add(r.settlement_id);
  }

  const out: BatchRow[] = [];
  let razorpayDown: string | null = null;
  for (const p of pairMonth(all, settlements, already)) {
    if (!inMonth(p.line)) continue;
    const base: BatchRow = {
      txnId: p.line.id, txnDate: p.line.txn_date, amount: Number(p.line.credit) || 0, narration: p.line.description,
      settlementId: p.settlement?.id ?? null, utr: p.settlement?.utr ?? null, pairedBy: p.by,
      ready: false, blockers: p.problem ? [p.problem] : [], payments: 0, gross: 0, fee: 0, feeGst: 0,
    };
    if (!p.settlement || (only && !only.has(p.line.id))) { out.push(base); continue; }
    /* Review: once Razorpay stops answering, the rest are not asked again (no 429 storm, no 20 s timeouts each). */
    if (razorpayDown) { out.push({ ...base, blockers: [razorpayDown] }); continue; }
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
        razorpayDown = e.message;
        out.push({ ...base, blockers: [e.message] });
        continue;
      }
      throw e;
    }
  }
  return done({ state: "batch", batch: summarise(month, out) });
}

/* razorpay_settlement_recons (R-2099) is not in the generated table types yet. */
interface ReconsQuery { eq(c: string, v: string): ReconsQuery; in(c: string, v: string[]): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> }
interface ReconsDb { from(t: "razorpay_settlement_recons"): { select(cols: string): ReconsQuery } }

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
const rpcOf = (db: UserDb): Rpc => (db as unknown as { rpc: Rpc }).rpc.bind(db);

export interface RunResult {
  /** the run these lines were booked on — null when a new run booked nothing */
  runId: string | null;
  booked: Array<{ txnId: string; settlementId: string; amount: number; fee: number }>;
  refused: Array<{ txnId: string; message: string }>;
}

export async function runMonthBatch(args: MonthArgs & {
  /** the chunk of lines the owner saw as Ready (at most RUN_CHUNK are taken) */
  txnIds: string[];
  /** continue this run (the press's earlier chunks) — else a new run starts */
  runId?: string | null;
}): Promise<{ state: "done"; result: RunResult } | { state: "no_keys" | "error"; message: string }> {
  /* Re-planned here from Razorpay and the app's rows — the browser sends only the account, month and line ids. */
  const want = new Set(args.txnIds.slice(0, RUN_CHUNK));
  const { lookup, plans } = await buildMonth(args, want);
  if (lookup.state !== "batch") return lookup;
  const result: RunResult = { runId: args.runId ?? null, booked: [], refused: [] };
  const rows = lookup.batch.rows;
  for (const id of want) {
    if (plans.has(id)) continue;
    const r = rows.find((x) => x.txnId === id);
    result.refused.push({ txnId: id, message: r?.blockers[0] ?? "This line is no longer open — fetch the month again." });
  }
  const ready = rows.filter((r) => want.has(r.txnId) && plans.has(r.txnId));
  if (!ready.length) return { state: "done", result };

  const rpc = rpcOf(args.db);
  let started = false;
  if (!result.runId) {
    const { data: runId, error: startErr } = await rpc("razorpay_batch_run_start", { p_account_id: args.accountId });
    if (startErr) return { state: "error", message: userMessage(startErr, "Could not start the run — nothing was booked. Try again.") };
    result.runId = runId as string;
    started = true;
  }

  for (const r of ready) {
    const plan = plans.get(r.txnId) as SettlementPlan;
    const { data, error } = await rpc("reconcile_razorpay_settlement_in_run", { p_run_id: result.runId, p_txn_id: r.txnId, p_settlement: plan.rpcArg });
    if (error) {
      result.refused.push({ txnId: r.txnId, message: userMessage(error, "Could not reconcile this line — nothing was saved for it. Try again.") });
      continue;
    }
    const d = (data ?? {}) as { settlement_id?: string; fee?: number };
    result.booked.push({ txnId: r.txnId, settlementId: d.settlement_id ?? plan.settlement.id, amount: r.amount, fee: Number(d.fee) || 0 });
  }
  /* Review: a new run that booked nothing is not offered for Undo. */
  if (started && !result.booked.length) result.runId = null;
  return { state: "done", result };
}

export async function undoMonthRun(db: UserDb, runId: string): Promise<{ undone: number; left: Array<{ txn_id: string; txn_date: string; credit: number; reason: string }> }> {
  const { data, error } = await rpcOf(db)("undo_bank_recon_run", { p_run_id: runId });
  if (error) throw Object.assign(new Error(userMessage(error, "Could not undo the run — nothing was changed. Try again.")), { code: error.code, raw: error.message });
  const d = (data ?? {}) as { undone?: number; left?: Array<{ txn_id: string; txn_date: string; credit: number; reason: string }> };
  return { undone: Number(d.undone) || 0, left: d.left ?? [] };
}
