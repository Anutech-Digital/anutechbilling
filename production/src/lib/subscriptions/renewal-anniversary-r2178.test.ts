/* R-2178 (3) — one renewal-date rule (coordinator decision, 31 Oct, on Pardeep's behalf):
   renewal_date is the NEXT term's start and the next bill date = start + term months (the
   anniversary, Zoho's next period start: period 03/08/2026–02/08/2027, next starts 03/08/2027).
   "Term ends" = renewal − 1 day, for display only. Before: Correct details (commitment change and
   start-date edit) wrote start + 12m − 1d (termEndInclusive) while the sale form and record_payment
   wrote start + 12m — Venus got 31 Jul 2027 from 1 Aug 2026; Think Beyond got 2 Aug 2027. */
import { describe, expect, it } from "vitest";
import { commitmentRenewal, commitmentVerdict } from "./commitment-change";

describe("R-2178 commitment change writes the anniversary", () => {
  it("Venus: Flexible from 1 Aug 2026 → Annual renews 1 Aug 2027 (not 31 Jul 2027)", () => {
    expect(commitmentRenewal({ startDate: "2026-08-01", renewalDate: "2026-11-01", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-31" }))
      .toBe("2027-08-01");
  });
  it("an old inclusive-shaped Flexible renewal reads the same way", () => {
    expect(commitmentRenewal({ startDate: "2026-08-01", renewalDate: "2026-10-31", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-31" }))
      .toBe("2027-08-01");
  });
  it("a flex sub older than a year lands on the anniversary of the annual term that covers today", () => {
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-11-15", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-30" }))
      .toBe("2027-06-15");
  });
  it("on the anniversary day itself the NEXT annual term is the one running", () => {
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-07-15", termMonthsNow: 1, termMonthsNext: 12, today: "2026-06-15" }))
      .toBe("2027-06-15");
  });
  it("month-end start clamps (31 Jan → 31 Jan next year; 29 Feb → 28 Feb)", () => {
    expect(commitmentRenewal({ startDate: "2026-01-31", renewalDate: "2026-11-30", termMonthsNow: 1, termMonthsNext: 12, today: "2026-11-10" }))
      .toBe("2027-01-31");
    expect(commitmentRenewal({ startDate: "2028-02-29", renewalDate: "2028-04-29", termMonthsNow: 1, termMonthsNext: 12, today: "2028-04-10" }))
      .toBe("2029-02-28");
  });
  it("Annual → Flexible after the annual term ended: renews on the next term's start (anniversary or old inclusive row)", () => {
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-06-15", termMonthsNow: 12, termMonthsNext: 1, today: "2026-10-30" }))
      .toBe("2026-06-15");
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-06-14", termMonthsNow: 12, termMonthsNext: 1, today: "2026-10-30" }))
      .toBe("2026-06-15");
  });
});

describe("R-2178 mid-term reduce check reads an anniversary renewal right", () => {
  const base = { role: "owner", termMonthsNow: 12, termMonthsNext: 1, cycleNow: "yearly", cycleNext: "monthly" as const, startDate: "2026-08-03" };
  it("running term: blocked, and says the last covered day (renewal − 1)", () => {
    const v = commitmentVerdict({ ...base, renewalDate: "2027-08-03", today: "2027-08-02" });
    expect(v.block).toMatch(/committed until 2027-08-02/);
  });
  it("on the anniversary the term has ended — not blocked", () => {
    expect(commitmentVerdict({ ...base, renewalDate: "2027-08-03", today: "2027-08-03" }).block).toBeNull();
  });
});
