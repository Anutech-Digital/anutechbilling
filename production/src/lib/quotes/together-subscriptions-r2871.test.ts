/* R-2871 — a together renewal quote (one quote renewing 2+ yearly subscriptions, R-2847..R-2849)
   names every subscription it renews. The members are the distinct line_items[].subscription_id
   — the link R-2848/R-2849 already use. A single renewal quote reads as before. */
import { describe, it, expect } from "vitest";
import { togetherMembers, togetherPlanNames } from "./quote-kind";
import { recordPaymentConsequences, type PaymentToRecord } from "@/lib/payments/record-consequences";

const subs = [
  { id: "s1", plan: "SCN Yearly Standard", domain: "a.in", seats: 20, renewal_date: "2026-11-26" },
  { id: "s2", plan: "SCN Yearly Starter", domain: "b.in", seats: 5, renewal_date: "2026-12-02" },
  { id: "s3", plan: "Other", domain: null, seats: 1, renewal_date: "2027-01-01" },
];

describe("togetherMembers (R-2871)", () => {
  it("2 lines on 2 subscriptions → both, each with its own plan, seats and date, in line order", () => {
    const m = togetherMembers([{ subscription_id: "s2" }, { subscription_id: "s1" }, { subscription_id: "s2" }], subs);
    expect(m.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(m[1].text).toBe("SCN Yearly Standard · a.in · 20 seats · renews 26 Nov 2026");
  });
  it("one subscription (or none) → empty: the single-subscription line stays as it is", () => {
    expect(togetherMembers([{ subscription_id: "s1" }, { subscription_id: "s1" }], subs)).toEqual([]);
    expect(togetherMembers([{}, {}], subs)).toEqual([]);
    expect(togetherMembers(null, subs)).toEqual([]);
  });
  it("a member not loaded yet → empty (never a half list that reads as the whole)", () => {
    expect(togetherMembers([{ subscription_id: "s1" }, { subscription_id: "gone" }], subs)).toEqual([]);
  });
});

describe("togetherPlanNames (R-2871)", () => {
  it("names each member line once; one subscription → []", () => {
    expect(togetherPlanNames([{ name: "A", subscription_id: "s1" }, { name: "B", subscription_id: "s2" }, { name: "Support", subscription_id: "s2" }])).toEqual(["A", "B"]);
    expect(togetherPlanNames([{ name: "A", subscription_id: "s1" }, { name: "Support" }])).toEqual([]);
    expect(togetherPlanNames(undefined)).toEqual([]);
  });
});

const base: PaymentToRecord = {
  quoteId: "Q-1", customerName: "Acme", amount: 1000, quoteAmount: 1000, priorReceived: 0,
  createsCustomer: false, createsSubscription: true, planLabel: "SCN Yearly Standard", renewsSubscription: true,
};
const texts = (p: Partial<PaymentToRecord>) =>
  recordPaymentConsequences({ payment: { ...base, ...p }, receiptSeries: null }).map((c) => c.text).join(" | ");

describe("Record payment — renewal consequence (R-2871)", () => {
  it("together quote: says it renews N subscriptions and names them", () => {
    const t = texts({ renewsSubscriptions: ["SCN Yearly Standard", "SCN Yearly Starter"] });
    expect(t).toContain("Renews 2 subscriptions: SCN Yearly Standard, SCN Yearly Starter");
    expect(t).toContain("its own next renewal date");
    expect(t).not.toContain("Renews the existing subscription");
  });
  it("single renewal quote: exactly today's sentence", () => {
    const t = texts({});
    expect(t).toContain("Renews the existing subscription — the same subscription moves to its next renewal date. No new subscription is created.");
    expect(texts({ renewsSubscriptions: ["Only one"] })).toContain("Renews the existing subscription");
  });
});
