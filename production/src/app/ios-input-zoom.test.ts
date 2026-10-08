// R-267: iPhone zoomed the page on every field tap (fields were 14px; iOS zooms under 16px).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

/** The body of the `@media (max-width: 767px)` block that sets 16px fields. */
function phoneFieldRule(): string {
  const blocks = css.split("@media (max-width: 767px)").slice(1);
  const hit = blocks.find((b) => /textarea[\s\S]*?font-size:\s*16px/.test(b.slice(0, 600)));
  expect(hit, "no phone-width 16px field rule in globals.css").toBeTruthy();
  return hit!.slice(0, 600);
}

describe("phone fields are 16px so iOS does not zoom on focus", () => {
  it("covers input, select and textarea at 16px", () => {
    const r = phoneFieldRule();
    expect(r).toMatch(/\binput\b/);
    expect(r).toMatch(/\bselect\b/);
    expect(r).toMatch(/\btextarea\b/);
    expect(r).toMatch(/font-size:\s*16px/);
  });

  it("leaves checkbox and radio alone", () => {
    const r = phoneFieldRule();
    expect(r).toContain(':not([type="checkbox"])');
    expect(r).toContain(':not([type="radio"])');
  });

  it("is outside @layer, so .text-sm on the field cannot beat it", () => {
    const at = css.indexOf("@media (max-width: 767px)");
    const before = css.slice(0, at);
    // every @layer block opened before the rule is closed again — count braces
    const opens = (before.match(/{/g) ?? []).length;
    const closes = (before.match(/}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("does not lock pinch-zoom (maximumScale stays > 1, no userScalable false)", () => {
    expect(layout).not.toMatch(/userScalable:\s*false/);
    expect(layout).not.toMatch(/maximumScale:\s*1\b/);
    expect(layout).not.toMatch(/Prevent iOS Safari from zooming/);
  });
});
