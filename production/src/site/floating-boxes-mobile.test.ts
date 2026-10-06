/**
 * R-230 (6 Oct 2026): on a 375px phone the website's three floating boxes — the AI chat
 * launcher (full text pill, bottom 78), the WhatsApp pill (bottom 22) and the consent banner
 * (left 22 + maxWidth 360, wider than the screen) — covered the bottom of every page, on
 * /checkout the Pay button too. The rule: nothing floats on /checkout and /done, the launcher
 * is a 48px icon below 980px, and the consent banner fits the phone with a 12px gutter.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hideFloatingOn } from "@/site/components/chrome/Chrome";

const read = (f: string) => readFileSync(f, "utf8");

describe("hideFloatingOn", () => {
  it("hides on the pay and paid pages", () => {
    expect(hideFloatingOn("/checkout")).toBe(true);
    expect(hideFloatingOn("/checkout/step-2")).toBe(true);
    expect(hideFloatingOn("/done")).toBe(true);
  });

  it("keeps them everywhere else, including the cart and look-alike paths", () => {
    for (const p of ["/", "/cart", "/quote", "/hosting", "/checkouts", "/donate", "/about/done"]) {
      expect(hideFloatingOn(p)).toBe(false);
    }
    expect(hideFloatingOn(null)).toBe(false);
    expect(hideFloatingOn(undefined)).toBe(false);
  });
});

describe("floating boxes on a phone", () => {
  const chat = read("src/site/components/agent/AgentChat.tsx");
  const chrome = read("src/site/components/chrome/Chrome.tsx");

  it("AI chat launcher and WhatsApp pill both step aside on /checkout and /done", () => {
    expect(chat).toMatch(/if \(hideFloatingOn\(pathname\)\) return null;/);
    expect(chrome).toMatch(/if \(!WHATSAPP_READY \|\| hideFloatingOn\(pathname\)\) return null;/);
  });

  it("the AI launcher becomes a 48px icon below 980px and keeps its accessible name", () => {
    expect(chat).toMatch(/aria-label="Talk to our live AI sales agent"/);
    expect(chat).toMatch(/@media \(max-width: 979px\)[\s\S]*\.agent-launcher \{[^}]*width: 48px; height: 48px;/);
    expect(chat).toMatch(/\.agent-launcher-text, \.agent-launcher-dot \{ display: none; \}/);
    // position/size must not sit in the inline style, or it beats the media query
    expect(chat).not.toMatch(/position: "fixed", right: 22, bottom: 78/);
    expect(chat).not.toMatch(/padding: "12px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer"/);
  });

  it("the consent banner fits a 375px screen (no maxWidth 360 hanging off the edge)", () => {
    expect(chrome).not.toMatch(/left: 22, bottom: 22, zIndex: 95, maxWidth: 360/);
    expect(chrome).toMatch(/@media \(max-width: 979px\) \{\s*\.consent-banner \{ left: 12px; right: 12px; bottom: 12px; max-width: none; \}/);
  });
});
