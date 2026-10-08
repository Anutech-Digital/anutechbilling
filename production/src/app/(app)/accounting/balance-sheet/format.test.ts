import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { fmtBS } from "./format";

describe("fmtBS — one way to write a Balance Sheet amount (R-180)", () => {
  it("puts a negative in parentheses, full and compact", () => {
    expect(fmtBS(-57490)).toBe("(₹57,490)");
    expect(fmtBS(-57490, { compact: true })).toBe("(₹57.5K)");
  });

  it("leaves a positive or zero amount plain", () => {
    expect(fmtBS(286708)).toBe("₹2,86,708");
    expect(fmtBS(286708, { compact: true })).toBe("₹2.9L");
    expect(fmtBS(0)).toBe("₹0");
  });

  it("the page never prints a signed amount with rupee() directly", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    /* netWorth / totals can be negative — they must go through fmtBS, not rupee(). */
    for (const v of ["netWorth", "totalAssets", "totalLiab", "totalLiab + netWorth"]) {
      expect(src, `rupee(${v}…) on the Balance Sheet`).not.toContain(`rupee(${v}`);
    }
  });
});
