import { describe, it, expect } from "vitest";
import {
  billingUnitOf, catalogUnitWarnings, defaultQtyForUnit, explicitBillingUnit, unitSuggestedByName, unitYearMultiplier,
} from "./billing-unit";

/* The rows from the AI tester's quote Q-FBB9-27-0019 (local catalogue, 9 Oct). */
const DOM_IN_OLD = { id: "DOM-IN-t", name: "Domain registration (.in / .com / yr)", vendor: "other", item_type: "subscription", msrp: 999, prices: {} };
const M365_EM_OLD = { id: "M365-EM-t", name: "M365 Email migration (one-time)", vendor: "microsoft", item_type: "subscription", msrp: 199, prices: {} };
const GW_STD = { id: "GW-STD-t", name: "Google Workspace Standard", vendor: "google", item_type: "subscription", msrp: 1080, prices: {} };

describe("R-526 — billingUnitOf", () => {
  it("the owner's unit wins", () => {
    expect(billingUnitOf({ ...DOM_IN_OLD, prices: { billing_unit: "unit_year" } })).toBe("unit_year");
    expect(billingUnitOf({ ...M365_EM_OLD, prices: { billing_unit: "one_time" } })).toBe("one_time");
    expect(explicitBillingUnit({ prices: { billing_unit: "bogus" } })).toBeNull();
  });
  it("an old row keeps the unit its old behaviour implied — nothing re-prices by itself", () => {
    expect(billingUnitOf(GW_STD)).toBe("seat_month");
    expect(billingUnitOf(DOM_IN_OLD)).toBe("seat_month");
    expect(billingUnitOf({ vendor: "hosting", msrp: 199, prices: {} })).toBe("unit_month");
    expect(billingUnitOf({ vendor: "support", msrp: 199, prices: {} })).toBe("unit_month");
    expect(billingUnitOf({ vendor: "support", msrp: 0, prices: { annual_total: { msrp: 9996 } } })).toBe("unit_year");
    expect(billingUnitOf({ vendor: "domain", item_type: "one_time", msrp: 799, prices: {} })).toBe("one_time");
  });
  it("×12 only for a per-month unit; qty = seats only for a per-seat unit", () => {
    expect(unitYearMultiplier("seat_month")).toBe(12);
    expect(unitYearMultiplier("unit_month")).toBe(12);
    expect(unitYearMultiplier("unit_year")).toBe(1);
    expect(unitYearMultiplier("one_time")).toBe(1);
    expect(defaultQtyForUnit("seat_month")).toBe(10);
    expect(defaultQtyForUnit("seat_month", 25)).toBe(25);
    expect(defaultQtyForUnit("unit_year", 25)).toBe(1);
    expect(defaultQtyForUnit("one_time", 25)).toBe(1);
    expect(defaultQtyForUnit("unit_month", 25)).toBe(1);
  });
});

describe("R-526 — Check these catalog items", () => {
  it("names say domain / migration", () => {
    expect(unitSuggestedByName("Domain registration (.in / .com / yr)")).toBe("unit_year");
    expect(unitSuggestedByName("M365 Email migration (one-time)")).toBe("one_time");
    expect(unitSuggestedByName("Workspace setup")).toBe("one_time");
    expect(unitSuggestedByName("Google Workspace Standard")).toBeNull();
  });
  it("lists the two tester rows with the quote number they produce today, never changes them", () => {
    const rows = [DOM_IN_OLD, M365_EM_OLD, GW_STD];
    const before = JSON.stringify(rows);
    const w = catalogUnitWarnings(rows);
    expect(w.map((x) => x.id)).toEqual(["DOM-IN-t", "M365-EM-t"]);
    expect(w[0].suggested).toBe("unit_year");
    expect(w[0].reason).toContain("₹11,988");
    expect(w[1].suggested).toBe("one_time");
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("a fixed row, an inactive row and an unrelated row are not listed", () => {
    expect(catalogUnitWarnings([
      { ...DOM_IN_OLD, prices: { billing_unit: "unit_year" } },
      { ...M365_EM_OLD, prices: { billing_unit: "one_time" } },
      { ...DOM_IN_OLD, id: "x", is_active: false },
      GW_STD,
    ])).toEqual([]);
  });
});
