/**
 * R-2654 — the Razorpay month batch end to end with Razorpay's HTTP MOCKED (never a real key):
 * 3 settlements, one carrying a payment the app does not have → 2 ready, 1 blocked (with its pay_ id);
 * "Reconcile all ready" books the 2 under ONE run with the server's own numbers; the settlements list is
 * read once and a shared recon day once; a second run after booking books nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (row: unknown) => row }));

import { loadMonthBatch, runMonthBatch, undoMonthRun, cachedGetter } from "./settlement-batch.server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>, rpcError: null as null | { message: string; code?: string } }));

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {};
      const chain = (fn?: (r: Row) => boolean) => { if (fn) filters.push(fn); return b; };
      b.select = () => chain();
      b.eq = (c: string, v: unknown) => chain((r) => r[c] === v);
      b.in = (c: string, vs: unknown[]) => chain((r) => vs.includes(r[c]));
      b.is = (c: string, v: unknown) => chain((r) => (r[c] ?? null) === v);
      b.gt = (c: string, v: number) => chain((r) => Number(r[c]) > v);
      b.gte = (c: string, v: string) => chain((r) => String(r[c]) >= v);
      b.lte = (c: string, v: string) => chain((r) => String(r[c]) <= v);
      b.ilike = (c: string, pat: string) => chain((r) => String(r[c] ?? "").toLowerCase().includes(pat.replace(/%/g, "").toLowerCase()));
      b.order = () => chain();
      b.limit = () => chain();
      const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok);
      return b;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      db.rpc.push({ fn, args });
      if (db.rpcError && fn === "reconcile_razorpay_settlement_in_run") return { data: null, error: db.rpcError };
      if (fn === "razorpay_batch_run_start") return { data: "99999999-0000-4000-8000-000000000001", error: null };
      if (fn === "reconcile_razorpay_settlement_in_run") {
        /* booking matches the line (what the database does) */
        const line = db.tables.bank_transactions.find((l) => l.id === args.p_txn_id);
        if (line) line.matched_to_type = "payment";
        const s = args.p_settlement as { id: string; fee_paise: number };
        return { data: { settlement_id: s.id, fee: Math.round(s.fee_paise / 100), run_id: args.p_run_id }, error: null };
      }
      if (fn === "undo_bank_recon_run") return { data: { run_id: args.p_run_id, undone: 2, left: [] }, error: null };
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  } as never;
}

const T = "tenant-1";
const ACC = "acc-1";
const NARR = "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-";
const line = (id: string, day: string, credit: number, utr: string) =>
  ({ id, tenant_id: T, bank_account_id: ACC, credit, txn_date: day, reference: null, matched_to_type: null, description: NARR + utr });
const pay = (id: string, ref: string, amount: number) => ({
  id, tenant_id: T, reference: ref, amount, credit_applied: 0, status: "received", received_at: "2025-10-02T10:00:00Z",
  quote_id: `Q-${id}`, customer_id: "c1", bank_txn_id: null,
});
const at = (day: string) => Date.parse(`${day}T10:00:00+05:30`) / 1000;
/* Each settlement: one payment of gross g paise with fee f (GST t). */
const setl = (id: string, day: string, g: number, f: number, t: number, utr: string) =>
  ({ id, entity: "settlement", amount: g - f, fees: f, tax: t, utr, status: "processed", created_at: at(day) });
const recon = (setlId: string, pay_: string, g: number, f: number, t: number) =>
  ({ entity_id: pay_, type: "payment", amount: g, credit: g - f, debit: 0, fee: f, tax: t, settlement_id: setlId, order_id: null, created_at: at("2025-10-02") });

const SETTLEMENTS = [
  setl("setl_A", "2025-10-03", 118000, 2360, 360, "UTRA00000001"),
  setl("setl_B", "2025-10-03", 236000, 4720, 720, "UTRB00000002"),
  setl("setl_C", "2025-10-08", 590000, 11800, 1800, "UTRC00000003"),
];
const RECON = [
  recon("setl_A", "pay_A1", 118000, 2360, 360),
  recon("setl_B", "pay_B1", 236000, 4720, 720),
  recon("setl_C", "pay_UNKNOWN", 590000, 11800, 1800),
];

let calls: string[] = [];
function razorpay(): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/v1/settlements") return Response.json({ entity: "collection", items: SETTLEMENTS });
    if (u.pathname === "/v1/settlements/recon/combined") {
      const day = `${u.searchParams.get("year")}-${String(u.searchParams.get("month")).padStart(2, "0")}-${String(u.searchParams.get("day")).padStart(2, "0")}`;
      const items = Number(u.searchParams.get("skip")) === 0 ? RECON.filter((r) => {
        const s = SETTLEMENTS.find((x) => x.id === r.settlement_id);
        return s && new Date((s.created_at + 5.5 * 3600) * 1000).toISOString().slice(0, 10) === day;
      }) : [];
      return Response.json({ entity: "collection", items });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  db.rpc = [];
  db.rpcError = null;
  db.tables = {
    bank_transactions: [
      line("L1", "2025-10-03", 1156, "UTRA00000001"),
      line("L2", "2025-10-04", 2313, "UTRB00000002"),
      line("L3", "2025-10-08", 5782, "UTRC00000003"),
      { ...line("LX", "2025-10-09", 999, "x"), description: "NEFT CR SOMEONE ELSE" },
    ],
    tenant_secrets: [{ tenant_id: T, razorpay_key_id: "rzp_test_abc123", razorpay_key_secret: "secret_xyz_123" }],
    payments: [pay("a1", "pay_A1", 1180), pay("b1", "pay_B1", 2360)],
    customers: [{ id: "c1", tenant_id: T, name: "Acme" }],
    quotes: [],
    razorpay_settlement_recons: [],
  };
});

