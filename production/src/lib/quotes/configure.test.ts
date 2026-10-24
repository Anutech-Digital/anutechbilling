import { describe, it, expect } from "vitest";
import { configureQuote, seatBounds, describeChanges } from "./configure";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

const SLABS = [
  { minSeats: 1,  maxSeats: 10,   msrp: 270, wholesale: 110 },
  { minSeats: 11, maxSeats: 50,   msrp: 250, wholesale: 105 },
  { minSeats: 51, maxSeats: null, msrp: 230, wholesale: 100 },
];

const gws: Item = {
  id: "item-gws", tenant_id: "t1", name: "Google Workspace Business Starter", vendor: "google",
  kind: "main", item_type: "subscription", covered_product: null, hsn: null, msrp: 270, wholesale: 110,
  prices: { annual: { msrp: 270, wholesale: 110 }, slabs: SLABS },
  margin_pct: 0, is_active: true, is_partner_visible: false, partner_price: null,
  synced_from_partner_id: null, created_at: "2026-01-01T00:00:00Z",
  /* R-1785 catalogue columns (unused by this test). */
  sku: null, term_months: null, gst_rate: 18, fulfilment: null, engine_ref: null, price_source: "catalog", is_public: false,
};

const CATALOG = [gws];

const seatLine = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l1", item_id: "item-gws", name: "Google Workspace Business Starter",
  qty: 10, rate: 3240, list_rate: 3240, cost: 1320, seats_adjustable: true, ...over,
});

const addon = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l2", name: "Acronis Backup", qty: 10, rate: 1800, list_rate: 1800, cost: 900,
  optional: true, included_by_default: false, ...over,
});

describe("only what the reseller allowed can move", () => {
  it("ignores a seat change on a line that is not adjustable", () => {
    /* An "interactive" quote where the buyer can edit any line is not a quote, it is
       an order form the seller has not seen. */
    const c = configureQuote([seatLine({ seats_adjustable: false })], [{ lineId: "l1", seats: 99 }], CATALOG);
    expect(c.lines[0].qty).toBe(10);
    expect(c.changed).toBe(false);
  });

  it("ignores an exclude on a line that is not optional", () => {
    const c = configureQuote([seatLine()], [{ lineId: "l1", included: false }], CATALOG);
    expect(c.lines[0].included).toBe(true);
  });

  it("clamps a seat count to the line's bounds", () => {
    const line = seatLine({ min_seats: 5, max_seats: 40 });
    expect(configureQuote([line], [{ lineId: "l1", seats: 500 }], CATALOG).lines[0].qty).toBe(40);
    expect(configureQuote([line], [{ lineId: "l1", seats: 1 }],   CATALOG).lines[0].qty).toBe(5);
  });

  it("ignores nonsense seat values instead of pricing them", () => {
    for (const bad of [NaN, Infinity, -10]) {
      const c = configureQuote([seatLine()], [{ lineId: "l1", seats: bad }], CATALOG);
      expect(c.lines[0].qty).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(c.subtotal)).toBe(true);
    }
  });
});

describe("seatBounds", () => {
  it("is null for a fixed line", () => {
    expect(seatBounds(seatLine({ seats_adjustable: false }))).toBeNull();
  });

  it("defaults to grow freely, shrink to half", () => {
    expect(seatBounds(seatLine({ qty: 20 }))).toEqual({ min: 10, max: 70 });
  });

  it("never allows zero seats", () => {
    expect(seatBounds(seatLine({ qty: 1 }))!.min).toBe(1);
  });
});

describe("the price is decided here, not by the browser", () => {
  it("re-prices across a volume band when seats grow", () => {
    // 10 → 60 seats moves into the 51+ band: ₹230 × 12 = ₹2,760/seat/yr.
    const c = configureQuote([seatLine()], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.lines[0].rate).toBe(2760);
    expect(c.lines[0].rePriced).toBe(true);
    expect(c.lines[0].bandLabel).toBe("51+ seats");
    expect(c.subtotal).toBe(60 * 2760);
  });

  it("keeps a NEGOTIATED rate at the new seat count", () => {
    /* The reseller agreed a per-seat number, not a position in the price list. */
    const c = configureQuote([seatLine({ rate: 2400 })], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.lines[0].rate).toBe(2400);
    expect(c.lines[0].rePriced).toBe(false);
    expect(c.subtotal).toBe(60 * 2400);
  });

  it("scales a CUSTOM line linearly — it has no price list to look up", () => {
    const custom = seatLine({ item_id: undefined, rate: 5000, cost: 3000 });
    const c = configureQuote([custom], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.lines[0].rate).toBe(5000);
    expect(c.subtotal).toBe(300_000);
  });

  it("updates COST across a band even when the rate was negotiated", () => {
    // The vendor's price still changes with volume, whatever we charge.
    const c = configureQuote([seatLine({ rate: 3240 })], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.lines[0].cost).toBe(1200);   // ₹100 × 12
  });
});

