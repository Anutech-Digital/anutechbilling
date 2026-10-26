/**
 * R-1967: the Workspace order lines for Annual or Monthly (flex). Annual must be exactly what
 * buildLinesFromCatalog gave before; Monthly is ONE month at the catalogue's flex rate.
 * Pardeep (26 Oct 2026): flex Starter ₹325, Standard ₹1,300; annual ₹270 / ₹1,080 unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { COMMIT_CHOICES, commitmentForChoice } from "@/lib/quotes/line-commit-choice";
import {
  BUY_COMMITMENTS, WORKSPACE_FLEX_LIST_PRICE_PM, buildFlexLinesFromCatalog, buildLinesFromCatalog, buildOrderLines,
  type CatalogPriceRow,
} from "./pricing";

vi.spyOn(console, "warn").mockImplementation(() => {});

const ROW: CatalogPriceRow = {
  id: "GW-STR", name: "Google Workspace Business Starter", msrp: 270, wholesale: 0,
  prices: { annual: { msrp: 270, wholesale: 0 }, monthly: { msrp: 325, wholesale: 0 } },
};
type Built = { items: { id: string }[] } & Record<string, unknown>;
const strip = (b: Built) => ({ ...b, items: b.items.map(({ id: _id, ...l }) => l) });

describe("R-1967 buildOrderLines", () => {
  it("Annual = the old buildLinesFromCatalog, unchanged (10 Starter: ₹32,400 + GST = ₹38,232)", () => {
    for (const seats of [1, 10, 37, 300]) {
      expect(strip(buildOrderLines(ROW, "starter", seats, "annual") as Built)).toEqual(strip(buildLinesFromCatalog(ROW, "starter", seats)));
    }
    const a = buildOrderLines(ROW, "starter", 10, "annual")!;
    expect(a.subtotal).toBe(32400);
    expect(a.amount).toBe(38232);
    expect(a.items[0].commitment).toBe("annual_yearly");
  });

  it("Monthly = users × flex rate, ONE month, +GST, a monthly line", () => {
    const m = buildOrderLines(ROW, "starter", 10, "monthly")!;
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ qty: 10, rate: 325, commitment: commitmentForChoice("monthly") });
    expect(m.items[0].name).toBe("Google Workspace Business Starter — monthly (flex)");
    expect(m.subtotal).toBe(3250);
    expect(m.amount).toBe(Math.round(3250 * 1.18)); // ₹3,835
  });

  it("no catalogue row → Pardeep's flex list price (₹325 / ₹1,300); Plus/Enterprise not sold monthly", () => {
    expect(WORKSPACE_FLEX_LIST_PRICE_PM).toEqual({ starter: 325, standard: 1300 });
    expect(buildFlexLinesFromCatalog(null, "starter", 2)!.subtotal).toBe(650);
    expect(buildFlexLinesFromCatalog(null, "standard", 2)!.subtotal).toBe(2600);
    expect(buildFlexLinesFromCatalog(null, "plus", 2)).toBeNull();
    expect(buildFlexLinesFromCatalog(null, "enterprise", 2)).toBeNull();
  });

  it("a row without a flex price, or with one not above annual (stale), is not sold monthly", () => {
    expect(buildFlexLinesFromCatalog({ ...ROW, prices: { annual: { msrp: 270, wholesale: 0 } } }, "starter", 5)).toBeNull();
    expect(buildFlexLinesFromCatalog({ ...ROW, prices: { annual: { msrp: 270, wholesale: 0 }, monthly: { msrp: 200, wholesale: 0 } } }, "starter", 5)).toBeNull();
  });

  it("the website's two choices are the quote builder's own COMMIT_CHOICES values", () => {
    const values = COMMIT_CHOICES.map((c) => c.value);
    for (const c of BUY_COMMITMENTS) expect(values).toContain(c);
    expect(commitmentForChoice("annual")).toBe("annual_yearly");
  });
});