const args = (extra: Record<string, unknown> = {}) => ({
  db: fakeClient(), admin: fakeClient(), tenantId: T, accountId: ACC, month: "2025-10", fetchImpl: razorpay(), env: {}, ...extra,
});

describe("R-2654 loadMonthBatch", () => {
  it("3 settlements, 1 unknown payment → 2 ready, 1 blocked naming the pay_ id; nothing booked", async () => {
    const r = await loadMonthBatch(args());
    if (r.state !== "batch") throw new Error(JSON.stringify(r));
    expect(r.batch.rows.map((x) => [x.txnId, x.settlementId, x.pairedBy, x.ready])).toEqual([
      ["L1", "setl_A", "utr", true],
      ["L2", "setl_B", "utr", true],
      ["L3", "setl_C", "utr", false],
    ]);
    expect(r.batch).toMatchObject({ ready: 2, blocked: 1, readyAmount: 1156 + 2313 });
    expect(r.batch.rows[2].blockers.join(" ")).toMatch(/pay_UNKNOWN .* is not in the app/);
    expect(r.batch.rows[0]).toMatchObject({ payments: 1, gross: 1180, fee: 24, feeGst: 4 });
    expect(db.rpc).toEqual([]);
  });

  it("reads the settlements list ONCE and a shared recon day once (setl_A and setl_B are the same day)", async () => {
    await loadMonthBatch(args());
    expect(calls.filter((c) => c.includes("/v1/settlements?")).length).toBe(1);
    const reconCalls = calls.filter((c) => c.includes("/recon/combined"));
    expect(new Set(reconCalls).size).toBe(reconCalls.length);
  });

  it("no keys → asks for the key, Razorpay never called", async () => {
    db.tables.tenant_secrets = [];
    const r = await loadMonthBatch(args());
    expect(r.state).toBe("no_keys");
    expect(calls).toEqual([]);
  });

  it("a month with no open Razorpay line → empty table, Razorpay never called", async () => {
    const r = await loadMonthBatch(args({ month: "2025-11" }));
    expect(r).toEqual({ state: "batch", batch: { month: "2025-11", rows: [], ready: 0, blocked: 0, readyAmount: 0 } });
    expect(calls).toEqual([]);
  });
});

describe("R-2654 runMonthBatch — Reconcile all ready", () => {
  it("books the 2 ready lines under ONE run with the server's own numbers; the blocked one is not sent", async () => {
    const r = await runMonthBatch(args());
    if (r.state !== "done") throw new Error(JSON.stringify(r));
    expect(r.result).toMatchObject({ runId: "99999999-0000-4000-8000-000000000001", blocked: 1, refused: [] });
    expect(r.result.booked.map((b) => [b.txnId, b.settlementId, b.fee])).toEqual([["L1", "setl_A", 24], ["L2", "setl_B", 47]]);
    expect(db.rpc.map((c) => c.fn)).toEqual(["razorpay_batch_run_start", "reconcile_razorpay_settlement_in_run", "reconcile_razorpay_settlement_in_run"]);
    const arg = db.rpc[1].args.p_settlement as { id: string; fee_paise: number; payments: Array<{ rzp_id: string; amount_paise: number; payment_ids: string[] }> };
    expect(arg).toMatchObject({ id: "setl_A", fee_paise: 2360, payments: [{ rzp_id: "pay_A1", amount_paise: 118000, payment_ids: ["a1"] }] });
  });

  it("only the lines the owner saw (txnIds) are booked", async () => {
    const r = await runMonthBatch(args({ txnIds: ["L2"] }));
    if (r.state !== "done") throw new Error("not done");
    expect(r.result.booked.map((b) => b.txnId)).toEqual(["L2"]);
  });

  it("second press after booking: lines are reconciled now → nothing ready, no run started", async () => {
    await runMonthBatch(args());
    db.rpc = [];
    const r = await runMonthBatch(args());
    if (r.state !== "done") throw new Error("not done");
    expect(r.result).toMatchObject({ runId: null, booked: [], blocked: 1 });
    expect(db.rpc).toEqual([]);
  });

  it("a line the database refuses comes back with its message; the others still book", async () => {
    db.rpcError = { message: "This bank line is already reconciled (payment).", code: "23514" };
    const r = await runMonthBatch(args());
    if (r.state !== "done") throw new Error("not done");
    expect(r.result.booked).toEqual([]);
    expect(r.result.refused).toEqual([
      { txnId: "L1", message: "This bank line is already reconciled (payment)." },
      { txnId: "L2", message: "This bank line is already reconciled (payment)." },
    ]);
  });

  it("no keys → nothing started", async () => {
    db.tables.tenant_secrets = [];
    const r = await runMonthBatch(args());
    expect(r.state).toBe("no_keys");
    expect(db.rpc).toEqual([]);
  });
});

describe("R-2654 undoMonthRun + cachedGetter", () => {
  it("undo calls undo_bank_recon_run with the run id", async () => {
    const r = await undoMonthRun(fakeClient(), "99999999-0000-4000-8000-000000000001");
    expect(r).toEqual({ undone: 2, left: [] });
    expect(db.rpc).toEqual([{ fn: "undo_bank_recon_run", args: { p_run_id: "99999999-0000-4000-8000-000000000001" } }]);
  });
  it("the same GET twice goes out once; a failed GET is not cached", async () => {
    let n = 0;
    const get = cachedGetter(async () => { n++; if (n === 1) throw new Error("x"); return { ok: n }; });
    await expect(get("/p", { a: 1 })).rejects.toThrow("x");
    expect(await get("/p", { a: 1 })).toEqual({ ok: 2 });
    expect(await get("/p", { a: 1 })).toEqual({ ok: 2 });
    expect(n).toBe(2);
  });
});
