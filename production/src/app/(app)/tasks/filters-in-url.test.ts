import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* R-286 — list filters survive Back on Tasks, Contacts, Enquiries and Orders (website).
   These filters lived in React.useState, so opening a row and pressing Back (or reloading)
   came home to the unfiltered default list. Each one must now be held by useUrlState /
   useUrlChoice (lib/hooks — behaviour tested in use-url-state.test.tsx), never a bare useState.
   Projects and My expenses have no list filter (only dialog / form state), so nothing to move. */

const PAGES: Record<string, string[]> = {
  tasks: ["tab", "assignee"],
  contacts: ["tab", "search"],
  enquiries: ["folder", "query"],
  "online-orders": ["tab", "focus", "search"],
};

function source(page: string): string {
  return readFileSync(join(process.cwd(), "src/app/(app)", page, "page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("R-286 — list filters live in the URL", () => {
  for (const [page, vars] of Object.entries(PAGES)) {
    it.each(vars)(`${page}: %s comes from the URL, not useState`, (name) => {
      const src = source(page);
      const decl = new RegExp(`const \\[${name},\\s*set\\w+\\]\\s*=\\s*(\\w+(?:\\.\\w+)?)`);
      const m = src.match(decl);
      expect(m, `${page}: no [${name}, set…] declaration found`).not.toBeNull();
      expect(m![1]).toMatch(/^useUrl(State|Choice)$/);
    });
  }

  it("each page uses a distinct URL key per filter", () => {
    for (const page of Object.keys(PAGES)) {
      const keys = [...source(page).matchAll(/useUrl(?:State|Choice)(?:<[^>]+>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(keys).size, `${page}: duplicate URL keys ${keys.join(", ")}`).toBe(keys.length);
    }
  });
});
