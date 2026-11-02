/**
 * R-2028 (1) — a quote line typed by hand ("Google Workspace Business Starter (1 year)") has no
 * item_id and cost 0, so the quote went to "Needs approval" with every customer copy locked
 * (Pardeep's screenshot, 27 Oct, Q-4786-27-0001). The builder now asks "Is this <item>?" for
 * the tenant's own catalogue rows that match the typed name — best 1–3, never a guess across tiers.
 */
import { describe, it, expect } from "vitest";
import { suggestCatalogMatches } from "./typed-line-catalog-match";

const CATALOG = [
  { id: "v-std", name: "Google Voice Standard" },
  { id: "gw-start", name: "Google Workspace Business Starter" },
  { id: "gw-std", name: "Google Workspace Business Standard" },
  { id: "gw-plus", name: "Google Workspace Business Plus" },
  { id: "m365-std", name: "Microsoft 365 Business Standard" },
  { id: "zoho", name: "Zoho Workplace Standard" },
];

const names = (r: Array<{ name: string | null }>) => r.map((x) => x.name);

describe("suggestCatalogMatches — a typed line name → the tenant's own catalogue rows", () => {
  it("the owner's real line: 'Google Workspace Business Starter (1 year)' → Business Starter only", () => {
    expect(names(suggestCatalogMatches(CATALOG, "Google Workspace Business Starter (1 year)"))).toEqual([
      "Google Workspace Business Starter",
    ]);
  });

  it("a shorter typed tier name finds the same row ('GW Starter', 'google workspace starter')", () => {
    expect(names(suggestCatalogMatches(CATALOG, "GW Starter"))).toEqual(["Google Workspace Business Starter"]);
    expect(names(suggestCatalogMatches(CATALOG, "google workspace starter"))).toEqual(["Google Workspace Business Starter"]);
  });

  it("never offers another tier of the same product (Starter is not Standard)", () => {
    const r = names(suggestCatalogMatches(CATALOG, "Google Workspace Starter licence"));
    expect(r).not.toContain("Google Workspace Business Standard");
    expect(r).not.toContain("Google Voice Standard");
  });

  it("a family with no tier typed → up to 3 rows of that family, never another family", () => {
    const r = names(suggestCatalogMatches(CATALOG, "Google Workspace"));
    expect(r).toHaveLength(3);
    expect(r.every((n) => n?.startsWith("Google Workspace"))).toBe(true);
  });

  it("a name that matches nothing in the catalogue → no suggestion", () => {
    expect(suggestCatalogMatches(CATALOG, "Website design and hosting setup")).toEqual([]);
    expect(suggestCatalogMatches(CATALOG, "Annual maintenance (1 year)")).toEqual([]);
    expect(suggestCatalogMatches(CATALOG, "")).toEqual([]);
  });

  it("a tier word alone is not enough to guess a product ('Standard plan')", () => {
    expect(suggestCatalogMatches(CATALOG, "Standard plan")).toEqual([]);
  });

  it("a row with no name is never suggested; max is respected", () => {
    const withBlank = [{ id: "x", name: null }, ...CATALOG];
    expect(names(suggestCatalogMatches(withBlank, "Google Workspace", 2))).toHaveLength(2);
  });
});
