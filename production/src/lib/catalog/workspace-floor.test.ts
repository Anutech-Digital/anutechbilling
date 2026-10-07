import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_LIST_PRICE_PM, workspaceTierOf, floorWorkspacePrice, floorWorkspaceRow } from "./workspace-floor";
import { publicWorkspaceCatalog } from "./public-workspace";
import { buildWorkspaceLines, type CatalogPriceRow } from "@/lib/pricing/workspace";
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";

/* R-205 (6 Oct 2026): Pardeep — Starter ₹3,240/saal = ₹270/mo, Standard ₹1,080/mo.
   Website + app quote chips ₹136 (₹1,632/saal) dikha rahe the — cost ₹3,080 se bhi kam. */

vi.spyOn(console, "warn").mockImplementation(() => {});

/** The stale row as the old seed (lib/queries/items.ts DEFAULT_CATALOG) left it. */
const STALE_STARTER = {
  id: "GW-STR", name: "Google Workspace Business Starter", msrp: 136, wholesale: 110,
  prices: { monthly: { msrp: 170, wholesale: 138 }, annual: { msrp: 136, wholesale: 110 } },
};
const STALE_STANDARD = {
  id: "GW-STD", name: "Google Workspace Standard", msrp: 736, wholesale: 620,
  prices: { annual: { msrp: 736, wholesale: 620 } },
};

describe("list prices (Pardeep, 6 Oct)", () => {
  it("Starter ₹270 (₹3,240/yr), Standard ₹1,080 (₹12,960/yr), Plus ₹1,380", () => {
    expect(WORKSPACE_LIST_PRICE_PM).toEqual({ starter: 270, standard: 1080, plus: 1380 });
    expect(WORKSPACE_LIST_PRICE_PM.starter * 12).toBe(3240);
    expect(WORKSPACE_LIST_PRICE_PM.standard * 12).toBe(12960);
  });

  it("tier from app and website names; not Enterprise, not add-ons", () => {
    expect(workspaceTierOf("Google Workspace Business Starter")).toBe("starter");
    expect(workspaceTierOf("GW Business Standard")).toBe("standard");
    expect(workspaceTierOf("Google Workspace Plus")).toBe("plus");
    expect(workspaceTierOf("Google Workspace Enterprise")).toBeNull();
    expect(workspaceTierOf("Plus + Voice add-on")).toBeNull();
    expect(workspaceTierOf("Microsoft 365 Business Standard")).toBeNull();
  });
});

describe("the ₹136 row is never shown or quoted", () => {
  it("fails before the fix: the website catalogue gave Starter ₹136", () => {
    const out = publicWorkspaceCatalog([STALE_STARTER, STALE_STANDARD]);
    expect(out.find((i) => /starter/i.test(i.name))?.annualPerSeatMo).toBe(270);
    expect(out.find((i) => /standard/i.test(i.name))?.annualPerSeatMo).toBe(1080);
    for (const i of out) expect(i.annualPerSeatMo).toBeGreaterThanOrEqual(270);
  });

  it("a flexible price at or under annual is 'annual only', not ₹170", () => {
    const out = publicWorkspaceCatalog([STALE_STARTER]);
    expect(out[0].monthlyPerSeatMo).toBeNull();
  });

  it("quote chips / added lines (catalogYearlyPrice) quote ₹3,240 a seat, cost untouched", () => {
    const { rate, cost } = catalogYearlyPrice(floorWorkspaceRow(STALE_STARTER));
    expect(rate).toBe(3240);
    expect(cost).toBe(110 * 12);
  });

  it("'Get a quote' (buildWorkspaceLines) drafts ₹3,240 / ₹12,960 a seat", () => {
    expect(buildWorkspaceLines(floorWorkspaceRow(STALE_STARTER) as CatalogPriceRow, "starter", 1).items[0].rate).toBe(3240);
    expect(buildWorkspaceLines(floorWorkspaceRow(STALE_STANDARD) as CatalogPriceRow, "standard", 1).items[0].rate).toBe(12960);
  });

  it("a price ABOVE list is kept (a price rise still reaches every screen)", () => {
    expect(floorWorkspacePrice("Google Workspace Business Starter", 300)).toBe(300);
    const row = { name: "Google Workspace Business Starter", msrp: 270, prices: { annual: { msrp: 270 }, monthly: { msrp: 325 } } };
    expect(floorWorkspaceRow(row)).toBe(row);   // same object — nothing to fix
  });

  it("non-Workspace rows pass through untouched", () => {
    const row = { name: "Zoho Workplace Standard", msrp: 105, prices: null };
    expect(floorWorkspaceRow(row)).toBe(row);
  });

  it("no hard-coded ₹136 / ₹736 left in the quote form or the add-lead form", () => {
    for (const p of [
      ["src", "components", "features", "quotes", "quote-builder.tsx"],
      ["src", "components", "features", "leads", "add-lead-form.tsx"],
    ]) {
      const src = readFileSync(join(process.cwd(), ...p), "utf8");
      expect(src, p.join("/")).not.toMatch(/"Google Workspace[^"]*":\s*(136|736)\b/);
    }
  });
});
