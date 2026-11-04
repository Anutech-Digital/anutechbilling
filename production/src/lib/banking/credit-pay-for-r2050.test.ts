/* R-2050 — Pardeep 28 Oct (localhost, Banking → Reconcile → "A new sale", E2E Google Workspace
   Business Starter, Annual, 10 seats): "commitment annual hai to annual price show hona chahiye".
   Annual commitment: the unit price is asked and shown ₹/user/YEAR (the quote line's own unit —
   no ×12 / ÷12), prefilled from the catalogue but never below the Workspace list floor
   (lib/catalog/workspace-floor.ts: Starter ₹270/mo → ₹3,240/yr). Monthly stays ₹/user/month. */
import { describe, expect, it } from "vitest";
import {
  convertTypedPrice, rateFromShownPrice, repriceLine, salePreview, saleLineFromItem, saleLinesPayload, shownPriceUnit, shownUnitPrice, type SaleLine,
} from "./credit-pay-for";

/* The local E2E catalogue row as it is today: a stale ₹136/month, no tiers. */
const E2E_STARTER = {
  id: "E2E-ST", name: "E2E Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110,
  item_type: "subscription", prices: {},
} as never;
const STANDARD = {
  id: "GW-STD", name: "Google Workspace Business Standard", vendor: "google", msrp: 1080, wholesale: 900,
  item_type: "subscription", prices: { annual: { msrp: 1080, wholesale: 900 }, monthly: { msrp: 1300, wholesale: 1080 } },
} as never;
const PLUS_ABOVE_LIST = {
  id: "GW-PLUS", name: "Google Workspace Business Plus", vendor: "google", msrp: 1800, wholesale: 1500,
  item_type: "subscription", prices: { annual: { msrp: 1800, wholesale: 1500 } },
} as never;

describe("R-2050 Annual commitment: unit price per user per YEAR, never below the list floor", () => {
  it("owner's example: E2E Starter, Annual, 10 seats → ₹3,240/user/year, ₹32,400 + GST ₹5,832 = ₹38,232", () => {
    const l = saleLineFromItem(E2E_STARTER, "annual_yearly", 10);
    expect(shownPriceUnit(l)).toBe("₹/user/year");
    expect(shownUnitPrice(l)).toBe(3240);
    expect(l.rate).toBe(3240);                 // the quote line's ₹/seat/year — same RPC shape as before
    expect(salePreview([l], 18)).toEqual({ taxable: 32400, gst: 5832, total: 38232 });
    expect(saleLinesPayload([l])[0]).toMatchObject({ qty: 10, rate: 3240, commitment: "annual_yearly" });
  });
  it("Standard / Plus: the list floor ₹12,960 a year; a catalogue price above list is kept", () => {
    expect(shownUnitPrice(saleLineFromItem(STANDARD, "annual_yearly", 1))).toBe(12960);
    expect(shownUnitPrice(saleLineFromItem(PLUS_ABOVE_LIST, "annual_yearly", 1))).toBe(21600);
  });
  it("a typed yearly price (a deal) is stored as typed — no × 12, not locked to the floor", () => {
    const l = saleLineFromItem(E2E_STARTER, "annual_yearly", 10);
    expect(rateFromShownPrice(l, 3000)).toBe(3000);
    expect(rateFromShownPrice(l, 2999.6)).toBe(2999.6);   // R-2095: paise kept (Zoho rates)
  });
  it("Monthly commitment stays ₹/user/month; switching re-prices for the new unit", () => {
    const annual = saleLineFromItem(STANDARD, "annual_yearly", 5);
    const flex = repriceLine(annual, STANDARD, "monthly");
    expect(shownPriceUnit(flex)).toBe("₹/user/month");
    expect(shownUnitPrice(flex)).toBe(1300);
    expect(rateFromShownPrice(flex, 1250)).toBe(1250);
    expect(shownUnitPrice(repriceLine(flex, STANDARD, "annual_yearly"))).toBe(12960);
    /* The stale E2E row is lifted on Monthly too (floorWorkspaceRow floors the monthly msrp). */
    expect(shownUnitPrice(repriceLine(saleLineFromItem(E2E_STARTER, "annual_yearly", 10), E2E_STARTER, "monthly"))).toBe(270);
  });
  it("a line with no catalogue row: the switch keeps the number; ÷12 / ×12 only by the explicit button (R-2178)", () => {
    const loose: SaleLine = { itemId: null, name: "Custom plan", qty: 2, rate: 3250, cost: 0, cycle: "annual_yearly", perSeat: true, monthPriced: true };
    const m = repriceLine(loose, undefined, "monthly");
    expect(m).toMatchObject({ cycle: "monthly", rate: 3250, typedFor: "annual_yearly" });
    const converted = { ...m, ...convertTypedPrice(m) };
    expect(converted).toMatchObject({ cycle: "monthly", rate: 271 });
    expect(repriceLine(m, undefined, "annual_yearly")).toMatchObject({ cycle: "annual_yearly", rate: 3250 });
  });
});
