import { describe, it, expect } from "vitest";
import { buildPlanCostIndex, dealMargin, marginBadge, MARGIN_FLOOR_PCT } from "./deal-margin";
import type { Item, Lead } from "@/lib/supabase/database.types";

/** This tenant's real catalog rows, read from the DB on 16 Aug 2026. ₹/seat/month. */
const item = (name: string, vendor: string, cost: number, type = "subscription"): Item =>
  ({ id: name, name, vendor, wholesale: cost, item_type: type,
     prices: { annual: { wholesale: cost } } } as unknown as Item);

const CATALOG: Item[] = [
  item("Google Workspace Business Starter", "google", 110),
  item("Google Workspace Standard",         "google", 620),
  item("Google Workspace Plus",             "google", 1150),
  item("Google Workspace Enterprise",       "google", 2050),
  item("Microsoft 365 Business Basic",      "microsoft", 165),
  item("Microsoft 365 Business Standard",   "microsoft", 820),
  item("Microsoft 365 Business Premium",    "microsoft", 1620),
  item("Zoho Workplace Standard",           "zoho", 95),
  // Hosting/support rows carry a genuine ₹0 — treated as "no recorded cost", so they
  // never enter the index at all. Kept here because that is the real catalog.
  item("Standard", "hosting", 0),
  item("Plus",     "hosting", 0),
  // A REAL ambiguity: two products whose names normalise to the same key at DIFFERENT
  // costs. Without this the ambiguity branch is never exercised.
  item("Premium", "support",   500),
  item("Premium", "microsoft", 1_620),
];

const index = buildPlanCostIndex(CATALOG);
const lead = (over: Partial<Lead> = {}) =>
  ({ plan: "Google Workspace Business Starter", seats: 10, value: 32_400, ...over }) as Lead;

describe("units — value is ANNUAL, catalog cost is per seat per MONTH", () => {
  it("multiplies cost by 12 and by seats", () => {
    /* Getting this wrong is a 12x error in either direction. add-lead-form computes
       value as price × seats × 12, so cost must be built the same way. */
    const m = dealMargin(lead({ plan: "Google Workspace Business Starter", seats: 10, value: 32_400 }), index);
    expect(m.costAnnual).toBe(110 * 12 * 10);     // ₹13,200
    expect(m.grossAnnual).toBe(32_400 - 13_200);  // ₹19,200
    expect(m.marginPct).toBe(59.3);
  });

  it("scales with seats", () => {
    const one  = dealMargin(lead({ seats: 1,  value: 3_240 }), index);
    const ten  = dealMargin(lead({ seats: 10, value: 32_400 }), index);
    expect(ten.costAnnual).toBe(one.costAnnual! * 10);
    expect(ten.marginPct).toBe(one.marginPct);
  });
});

describe("the four plans the lead form auto-calculates BELOW cost", () => {
  /* add-lead-form's PLAN_PRICE_PER_SEAT_PM auto-fills the deal value from a hardcoded
     price list. Measured against the real catalog on 16 Aug 2026, four of its nine plans
     produce a value below what the vendor charges. These are the exact figures. */
  it.each([
    ["Google Workspace Enterprise",     2_000, 2_050],
    ["Microsoft 365 Business Basic",      145,   165],
    ["Microsoft 365 Business Standard",   735,   820],
    ["Microsoft 365 Business Premium",  1_470, 1_620],
  ] as const)("%s at ₹%s/seat/month loses money against a ₹%s cost", (plan, formPrice, cost) => {
    const seats = 10;
    const m = dealMargin(lead({ plan, seats, value: formPrice * seats * 12 }), index);
    expect(m.band).toBe("loss");
    expect(m.costAnnual).toBe(cost * 12 * seats);
    expect(m.grossAnnual).toBeLessThan(0);
  });

  it("Zoho Workplace Standard is not a loss but sits under the floor", () => {
    // ₹105 against ₹95 — 9.5%, profitable but below the 15% a reseller should accept.
    const m = dealMargin(lead({ plan: "Zoho Workplace Standard", seats: 10, value: 105 * 10 * 12 }), index);
    expect(m.band).toBe("thin");
    expect(m.marginPct).toBe(9.5);
  });
});

