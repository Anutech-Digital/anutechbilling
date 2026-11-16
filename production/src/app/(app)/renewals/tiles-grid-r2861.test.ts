/** R-2861 — the six tiles sit in ONE row from a 1100px window; the 1280 fit guards (R-2855 / R-2759) are untouched. */
import { describe, expect, it } from "vitest";
import { TILE_GRID } from "./tiles-card";
import { TILE_KEYS } from "./tiles";

describe("R-2861 tile grid", () => {
  it("six tiles, six columns from 1100px (one row), 3 then 2 columns below", () => {
    expect(TILE_KEYS).toHaveLength(6);
    expect(TILE_GRID).toContain("min-[1100px]:grid-cols-6");
    expect(TILE_GRID).toContain("md:grid-cols-3");
    expect(TILE_GRID).toContain("grid-cols-2");
  });
  it("no later breakpoint puts them back on two rows", () => {
    const cols = [...TILE_GRID.matchAll(/min-\[(\d+)px\]:grid-cols-(\d+)/g)];
    expect(cols.every(([, , n]) => Number(n) === 6)).toBe(true);
    expect(TILE_GRID).not.toMatch(/(xl|2xl|lg):grid-cols-[1-5]\b/);
  });
});
