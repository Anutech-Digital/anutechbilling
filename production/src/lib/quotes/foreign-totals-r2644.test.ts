// R-2644 — a USD quote whose exchange rate is changed after a catalogue line was added showed
// "Quote discount (0%) −$0.00" although price = list. 10 seats × $48 @ 94.8755: rate = list_rate =
// ₹4,554.024 (R-2637 keeps the paise), the subtotal is the per-line rupee round 10 × 4554.024 =
// ₹45,540, but the builder's list gross was the UNROUNDED ₹45,540.24 → a ₹0.24 "discount".
// The list gross must be rounded per line by the SAME rule as the subtotal (lineInr).
import { describe, it, expect } from "vitest";
import { inrRateFromForeign, linesInrListGross, linesInrSubtotal } from "./foreign-totals";
import { lineEconomics } from "./approval-economics";
import { discountBps, requiredApproval } from "./approval";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const FX = 94.8755;
const year = inrRateFromForeign(48, FX);   // 4554.024

describe("R-2644: list gross is rounded per line like the subtotal", () => {
  it("94.8755: price = list → list gross equals the subtotal (no ₹0.24 'discount')", () => {
    expect(year).toBe(4554.024);
    const lines = [{ qty: 10, rate: year, list_rate: year }];
    expect(linesInrSubtotal(lines)).toBe(45540);
    expect(linesInrListGross(lines)).toBe(45540);
  });

  it("a line without list_rate falls back to its rate", () => {
    expect(linesInrListGross([{ qty: 10, rate: year }])).toBe(45540);
  });

  it("several USD lines: each line rounded once, then summed (same as the subtotal)", () => {
    const a = inrRateFromForeign(2, 95.1), b = inrRateFromForeign(48, FX);
    const lines = [{ qty: 5, rate: a, list_rate: a }, { qty: 3, rate: b, list_rate: b }];
    expect(linesInrListGross(lines)).toBe(linesInrSubtotal(lines));
  });

  it("a real discount still shows: $2.80 on a $4 list", () => {
    const list = inrRateFromForeign(48, FX), rate = inrRateFromForeign(2.8 * 12, FX);
    const lines = [{ qty: 10, rate, list_rate: list }];
    expect(linesInrListGross(lines) - linesInrSubtotal(lines)).toBe(45540 - 31878);
  });

  it("whole-rupee INR lines unchanged", () => {
    expect(linesInrListGross([{ qty: 3, rate: 900, list_rate: 1000 }])).toBe(3000);
  });

  it("approval: price = list at 94.8755 → 0 bps, no approval (client maths; SQL twin quote_lines_approval_bps is the same sum)", () => {
    const line: QuoteLineItem = { id: "a", item_id: "X", name: "Seat", qty: 10, rate: year, list_rate: year, cost: 2846, commitment: "annual_yearly" };
    expect(discountBps(lineEconomics([line]))).toBe(0);
    expect(requiredApproval(lineEconomics([line])).tier).toBe("none");
  });
});
