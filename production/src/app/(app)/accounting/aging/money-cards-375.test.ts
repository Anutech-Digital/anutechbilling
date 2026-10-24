/**
 * R-1136 (17 Oct 2026) — money cards on five accounting screens broke at 375px: fixed
 * grid-cols-3/4 with no phone breakpoint, text-2xl amounts, and grid items that could not
 * shrink below a long "₹99,99,999". Source checks so a later edit that brings one back fails
 * here before anyone opens a phone. Layout classes only — no number is computed here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ACC = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ACC, rel), "utf8");

const FILES = [
  "aging/page.tsx",
  "balance-sheet/page.tsx",
  "payroll/screens.tsx",
  "business-loans/page.tsx",
  "profitability/page.tsx",
];

/** Every className="…" / `…` string that holds a grid-cols-N. */
function gridClassLists(src: string): string[] {
  return [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .filter((c) => /\bgrid-cols-\d/.test(c));
}

describe("money cards fit a 375px phone (R-1136)", () => {
  it.each(FILES)("%s has no 3- or 4-column grid without a phone breakpoint", (file) => {
    const bad = gridClassLists(read(file)).filter((c) => {
      const base = c.split(/\s+/).find((t) => /^grid-cols-\d+$/.test(t));
      return base !== undefined && Number(base.slice("grid-cols-".length)) >= 3;
    });
    expect(bad).toEqual([]);
  });

  it.each(FILES)("%s has no unconditional text-2xl amount (steps up from text-xl or smaller)", (file) => {
    // An unprefixed text-2xl/3xl on a non-heading line is a phone-size amount that is too big.
    const lines = read(file).split("\n").filter((l) => !/<h1\b/.test(l));
    const bad = lines.filter((l) => /(?:^|[\s"`'])text-(?:2xl|3xl)\b/.test(l));
    expect(bad).toEqual([]);
  });

  it("KPI values use tabular numbers, wrap only as a last resort, and the card can shrink", () => {
    for (const file of ["aging/page.tsx", "profitability/page.tsx", "business-loans/page.tsx"]) {
      const kpi = read(file).split(/function KPI\b/)[1] ?? "";
      expect(kpi, file).toMatch(/font-serif[^\n]*tabular-nums[^\n]*break-words/);
      expect(kpi, file).toMatch(/<Card className="[^"]*\bmin-w-0\b/);
    }
  });

  it("balance-sheet headline cards shrink and the third card takes a full row on phone", () => {
    const src = read("balance-sheet/page.tsx");
    expect(src).toMatch(/grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4/);
    expect(src).toMatch(/col-span-2 sm:col-span-1/);
    expect(src.match(/font-serif text-xl sm:text-2xl mt-1 tabular-nums break-words/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("payroll summary amounts step down on phone", () => {
    const src = read("payroll/screens.tsx");
    expect(src.match(/font-serif text-xl sm:text-2xl[^"]*tabular-nums/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
