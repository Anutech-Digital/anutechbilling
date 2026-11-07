/**
 * R-2576 — Print / Save as PDF is always light.
 *
 * globals.css @media print resets every theme token to its LIGHT value, so an invoice / quote
 * printed from a dark OS (R-2187: theme follows the OS) comes out light. That list is a copy of
 * the :root block — this keeps the copy honest: every token the `.dark` block changes must be
 * reset in print, to exactly the :root value. Retune a light token and forget the print copy → red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Comments out first: the :root block's prose may hold any character, `}` included.
const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the `{ … }` that follows `from` (these token blocks have no nested braces). */
function body(from: number): string {
  const open = css.indexOf("{", from);
  return css.slice(open + 1, css.indexOf("}", open));
}
function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim().replace(/\s+/g, " "));
  return out;
}

/** First rule at or after `from` whose selector list contains `.dark`. */
function darkRuleAt(from: number): number {
  const re = /(^|[\s,{}])([^{}]*?)\{/g;
  re.lastIndex = from;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[2].split(",").some((s) => s.trim() === ".dark")) return m.index + m[1].length;
  }
  return -1;
}

const printAt = css.indexOf("@media print");
const light = tokens(body(css.indexOf(":root")));
const dark = tokens(body(darkRuleAt(0)));
const printRule = printAt < 0 ? -1 : darkRuleAt(printAt);
const printBody = printRule < 0 ? "" : body(printRule);
const printed = tokens(printBody);

describe("R-2576 — the print block resets every theme token to its light value", () => {
  it("@media print has a .dark rule with color-scheme: light !important", () => {
    expect(printAt).toBeGreaterThan(-1);
    expect(printRule, "a .dark rule inside @media print").toBeGreaterThan(printAt);
    expect(printBody).toMatch(/color-scheme:\s*light\s*!important;/);
  });

  it("every token the dark theme changes is reset in print", () => {
    expect(dark.size).toBeGreaterThan(10);
    const missing = [...dark.keys()].filter((k) => !printed.has(k));
    expect(missing, "dark tokens with no light value in @media print").toEqual([]);
  });

  it("each printed value equals the :root (light) value", () => {
    const wrong = [...printed].filter(([k, v]) => light.get(k) !== v).map(([k, v]) => `--${k}: print ${v} vs :root ${light.get(k)}`);
    expect(wrong).toEqual([]);
  });
});
