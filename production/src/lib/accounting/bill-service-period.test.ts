/**
 * R-2623 — a vendor bill's service period (the month(s) the licence was used), as the owner sees
 * and sets it on the bill. The period itself is worked out in SQL (vendor_bill_service_period,
 * R-2156); this file only turns month pickers into the saved dates and back, words the basis, and
 * maps the database's constraint error to plain English.
 */
import { describe, expect, it } from "vitest";
import {
  SERVICE_PERIOD_RULE_TEXT,
  monthsToPeriod,
  periodToMonths,
  servicePeriodBasisText,
  servicePeriodErrorText,
  servicePeriodLabel,
  servicePeriodShowsInList,
} from "./bill-service-period";

describe("months to dates", () => {
  it("one month -> 1st .. last day (Aug 2026)", () => {
    expect(monthsToPeriod("2026-08", "2026-08")).toEqual({ ok: true, service_from: "2026-08-01", service_to: "2026-08-31" });
  });
  it("range -> 1st of the first .. last day of the last (Jul-Sep 2026)", () => {
    expect(monthsToPeriod("2026-07", "2026-09")).toEqual({ ok: true, service_from: "2026-07-01", service_to: "2026-09-30" });
  });
  it("February in a leap year ends on the 29th", () => {
    expect(monthsToPeriod("2028-02", "2028-02")).toEqual({ ok: true, service_from: "2028-02-01", service_to: "2028-02-29" });
  });
  it("across a year end", () => {
    expect(monthsToPeriod("2026-11", "2027-01")).toEqual({ ok: true, service_from: "2026-11-01", service_to: "2027-01-31" });
  });
  it("36 months is the most (same as the database check)", () => {
    expect(monthsToPeriod("2026-01", "2028-12").ok).toBe(true);
  });
});

describe("validate — the form refuses what the database would refuse", () => {
  it("To before From", () => {
    const r = monthsToPeriod("2026-09", "2026-08");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("The last month must be the same as or after the first month.");
  });
  it("only one month filled", () => {
    for (const [a, b] of [["2026-09", ""], ["", "2026-09"]] as const) {
      const r = monthsToPeriod(a, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Pick both the first and the last month.");
    }
  });
  it("over 36 months", () => {
    const r = monthsToPeriod("2026-01", "2029-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("A service period can be at most 36 months.");
  });
  it("not a month", () => {
    const r = monthsToPeriod("2026-13", "2026-13");
    expect(r.ok).toBe(false);
  });
});

describe("dates back to month pickers", () => {
  it("reads the saved dates", () => {
    expect(periodToMonths("2026-07-01", "2026-09-30")).toEqual({ from: "2026-07", to: "2026-09" });
  });
  it("clear — empty when nothing is saved", () => {
    expect(periodToMonths(null, null)).toEqual({ from: "", to: "" });
  });
});

describe("label", () => {
  it("one month", () => expect(servicePeriodLabel("2026-09-01", "2026-09-30")).toBe("Sep 2026"));
  it("months in one year", () => expect(servicePeriodLabel("2026-07-01", "2026-09-30")).toBe("Jul–Sep 2026"));
  it("across a year end", () => expect(servicePeriodLabel("2026-11-01", "2027-01-31")).toBe("Nov 2026 – Jan 2027"));
  it("nothing", () => expect(servicePeriodLabel(null, null)).toBe(""));
});

describe("auto label — the basis in words", () => {
  it("set by the owner", () => expect(servicePeriodBasisText("set")).toBe("set on the bill"));
  it("month named on the bill", () => expect(servicePeriodBasisText("reference")).toBe("auto (read from the bill text)"));
  it("Google / Microsoft default", () =>
    expect(servicePeriodBasisText("vendor_default")).toBe("auto (Google / Microsoft bill: month before the bill date)"));
  it("bill month", () => expect(servicePeriodBasisText("bill_month")).toBe("auto (bill month)"));
});

describe("db error text", () => {
  it("the raw check-constraint error becomes the rule in plain English", () => {
    const err = { message: 'new row for relation "vendor_bills" violates check constraint "vendor_bills_service_period_check"', code: "23514" };
    expect(servicePeriodErrorText(err)).toBe(SERVICE_PERIOD_RULE_TEXT);
    expect(SERVICE_PERIOD_RULE_TEXT).not.toMatch(/constraint|vendor_bills|check/i);
  });
  it("any other error is left alone", () => {
    expect(servicePeriodErrorText(new Error("Books 31 Oct 2026 tak lock hain"))).toBeNull();
    expect(servicePeriodErrorText(null)).toBeNull();
  });
});

describe("list shows 'for <month>' only when it is not the bill's own month", () => {
  it("Google bill dated 7 Oct for Sep -> shown", () =>
    expect(servicePeriodShowsInList("2026-10-07", "2026-09-01", "2026-09-30")).toBe(true));
  it("bill month -> not shown (nothing new to say)", () =>
    expect(servicePeriodShowsInList("2026-10-07", "2026-10-01", "2026-10-31")).toBe(false));
  it("a range starting in the bill month -> shown", () =>
    expect(servicePeriodShowsInList("2026-10-07", "2026-10-01", "2026-12-31")).toBe(true));
  it("unknown -> not shown", () => expect(servicePeriodShowsInList("2026-10-07", null, null)).toBe(false));
});
