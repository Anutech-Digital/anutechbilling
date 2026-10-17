// R-1449 (Pawan, staging, 13 Oct 2026): the STAGING badge in the top bar was `text-ink` on
// `bg-amber`. `ink` flips with the theme (near-black in light, cream in dark) while amber stays
// orange, so the text changed colour between themes and failed WCAG AA in both:
// 3.76:1 light, 2.83:1 dark. The badge now uses the existing amber-soft / amber-ink pair.
// This test reads the real token values from globals.css, so nudging a token re-runs the maths.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const topbar = readFileSync(join(root, "src/components/layout/topbar.tsx"), "utf8");

type Hsl = readonly [number, number, number];

/** `--name: H S% L%;` inside the block that starts at `selector {`. */
function token(selector: string, name: string): Hsl {
  const start = css.indexOf(`${selector} {`);
  expect(start, `block not found: ${selector}`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("}", start));
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  expect(m, `--${name} missing in ${selector}`).toBeTruthy();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

function hslToRgb([h, s, l]: Hsl): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function luminance(c: Hsl): number {
  const [r, g, b] = hslToRgb(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Hsl, b: Hsl): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Class strings of the environment badges (the spans carrying the env `title`). */
function badgeClasses(): string[] {
  const spans = topbar.match(/<span className="[^"]*"\s+title="[^"]*">(Staging|Local)<\/span>/g) ?? [];
  return spans.map((s) => s.match(/className="([^"]*)"/)![1]);
}

describe("R-1449: STAGING / Local badge contrast", () => {
  it("contrast helper matches known values", () => {
    expect(contrast([0, 0, 0], [0, 0, 100])).toBeCloseTo(21, 1);
    expect(contrast([0, 0, 50], [0, 0, 50])).toBeCloseTo(1, 5);
  });

  it("both badges use bg-amber-soft with text-amber-ink (no theme-flipping text-ink on bg-amber)", () => {
    const classes = badgeClasses();
    expect(classes).toHaveLength(2);
    for (const cls of classes) {
      expect(cls).toMatch(/(^|\s)bg-amber-soft(\s|$)/);
      expect(cls).toMatch(/(^|\s)text-amber-ink(\s|$)/);
      expect(cls).not.toMatch(/(^|\s)bg-amber(\s|$)/);
      expect(cls).not.toMatch(/(^|\s)text-ink(\s|$)/);
    }
    expect(classes[0]).toBe(classes[1]);
  });

  it.each([":root", ".dark"])("amber-ink on amber-soft is at least 4.5:1 in %s", (sel) => {
    expect(contrast(token(sel, "amber-ink"), token(sel, "amber-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("still shows only for staging and local", () => {
    expect(topbar).toMatch(/NEXT_PUBLIC_APP_ENV === "staging" &&/);
    expect(topbar).toMatch(/NEXT_PUBLIC_APP_ENV === "local" &&/);
  });
});
