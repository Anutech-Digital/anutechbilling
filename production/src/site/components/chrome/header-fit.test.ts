/* R-1495 galat (Pawan on staging, 17 Oct 2026): at ~1000px the header's "Customer login"
   button ran past the right edge and the whole page scrolled sideways (measured locally:
   +46px at 1000 and 1200px, +6px at 1280px — the row is ~47px wider than the 1180px .wrap
   leaves inside its padding, so it shows until the side margins absorb it at ~1290px).

   2nd galat (24 Oct): the first fix left 0–6px of room, so it still showed. Now three width
   bands keep real room (measured: 980–1199 ~35px, 1200–1399 ~90px, 1400+ ~50px). This test pins
   the rules; e2e/cards/R-1495.spec.ts measures the real page in a browser. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../../..");
const css = readFileSync(path.join(root, "src/site/site.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const header = readFileSync(path.join(root, "src/site/components/chrome/Header.tsx"), "utf8");

/** Every @media block whose condition text is exactly `cond` (e.g. "(min-width: 980px) and (max-width: 1199px)"), joined. */
function block(cond: string): string {
  const esc = cond.replace(/[()]/g, "\\$&").replace(/\s+/g, "\\s*");
  const re = new RegExp(`@media\\s*${esc}\\s*\\{`, "g");
  const bodies: string[] = [];
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (depth > 0 && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    bodies.push(css.slice(start, i - 1));
  }
  expect(bodies.length, `@media ${cond} block in site.css`).toBeGreaterThan(0);
  return bodies.join("\n");
}

const px = (v: string | undefined): number => Number(/(\d+(?:\.\d+)?)px/.exec(v ?? "")?.[1] ?? NaN);
const prop = (rule: string, name: string) => new RegExp(`${name}:\\s*([^;!]+)`).exec(rule)?.[1];

const ruleOf = (body: string, sel: string) =>
  new RegExp(`\\.anutech-site \\.${sel}\\s*\\{([^}]*)\\}`).exec(body)?.[1] ?? "";

const NARROW = "(min-width: 980px) and (max-width: 1199px)";
const MID = "(min-width: 1200px) and (max-width: 1399px)";
const WIDE = "(min-width: 1400px)";

describe("site header fits from 980px up (R-1495)", () => {
  it("the header row carries the hdr-row class the rules target", () => {
    expect(header).toMatch(/className="wrap hdr-row"/);
  });

  it("980–1199px: tight row (gap ≤ 8, side padding ≤ 16) and menu items at 4px / 13px", () => {
    const row = ruleOf(block(NARROW), "hdr-row");
    expect(px(prop(row, "gap"))).toBeLessThanOrEqual(8);
    expect(px(prop(row, "padding-left"))).toBeLessThanOrEqual(16);
    expect(px(prop(row, "padding-right"))).toBeLessThanOrEqual(16);
    const item = ruleOf(block(NARROW), "nav-item");
    expect(px(prop(item, "padding-left"))).toBeLessThanOrEqual(4);
    expect(px(prop(item, "font-size"))).toBeLessThanOrEqual(13);
    expect(block(NARROW)).toMatch(/\.nav-why\s*\{\s*display:\s*none/);
  });

  // 2nd galat (Pawan, 24 Oct): 1000–1280px still cut "Customer login" — the old rule left 0–6px.
  it("1200–1399px: row gap ≤ 12, padding ≤ 24, items 8px, and Why us hidden (it is in a menu too)", () => {
    const row = ruleOf(block(MID), "hdr-row");
    expect(px(prop(row, "gap"))).toBeLessThanOrEqual(12);
    expect(px(prop(row, "padding-left"))).toBeLessThanOrEqual(24);
    expect(px(prop(ruleOf(block(MID), "nav-item"), "padding-left"))).toBeLessThanOrEqual(8);
    expect(block(MID)).toMatch(/\.nav-why\s*\{\s*display:\s*none/);
  });

  it("1400px up: the header row may use 1300px so all seven items fit with room", () => {
    expect(px(prop(ruleOf(block(WIDE), "hdr-row"), "max-width"))).toBeGreaterThanOrEqual(1300);
    expect(px(prop(ruleOf(block(WIDE), "nav-item"), "padding-left"))).toBeLessThanOrEqual(8);
  });
});
