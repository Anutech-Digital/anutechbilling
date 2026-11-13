/**
 * The warm theme must be a pure OPT-IN layer: with the switch on "classic" (the default) the
 * website must look exactly as site.css draws it. That holds only while every rule in
 * site-warm.css is scoped under `.anutech-site[data-site-theme="warm"]` — one unscoped rule
 * would restyle the classic site (or the whole app) without anybody switching anything.
 *
 * Also pins the wiring: the (marketing) layout loads the file and sets data-site-theme from the
 * stored theme. A theme that is stored but never applied is a switch that does nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const css = readFileSync(path.join(root, "src/site/site-warm.css"), "utf8");
const layout = readFileSync(path.join(root, "src/app/(marketing)/layout.tsx"), "utf8");

const SCOPE = '.anutech-site[data-site-theme="warm"]';

/** Every selector list in the file, comments removed, @media/@supports wrappers unwrapped. */
function selectors(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(/,(?![^(]*\))/)) out.push(part.trim());
  }
  return out;
}

describe("site-warm.css is opt-in only", () => {
  const list = selectors(css);

  it("has rules to check (the parser found the file's selectors)", () => {
    expect(list.length).toBeGreaterThan(15);
  });

  it("every selector starts with the warm scope", () => {
    const unscoped = list.filter((s) => !s.startsWith(SCOPE));
    expect(unscoped).toEqual([]);
  });
});

describe("the (marketing) layout applies the stored theme", () => {
  it("loads site-warm.css after site.css", () => {
    const base = layout.indexOf('import "@/site/site.css";');
    const warm = layout.indexOf('import "@/site/site-warm.css";');
    expect(base).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(base);
  });

  it("reads the theme for the website company and puts it on the wrapper", () => {
    expect(layout).toMatch(/getWebsiteTheme\(websiteTenantId\(\)\)/);
    expect(layout).toMatch(/data-site-theme=\{theme\}/);
  });
});

/**
 * Page components (HomeV2's C palette, HomeCompany, ProductPeek) take their colours from
 * `var(--hv-…, <classic value>)`. Two ways that silently breaks:
 *   - a var with NO fallback → on the Classic site the colour resolves to nothing;
 *   - a var site-warm.css never sets → the Warm site keeps the classic colour there.
 */
describe("--hv-* page colours: classic fallback always, warm value always", () => {
  const files = ["src/site/components/home/HomeV2.tsx", "src/site/components/home/HomeCompany.tsx", "src/site/components/home/ProductPeek.tsx"];
  const sources = files.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
  const uses = [...sources.matchAll(/var\(--hv-([a-z0-9-]+)(\s*,)?/g)];
  const warmDefined = new Set([...css.matchAll(/--hv-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  it("finds the variables (the scan is reading the right files)", () => {
    expect(uses.length).toBeGreaterThan(20);
  });

  it("every use carries the classic value as its fallback", () => {
    const bare = uses.filter((m) => !m[2]).map((m) => m[1]);
    expect(bare).toEqual([]);
  });

  it("every variable a page uses is set by the warm theme", () => {
    const missing = [...new Set(uses.map((m) => m[1]))].filter((v) => !warmDefined.has(v));
    expect(missing).toEqual([]);
  });
});
