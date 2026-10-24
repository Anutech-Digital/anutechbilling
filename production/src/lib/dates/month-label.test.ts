/**
 * R-1139: month labels ("Oct 2026") must not depend on the viewer's time zone.
 *
 * `new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short" })` formats the
 * UTC midnight of the 1st in the DEVICE zone: in Los Angeles that is 30 Sep 17:00, so October's
 * column read "Sep". formatMonthLabel builds the label from the numbers — no Date, no zone.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatMonthLabel } from "./ist";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("formatMonthLabel (R-1139)", () => {
  for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "UTC", "Pacific/Kiritimati"]) {
    it(`gives the same month under TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(formatMonthLabel("2026-10")).toBe("Oct 2026");
      expect(formatMonthLabel("2026-03")).toBe("Mar 2026");
      expect(formatMonthLabel("2026-01")).toBe("Jan 2026");
      expect(formatMonthLabel("2026-12")).toBe("Dec 2026");
      expect(formatMonthLabel("2026-09-15")).toBe("Sep 2026");
    });
  }

  it("supports the short-year and long-month styles the screens use", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatMonthLabel("2026-10", { year: "2-digit" })).toBe("Oct 26");
    expect(formatMonthLabel("2026-10", { month: "long" })).toBe("October 2026");
    expect(formatMonthLabel("2026-09", { month: "long" })).toBe("September 2026");
  });

  it("returns the input unchanged when it is not a YYYY-MM month", () => {
    expect(formatMonthLabel("")).toBe("");
    expect(formatMonthLabel("garbage")).toBe("garbage");
    expect(formatMonthLabel("2026-13")).toBe("2026-13");
  });
});

/* Every month label on these screens goes through formatMonthLabel; a toLocaleDateString /
   toLocaleTimeString there must name a timeZone (IST_TZ for instants). Number formatting
   (`n.toLocaleString("en-IN")`) is not a date and is not checked. */
const FILES = [
  "src/app/(app)/accounting/cash-flow/page.tsx",
  "src/app/(app)/accounting/esi-register/page.tsx",
  "src/app/(app)/accounting/salary-register/page.tsx",
  "src/app/(app)/reports/purchases/page.tsx",
  "src/components/features/accounting/expense-report-card.tsx",
  "src/components/features/accounting/salary-breakdown-dialog.tsx",
  "src/app/(app)/accounting/payroll/screens.tsx",
];

describe("month-label call sites are zone-safe (R-1139)", () => {
  for (const file of FILES) {
    it(`${file}: no toLocaleDateString/TimeString without timeZone`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const calls = [...src.matchAll(/\.toLocale(?:Date|Time)String\(([^)]*)\)/g)].map((m) => m[1]);
      const naked = calls.filter((args) => !/timeZone\s*:/.test(args));
      expect(naked, `unzoned toLocale call in ${file}`).toEqual([]);
    });
    it(`${file}: uses formatMonthLabel`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(src).toMatch(/\bformatMonthLabel\(/);
    });
  }
});
