import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* R-287 — accounting lists keep their filters on Back.
   The filters below lived in React.useState, so opening a row (or a payroll posting) and
   pressing Back, or reloading, came home to the unfiltered default list. Each one must now be
   held by useUrlState / useUrlChoice (lib/hooks — behaviour tested in use-url-state.test.tsx),
   and never again by a bare useState. Prepaid, reimbursements and assets have no list filter. */

const PAGES: Record<string, string[]> = {
  bills: ["from", "to", "search"],
  expenses: ["from", "to", "catFilter", "payeeFilter", "unpaidParam", "search", "groupBy"],
  vendors: ["search"],
  "bill-payments": ["q"],
  "day-book": ["from", "to", "only"],
};

function source(page: string): string {
  return readFileSync(join(process.cwd(), "src/app/(app)/accounting", page, "page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("R-287 — accounting list filters live in the URL", () => {
  for (const [page, vars] of Object.entries(PAGES)) {
    it.each(vars)(`${page}: %s comes from the URL, not useState`, (name) => {
      const src = source(page);
      const decl = new RegExp(`const \\[${name},\\s*set\\w+\\]\\s*=\\s*(\\w+(?:\\.\\w+)?)`);
      const m = src.match(decl);
      expect(m, `${page}: no [${name}, set…] declaration found`).not.toBeNull();
      expect(m![1]).toMatch(/^useUrl(State|Choice)$/);
    });
  }

  it("expenses no longer copies ?q into state by hand (useUrlState reads it)", () => {
    expect(source("expenses")).not.toMatch(/get\("q"\)/);
  });
});
