// R-1696 (Pardeep, 20 Oct 2026): "billing cycle ke hisaab bhi filter hona chahiye".
// Scan test: reads page.tsx, because the page is too large (queries, dialogs, sheets) to
// render in jsdom — same approach as sticky-header-r1481.test.ts. The rule itself is
// tested in lib/subscriptions/billing-cycle.test.ts and the chips in
// components/features/subscriptions/billing-cycle-filter.test.tsx; this checks the page
// is wired to them.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"),
  "utf8",
);

describe("R-1696 — /subscriptions filters by billing cycle", () => {
  it("keeps the cycle in ?cycle= with the same hook as ?tab=", () => {
    expect(src).toMatch(/useUrlChoice<CycleFilter>\("cycle", CYCLE_FILTERS, "all"\)/);
  });

  it("filters the rows with matchesCycle, alongside vendor and search", () => {
    const start = src.indexOf("const beforeCycle = subsByWorkspace.filter");
    expect(start).toBeGreaterThan(-1);
    const filterBlock = src.slice(start, src.indexOf("const ordered"));
    expect(filterBlock).toMatch(/vendor !== "all"/);
    expect(filterBlock).toMatch(/search\.trim\(\)/);
    expect(filterBlock).toMatch(/const filtered = beforeCycle\.filter\(\(s\) => matchesCycle\(s, cycle\)\)/);
  });

  it("counts the cycles over the rows every OTHER filter leaves, so a chip's count is what clicking it shows", () => {
    expect(src).toMatch(/cycleOptions\(beforeCycle, cycle\)/);
  });

  it("the row label and tooltip come from subscriptionCycle — never rowTerm directly", () => {
    expect(src).not.toMatch(/rowTerm\(s\.billing_cycle/);
    expect((src.match(/subscriptionCycle\(s\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/cycleInvoiceTitle\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("Export writes the filtered rows, not every subscription", () => {
    expect(src).not.toMatch(/exportRows\(subs \?\? \[\]\)/);
    expect(src).toMatch(/exportRows\(ordered\)/);
  });

  it("vendor chips say which one is on (aria-pressed), like the cycle chips", () => {
    expect(src).toMatch(/aria-pressed=\{vendor === opt\.value\}/);
  });
});
