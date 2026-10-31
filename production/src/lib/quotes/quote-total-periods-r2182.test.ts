/* ─────────────────────────────────────────────────────────────────────────────
   R-2182 — the quote detail Totals card printed the YEAR with "/month" after it.

   Q-F588-27-0068 / Q-F588-27-0052 (local): Starter × 10 at ₹3,240/user/year on an Annual
   commitment = ₹32,400 + 18% GST = ₹38,232 for the year. Paid monthly the page said
   "₹38,232 /month" — twelve times the real ₹3,186. Paid quarterly it said "₹38,232" with no
   unit at all. The PDF and the email already print the right figure from
   lib/quotes/per-period-figures (R-1570); the page now reads the same helper.

   Owner rule (R-2178, 31 Oct): under Annual, the payment frequency never changes the
   per-month rate — only the amount per bill (×1/×3/×6/×12).
   ───────────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteTotalPeriods, quoteTotalPeriodsText } from "./per-period-figures";
import type { BillingCycle } from "@/lib/supabase/database.types";

/* Starter × 10 at ₹3,240/user/year, 18% GST — the local Nayi Company Test quote. */
const annualStarter = (cycle: BillingCycle) => ({
  cycle, lineCommitment: "annual_yearly",
  subtotal: 32400, discount: 0, taxable: 32400, tax: 5832, total: 38232, taxRate: 18,
});

describe("R-2182 quote total per period", () => {
  it("Annual + Quarterly (Q-F588-27-0052): ₹9,558 a quarter and ₹38,232 a year", () => {
    const t = quoteTotalPeriods(annualStarter("quarterly"));
    expect(t).toMatchObject({ perBill: 9558, unit: "quarter", yearTotal: 38232 });
    expect(quoteTotalPeriodsText(t)).toEqual({ perBill: "₹9,558", unit: "/quarter", year: "₹38,232/year" });
  });

  it("Annual + Monthly payment (Q-F588-27-0068): ₹3,186/month · ₹38,232/year — never ₹38,232/month", () => {
    const t = quoteTotalPeriods(annualStarter("monthly"));
    expect(t).toMatchObject({ perBill: 3186, unit: "month", yearTotal: 38232 });
    const text = quoteTotalPeriodsText(t);
    expect(`${text.perBill}${text.unit} · ${text.year}`).toBe("₹3,186/month · ₹38,232/year");
  });

  it("Annual + Yearly: one bill a year — ₹38,232/year only, no second figure", () => {
    const t = quoteTotalPeriods(annualStarter("yearly"));
    expect(t).toMatchObject({ perBill: 38232, unit: "year", yearTotal: null });
    expect(quoteTotalPeriodsText(t)).toEqual({ perBill: "₹38,232", unit: "/year", year: null });
  });

  it("Annual + Half-yearly: ₹19,116 a half-year and the year", () => {
    expect(quoteTotalPeriods(annualStarter("half_yearly"))).toMatchObject({ perBill: 19116, unit: "half-year", yearTotal: 38232 });
  });

  it("R-2178 rule: under Annual the per-month rate is the same whatever the payment frequency", () => {
    const perMonth = (c: BillingCycle) => {
      const t = quoteTotalPeriods(annualStarter(c));
      return t.perBill / ({ monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 } as const)[c];
    };
    expect(new Set((["monthly", "quarterly", "half_yearly", "yearly"] as const).map(perMonth))).toEqual(new Set([3186]));
  });

  it("Monthly flex: the stored total IS one month — per month only, no year figure", () => {
    /* 10 × ₹360/month flex = ₹3,600 + 18% = ₹4,248 a month. */
    const t = quoteTotalPeriods({
      cycle: "monthly", lineCommitment: "monthly",
      subtotal: 3600, discount: 0, taxable: 3600, tax: 648, total: 4248, taxRate: 18,
    });
    expect(t).toMatchObject({ perBill: 4248, unit: "month", yearTotal: null });
    expect(quoteTotalPeriodsText(t)).toEqual({ perBill: "₹4,248", unit: "/month", year: null });
  });

  it("One-time (add seats / one-off / month extension): paid once — no period at all", () => {
    const t = quoteTotalPeriods({ ...annualStarter("monthly"), oneTime: true });
    expect(t).toMatchObject({ perBill: 38232, unit: null, yearTotal: null });
    expect(quoteTotalPeriodsText(t)).toEqual({ perBill: "₹38,232", unit: "", year: null });
  });

  it("old quote with no billing_cycle on an annual line: one yearly bill, not a guess of /month", () => {
    expect(quoteTotalPeriods({ ...annualStarter("yearly"), cycle: null })).toMatchObject({ perBill: 38232, unit: "year", yearTotal: null });
  });

  it("the quote page reads the helper — no '/month' decided by billing_cycle alone", () => {
    const src = readFileSync(join(__dirname, "../../app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(src).toContain("quoteTotalPeriods(");
    expect(src).not.toMatch(/billing_cycle === "monthly" &&[^\n]*\/month/);
  });
});
