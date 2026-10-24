/**
 * R-1455 (16 Oct 2026, Pawan on staging): the anutech.in footer's "About Anutech" opened
 * /about — the ResellerOS About page (site-split moves /about to reselleros.anutech.in), so a
 * shop visitor landed on the other brand. And tab titles read "About — ResellerOS · ResellerOS":
 * the page wrote the brand into its title AND the layout's template appended it again.
 *
 * There is no Anutech about page; /why-us is the company's own page on anutech.in, so the
 * company links point there until a real one is built.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOSTING_PROOFS } from "@/site/lib/data/hosting-landing-v2";
import { PRODUCT_PATHS, lookupMoved } from "@/site/lib/site-split";

const read = (f: string) => readFileSync(f, "utf8");

describe("company 'About' links stay on the Anutech site", () => {
  it("/about is a ResellerOS page (moved to the product host)", () => {
    expect(lookupMoved(PRODUCT_PATHS, "/about")).toBe("https://reselleros.anutech.in/about");
  });

  it("the anutech.in footer's About Anutech opens an Anutech page", () => {
    const c = read("src/site/components/chrome/Chrome.tsx");
    const m = c.match(/\["About Anutech", "([^"]+)"\]/);
    expect(m?.[1]).toBe("/why-us");
    expect(lookupMoved(PRODUCT_PATHS, m?.[1] ?? "")).toBeNull();
  });

  it("the hosting page's 'About the company' opens an Anutech page", () => {
    const about = HOSTING_PROOFS.find((p) => p.k === "COMPANY");
    expect(about?.href).toBe("/why-us");
  });
});

/** Route group → the brand its layout's title template appends. */
const GROUP_BRAND: Record<string, string> = {
  "src/app/(marketing)": "Anutech",
  "src/app/(lp)": "Anutech",
  "src/app/(public)": "ResellerOS", // root layout: "%s · ResellerOS"
  "src/app/(product)": "ResellerOS",
};

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return pages(p);
    return n === "page.tsx" ? [p] : [];
  });
}

/** The page's own templated title: `title: "…"` at the top of its metadata (absolute titles skip the template). */
function templatedTitle(src: string): string | null {
  const m = src.match(/^ {2}title:\s*["`]([^"`]+)["`]/m) ?? src.match(/metadata[^=]*=\s*\{\s*title:\s*["`]([^"`]+)["`]/);
  return m ? m[1] : null;
}

describe("tab titles name the site once", () => {
  for (const [group, brand] of Object.entries(GROUP_BRAND)) {
    it(`${group}: no page repeats "${brand}" before the template adds it`, () => {
      const doubled = pages(group)
        .map((f) => ({ f, t: templatedTitle(read(f)) }))
        .filter(({ t }) => t !== null && t.includes(brand))
        .map(({ f, t }) => `${f}: ${t}`);
      expect(doubled).toEqual([]);
    });
  }

  it("the pages Pawan named are fixed", () => {
    expect(templatedTitle(read("src/app/(public)/about/page.tsx"))).toBe("About");
    expect(templatedTitle(read("src/app/(public)/pricing/page.tsx"))).toBe("Pricing");
  });
});
