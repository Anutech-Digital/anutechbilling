/**
 * R-2661 — day-calls-store.ts: the one-reader lease helpers (take / release / asZohoReader) and the
 * tenant meter's client. The admin client is a fake that records its RPCs; Zoho is never called.
 * Names and ids are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  asZohoReader, forgetTenantDayMeters, releaseZohoReader, takeZohoReader, tenantDayMeter, ZOHO_READER_HOLD_MS,
} from "./day-calls-store";
import { istDayOf } from "./zoho-day-budget";

type Call = [string, Record<string, unknown>];
function fakeDb(opts: { holder?: string | null; rpcError?: string; throwRpc?: boolean; row?: Record<string, unknown> | null } = {}) {
  const calls: Call[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const db = {
    calls, reads,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (opts.throwRpc) throw new Error("network down");
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      if (fn === "zoho_reader_take") return { data: opts.holder ?? null, error: null };
      if (fn === "zoho_reader_release") return { data: true, error: null };
      if (fn === "zoho_day_calls_add") return { data: [{ total: 41, hit_at: null }], error: null };
      return { data: null, error: null };
    },
    from: () => {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        limit: async () => { reads.push(filters); return { data: opts.row ? [opts.row] : [], error: null }; },
      };
      return q;
    },
  };
  return db;
}
type Db = Parameters<typeof takeZohoReader>[0];
const as = (d: unknown) => d as Db;
const T = Date.parse("2026-11-13T19:00:00Z");   /* 14 Nov 00:30 IST */

beforeEach(() => forgetTenantDayMeters());

describe("R-2661 one Zoho reader at a time — lease helpers", () => {
  it("take: asks for THIS tenant, the IST day and the name; null = ours, a name = who holds it", async () => {
    const free = fakeDb();
    expect(await takeZohoReader(as(free), "t1", "Reconcile from Zoho", T + 180_000, T)).toBeNull();
    expect(free.calls).toEqual([["zoho_reader_take", { p_tenant: "t1", p_day: "2026-11-14", p_name: "Reconcile from Zoho", p_until: new Date(T + 180_000).toISOString() }]]);
    const held = fakeDb({ holder: "FY 2025-26 sales from Zoho" });
    expect(await takeZohoReader(as(held), "t1", "Reconcile from Zoho", T + 180_000, T)).toBe("FY 2025-26 sales from Zoho");
  });

  it("a lease call that FAILS (DB hiccup, function not there yet) never blocks a read and never throws — it is logged; the day budget still bounds the read", async () => {
    const logs: string[] = [];
    expect(await takeZohoReader(as(fakeDb({ rpcError: "function zoho_reader_take does not exist" })), "t1", "x", T, T, (m) => logs.push(m))).toBeNull();
    expect(await takeZohoReader(as(fakeDb({ throwRpc: true })), "t1", "x", T, T, (m) => logs.push(m))).toBeNull();
    await expect(releaseZohoReader(as(fakeDb({ throwRpc: true })), "t1", "x", (m) => logs.push(m))).resolves.toBeUndefined();
    await expect(releaseZohoReader(as(fakeDb({ rpcError: "boom" })), "t1", "x", (m) => logs.push(m))).resolves.toBeUndefined();
    expect(logs).toHaveLength(4);
    expect(logs.join(" ")).not.toMatch(/token|secret/i);
  });

  it("asZohoReader: refused → run is never called and nothing is released (the lease is someone else's)", async () => {
    const db = fakeDb({ holder: "FY 2025-26 purchases from Zoho" });
    const run = vi.fn(async () => ({ value: 1, keep: false }));
    expect(await asZohoReader(as(db), "t1", "Reconcile from Zoho", run)).toEqual({ refused: "FY 2025-26 purchases from Zoho" });
    expect(run).not.toHaveBeenCalled();
    expect(db.calls.map(([fn]) => fn)).toEqual(["zoho_reader_take"]);
  });

  it("asZohoReader: keep → the lease stays for the next request (about ZOHO_READER_HOLD_MS); done → released; a THROW → released too, and the error still reaches the caller", async () => {
    const keep = fakeDb();
    const before = Date.now();
    expect(await asZohoReader(as(keep), "t1", "r", async () => ({ value: "go on", keep: true }))).toEqual({ value: "go on" });
    expect(keep.calls.map(([fn]) => fn)).toEqual(["zoho_reader_take"]);
    const until = Date.parse(String(keep.calls[0][1].p_until));
    expect(until - before).toBeGreaterThanOrEqual(ZOHO_READER_HOLD_MS - 5);
    expect(until - before).toBeLessThan(ZOHO_READER_HOLD_MS + 30_000);
    expect(keep.calls[0][1].p_day).toBe(istDayOf(before));

    const done = fakeDb();
    expect(await asZohoReader(as(done), "t1", "r", async () => ({ value: "done", keep: false }))).toEqual({ value: "done" });
    expect(done.calls).toEqual([["zoho_reader_take", expect.any(Object)], ["zoho_reader_release", { p_tenant: "t1", p_name: "r" }]]);

    const boom = fakeDb();
    await expect(asZohoReader(as(boom), "t1", "r", async () => { throw new Error("crash in the step"); })).rejects.toThrow("crash in the step");
    expect(boom.calls.map(([fn]) => fn)).toEqual(["zoho_reader_take", "zoho_reader_release"]);
  });
});

describe("R-2661 tenant meter — client and tenant", () => {
  it("one meter per tenant; it reads and writes through the LATEST caller's client (never one kept from an earlier request), always filtered by its own tenant", async () => {
    const first = fakeDb({ row: { day: "2026-11-14", calls: 40, limit_hit_at: null } });
    const second = fakeDb();
    const m1 = tenantDayMeter(as(first), "t1");
    expect((await m1.state(T)).calls).toBe(40);
    expect(first.reads).toEqual([{ tenant_id: "t1", day: "2026-11-14" }]);
    const again = tenantDayMeter(as(second), "t1");
    expect(again).toBe(m1);
    await again.note(T + 1, null);
    expect(first.calls).toEqual([]);                                   /* the old request's client is not used again */
    expect(second.calls).toEqual([["zoho_day_calls_add", { p_tenant: "t1", p_day: "2026-11-14", p_calls: 1, p_limit_hit: false, p_refusal: null }]]);
    expect((await again.state(T + 2)).calls).toBe(41);                  /* the RPC's total */
    /* Another tenant has its own meter and its own rows. */
    const other = fakeDb();
    const m2 = tenantDayMeter(as(other), "t2");
    expect(m2).not.toBe(m1);
    await m2.state(T);
    expect(other.reads).toEqual([{ tenant_id: "t2", day: "2026-11-14" }]);
  });
});
