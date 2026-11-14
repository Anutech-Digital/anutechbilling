/* R-2765 (R-2742 PERF-2): the Renewals page's reads.
   - fetchAllRowsIn reads id chunks 4 at a time (opt-in), rows in chunk order;
   - Last paid is worked out from Last docs' rounds 1–2 (ONE read of quotes / billings / invoices for both),
     with the same links as before: own quote, renewal quote, billing-part invoice, part proforma (R-2752),
     void invoices left out, refunds never "last paid";
   - the page's Last docs + Last paid share one rounds-1–2 read (one cache entry, joined in flight). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";

/* ── a fake PostgREST: from(table).select().in()/eq()/neq()/or().order().range() → rows ─────── */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const calls: string[] = [];
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const b = {
    select: () => b,
    in: (col: string, ids: unknown[]) => { filters.push((r) => ids.includes(r[col])); return b; },
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
    neq: (col: string, v: unknown) => { filters.push((r) => r[col] != null && r[col] !== v); return b; },   // SQL: NULL <> x is not true
    or: (expr: string) => {
      /* renewal_subscription_id.in.("a","b"),add_seats_subscription_id.in.("a","b") */
      const parts = [...expr.matchAll(/(\w+)\.in\.\(([^)]*)\)/g)].map((m) => ({ col: m[1], ids: m[2].split(",").map((x) => x.replace(/"/g, "")) }));
      filters.push((r) => parts.some((p) => p.ids.includes(String(r[p.col]))));
      return b;
    },
    order: () => b,
    range: (from: number, to: number) => {
      calls.push(table);
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(from, to + 1);
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return b;
}
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => builder(t) }) }));

import { readRenewalDocRows, fetchRenewalDocRows } from "./last-docs-data";
import { lastPaidFromDocRows, readRenewalLastPaid } from "./last-paid-data";

const S1 = "s1";
beforeEach(() => {
  calls.length = 0;
  tables.quotes = [
    { id: "Q1", status: "paid", invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, created_at: "2025-11-01" },
    { id: "QR", status: "sent", invoice_id: "INV2", renewal_subscription_id: S1, add_seats_subscription_id: null, subscription_billing_id: null, created_at: "2026-10-01" },
    { id: "QP", status: "sent", invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: "B1", created_at: "2026-08-01" },
  ];
  tables.subscription_billings = [{ id: "B1", subscription_id: S1, invoice_id: "INV3" }];
  tables.invoices = [
    { id: "INV1", quote_id: "Q1", status: "paid" },
    { id: "INVV", quote_id: "Q1", status: "void" },
    { id: "INV2", quote_id: "QR", status: "pending" },
    { id: "INV3", quote_id: null, status: "paid" },
  ];
  tables.subscriptions = [{ id: S1, quote_id: "Q1" }];
  tables.payments = [
    { id: "P1", amount: 1000, method: "upi", status: "received", received_at: "2025-11-05", refunded_at: null, quote_id: "Q1", invoice_id: null },
    { id: "P3", amount: 300, method: "bank_transfer", status: "received", received_at: "2026-08-05", refunded_at: null, quote_id: null, invoice_id: "INV3" },
    { id: "PP", amount: 250, method: "upi", status: "received", received_at: "2026-09-05", refunded_at: null, quote_id: "QP", invoice_id: null },
    { id: "PR", amount: 999, method: "upi", status: "refunded", received_at: "2026-10-05", refunded_at: "2026-10-06", quote_id: "QR", invoice_id: null },
    { id: "PV", amount: 77, method: "upi", status: "received", received_at: "2026-10-07", refunded_at: null, quote_id: null, invoice_id: "INVV" },
  ];
});

const ROWS = [{ id: S1, quote_id: "Q1", renewal_quote_id: "QR" }];

describe("R-2765 fetchAllRowsIn concurrency", () => {
  it("at most N chunks in flight; rows come back in chunk order", async () => {
    let inFlight = 0; let peak = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const out = await fetchAllRowsIn<string, string>(ids, async (run) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 * (3 - (Number(run[0].slice(2)) % 3))));   // later chunks may finish first
      inFlight--;
      return { data: run, error: null };
    }, { chunkSize: 1, concurrency: 4 });
    expect(out).toEqual(ids);
    expect(peak).toBe(4);
  });
  it("default stays one chunk at a time (every other caller unchanged)", async () => {
    let inFlight = 0; let peak = 0;
    await fetchAllRowsIn<string, string>(["a", "b", "c"], async (run) => {
      inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 2)); inFlight--;
      return { data: run, error: null };
    }, { chunkSize: 1 });
    expect(peak).toBe(1);
  });
});

describe("R-2765 Last paid from Last docs' rows", () => {
  it("same links as before: own quote, billing-part invoice, part proforma; refund and void-invoice payments left out", async () => {
    const docRows = await readRenewalDocRows(ROWS);
    const paid = await lastPaidFromDocRows(ROWS, docRows);
    const ids = paid.get(S1)!.history.map((h) => h.paymentId);
    expect(ids).toEqual(["PP", "P3", "P1"]);   // newest first
    expect(paid.get(S1)!.last.paymentId).toBe("PP");
    /* Last paid itself reads no quotes / invoices / billings again */
    calls.length = 0;
    await lastPaidFromDocRows(ROWS, docRows);
    expect(calls.filter((t) => t === "quotes" || t === "invoices" || t === "subscription_billings")).toEqual([]);
  });

  it("an own quote this person may not read (quotes RLS) still brings its payments and invoices — as the old read", async () => {
    tables.quotes = tables.quotes.filter((q) => q.id !== "Q1");   // RLS hides Q1; P1 (on Q1) and INV1 are visible
    tables.payments.push({ id: "PI1", amount: 50, method: "upi", status: "received", received_at: "2026-10-20", refunded_at: null, quote_id: null, invoice_id: "INV1" });
    const paid = await lastPaidFromDocRows(ROWS, await readRenewalDocRows(ROWS));
    expect(paid.get(S1)!.history.map((h) => h.paymentId)).toEqual(["PI1", "PP", "P3", "P1"].slice(0, 3));
    const all = await lastPaidFromDocRows(ROWS, await readRenewalDocRows(ROWS), { historySize: Infinity });
    expect(all.get(S1)!.history.map((h) => h.paymentId)).toEqual(["PI1", "PP", "P3", "P1"]);
  });

  it("an invoice with no status is left out, as PostgREST's neq('status','void') did", async () => {
    tables.invoices.push({ id: "INVN", quote_id: "Q1", status: null });
    tables.payments.push({ id: "PN", amount: 5, method: "upi", status: "received", received_at: "2026-11-01", refunded_at: null, quote_id: null, invoice_id: "INVN" });
    const paid = await lastPaidFromDocRows(ROWS, await readRenewalDocRows(ROWS), { historySize: Infinity });
    expect(paid.get(S1)!.history.map((h) => h.paymentId)).not.toContain("PN");
  });

  it("the drawer's one-subscription read gives the same answer", async () => {
    const paid = await readRenewalLastPaid(ROWS, { historySize: Infinity });
    expect(paid.get(S1)!.history.map((h) => h.paymentId)).toEqual(["PP", "P3", "P1"]);
  });

  it("Last docs + Last paid on the page share ONE rounds-1–2 read (joined while in flight)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const [a, b] = await Promise.all([fetchRenewalDocRows(qc, ROWS), fetchRenewalDocRows(qc, [...ROWS])]);
    expect(a).toBe(b);
    expect(calls.filter((t) => t === "subscription_billings")).toHaveLength(1);
  });
});
