/**
 * R-2522 — each import says which period it covers. Staging 6 Nov 2026: "3 active" imports on
 * HDFC 4523 read as the FY 2025-26 file imported three times.
 */
import { describe, expect, it } from "vitest";
import { statementFyLabel, statementPeriodLabel } from "./import-history";

describe("statementPeriodLabel (R-2522)", () => {
  it("a year's statement: FY · first – last line date · line count (Indian grouping)", () => {
    expect(statementPeriodLabel("2025-04-01", "2026-03-31", 3665)).toBe("FY 2025-26 · 1 Apr 2025 – 31 Mar 2026 · 3,665 lines");
  });
  it("a last line posted on 1 Apr (value date 31 Mar) keeps the statement in its own year", () => {
    expect(statementFyLabel("2025-04-01", "2026-04-01")).toBe("FY 2025-26");
    expect(statementPeriodLabel("2025-04-01", "2026-04-01", 3666)).toBe("FY 2025-26 · 1 Apr 2025 – 1 Apr 2026 · 3,666 lines");
  });
  it("a statement reaching well into the next year names both years", () => {
    expect(statementFyLabel("2026-01-01", "2026-10-23")).toBe("FY 2025-26 – 2026-27");
  });
  it("one day, one line; no dates → just the count", () => {
    expect(statementPeriodLabel("2026-11-01", "2026-11-01", 1)).toBe("FY 2026-27 · 1 Nov 2026 · 1 line");
    expect(statementPeriodLabel(null, null, 0)).toBe("0 lines");
  });
});
