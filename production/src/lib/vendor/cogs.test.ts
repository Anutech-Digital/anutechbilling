import { describe, it, expect } from "vitest";
import { subscriptionCogs, cogsBadge, cogsTotals } from "./cogs";
import type { Item, Subscription } from "@/lib/supabase/database.types";

const item = (over: Partial<Item> = {}): Item => ({
  id: "item-gws", tenant_id: "t1", name: "Google Workspace Business Starter", vendor: "google",
  kind: "main", item_type: "subscription", covered_product: null, hsn: null, msrp: 270, wholesale: 110,
  prices: { annual: { msrp: 270, wholesale: 110 } },
  margin_pct: 0, is_active: true, is_partner_visible: false, partner_price: null,
  synced_from_partner_id: null, created_at: "2026-01-01T00:00:00Z",
  /* R-1785 catalogue columns (unused by this test). */
  sku: null, term_months: null, gst_rate: 18, fulfilment: null, engine_ref: null, price_source: "catalog", is_public: false,
  ...over,
});

const sub = (over: Partial<Subscription> = {}) => ({
  seats: 10, mrr: 2_700, item_id: "item-gws",
  vendor_cost_per_seat_month: null, vendor_synced_at: null,
  ...over,
}) as Subscription;

const CATALOG = [item()];

describe("it replaces the 17% constant with a real figure", () => {
  it("computes margin from the catalogue, not from a multiplier", () => {
    /* The old code was `cost = mrr × 0.83`, which returned 17% for every
       subscription in the app — a constant wearing a measurement's clothes. */
    const c = subscriptionCogs(sub(), CATALOG);
    expect(c.source).toBe("catalog");
    expect(c.perSeatMonth).toBe(110);
    expect(c.monthlyCost).toBe(1_100);
    expect(c.marginMonthly).toBe(1_600);
    expect(c.marginBps).toBe(5926);          // 59.26%, not 17%
  });

  it("gives DIFFERENT margins for different plans — the point of the change", () => {
    const cheap = subscriptionCogs(sub({ mrr: 1_200 }), CATALOG);
    const rich  = subscriptionCogs(sub({ mrr: 5_000 }), CATALOG);
    expect(cheap.marginBps).not.toBe(rich.marginBps);
  });
});

describe("three sources, in order of truth", () => {
  it("prefers what the VENDOR actually billed over the price list", () => {
    /* The gap between them is a promo that ended or a band we fell out of — exactly
       the case worth catching, and deriving cost from the price list would hide it. */
    const c = subscriptionCogs(sub({ vendor_cost_per_seat_month: 135, vendor_synced_at: "2026-08-01T00:00:00Z" }), CATALOG);
    expect(c.source).toBe("vendor");
    expect(c.perSeatMonth).toBe(135);
    expect(c.note).toContain("2026-08-01");
  });

  it("falls back to the catalogue and SAYS it is unconfirmed", () => {
    const c = subscriptionCogs(sub(), CATALOG);
    expect(c.note).toMatch(/Reconcile against a vendor bill to confirm/);
  });

  it("reports UNKNOWN rather than a number when there is no catalogue row", () => {
    const c = subscriptionCogs(sub({ item_id: null }), CATALOG);
    expect(c.source).toBe("unknown");
    expect(c.perSeatMonth).toBeNull();
    expect(c.marginBps).toBeNull();
    expect(c.note).toMatch(/not linked to a catalogue row/);
  });

  it("distinguishes 'no catalogue row' from 'catalogue row with no price'", () => {
    const c = subscriptionCogs(sub(), [item({ prices: {}, wholesale: 0 })]);
    expect(c.source).toBe("unknown");
    expect(c.note).toMatch(/has no wholesale price/);
  });

  it("treats a ₹0 wholesale as absent, not as a free product", () => {
    const c = subscriptionCogs(sub(), [item({ prices: { annual: { msrp: 270, wholesale: 0 } }, wholesale: 0 })]);
    expect(c.source).toBe("unknown");
  });

  it("accepts a genuine ₹0 VENDOR bill — that is a fact someone recorded", () => {
    const c = subscriptionCogs(sub({ vendor_cost_per_seat_month: 0 }), CATALOG);
    expect(c.source).toBe("vendor");
    expect(c.monthlyCost).toBe(0);
    expect(c.marginBps).toBe(10_000);
  });
});

