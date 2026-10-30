/**
 * R-2095 (30 Oct 2026, September reconcile): Q-0224's BALANCE payment said "Creates 2 recurring
 * subscriptions" although the first payment had already made both (record_payment files a sale's
 * subscriptions on its first receipt and never twice). A payment on a quote that already received
 * money says the subscriptions exist and none is added.
 */
import { describe, it, expect } from "vitest";
import { recordPaymentConsequences, type PaymentToRecord } from "./record-consequences";

const base: PaymentToRecord = {
  quoteId: "Q-0224", customerName: "Acme", amount: 5000, quoteAmount: 20000, priorReceived: 15000,
  createsCustomer: false, createsSubscription: true, planLabel: "Business Starter",
  planLabels: ["Business Starter", "Business Standard"],
};

describe("R-2095 balance payment preview", () => {
  it("money already received → the subscriptions exist, none is created", () => {
    const texts = recordPaymentConsequences({ payment: base, receiptSeries: null }).map((c) => c.text).join(" | ");
    expect(texts).not.toMatch(/Creates 2 recurring subscriptions/);
    expect(texts).toMatch(/already exist/);
  });
  it("first payment still says it creates them", () => {
    const texts = recordPaymentConsequences({ payment: { ...base, priorReceived: 0 }, receiptSeries: null }).map((c) => c.text).join(" | ");
    expect(texts).toMatch(/Creates 2 recurring subscriptions/);
  });
});
