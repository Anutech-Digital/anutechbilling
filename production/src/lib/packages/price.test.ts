import { describe, it, expect } from "vitest";
import { pricePackage, packageLines, partQty, missingMessage, type PackageRow } from "./price";
import type { Item } from "@/lib/supabase/database.types";

const item = (over: Partial<Item> & { id: string; name: string }): Item => ({
  tenant_id: "t", vendor: "google", hsn: "998313", msrp: 0, wholesale: 0, margin_pct: 0,
  is_active: true, created_at: "", kind: "main", prices: {}, is_partner_visible: false,
  partner_price: null, synced_from_partner_id: null, item_type: "subscription", covered_product: null,
  ...over,
} as Item);

const CAT = [
  // R-387: a stale ₹136 Starter row is quoted at the ₹270 list price, the same as every other
  // adder (catalogYearlyPrice floors it) — so ₹3,240 a seat a year below, not ₹1,632.
  item({ id: "GW-STR", name: "Google Workspace Business Starter", msrp: 136, wholesale: 110 }),
  item({ id: "SUP-GW-STR-YR", name: "Starter Support (Yearly)", vendor: "support", kind: "addon", prices: { annual_total: { msrp: 9996, wholesale: 0 } } as never }),
  item({ id: "OLD", name: "Retired backup", msrp: 50, wholesale: 30, is_active: false }),
];

const PKG = (over: Partial<PackageRow> = {}): PackageRow => ({
  id: "p1", name: "Starter + Support", pitch: null, discount_pct: 0, is_active: true, sort_order: 0,
  items: [
    { item_id: "GW-STR", qty_mode: "per_seat", fixed_qty: null, optional: false, sort_order: 0 },
    { item_id: "SUP-GW-STR-YR", qty_mode: "fixed", fixed_qty: 1, optional: false, sort_order: 1 },
  ],
  ...over,
});

describe("packages — priced from the catalogue at quote time", () => {
  it("per-seat parts follow the seats, fixed parts do not", () => {
    const p = pricePackage(PKG(), CAT, 10);
    expect(p.parts.map((x) => [x.item.id, x.qty, x.rate])).toEqual([["GW-STR", 10, 3240], ["SUP-GW-STR-YR", 1, 9996]]);
    expect(p.total).toBe(32400 + 9996);
    expect(p.saving).toBe(0);
    expect(p.complete).toBe(true);
  });

  it("the discount comes off each rate in whole rupees, and is shown as a saving", () => {
    const p = pricePackage(PKG({ discount_pct: 10 }), CAT, 10);
    expect(p.parts.map((x) => x.rate)).toEqual([2916, 8996]);
    expect(p.listTotal).toBe(42396);
    expect(p.total).toBe(2916 * 10 + 8996);
    expect(p.saving).toBe(42396 - (29160 + 8996));
  });

  it("a discount above the 30% cap is held at 30", () => {
    expect(pricePackage(PKG({ discount_pct: 90 }), CAT, 1).parts[0].rate).toBe(Math.round(3240 * 0.7));
  });

  it("a part that left the catalogue is MISSING, not silently dropped", () => {
    const p = pricePackage(PKG({ items: [...PKG().items, { item_id: "OLD", qty_mode: "per_seat", fixed_qty: null, optional: false, sort_order: 2 }] }), CAT, 5);
    expect(p.complete).toBe(false);
    expect(p.missing.map((m) => m.item_id)).toEqual(["OLD"]);
    expect(missingMessage(p, (id) => CAT.find((c) => c.id === id)?.name)).toMatch(/Retired backup is no longer active/);
  });

  it("an optional miss does not make the package incomplete; optional parts can be left out", () => {
    const withOpt = PKG({ items: [...PKG().items, { item_id: "OLD", qty_mode: "fixed", fixed_qty: 1, optional: true, sort_order: 2 }] });
    expect(pricePackage(withOpt, CAT, 5).complete).toBe(true);
    const noSupport = PKG({ items: [PKG().items[0], { ...PKG().items[1], optional: true }] });
    expect(pricePackage(noSupport, CAT, 5, { includeOptional: false }).parts).toHaveLength(1);
  });

  it("the quote lines keep the catalogue rate as list_rate, so the discount shows", () => {
    const lines = packageLines(pricePackage(PKG({ discount_pct: 10 }), CAT, 10), { startDate: "2026-10-02" });
    expect(lines[0]).toMatchObject({ item_id: "GW-STR", qty: 10, rate: 2916, list_rate: 3240, cost: 1320, start_date: "2026-10-02" });
  });

  it("seat count never goes below one", () => {
    expect(partQty({ item_id: "x", qty_mode: "per_seat", fixed_qty: null, optional: false, sort_order: 0 }, 0)).toBe(1);
  });
});
