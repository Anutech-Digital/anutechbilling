// @vitest-environment jsdom
//
// R-1454 (Pawan, staging AI Help ×2): the home page was a wall of text — no picture, no colour,
// no motion. It now has a hero drawing of the real ResellerOS "Today" screen, icons on every
// feature tile and project step, and light scroll motion. This pins the parts that must not
// quietly regress:
//  - the hero visual is there, built from HTML/CSS (no image file → no LCP cost, no stock photo),
//    and it shows no invented numbers, amounts or customer names;
//  - every feature tile carries an icon;
//  - motion is opt-out: reduced-motion visitors get nothing hidden or moved, and nothing above the
//    fold is ever hidden (no flicker, nothing lost if JS is slow).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {} }) }));

import { HomeCompany } from "@/site/components/home/HomeCompany";
import { PEEK_CAPTION, PEEK_MENU, PEEK_ROWS } from "@/site/components/home/ProductPeek";

const read = (f: string) => readFileSync(f, "utf8");
const HOME = "src/site/components/home/HomeCompany.tsx";
const PEEK = "src/site/components/home/ProductPeek.tsx";

/** A controllable IntersectionObserver: tests fire entries by hand. */
let ioInstances: FakeIO[] = [];
class FakeIO {
  cb: IntersectionObserverCallback;
  targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) { this.cb = cb; ioInstances.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  fire(el: Element) {
    this.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const origRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  ioInstances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  setReducedMotion(false);
  // Everything marked data-reveal sits far below the fold, like on a real phone.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = this.hasAttribute("data-reveal") ? 5000 : 0;
    return { top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = origRect;
});

describe("home hero visual (R-1454)", () => {
  it("renders the ResellerOS drawing with a visible, honest caption", () => {
    const { container } = render(<HomeCompany />);
    const fig = container.querySelector("figure[data-hero-visual]");
    expect(fig).not.toBeNull();
    expect(screen.getByText(PEEK_CAPTION)).toBeTruthy();
    expect(PEEK_CAPTION).toMatch(/illustration/i);
    // The drawing is decorative; the caption is its text alternative.
    expect(fig!.querySelector(".pk-win")!.getAttribute("aria-hidden")).toBe("true");
    // It sits in the hero, next to the call-back form.
    expect(fig!.closest(".hc-hero")).not.toBeNull();
    expect(fig!.querySelector("img")).toBeNull();
  });

  it("shows no invented numbers, amounts or names — only real screen labels", () => {
    for (const r of PEEK_ROWS) expect(`${r.tag} ${r.text}`).not.toMatch(/[0-9₹%]/);
    for (const m of PEEK_MENU) expect(m).not.toMatch(/[0-9₹%]/);
    // The menu labels are ResellerOS's own (src/lib/nav.ts).
    const nav = read("src/lib/nav.ts");
    for (const m of PEEK_MENU) expect(nav, m).toContain(`label: "${m}"`);
  });

  it("is HTML/CSS only — no image file, no stock photo, no animation library", () => {
    const src = read(PEEK);
    expect(src).not.toMatch(/<img|url\(|\.(png|jpe?g|webp|gif|avif)\b/i);
    expect(src).not.toMatch(/from ["'](framer-motion|motion|gsap|react-spring|lottie)/);
    expect(read(HOME)).not.toMatch(/from ["'](framer-motion|motion|gsap|react-spring|lottie)/);
  });
});

describe("feature icons (R-1454)", () => {
  it("every 'what we automate' tile and project step has an icon", () => {
    const { container } = render(<HomeCompany />);
    const tiles = container.querySelectorAll("#software .hc-tile");
    expect(tiles.length).toBe(6);
    for (const t of tiles) expect(t.querySelector(".hc-ico svg"), t.textContent ?? "").not.toBeNull();
    const steps = container.querySelectorAll("#how .hc-steps li");
    expect(steps.length).toBe(6);
    for (const s of steps) expect(s.querySelector(".hc-step-n svg")).not.toBeNull();
  });
});

describe("scroll motion respects the visitor (R-1454)", () => {
  it("below-the-fold blocks wait, then appear when scrolled into view", () => {
    const { container } = render(<HomeCompany />);
    const waiting = container.querySelectorAll(".hc-wait");
    expect(waiting.length).toBeGreaterThan(0);
    const first = waiting[0];
    act(() => ioInstances[0].fire(first));
    expect(first.classList.contains("hc-wait")).toBe(false);
  });

  it("prefers-reduced-motion: nothing is hidden", () => {
    setReducedMotion(true);
    const { container } = render(<HomeCompany />);
    expect(container.querySelectorAll(".hc-wait").length).toBe(0);
  });

  it("nothing on screen at load is hidden", () => {
    Element.prototype.getBoundingClientRect = function () {
      return { top: 10, bottom: 110, left: 0, right: 100, width: 100, height: 100, x: 0, y: 10, toJSON: () => ({}) } as DOMRect;
    };
    const { container } = render(<HomeCompany />);
    expect(container.querySelectorAll(".hc-wait").length).toBe(0);
  });

  it("the server HTML never ships hidden blocks", () => {
    // hc-wait is only ever added by the effect — never written into the markup.
    expect(read(HOME)).not.toMatch(/className=["'{][^"'}]*hc-wait/);
  });

  it("every animation and the hide state live inside a no-preference media query", () => {
    for (const f of [HOME, PEEK]) {
      const css = read(f).split("const CSS = `")[1] ?? "";
      const blocks = css.split("@media (prefers-reduced-motion: no-preference){");
      // Outside those blocks: no animation, no hidden reveal state.
      expect(blocks[0], f).not.toMatch(/animation:|hc-wait/);
      for (const b of blocks.slice(1)) {
        const rest = b.slice(b.indexOf("\n}") + 2);
        expect(rest, f).not.toMatch(/animation:|hc-wait/);
      }
    }
  });
});

describe("no stock photos on the public site (R-1454)", () => {
  it("site components never pull images from stock libraries", () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) out.push(p);
      }
      return out;
    };
    for (const f of walk("src/site/components")) {
      expect(read(f), f).not.toMatch(/unsplash|pexels|shutterstock|istockphoto|gettyimages|freepik|stock-photo/i);
    }
  });
});
