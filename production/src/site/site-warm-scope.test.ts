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
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
/** site-warm.css plus every per-page file under src/site/warm/ — all held to the same rules. */
const warmDir = path.join(root, "src/site/warm");
const warmFiles = ["src/site/site-warm.css", ...readdirSync(warmDir).filter((f) => f.endsWith(".css")).map((f) => `src/site/warm/${f}`)];
const css = warmFiles.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
const layout = readFileSync(path.join(root, "src/app/(marketing)/layout.tsx"), "utf8");

/** The company site's wrapper, or the ResellerOS product site's ((product)/layout.tsx). Nothing
 *  else can match a warm rule — and no root prefix: Warm is light only (owner, 16 Nov 2026: the
 *  light/dark switch and the dark variant were removed), so a ":root[data-theme=…]" rule fails here. */
const SCOPES = ['.anutech-site[data-site-theme="warm"]', '.anutech-product[data-site-theme="warm"]', '.w-scope[data-site-theme="warm"]'];
const inScope = (sel: string) => SCOPES.some((sc) => sel.startsWith(sc));

/** Split a selector list on top-level commas only — a comma inside :is()/:has()/:not(), however
 *  deeply nested, belongs to that selector (a one-level regex split cut ":has(a:nth-child(3), b)"). */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every selector list in the file, comments removed, @media/@supports wrappers unwrapped. */
function selectors(source: string): string[] {
  // @keyframes steps ("0%, 22% { … }") are not selectors — they style nothing on their own.
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of splitSelectorList(sel)) out.push(part);
  }
  return out;
}

describe("site-warm.css is opt-in only", () => {
  const list = selectors(css);

  it("has rules to check (the parser found the file's selectors)", () => {
    expect(list.length).toBeGreaterThan(15);
  });

  it("every selector starts with the warm scope", () => {
    const unscoped = list.filter((s) => !inScope(s));
    expect(unscoped).toEqual([]);
  });

  /* Warm is light only (owner, 16 Nov 2026: remove the light/dark switch and its functionality).
     A dark rule would show only on dark-mode devices — with no switch to get back to light. */
  it("has no dark mode: no prefers-color-scheme block and no data-theme selector", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/prefers-color-scheme/);
    expect(code).not.toMatch(/\[data-theme=/);
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

/**
 * Theme only — never content (Pawan, 13 Nov 2026: "Only content cannot be changed. Layout and
 * colour combo are free to change"). A warm rule may hide a DECORATION (::before / ::after) but
 * never a real element: hiding the six steps' "You" / "We" tags was caught by eye on 14 Nov;
 * this makes the next one fail here instead.
 */
describe("site-warm.css never hides page content", () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const rules = [...noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const HIDES = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px)?\s*[;}]|opacity\s*:\s*0\s*[;}])/;

  it("finds rules to check", () => {
    expect(rules.length).toBeGreaterThan(50);
  });

  /* The ONE real element Warm may hide: the inline header menus at 980–1339px, where the design
     shows the drawer instead (docs/WEBSITE-THEME.md "full nav with dropdowns ≥1340px; drawer
     below"). Nothing is lost — the same pages are in the drawer (nav "Mobile"), and the test below
     fails if the drawer button is not shown in that same range. */
  const HEADER_MENUS = '.anutech-site[data-site-theme="warm"] > header .hdr-row > nav[aria-label="Main"]';
  /* Two decorations of the home's ResellerOS drawing (ProductPeek, aria-hidden — its caption is
     the text alternative): the grey placeholder bars and the pulsing dot, which the design does
     not draw. No words, no meaning. */
  const PEEK_DECOR = ['.anutech-site[data-site-theme="warm"] .hc .pk-skel', '.anutech-site[data-site-theme="warm"] .hc .pk-dot'];
  /* The header menus' Classic "▾" glyph (aria-hidden decoration), replaced on Warm by the design's
     chevron (svg.nav-chev, w-only) — the test below checks the replacement is there. */
  const NAV_CARET = '.anutech-site[data-site-theme="warm"] > header .nav-item > .nav-caret';

  it("only ::before / ::after are ever hidden", () => {
    const offenders = rules
      .filter((r) => HIDES.test(r.body + ";"))
      .flatMap((r) => splitSelectorList(r.sel))
      .filter((s) => !/::(before|after)\s*$/.test(s))
      // The theme's OWN controls (class prefix .w-, e.g. .w-to-top's "hidden until you scroll")
      // are not page content; anything else hidden is.
      .filter((s) => !/\.w-[a-z0-9-]+(\[[^\]]*\])*\s*$/.test(s))
      .filter((s) => s !== HEADER_MENUS)
      .filter((s) => !PEEK_DECOR.includes(s))
      .filter((s) => s !== NAV_CARET);
    expect(offenders).toEqual([]);
  });

  it("the header's ▾ glyph it hides is decoration with the Warm chevron right beside it", () => {
    const src = readFileSync(path.join(root, "src/site/components/chrome/Header.tsx"), "utf8");
    expect(src).toMatch(/<span className="nav-caret" aria-hidden[^>]*>▾<\/span>/);
    expect(src).toMatch(/<span className="nav-caret"[^\n]*\n[^\n]*\n\s*<svg className="w-only nav-chev" aria-hidden="true"/);
  });

  it("the ProductPeek decorations it hides are inside the aria-hidden drawing and carry no words", () => {
    const src = readFileSync(path.join(root, "src/site/components/home/ProductPeek.tsx"), "utf8");
    expect(src).toMatch(/<div className="pk-win" aria-hidden="true">/);
    // empty elements only: <span className="pk-skel" /> and <span className="pk-dot" />
    for (const cls of ["pk-skel", "pk-dot"]) {
      const tags = [...src.matchAll(new RegExp(`<span className="${cls}[^"]*"[^>]*?(/?)>`, "g"))];
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(t[1]).toBe("/");
    }
  });

  it("the header menus are hidden only at 980–1339px, and only with the drawer button shown there", () => {
    const block = noComments.match(/@media \(min-width: 980px\) and \(max-width: 1339px\) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g) ?? [];
    const hidesMenus = block.filter((b) => b.includes(HEADER_MENUS) && /display:\s*none/.test(b));
    expect(hidesMenus).toHaveLength(1);
    expect(hidesMenus[0]).toMatch(/> button\.only-mobile \{ display: inline-flex !important/);
    // …and nowhere else.
    const everywhere = rules.filter((r) => splitSelectorList(r.sel).includes(HEADER_MENUS) && HIDES.test(r.body + ";"));
    expect(everywhere).toHaveLength(1);
  });
});

