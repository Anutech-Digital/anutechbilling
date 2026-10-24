/**
 * R-1473 — one set of data, four "money owed" figures. Each test feeds the SAME rows to the
 * functions behind the dashboard "Still owed" tile, the dashboard Collections card, the
 * Companies "To collect" tile and the Renewals "Unpaid balance" badge, and checks that they
 * agree — or differ only in the way their label says.
 */
import { describe, it, expect } from "vitest";
import { subscriptionDue, toChaseSummary, chaseNote, type DueSubscription } from "./receivables-due";
import { invoiceMoney, type MoneyInvoice } from "@/lib/company/summary";
import { renewalRisk } from "@/app/(app)/renewals/risk";

const NOW = new Date("2026-10-16T06:00:00Z");

/** The Renewals badge's figure for one subscription (0 when it shows no "Unpaid balance"). */
function renewalsUnpaid(sub: DueSubscription): number {
  const r = renewalRisk({
    used: 0, seats: 10, plan: "Business Standard", used_synced_at: null,
    outstanding_amount: sub.outstanding_amount ?? 0, written_off_at: sub.written_off_at ?? null,
  });
  return r.reasons.some((x) => x.startsWith("Unpaid balance")) ? (sub.outstanding_amount ?? 0) : 0;
}

describe("R-1473 subscriptionDue", () => {
  it("is the stored due, in whole rupees", () => {
    expect(subscriptionDue({ customer_id: "c1", outstanding_amount: 25_480 })).toBe(25_480);
  });
  it("is 0 once written off, and never negative", () => {
    expect(subscriptionDue({ customer_id: "c1", outstanding_amount: 9_000, written_off_at: "2026-10-01T00:00:00Z" })).toBe(0);
    expect(subscriptionDue({ customer_id: "c1", outstanding_amount: null })).toBe(0);
    expect(subscriptionDue({ customer_id: "c1", outstanding_amount: -5 })).toBe(0);
  });
});

describe("R-1473 Pawan's staging case — unpaid renewals WITHOUT an invoice", () => {
  // Two customers owe on their subscriptions; nobody has raised an invoice yet.
  const subs: DueSubscription[] = [
    { customer_id: "acme", outstanding_amount: 25_480 },
    { customer_id: "beta", outstanding_amount: 19_266 },
  ];
  const invoices: MoneyInvoice[] = [];

  it("Collections, Companies and Renewals give the same ₹44,746", () => {
    const chase = toChaseSummary(subs);
    const renewals = subs.reduce((s, x) => s + renewalsUnpaid(x), 0);
    expect(chase.total).toBe(44_746);
    expect(chase.companiesTotal).toBe(44_746);
    expect(renewals).toBe(44_746);
    expect(chase.unlinked).toEqual({ count: 0, value: 0 });
  });

  it("Still owed stays ₹0 — it counts billed invoices only (its label says so)", () => {
    expect(invoiceMoney(invoices, NOW).outstanding).toEqual({ count: 0, value: 0 });
  });
});

describe("R-1473 an unpaid renewal WITH an invoice", () => {
  const subs: DueSubscription[] = [{ customer_id: "acme", outstanding_amount: 25_480 }];
  const invoices: MoneyInvoice[] = [{
    status: "pending", amount: 25_480, net_payable: 25_480, paid_amount: 0,
    due_date: "2026-10-30", invoice_date: "2026-10-10",
  }];

  it("shows the same money in Still owed and in Collections — never added together", () => {
    const owed = invoiceMoney(invoices, NOW).outstanding;
    const chase = toChaseSummary(subs);
    expect(owed).toEqual({ count: 1, value: 25_480 });
    expect(chase.total).toBe(25_480);
    expect(chase.companiesTotal).toBe(25_480);
    expect(renewalsUnpaid(subs[0])).toBe(25_480);
  });
});

describe("R-1473 the drifts that made the figures disagree", () => {
  it("Companies adds EVERY subscription of a company (it kept only one)", () => {
    const chase = toChaseSummary([
      { customer_id: "acme", outstanding_amount: 10_000 },
      { customer_id: "acme", outstanding_amount: 5_000 },
    ]);
    expect(chase.byCustomer.get("acme")).toBe(15_000);
    expect(chase.companiesTotal).toBe(chase.total);
  });

  it("a written-off due is out of Collections, Companies and Renewals alike", () => {
    const sub: DueSubscription = { customer_id: "acme", outstanding_amount: 9_000, written_off_at: "2026-10-01T00:00:00Z" };
    const chase = toChaseSummary([sub]);
    expect(chase.total).toBe(0);
    expect(chase.companiesTotal).toBe(0);
    expect(renewalsUnpaid(sub)).toBe(0);
  });

  it("a due on a subscription with no company is in Collections, kept apart from Companies", () => {
    const chase = toChaseSummary([
      { customer_id: "acme", outstanding_amount: 4_000 },
      { customer_id: null, outstanding_amount: 1_500 },
    ]);
    expect(chase.total).toBe(5_500);
    expect(chase.companiesTotal).toBe(4_000);
    expect(chase.unlinked).toEqual({ count: 1, value: 1_500 });
    expect(chase.companiesTotal + chase.unlinked.value).toBe(chase.total);
  });

  it("project receivables join their company and the total", () => {
    const chase = toChaseSummary([{ customer_id: "acme", outstanding_amount: 4_000 }], { acme: 1_000, beta: 2_000, gamma: 0 });
    expect(chase.subscriptionDues).toBe(4_000);
    expect(chase.projectInvoices).toBe(3_000);
    expect(chase.byCustomer.get("acme")).toBe(5_000);
    expect(chase.byCustomer.has("gamma")).toBe(false);
    expect(chase.total).toBe(7_000);
    expect(chase.companiesTotal).toBe(7_000);
  });
});

describe("R-1473 chaseNote — the label says why it can differ from Still owed", () => {
  it("names the parts and the invoice difference", () => {
    const note = chaseNote(toChaseSummary([{ customer_id: "acme", outstanding_amount: 44_746 }]));
    expect(note).toContain("Subscription dues ₹44.7K");
    expect(note).toContain("Still owed");
  });
  it("names dues on subscriptions with no company (they are not on the Companies list)", () => {
    const note = chaseNote(toChaseSummary([{ customer_id: null, outstanding_amount: 1_500 }], { acme: 2_000 }));
    expect(note).toContain("project invoices ₹2.0K");
    expect(note).toContain("₹1.5K on 1 subscription with no company linked");
  });
});
