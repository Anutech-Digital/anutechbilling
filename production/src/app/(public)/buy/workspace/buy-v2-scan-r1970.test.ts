/**
 * R-1970 (DECISIONS 1–4, Pardeep 26 Oct 2026): the buy page's source never names the design's
 * historical company (a deny term — R-1432: never written in this repo, read from
 * SECRET_SCAN_DENY_TERMS, set in CI; the company comes from the tenant row), never
 * "Premier Partner" (only "Google Workspace reseller"), never the old ₹864 Standard promo, and
 * never brings the website cart back. Seeds and fallbacks carry Plus 1,500 / 1,800.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TIER_FALLBACK_MONTHLY } from "@/lib/pricing/workspace";
import { DEFAULT_CATALOG } from "@/lib/queries/items";
import { denyTermsRe } from "@/test/deny-terms";

const DIR = __dirname;
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { out.push(...sources(p)); continue; }
    if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const FILES = sources(DIR);

describe("R-1970 buy/workspace words and numbers", () => {
  it("scans the page and its parts", () => {
    const names = FILES.map((f) => relative(DIR, f).replace(/\\/g, "/"));
    expect(names).toContain("buy-workspace-client.tsx");
    expect(names).toContain("_parts/hero.tsx");
    expect(names).toContain("_parts/plan-cards.tsx");
  });

  it("no deny-listed company name, no 'Premier Partner', no 864 anywhere in the buy page source", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const re of [denyTermsRe(), /Premier Partner/i, /\b864\b/]) {
        if (re.test(src)) hits.push(`${relative(DIR, f)}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no website cart on this page (R-1966 superseded)", () => {
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/CartProvider|CartDrawer|HeaderCartLink|workspaceCartLine|Add to cart/);
    }
  });

  it("/checkout no longer sends a Workspace cart line to this page", () => {
    const co = readFileSync(join(DIR, "..", "..", "..", "(marketing)", "checkout", "page.tsx"), "utf8");
    expect(co).not.toMatch(/cartCheckoutHref|Opening the Google Workspace checkout/);
  });

  it("seeds and fallback: Plus 1,500 annual (list floor) and 1,800 monthly; Starter/Standard monthly 325 / 1,300", () => {
    expect(TIER_FALLBACK_MONTHLY.plus).toBe(1500);
    const monthly = (id: string) => DEFAULT_CATALOG.find((r) => r.id === id)?.prices.monthly?.msrp;
    expect(monthly("GW-STR")).toBe(325);
    expect(monthly("GW-STD")).toBe(1300);
    expect(monthly("GW-PLS")).toBe(1800);
    const client = readFileSync(join(DIR, "buy-workspace-client.tsx"), "utf8");
    expect(client).toMatch(/id: "plus",[\s\S]{0,200}monthlyPrice: isPublicPriceHiddenTier\("plus"\) \? null : 1800,\s*annualPrice: +isPublicPriceHiddenTier\("plus"\) \? null : 1500,/);
  });
});