describe("cost follows provisioned seats, not usage", () => {
  it("prices all billed seats even when nobody logged in", () => {
    /* We pay the vendor for what is provisioned, whether or not it is used. */
    const c = subscriptionCogs(sub({ seats: 10, used: 2 } as Partial<Subscription>), CATALOG);
    expect(c.monthlyCost).toBe(1_100);
  });

  it("handles zero seats without dividing by zero", () => {
    const c = subscriptionCogs(sub({ seats: 0, mrr: 0 }), CATALOG);
    expect(c.monthlyCost).toBe(0);
    expect(c.marginBps).toBeNull();
  });

  it("reports a NEGATIVE margin rather than clamping it", () => {
    const c = subscriptionCogs(sub({ mrr: 500 }), CATALOG);
    expect(c.marginMonthly).toBe(-600);
    expect(c.marginBps).toBeLessThan(0);
  });
});

describe("cogsBadge", () => {
  it("shows Unknown, not 100%, when cost is unknown", () => {
    const b = cogsBadge(subscriptionCogs(sub({ item_id: null }), CATALOG));
    expect(b).toMatchObject({ label: "Unknown", kind: "muted" });
  });

  it.each([
    [2_700, "success"],   // 59%
    [1_290, "warning"],   // 14.7%
    [1_250, "danger"],    // 12%
    [900,   "danger"],    // negative
  ])("mrr ₹%s → %s", (mrr, kind) => {
    expect(cogsBadge(subscriptionCogs(sub({ mrr }), CATALOG)).kind).toBe(kind);
  });

  it("carries the SOURCE in the tooltip — a catalogue guess and a vendor bill look identical otherwise", () => {
    const cat = cogsBadge(subscriptionCogs(sub(), CATALOG));
    const ven = cogsBadge(subscriptionCogs(sub({ vendor_cost_per_seat_month: 110 }), CATALOG));
    expect(cat.title).not.toBe(ven.title);
    expect(ven.title).toMatch(/vendor's own bill/);
  });
});

describe("cogsTotals — unknowns are excluded, not counted as free", () => {
  const rows = [
    subscriptionCogs(sub(), CATALOG),                                       // catalog
    subscriptionCogs(sub({ vendor_cost_per_seat_month: 100 }), CATALOG),    // vendor
    subscriptionCogs(sub({ item_id: null }), CATALOG),                      // unknown
  ];

  it("sums only what is known", () => {
    const t = cogsTotals(rows);
    expect(t.monthlyCost).toBe(1_100 + 1_000);
    expect(t.knownCount).toBe(2);
    expect(t.unknownCount).toBe(1);
  });

  it("counts how many of the known figures are only estimates", () => {
    /* A total built mostly from price-list guesses should not read like a
       measurement. */
    expect(cogsTotals(rows).estimatedCount).toBe(1);
  });

  it("is all zeroes on an empty list", () => {
    expect(cogsTotals([])).toEqual({
      monthlyCost: 0, marginMonthly: 0, knownCount: 0, unknownCount: 0, estimatedCount: 0,
    });
  });
});

/* R-2095 follow-up (30 Oct 2026): a Flexible (monthly) subscription with no vendor bill was costed
   at the ANNUAL wholesale — Google's Flexible tier costs more, so its margin read too high. The
   tier follows term_months, the same rule as catalogCostPerSeatMonth (Correct details). */
describe("R-2095 — catalogue tier follows the commitment", () => {
  const tiered = [item({ prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } } })];

  it("Flexible (term_months 1) uses the Flexible (monthly) wholesale", () => {
    const c = subscriptionCogs(sub({ term_months: 1, mrr: 3_250 }), tiered);
    expect(c.source).toBe("catalog");
    expect(c.perSeatMonth).toBe(132);
    expect(c.monthlyCost).toBe(1_320);
  });

  it("Annual (term_months 12, or not stored) keeps the annual wholesale", () => {
    expect(subscriptionCogs(sub({ term_months: 12 }), tiered).perSeatMonth).toBe(110);
    expect(subscriptionCogs(sub({ term_months: undefined }), tiered).perSeatMonth).toBe(110);
  });

  it("Flexible with no Flexible tier falls back to the annual one", () => {
    expect(subscriptionCogs(sub({ term_months: 1 }), CATALOG).perSeatMonth).toBe(110);
  });

  it("a stored vendor cost still wins over either tier", () => {
    expect(subscriptionCogs(sub({ term_months: 1, vendor_cost_per_seat_month: 120 }), tiered).perSeatMonth).toBe(120);
  });
});
