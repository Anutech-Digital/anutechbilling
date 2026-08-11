import { describe, it, expect } from "vitest";
import { nationalHolidaysForYear, FIXED_NATIONAL_HOLIDAYS, indiaPublicHolidaysForYear } from "./holidays-india";

describe("nationalHolidaysForYear", () => {
  it("returns the three fixed national holidays for the given year", () => {
    expect(nationalHolidaysForYear(2026)).toEqual(["2026-01-26", "2026-08-15", "2026-10-02"]);
  });
  it("scales to any year", () => {
    expect(nationalHolidaysForYear(2027)).toEqual(["2027-01-26", "2027-08-15", "2027-10-02"]);
  });
  it("only fixed-date national holidays (no guessed festivals)", () => {
    expect(FIXED_NATIONAL_HOLIDAYS).toHaveLength(3);
  });
});

describe("indiaPublicHolidaysForYear", () => {
  it("returns fixed-date public holidays with names for the year", () => {
    const list = indiaPublicHolidaysForYear(2026);
    expect(list).toEqual([
      { date: "2026-01-26", name: "Republic Day" },
      { date: "2026-04-14", name: "Dr. Ambedkar Jayanti" },
      { date: "2026-08-15", name: "Independence Day" },
      { date: "2026-10-02", name: "Gandhi Jayanti" },
      { date: "2026-12-25", name: "Christmas" },
    ]);
  });
});
