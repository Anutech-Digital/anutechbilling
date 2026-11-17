/* R-2855 — Status / Last bill showed "Loading…" for 8–10 s on staging (786 subscriptions, 16 Nov 2026).
   R-2765 made rounds 1–2 read 4 id chunks at a time; three reads still ran ONE chunk after another and each
   blocks the Status chip:
     - the renewal-quote facts (queue-data.ts useRenewalQuoteInfo) — ~1,570 quote ids = 8 requests in a row;
     - Last docs' round 3 (quote lines + credit / debit notes) — 16 requests in a row for the quote lines
       (100 ids a request); now 200 ids a request, 4 at a time;
     - round 1's "quotes by subscription" put the id list in the URL twice (one .or()), so only 60 ids fit a
       request = 14 requests, 4 at a time = 4 trips; as two plain .in() reads of 150 ids it is 2 trips.
   Measured with this file before the change: rounds 1–2 = 6 trips, round 3 = 16, quote facts = 8 (22 before
   the Status chip can show); after: 4 + 2, quote facts 2 (6).
   Counted here in "trips": every request in flight answers together, then the next batch starts — the number
   of trips is how many times the page waits on the network when the server answers a batch together. It is a
   floor, not a stopwatch: a browser on HTTP/1.1 sends 6 requests at a time to one host, and a busy database
   answers a batch more slowly — the real seconds are measured on staging after the train.
   Same rows as before in every case (the R-2765 tests still pass unchanged).
   R-2876 (16 Nov 2026): on the page these reads are now answered from ONE read (renewal_row_facts) — 786 subscriptions =
   1 trip for Status, Last bill AND Last paid, pinned in row-facts-r2876.test.ts. The numbers below are the FALLBACK's
   (function missing / not covered) and the drawer's, and must not go up either. */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let pending: (() => void)[] = [];
let requests = 0;
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const b = {
    select: () => b,
    in: (col: string, ids: unknown[]) => { const set = new Set(ids); filters.push((r) => set.has(r[col])); return b; },
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
    neq: (col: string, v: unknown) => { filters.push((r) => r[col] != null && r[col] !== v); return b; },
    or: (expr: string) => {
      const parts = [...expr.matchAll(/(\w+)\.in\.\(([^)]*)\)/g)].map((m) => ({ col: m[1], ids: new Set(m[2].split(",").map((x) => x.replace(/"/g, ""))) }));
      filters.push((r) => parts.some((p) => p.ids.has(String(r[p.col]))));
      return b;
    },
    order: () => b,
    range: (from: number, to: number) => new Promise<{ data: Row[]; error: null }>((resolve) => {
      requests += 1;
      pending.push(() => resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }));
    }),
  };
  return b;
}
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => builder(t) }) }));

import { readRenewalDocRows, docsFromRows, RENEWALS_READ_CONCURRENCY } from "./last-docs-data";
import { readRenewalQuoteInfo } from "./queue-data";

/** Run `work`; answer every request in flight together, again and again — returns how many trips it took. */
async function trips<T>(work: () => Promise<T>): Promise<{ value: T; trips: number }> {
  let done = false; let value!: T; let error: unknown;
  work().then((v) => { value = v; done = true; }, (e) => { error = e; done = true; });
  let n = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    if (done) break;
    if (pending.length === 0) continue;
    n += 1;
    const batch = pending; pending = [];
    for (const answer of batch) answer();
  }
  if (error) throw error;
  return { value, trips: n };
}

const N = 786;   // staging's subscription count on 16 Nov
const id = (p: string, i: number) => `${p}${String(i).padStart(4, "0")}`;
const SUBS = Array.from({ length: N }, (_, i) => ({
  id: id("s", i), quote_id: id("Q", i), renewal_quote_id: id("R", i), start_date: "2025-11-20", plan: "Workspace", domain: null, term_months: 12,
}));

beforeEach(() => {
  pending = []; requests = 0;
  tables.quotes = SUBS.flatMap((s, i) => [
    { id: s.quote_id, status: "accepted", payment_status: "received", created_at: "2025-11-01", created_date: "2025-11-01", invoice_id: id("I", i), renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, amount: 1180, currency: "INR" },
    { id: s.renewal_quote_id, status: "sent", payment_status: "none", created_at: "2026-11-01", created_date: "2026-11-01", invoice_id: null, renewal_subscription_id: s.id, add_seats_subscription_id: null, subscription_billing_id: null, amount: 1180, currency: "INR" },
  ]);
  tables.subscription_billings = [];
  tables.invoices = SUBS.map((s, i) => ({ id: id("I", i), quote_id: s.quote_id, invoice_date: "2025-11-02", status: "paid", amount: 1180, paid_amount: 1180, currency: "INR", created_at: "2025-11-02" }));
  tables.credit_notes = [];
  tables.debit_notes = [];
});

describe("R-2855 the Renewals reads behind Status / Last bill — trips to the server for 786 subscriptions", () => {
  it("rounds 1–2 (quotes, billing parts, invoices): 4 trips (was 6)", async () => {
    const { value, trips: n } = await trips(() => readRenewalDocRows(SUBS, { concurrency: RENEWALS_READ_CONCURRENCY }));
    /* the same rows as one .or() read gave: each subscription's renewal quote, once */
    expect(value.viaSub).toHaveLength(N);
    expect(new Set(value.viaSub.map((q) => q.id)).size).toBe(N);
    expect(value.own).toHaveLength(2 * N);
    expect(value.byQuote).toHaveLength(N);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("a quote linked BOTH ways (renewal + add seats) still comes back once, in id order", async () => {
    tables.quotes.push({ id: "ZBOTH", status: "sent", payment_status: "none", created_at: "2026-11-02", invoice_id: null, renewal_subscription_id: SUBS[0].id, add_seats_subscription_id: SUBS[1].id, subscription_billing_id: null });
    tables.quotes.push({ id: "ASEATS", status: "sent", payment_status: "none", created_at: "2026-11-02", invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: SUBS[2].id, subscription_billing_id: null });
    const { value } = await trips(() => readRenewalDocRows(SUBS.slice(0, 3), { concurrency: RENEWALS_READ_CONCURRENCY }));
    const ids = value.viaSub.map((q) => q.id);
    expect(ids.filter((x) => x === "ZBOTH")).toHaveLength(1);
    expect(ids).toContain("ASEATS");
    expect(ids).toEqual([...ids].sort());
  });

  it("round 3 (quote lines + credit / debit notes) reads its chunks side by side: 2 trips (was 16, one per chunk)", async () => {
    const docRows = (await trips(() => readRenewalDocRows(SUBS, { concurrency: RENEWALS_READ_CONCURRENCY }))).value;
    requests = 0;
    const { value, trips: n } = await trips(() => docsFromRows(SUBS, docRows, { concurrency: RENEWALS_READ_CONCURRENCY }));
    expect(value.size).toBe(N);
    expect(requests).toBeGreaterThan(RENEWALS_READ_CONCURRENCY);   // really more requests than fit one trip
    expect(n).toBeLessThanOrEqual(2);
  });

  it("the renewal-quote facts (Status waits for them): 1,572 quote ids in 2 trips (was 8)", async () => {
    const ids = SUBS.flatMap((s) => [s.renewal_quote_id, s.quote_id]);
    const { value, trips: n } = await trips(() => readRenewalQuoteInfo(ids));
    expect(value.size).toBe(2 * N);
    expect(n).toBeLessThanOrEqual(2);
  });
});
