/**
 * R-2028 (3) — the quote screen's approval gate names the line with no vendor cost and offers
 * "Add cost" (→ the draft's editor at that line's cost box). The helpers are tested in
 * lib/quotes/missing-cost-reason.test.ts and the editor side in
 * quote-builder-typed-line-match-r2028.test.tsx; this pins the wiring on the page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("R-2028 (3): quote page wiring", () => {
  it("the shown approval reasons name the line (gate list and the approval drawer)", () => {
    expect(page).toContain("namedApprovalReasons(approvalNeed.reasons");
    expect(page).toMatch(/shownApprovalReasons\.map\(\(r\)/);
    expect(page).toContain("requirement={{ ...approvalNeed, reasons: shownApprovalReasons }}");
  });
  it("an 'Add cost' button goes to the editor at the first line with no cost", () => {
    expect(page).toMatch(/addCostHref\(quote\.id, missingCostLines\[0\]\.lineNo\)[^]*?>Add cost</);
  });
  it("the line is named even while the approval waits (pending)", () => {
    expect(page).toContain('data-testid="missing-cost-reason"');
  });
});
