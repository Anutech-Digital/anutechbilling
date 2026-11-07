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

const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

/** `--name: value;` pairs of the first `{ … }` block that starts at `from` (no nested braces in these blocks). */
function tokens(from: number): Map<string, string> {
  const open = css.indexOf("{", from);
  const block = css.slice(open + 1, css.indexOf("}", open));
  const out = new Map<string, string>();
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return out;
}

const printAt = css.indexOf("@media print");
const light = tokens(css.indexOf(":root {"));
const dark = tokens(css.indexOf(".dark {"));
const printed = tokens(css.indexOf(".dark {", printAt));
const printSelector = css.slice(css.indexOf("{", printAt) + 1, css.indexOf(".dark {", printAt) + ".dark {".length);

describe("R-2576 — the print block resets every theme token to its light value", () => {
  it("the print block exists and covers :root, :root.dark and .dark with color-scheme: light", () => {
    expect(printAt).toBeGreaterThan(-1);
    expect(css.indexOf(".dark {", printAt), "a .dark rule inside @media print").toBeGreaterThan(printAt);
    expect(printSelector).toMatch(/:root,\s*:root\.dark,\s*\.dark \{$/);
    expect(css.slice(css.indexOf(".dark {", printAt))).toMatch(/^\.dark \{\s*(?:\/\*[\s\S]*?\*\/\s*)?color-scheme: light !important;/);
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
