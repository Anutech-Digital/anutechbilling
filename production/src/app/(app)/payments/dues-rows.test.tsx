// @vitest-environment jsdom
/* R-1701 — Payments → Subscription dues: Paid, Age and the quote on a row are THAT
   subscription's, not the customer's.

   The owner's record (20 Oct, staging): one customer, two subscriptions owing ₹14,406 and
   ₹8,424; the customer had received ₹2,46,564 in all, the first of it on 8 May. Both rows read
   "Paid ₹2,46,564" and "166d", and both opened the ₹8,424 quote. The supabase client below is
   an in-memory fake that answers every read the hook makes (filters applied, pages sliced). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Row = Record<string, unknown>;
let db: Record<string, Row[]> = {};

function fakeQuery(table: string) {
  let rows = [...(db[table] ?? [])];
  let range: [number, number] | null = null;
  const q = {
    select: () => q,
    gt: (c: string, v: number) => { rows = rows.filter((r) => (r[c] as number) > v); return q; },
    is: (c: string, v: null) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q; },
    eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
    not: (c: string, op: string, v: null) => { if (op === "is") rows = rows.filter((r) => (r[c] ?? null) !== v); return q; },
    order: (c: string) => { rows.sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? ""))); return q; },
    range: (from: number, to: number) => { range = [from, to]; return q; },
    then: (ok: (v: { data: Row[]; error: null }) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }).then(ok, bad),
  };
  return q;
}

/* R-1718: quote_open_balances() answered from db.open_balances (absent = the read fails). */
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (t: string) => fakeQuery(t),
    rpc: (fn: string) => {
      if (fn !== "quote_open_balances" || !db.open_balances) {
        return { order: () => ({ range: () => Promise.resolve({ data: null, error: { message: `no function ${fn}` } }) }) };
      }
      return fakeQuery("open_balances");
    },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { useOutstandingReceivables, type OutstandingRow } from "@/lib/queries/payments";

const CUST = "c-1";
const sub = (o: Row): Row => ({
  customer_id: CUST, customer_name: "Two Subs Pvt Ltd", plan: "Google Workspace", status: "active",
  last_reminder_at: null, written_off_at: null, payment_due_date: null, renewal_quote_id: null, ...o,
});

function ownerRecord() {
  db = {
    subscriptions: [
      /* Started 10 Oct, no invoice yet: owes ₹14,406 on its own quote Q-A. */
      sub({ id: "s-new", plan: "Business Starter", outstanding_amount: 14406, quote_id: "Q-A", start_date: "2026-10-10", created_at: "2026-10-10T06:00:00Z" }),
      /* The older one: invoice due 30 Sep, ₹8,424 still owed on Q-B. */
      sub({ id: "s-old", plan: "Business Standard", outstanding_amount: 8424, quote_id: "Q-B", start_date: "2026-05-08", created_at: "2026-05-08T06:00:00Z" }),
    ],
    quotes: [
      { id: "Q-A", customer_id: CUST, amount: 28812, payment_status: "partial", customer_name: "Two Subs Pvt Ltd" },
      { id: "Q-B", customer_id: CUST, amount: 240582, payment_status: "invoiced", customer_name: "Two Subs Pvt Ltd" },
    ],
    payments: [
      /* ₹2,32,158 + ₹14,406 = ₹2,46,564 received from the customer in all; first on 8 May. */
      { id: "p1", quote_id: "Q-B", customer_id: CUST, amount: 232158, status: "received", received_at: "2026-05-08T05:00:00Z" },
      { id: "p2", quote_id: "Q-A", customer_id: CUST, amount: 14406, status: "received", received_at: "2026-10-10T05:00:00Z" },
      /* Refunded money is not "paid". */
      { id: "p3", quote_id: "Q-A", customer_id: CUST, amount: 5000, status: "refunded", received_at: "2026-10-11T05:00:00Z" },
    ],
    invoices: [
      { id: "INV-B", quote_id: "Q-B", invoice_date: "2026-09-15", due_date: "2026-09-30", status: "pending", amount: 240582, net_payable: 240582, paid_amount: 232158 },
      /* Paid long ago — must not set the age. */
      { id: "INV-OLD", quote_id: "Q-B", invoice_date: "2026-01-01", due_date: "2026-01-15", status: "paid", amount: 1000, net_payable: 1000, paid_amount: 1000 },
    ],
    subscription_billings: [],
  };
}

async function readRows(): Promise<OutstandingRow[]> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useOutstandingReceivables(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
  if (result.current.isError) throw result.current.error;
  return result.current.data!;
}

beforeEach(() => {
  /* 20 Oct 20:00 UTC is already 21 Oct 01:30 in India — "today" is the IST day. */
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T20:00:00Z"));
  ownerRecord();
});
afterEach(() => vi.useRealTimers());

