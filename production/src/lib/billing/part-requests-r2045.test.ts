/**
 * R-2045 (28 Oct 2026, Pardeep) — a part payment request paid net of TDS. "TDS is only on the
 * instalment the customer paid — never on the whole year's value." Expected TDS = rate × THIS
 * part's taxable value (GST excluded, CBDT circular 23/2017). More than that (+₹1) → a warning in
 * the Record payment sheet (the customer may have deducted on the full year or on GST) — never a
 * block: bank + TDS that covers the part still pays it in full.
 * The money side (one paid tax invoice for the full part, TDS receivable on it) is proven on the
 * database in supabase/tests/r2045_part_request_tds.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { partRequestTdsCheck, PART_TDS_TOLERANCE } from "./part-requests";

describe("R-2045 partRequestTdsCheck — TDS only on this part's taxable value", () => {
  it("owner's case: Q2 taxable ₹4,080 at 194J 10% → expected ₹408; ₹408 entered → no warning", () => {
    const c = partRequestTdsCheck({ taxable: 4080, ratePct: 10, tds: 408 });
    expect(c.expected).toBe(408);
    expect(c.tooHigh).toBe(false);
    expect(c.message).toBeNull();
  });

  it("card's case: ₹7,080 part (taxable ₹6,000) with ₹708 TDS → expected ₹600, warning (not a block)", () => {
    const c = partRequestTdsCheck({ taxable: 6000, ratePct: 10, tds: 708 });
    expect(c.expected).toBe(600);
    expect(c.tooHigh).toBe(true);
    expect(c.message).toContain("₹708");
    expect(c.message).toContain("₹600");
    expect(c.message).toContain("₹6,000");
    expect(c.message).toMatch(/full year/);
  });

  it("₹1 rounding tolerance: ₹601 on ₹600 expected is fine, ₹602 warns", () => {
    expect(PART_TDS_TOLERANCE).toBe(1);
    expect(partRequestTdsCheck({ taxable: 6000, ratePct: 10, tds: 601 }).tooHigh).toBe(false);
    expect(partRequestTdsCheck({ taxable: 6000, ratePct: 10, tds: 602 }).tooHigh).toBe(true);
  });

  it("2% (194C) on ₹4,080 → ₹82 expected; less TDS than expected never warns", () => {
    expect(partRequestTdsCheck({ taxable: 4080, ratePct: 2, tds: 82 })).toMatchObject({ expected: 82, tooHigh: false });
    expect(partRequestTdsCheck({ taxable: 4080, ratePct: 10, tds: 100 }).tooHigh).toBe(false);
  });

  it("no TDS, or no taxable value known → nothing to warn about", () => {
    expect(partRequestTdsCheck({ taxable: 6000, ratePct: 10, tds: 0 }).tooHigh).toBe(false);
    expect(partRequestTdsCheck({ taxable: 0, ratePct: 10, tds: 708 }).tooHigh).toBe(false);
  });
});

describe("R-2045 Record payment sheet wiring", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/record-payment-dialog.tsx"), "utf8");

  it("reads the rule from lib/billing/part-requests and shows the warning only for a part request", () => {
    expect(src).toContain("partRequestTdsCheck");
    expect(src).toMatch(/data-testid="part-tds-warning"/);
    expect(src).toMatch(/invoiceFacts\?\.partRequest/);
  });

  it("a part request lets the TDS actually withheld be typed, and that amount is what is saved", () => {
    expect(src).toMatch(/id="partTdsAmount"/);
    expect(src).toMatch(/p_tds_amount:\s+tdsAmount/);
  });
});
