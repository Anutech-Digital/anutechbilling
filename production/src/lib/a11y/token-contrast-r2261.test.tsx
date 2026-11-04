// @vitest-environment jsdom
/**
 * R-2261 / R-2262 (31 Oct 2026) — readable contrast at the TOKEN level, light AND dark.
 *
 * Design audit (Anutech-HQ/drafts/ZOHO-AUDIT/design.md rows 1, 2, 10, 11; decision 3), measured:
 *  - primary / danger buttons in dark: white on amber 2.99:1, white on rose 3.30:1 (need 4.5)
 *  - "Fill missing costs" on /invoices: `text-accent` = amber-SOFT, a background colour — 1.05:1
 *  - `ink-4` hint / placeholder text 2.32:1 on paper (need 4.5)
 *  - input / select / textarea borders (`border-hairline`) 1.24:1 (WCAG 1.4.11 needs 3:1)
 *
 * The ratios are computed from the HSL values in globals.css, so retuning a token
 * below the floor turns this red. The cream paper itself stays as it is (decision 3).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

afterEach(cleanup);

type RGB = [number, number, number];
function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const lum = ([r, g, b]: RGB) => {
  const c = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const root = process.cwd();
const css = readFileSync(join(root, "src", "app", "globals.css"), "utf8");
function token(name: string, theme: "light" | "dark"): RGB {
  const start = theme === "light" ? css.indexOf(":root {") : css.indexOf(".dark {");
  const block = css.slice(start, css.indexOf("}", start));
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  if (!m) throw new Error(`--${name} not found in the ${theme} block of globals.css`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}
const THEMES = ["light", "dark"] as const;
const show = (n: number) => `${n.toFixed(2)}:1`;

describe("R-2261 — button text on primary / danger fills", () => {
  it.each(THEMES)("%s: on-primary is >= 4.5:1 on amber and on rose", (theme) => {
    for (const bg of ["amber", "rose"]) {
      const r = ratio(token("on-primary", theme), token(bg, theme));
      expect(r, `on-primary on ${bg} (${theme}) = ${show(r)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("primary and danger <Button> use the flipping token, never a fixed white", () => {
    for (const variant of ["primary", "danger"] as const) {
      const { getByRole } = render(<Button variant={variant}>Save</Button>);
      const cls = getByRole("button", { name: "Save" }).className;
      expect(cls, variant).toMatch(/\btext-on-primary\b/);
      expect(cls, variant).not.toMatch(/\btext-white\b/);
      cleanup();
    }
  });

  it("tailwind maps on-primary and the shadcn foregrounds to the token", () => {
    const tw = readFileSync(join(root, "tailwind.config.ts"), "utf8");
    expect(tw).toMatch(/"on-primary":\s*"hsl\(var\(--on-primary\)/);
    expect(tw).not.toMatch(/foreground:\s*"hsl\(0 0% 100%/);
  });
});

describe("R-2261 — hint / placeholder text (ink-4)", () => {
  it.each(THEMES)("%s: ink-4 is >= 4.5:1 on paper and stays lighter than ink-3", (theme) => {
    const r4 = ratio(token("ink-4", theme), token("paper", theme));
    const r3 = ratio(token("ink-3", theme), token("paper", theme));
    expect(r4, `ink-4 on paper (${theme}) = ${show(r4)}`).toBeGreaterThanOrEqual(4.5);
    expect(r4, `ink-4 ${show(r4)} must stay below ink-3 ${show(r3)} (${theme})`).toBeLessThan(r3);
  });
});

describe("R-2261 — form field borders (WCAG 1.4.11)", () => {
  it.each(THEMES)("%s: input-border is >= 3:1 on paper and paper-2", (theme) => {
    for (const bg of ["paper", "paper-2"]) {
      const r = ratio(token("input-border", theme), token(bg, theme));
      expect(r, `input-border on ${bg} (${theme}) = ${show(r)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("Input and Textarea draw their border with border-input, not the 1.24:1 hairline", () => {
    const { container } = render(<><Input aria-label="a" /><Textarea aria-label="b" /></>);
    const boxes = [
      container.querySelector("input")!.parentElement!, // Input paints its border on the wrapper box
      container.querySelector("textarea")!,
    ];
    for (const el of boxes) {
      expect(el.className).toMatch(/\bborder-input\b/);
      expect(el.className).not.toMatch(/\bborder-hairline\b/);
    }
  });

  it("Select trigger uses border-input (source — the trigger needs a Radix root to render)", () => {
    const src = readFileSync(join(root, "src", "components", "ui", "select.tsx"), "utf8");
    expect(src).toMatch(/"border-input focus:ring-amber/);
  });

  it("tailwind's input colour is the input-border token", () => {
    const tw = readFileSync(join(root, "tailwind.config.ts"), "utf8");
    expect(tw).toMatch(/input:\s*"hsl\(var\(--input-border\)/);
  });
});

describe("R-2262 — 'Fill missing costs' is a readable link", () => {
  const page = readFileSync(join(root, "src", "app", "(app)", "invoices", "page.tsx"), "utf8");

  it("uses amber-ink (a text colour), not text-accent (the amber-soft background)", () => {
    const i = page.search(/Fill missing costs\r?\n/);
    expect(i, "the 'Fill missing costs' button text").toBeGreaterThan(0);
    const tag = page.slice(page.lastIndexOf("<button", i), i);
    expect(tag).toMatch(/\btext-amber-ink\b/);
    expect(tag).not.toMatch(/\btext-accent\b/);
  });

  it.each(THEMES)("%s: amber-ink is >= 4.5:1 on paper; amber-soft as text was not", (theme) => {
    const good = ratio(token("amber-ink", theme), token("paper", theme));
    expect(good, `amber-ink on paper (${theme}) = ${show(good)}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("amber-soft", theme), token("paper", theme))).toBeLessThan(3);
  });

  it("no screen uses text-accent — accent is a background token", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx") ? [join(dir, e.name)] : [],
      );
    const hits = walk(join(root, "src"))
      .filter((f) => /\btext-accent\b/.test(readFileSync(f, "utf8")))
      .join("\n");
    expect(hits.trim()).toBe("");
  });
});
