/** R-2710 — revising an older multi-year renewal quote: its line says the years, so picking a new
 *  term scales from the right yearly price (no double count); the term stays extension_months. */
import { describe, it, expect } from "vitest";
import { renewalLinesWithYears } from "./revise";
import { lineForYears } from "@/components/features/quotes/domain-term";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const line = { id: "renewal-1", name: "Domain acme.in", description: "Renewal, 1 year", qty: 1, rate: 2400, cost: 0, commitment: "annual_yearly" } as QuoteLineItem;
const q = (p: Record<string, unknown> = {}) => ({ line_items: [line], is_renewal: true, is_extension: false, extension_months: 24, ...p }) as never;

describe("R-2710 renewalLinesWithYears", () => {
  it("an old 24-month renewal quote's line gets years: 2; picking 3 then gives 1.5x the 2-year price (₹3,600), not 3x (₹7,200)", () => {
    const lines = renewalLinesWithYears(q()) as unknown as QuoteLineItem[];
    expect(lines[0].years).toBe(2);
    expect(lineForYears(lines[0], 3)).toMatchObject({ rate: 3600, years: 3 });
  });
  it("12 months, an extension, a line that already has years, or a non-renewal → unchanged", () => {
    for (const p of [{ extension_months: 12 }, { is_extension: true }, { is_renewal: false }, { line_items: [{ ...line, years: 3 }], extension_months: 36 }, { extension_months: 18 }]) {
      const src = q(p) as { line_items: unknown };
      expect(renewalLinesWithYears(src as never)).toBe(src.line_items);
    }
  });
});
