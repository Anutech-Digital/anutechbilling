/** R-2712 — a multi-year bulk line's rate is the whole term: never "per year" under a 3-year rate. */
import { describe, it, expect } from "vitest";
import { lineUnitLabel } from "./line-unit-label";

const bulk = (years: number | undefined, seats: number[]) => ({
  name: ".in", commitment: "annual_yearly", bulk: true, years,
  qty: seats.reduce((s, n) => s + n, 0),
  domains: seats.map((n, i) => ({ domain: `d${i}.in`, seats: n })),
});

describe("R-2712 lineUnitLabel on a multi-year bulk line", () => {
  it("3 years → 'Per seat for 3 years' (the same unit word as at 1 year)", () => {
    expect(lineUnitLabel(bulk(3, [1, 1, 1]), false)).toBe("Per seat for 3 years");
    expect(lineUnitLabel(bulk(3, [2, 1]), false)).toBe("Per seat for 3 years");
  });
  it("split billing (per invoice) adds no term", () => {
    expect(lineUnitLabel(bulk(3, [1, 1]), true)).toBe("Per seat");
  });
  it("a Flexible (monthly) bulk line that still carries years is not 'for 3 years'", () => {
    expect(lineUnitLabel({ ...bulk(3, [1, 1]), commitment: "monthly" }, false)).toBe("Per seat per year");
  });
  it("a 1-year bulk line is unchanged", () => {
    expect(lineUnitLabel(bulk(undefined, [1, 1]), false)).toBe("Per seat per year");
    expect(lineUnitLabel(bulk(1, [5, 5]), false)).toBe("Per seat per year");
  });
});
