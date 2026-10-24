/* R-1495 galat (Pawan on staging, 17 Oct 2026): at ~1000px the header's "Customer login"
   button ran past the right edge and the whole page scrolled sideways (measured locally:
   +46px at 1000 and 1200px, +6px at 1280px — the row is ~47px wider than the 1180px .wrap
   leaves inside its padding, so it shows until the side margins absorb it at ~1290px).

   From 980px up to 1299px the header row (logo, six menus, Cart, Customer login) tightens:
   smaller gaps and side padding; below 1200px the menu items tighten too. Measured after the
   fix in a browser at 980 / 1000 / 1100 / 1199 / 1200 / 1280 / 1440: no sideways scroll. This
   test pins the rules that do it, so a later edit cannot quietly bring the overflow back. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../../..");
const css = readFileSync(path.join(root, "src/site/site.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const header = readFileSync(path.join(root, "src/site/components/chrome/Header.tsx"), "utf8");

/** The body of the `@media (min-width: 980px) and (max-width: <maxPx>px)` block. */
function block(maxPx: number): string {
  const at = css.search(new RegExp(`@media\\s*\\(min-width:\\s*980px\\)\\s*and\\s*\\(max-width:\\s*${maxPx}px\\)\\s*\\{`));
  expect(at, `980–${maxPx}px block in site.css`).toBeGreaterThanOrEqual(0);
  let i = css.indexOf("{", at) + 1;
  let depth = 1;
  const start = i;
  while (depth > 0 && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
  return css.slice(start, i - 1);
}

const px = (v: string | undefined): number => Number(/(\d+(?:\.\d+)?)px/.exec(v ?? "")?.[1] ?? NaN);
const prop = (rule: string, name: string) => new RegExp(`${name}:\\s*([^;!]+)`).exec(rule)?.[1];

describe("site header fits from 980px up (R-1495)", () => {
  it("the header row carries the hdr-row class the rules target", () => {
    expect(header).toMatch(/className="wrap hdr-row"/);
  });

  it("from 980 up to 1299px the row's gaps and side padding shrink", () => {
    const rule = /\.anutech-site \.hdr-row\s*\{([^}]*)\}/.exec(block(1299))?.[1] ?? "";
    expect(rule, ".hdr-row rule inside the 980–1299px block").not.toBe("");
    expect(px(prop(rule, "gap"))).toBeLessThanOrEqual(12);
    expect(px(prop(rule, "padding-left"))).toBeLessThanOrEqual(24);
    expect(px(prop(rule, "padding-right"))).toBeLessThanOrEqual(24);
  });

  it("below 1200px the menu items tighten to 4px side padding and 13px text", () => {
    const rule = /\.anutech-site \.nav-item\s*\{([^}]*)\}/.exec(block(1199))?.[1] ?? "";
    expect(px(prop(rule, "padding-left"))).toBeLessThanOrEqual(4);
    expect(px(prop(rule, "font-size"))).toBeLessThanOrEqual(13);
  });
});
