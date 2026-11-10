/** R-2499 — FY imports go in parts; part N is a stable slice, an unknown part is refused. */
import { describe, it, expect } from "vitest";
import { IMPORT_PART, RECEIPTS_IMPORT_PART, partCount, partOf } from "./parts";

describe("R-2499 import parts", () => {
  it("counts and slices parts", () => {
    const all = Array.from({ length: IMPORT_PART + 3 }, (_, i) => i);
    expect(partCount(all.length)).toBe(2);
    expect(partCount(0)).toBe(0);
    expect(partOf(all, 0)).toHaveLength(IMPORT_PART);
    expect(partOf(all, 1)).toEqual([IMPORT_PART, IMPORT_PART + 1, IMPORT_PART + 2]);
  });
  it("refuses a part that does not exist", () => {
    expect(partOf([1, 2], 1)).toBeNull();
    expect(partOf([1, 2], -1)).toBeNull();
    expect(partOf([1, 2], "x")).toBeNull();
    expect(partOf([1, 2], 0.5)).toBeNull();
  });
});

describe("R-2547 receipts parts stay under the 8 s statement limit", () => {
  it("a receipts part is at most 50 payments (each books a receipt + TDS + bank match: ~8 ms each locally)", () => {
    expect(RECEIPTS_IMPORT_PART).toBeGreaterThan(0);
    expect(RECEIPTS_IMPORT_PART).toBeLessThanOrEqual(50);
  });
  it("smaller parts cover the same payments in the same order (a resumed import re-sends earlier ones as 'already')", () => {
    const all = Array.from({ length: 260 }, (_, i) => `p${i}`);
    const small = Array.from({ length: partCount(all.length, RECEIPTS_IMPORT_PART) }, (_, p) => partOf(all, p, RECEIPTS_IMPORT_PART)!).flat();
    expect(small).toEqual(all);
    /* The old part 0 (250) is exactly the new parts 0..4 — what staging already booked is "already" again. */
    expect(Array.from({ length: 250 / RECEIPTS_IMPORT_PART }, (_, p) => partOf(all, p, RECEIPTS_IMPORT_PART)!).flat()).toEqual(partOf(all, 0, 250));
  });
});
