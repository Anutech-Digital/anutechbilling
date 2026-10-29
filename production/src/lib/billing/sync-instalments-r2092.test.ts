/**
 * R-2092 — a quote with several subscriptions billed in parts gets ONE tax invoice per period.
 * The database groups the quote's parts of one period (billing_part_group, migration
 * 20261029034541; SQL test supabase/tests/r2092_quote_period_one_invoice.test.sql) — but only the
 * parts that EXIST when the first one is billed. So raise-instalments and the billing cron lay
 * every subscription's parts first, then bill. Staging (29 Oct): Starter and Standard of one quote
 * got two Q1 invoices, because the Starter's parts were laid AND billed before the Standard's
 * were laid.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { duePartInvoices, quoteSiblings, raiseDueInstalmentsForQuote } from "./sync-instalments.server";
import { requestSubscriptionIds } from "./part-request-chase.server";

type Row = Record<string, unknown>;

/** A tiny PostgREST stand-in that logs every insert and rpc, in order. */
function fakeDb(tables: Record<string, Row[]>) {
  const events: string[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let pendingInsert: Row[] | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return b; },
      in: (c: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      not: (c: string) => { rows = rows.filter((r) => r[c] != null); return b; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return b; },
      lte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) <= v); return b; },
      limit: () => b,
      order: () => b,
      update: () => b,
      insert: (xs: Row[]) => {
        pendingInsert = xs;
        for (const x of xs) {
          (tables[table] ??= []).push({ id: `${String(x.subscription_id)}-${String(x.period_index)}`, invoice_id: null, ...x });
          events.push(`insert:${String(x.subscription_id)}:${String(x.period_index)}`);
        }
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: (x: { data: Row[] | null; error: null }) => unknown) =>
        Promise.resolve({ data: pendingInsert ? null : rows, error: null }).then(res),
    };
    return b;
  };
  const rpc = (fn: string, args: Record<string, unknown>) => {
    events.push(`rpc:${fn}:${String(args.p_billing_id ?? args.p_subscription_id ?? "")}`);
    const data = fn === "bill_subscription_instalment" ? { action: "request_open", quote_id: "Q-1", status: "accepted", gross: 0 } : null;
    return Promise.resolve({ data, error: null });
  };
  return { db: { from, rpc } as never, events };
}

const TODAY = "2026-10-21";
const sub = (id: string, mrr: number) => ({
  id, tenant_id: "t1", quote_id: "Q-1", mrr, billing_cycle: "quarterly", term_months: 12,
  start_date: TODAY, renewal_date: "2027-10-21", status: "active",
  external_source: null, external_ref: null, billed_externally_until: null,
});

describe("raiseDueInstalmentsForQuote (R-2092)", () => {
  it("lays EVERY subscription's parts before billing any — so the quote's Q1 is one group", async () => {
    const { db, events } = fakeDb({
      quotes: [{ id: "Q-1", tenant_id: "t1", amount: 383972, payment_amount: 95993, invoice_id: null, subscription_billing_id: null }],
      subscriptions: [sub("s-starter", 15200), sub("s-standard", 11917)],
      invoices: [],
      subscription_billings: [],
    });
    await raiseDueInstalmentsForQuote({ supabase: db, quoteId: "Q-1", tenantId: "t1", todayISO: TODAY });
    const lastInsert = Math.max(...events.map((e, i) => (e.startsWith("insert:") ? i : -1)));
    const firstBill = events.findIndex((e) => e.startsWith("rpc:bill_subscription_instalment"));
    expect(events.some((e) => e.startsWith("insert:s-standard"))).toBe(true);
    expect(firstBill).toBeGreaterThan(-1);
    expect(lastInsert).toBeLessThan(firstBill);
  });
});

describe("quoteSiblings (R-2092)", () => {
  it("only subscriptions that share their quote (same company) with another", () => {
    const subs = [
      { id: "a", tenant_id: "t1", quote_id: "Q-1" },
      { id: "b", tenant_id: "t1", quote_id: "Q-1" },
      { id: "c", tenant_id: "t1", quote_id: "Q-2" },
      { id: "d", tenant_id: "t2", quote_id: "Q-1" },
      { id: "e", tenant_id: "t1", quote_id: null },
    ];
    expect(quoteSiblings(subs).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("duePartInvoices (R-2092)", () => {
  it("two subscriptions' Q1 on ONE invoice → reported once", async () => {
    const { db } = fakeDb({
      subscription_billings: [
        { id: "b1", subscription_id: "s1", period_index: 1, period_start: "2026-10-21", period_end: "2027-01-21", bill_on: "2026-10-21", invoice_id: "INV-4" },
        { id: "b2", subscription_id: "s2", period_index: 1, period_start: "2026-10-21", period_end: "2027-01-21", bill_on: "2026-10-21", invoice_id: "INV-4" },
      ],
      subscriptions: [{ id: "s1", billing_cycle: "quarterly" }, { id: "s2", billing_cycle: "quarterly" }],
      invoices: [{ id: "INV-4", amount: 95993 }],
    });
    const out = await duePartInvoices(db, { subscriptionIds: ["s1", "s2"], todayISO: "2026-10-28", raisedNow: new Set(["INV-4"]) });
    expect(out.map((x) => [x.invoice_id, x.gross, x.part])).toEqual([["INV-4", 95993, "Q1"]]);
  });
});

describe("requestSubscriptionIds (R-2092)", () => {
  it("a request naming two parts → both subscriptions (the pause covers both)", async () => {
    const { db } = fakeDb({
      subscription_billings: [
        { id: "b1", tenant_id: "t1", subscription_id: "s1" },
        { id: "b2", tenant_id: "t1", subscription_id: "s2" },
        { id: "bx", tenant_id: "t2", subscription_id: "sx" },
      ],
    });
    const ids = await requestSubscriptionIds(db, { tenant_id: "t1", line_items: [{ billing_id: "b1" }, { billing_id: "b2" }, { billing_id: "bx" }] }, "s1");
    expect(ids.sort()).toEqual(["s1", "s2"]);
  });

  it("an older one-subscription request → its own subscription only, no read", async () => {
    const { db, events } = fakeDb({});
    expect(await requestSubscriptionIds(db, { tenant_id: "t1", line_items: [{ name: "Advance payment for Q2" }] }, "s1")).toEqual(["s1"]);
    expect(events).toEqual([]);
  });
});

describe("billing cron wiring (R-2092)", () => {
  it("lays the quote siblings' parts before the per-subscription billing loop", () => {
    const src = readFileSync(path.join(__dirname, "../../app/api/cron/billing/route.ts"), "utf8");
    const lay = src.indexOf("await layInstalments(");
    const loop = src.indexOf("syncSubscriptionInstalments({ supabase, sub, quote, todayISO: today, dryRun })");
    expect(lay).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(lay);
    expect(src).toContain("quoteSiblings(");
  });
});
