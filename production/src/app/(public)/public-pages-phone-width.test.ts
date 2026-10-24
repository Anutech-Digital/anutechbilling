/**
 * R-1456 (16 Oct 2026, Pawan on staging): /about, /pricing, /privacy and /terms were 468px wide
 * on a 390px phone, so the whole page scrolled sideways. Cause: the shared footer's row of seven
 * links never wrapped (one line wider than the phone), plus 20–24px gutters where the phone rule
 * (production/CLAUDE.md §20) is 16px, and the privacy sub-processor table had no box of its own.
 * Source scan — no browser here; the manager/AI tester checks the pages at 390px.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "src/app/(public)");
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

const shell = read("_components/public-shell.tsx");
const pricing = read("_components/pricing-sections.tsx");
const privacy = read("privacy/page.tsx");

/** The source between `export function <name>` and the next top-level `export function`. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Every className string literal in a chunk of source. */
const classNames = (src: string) =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2] ?? "");

describe("R-1456 public pages fit a 390px phone", () => {
  it("the footer link row wraps instead of running off the screen", () => {
    const footer = fn(shell, "PublicFooter");
    const nav = footer.match(/<nav className="([^"]*)"/)?.[1];
    expect(nav).toBeDefined();
    expect(nav).toMatch(/\bflex-wrap\b/);
    // the © line beside the logo may wrap too
    expect(footer).toMatch(/<span className="[^"]*\bmin-w-0\b[^"]*">\s*©/);
  });

  it("the top bar keeps the logo shrinkable and the links on one tidy line", () => {
    const top = fn(shell, "PublicTopBar");
    const cls = classNames(top);
    expect(cls.some((c) => /\bmin-w-0\b/.test(c) && c.includes("items-center"))).toBe(true);
    expect(cls.some((c) => /\bshrink-0\b/.test(c) && /\bgap-4\b/.test(c))).toBe(true);
  });

  it("phone gutter is 16px (px-4) on the shell, top bar, footer and every pricing section", () => {
    for (const [name, src] of [
      ["PublicShell", fn(shell, "PublicShell")],
      ["PublicTopBar", fn(shell, "PublicTopBar")],
      ["PublicFooter", fn(shell, "PublicFooter")],
      ["pricing-sections", pricing],
    ] as const) {
      // page-width containers that set their own side padding
      const containers = classNames(src).filter(
        (x) => /\bmx-auto\b/.test(x) && /\bmax-w-/.test(x) && /(^|\s)px-\d/.test(x),
      );
      expect(containers.length, name).toBeGreaterThan(0);
      for (const c of containers) {
        expect(c, `${name}: "${c}"`).toMatch(/(^|\s)px-4(\s|$)/);
      }
    }
  });

  it("long words, emails and URLs break inside the legal/about text instead of widening the page", () => {
    const body = classNames(fn(shell, "PublicShell")).find((c) => c.includes("prose-resellersos"));
    expect(body).toBeDefined();
    expect(body).toMatch(/\bmin-w-0\b/);
    expect(body).toContain("[overflow-wrap:anywhere]");
  });

  it("the privacy sub-processor table sits in its own scroll box", () => {
    expect(privacy).toMatch(/<div className="[^"]*\boverflow-x-auto\b[^"]*">\s*<table/);
  });

  it("the pricing comparison table scrolls inside its own box, never the page", () => {
    const cmp = fn(pricing, "Comparison");
    expect(cmp).toMatch(/<div className="[^"]*\boverflow-x-auto\b[^"]*">\s*<table className="[^"]*min-w-\[/);
    // no fixed width anywhere else on the four pages' shared pieces
    for (const src of [shell, privacy]) expect(src).not.toMatch(/\b(min-)?w-\[\d+px\]/);
  });
});
