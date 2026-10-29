/**
 * R-2083 — the pure rules of the /buy/support checkout.
 */
import { describe, it, expect } from "vitest";
import {
  buildSupportOrder, isSupportCheckoutPlan, parseSupportBuyParams, supportCheckoutSchema, supportPriceView,
  supportWhatNext, yearlySavingPct,
} from "./public-checkout";

const ITEM = { id: "SUP-STANDARD-YR-abc", name: "Support Standard (Yearly)" };

describe("parseSupportBuyParams — the link DSP's Upgrade button opens", () => {
  it("reads plan, term, email and billing_customer_id", () => {
    expect(parseSupportBuyParams({ plan: "enterprise", term: "monthly", email: "a@b.in", billing_customer_id: "C-0042" }))
      .toEqual({ plan: "enterprise", term: "monthly", email: "a@b.in", billingCustomerId: "C-0042" });
  });
  it("unknown or Free → Standard / Yearly; junk email and id are dropped, never echoed", () => {
    expect(parseSupportBuyParams({ plan: "free", term: "x", email: "not-an-email", billing_customer_id: "1;drop" }))
      .toEqual({ plan: "standard", term: "yearly", email: "", billingCustomerId: "" });
  });
});

describe("buildSupportOrder — the server's price, never ₹0", () => {
  it("yearly: the year total on an annual_yearly line, 18% GST rounded to the rupee", () => {
    const o = buildSupportOrder({ plan: "standard", term: "yearly", price: 9996, item: ITEM, lineId: "l1" })!;
    expect(o).toMatchObject({ planLabel: "support-standard", tierName: "Standard Support (Yearly)", subtotal: 9996, gst: 1799, amount: 11795 });
    expect(o.line).toEqual({ id: "l1", item_id: ITEM.id, name: ITEM.name, qty: 1, rate: 9996, cost: 0, commitment: "annual_yearly" });
  });
  it("monthly: one month on a monthly line", () => {
    const o = buildSupportOrder({ plan: "enterprise", term: "monthly", price: 4999, item: { id: "i", name: "" } })!;
    expect(o.line).toMatchObject({ commitment: "monthly", rate: 4999, name: "Enterprise Support (Monthly)" });
    expect(o.amount).toBe(5899);
  });
  it("no price, ₹0, negative or a fraction → no order", () => {
    for (const price of [null, 0, -1, 99.5]) expect(buildSupportOrder({ plan: "standard", term: "yearly", price, item: ITEM })).toBeNull();
  });
});

describe("supportCheckoutSchema — only the choice and the buyer's details", () => {
  it("drops any amount the browser sends", () => {
    const r = supportCheckoutSchema.parse({ plan: "standard", term: "yearly", fullName: "AB", email: "a@b.in", phone: "9876543210", amount: 1, rate: 1 });
    expect(r).not.toHaveProperty("amount");
    expect(r).not.toHaveProperty("rate");
  });
  it("refuses Free, an id with filter characters, and a bad email", () => {
    const base = { plan: "standard", term: "yearly", fullName: "AB", email: "a@b.in", phone: "9876543210" };
    expect(supportCheckoutSchema.safeParse({ ...base, plan: "free" }).success).toBe(false);
    expect(supportCheckoutSchema.safeParse({ ...base, billingCustomerId: "x,id.eq.y" }).success).toBe(false);
    expect(supportCheckoutSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });
});

describe("the rest", () => {
  it("isSupportCheckoutPlan knows only website support orders", () => {
    expect(isSupportCheckoutPlan("support-standard")).toBe(true);
    expect(isSupportCheckoutPlan("support-enterprise")).toBe(true);
    expect(isSupportCheckoutPlan("support-free")).toBe(false);
    expect(isSupportCheckoutPlan("google-workspace-standard")).toBe(false);
    expect(isSupportCheckoutPlan(null)).toBe(false);
  });
  it("price view and the yearly saving come from the two prices charged", () => {
    expect(supportPriceView("standard", "yearly", 9996)).toEqual({ plan: "standard", term: "yearly", label: "Standard Support (Yearly)", exGst: 9996, gst: 1799, total: 11795 });
    expect(yearlySavingPct(999, 9996)).toBe(17);
    expect(yearlySavingPct(999, 11988)).toBeNull();
    expect(yearlySavingPct(0, 9996)).toBeNull();
  });
  it("the buyer's next step names the plan, not a setup", () => {
    expect(supportWhatNext("Standard Support (Yearly)")).toMatch(/Standard Support \(Yearly\) plan is switched on at our support desk/);
  });
});
