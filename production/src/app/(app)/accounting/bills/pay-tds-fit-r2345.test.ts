import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* R-2345 — Bills → Pay: with 194C picked ("194C Contractor · 2% — s.393(1) Sl. 6(i)") the TDS
   <select> took the width of its longest option, the dialog got a horizontal scrollbar and the
   arrow was cut off. jsdom has no layout, so this reads the classes: the select must be able to
   shrink inside its row (min-w-0 + flex-1/w-full, truncated closed text, no fixed min-width),
   its row must not let it grow past the box, and it must look like the Pay from select. */

const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/bills/page.tsx"), "utf8");

function classesOf(id: string): string[] {
  const m = src.match(new RegExp(`<select id="${id}"[\\s\\S]{0,400}?className="([^"]+)"`, "s"));
  expect(m, `select #${id} with a className`).toBeTruthy();
  return m![1].split(/\s+/);
}

describe("R-2345 — Pay dialog TDS select fits the dialog", () => {
  it("the TDS select shrinks to its box and truncates its closed text", () => {
    const c = classesOf("bills-tds-section");
    expect(c).toContain("min-w-0");
    expect(c).toContain("w-full");
    expect(c).toContain("flex-1");
    expect(c).toContain("truncate");
    expect(c.some((x) => /^min-w-\[/.test(x) || /^w-\[/.test(x))).toBe(false);
  });

  it("its row cannot push it wider than the dialog", () => {
    const start = src.indexOf('<select id="bills-tds-section"');
    const before = src.slice(0, start);
    const rowOpen = before.lastIndexOf("<div ");
    const row = before.slice(rowOpen, before.indexOf(">", rowOpen));
    expect(row).toMatch(/\bmin-w-0\b/);
    expect(row).not.toMatch(/\bflex-wrap\b/);
    const label = before.slice(before.lastIndexOf("<label", start));
    expect(label).toMatch(/\bshrink-0\b/);
  });

  it("looks like the Pay from select in the same dialog", () => {
    const pay = classesOf("bills-pay-from");
    const tds = classesOf("bills-tds-section");
    for (const k of pay) expect(tds).toContain(k);
  });
});
