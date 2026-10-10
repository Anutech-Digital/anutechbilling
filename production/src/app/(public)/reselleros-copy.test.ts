/**
 * R-463 (owner, 9 Oct 2026): ResellerOS is "Free during beta". No "14-day trial" or
 * "free trial" wording anywhere in the ResellerOS public copy — landing, pricing, about,
 * and the company header's ResellerOS promo. Google Workspace / hosting trials are a
 * different thing (the customer's own product trial) and live in other files, untouched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PRICING_LINE } from "@/site/lib/data/reselleros-home";

const FILES = [
  "src/app/(public)/_components/landing-sections.tsx",
  "src/app/(public)/_components/pricing-sections.tsx",
  "src/app/(public)/about/page.tsx",
  "src/app/(public)/pricing/page.tsx",
  "src/site/components/product/ProductChrome.tsx",
];

describe("ResellerOS public copy — Free during beta, no trial wording (R-463)", () => {
  for (const f of FILES) {
    it(`${f} has no trial wording`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/14[- ]day|14 days|fourteen days/i);
      expect(src).not.toMatch(/trial/i);
    });
  }

  it("landing, pricing tiers and about show the one beta line", () => {
    expect(PRICING_LINE).toMatch(/Free during beta/);
    for (const f of FILES.slice(0, 3)) expect(readFileSync(f, "utf8")).toContain("PRICING_LINE");
  });

  it("the company header's ResellerOS promo says Get started free, not a trial", () => {
    const header = readFileSync("src/site/components/chrome/Header.tsx", "utf8");
    const promo = header.split("\n").find((l) => l.includes('href: "/reselleros", os: true'));
    expect(promo).toBeDefined();
    expect(promo).toContain('cta: "Get started free"');
    expect(promo).not.toMatch(/trial/i);
  });
});
