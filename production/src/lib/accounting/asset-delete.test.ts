/**
 * R-1650 — the "Remove from the asset register?" confirm states what the books will do.
 *
 * Before: "removed from the register only; the expense / EMI it came from stays as it is" —
 * but report_pnl leaves out an expense only while an asset points at it (r1578), so removing the
 * asset put the whole expense back into its month's P&L and took the depreciation away.
 *
 * Rule (card R-1650): delete = undo a capitalisation entered by mistake — the expense is a cost
 * of its own month again AND the depreciation charged on the asset is reversed with it. Allowed
 * only while those months are open (DB trigger, supabase/tests/r1650_…). An asset that left the
 * business is "Sold / scrap", which keeps the depreciation already charged.
 */
import { describe, it, expect } from "vitest";
import { assetDeleteConfirm } from "./asset-delete";
import { accumulatedDepreciation, type AssetLike } from "./depreciation";

const laptop: AssetLike = { id: "a1", name: "Dell laptop", block: "computers", cost: 85_000, put_to_use: "2026-05-10" };

describe("R-1650: asset delete confirm", () => {
  it("says the expense comes back into its month's P&L, with the rupees and the month", () => {
    const c = assetDeleteConfirm({ ...laptop, expense_id: "e1", source_expense: { amount: 100_300, expense_date: "2026-05-08" } }, "2026-10-24");
    expect(c.expenseBack).toBe(100_300);
    expect(c.body).toMatch(/₹\s?1,00,300/);
    expect(c.body).toMatch(/May 2026/);
    expect(c.body).toMatch(/P&L/);
    /* The old, false promise is gone. */
    expect(c.body).not.toMatch(/stays as it is/);
  });

  it("says the depreciation charged so far is reversed, in rupees", () => {
    const c = assetDeleteConfirm({ ...laptop, expense_id: "e1", source_expense: { amount: 85_000, expense_date: "2026-05-08" } }, "2026-10-24");
    const charged = accumulatedDepreciation(laptop, "2026-10-24");
    expect(charged).toBeGreaterThan(0);
    expect(c.depreciationReversed).toBe(charged);
    expect(c.body).toMatch(/depreciation/i);
  });

  it("points to Sold / scrap for an asset that left the business", () => {
    const c = assetDeleteConfirm({ ...laptop, expense_id: null }, "2026-10-24");
    expect(c.body).toMatch(/Sold \/ scrap/);
  });

  it("an asset from an EMI purchase: the EMI stays, only the depreciation goes", () => {
    const c = assetDeleteConfirm({ ...laptop, expense_id: null, emi_purchase_id: "emi1" }, "2026-10-24");
    expect(c.expenseBack).toBeNull();
    expect(c.body).toMatch(/EMI/);
    expect(c.body).not.toMatch(/counts as a cost/);
  });

  it("a linked expense this login cannot read still says it comes back — never 'stays'", () => {
    const c = assetDeleteConfirm({ ...laptop, expense_id: "e1", source_expense: null }, "2026-10-24");
    expect(c.expenseBack).toBeNull();
    expect(c.body).toMatch(/counts as a cost/);
  });
});
