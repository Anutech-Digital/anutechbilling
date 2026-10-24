/** R-1111: /done says "Payment received" only with proof for this order in this session. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { doneView, type DoneFacts } from "./done-view";

const base: DoneFacts = { trialEmail: null, trialSent: true, hasPayment: false, verdict: null, orderNo: null, simulatedFor: null };

describe("R-1111 doneView", () => {
  it("a fresh tab (nothing in storage) is not told it paid", () => {
    expect(doneView(base)).toBe("none");
  });
  it("an order number alone is not proof of payment", () => {
    expect(doneView({ ...base, orderNo: "QT-2026-0042" })).toBe("none");
  });
  it("a Razorpay payment the server confirmed shows paid", () => {
    expect(doneView({ ...base, hasPayment: true, verdict: "paid", orderNo: "QT-1" })).toBe("paid");
  });
  it("a Razorpay payment not yet confirmed shows the pending screen", () => {
    expect(doneView({ ...base, hasPayment: true, verdict: null })).toBe("payment-pending");
    expect(doneView({ ...base, hasPayment: true, verdict: "failed" })).toBe("payment-pending");
  });
  it("a simulated order counts only for the same order number", () => {
    expect(doneView({ ...base, orderNo: "QT-1", simulatedFor: "QT-1" })).toBe("paid");
    expect(doneView({ ...base, orderNo: "QT-2", simulatedFor: "QT-1" })).toBe("none");
    expect(doneView({ ...base, orderNo: null, simulatedFor: "" })).toBe("paid");
  });
  it("trial screens win over everything", () => {
    expect(doneView({ ...base, trialEmail: "a@b.in" })).toBe("trial");
    expect(doneView({ ...base, trialEmail: "a@b.in", trialSent: false })).toBe("trial-unsent");
  });
});

describe("R-1111 wiring", () => {
  const page = readFileSync("src/app/(marketing)/done/page.tsx", "utf8");
  const checkout = readFileSync("src/app/(marketing)/checkout/page.tsx", "utf8");
  it("the success screen is gated on doneView === 'paid', and a neutral screen exists", () => {
    expect(page).toMatch(/if \(view !== "paid"\)/);
    expect(page.indexOf('if (view !== "paid")')).toBeLessThan(page.indexOf('badge="Payment received · order placed"'));
    expect(page).toMatch(/Looking for your order\?/);
  });
  it("the checkout marks simulated orders and clears the mark on other paths", () => {
    expect(checkout).toMatch(/setItem\(SIMULATED_KEY, json\.quoteId \|\| ""\)/);
    expect((checkout.match(/removeItem\(SIMULATED_KEY\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
