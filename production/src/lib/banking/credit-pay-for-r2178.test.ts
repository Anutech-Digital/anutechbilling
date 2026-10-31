/* R-2178 — staging reconcile 31 Oct (LOOK BOOK FLY, Q-A378-27-0241): 7 users at a typed ₹1,800/user/year
   became ₹21,600 after the Commitment was switched (via One-time → Monthly flex → Annual), and the
   quote was ₹1,78,416 instead of ₹14,868. Rule now: a typed price NEVER changes when Commitment
   changes. If the unit changed (₹/year ↔ ₹/month) the line says so and offers the ÷12 / ×12
   conversion as an explicit button, which can be undone; the sale cannot be saved until the
   operator either converts or keeps the number. */
import { describe, expect, it } from "vitest";
import {
  convertTypedPrice, keepTypedPrice, rateFromShownPrice, repriceLine, saleLineFromItem, salePreview,
  typedPriceCheck, undoTypedConversion, type SaleLine,
} from "./credit-pay-for";

const STARTER = {
  id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
  item_type: "subscription", prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
} as never;
/** What the price box does when the operator types (the section's onChange). */
const type = (l: SaleLine, shown: number): SaleLine => ({ ...l, rate: rateFromShownPrice(l, shown), priceTyped: true, typedFor: l.cycle, convertedFrom: undefined });
const apply = (l: SaleLine, patch: Partial<SaleLine>): SaleLine => ({ ...l, ...patch });

describe("R-2178 (1) a typed price never changes silently on a Commitment switch", () => {
  it("owner's path: 7 × ₹1,800/year, Annual → One-time → Monthly flex → Annual keeps ₹1,800 and ₹14,868", () => {
    let l = type(saleLineFromItem(STARTER, "annual_yearly", 7), 1800);
    l = repriceLine(l, STARTER, "one_time");
    expect(l.rate).toBe(1800);
    l = repriceLine(l, STARTER, "monthly");
    expect(l.rate).toBe(1800);
    l = repriceLine(l, STARTER, "annual_yearly");
    expect(l).toMatchObject({ cycle: "annual_yearly", rate: 1800 });
    expect(typedPriceCheck(l)).toBeNull();
    expect(salePreview([l], 18)).toEqual({ taxable: 12600, gst: 2268, total: 14868 });
  });
  it("typed under Monthly flex, then switched to Annual: the number stays (no × 12) and the line asks", () => {
    let l = type(saleLineFromItem(STARTER, "monthly", 7), 1800);
    l = repriceLine(l, STARTER, "annual_yearly");
    expect(l.rate).toBe(1800);
    const check = typedPriceCheck(l);
    expect(check).toMatchObject({ kind: "unit_changed", convertRate: 21600, blocksSave: true });
    expect(check?.text).toBe("₹1,800 was typed as ₹/user/month. The line is now ₹/user/year — the number was kept.");
  });
  it("Annual 3000 → Monthly flex: kept at 3000; explicit ÷ 12 gives 250; Undo gives 3000 back", () => {
    let l = repriceLine(type(saleLineFromItem(STARTER, "annual_yearly", 10), 3000), STARTER, "monthly");
    expect(l.rate).toBe(3000);
    expect(typedPriceCheck(l)).toMatchObject({ kind: "unit_changed", convertRate: 250, convertLabel: "Use ₹250/user/month (₹3,000 ÷ 12)", keepLabel: "Keep ₹3,000/user/month" });
    l = apply(l, convertTypedPrice(l));
    expect(l.rate).toBe(250);
    expect(typedPriceCheck(l)).toMatchObject({ kind: "converted", blocksSave: false, undoLabel: "Undo — back to ₹3,000" });
    l = apply(l, undoTypedConversion(l));
    expect(l.rate).toBe(3000);
    expect(typedPriceCheck(l)).toMatchObject({ kind: "unit_changed", blocksSave: true });
  });
  it("Keep: the number is confirmed in the new unit and the question goes away", () => {
    let l = repriceLine(type(saleLineFromItem(STARTER, "annual_yearly", 10), 3000), STARTER, "monthly");
    l = apply(l, keepTypedPrice(l));
    expect(l.rate).toBe(3000);
    expect(typedPriceCheck(l)).toBeNull();
  });
  it("switching straight back needs no answer and changes nothing", () => {
    const a = type(saleLineFromItem(STARTER, "annual_yearly", 10), 3000);
    const back = repriceLine(repriceLine(a, STARTER, "monthly"), STARTER, "annual_yearly");
    expect(back.rate).toBe(3000);
    expect(typedPriceCheck(back)).toBeNull();
  });
  it("to or from One-time there is no conversion to offer, only Keep", () => {
    const o = repriceLine(type(saleLineFromItem(STARTER, "annual_yearly", 1), 3000), STARTER, "one_time");
    expect(typedPriceCheck(o)).toMatchObject({ kind: "unit_changed", convertRate: null, convertLabel: null });
  });
  it("a line with no catalogue row keeps its number too (it is the operator's only price)", () => {
    const loose: SaleLine = { itemId: null, name: "Custom plan", qty: 2, rate: 3250, cost: 0, cycle: "annual_yearly", perSeat: true, monthPriced: true };
    const m = repriceLine(repriceLine(loose, undefined, "one_time"), undefined, "monthly");
    const a = repriceLine(m, undefined, "annual_yearly");
    expect([m.rate, a.rate]).toEqual([3250, 3250]);
  });
  it("an untouched catalogue line still takes the catalogue price (nothing was typed)", () => {
    const m = repriceLine(saleLineFromItem(STARTER, "annual_yearly", 10), STARTER, "monthly");
    expect(m.rate).toBe(325);
    expect(typedPriceCheck(m)).toBeNull();
  });
});
