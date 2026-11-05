/** R-2499 — FY imports go in parts; part N is a stable slice, an unknown part is refused. */
import { describe, it, expect } from "vitest";
import { IMPORT_PART, partCount, partOf } from "./parts";

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
