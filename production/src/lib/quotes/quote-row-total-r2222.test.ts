/* ─────────────────────────────────────────────────────────────────────────────
   R-2222 — the /quotes LIST put "/mo" after the YEAR's total (same bug as R-2182 on the
   quote page). Q-F588-27-0068: Starter × 10 at ₹3,240/user/year, Annual, paid monthly =
   ₹38,232 a year; the list row read "₹38,232/mo". Q-F588-27-0052 (paid quarterly) read
   "₹38,232" with no unit. The row now reads the same helper as the quote page:
   one bill with its period + "₹38,232/year" under it.
   ───────────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteRowTotalPeriods, quoteTotalPeriodsText } from "./per-period-figures";

/* The row exactly as the list reads it (select * from quotes). */
const row = (billing_cycle: string | null, over: Record<string, unknown> = {}) => ({
  amount: 38232, subtotal: 32400, discount_pct: 0, tax_rate: 18, billing_cycle,
  line_items: [{ name: "Google Workspace Business Starter", qty: 10, rate: 3240, commitment: "annual_yearly" }],
  is_add_seats: false, is_one_off: false, is_extension: false, extension_months: null,
  ...over,
});
const text = (q: ReturnType<typeof row>) => {
  const t = quoteRowTotalPeriods(q);
  return t && quoteTotalPeriodsText(t);
};

describe("R-2222 /quotes list row total", () => {
  it("Q-F588-27-0068 Annual + Monthly payment: ₹3,186/month and ₹38,232/year — never ₹38,232/mo", () => {
    expect(text(row("monthly"))).toEqual({ perBill: "₹3,186", unit: "/month", year: "₹38,232/year" });
  });

  it("Q-F588-27-0052 Annual + Quarterly: ₹9,558/quarter and ₹38,232/year", () => {
    expect(text(row("quarterly"))).toEqual({ perBill: "₹9,558", unit: "/quarter", year: "₹38,232/year" });
  });

  it("Annual + Yearly: ₹38,232/year only", () => {
    expect(text(row("yearly"))).toEqual({ perBill: "₹38,232", unit: "/year", year: null });
  });

  it("Monthly flex: the stored total is one month — /month only", () => {
    expect(text(row("monthly", {
      amount: 4248, subtotal: 3600,
      line_items: [{ name: "Starter", qty: 10, rate: 360, commitment: "monthly" }],
    }))).toEqual({ perBill: "₹4,248", unit: "/month", year: null });
  });

  it("one-time (add seats / direct invoice / month extension): no period (R-1715)", () => {
    for (const over of [{ is_add_seats: true }, { is_one_off: true }, { is_extension: true, extension_months: 3 }]) {
      expect(text(row("yearly", over))).toEqual({ perBill: "₹38,232", unit: "", year: null });
    }
  });

  it("no billing_cycle and no line commitment: no guessed unit (R-1715)", () => {
    expect(text(row(null, { line_items: [{ name: "x", qty: 1, rate: 32400 }] }))?.unit).toBe("");
  });

  it("no amount: nothing to show", () => {
    expect(quoteRowTotalPeriods(row("monthly", { amount: null }))).toBeNull();
  });

  it("the list page reads the helper, not the cycle-only quoteTotalUnit", () => {
    const src = readFileSync(join(__dirname, "../../app/(app)/quotes/page.tsx"), "utf8");
    expect(src).toContain("quoteRowTotalPeriods(");
    expect(src).not.toContain("quoteTotalUnit");
  });
});
