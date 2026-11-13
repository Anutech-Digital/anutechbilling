/** R-2712 — a NEW-sale line registered for several years (`years`, normal or bulk) prints its real
 *  period on the quote, PDF, accept page, email and the tax invoice: it said "1 Year" on a 3-year price. */
import { describe, it, expect } from "vitest";
import { linePeriodText, lineServicePeriod, quoteServicePeriod, servicePeriodText } from "./service-period";

const NEW_SALE = { startFallback: "2026-11-13" };

describe("R-2712 line period follows `years` on a new sale", () => {
  it("bulk line, 3 years from 1 Sep 2026 → 3 Years (01/09/2026 – 31/08/2029)", () => {
    expect(linePeriodText({ name: "Domain .in", commitment: "annual_yearly", bulk: true, years: 3, start_date: "2026-09-01",
      domains: [{ domain: "a1.in", seats: 1 }] }, NEW_SALE)).toBe("Subscription period: 3 Years (01/09/2026 – 31/08/2029)");
  });
  it("a normal domain line with years 2 and no start date → from the quote's date", () => {
    expect(linePeriodText({ name: "Domain acme.in", commitment: "annual_yearly", years: 2 }, NEW_SALE))
      .toBe("Subscription period: 2 Years (13/11/2026 – 12/11/2028)");
  });
  it("29 Feb 2028 + 3 years ends 27 Feb 2031 (renewal 28 Feb 2031, as the database files it)", () => {
    expect(lineServicePeriod({ name: "Domain .in", commitment: "annual_yearly", years: 3, start_date: "2028-02-29" }, NEW_SALE))
      .toEqual({ from: "2028-02-29", to: "2031-02-27", months: 36 });
  });
  it("no years / years 1 / a bad value → one year, as before", () => {
    for (const years of [undefined, 1, 0, 11, 2.5]) {
      expect(linePeriodText({ name: "Domain .in", commitment: "annual_yearly", years, start_date: "2026-09-01" }, NEW_SALE))
        .toBe("Subscription period: 1 Year (01/09/2026 – 31/08/2027)");
    }
  });
  it("a monthly line ignores years", () => {
    expect(linePeriodText({ name: "Flex", commitment: "monthly", years: 3, start_date: "2026-09-01" }, NEW_SALE))
      .toBe("Subscription period: 1 Month (01/09/2026 – 30/09/2026)");
  });
  it("renewal / add-seats / one-time lines are unchanged by years", () => {
    expect(linePeriodText({ name: "Domain .in", commitment: "annual_yearly", years: 3 },
      { isRenewal: true, extensionMonths: 12, renewalTermDate: "2026-11-30" }))
      .toBe("Subscription period: 1 Year (01/12/2026 – 30/11/2027)");
    expect(linePeriodText({ name: "Seats (pro-rata from 2026-09-25 to 2027-08-31)", commitment: "annual_yearly", years: 3 }, { isAddSeats: true }))
      .toBe("Subscription period: 25/09/2026 – 31/08/2027");
    expect(linePeriodText({ name: "Setup", one_time: true, years: 3 }, NEW_SALE)).toBeNull();
  });
});

describe("R-2712 'covers …' on a new quote follows `years`", () => {
  it("every term line is 3 years → covers 3 years", () => {
    expect(servicePeriodText(quoteServicePeriod({ lines: [{ name: "Domain .in", commitment: "annual_yearly", years: 3 }] })))
      .toBe("covers 3 years");
  });
  it("a 3-year line next to a 1-year line → no single claim", () => {
    expect(quoteServicePeriod({ lines: [
      { name: "Domain .in", commitment: "annual_yearly", years: 3 },
      { name: "Google Workspace", commitment: "annual_yearly" },
    ] })).toBeNull();
  });
  it("no years anywhere → covers 12 months, as before", () => {
    expect(servicePeriodText(quoteServicePeriod({ lines: [{ name: "Google Workspace", commitment: "annual_yearly" }] })))
      .toBe("covers 12 months");
  });
});
