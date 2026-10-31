/**
 * R-2095 (30 Oct 2026, September reconcile): Subscriptions → Add subscription had no half-yearly
 * billing (only yearly / quarterly / monthly) — a Zoho sub billed every 6 months could not be
 * entered as it is. "Half-yearly — annual commitment": the annual rate per month, stored as the
 * year, invoiced every 6 months (2 invoices), billing_cycle half_yearly.
 */
import { describe, it, expect } from "vitest";
import { BILLING_CHOICES, billingTerms, firstInvoiceTaxable, convertPriceForChoice } from "./catalog-options";

describe("R-2095 Add subscription — half-yearly", () => {
  it("is offered, between quarterly and yearly", () => {
    expect(BILLING_CHOICES.map((c) => c.value)).toContain("annual_half_yearly");
  });
  it("2 invoices a year, billing_cycle half_yearly, stored as the year at the monthly rate", () => {
    const t = billingTerms("annual_half_yearly");
    expect(t).toMatchObject({ billingCycle: "half_yearly", invoicesPerTerm: 2, periods: 12, unit: "per_seat_month", commitment: "annual_yearly", termMonths: 12 });
    expect(firstInvoiceTaxable(78750 * 2, t)).toBe(78750);
  });
  it("switching from yearly converts the price to per month like quarterly", () => {
    expect(convertPriceForChoice("3780", "annual_yearly", "annual_half_yearly").text).toBe("315");
  });
});
