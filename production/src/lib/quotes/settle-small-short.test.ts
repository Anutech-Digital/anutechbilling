/**
 * R-2606 — the quote's "Settle ₹X as round-off" button: who sees it, what it says, and how a
 * refusal from settle_quote_part_short (R-2595) reaches the owner.
 */
import { describe, it, expect } from "vitest";
import {
  maySettleSmallShort, settleShortLabel, settleShortRefusal, SETTLE_SHORT_GENERIC,
} from "./settle-small-short";

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

describe("maySettleSmallShort (R-2606)", () => {
  it("owner and accountant only — as R-2595's RPC", () => {
    expect(maySettleSmallShort("owner")).toBe(true);
    expect(maySettleSmallShort("accountant")).toBe(true);
    for (const r of ["manager", "billing", "sales", "sales_senior", "support", "delivery", null, undefined]) {
      expect(maySettleSmallShort(r)).toBe(false);
    }
  });
});

describe("settleShortLabel", () => {
  it("names the amount as a round-off, never a bank charge (R-2577)", () => {
    expect(settleShortLabel(60, rupee)).toBe("Settle ₹60 as round-off");
    expect(settleShortLabel(60, rupee)).not.toMatch(/bank charge/i);
  });
});

describe("settleShortRefusal", () => {
  it("role refusal → 403 with the database's own sentence", () => {
    expect(settleShortRefusal({ code: "42501", message: "Only the owner or the accountant can settle a small difference." }))
      .toEqual({ status: 403, error: "Only the owner or the accountant can settle a small difference." });
  });
  it("a rule refusal (22023) → 400 with the plain sentence as is", () => {
    const m = "Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹60 difference.";
    expect(settleShortRefusal({ code: "22023", message: m })).toEqual({ status: 400, error: m });
  });
  it("'nothing was saved' (P0001) and no-company (28000) pass through", () => {
    expect(settleShortRefusal({ code: "P0001", message: "The small difference was not recorded — nothing was saved. Refresh the page and try again." }).status).toBe(400);
    expect(settleShortRefusal({ code: "28000", message: "No company on this login — sign in again." }))
      .toEqual({ status: 401, error: "No company on this login — sign in again." });
  });
  it("anything else → a generic sentence, never raw SQL", () => {
    expect(settleShortRefusal({ code: "42883", message: "function public.settle_quote_part_short(text, text) does not exist" }))
      .toEqual({ status: 500, error: SETTLE_SHORT_GENERIC });
    expect(settleShortRefusal({ message: "fetch failed" })).toEqual({ status: 500, error: SETTLE_SHORT_GENERIC });
  });
});
