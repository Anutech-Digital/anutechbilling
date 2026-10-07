import { describe, it, expect, vi } from "vitest";
import { planPricePerSeat, catalogRowForPlan } from "./plan-price";
import { workspaceListPriceGap } from "./workspace-floor";
import { catalogYearlyPrice, lineFromCatalog } from "@/lib/quotes/catalog-line";
import type { Item } from "@/lib/supabase/database.types";

vi.spyOn(console, "warn").mockImplementation(() => {});

// The local tenant's real rows on 7 Oct 2026 (items, tenant fbb976f1…): the old ₹136/₹736 seed.
const CATALOG = [
  { id: "GW-STR-t", name: "Google Workspace Business Starter", item_type: "subscription", is_active: true, msrp: 136, wholesale: 110,
    prices: { annual: { msrp: 136, wholesale: 110 }, monthly: { msrp: 170, wholesale: 138 } } },
  { id: "GW-STD-t", name: "Google Workspace Standard", item_type: "subscription", is_active: true, msrp: 736, wholesale: 620,
    prices: { annual: { msrp: 736, wholesale: 620 }, monthly: { msrp: 920, wholesale: 780 } } },
  { id: "GW-PLS-t", name: "Google Workspace Plus", item_type: "subscription", is_active: true, msrp: 1380, wholesale: 1150,
    prices: { annual: { msrp: 1380, wholesale: 1150 } } },
  { id: "SUP-GW-STR-t-MO", name: "Google Workspace Business Starter Support", item_type: "subscription", is_active: true, msrp: 999, wholesale: 0, prices: {} },
  { id: "M365-BB-t", name: "Microsoft 365 Business Basic", item_type: "subscription", is_active: true, msrp: 160, wholesale: 120, prices: {} },
] as unknown as Item[];

const FALLBACK = {
  "Google Workspace Business Starter": 270,
  "Google Workspace Standard": 1080,
  "Microsoft 365 Business Basic": 145,
  "Zoho Workplace Standard": 105,
};

describe("R-387 — lead plan and quote catalogue give the same rate", () => {
  it("GW Standard: lead prefill = Add item → From catalog = ₹1,080/seat/mo (₹12,960/yr)", () => {
    const lead = planPricePerSeat("Google Workspace Standard", CATALOG, FALLBACK);
    const quoteLine = lineFromCatalog(catalogRowForPlan("Google Workspace Standard", CATALOG)! as never);
    expect(lead).toEqual({ perSeatPm: 1080, source: "catalog", itemId: "GW-STD-t" });
    expect(quoteLine.rate).toBe(lead!.perSeatPm * 12);
  });

  it("GW Starter: both paths ₹270 — not the stale ₹136 row", () => {
    const lead = planPricePerSeat("Google Workspace Business Starter", CATALOG, FALLBACK)!;
    expect(lead.perSeatPm).toBe(270);
    expect(catalogYearlyPrice(CATALOG[0] as never).rate).toBe(lead.perSeatPm * 12);
  });

  it("the catalogue wins over the form's own map when they differ (M365 ₹160, not ₹145)", () => {
    expect(planPricePerSeat("Microsoft 365 Business Basic", CATALOG, FALLBACK)).toEqual({ perSeatPm: 160, source: "catalog", itemId: "M365-BB-t" });
  });

  it("a catalogue price ABOVE list (a price rise) reaches the lead too", () => {
    const risen = [{ ...(CATALOG[1] as object), msrp: 1200, prices: { annual: { msrp: 1200, wholesale: 620 } } }] as unknown as Item[];
    expect(planPricePerSeat("Google Workspace Standard", risen, FALLBACK)!.perSeatPm).toBe(1200);
  });

  it("no catalogue row → the fallback, labelled as list price; unknown plan → nothing", () => {
    expect(planPricePerSeat("Zoho Workplace Standard", CATALOG, FALLBACK)).toEqual({ perSeatPm: 105, source: "list" });
    expect(planPricePerSeat("Custom / Mixed", CATALOG, FALLBACK)).toBeUndefined();
    expect(planPricePerSeat("Google Workspace Standard", [], FALLBACK)).toEqual({ perSeatPm: 1080, source: "list" });
  });

  it("matches the tier under the catalogue's wording, never a support plan or inactive row", () => {
    expect(catalogRowForPlan("Google Workspace Starter", CATALOG)?.id).toBe("GW-STR-t");
    const onlySupport = [CATALOG[3], { ...(CATALOG[0] as object), is_active: false }] as unknown as Item[];
    expect(catalogRowForPlan("Google Workspace Business Starter", onlySupport)).toBeUndefined();
  });
});

describe("R-387 — /items warns when the catalogue is under the list price", () => {
  it("flags the stale ₹136 / ₹736 rows with what quotes use instead", () => {
    expect(workspaceListPriceGap(CATALOG[0] as never)).toEqual({ itemId: "GW-STR-t", name: "Google Workspace Business Starter", catalogPm: 136, listPm: 270 });
    expect(workspaceListPriceGap(CATALOG[1] as never)).toEqual({ itemId: "GW-STD-t", name: "Google Workspace Standard", catalogPm: 736, listPm: 1080 });
  });
  it("no warning at list, above list, for support plans, ₹0 rows or other vendors", () => {
    expect(workspaceListPriceGap(CATALOG[2] as never)).toBeNull();
    expect(workspaceListPriceGap({ id: "x", name: "Google Workspace Standard", msrp: 1200, prices: {} })).toBeNull();
    expect(workspaceListPriceGap(CATALOG[3] as never)).toBeNull();
    expect(workspaceListPriceGap({ id: "y", name: "Google Workspace Standard", msrp: 0, prices: {} })).toBeNull();
    expect(workspaceListPriceGap(CATALOG[4] as never)).toBeNull();
  });
});
