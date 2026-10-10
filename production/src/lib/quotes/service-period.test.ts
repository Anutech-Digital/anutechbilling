/**
 * R-806 — a quote's "covers ..." line states the period the payment really buys.
 * Q-F588-27-0007 (1 seat, 340 days pro-rata) said "covers full 12 months of service".
 */
import { describe, it, expect } from "vitest";
import {
  quoteServicePeriod, servicePeriodText, lineDateRange, periodDate, monthsWords,
} from "./service-period";

type In = Parameters<typeof quoteServicePeriod>[0];
const text = (i: In) => servicePeriodText(quoteServicePeriod(i));

describe("add-seats / pro-rata", () => {
  it("one pro-rata line → its own dates, not 12 months", () => {
    expect(text({
      isAddSeats: true,
      lines: [{ name: "Business Starter · +1 seats (pro-rata from 2026-09-25 to 2027-08-31)", commitment: "annual_yearly" }],
    })).toBe("covers 25 Sep 2026 to 31 Aug 2027");
  });

  it("previous term + current term lines → earliest from, latest to", () => {
    expect(text({
      isAddSeats: true,
      lines: [
        { name: "Starter · +2 seats (previous term, pro-rata from 2025-08-01 to 2025-09-14)", commitment: "annual_yearly" },
        { name: "Starter · +2 seats (current term 2025-09-15 to 2026-04-01)", commitment: "annual_yearly" },
      ],
    })).toBe("covers 1 Aug 2025 to 1 Apr 2026");
  });

  it("dates win even without the flag (the builder has no flags)", () => {
    expect(text({ lines: [{ name: "X · +1 seats (pro-rata from 2026-10-10 to 2027-04-01)", commitment: "annual_yearly" }] }))
      .toBe("covers 10 Oct 2026 to 1 Apr 2027");
  });

  it("add-seats quote with no dates on its lines → no claim", () => {
    expect(text({ isAddSeats: true, lines: [{ name: "Starter · +1 seats", commitment: "annual_yearly" }] })).toBeNull();
  });

  it("one dated term line and one undated term line → no claim", () => {
    expect(text({ lines: [
      { name: "X (pro-rata from 2026-10-10 to 2027-04-01)", commitment: "annual_yearly" },
      { name: "Business Plus", commitment: "annual_yearly" },
    ] })).toBeNull();
  });

  it("a one-time service line beside the pro-rata line does not hide the dates", () => {
    expect(text({ lines: [
      { name: "X (pro-rata from 2026-10-10 to 2027-04-01)", commitment: "annual_yearly" },
      { name: "Data migration", commitment: null },
    ] })).toBe("covers 10 Oct 2026 to 1 Apr 2027");
  });
});

describe("yearly", () => {
  it("new annual quote → 12 months", () => {
    expect(text({ lines: [{ name: "Business Starter", commitment: "annual_yearly" }] })).toBe("covers 12 months");
  });
  it("annual billed in parts is still a 12-month term", () => {
    expect(text({ lines: [{ name: "Business Starter", commitment: "annual_quarterly" }] })).toBe("covers 12 months");
  });
  it("1-year renewal → 12 months", () => {
    expect(text({ isRenewal: true, extensionMonths: 12, lines: [{ name: "Starter", commitment: "annual_yearly" }] }))
      .toBe("covers 12 months");
  });
});

describe("multi-year", () => {
  it("2-year extension (flagged) → 2 years", () => {
    expect(text({ isRenewal: true, isExtension: true, extensionMonths: 24,
      lines: [{ name: "Starter · 2-year extension", commitment: "annual_yearly" }] })).toBe("covers 2 years");
  });
  it("3-year extension read from the line name in the builder → 3 years", () => {
    expect(text({ lines: [{ name: "Starter · 3-year extension", commitment: "annual_yearly" }] })).toBe("covers 3 years");
  });
  it("monthsWords", () => {
    expect(monthsWords(24)).toBe("2 years");
    expect(monthsWords(12)).toBe("12 months");
    expect(monthsWords(18)).toBe("18 months");
    expect(monthsWords(1)).toBe("1 month");
  });
});

describe("monthly", () => {
  it("flex quote → 1 month", () => {
    expect(text({ lines: [{ name: "Starter (flex)", commitment: "monthly" }] })).toBe("covers 1 month");
  });
  it("monthly renewal → 1 month", () => {
    expect(text({ isRenewal: true, extensionMonths: 1, lines: [{ name: "Hosting", commitment: "monthly" }] }))
      .toBe("covers 1 month");
  });
  it("monthly lines but extension_months 12 → conflict, no claim", () => {
    expect(text({ isRenewal: true, extensionMonths: 12, lines: [{ name: "Hosting", commitment: "monthly" }] })).toBeNull();
  });
});

describe("unknown period → no claim", () => {
  const cases: [string, In][] = [
    ["one-off sale", { isOneOff: true, lines: [{ name: "Laptop", commitment: "annual_yearly" }] }],
    ["no lines", { lines: [] }],
    ["only one-time lines", { lines: [{ name: "Setup", commitment: null }] }],
    ["mixed monthly + annual", { lines: [{ name: "A", commitment: "monthly" }, { name: "B", commitment: "annual_yearly" }] }],
    ["renewal with no months", { isRenewal: true, extensionMonths: 0, lines: [{ name: "A", commitment: "annual_yearly" }] }],
    ["renewal with odd months on an annual line", { isRenewal: true, extensionMonths: 7, lines: [{ name: "A", commitment: "annual_yearly" }] }],
  ];
  it.each(cases)("%s", (_label, input) => {
    expect(text(input)).toBeNull();
  });
  it("servicePeriodText(null) is null", () => expect(servicePeriodText(null)).toBeNull());
});

describe("dates", () => {
  it("bad or reversed dates are not a range", () => {
    expect(lineDateRange("pro-rata from 2026-02-30 to 2026-05-01")).toBeNull();
    expect(lineDateRange("pro-rata from 2027-01-01 to 2026-01-01")).toBeNull();
  });
  it("calendar date, no timezone shift", () => {
    expect(periodDate("2026-09-25")).toBe("25 Sep 2026");
    expect(periodDate("2027-01-01")).toBe("1 Jan 2027");
  });
});