describe("bands", () => {
  it("loss below cost, thin under the floor, ok above it", () => {
    const seats = 10, cost = 110 * 12 * seats;   // ₹13,200
    expect(dealMargin(lead({ seats, value: cost - 1 }), index).band).toBe("loss");
    expect(dealMargin(lead({ seats, value: 15_000 }), index).band).toBe("thin");   // 12%
    expect(dealMargin(lead({ seats, value: 32_400 }), index).band).toBe("ok");     // 59.3%
  });

  it("exactly at the floor is OK; a hair under is thin", () => {
    // The floor is the minimum acceptable, so sitting exactly on it is acceptable.
    const seats = 10;
    const atFloor = Math.round((110 * 12 * seats) / (1 - MARGIN_FLOOR_PCT / 100));
    expect(dealMargin(lead({ seats, value: atFloor }), index).band).toBe("ok");
    expect(dealMargin(lead({ seats, value: atFloor - 200 }), index).band).toBe("thin");
  });

  it("exactly at cost is thin (0%), not a loss", () => {
    const m = dealMargin(lead({ seats: 10, value: 13_200 }), index);
    expect(m.band).toBe("thin");
    expect(m.marginPct).toBe(0);
    expect(m.grossAnnual).toBe(0);
  });

  it("takes a different floor when one is given", () => {
    const m = dealMargin(lead({ seats: 10, value: 32_400 }), index, 70);
    expect(m.band).toBe("thin");    // 59.3% is under a 70% floor
  });
});

describe("what it refuses to price", () => {
  it("REFUSES a name carried by two vendors at different costs", () => {
    /* "Premium" is ₹500 under support and ₹1,620 under microsoft. Picking one would put
       a coin-toss cost behind a margin somebody acts on. */
    const m = dealMargin(lead({ plan: "Premium" }), index);
    expect(m.band).toBe("unknown");
    expect(m.reason).toBe("ambiguous_plan");
  });

  it("treats a ₹0 hosting row as unpriced rather than as a match", () => {
    /* A first version of the test above used "Standard" — a hosting row at ₹0 — and
       expected ambiguity. It is not ambiguous: a zero cost never enters the index, so
       the honest answer is not_in_catalog. The fixture was wrong, not the rule. */
    const m = dealMargin(lead({ plan: "Standard" }), index);
    expect(m.reason).toBe("not_in_catalog");
  });

  it("returns unknown — never 0% — for a plan with no catalogue row", () => {
    const m = dealMargin(lead({ plan: "Tally Prime Gold License" }), index);
    expect(m.band).toBe("unknown");
    expect(m.reason).toBe("not_in_catalog");
    expect(m.marginPct).toBeNull();
  });

  it("names which input is missing, so the message can say what to fix", () => {
    expect(dealMargin(lead({ plan: null }), index).reason).toBe("no_plan");
    expect(dealMargin(lead({ seats: 0 }), index).reason).toBe("no_seats");
    expect(dealMargin(lead({ value: 0 }), index).reason).toBe("no_value");
    expect(dealMargin(lead({ plan: "   " }), index).reason).toBe("no_plan");
  });

  it("treats a resold product with no recorded cost as unknown, not as 100% margin", () => {
    // Putting the best number in the app on the row we know least about.
    const idx = buildPlanCostIndex([item("Mystery Suite", "google", 0)]);
    const m = dealMargin(lead({ plan: "Mystery Suite" }), idx);
    expect(m.band).toBe("unknown");
  });
});

describe("buildPlanCostIndex", () => {
  it("matches on normalised names, so 'Business Standard' finds 'Standard'", () => {
    // Same planKey rule as subscriptions: the filler word "business" is dropped.
    const m = dealMargin(lead({ plan: "Google Workspace Business Standard", seats: 10, value: 100_000 }), index);
    expect(m.costAnnual).toBe(620 * 12 * 10);
  });

  it("tolerates a duplicate that agrees on price", () => {
    const idx = buildPlanCostIndex([
      item("Google Workspace Standard", "google", 620),
      item("Google Workspace Business Standard", "google", 620),
    ]);
    expect(dealMargin(lead({ plan: "Google Workspace Standard", seats: 1, value: 10_000 }), idx).band).not.toBe("unknown");
  });

  it("ignores one-time items — a deal value is a subscription figure", () => {
    const idx = buildPlanCostIndex([item("SSL Certificate", "other", 500, "one_time")]);
    expect(idx.costs.size).toBe(0);
  });
});

describe("marginBadge", () => {
  it("says what a loss costs per year, in rupees", () => {
    const m = dealMargin(lead({ plan: "Microsoft 365 Business Premium", seats: 10, value: 1_470 * 10 * 12 }), index);
    const b = marginBadge(m);
    expect(b.kind).toBe("danger");
    expect(b.title).toMatch(/Below cost/);
    expect(b.title).toMatch(/18,000/);   // (1620-1470) x 12 x 10
  });

  it("renders an unknown margin as a dash and explains WHICH input is missing", () => {
    const b = marginBadge(dealMargin(lead({ plan: "Tally Prime Gold License" }), index));
    expect(b.label).toBe("—");
    expect(b.kind).toBe("muted");
    expect(b.title).toMatch(/no row in Products/i);
  });

  it("names the floor when a margin is thin", () => {
    const b = marginBadge(dealMargin(lead({ seats: 10, value: 15_000 }), index));
    expect(b.title).toContain(`${MARGIN_FLOOR_PCT}%`);
  });
});
