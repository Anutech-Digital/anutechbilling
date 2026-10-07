import { describe, it, expect } from "vitest";
import {
  LATE_INTEREST_RATE_PCT, LATE_INTEREST_NOTE_PREFIX,
  lateInterest, interestAlreadyCharged, interestPrincipal, interestToAdd,
  interestDebitNoteGross, interestDebitNoteNote, mayAddLateInterest, lateInterestView,
} from "./late-interest";

const DUE = "2026-10-01";

describe("lateInterest — 18% p.a. simple, per day, whole rupees", () => {
  it("rate is 18% p.a.", () => {
    expect(LATE_INTEREST_RATE_PCT).toBe(18);
  });

  it("nothing before or on the due date", () => {
    expect(lateInterest({ principal: 100_000, dueDate: DUE, payments: [], asOf: "2026-09-20" }).interest).toBe(0);
    expect(lateInterest({ principal: 100_000, dueDate: DUE, payments: [], asOf: DUE })).toEqual({ interest: 0, daysLate: 0, outstanding: 100_000 });
  });

  it("one day late = one day of interest", () => {
    // 1,00,000 × 18% / 365 = 49.315… → ₹49
    expect(lateInterest({ principal: 100_000, dueDate: DUE, payments: [], asOf: "2026-10-02" })).toEqual({ interest: 49, daysLate: 1, outstanding: 100_000 });
  });

  it("365 days late on ₹1,00,000 = ₹18,000", () => {
    expect(lateInterest({ principal: 100_000, dueDate: "2025-10-01", payments: [], asOf: "2026-10-01" }).interest).toBe(18_000);
  });

  it("30 days on ₹50,000 = ₹740 (rounded once at the end, not per day)", () => {
    // 50,000 × 0.18 × 30 / 365 = 739.73 → 740. Per-day rounding would give 30 × 25 = 750.
    expect(lateInterest({ principal: 50_000, dueDate: DUE, payments: [], asOf: "2026-10-31" }).interest).toBe(740);
  });

  it("whole rupees always", () => {
    for (const p of [1, 7, 333, 12_345, 99_999]) {
      const r = lateInterest({ principal: p, dueDate: DUE, payments: [], asOf: "2026-12-17" });
      expect(Number.isInteger(r.interest)).toBe(true);
    }
  });

  it("leap year: 29 Feb is a day, and the year is still 365 days", () => {
    // 28 Feb 2028 → 1 Mar 2028 is 2 days (29 Feb, 1 Mar).
    const r = lateInterest({ principal: 365_000, dueDate: "2028-02-28", payments: [], asOf: "2028-03-01" });
    expect(r.daysLate).toBe(2);
    expect(r.interest).toBe(360); // 365,000 × 18% / 365 = ₹180 a day
    // A whole leap year late = 366 days of interest.
    const y = lateInterest({ principal: 365_000, dueDate: "2027-12-31", payments: [], asOf: "2028-12-31" });
    expect(y.daysLate).toBe(366);
    expect(y.interest).toBe(180 * 366);
  });

  it("partial payment after the due date: interest on the full amount till that day, then on the rest", () => {
    // ₹1,00,000 due 1 Oct. ₹60,000 paid 11 Oct (10 days late on the full sum), then 10 more days on ₹40,000.
    const r = lateInterest({
      principal: 100_000, dueDate: DUE,
      payments: [{ amount: 60_000, date: "2026-10-11" }],
      asOf: "2026-10-21",
    });
    // (1,00,000 × 10 + 40,000 × 10) × 0.18 / 365 = 690.41 → 690
    expect(r.interest).toBe(690);
    expect(r.outstanding).toBe(40_000);
    expect(r.daysLate).toBe(20);
  });

  it("a payment on day D stops interest from day D+1 (day D itself is a late day)", () => {
    const paidNextDay = lateInterest({
      principal: 100_000, dueDate: DUE, payments: [{ amount: 100_000, date: "2026-10-02" }], asOf: "2026-10-30",
    });
    expect(paidNextDay.interest).toBe(49);
    expect(paidNextDay.outstanding).toBe(0);
  });

  it("paid in full on or before due → no interest ever", () => {
    const r = lateInterest({
      principal: 100_000, dueDate: DUE, payments: [{ amount: 100_000, date: "2026-09-30" }], asOf: "2027-01-01",
    });
    expect(r).toEqual({ interest: 0, daysLate: 0, outstanding: 0 });
  });

  it("part paid before due → interest only on the rest", () => {
    const r = lateInterest({
      principal: 100_000, dueDate: DUE, payments: [{ amount: 50_000, date: "2026-09-25" }], asOf: "2026-10-02",
    });
    expect(r.interest).toBe(25); // 50,000 × 18% / 365 = 24.66 → 25
  });

  it("payments out of order, over-payment and zero/negative amounts are handled", () => {
    const r = lateInterest({
      principal: 10_000, dueDate: DUE,
      payments: [
        { amount: 20_000, date: "2026-10-21" },
        { amount: -5, date: "2026-10-05" },
        { amount: 0, date: "2026-10-06" },
      ],
      asOf: "2026-12-31",
    });
    // 20 late days on ₹10,000, then nothing left.
    expect(r.interest).toBe(Math.round((10_000 * 20 * 18) / 36_500));
    expect(r.outstanding).toBe(0);
  });

  it("no due date, zero principal or bad dates → zero, never NaN", () => {
    expect(lateInterest({ principal: 0, dueDate: DUE, payments: [], asOf: "2026-12-01" }).interest).toBe(0);
    expect(lateInterest({ principal: 1000, dueDate: "", payments: [], asOf: "2026-12-01" }).interest).toBe(0);
    expect(lateInterest({ principal: Number.NaN, dueDate: DUE, payments: [], asOf: "2026-12-01" }).interest).toBe(0);
  });
});

