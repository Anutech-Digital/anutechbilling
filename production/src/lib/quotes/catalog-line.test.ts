import { describe, it, expect } from "vitest";
import { catalogYearlyPrice, lineFromCatalog } from "./catalog-line";

describe("catalog → quote line (2 Oct 2026)", () => {
  it("a monthly-priced licence is ₹/mo × 12", () => {
    expect(catalogYearlyPrice({ msrp: 136, wholesale: 110, prices: {} } as never)).toEqual({ rate: 1632, cost: 1320 });
  });
  it("the annual tier wins over msrp", () => {
    expect(catalogYearlyPrice({ msrp: 170, wholesale: 140, prices: { annual: { msrp: 136, wholesale: 110 } } } as never)).toEqual({ rate: 1632, cost: 1320 });
  });
  it("a yearly-total plan is used verbatim — never a ₹0 line", () => {
    expect(catalogYearlyPrice({ msrp: 0, wholesale: 0, prices: { annual_total: { msrp: 9996, wholesale: 0 } } } as never)).toEqual({ rate: 9996, cost: 0 });
  });
  it("support defaults to one, a licence to ten, an explicit qty wins", () => {
    const sup = lineFromCatalog({ id: "SUP-GW-STR-t-YR", name: "S", vendor: "support", msrp: 0, wholesale: 0, prices: { annual_total: { msrp: 9996 } } } as never);
    expect(sup.qty).toBe(1);
    expect(sup.rate).toBe(9996);
    const lic = lineFromCatalog({ id: "GW-STR-t", name: "G", vendor: "google", msrp: 136, wholesale: 110, prices: {} } as never);
    expect(lic.qty).toBe(10);
    expect(lineFromCatalog({ id: "GW-STR-t", name: "G", vendor: "google", msrp: 136, wholesale: 110, prices: {} } as never, { qty: 25 }).qty).toBe(25);
  });
});

describe("R-387 — one product, one price, whichever adder", () => {
  // The local tenant's real rows (7 Oct): the old seed's ₹136 / ₹736.
  const starter  = { id: "GW-STR-t", name: "Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110,
    prices: { annual: { msrp: 136, wholesale: 110 }, monthly: { msrp: 170, wholesale: 138 } } };
  const standard = { id: "GW-STD-t", name: "Google Workspace Standard", vendor: "google", msrp: 736, wholesale: 620,
    prices: { annual: { msrp: 736, wholesale: 620 }, monthly: { msrp: 920, wholesale: 780 } } };

  it("Add item → From catalog quotes the list price, not the stale ₹136 / ₹736 row", () => {
    expect(catalogYearlyPrice(starter as never)).toEqual({ rate: 270 * 12, cost: 110 * 12 });
    expect(catalogYearlyPrice(standard as never)).toEqual({ rate: 1080 * 12, cost: 620 * 12 });
    expect(lineFromCatalog(standard as never).rate).toBe(12960);
  });
  it("a support plan named after a tier is not lifted to the licence price", () => {
    const sup = { id: "SUP-GW-STR-t-MO", name: "Google Workspace Business Starter Support", vendor: "support", msrp: 199, wholesale: 0, prices: {} };
    expect(catalogYearlyPrice(sup as never).rate).toBe(199 * 12);
  });
});
