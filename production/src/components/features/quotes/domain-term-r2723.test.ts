/** R-2723 — switching a multi-year domain line to Flexible: the line goes back to ONE year first
 *  (years removed, rate / list rate / cost = the yearly figure), then the unit is converted. It used
 *  to keep `years` and divide the whole-term rate by 12 (3 years ₹2,400 → ₹200 a month). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { lineForCommitment, lineForYears } from "./domain-term";
import { convertRateForCommitment } from "@/lib/quotes/commitment-rate";
import { buildBulkLine } from "@/lib/quotes/bulk";

const yearly: QuoteLineItem = {
  id: "l1", name: "Domain registration .in", qty: 1, rate: 800, list_rate: 800, cost: 600,
  commitment: "annual_yearly", domain: "acme.in",
} as QuoteLineItem;

/** What the builder's updateCommitment does with a line that has no catalogue price tier. */
function toCommitment(line: QuoteLineItem, to: NonNullable<QuoteLineItem["commitment"]>) {
  const l = lineForCommitment(line, to);
  const conv = convertRateForCommitment({ rate: l.rate, cost: l.cost, from: l.commitment, to });
  const list = convertRateForCommitment({ rate: l.list_rate, cost: 0, from: l.commitment, to });
  return { ...l, commitment: to, rate: conv.rate, cost: conv.cost, list_rate: list.rate };
}

describe("R-2723 lineForCommitment", () => {
  it("3-year domain line → Flexible: years removed, one month of ONE year (67 / 50), not 200 / 150", () => {
    const three = lineForYears(yearly, 3);
    expect([three.rate, three.cost, three.list_rate, three.years]).toEqual([2400, 1800, 2400, 3]);
    const flex = toCommitment(three, "monthly");
    expect(flex.years).toBeUndefined();
    expect([flex.rate, flex.cost, flex.list_rate, flex.commitment]).toEqual([67, 50, 67, "monthly"]);
  });

  it("before the fix the same switch gave 200 / 150 and kept years: 3 (the bug, pinned)", () => {
    const three = lineForYears(yearly, 3);
    const old = convertRateForCommitment({ rate: three.rate, cost: three.cost, from: three.commitment, to: "monthly" });
    expect([old.rate, old.cost]).toEqual([200, 150]);
  });

  it("a multi-year BULK domain line follows the same rule", () => {
    const bulk = lineForYears(
      { ...buildBulkLine({ id: "b1", item_id: "it-in", name: ".in", cost: 600 }, 800, [{ domain: "a1.in", seats: 1 }, { domain: "a2.in", seats: 2 }]), list_rate: 800 },
      3,
    );
    expect([bulk.rate, bulk.years]).toEqual([2400, 3]);
    const flex = toCommitment(bulk, "monthly");
    expect(flex.years).toBeUndefined();
    expect([flex.rate, flex.cost, flex.qty]).toEqual([67, 50, 3]);
    expect(flex.domains).toEqual(bulk.domains);
  });

  it("a 1-year line, a line without years and a non-monthly change are returned untouched", () => {
    expect(lineForCommitment(yearly, "monthly")).toBe(yearly);
    const one = { ...yearly, years: 1 } as QuoteLineItem;
    expect(lineForCommitment(one, "monthly")).toBe(one);
    const three = lineForYears(yearly, 3);
    expect(lineForCommitment(three, "annual_yearly")).toBe(three);
    expect(lineForCommitment(three, "annual_monthly")).toBe(three);
    expect(lineForCommitment(three, null)).toBe(three);
  });

  it("years out of range (0, 11, 2.5) read as 1 year — the line is not rescaled", () => {
    for (const y of [0, 11, 2.5, Number.NaN]) {
      const odd = { ...yearly, years: y } as QuoteLineItem;
      expect(lineForCommitment(odd, "monthly")).toBe(odd);
    }
  });

  it("the builder's updateCommitment runs every changed line through lineForCommitment", () => {
    const src = readFileSync(path.resolve(__dirname, "quote-builder.tsx"), "utf8");
    const at = src.indexOf("const updateCommitment = (");
    const body = src.slice(at, src.indexOf("\n  const ", at + 10));
    expect(body).toContain("const l = lineForCommitment(l0, commitment);");
    // Nothing after it reads the raw line again.
    expect(body.slice(body.indexOf("lineForCommitment(l0, commitment)") + 40)).not.toMatch(/\bl0\b/);
  });
});
