/**
 * The buy → done flow fits a 320px phone (7 Oct 2026, Pawan: "mobile responsive design should
 * be proper too"). Measured in a browser at 320/360/390/414/768: no sideways scroll, nothing
 * off-screen, every tap target ≥ 44px (CLAUDE.md §20). These pin the fixes that got it there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const read = (f: string) => readFileSync(f, "utf8");

describe("the site fits a 320px phone", () => {
  it("the header row's gap shrinks on a phone (it pushed the menu button off-screen)", () => {
    const css = read("src/site/site.css");
    expect(css).toMatch(/\.anutech-site \.site-header-row \{ gap: 26px; \}/);
    expect(css).toMatch(/\.anutech-site \.site-header-row \{ gap: 10px; \}/);
    const header = read("src/site/components/chrome/Header.tsx");
    expect(header).toContain('className="wrap site-header-row"');
    expect(header).not.toMatch(/alignItems: "center", gap: 26 \}\}/);
    expect(header).toMatch(/minWidth: 44, minHeight: 44/);
  });
  it("the cookie banner is never wider than the screen", () => {
    expect(read("src/site/components/chrome/Chrome.tsx")).toContain('maxWidth: "min(360px, calc(100vw - 44px))"');
  });
  it("/done wraps a long email address and its links are 44px tall", () => {
    const done = read("src/app/(marketing)/done/page.tsx");
    expect(done).toMatch(/<p className="body-lg" style=\{\{ margin: 0, overflowWrap: "anywhere" \}\}>/);
    expect(done).toMatch(/const helpLink = \{[^}]*minHeight: 44/);
    expect(done).toMatch(/padding: "6px 12px", minHeight: 44/);
  });
  it("the cart's stepper and Remove are 44px tap targets, and so is checkout's state picker", () => {
    const cart = read("src/app/(marketing)/cart/page.tsx");
    expect(cart).toMatch(/const step: React\.CSSProperties = \{[^}]*width: 44, minHeight: 44/);
    expect(cart).toMatch(/color: "var\(--danger\)", fontSize: 14, cursor: "pointer", minHeight: 44/);
    expect(read("src/app/(marketing)/checkout/page.tsx")).toMatch(/style=\{\{ width: "100%", minHeight: 44,/);
  });
});
