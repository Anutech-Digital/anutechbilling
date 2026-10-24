/**
 * R-1811 (24 Oct 2026): a phone's FIRST paint of the website is the server HTML. Two things made
 * that paint wider than a 375px screen:
 *  - the footer's phone rule lived in styled-jsx, which has no server registry here, so the
 *    server HTML was six footer columns (592px) until hydration;
 *  - /hosting, /domains and /email size their grids from a `w` state that starts at 1200 and is
 *    measured only after hydration, so the server HTML was the desktop layout — on /hosting the
 *    "honest numbers" price card sat in a second column, cut off at the right edge.
 * Fix: the footer columns live in site.css; every width-driven grid also carries a data-grid
 * attribute whose site.css media rule gives the phone layout before any JS runs.
 * Source scan — the browser sweep (375 and 768, server HTML and hydrated) is in the card.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "src/site");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const css = read("site.css");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n) ? [p] : [];
  });
}

/** Components whose layout depends on a width measured after hydration. */
const widthDriven = walk(path.join(root, "components")).filter((f) =>
  /const \[w, setW\] = useState\(\d+\)/.test(readFileSync(f, "utf8")),
);

/** A JSX line whose grid columns come from the measured width. */
const WIDTH_GRID = /gridTemplateColumns: (?:mob|mid|w <|twoCol|threeCol|tripleCol)\b|style=\{quadGrid\}/;
const HAS_PHONE_ATTR = /\bdata-grid(?:-phone|-2up)?\b/;

describe("R-1811 the website's first paint fits a phone", () => {
  it("finds the width-driven pages (hosting, domains, email)", () => {
    const names = widthDriven.map((f) => path.basename(f)).sort();
    expect(names).toEqual(expect.arrayContaining(["DomainLanding.tsx", "HomeV2.tsx", "HostingLanding.tsx"]));
  });

  it("every width-driven grid carries a data-grid attribute, so the server HTML is already one column on a phone", () => {
    const missing: string[] = [];
    for (const f of widthDriven) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (WIDTH_GRID.test(line) && /<(div|section)\b/.test(line) && !HAS_PHONE_ATTR.test(line)) {
          missing.push(`${path.relative(root, f)}:${i + 1}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it("site.css gives those attributes their phone columns without JS", () => {
    expect(css).toMatch(/@media \(max-width: 759px\) \{\s*\.anutech-site \[data-grid-phone\] \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
    expect(css).toMatch(/\.anutech-site \[data-grid-2up\] \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important; \}/);
    expect(css).toMatch(/\[data-grid\] \{ grid-template-columns: 1fr !important; \}/);
  });

  it("the hosting hero (price card beside the headline) is one column on a phone before hydration", () => {
    const hosting = read("components/hosting/HostingLanding.tsx");
    expect(hosting).toMatch(/<div data-grid-phone style=\{\{ \.\.\.wrap, display: "grid", gridTemplateColumns: w < 880/);
  });

  it("the footer's columns are in site.css, not styled-jsx", () => {
    const chrome = read("components/chrome/Chrome.tsx");
    const footer = chrome.slice(chrome.indexOf("export function Footer("), chrome.indexOf("export { hideFloatingOn }"));
    expect(footer).toContain('className="footer-grid"');
    expect(footer).not.toMatch(/<style jsx>/);
    expect(footer).not.toMatch(/gridTemplateColumns/);
    expect(css).toMatch(/\.anutech-site \.footer-grid \{ display: grid; grid-template-columns: 1\.5fr repeat\(5, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 979px\) \{\s*\.anutech-site \.footer-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  });
});
