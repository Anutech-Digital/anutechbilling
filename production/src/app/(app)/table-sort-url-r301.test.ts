// R-301: R-297 gave DataTable a `urlKey` prop (sort lives in the address bar, so it
// survives opening a row and pressing Back) but no page used it. These four money lists
// must pass it. Scan test: reads each page's <DataTable ...> opening tag.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PAGES = [
  "src/app/(app)/accounting/bills/page.tsx",
  "src/app/(app)/accounting/expenses/page.tsx",
  "src/app/(app)/invoices/page.tsx",
  "src/app/(app)/payments/page.tsx",
];

/** Every `<DataTable ... >` opening tag in the file (props up to the first lone `>` line end). */
function dataTableTags(src: string): string[] {
  const out: string[] = [];
  const re = /<DataTable[\s<]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Props span until a line that ends the opening tag: `>` or `/>` on its own.
    const rest = src.slice(m.index);
    const end = rest.search(/\n\s*\/?>\s*\n/);
    out.push(end === -1 ? rest.slice(0, 2000) : rest.slice(0, end));
  }
  return out;
}

describe("R-301: list pages keep their sort in the URL", () => {
  for (const rel of PAGES) {
    it(`${rel}: every DataTable has urlKey`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      const tags = dataTableTags(src);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/\burlKey="[a-z]+"/);
    });
  }
});
