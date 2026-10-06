import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { normPath, pathsOverlap, tooBroad, findConflicts, queueFull } from "../scripts/ops/worker-lock.mjs";

describe("worker locks (two workers must never build in the same files)", () => {
  it("compares paths from the app root, whatever the slashes", () => {
    expect(normPath("production\\src\\lib\\deals\\")).toBe("src/lib/deals");
    expect(normPath("./src/lib/x.ts")).toBe("src/lib/x.ts");
  });

  it("a folder overlaps the files inside it, but not a sibling with a longer name", () => {
    expect(pathsOverlap("src/lib/deals", "src/lib/deals/deal-rules.ts")).toBe(true);
    expect(pathsOverlap("src/lib/deals/deal-rules.ts", "src/lib/deals")).toBe(true);
    expect(pathsOverlap("src/lib/deal", "src/lib/deals")).toBe(false);
    expect(pathsOverlap("src/app/(app)/deals", "src/app/(app)/customers")).toBe(false);
  });

  it("refuses claims so broad they would lock every other worker out", () => {
    expect(tooBroad("src")).toBe(true);
    expect(tooBroad("src/app")).toBe(true);
    expect(tooBroad("src/lib/deals")).toBe(false);
  });

  it("names the other card and both paths on a conflict, and ignores its own lock", () => {
    const locks = [
      { card: "R-197", areas: ["src/app/(app)/deals"], files: [] },
      { card: "R-300", areas: ["src/lib/inbound"], files: ["src/lib/ai/app-help.ts"] },
    ];
    expect(findConflicts("R-197", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([]);
    expect(findConflicts("R-301", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([
      { card: "R-197", mine: "src/app/(app)/deals/page.tsx", theirs: "src/app/(app)/deals" },
    ]);
    expect(findConflicts("R-301", ["src/lib/ai/app-help.ts"], locks).map((c: { card: string }) => c.card)).toEqual(["R-300"]);
    expect(findConflicts("R-301", ["src/lib/customers"], locks)).toEqual([]);
  });

  it("lets at most 4 workers run, and a worker re-claiming its own card is not counted", () => {
    const four = ["R-1", "R-2", "R-3", "R-4"].map((card) => ({ card, areas: [], files: [] }));
    expect(queueFull("R-5", four.slice(0, 3))).toBe(false);
    expect(queueFull("R-5", four)).toBe(true);
    expect(queueFull("R-4", four)).toBe(false);
    expect(queueFull("R-5", four, 8)).toBe(false);
  });
});
