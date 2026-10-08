import { describe, it, expect } from "vitest";
import { resolveSeatTax } from "./apply-seat-increase";

/* Tiny stand-in for the two single-row reads resolveSeatTax makes. */
function fakeDb(rows: { customers?: Record<string, unknown> | null; tenants?: Record<string, unknown> | null }) {
  return {
    from(table: "customers" | "tenants") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof resolveSeatTax>[0];
}

describe("R-389 (F9): add-seats tax head follows place of supply", () => {
  it("inter-state customer → IGST 18% (was 'GST 18%')", async () => {
    const db = fakeDb({ customers: { country: "India", state_code: "27" }, tenants: { state_code: "07" } });
    expect(await resolveSeatTax(db, "c1", "t1")).toEqual({ taxRatePct: 18, taxLabel: "IGST 18%" });
  });
  it("same state → CGST 9% + SGST 9%", async () => {
    const db = fakeDb({ customers: { country: "India", state_code: "07" }, tenants: { state_code: "07" } });
    expect(await resolveSeatTax(db, "c1", "t1")).toEqual({ taxRatePct: 18, taxLabel: "CGST 9% + SGST 9%" });
  });
  it("export stays zero-rated", async () => {
    const db = fakeDb({ customers: { country: "United States" }, tenants: { state_code: "07" } });
    expect(await resolveSeatTax(db, "c1", "t1")).toEqual({ taxRatePct: 0, taxLabel: "GST 0% (export)" });
  });
  it("state learned from the GSTIN when state_code is blank", async () => {
    const db = fakeDb({ customers: { country: "India", gstin: "07ABDCA0298H1ZP" }, tenants: { state_code: "06" } });
    expect((await resolveSeatTax(db, "c1", "t1")).taxLabel).toBe("IGST 18%");
  });
});
