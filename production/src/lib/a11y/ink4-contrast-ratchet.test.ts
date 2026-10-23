/**
 * R-1135 (23 Oct 2026) — real text must be readable: WCAG AA needs 4.5:1 for body text.
 *
 * `text-ink-4` (#ABA290) is the placeholder / hint token (globals.css says so): on paper it
 * reads ~2.4:1. The 12 Oct audit found it on ~75 pieces of real text (vault, admin/feedback,
 * money.tsx, the breadcrumb …). Those moved to `text-ink-3`, which passes AA on both paper
 * backgrounds in light and dark. `placeholder:text-ink-4` is not counted — that is its job.
 *
 * Two guards:
 *  1. The tokens themselves: ink-3 >= 4.5:1 on paper and paper-2 (light + dark), ink-4 below
 *     it — so "use ink-3 for text" stays a true rule if someone retunes a token.
 *  2. A ratchet on the `ink4-body` count from `scripts/a11y-count.mjs` (the same counter the
 *     audit used). It may only go DOWN. Separator glyphs (· • └) moved to `text-ink-3` with
 *     aria-hidden; disabled buttons keep the grey as `disabled:text-ink-4` (WCAG exempts
 *     disabled controls, and the counter skips any `x:` variant). A new real-text
 *     `text-ink-4` fails this test.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Measured 23 Oct 2026 after R-1135 (was 75: 73 pardeep + 2 shared). Only ever lower it. */
const INK4_BODY_BASELINE = 0;

type Report = { totals: Record<string, Record<string, number>> };

const report = (): Report =>
  JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts", "a11y-count.mjs"), "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })) as Report;

// ── contrast maths (WCAG 2.1 relative luminance) ──
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const lum = ([r, g, b]: [number, number, number]) => {
  const c = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
/** The token's HSL in the `:root` block (light) or the `.dark` block. */
function token(name: string, theme: "light" | "dark"): [number, number, number] {
  const start = theme === "light" ? css.indexOf(":root {") : css.indexOf(".dark {");
  const block = css.slice(start, css.indexOf("}", start));
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  if (!m) throw new Error(`--${name} not found in the ${theme} block of globals.css`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

describe("R-1135 — text tokens meet WCAG AA", () => {
  it.each(["light", "dark"] as const)("%s: ink-3 is >= 4.5:1 on paper and paper-2; ink-4 is not text-grade", (theme) => {
    for (const bg of ["paper", "paper-2"]) {
      const r3 = ratio(token("ink-3", theme), token(bg, theme));
      expect(r3, `ink-3 on ${bg} (${theme}) = ${r3.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const r4 = ratio(token("ink-4", theme), token("paper", theme));
    expect(r4, `ink-4 on paper (${theme}) = ${r4.toFixed(2)}:1 — if this passes AA, retire this guard`).toBeLessThan(4.5);
  });
});

describe("R-1135 — ink4-body ratchet", () => {
  it("real text does not use text-ink-4 (count does not grow)", () => {
    const total = Object.values(report().totals).reduce((s, t) => s + (t["ink4-body"] ?? 0), 0);
    expect(
      total,
      `ink4-body is ${total}; limit ${INK4_BODY_BASELINE}. Use text-ink-3 for real text (node scripts/a11y-count.mjs --owner pardeep lists the lines).`,
    ).toBeLessThanOrEqual(INK4_BODY_BASELINE);
  });
});