describe("optional lines", () => {
  it("adds a ticked add-on to the total", () => {
    const c = configureQuote([seatLine(), addon()], [{ lineId: "l2", included: true }], CATALOG);
    expect(c.lines[1].included).toBe(true);
    expect(c.subtotal).toBe(10 * 3240 + 10 * 1800);
  });

  it("leaves an unticked add-on out of the total AND out of the margin", () => {
    const c = configureQuote([seatLine(), addon()], [], CATALOG);
    expect(c.subtotal).toBe(32_400);
    expect(c.economics.totalCost).toBe(13_200);
  });

  it("counts a default-included add-on in the ORIGINAL total", () => {
    const c = configureQuote([seatLine(), addon({ included_by_default: true })], [], CATALOG);
    expect(c.originalSubtotal).toBe(10 * 3240 + 10 * 1800);
    expect(c.changed).toBe(false);
  });
});

describe("a reconfigured quote goes through the SAME approval matrix", () => {
  it("lets an unchanged quote be accepted, whatever its margin", () => {
    /* The reseller already sent it, so whatever approval it needed happened before
       Send. Only a CHANGED shape has to clear the matrix again. */
    const thin = seatLine({ rate: 1400, cost: 1320, seats_adjustable: false });
    const c = configureQuote([thin], [], CATALOG);
    expect(c.changed).toBe(false);
    expect(c.selfAcceptable).toBe(true);
  });

  it("BLOCKS self-acceptance when the customer's change drops margin below the floor", () => {
    /* The whole reason this is a money feature. A customer must not be able to
       self-accept into a deal the reseller's own rules would have stopped. */
    const negotiated = seatLine({ rate: 1300, list_rate: 3240, cost: 1320 });
    const c = configureQuote([negotiated], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.changed).toBe(true);
    expect(c.approval.tier).toBe("owner");
    expect(c.selfAcceptable).toBe(false);
  });

  it("allows a change that stays healthy", () => {
    const c = configureQuote([seatLine()], [{ lineId: "l1", seats: 20 }], CATALOG);
    expect(c.changed).toBe(true);
    expect(c.approval.tier).toBe("none");
    expect(c.selfAcceptable).toBe(true);
  });

  it("blocks self-acceptance when the change makes cost unknown", () => {
    const c = configureQuote(
      [seatLine({ item_id: undefined, cost: 0 }), addon()],
      [{ lineId: "l2", included: true }],
      CATALOG,
    );
    expect(c.economics.costUnknown).toBe(true);
    expect(c.selfAcceptable).toBe(false);
  });
});

describe("describeChanges — what the reseller is told", () => {
  it("names an added add-on", () => {
    const c = configureQuote([seatLine(), addon()], [{ lineId: "l2", included: true }], CATALOG);
    expect(describeChanges(c)).toEqual(['Added "Acronis Backup".']);
  });

  it("names a removed default line", () => {
    const c = configureQuote([seatLine(), addon({ included_by_default: true })], [{ lineId: "l2", included: false }], CATALOG);
    expect(describeChanges(c)).toEqual(['Removed "Acronis Backup".']);
  });

  it("names a seat change AND the re-price it caused", () => {
    const msgs = describeChanges(configureQuote([seatLine()], [{ lineId: "l1", seats: 60 }], CATALOG));
    expect(msgs[0]).toContain("10 → 60 seats");
    expect(msgs[0]).toContain("₹2760/seat/yr");
    expect(msgs[0]).toContain("51+ seats");
  });

  it("says nothing when nothing changed", () => {
    expect(describeChanges(configureQuote([seatLine()], [], CATALOG))).toEqual([]);
  });
});

describe("empty and degenerate input", () => {
  it("handles a quote with no lines", () => {
    const c = configureQuote([], [], CATALOG);
    expect(c).toMatchObject({ subtotal: 0, changed: false, selfAcceptable: true });
  });

  it("ignores a choice for a line that does not exist", () => {
    const c = configureQuote([seatLine()], [{ lineId: "nope", seats: 99 }], CATALOG);
    expect(c.lines[0].qty).toBe(10);
  });

  it("works with an empty catalogue — the line keeps its stored price", () => {
    const c = configureQuote([seatLine()], [{ lineId: "l1", seats: 60 }], []);
    expect(c.lines[0].rate).toBe(3240);
    expect(c.subtotal).toBe(60 * 3240);
  });
});
