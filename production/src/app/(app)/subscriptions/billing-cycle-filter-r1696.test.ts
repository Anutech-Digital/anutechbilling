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
    // R-1774: the URL also accepts the old quarterly / half_yearly values, read through cycleFromUrl.
    expect(src).toMatch(/useUrlChoice<CycleUrlValue>\("cycle", CYCLE_URL_VALUES, "all"\)/);
    expect(src).toMatch(/const cycle: CycleFilter = cycleFromUrl\(cycleRaw\)/);
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
    // R-1774: the badge + tooltip (cycleInvoiceTitle) live in ONE component for table and card.
    expect((src.match(/<SubCycleBadge\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/cyc=\{cyc\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("R-1774: Check term rows open the existing Correct details dialog, from table and card", () => {
    expect((src.match(/onCorrect=\{\(\) => setEditSub\(s\)\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("R-1774: the renewal clock comes from renewalClock (closed rows never read 'overdue')", () => {
    expect(src).not.toMatch(/renewalDistance\(dl\)/);
    expect((src.match(/renewalClock\(s, dl\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/const isUrgent = s\.status === "active" && dl !== null/);
  });

  it("Export writes the filtered rows, not every subscription", () => {
    expect(src).not.toMatch(/exportRows\(subs \?\? \[\]\)/);
    expect(src).toMatch(/exportRows\(ordered\)/);
  });

  it("vendor chips say which one is on (aria-pressed), like the cycle chips", () => {
    expect(src).toMatch(/aria-pressed=\{vendor === opt\.value\}/);
  });
});
