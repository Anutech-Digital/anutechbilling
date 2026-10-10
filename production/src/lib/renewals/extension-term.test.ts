/**
 * R-805 — Extend term by months (1, 3, 6, custom 1–11) next to years.
 * Pins: the new renewal date on both stored shapes (inclusive last day, anniversary),
 * years exactly as before, the quote amount through the R-803 paise engine with the R-804
 * GST split, and that the renewal schedule follows the new end date.
 */
import { describe, it, expect } from "vitest";
import {
  extensionCharge, extensionRenewalDate, extensionMonths, extensionLengthError, extensionLabel,
  extensionBlockedReason,
} from "./extension-term";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { isQuoteAmountConsistent, grossAmount } from "@/lib/quotes/amounts";
import {
  currentTermStart, followingTermStart, nextTermSchedule, subscriptionSchedule,
} from "@/lib/billing/subscription-schedule";
import { plannedInstalments } from "@/lib/billing/instalments";

// Inclusive row: term 10 Oct 2025 → last covered day 9 Oct 2026.
const inclusive = { start_date: "2025-10-10", renewal_date: "2026-10-09", term_months: 12 };
// Anniversary row (record_payment's quote sale): start 8 Oct 2025 → renewal 8 Oct 2026.
const anniversary = { start_date: "2025-10-08", renewal_date: "2026-10-08", term_months: 12 };

describe("extensionRenewalDate — months", () => {
  it.each([
    [1, "2026-11-09"],
    [3, "2027-01-09"],
    [6, "2027-04-09"],
    [7, "2027-05-09"],   // custom
    [11, "2027-09-09"],  // custom, the largest
  ])("inclusive row + %i months → %s", (m, want) => {
    expect(extensionRenewalDate(inclusive, { unit: "months", count: m })).toBe(want);
  });

  it.each([
    [1, "2026-11-07"],
    [3, "2027-01-07"],
    [6, "2027-04-07"],
    [5, "2027-03-07"],   // custom
  ])("anniversary row + %i months → %s (inclusive last day of the extension)", (m, want) => {
    expect(extensionRenewalDate(anniversary, { unit: "months", count: m })).toBe(want);
  });

  it("the extended term starts the morning after, on both shapes — no day lost or sold twice", () => {
    for (const sub of [inclusive, anniversary]) {
      const before = followingTermStart(sub);
      const after = extensionRenewalDate(sub, { unit: "months", count: 3 })!;
      // 3 months after the old following-term start
      expect(followingTermStart({ ...sub, renewal_date: after })).toBe(
        sub === inclusive ? "2027-01-10" : "2027-01-08",
      );
      expect(before < after).toBe(true);
    }
  });

  it("month end: a term that started on the 1st runs to the last day of the month", () => {
    const sub = { start_date: "2025-10-01", renewal_date: "2026-09-30", term_months: 12 };
    // plain "+1 month" on 30 Sep would give 30 Oct — one day short
    expect(extensionRenewalDate(sub, { unit: "months", count: 1 })).toBe("2026-10-31");
    expect(extensionRenewalDate(sub, { unit: "months", count: 5 })).toBe("2027-02-28");
  });

  it("no renewal date → null", () => {
    expect(extensionRenewalDate({ ...inclusive, renewal_date: null }, { unit: "months", count: 3 })).toBeNull();
  });
});

describe("extensionRenewalDate — years exactly as before (renewal_date + N × 12 months)", () => {
  it.each([[1, "2027-10-09"], [2, "2028-10-09"], [3, "2029-10-09"]])("inclusive + %i year(s) → %s", (y, want) => {
    expect(extensionRenewalDate(inclusive, { unit: "years", count: y })).toBe(want);
  });
  it("anniversary + 1 year → 8 Oct 2027", () => {
    expect(extensionRenewalDate(anniversary, { unit: "years", count: 1 })).toBe("2027-10-08");
  });
});