describe("R-1701 subscription dues rows are per subscription", () => {
  it("two subscriptions of one customer: their own Paid, their own quote, their own age", async () => {
    const rows = await readRows();
    const byId = new Map(rows.map((r) => [r.subscription_id, r]));
    const fresh = byId.get("s-new")!;
    const old = byId.get("s-old")!;

    expect(fresh.paid_amount).toBe(14406);
    expect(old.paid_amount).toBe(232158);
    expect(fresh.paid_amount).not.toBe(246564);

    expect(fresh.quote_id).toBe("Q-A");
    expect(old.quote_id).toBe("Q-B");
    expect(fresh.total_quote_amount).toBe(28812);

    /* Started 10 Oct, no invoice: 11 days in IST (not 166 from the customer's first payment). */
    expect(fresh.days_outstanding).toBe(11);
    expect(fresh.age_from).toBe("2026-10-10");
    /* Oldest UNPAID invoice fell due 30 Sep → 21 days; the paid January invoice is ignored. */
    expect(old.days_outstanding).toBe(21);
    expect(old.age_from).toBe("2026-09-30");
    expect(fresh.started_at.slice(0, 10)).toBe("2026-10-10");
  });

  it("an open renewal quote is the row's quote once its own quote is paid, and an instalment invoice sets the age", async () => {
    /* R-1718: while its own quote still owes, the row records there (see below). */
    db.quotes[1] = { ...db.quotes[1], payment_status: "received" };
    db.subscriptions[1] = { ...db.subscriptions[1], renewal_quote_id: "Q-R" };
    db.quotes.push({ id: "Q-R", customer_id: CUST, amount: 9000, payment_status: "pending" });
    db.subscription_billings.push({ id: "b1", subscription_id: "s-new", invoice_id: "INV-I1" });
    db.invoices.push({ id: "INV-I1", quote_id: null, invoice_date: "2026-10-12", due_date: "2026-10-15", status: "overdue", amount: 7203, net_payable: 7203, paid_amount: 0 });
    const rows = await readRows();
    const byId = new Map(rows.map((r) => [r.subscription_id, r]));
    expect(byId.get("s-old")!.quote_id).toBe("Q-R");
    expect(byId.get("s-old")!.paid_amount).toBe(0);
    expect(byId.get("s-new")!.days_outstanding).toBe(6);
  });

  it("age is never negative (agreed due date still ahead)", async () => {
    db.subscriptions[0] = { ...db.subscriptions[0], payment_due_date: "2026-11-05", start_date: "2026-10-25" };
    const rows = await readRows();
    const fresh = rows.find((r) => r.subscription_id === "s-new")!;
    expect(fresh.days_outstanding).toBe(0);
    expect(fresh.age_from).toBe("2026-11-05");
  });

  it("no open quote of its own → no quote on the row (never another subscription's)", async () => {
    db.subscriptions[0] = { ...db.subscriptions[0], quote_id: null };
    const rows = await readRows();
    const fresh = rows.find((r) => r.subscription_id === "s-new")!;
    expect(fresh.quote_id).toBeNull();
    expect(fresh.paid_amount).toBe(0);
  });
});

describe("R-1718 Balance due and Record payment read the same quote", () => {
  /* The local record (21 Oct): R818 Test Co — R818 Second License. Balance due ₹1,180 is its
     own accepted quote Q-F588-27-0012 (₹1,180, nothing paid). Its renewal link points at a
     1-year EXTENSION quote Q-F588-27-0015 (₹1,175, only `sent` — an offer, not owed). The row
     opened the extension quote, so the dialog said "Quote total / Expected ₹1,175" under a
     ₹1,180 balance — and ₹1,180 recorded there would pay the offer and leave the debt. */
  function r818() {
    db = {
      subscriptions: [sub({
        id: "s-818", customer_name: "R818 Test Co", plan: "R818 Second License", outstanding_amount: 1180,
        quote_id: "Q-F588-27-0012", renewal_quote_id: "Q-F588-27-0015",
        start_date: "2026-10-10", created_at: "2026-10-10T06:00:00Z",
      })],
      quotes: [
        { id: "Q-F588-27-0012", amount: 1180, status: "accepted", payment_status: "awaiting", invoice_id: null, superseded_by: null },
        { id: "Q-F588-27-0015", amount: 1175, status: "sent", payment_status: "awaiting", invoice_id: null, superseded_by: null },
      ],
      payments: [], invoices: [], subscription_billings: [],
      open_balances: [
        { quote_id: "Q-F588-27-0012", open_balance: 1180 },
        { quote_id: "Q-F588-27-0015", open_balance: 1175 },
      ],
    };
  }

  it("the row's quote is the one the balance is owed on — ₹1,180 both places", async () => {
    r818();
    const [row] = await readRows();
    expect(row.quote_id).toBe("Q-F588-27-0012");
    expect(row.total_quote_amount).toBe(row.outstanding_amount);
  });

  it("once the own quote is settled (open balance 0, e.g. a credit note), the renewal/extension quote is next", async () => {
    r818();
    db.open_balances = [{ quote_id: "Q-F588-27-0012", open_balance: 0 }, { quote_id: "Q-F588-27-0015", open_balance: 1175 }];
    const [row] = await readRows();
    expect(row.quote_id).toBe("Q-F588-27-0015");
  });

  it("an ACCEPTED renewal quote still waits behind the older debt on the own quote (oldest bill first)", async () => {
    r818();
    db.quotes[1] = { ...db.quotes[1], status: "accepted" };
    const [row] = await readRows();
    expect(row.quote_id).toBe("Q-F588-27-0012");
  });

  it("without the open-balance read it falls back to amount − received, never to 'nothing owed'", async () => {
    r818();
    delete db.open_balances;
    const [row] = await readRows();
    expect(row.quote_id).toBe("Q-F588-27-0012");
  });
});

describe("R-1701 Record payment sheet: the amount comes before the domain", () => {
  it("'Customer domain (optional)' sits below 'Amount received'", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
    const amount = src.indexOf('htmlFor="amount"');
    const domain = src.indexOf('label="Customer domain (optional)"');
    expect(amount).toBeGreaterThan(-1);
    expect(domain).toBeGreaterThan(amount);
  });
});
