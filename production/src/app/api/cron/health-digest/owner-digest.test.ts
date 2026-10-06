import { describe, expect, it } from "vitest";
import { buildOwnerDigest, inr, ownerDigestSubject, ownerDigestText, type OwnerDigestInput } from "./owner-digest";

// 7 Oct 2026, 08:00 IST = 02:30 UTC. Yesterday (IST) = 2026-10-06.
const NOW = new Date("2026-10-07T02:30:00Z");

function input(o: Partial<OwnerDigestInput> = {}): OwnerDigestInput {
  return {
    now: NOW, payments: [], projectPayments: [], invoices: [], held: [],
    quotesAwaitingApproval: 0, subscriptions: [], ...o,
  };
}

describe("R-220 owner digest — the four numbers", () => {
  it("money in = received payments + project payments dated yesterday (IST), whole rupees", () => {
    const d = buildOwnerDigest(input({
      payments: [
        { status: "received", amount: 11800, received_at: "2026-10-05T18:31:00Z" }, // 6 Oct 00:01 IST — yesterday
        { status: "received", amount: 5900, received_at: "2026-10-06T18:29:00Z" },  // 6 Oct 23:59 IST — yesterday
        { status: "received", amount: 999, received_at: "2026-10-06T18:31:00Z" },   // 7 Oct IST — today, not counted
        { status: "refunded", amount: 2000, received_at: "2026-10-06T06:00:00Z" },  // refunded — not money in
        { status: "received", amount: 700, received_at: "2026-10-05T18:29:00Z" },   // 5 Oct IST — not yesterday
      ],
      projectPayments: [
        { amount: 250000, received_at: "2026-10-06" },
        { amount: 1, received_at: "2026-10-07" },
      ],
    }));
    expect(d.day).toBe("2026-10-06");
    expect(d.moneyIn).toEqual({ count: 3, value: 267700 });
  });

  it("overdue = past due with balance left, net of advances and receipts", () => {
    const d = buildOwnerDigest(input({
      invoices: [
        { status: "pending", due_date: "2026-10-01", amount: 100000, net_payable: 90000, paid_amount: 40000 }, // owes 50,000
        { status: "pending", due_date: "2026-10-07", amount: 5000 },                                        // due today — not overdue
        { status: "overdue", due_date: "2026-09-01", amount: 1180, paid_amount: 0 },                        // stored overdue
        { status: "pending", due_date: null, amount: 7000 },                                                 // no due date
        { status: "pending", due_date: "2026-09-15", amount: 3000, paid_amount: 3000 },                     // fully paid
      ],
    }));
    expect(d.overdue).toEqual({ count: 2, value: 51180 });
  });

  it("waiting on you = held AI actions in the last 7 days + quotes awaiting approval", () => {
    const d = buildOwnerDigest(input({
      held: [
        { created_at: "2026-10-06T10:00:00Z", reason: "Reply drafted for Acme — price not confirmed" },
        { created_at: "2026-09-30T00:00:00Z", reason: "Old but inside 7 days (30 Sep IST)" },
        { created_at: "2026-09-28T10:00:00Z", reason: "Too old" },
      ],
      quotesAwaitingApproval: 2,
    }));
    expect(d.waiting.held).toBe(2);
    expect(d.waiting.quotes).toBe(2);
    expect(d.waiting.total).toBe(4);
    expect(d.waiting.examples[0]).toMatch(/Acme/);
  });

  it("renewal risk = the Expiring folder (30 days or lapsed-live), MRR at stake", () => {
    const d = buildOwnerDigest(input({
      subscriptions: [
        { status: "active", renewal_date: "2026-10-20", mrr: 1650 },  // in 13 days
        { status: "active", renewal_date: "2026-11-05", mrr: 3080 },  // in 29 days
        { status: "active", renewal_date: "2026-12-31", mrr: 9999 },  // far away
        { status: "cancelled", renewal_date: "2026-10-10", mrr: 500 }, // ended — not at risk
      ],
    }));
    expect(d.renewals).toEqual({ count: 2, value: 4730 });
  });

  it("text and subject carry the numbers in English with ₹ Indian grouping", () => {
    const d = buildOwnerDigest(input({
      payments: [{ status: "received", amount: 123456, received_at: "2026-10-06T06:00:00Z" }],
      quotesAwaitingApproval: 1,
    }));
    expect(inr(123456)).toBe("₹1,23,456");
    expect(ownerDigestSubject(d)).toBe("ResellerOS morning: ₹1,23,456 in, 0 overdue, 1 waiting on you");
    const text = ownerDigestText(d, "https://app.example/");
    expect(text).toContain("1. Money in yesterday: ₹1,23,456 from 1 payment");
    expect(text).toContain("https://app.example/invoices?tab=overdue");
    expect(text).toContain("3. Waiting on you: 1 (0 AI actions held, 1 quote to approve)");
    expect(text).toContain("https://app.example/subscriptions?tab=expiring");
  });
});
