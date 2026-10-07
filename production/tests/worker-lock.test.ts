import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { normPath, pathsOverlap, tooBroad, findConflicts, queueFull, pushTurnFree, PUSH_TURN_STALE_MS, maxWorkersAt, reexportTarget, lockAreaFor } from "../scripts/ops/worker-lock.mjs";

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
    expect(tooBroad("scripts/ops")).toBe(true);
    expect(tooBroad(".")).toBe(true);
    expect(tooBroad("")).toBe(true);
    expect(tooBroad("*")).toBe(true);
    expect(tooBroad("src/*")).toBe(true);
    expect(tooBroad("src/lib/*.ts")).toBe(true);
    expect(tooBroad(".github")).toBe(true);
  });

  it("R-345: an exact FILE path is fine at any depth (root config files can be locked)", () => {
    expect(tooBroad("sentry.client.config.ts")).toBe(false);
    expect(tooBroad("production/next.config.ts")).toBe(false);
    expect(tooBroad("scripts/setup-cloud-scheduler.sh")).toBe(false);
    expect(tooBroad("tests/worker-lock.test.ts")).toBe(false);
    expect(tooBroad(".env.example")).toBe(false);
    expect(tooBroad("production\\package.json")).toBe(false);
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
    expect(queueFull("R-5", four.slice(0, 3), 4)).toBe(false);
    expect(queueFull("R-5", four, 4)).toBe(true);
    expect(queueFull("R-4", four, 4)).toBe(false);
    expect(queueFull("R-5", four, 8)).toBe(false);
  });

  it("one push at a time; a turn left by a crashed worker frees itself after 15 min", () => {
    const now = 1_000_000_000;
    expect(pushTurnFree(null, now)).toBe(true);
    expect(pushTurnFree({ card: "R-1", at: now - 60_000 }, now)).toBe(false);
    expect(pushTurnFree({ card: "R-1", at: now - PUSH_TURN_STALE_MS - 1 }, now)).toBe(true);
  });

  it("card prep: spots a page that only re-exports another (R-197's deals page)", () => {
    expect(reexportTarget('export { default } from "../leads/page";\n')).toBe("../leads/page");
    expect(reexportTarget("// deals = leads\nexport { default, metadata } from '@/app/(app)/leads/page';")).toBe("@/app/(app)/leads/page");
    expect(reexportTarget("export default function Page() { return null; }")).toBeNull();
    expect(reexportTarget('import x from "y";\nconst a = 1;\nexport { a } from "z";')).toBeNull();
  });

  it("card prep: a file's lock area is its folder; never broader than 3 parts", () => {
    expect(lockAreaFor("production/src/app/(app)/deals/page.tsx")).toBe("src/app/(app)/deals");
    expect(lockAreaFor("src/lib/nav.ts")).toBe("src/lib/nav.ts");
    expect(lockAreaFor("src/components/layout/topbar.tsx")).toBe("src/components/layout/topbar.tsx");
  });

  it("2 workers while Pardeep works (09:00–21:59 IST), 4 at night", () => {
    expect(maxWorkersAt("2026-10-07T03:30:00Z")).toBe(2); // 09:00 IST
    expect(maxWorkersAt("2026-10-07T16:29:00Z")).toBe(2); // 21:59 IST
    expect(maxWorkersAt("2026-10-07T16:30:00Z")).toBe(4); // 22:00 IST
    expect(maxWorkersAt("2026-10-06T21:00:00Z")).toBe(4); // 02:30 IST
  });
});
