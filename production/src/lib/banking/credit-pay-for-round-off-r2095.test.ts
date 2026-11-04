/**
 * R-2095 (30 Oct 2026, September reconcile): a new sale of ₹14,868 paid ₹14,860 — ₹8 short. The
 * drawer offered only "TDS deducted" or "Part payment — ₹8 stays due"; a round-off (≤ ₹50, the item
 * then settled in full — R-2098's rule) was only on the several-items split. Now the single new
 * sale / open item offers it too, and saves through the split RPC (no items left part-paid).
 */
import { describe, it, expect } from "vitest";
import { shortChoices, roundOffSplit, tdsToRecord, type AmountCheck } from "./credit-pay-for";

const short = (shortBy: number, tdsRatePct: number | null = null): AmountCheck => ({ kind: "short", shortBy, tdsRatePct } as AmountCheck);

describe("R-2095 round-off on a single sale / item", () => {
  it("₹8 short → TDS, part payment AND round-off are offered", () => {
    expect(shortChoices(short(8)).map((c) => c.value)).toEqual(["tds", "part", "round_off"]);
    expect(shortChoices(short(8)).find((c) => c.value === "round_off")?.label).toMatch(/Round off ₹8/);
  });
  it("₹51 short → no round-off", () => {
    expect(shortChoices(short(51)).map((c) => c.value)).toEqual(["tds", "part"]);
  });
  it("round-off records no TDS", () => {
    expect(tdsToRecord(short(8), "round_off")).toBe(0);
  });
  it("a new sale → the split call: no items, the sale for its full total, rest round_off", () => {
    expect(roundOffSplit({ mode: "sale", saleTotal: 14868 })).toEqual({ items: [], saleAmount: 14868, rest: "round_off" });
  });
  it("an open item → that item for its full due, rest round_off", () => {
    expect(roundOffSplit({ mode: "item", item: { quote_id: "Q-1", invoice_id: null, amount_due: 25960 } }))
      .toEqual({ items: [{ quote_id: "Q-1", invoice_id: null, amount: 25960 }], saleAmount: null, rest: "round_off" });
  });
});
