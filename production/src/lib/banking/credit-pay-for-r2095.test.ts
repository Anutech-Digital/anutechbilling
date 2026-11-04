/* R-2095 (30 Oct 2026, staging reconcile) — Reconcile → "A new sale":
   · "Then ₹X every month" counted the one-time lines (setup, migration) in X;
   · unit prices were rounded to whole rupees — Zoho bills ₹103.5 and ₹1,347.5, so the sale could
     not match the bank line. */
import { describe, expect, it } from "vitest";
import { laterBillsText, rateFromShownPrice, saleLinesPayload, salePreview, saleSchedule, type SaleLine } from "./credit-pay-for";

const line = (p: Partial<SaleLine>): SaleLine => ({
  itemId: null, name: "Item", qty: 1, rate: 0, cost: 0, cycle: "monthly", perSeat: true, ...p,
}) as SaleLine;

describe("R-2095 Monthly flex: the monthly bill leaves the one-time lines out", () => {
  const lines = [
    line({ name: "Google Workspace Business Starter", qty: 10, rate: 325, cycle: "monthly" }),
    line({ name: "Email migration", qty: 1, rate: 2000, cycle: "one_time", perSeat: false }),
  ];
  it("due now = month + setup; then only the month again", () => {
    const s = saleSchedule(lines, 18, "monthly", "2026-10-21");
    expect(s.dueNow).toBe(Math.round((3250 + 2000) * 1.18));
    expect(laterBillsText(s, "monthly")).toBe("Then ₹3,835 every month while the Flexible (monthly) plan runs.");
  });
});

describe("R-2095 unit prices keep paise", () => {
  it("a typed ₹1,347.5 stays ₹1,347.5 (two decimals at most)", () => {
    expect(rateFromShownPrice({ cycle: "annual_yearly" }, 1347.5)).toBe(1347.5);
    expect(rateFromShownPrice({ cycle: "monthly" }, 103.456)).toBe(103.46);
  });
  it("the sale total rounds once: 3 × ₹103.5 = ₹310.5 → ₹311 taxable (rupee invoice), GST on that", () => {
    const p = salePreview([line({ qty: 3, rate: 103.5 })], 18);
    expect(p.taxable).toBe(311);
    expect(p.gst).toBe(56);
    expect(salePreview([line({ qty: 2, rate: 1347.5, cycle: "annual_yearly" })], 18).taxable).toBe(2695);
  });
  it("the server gets the paise rate, not a rounded one", () => {
    expect(saleLinesPayload([line({ qty: 2, rate: 1347.5 })])[0].rate).toBe(1347.5);
  });
});
