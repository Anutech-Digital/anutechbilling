/**
 * R-1507 (17 Oct 2026, Pawan, 3 staging reports): "text is too much attached to the box lining".
 * On /rates every price table sits in a bordered `.tablewrap` box, but the first column's cells
 * had `padding: "… 12px … 0"` — zero on the left — so ".in", "Starter" etc. touched the border
 * (1px gap, measured at 375px and 1280px). Rule: a table cell inside a bordered `.tablewrap`
 * never has a zero left/right padding; the outer columns get the same 16px the `.rates` table
 * class uses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILES = [
  "src/app/(marketing)/rates/page.tsx",
  "src/app/(marketing)/why-us/page.tsx",
  "src/site/components/email/EditionTabs.tsx",
];

/** Every inline `padding: "…"` on a <th>/<td> in the file, as [left, right] in px. */
function cellPaddings(src: string): { raw: string; left: number; right: number }[] {
  const out: { raw: string; left: number; right: number }[] = [];
  const re = /<t[hd]\b[^>]*?style=\{\{[^}]*?padding:\s*(?:"([^"]+)"|(\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[1] ?? m[2];
    const v = raw.split(/\s+/).map((x) => parseFloat(x));
    const [t, r = t, , l = r] = v;
    void t;
    out.push({ raw, left: l, right: r });
  }
  return out;
}

describe("R-1507: text in a bordered table box never touches the border", () => {
  it("the /rates tables have no zero-side cell padding", () => {
    const src = readFileSync("src/app/(marketing)/rates/page.tsx", "utf8");
    const cells = cellPaddings(src);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.left, `padding "${c.raw}"`).toBeGreaterThanOrEqual(12);
      expect(c.right, `padding "${c.raw}"`).toBeGreaterThanOrEqual(12);
    }
  });

  it("no other tablewrap table on the website has a zero-side cell padding", () => {
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("tablewrap")) continue;
      for (const c of cellPaddings(src)) {
        expect(c.left, `${f}: padding "${c.raw}"`).toBeGreaterThan(0);
        expect(c.right, `${f}: padding "${c.raw}"`).toBeGreaterThan(0);
      }
    }
  });

  it("the first column on /rates starts 16px from the border, like the .rates table class", () => {
    const src = readFileSync("src/app/(marketing)/rates/page.tsx", "utf8");
    const css = readFileSync("src/site/site.css", "utf8");
    expect(css).toMatch(/table\.rates td \{ padding: 13px 16px;/);
    const rowHead = /<th scope="row" style=\{\{ padding: "([^"]+)"/.exec(src);
    expect(rowHead).not.toBeNull();
    const l = rowHead![1].split(/\s+/).map(parseFloat)[3];
    expect(l).toBe(16);
  });
});
