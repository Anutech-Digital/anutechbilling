import { describe, it, expect } from "vitest";
import {
  canEditSupportCatalog, isValidSupportPrice, knownSupportPrice, supportCatalogId,
  supportCatalogName, supportCatalogRow, supportLineRate, supportRowPrice,
} from "./catalog-row";
import { findSupportSku, supportTier } from "./tiers";

const TENANT = "fbb976f1-1111-2222-3333-444455556666";
const std = supportTier("standard");
const ent = supportTier("enterprise");

describe("R-364: the row Add to catalog creates", () => {
  it("is found by the same lookup the quote builder uses, for this tenant only", () => {
    const row = supportCatalogRow({ tier: std, cycle: "yearly", tenantId: TENANT, name: "Acme Standard Support (Yearly)", price: 9_996 });
    expect(row.id).toBe("SUP-STANDARD-YR-fbb976f1111122223333444455556666");
    expect(findSupportSku([{ id: row.id as string }], "standard", "yearly")).not.toBeNull();
    /* Never the monthly row, never the other tier. */
    expect(findSupportSku([{ id: row.id as string }], "standard", "monthly")).toBeNull();
    expect(findSupportSku([{ id: row.id as string }], "enterprise", "yearly")).toBeNull();
  });

  it("carries no tenant_id of its own — useCreateItem stamps the caller's, RLS refuses any other", () => {
    const row = supportCatalogRow({ tier: ent, cycle: "monthly", tenantId: TENANT, name: "X", price: 4_999 });
    expect("tenant_id" in row).toBe(false);
    /* Two tenants never collide on the primary key. */
    expect(supportCatalogId(ent, "monthly", TENANT)).not.toBe(supportCatalogId(ent, "monthly", "aaaaaaaa-0000-0000-0000-000000000000"));
  });

  it("writes the shape the seed migration writes", () => {
    const yr = supportCatalogRow({ tier: std, cycle: "yearly", tenantId: TENANT, name: " A ", price: 9_996 });
    expect(yr).toMatchObject({
      name: "A", vendor: "support", hsn: "998313", msrp: 0, wholesale: 0, is_active: true,
      item_type: "subscription", kind: "main", covered_product: "all",
      prices: { annual_total: { msrp: 9_996, wholesale: 0 } },
    });
    const mo = supportCatalogRow({ tier: std, cycle: "monthly", tenantId: TENANT, name: "A", price: 999 });
    expect(mo).toMatchObject({ msrp: 999, prices: {} });
  });

  it("refuses to build a row without a real whole-rupee price", () => {
    for (const price of [0, -1, 99.5, Number.NaN]) {
      expect(() => supportCatalogRow({ tier: std, cycle: "monthly", tenantId: TENANT, name: "A", price })).toThrow();
    }
    expect(() => supportCatalogRow({ tier: std, cycle: "monthly", tenantId: TENANT, name: "  ", price: 999 })).toThrow();
    expect(() => supportCatalogRow({ tier: supportTier("free"), cycle: "monthly", tenantId: TENANT, name: "A", price: 1 })).toThrow();
  });
});

describe("the price field", () => {
  it("accepts only whole rupees above zero", () => {
    expect(isValidSupportPrice("9996")).toBe(true);
    expect(isValidSupportPrice(" 999 ")).toBe(true);
    for (const bad of ["", "  ", "0", "-5", "99.5", "1e3", "₹999", "abc"]) {
      expect(isValidSupportPrice(bad)).toBe(false);
    }
  });

  it("prefills only from the plan definition, never an invented number", () => {
    expect(knownSupportPrice(std, "yearly")).toBe(9_996);
    expect(knownSupportPrice(std, "monthly")).toBe(999);
    expect(knownSupportPrice(supportTier("free"), "yearly")).toBeNull();
  });
});

describe("naming", () => {
  it("brands with the reseller's name like the seed, and falls back when there is none", () => {
    expect(supportCatalogName(std, "monthly", "Excel Technologies")).toBe("Excel Technologies Standard Support");
    expect(supportCatalogName(std, "yearly", "Excel Technologies")).toBe("Excel Technologies Standard Support (Yearly)");
    expect(supportCatalogName(ent, "monthly", null)).toBe("Support Enterprise (Monthly)");
  });
});

describe("the quote line uses the catalogue's own price", () => {
  it("reads the row's price, so a price typed in the dialog is the price quoted", () => {
    expect(supportLineRate({ msrp: 0, prices: { annual_total: { msrp: 12_000, wholesale: 0 } } } as never, std, "yearly")).toBe(12_000);
    expect(supportLineRate({ msrp: 1_199, prices: {} } as never, std, "monthly")).toBe(1_199);
  });

  it("falls back to the plan definition when the row holds no price (old behaviour)", () => {
    expect(supportLineRate({ msrp: 0, prices: {} } as never, std, "yearly")).toBe(9_996);
    expect(supportLineRate(null, std, "monthly")).toBe(999);
    expect(supportRowPrice({ msrp: 0, prices: {} } as never, "monthly")).toBeNull();
  });
});

describe("who may add to the catalogue", () => {
  it("is the roles that can open Products", () => {
    expect(canEditSupportCatalog("owner")).toBe(true);
    expect(canEditSupportCatalog("manager")).toBe(true);
    for (const r of ["sales", "sales_senior", "billing", "accountant", "support", "delivery"]) {
      expect(canEditSupportCatalog(r)).toBe(false);
    }
  });

  it("is no while the role is still loading", () => {
    expect(canEditSupportCatalog(null)).toBe(false);
    expect(canEditSupportCatalog(undefined)).toBe(false);
  });
});
