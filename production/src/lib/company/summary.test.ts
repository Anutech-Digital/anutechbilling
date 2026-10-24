import { describe, it, expect } from "vitest";
import {
  inIstMonth, istMonthStartUtc, growthSummary, trialsStartedInMonth, invoiceMoney,
  collectedInMonth, newCustomersInMonth, subscriptionSummary, openTicketCount,
} from "./summary";
import { captureChannel } from "@/lib/leads/capture-channel";

// 15 Oct 2026, 10:00 IST
const NOW = new Date("2026-10-15T04:30:00Z");

describe("inIstMonth", () => {
  it("reads instants in IST at both month edges", () => {
    expect(inIstMonth("2026-09-30T18:30:00Z", NOW)).toBe(true);   // 1 Oct 00:00 IST
    expect(inIstMonth("2026-09-30T18:29:59Z", NOW)).toBe(false);  // 30 Sep 23:59 IST
    expect(inIstMonth("2026-10-31T18:29:59Z", NOW)).toBe(true);   // 31 Oct 23:59 IST
    expect(inIstMonth("2026-10-31T18:30:00Z", NOW)).toBe(false);  // 1 Nov IST
  });
  it("does not shift a bare calendar date", () => {
    expect(inIstMonth("2026-10-01", NOW)).toBe(true);
    expect(inIstMonth("2026-09-30", NOW)).toBe(false);
  });
  it("null is never in the month", () => {
    expect(inIstMonth(null, NOW)).toBe(false);
  });
  it("month start is midnight IST", () => {
    expect(istMonthStartUtc(NOW).toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });
});

describe("growthSummary", () => {
  it("counts this month's leads and the website ones by the /lead-gen channel rule", () => {
    const leads = [
      { source: "enquiry-form", created_at: "2026-10-02T05:00:00Z" },
      { source: "buy-workspace-trial", created_at: "2026-10-03T05:00:00Z" },
      { source: "buy-hosting-trial", created_at: "2026-10-03T05:00:00Z" },
      { source: "referral", created_at: "2026-10-04T05:00:00Z" },
      { source: null, created_at: "2026-10-04T05:00:00Z" },
      { source: "enquiry-form", created_at: "2026-09-29T05:00:00Z" }, // last month
    ];
    expect(growthSummary(leads, NOW)).toEqual({ newLeads: 5, fromWebsite: 3 });
  });
  it("every public-flow source is a website lead", () => {
    for (const s of ["enquiry-form", "buy-workspace", "buy-workspace-v2", "buy-workspace-trial",
      "buy-workspace-direct", "buy-hosting-trial"]) expect(captureChannel(s)).toBe("website");
    expect(captureChannel("meta-ads")).toBe("facebook");
    expect(captureChannel(null)).toBe("manual");
  });
  it("trials started counts trial_started_at in the IST month", () => {
    expect(trialsStartedInMonth([
      { trial_started_at: "2026-10-01T00:00:00Z" },
      { trial_started_at: "2026-09-30T19:00:00Z" },  // 1 Oct IST
      { trial_started_at: "2026-09-20T00:00:00Z" },
      { trial_started_at: null },
    ], NOW)).toBe(2);
  });
});

describe("invoiceMoney", () => {
  const inv = (o: Partial<Parameters<typeof invoiceMoney>[0][number]>) => ({
    status: "pending", amount: 1000, due_date: null, invoice_date: "2026-10-05", paid_amount: 0, net_payable: null, ...o,
  });
  it("invoiced = real invoices dated this month at stored amount", () => {
    const r = invoiceMoney([
      inv({ amount: 1180 }),
      inv({ status: "paid", amount: 2360 }),
      inv({ status: "void", amount: 99999 }),
      inv({ status: "draft", amount: 5000 }),
      inv({ invoice_date: "2026-09-30", amount: 700 }),
    ], NOW);
    expect(r.invoicedThisMonth).toEqual({ count: 2, value: 3540 });
  });
  it("outstanding = pending + overdue at net payable; void and draft are not owed", () => {
    const r = invoiceMoney([
      inv({ amount: 1000, net_payable: 800 }),
      inv({ amount: 500, due_date: "2026-10-01" }),           // overdue
      inv({ status: "overdue", amount: 300 }),                 // stored overdue still counts
      inv({ status: "paid", amount: 4000 }),
      inv({ status: "void", amount: 2900000 }),
      inv({ status: "draft", amount: 100 }),
    ], NOW);
    expect(r.outstanding).toEqual({ count: 3, value: 1600 });
    expect(r.overdueCount).toBe(2);
  });
  it("a fully paid-up pending invoice past due is not overdue", () => {
    const r = invoiceMoney([inv({ amount: 500, paid_amount: 500, due_date: "2026-10-01" })], NOW);
    expect(r.overdueCount).toBe(0);
  });
});

describe("collectedInMonth", () => {
  it("received sales payments (IST) + project payments (calendar date) this month", () => {
    expect(collectedInMonth(
      [
        { status: "received", amount: 100, received_at: "2026-09-30T19:00:00Z" }, // 1 Oct IST
        { status: "received", amount: 200, received_at: "2026-09-30T18:00:00Z" }, // 30 Sep IST
        { status: "refunded", amount: 400, received_at: "2026-10-05T05:00:00Z" },
      ],
      [{ amount: 1000, received_at: "2026-10-02" }, { amount: 50, received_at: "2026-09-30" }],
      NOW,
    )).toBe(1100);
  });

  /* R-1565: ₹10,000 came in as an advance in September (it is the customer's credit now).
     In October that credit pays a ₹10,000 quote: record_desk_payment writes a payments row of
     amount 10,000 with credit_applied 10,000. No money arrived in October — "Collected this
     month" must not count it again. */
  it("advance credit applied to a payment is not money collected (R-1565)", () => {
    const pays = [
      { status: "received", amount: 10_000, credit_applied: 0, received_at: "2026-09-10T05:00:00Z" },      // Sept advance
      { status: "received", amount: 10_000, credit_applied: 10_000, received_at: "2026-10-05T05:00:00Z" }, // Oct: all credit
      { status: "received", amount: 6_000, credit_applied: 4_000, received_at: "2026-10-06T05:00:00Z" },   // Oct: ₹2,000 cash + ₹4,000 credit
    ];
    expect(collectedInMonth(pays, [], NOW)).toBe(2_000);
    expect(collectedInMonth(pays, [], new Date("2026-09-20T06:00:00Z"))).toBe(10_000);
  });
});

describe("customers & ops", () => {
  it("new customers this IST month", () => {
    expect(newCustomersInMonth([
      { created_at: "2026-10-10T05:00:00Z" }, { created_at: "2026-09-10T05:00:00Z" }, { created_at: null },
    ], NOW)).toBe(1);
  });
  it("MRR over active subs; renewals due = the Expiring folder", () => {
    const r = subscriptionSummary([
      { status: "active", mrr: 1000, renewal_date: "2026-12-31" },
      { status: "active", mrr: 500, renewal_date: "2026-11-10" },   // 26 days → expiring
      { status: "active", mrr: 300, renewal_date: "2026-10-01" },   // lapsed, still live → expiring
      { status: "paused", mrr: 900, renewal_date: "2026-10-20" },
      { status: "expired", mrr: 700, renewal_date: "2026-10-20" },
    ], NOW);
    expect(r).toEqual({ activeCount: 3, mrr: 1800, renewalsDue: { count: 2, value: 800 } });
  });
  it("open tickets = open + in progress + awaiting customer", () => {
    expect(openTicketCount({ all: 9, open: 2, in_progress: 1, awaiting_customer: 1, resolved: 4, closed: 1 })).toBe(4);
    expect(openTicketCount(null)).toBe(0);
  });
});
