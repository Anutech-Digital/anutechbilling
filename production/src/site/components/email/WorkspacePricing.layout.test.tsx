// @vitest-environment jsdom
//
// R-1495 (17 Oct 2026, Pawan on staging): "/google-workspace/pricing page is totally broken".
// At laptop widths below 1280px the four plan cards sat in ONE row (4 columns down to 1000px),
// each card a thin strip; "Contact us for pricing" / "Let's talk" at 28px wrapped into huge
// blocks; the floating AI / WhatsApp buttons and the cookie banner sat over the plan prices.
//
// The page's layout lives in the component's own <style> block, so this test reads that CSS
// (class scan) and pins the rules at 375 / 768 / 1280px:
//   - phone 1 column, tablet (md, 768px) 2 columns, 4 columns ONLY from xl (1280px);
//   - card heading, price and "talk" headings step up with the width instead of starting big;
//   - the page leaves room at the bottom for the floating buttons (safe-area aware) and, while
//     the cookie banner is open, for the banner too; on a phone the AI launcher steps aside
//     while the plan cards are on screen (data-avoid-floating, R-464 rule).
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { WorkspacePricing, type PricedPlan } from "./WorkspacePricing";
import { AVOID_FLOATING_ATTR } from "@/site/components/chrome/floating";

afterEach(cleanup);

const plans: PricedPlan[] = [
  { key: "starter", edition: "GW Business Starter", annual: 270, monthly: 324 },
  { key: "standard", edition: "GW Business Standard", annual: 1080, monthly: 1296 },
  { key: "plus", edition: "GW Business Plus", annual: null, monthly: null },
  { key: "enterprise", edition: null, annual: null, monthly: null },
];

type Rule = { media: string | null; selector: string; body: string };

/** Flat list of CSS rules, each with the @media condition it sits in (one level deep). */
function parse(raw: string): Rule[] {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  const readBlock = (media: string | null, end: number) => {
    while (i < end) {
      const open = css.indexOf("{", i);
      if (open < 0 || open >= end) { i = end; return; }
      const head = css.slice(i, open).trim();
      if (head.startsWith("@media")) {
        // find the matching close brace
        let depth = 1; let j = open + 1;
        while (depth > 0 && j < css.length) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
        i = open + 1;
        readBlock(head.replace(/^@media\s*/, ""), j - 1);
        i = j;
      } else {
        const close = css.indexOf("}", open);
        out.push({ media, selector: head, body: css.slice(open + 1, close) });
        i = close + 1;
      }
    }
  };
  readBlock(null, css.length);
  return out;
}

function css(): Rule[] {
  const { container } = render(<WorkspacePricing plans={plans} />);
  const style = container.querySelector("style");
  if (!style?.textContent) throw new Error("no <style> in WorkspacePricing");
  return parse(style.textContent);
}

/** Rules that apply at `width` px (min-width / max-width conditions only). */
function at(rules: Rule[], width: number): Rule[] {
  return rules.filter((r) => {
    if (r.media == null) return true;
    const min = /min-width:\s*(\d+)px/.exec(r.media);
    const max = /max-width:\s*(\d+)px/.exec(r.media);
    if (min && width < Number(min[1])) return false;
    if (max && width > Number(max[1])) return false;
    return true;
  });
}

/** The last value of `prop` for a rule whose selector list includes `sel`, at `width`. */
function value(rules: Rule[], width: number, sel: string, prop: string): string | null {
  let v: string | null = null;
  for (const r of at(rules, width)) {
    if (!r.selector.split(",").map((s) => s.trim()).includes(sel)) continue;
    for (const decl of r.body.split(";")) {
      const k = decl.slice(0, decl.indexOf(":")).trim();
      if (k === prop) v = decl.slice(decl.indexOf(":") + 1).trim();
    }
  }
  return v;
}

const columns = (v: string | null): number => {
  if (!v) return 0;
  if (/^1fr$|^minmax\(0,\s*1fr\)$/.test(v)) return 1;
  const m = /^repeat\((\d+)/.exec(v);
  if (m) return Number(m[1]);
  if (/^repeat\(var\(--n/.test(v)) return 4;
  return -1;
};
const px = (v: string | null): number => Number(/(\d+(?:\.\d+)?)px/.exec(v ?? "")?.[1] ?? NaN);

describe("Workspace pricing layout (R-1495)", () => {
  it("plan grid: 1 column on a phone, 2 on a tablet / small laptop, 4 only from 1280px", () => {
    const r = css();
    for (const w of [375, 620, 767]) expect(columns(value(r, w, ".wp-cards", "grid-template-columns")), `${w}px`).toBe(1);
    for (const w of [768, 800, 1000, 1100, 1279]) expect(columns(value(r, w, ".wp-cards", "grid-template-columns")), `${w}px`).toBe(2);
    for (const w of [1280, 1536]) expect(columns(value(r, w, ".wp-cards", "grid-template-columns")), `${w}px`).toBe(4);
  });

  it("card headings, the price and 'Contact us for pricing' start smaller and step up with the width", () => {
    const r = css();
    const h3 = [375, 768, 1280].map((w) => px(value(r, w, ".wp-card h3", "font-size")));
    const price = [375, 768, 1280].map((w) => px(value(r, w, ".wp-price b", "font-size")));
    const talk = [375, 768, 1280].map((w) => px(value(r, w, ".wp-price .wp-talk", "font-size")));
    for (const [name, s] of [["h3", h3], ["price", price], ["talk", talk]] as const) {
      expect(s.every(Number.isFinite), name).toBe(true);
      expect(s[0], `${name} phone ≤ tablet`).toBeLessThanOrEqual(s[1]);
      expect(s[1], `${name} tablet ≤ desktop`).toBeLessThanOrEqual(s[2]);
    }
    expect(h3[0]).toBeLessThanOrEqual(22);
    expect(talk[0]).toBeLessThanOrEqual(22);
    // "Contact us for pricing" never out-shouts a real price.
    for (let k = 0; k < 3; k++) expect(talk[k]).toBeLessThan(price[k]);
  });

  it("the page leaves room for the floating buttons (safe area) and for the open cookie banner", () => {
    const r = css();
    const pad = value(r, 375, ".wp-root", "padding-bottom") ?? "";
    expect(pad).toMatch(/env\(safe-area-inset-bottom/);
    expect(px(pad)).toBeGreaterThanOrEqual(72);
    const banner = r.find((x) => x.media == null && /:has\(\.consent-banner\)/.test(x.selector) && /\.wp-root/.test(x.selector));
    expect(banner, "padding while the cookie banner is open").toBeTruthy();
    expect(px(/padding-bottom:([^;]+)/.exec(banner?.body ?? "")?.[1] ?? null)).toBeGreaterThan(px(pad));
  });

  it("on a phone the floating AI launcher steps aside while the plan cards are on screen", () => {
    const { container } = render(<WorkspacePricing plans={plans} />);
    expect(container.querySelector(".wp-cards")?.hasAttribute(AVOID_FLOATING_ATTR)).toBe(true);
  });

  /* R-1495 galat (Pawan, 17 Oct): on a phone the AI launcher still sat over buttons further
     down — measured at 390px it covered the FAQ rows' "+" toggles. The FAQ steps it aside too. */
  it("on a phone the launcher also steps aside while the pricing FAQ is on screen", () => {
    const { container } = render(<WorkspacePricing plans={plans} />);
    expect(container.querySelector(".wp-faq")?.hasAttribute(AVOID_FLOATING_ATTR)).toBe(true);
  });
});