describe("extensionCharge", () => {
  // HOK AG-like: Business Starter, 5 seats, ₹1,380/month all seats → ₹3,312/seat/year.
  const base = { seats: 5, mrr: 1380 };

  it("3 months = annual per seat × seats × 3/12 + GST, in paise, rounded once", () => {
    const c = extensionCharge({ ...base, len: { unit: "months", count: 3 } });
    expect(c.annualPerSeat).toBe(3312);
    expect(c.subtotal).toBe(4140);       // 3312 × 5 × 3/12
    expect(c.total).toBe(4885);          // 4140 + 745.20 → 4885.20 → 4885
    expect(c.tax).toBe(745);
    expect(c.subtotal + c.tax).toBe(c.total);
    expect(c.perSeat).toBe(828);
  });

  it.each([1, 3, 6, 7, 11])("%i month(s): subtotal + GST = total; R-804 display tax agrees; quote consistent", (m) => {
    const c = extensionCharge({ seats: 7, mrr: 1933, len: { unit: "months", count: m } });
    expect(c.subtotal + c.tax).toBe(c.total);
    expect(quoteDisplayTax(c.subtotal, 18, c.total)).toBe(c.tax);
    expect(isQuoteAmountConsistent(c.subtotal, 18, c.total)).toBe(true);
    const annualPerSeat = Math.round((1933 * 12) / 7);
    expect(Math.abs(c.subtotal - (annualPerSeat * 7 * m) / 12)).toBeLessThanOrEqual(0.5);
  });

  it("paise rounding: ₹853-style odd figures still add up (rounded once from paise)", () => {
    // 1 seat at ₹1,657/yr for 1 month = ₹138.0833 → 138; GST 24.855 → total 162.94 → 163
    const c = extensionCharge({ seats: 1, mrr: 1657 / 12, len: { unit: "months", count: 1 } });
    expect(c.annualPerSeat).toBe(1657);
    expect(c.subtotal).toBe(138);
    expect(c.total).toBe(163);
    expect(c.tax).toBe(25);
  });

  it.each([1, 2, 3])("%i year(s): unchanged — round(mrr × 12 × years), grossAmount at 18%%", (y) => {
    const c = extensionCharge({ ...base, len: { unit: "years", count: y } });
    const old = Math.max(0, Math.round(1380 * 12 * y));
    expect(c.subtotal).toBe(old);
    expect(c.total).toBe(grossAmount(old, 18));
    expect(c.perSeat).toBe(Math.round(old / 5));
  });

  it("12 months in months would equal 1 year in years (same annual price)", () => {
    const y = extensionCharge({ ...base, len: { unit: "years", count: 1 } });
    const sixTwice = extensionCharge({ ...base, len: { unit: "months", count: 6 } }).subtotal * 2;
    expect(sixTwice).toBe(y.subtotal);
  });
});

describe("length rules", () => {
  it("months 1–11, years 1–5, whole numbers only", () => {
    expect(extensionLengthError({ unit: "months", count: 1 })).toBeNull();
    expect(extensionLengthError({ unit: "months", count: 11 })).toBeNull();
    expect(extensionLengthError({ unit: "months", count: 0 })).toMatch(/between 1 and 11/);
    expect(extensionLengthError({ unit: "months", count: 12 })).toMatch(/between 1 and 11/);
    expect(extensionLengthError({ unit: "months", count: 2.5 })).toMatch(/whole number/);
    expect(extensionLengthError({ unit: "years", count: 5 })).toBeNull();
    expect(extensionLengthError({ unit: "years", count: 6 })).toMatch(/between 1 and 5/);
  });
  it("extension_months and labels", () => {
    expect(extensionMonths({ unit: "years", count: 2 })).toBe(24);
    expect(extensionMonths({ unit: "months", count: 3 })).toBe(3);
    expect(extensionLabel({ unit: "months", count: 1 })).toBe("1 month");
    expect(extensionLabel({ unit: "months", count: 6 })).toBe("6 months");
    expect(extensionLabel({ unit: "years", count: 2 })).toBe("2 years");
  });
});

