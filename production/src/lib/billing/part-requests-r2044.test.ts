/**
 * R-2044 (28 Oct 2026, Pardeep) — a subscription billed in parts gets a PAYMENT REQUEST for each
 * part on its date, never an unpaid tax invoice. The owner's case: Annual commitment, Quarterly
 * payment; on the 2nd quarter's date the billing cron makes a quote "part 2" and NO invoice.
 * The money side (request once, paid → one invoice, Customer stopped → nothing owed) is proven
 * on the database in supabase/tests/r2044_part_payment_requests.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncSubscriptionInstalments, type InstalmentSub } from "./sync-instalments.server";
import { plannedInstalments } from "./instalments";
import {
  applyBillOutcome, billingCronDay, requestPauseDue, requestReminderStep, requestReminderText,
} from "./part-requests";

/* ── a tiny Supabase double: every chain resolves to the table's rows; rpc answers by name ── */
function fakeDb(tables: Record<string, unknown[]>, rpc: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: { rpc: Array<[string, Record<string, unknown>]>; writes: string[] } = { rpc: [], writes: [] };
  const chain = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "range", "limit", "neq"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
    c.insert = () => { calls.writes.push(`insert ${table}`); return Promise.resolve({ error: null }); };
    c.update = () => { calls.writes.push(`update ${table}`); return c; };
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
    return c;
  };
  const db = {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push([fn, args]);
      return { data: rpc(fn, args), error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

/* Annual commitment billed quarterly: ₹2,000 a month → ₹6,000 a quarter. Term from 1 Aug 2026. */
const sub: InstalmentSub = {
  id: "sub-q", tenant_id: "t1", quote_id: "Q-SALE", mrr: 2000, billing_cycle: "quarterly", term_months: 12,
  start_date: "2026-08-01", renewal_date: "2027-07-31",
};
const plan = plannedInstalments(sub);
const rows = plan.map((p) => ({
  id: `b${p.periodIndex}`, period_index: p.periodIndex, bill_on: p.billOn, term_start: p.termStart,
  taxable_amount: p.taxableAmount,
  invoice_id: p.periodIndex === 1 ? "INV-Q1" : null,   // Q1 was invoiced when the sale was paid
}));
const q2 = plan[1];

describe("R-2044 — the 2nd quarter's date: a payment request, not a tax invoice", () => {
  it("the cron asks bill_subscription_instalment for the due part and never raises the invoice itself", async () => {
    const { db, calls } = fakeDb({ subscription_billings: rows }, (fn) =>
      fn === "bill_subscription_instalment" ? { action: "request", quote_id: "Q-PART-2", created: true, gross: 7080 } : 0);
    const r = await syncSubscriptionInstalments({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: db as any, sub, quote: { amount: 28320, payment_amount: 7080, invoiced: false }, todayISO: q2.billOn,
    });
    expect(calls.rpc.map(([fn]) => fn)).not.toContain("raise_subscription_billing");
    expect(calls.rpc.filter(([fn]) => fn === "bill_subscription_instalment"))
      .toEqual([["bill_subscription_instalment", { p_billing_id: "b2", p_dry_run: false }]]);
    expect(r.raised).toEqual([]);
    expect(r.requests).toEqual([{ period_index: 2, quote_id: "Q-PART-2", gross: 7080 }]);
  });

  it("dry run (?dry=1&on=) only asks; nothing is inserted", async () => {
    const { db, calls } = fakeDb({ subscription_billings: rows }, () => ({ action: "request", gross: 7080, dry_run: true }));
    const r = await syncSubscriptionInstalments({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: db as any, sub, quote: { amount: 28320, payment_amount: 7080, invoiced: false }, todayISO: q2.billOn, dryRun: true,
    });
    expect(calls.rpc).toEqual([["bill_subscription_instalment", { p_billing_id: "b2", p_dry_run: true }]]);
    expect(calls.writes).toEqual([]);
    expect(r.wouldRequest).toBe(1);
    expect(r.requests).toEqual([]);
  });

  it("before the 2nd quarter's date nothing is asked", async () => {
    const { db, calls } = fakeDb({ subscription_billings: rows }, () => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await syncSubscriptionInstalments({ supabase: db as any, sub, quote: undefined, todayISO: "2026-10-31" });
    expect(calls.rpc.filter(([fn]) => fn === "bill_subscription_instalment")).toEqual([]);
  });

  it("yearly is unchanged: skipped before any database call", async () => {
    const noDb = new Proxy({}, { get() { throw new Error("database touched"); } });
    const r = await syncSubscriptionInstalments({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: noDb as any, sub: { ...sub, billing_cycle: "yearly" }, quote: undefined, todayISO: q2.billOn,
    });
    expect(r.skip?.code).toBe("not_split_billed");
  });
});

describe("R-2044 — what the database's answer means for the run", () => {
  const empty = () => ({ raised: [], alreadyRaised: 0, wouldRaise: 0, requests: [], requestsOpen: [], wouldRequest: 0 });
  it("a paid part is an invoice; an unpaid one a request; one waiting is counted, not re-made", () => {
    const t = empty();
    applyBillOutcome(t, 1, { action: "invoice", invoice_id: "INV-1", gross: 7080, already_raised: false }, false);
    applyBillOutcome(t, 2, { action: "request", quote_id: "Q-2", gross: 7080, created: true }, false);
    applyBillOutcome(t, 3, { action: "request_open", quote_id: "Q-3", status: "sent", gross: 7080 }, false);
    applyBillOutcome(t, 4, { action: "already_invoiced", invoice_id: "INV-4" }, false);
    expect(t.raised).toEqual([{ period_index: 1, invoice_id: "INV-1", gross: 7080 }]);
    expect(t.requests).toEqual([{ period_index: 2, quote_id: "Q-2", gross: 7080 }]);
    expect(t.requestsOpen).toEqual([{ period_index: 3, quote_id: "Q-3", status: "sent" }]);
    expect(t.alreadyRaised).toBe(1);
  });
  it("an empty or unknown answer is an error, never a silent 0", () => {
    expect(() => applyBillOutcome(empty(), 2, null, false)).toThrow(/returned nothing/);
    expect(() => applyBillOutcome(empty(), 2, { action: "maybe" }, false)).toThrow(/answered "maybe"/);
  });
});

describe("R-2044 — chasing an unpaid request (the invoice-dunning ladder)", () => {
  const base = { dueOn: "2026-11-01", open: true, amountDue: 7080 };
  it("Day 1 reminder, then Day 3, never the same step twice", () => {
    expect(requestReminderStep({ ...base, todayISO: "2026-11-01", lastStep: "request_sent" })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-02", lastStep: "request_sent" })).toBe("reminder");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-02", lastStep: "reminder" })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-04", lastStep: "reminder" })).toBe("retry");
    expect(requestReminderStep({ ...base, todayISO: "2026-11-15", lastStep: "grace_warning" })).toBe("final");
  });
  it("a paid or stopped request is not chased", () => {
    expect(requestReminderStep({ ...base, todayISO: "2026-11-05", lastStep: null, amountDue: 0 })).toBeNull();
    expect(requestReminderStep({ ...base, todayISO: "2026-11-05", lastStep: null, open: false })).toBeNull();
  });
  it("pause only when the company switched it on, after the final reminder + 3 days' notice", () => {
    const p = { companyOn: true, suspendDays: 15, dueOn: "2026-11-01", open: true };
    expect(requestPauseDue({ ...p, todayISO: "2026-11-20", lastStep: "final" })).toBe(true);    // 19 days
    expect(requestPauseDue({ ...p, todayISO: "2026-11-18", lastStep: "final" })).toBe(false);   // 17 days
    expect(requestPauseDue({ ...p, todayISO: "2026-11-30", lastStep: "grace_warning" })).toBe(false);
    expect(requestPauseDue({ ...p, companyOn: false, todayISO: "2026-12-30", lastStep: "final" })).toBe(false);
  });
  it("the mail carries the Pay link and says the tax invoice follows payment", () => {
    const m = requestReminderText({
      step: "new", customerName: "Acme", companyName: "Anutech", quoteId: "Q-9", part: "part 2 (1 Nov 2026 to 31 Jan 2027)",
      amount: "₹7,080", dueOn: "1 Nov 2026", payUrl: "https://app.example/quote/Q-9/accept?t=x",
    });
    expect(m.subject).toBe("Payment request Q-9 — ₹7,080");
    expect(m.body).toContain("Pay here: https://app.example/quote/Q-9/accept?t=x");
    expect(m.body).toContain("The tax invoice for this part is issued as soon as it is paid.");
  });
});

describe("R-2044 — ?on= only on a dry run", () => {
  it("time-travels a dry run, refuses a live one and a bad date", () => {
    expect(billingCronDay({ dryRun: true, on: "2026-11-01", todayISO: "2026-10-28" })).toEqual({ todayISO: "2026-11-01" });
    expect(billingCronDay({ dryRun: false, on: null, todayISO: "2026-10-28" })).toEqual({ todayISO: "2026-10-28" });
    expect(billingCronDay({ dryRun: false, on: "2026-11-01", todayISO: "2026-10-28" })).toHaveProperty("error");
    expect(billingCronDay({ dryRun: true, on: "1 Nov", todayISO: "2026-10-28" })).toHaveProperty("error");
  });
});

describe("R-2044 — one instalment invoice path", () => {
  it("the billing cron code no longer calls raise_subscription_billing directly", () => {
    const src = readFileSync(join(__dirname, "sync-instalments.server.ts"), "utf8");
    expect(src).not.toMatch(/rpc\(\s*"raise_subscription_billing"/);
    expect(src).toMatch(/rpc\("bill_subscription_instalment"/);
  });
});
