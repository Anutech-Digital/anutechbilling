/**
 * R-1764 — every subscription line of a quote (and the invoice raised from it) says, under its
 * name, the domain and the period the money buys, as Zoho did:
 *   Domain: dynamicindustries.in
 *   Subscription period: 1 Year (27/10/2026 – 26/10/2027)
 * Pardeep, 22 Oct (renewal quote preview, Dynamic Industries, Business Starter 7 × ₹3,099):
 * "ye renewal quote hai aur product ke description me subscription period show nahi ho raha".
 */
import { describe, it, expect } from "vitest";
import {
  lineSubscriptionNotes, linePeriodText, lineServicePeriod, quoteLinePeriodContext,
  addMonthsIso, termWords,
} from "./service-period";

const starter = {
  name: "Google Workspace - Business Starter ( Email Solutions )",
  commitment: "annual_yearly",
};

describe("renewal quote — the NEXT term after the current one", () => {
  it("owner's example: renewal 26 Oct 2026, annual → 1 Year (27/10/2026 – 26/10/2027)", () => {
    const ctx = quoteLinePeriodContext(
      { is_renewal: true, extension_months: 12, renewal_term_date: "2026-10-26", created_date: "2026-10-22", domain: null },
      "dynamicindustries.in",
    );
    expect(lineSubscriptionNotes(starter, ctx)).toEqual([
      "Domain: dynamicindustries.in",
      "Subscription period: 1 Year (27/10/2026 – 26/10/2027)",
    ]);
  });

  it("a monthly renewal → 1 Month", () => {
    expect(linePeriodText(
      { name: "Hosting", commitment: "monthly" },
      { isRenewal: true, extensionMonths: 1, renewalTermDate: "2026-10-25" },
    )).toBe("Subscription period: 1 Month (26/10/2026 – 25/11/2026)");
  });

  it("a renewal quote without its term date (made before R-1574) → no period, never a guess", () => {
    expect(linePeriodText(starter, { isRenewal: true, extensionMonths: 12, renewalTermDate: null, startFallback: "2026-10-22" })).toBeNull();
  });

  it("monthly line but 12 extension months → conflict, no period", () => {
    expect(linePeriodText({ name: "x", commitment: "monthly" }, { isRenewal: true, extensionMonths: 12, renewalTermDate: "2026-10-25" })).toBeNull();
  });
});

describe("add-seats — pro-rata start → term end", () => {
  it("the window the line names", () => {
    expect(linePeriodText(
      { name: "Business Starter · +1 seats (pro-rata from 2026-09-25 to 2027-08-31)", commitment: "annual_yearly" },
      { isAddSeats: true, startFallback: "2026-09-25" },
    )).toBe("Subscription period: 25/09/2026 – 31/08/2027");
  });

  it("add-seats line without dates → no period", () => {
    expect(linePeriodText(starter, { isAddSeats: true, startFallback: "2026-09-25" })).toBeNull();
  });
});

describe("new quote — start_date, else the quote's date, + one term", () => {
  it("annual line with a start date → 1 Year", () => {
    expect(linePeriodText({ ...starter, start_date: "2026-10-27" }, { startFallback: "2026-10-22" }))
      .toBe("Subscription period: 1 Year (27/10/2026 – 26/10/2027)");
  });

  it("no start date → from the quote's date", () => {
    expect(linePeriodText(starter, { startFallback: "2026-10-22" }))
      .toBe("Subscription period: 1 Year (22/10/2026 – 21/10/2027)");
  });

  it("monthly (flex) → 1 Month", () => {
    expect(linePeriodText({ name: "Flex", commitment: "monthly" }, { startFallback: "2026-01-31" }))
      .toBe("Subscription period: 1 Month (31/01/2026 – 27/02/2026)");
  });
});

describe("no period / no domain where it is not certain", () => {
  it("owner's example: Support Charges (one-time) line → nothing", () => {
    const ctx = { isRenewal: true, extensionMonths: 12, renewalTermDate: "2026-10-26", domain: "dynamicindustries.in" };
    expect(lineSubscriptionNotes({ name: "Support Charges", one_time: true }, ctx)).toEqual([]);
    expect(lineSubscriptionNotes({ name: "Support Charges" }, ctx)).toEqual([]);
  });

  it("a one-off quote → no period", () => {
    expect(lineServicePeriod(starter, { isOneOff: true, startFallback: "2026-10-22" })).toBeNull();
  });

  it("no domain known → only the period line", () => {
    expect(lineSubscriptionNotes(starter, { startFallback: "2026-10-22" })).toEqual([
      "Subscription period: 1 Year (22/10/2026 – 21/10/2027)",
    ]);
  });

  it("the line's own domain wins over the quote's", () => {
    expect(lineSubscriptionNotes({ ...starter, domain: "b.in" }, { domain: "a.in" })[0]).toBe("Domain: b.in");
  });

  it("a bulk line already lists its domains → no Domain line", () => {
    expect(lineSubscriptionNotes(
      { ...starter, bulk: true, domains: [{ domain: "a.in", seats: 1 }] }, { domain: "a.in" },
    )).toEqual([]);
  });

  it("no context (a caller without the quote) → nothing", () => {
    expect(lineSubscriptionNotes(starter, null)).toEqual([]);
  });
});

describe("date helpers", () => {
  it("month end clamps", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2028-01-31", 1)).toBe("2028-02-29");
  });
  it("term words", () => {
    expect([1, 3, 12, 24, 18].map(termWords)).toEqual(["1 Month", "3 Months", "1 Year", "2 Years", "18 Months"]);
  });
});