describe("renewal schedule follows the new end date", () => {
  for (const [name, sub] of [["inclusive", inclusive], ["anniversary", anniversary]] as const) {
    it(`${name}: after +3 months the current term ends on the new date and the next term starts the day after`, () => {
      const row = { ...sub, mrr: 1380, billing_cycle: "yearly" as const };
      const newEnd = extensionRenewalDate(row, { unit: "months", count: 3 })!;
      const after = { ...row, renewal_date: newEnd };

      const current = subscriptionSchedule(after);
      expect(current).toHaveLength(1);
      // current term = 12 months ending on the new inclusive last day
      expect(current[0].periodEnd).toBe(followingTermStart(after));
      expect(current[0].periodStart).toBe(currentTermStart(after));

      const next = nextTermSchedule(after);
      expect(next[0].periodStart).toBe(sub === inclusive ? "2027-01-10" : "2027-01-08");
      expect(next[0].amount).toBe(1380 * 12);

      // yearly is not split-billed — no instalments are laid out, so none can shift
      expect(plannedInstalments(after)).toEqual([]);
    });
  }
});

/* ─── R-807: no extension at all on a subscription billed in parts ─────────────────────
   Proof (local DB, rolled back, 10 Oct 2026): quarterly, 8 seats, mrr ₹2,160, Q1 paid.
   +1 year extension quote paid ₹30,586 → one whole-year PAID invoice. The cron then laid the
   extended year's four quarters and raise_subscription_billing issued them PENDING, ₹7,646
   each (it credits only payments on the ORIGINAL quote) = ₹30,584 demanded twice. The pure
   half of that is pinned below: after the paid extension rolls renewal_date a year, the
   cron's plan IS the extended year — the year the extension quote already charged — and the
   current year's remaining quarters drop out of the plan. */
describe("extensionBlockedReason (R-807)", () => {
  const quarterly = {
    start_date: "2026-10-10", renewal_date: "2027-10-10", term_months: 12,
    mrr: 2160, billing_cycle: "quarterly" as const,
  };

  it("PROOF: a paid +1 year extension makes the cron plan the extended year's 4 quarters", () => {
    expect(plannedInstalments(quarterly)[0].termStart).toBe("2026-10-10");
    const after = { ...quarterly, renewal_date: extensionRenewalDate(quarterly, { unit: "years", count: 1 }) };
    expect(after.renewal_date).toBe("2028-10-10");
    const plan = plannedInstalments(after);
    expect(plan.map((p) => p.billOn)).toEqual(["2027-10-10", "2028-01-10", "2028-04-10", "2028-07-10"]);
    // The same ₹25,920 ex-GST the extension quote charged — a second bill for that year.
    expect(plan.reduce((s, p) => s + p.taxableAmount, 0)).toBe(extensionCharge({ seats: 8, mrr: 2160, len: { unit: "years", count: 1 } }).subtotal);
    // …and nothing of the current year (Q2–Q4 from 10 Jan 2027) is in the plan any more.
    expect(plan.some((p) => p.billOn < "2027-10-10")).toBe(false);
  });

  it.each([
    ["monthly", "monthly"], ["quarterly", "quarterly"], ["half_yearly", "half-yearly"],
  ] as const)("billed %s → refused with the reason", (cycle, word) => {
    expect(extensionBlockedReason(cycle)).toBe(
      `This subscription is billed ${word}, so each part gets its own invoice on its date. An extension quote would bill the same months twice, so it cannot be extended.`,
    );
  });

  it.each(["yearly", null, undefined] as const)("billed %s → allowed", (cycle) => {
    expect(extensionBlockedReason(cycle)).toBeNull();
  });
});
