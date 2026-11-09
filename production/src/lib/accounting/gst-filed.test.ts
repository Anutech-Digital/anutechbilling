import { describe, it, expect } from "vitest";
import { latestFilableMonth, monthEndOf, monthName, monthOf } from "./gst-filed";

describe("R-2621 GST returns filed up to — month helpers", () => {
  it("a month input becomes the month's last day (what the database stores)", () => {
    expect(monthEndOf("2026-09")).toBe("2026-09-30");
    expect(monthEndOf("2026-02")).toBe("2026-02-28");
    expect(monthEndOf("2028-02")).toBe("2028-02-29");
    expect(monthEndOf("2026-03")).toBe("2026-03-31");
    expect(monthEndOf("")).toBeNull();
    expect(monthEndOf("2026-13")).toBeNull();
  });

  it("the stored day shows as its month; nothing stored → empty", () => {
    expect(monthOf("2026-09-30")).toBe("2026-09");
    expect(monthOf(null)).toBe("");
  });

  it("the latest month that can be filed is last month (IST)", () => {
    expect(latestFilableMonth("2026-11-09")).toBe("2026-10");
    expect(latestFilableMonth("2027-01-05")).toBe("2026-12");
  });

  it("month names for the sentence", () => {
    expect(monthName("2026-09-30")).toBe("September 2026");
  });
});
