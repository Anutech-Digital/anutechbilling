/* R-1716: the "invoice to raise" age is IST days and never "-1d". */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toInvoiceAgeDays } from "./to-invoice-age";

describe("toInvoiceAgeDays (R-1716)", () => {
  it.each([
    ["date-only anchor, same IST day at 00:30 (was -1d)", "2026-10-21", "2026-10-21", 0],
    ["timestamp at 00:30 IST = 20 Oct 19:00 UTC is still 21 Oct", "2026-10-20T19:00:00Z", "2026-10-21", 0],
    ["timestamp the IST evening before", "2026-10-20T13:00:00Z", "2026-10-21", 1],
    ["16 days", "2026-10-05", "2026-10-21", 16],
    ["future anchor is 0, never negative", "2026-10-25", "2026-10-21", 0],
    ["no anchor", null, "2026-10-21", 0],
    ["garbage", "not a date", "2026-10-21", 0],
  ] as const)("%s", (_l, anchor, today, days) => {
    expect(toInvoiceAgeDays(anchor, today)).toBe(days);
  });

  it("the /invoices panel uses it — no raw ms arithmetic left", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/invoices/page.tsx"), "utf8");
    expect(page).not.toMatch(/now - new Date\(a(nchor)?\)\.getTime\(\)/);
    expect(page.match(/toInvoiceAgeDays\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