describe("every warm stylesheet is loaded where its pages render", () => {
  const product = readFileSync(path.join(root, "src/app/(product)/layout.tsx"), "utf8");
  it("the company site's layout imports each page-group file except product.css", () => {
    for (const f of warmFiles.filter((f) => f.startsWith("src/site/warm/") && !f.endsWith("product.css") && !f.includes("/extra-"))) {
      expect(layout).toContain(`import "@/${f.replace(/^src\//, "")}";`);
    }
  });
  it("the product site reads the same switch and loads product.css", () => {
    expect(product).toMatch(/getWebsiteTheme\(websiteTenantId\(\)\)/);
    expect(product).toMatch(/data-site-theme=\{theme\}/);
    expect(product).toContain('import "@/site/warm/product.css";');
  });
});

describe("Warm-only elements (class w-only) never show on Classic", () => {
  const gate = readFileSync(path.join(root, "src/site/warm-only.css"), "utf8");
  const product = readFileSync(path.join(root, "src/app/(product)/layout.tsx"), "utf8");
  it("the gate hides .w-only on any site wrapper that is not on Warm", () => {
    expect(gate).toContain('.w-scope:not([data-site-theme="warm"]) .w-only, :is(.anutech-site, .anutech-product):not([data-site-theme="warm"]) .w-only { display: none !important; }');
  });
  it("both layouts load the gate", () => {
    expect(layout).toContain('import "@/site/warm-only.css";');
    expect(product).toContain('import "@/site/warm-only.css";');
  });
});

describe("WarmScope (pages outside the website layouts)", () => {
  const scope = readFileSync(path.join(root, "src/site/components/chrome/WarmScope.tsx"), "utf8");
  it("never creates a box, so Classic lays out exactly as before", () => {
    expect(scope).toMatch(/style=\{\{ display: "contents" \}\}/);
  });
  it("reads the same switch and loads the gate and every extra-*.css", () => {
    expect(scope).toMatch(/getWebsiteTheme\(websiteTenantId\(\)\)/);
    expect(scope).toContain('import "@/site/warm-only.css";');
    for (const f of warmFiles.filter((f) => f.includes("/extra-"))) {
      expect(scope).toContain(`import "@/${f.replace(/^src\//, "")}";`);
    }
  });
});

describe("the company header/footer around extra pages appear on Warm only", () => {
  const scope = readFileSync(path.join(root, "src/site/components/chrome/WarmScope.tsx"), "utf8");
  const chrome = readFileSync(path.join(root, "src/site/components/chrome/WarmSiteChrome.tsx"), "utf8");
  const shell = readFileSync(path.join(root, "src/app/(public)/_components/public-shell.tsx"), "utf8");
  const unsub = readFileSync(path.join(root, "src/app/(public)/unsubscribe/page.tsx"), "utf8");
  it("WarmScope adds them only when the theme is warm", () => {
    expect(scope).toContain('theme === "warm" && siteChrome ? <WarmSiteChrome>');
  });
  it("the nested-segment helper checks the theme too", () => {
    expect(chrome).toContain('theme === "warm" ? <WarmSiteChrome>{children}</WarmSiteChrome> : <>{children}</>');
  });
  it("unsubscribe drops its own bars only on Warm (no double header), and PublicShell keeps them by default", () => {
    expect(unsub).toContain('bars={theme !== "warm"}');
    expect(shell).toMatch(/bars = true/);
  });
});