describe("what has already been charged (interest debit notes)", () => {
  const notes = [
    { amount: 59, taxable_value: 50, notes: `${LATE_INTEREST_NOTE_PREFIX} through 2026-10-10 @18% p.a.` },
    { amount: 1180, taxable_value: 1000, notes: "Price escalation" },
    { amount: 12, taxable_value: 10, notes: null },
  ];
  it("only our tagged debit notes count", () => {
    expect(interestAlreadyCharged(notes)).toEqual({ taxable: 50, gross: 59 });
  });
  it("principal = invoice total minus the interest debit notes (interest is not charged on interest)", () => {
    expect(interestPrincipal({ amount: 100_000, net_payable: 100_059 }, notes)).toBe(100_000);
    expect(interestPrincipal({ amount: 100_000, net_payable: null }, [])).toBe(100_000);
  });
  it("to add = interest so far minus what is already on a debit note, never negative", () => {
    expect(interestToAdd(740, { taxable: 50 })).toBe(690);
    expect(interestToAdd(40, { taxable: 50 })).toBe(0);
  });
});

describe("the debit note", () => {
  it("gross = interest + GST at the invoice's rate, and the RPC's split gives the interest back", () => {
    expect(interestDebitNoteGross(100, 18)).toBe(118);
    expect(interestDebitNoteGross(100, 0)).toBe(100);
    expect(interestDebitNoteGross(100, null)).toBe(118);
    // issue_debit_note: taxable = round(gross × 100 / (100 + rate)). Must round-trip for every rupee.
    for (let x = 1; x <= 5000; x++) {
      const g = interestDebitNoteGross(x, 18);
      expect(Math.round((g * 100) / 118)).toBe(x);
    }
  });
  it("note carries the tag, the period and the rate", () => {
    const n = interestDebitNoteNote({ dueDate: "2026-10-01", asOf: "2026-10-31", interest: 740 });
    expect(n.startsWith(LATE_INTEREST_NOTE_PREFIX)).toBe(true);
    expect(n).toContain("2026-10-01");
    expect(n).toContain("2026-10-31");
    expect(n).toContain("18%");
  });
  it("only owner and billing may add it", () => {
    expect(mayAddLateInterest("owner")).toBe(true);
    expect(mayAddLateInterest("billing")).toBe(true);
    expect(mayAddLateInterest("sales")).toBe(false);
    expect(mayAddLateInterest("manager")).toBe(false);
    expect(mayAddLateInterest(null)).toBe(false);
  });
});

describe("lateInterestView (what the quote shows)", () => {
  const invoice = { amount: 50_000, net_payable: 50_000, due_date: "2026-10-01" };
  it("not late yet → nothing shown", () => {
    expect(lateInterestView({ invoice, payments: [], notes: [], today: "2026-10-01" })).toBeNull();
    expect(lateInterestView({ invoice: { ...invoice, due_date: null }, payments: [], notes: [], today: "2026-12-01" })).toBeNull();
  });
  it("30 days late → ₹740 so far, all of it to add", () => {
    expect(lateInterestView({ invoice, payments: [], notes: [], today: "2026-10-31" }))
      .toEqual({ soFar: 740, charged: 0, toAdd: 740, daysLate: 30, dueDate: "2026-10-01" });
  });
  it("after a debit note: principal excludes it, only the new part is to add", () => {
    const notes = [{ amount: 873, taxable_value: 740, notes: `${LATE_INTEREST_NOTE_PREFIX} @18% p.a. simple, 2026-10-01 to 2026-10-31` }];
    const v = lateInterestView({ invoice: { ...invoice, net_payable: 50_873 }, payments: [], notes, today: "2026-11-30" });
    // 60 days on ₹50,000 = 1479.45 → 1479; 740 already charged.
    expect(v).toEqual({ soFar: 1479, charged: 740, toAdd: 739, daysLate: 60, dueDate: "2026-10-01" });
  });
  it("paid late in full: interest stays visible until it is charged", () => {
    const v = lateInterestView({ invoice, payments: [{ amount: 50_000, date: "2026-10-11" }], notes: [], today: "2026-12-01" });
    expect(v?.soFar).toBe(247); // 10 days: 50,000 × 0.18 × 10 / 365 = 246.58
    expect(v?.toAdd).toBe(247);
  });
});
