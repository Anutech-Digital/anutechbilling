/**
 * R-2736 — renewal line cost always from the catalogue (see renewal-catalog-cost.ts).
 */
import { describe, it, expect } from "vitest";
import {
  pickRenewalCatalogItem, renewalCatalogCost, pickDomainCatalogItem, domainRenewalCatalogCost,
  type RenewalCatalogRow,
} from "./renewal-catalog-cost";

const row = (o: Partial<RenewalCatalogRow> & { id: string; name: string }): RenewalCatalogRow =>
  ({ vendor: "google", msrp: 0, wholesale: 0, prices: {}, is_active: true, ...o });

/* E2E Test Co's real catalogue rows (local DB, 14 Nov 2026). */
const GW_STD = row({ id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", msrp: 736, wholesale: 620 });
const GW_STR = row({ id: "E2E-GW-STR", name: "E2E Google Workspace Business Starter", msrp: 136, wholesale: 110 });
const M365_STD = row({ id: "E2E-M365-STD", name: "E2E Microsoft 365 Business Standard", vendor: "microsoft", msrp: 880, wholesale: 750 });
const CATALOG = [GW_STR, GW_STD, M365_STD];

describe("pickRenewalCatalogItem", () => {
  it("r2736 confident match: Q-F588-27-0156's plan (no item_id, name not exact) finds E2E GW Standard", () => {
    expect(pickRenewalCatalogItem(CATALOG, { itemId: null, plan: "Google Workspace Business Standard" }))
      .toEqual({ row: GW_STD, how: "match" });
  });

  it("item_id wins, even for an inactive row", () => {
    const old = { ...GW_STR, is_active: false };
    expect(pickRenewalCatalogItem([old, GW_STD], { itemId: "E2E-GW-STR", plan: "Google Workspace Business Standard" }))
      .toEqual({ row: old, how: "item_id" });
  });

  it("exact name (case / spaces / '(N seats)' suffix ignored)", () => {
    const exact = row({ id: "X", name: "Google Workspace Business Standard", wholesale: 620 });
    expect(pickRenewalCatalogItem([GW_STD, exact], { plan: "google  workspace business standard (20 seats)" }))
      .toEqual({ row: exact, how: "name" });
  });

  it("r2736 ambiguous no guess: another tier only → nothing", () => {
    expect(pickRenewalCatalogItem([GW_STR], { plan: "Google Workspace Business Standard" })).toBeNull();
  });

  it("r2736 ambiguous no guess: two rows containing the plan name → nothing", () => {
    const flex = row({ id: "F", name: "Google Workspace Business Standard (Yearly)", wholesale: 700 });
    const ann = row({ id: "A", name: "Google Workspace Business Standard Annual", wholesale: 620 });
    expect(pickRenewalCatalogItem([flex, ann], { plan: "Google Workspace Business Standard" })).toBeNull();
  });

  it("two rows with the same exact name → nothing", () => {
    const a = row({ id: "A", name: "Google Workspace Business Standard", wholesale: 620 });
    const b = row({ id: "B", name: "Google Workspace Business Standard", wholesale: 700 });
    expect(pickRenewalCatalogItem([a, b], { plan: "Google Workspace Business Standard" })).toBeNull();
  });

  it("a support plan row is never a licence's cost", () => {
    const sup = row({ id: "S", name: "Google Workspace Business Standard Support", vendor: "support", msrp: 999 });
    expect(pickRenewalCatalogItem([sup, GW_STD], { plan: "Google Workspace Business Standard" })?.row).toBe(GW_STD);
    expect(pickRenewalCatalogItem([sup], { plan: "Google Workspace Business Standard" })).toBeNull();
  });

  it("vendor known → only that vendor rows are matched", () => {
    expect(pickRenewalCatalogItem(CATALOG, { plan: "Google Workspace Business Standard", vendor: "microsoft" })).toBeNull();
    expect(pickRenewalCatalogItem(CATALOG, { plan: "Google Workspace Business Standard", vendor: "google" })?.row).toBe(GW_STD);
    expect(pickRenewalCatalogItem(CATALOG, { plan: "Google Workspace Business Standard", vendor: "other" })?.row).toBe(GW_STD);
  });

  it("an inactive row is not picked by name", () => {
    expect(pickRenewalCatalogItem([{ ...GW_STD, is_active: false }], { plan: "Google Workspace Business Standard" })).toBeNull();
  });

  it("no plan → nothing", () => {
    expect(pickRenewalCatalogItem(CATALOG, { plan: "" })).toBeNull();
  });
});

describe("renewalCatalogCost", () => {
  it("annual: wholesale ₹620/seat/month → ₹7,440 a seat a year (the editor's 'Use cost ₹7,440')", () => {
    expect(renewalCatalogCost(GW_STD, { termMonths: 12, seats: 20 })).toEqual({ perSeat: 7440, total: 148800, known: true, reason: null });
  });

  it("r2736 tier cost: annual term uses the annual tier, monthly the monthly tier", () => {
    const tiered = row({ id: "T", name: "T", msrp: 300, wholesale: 264, prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } } });
    expect(renewalCatalogCost(tiered, { termMonths: 12, seats: 1 }).perSeat).toBe(264 * 12);
    expect(renewalCatalogCost(tiered, { termMonths: 1, seats: 1 }).perSeat).toBe(318);
  });

  it("volume slab for these seats (as the editor fill reads it) on an annual term", () => {
    const slabbed = row({ id: "S", name: "S", msrp: 700, wholesale: 620, prices: { slabs: [{ minSeats: 1, maxSeats: 9, msrp: 700, wholesale: 620 }, { minSeats: 10, maxSeats: null, msrp: 650, wholesale: 560 }] } });
    expect(renewalCatalogCost(slabbed, { termMonths: 12, seats: 20 }).perSeat).toBe(560 * 12);
    expect(renewalCatalogCost(slabbed, { termMonths: 12, seats: 5 }).perSeat).toBe(620 * 12);
  });

  it("a 6-month annual-commitment term = annual tier per month × 6 (not the Flexible tier)", () => {
    const tiered = row({ id: "T", name: "T", msrp: 300, wholesale: 264, prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } } });
    expect(renewalCatalogCost(tiered, { termMonths: 6, seats: 1 }).perSeat).toBe(264 * 6);
  });

  it("a yearly-total support row: its year, × years", () => {
    const sup = row({ id: "SUP", name: "Std Support (Yearly)", vendor: "support", msrp: 0, wholesale: 0, prices: { annual_total: { msrp: 9996, wholesale: 6000 } } });
    expect(renewalCatalogCost(sup, { termMonths: 12, seats: 1 }).perSeat).toBe(6000);
  });

  it("r2736 multi-year: 24 / 36 months = yearly cost × years", () => {
    expect(renewalCatalogCost(GW_STD, { termMonths: 24, seats: 1 }).perSeat).toBe(14880);
    expect(renewalCatalogCost(GW_STD, { termMonths: 36, seats: 2 }).total).toBe(22320 * 2);
  });

  it("r2736 seats: the line total is per seat × the quote's seats (a scheduled cut's seats)", () => {
    expect(renewalCatalogCost(GW_STD, { termMonths: 12, seats: 15 }).total).toBe(7440 * 15);
  });

  it("no row / wholesale 0 / annual tier wholesale 0 → unknown, 0", () => {
    expect(renewalCatalogCost(null, { termMonths: 12, seats: 1 })).toMatchObject({ known: false, perSeat: 0, total: 0 });
    expect(renewalCatalogCost(row({ id: "Z", name: "Z", msrp: 100 }), { termMonths: 12, seats: 1 }).known).toBe(false);
    const demo = row({ id: "D", name: "D", msrp: 83, wholesale: 0, prices: { annual: { msrp: 83.3, wholesale: 0 }, billing_unit: "seat_month" } });
    expect(renewalCatalogCost(demo, { termMonths: 12, seats: 1 }).known).toBe(false);
  });

  it("r2736 usd-only unknown: a USD wholesale with no ₹ wholesale is not converted here", () => {
    const usd = row({ id: "U", name: "U", vendor: "other", msrp: 1000, wholesale: 0, prices: { usd: { msrp: 4, wholesale: 2.5 } } });
    expect(renewalCatalogCost(usd, { termMonths: 12, seats: 1 }).known).toBe(false);
  });

  it("no term or no seats → unknown", () => {
    expect(renewalCatalogCost(GW_STD, { termMonths: 0, seats: 1 }).known).toBe(false);
    expect(renewalCatalogCost(GW_STD, { termMonths: 12, seats: 0 }).known).toBe(false);
  });
});

describe("domain renewal cost", () => {
  const IN = row({ id: "SCN-R2712-DOMAIN-IN", name: "SCN R2712 Domain .in", vendor: "domain", msrp: 800, wholesale: 600, prices: { billing_unit: "unit_year" } });
  const COIN = row({ id: "CO", name: "Domain .co.in", vendor: "domain", msrp: 700, wholesale: 500, prices: { billing_unit: "unit_year" } });

  it("domain renewal cost: the one Domain row for the extension, per year", () => {
    const pick = pickDomainCatalogItem([IN, COIN, GW_STD], { tld: "in" });
    expect(pick).toEqual({ row: IN, how: "name" });
    expect(domainRenewalCatalogCost(pick!.row)).toEqual({ perSeat: 600, total: 600, known: true, reason: null });
    expect(pickDomainCatalogItem([IN, COIN], { tld: "co.in" })?.row).toBe(COIN);
  });

  it("item_id first; × years", () => {
    expect(pickDomainCatalogItem([IN, COIN], { itemId: "CO", tld: "in" })?.row).toBe(COIN);
    expect(domainRenewalCatalogCost(IN, 3).perSeat).toBe(1800);
  });

  it("domain renewal unknown: none / two rows / not priced per year / wholesale 0", () => {
    expect(pickDomainCatalogItem([GW_STD], { tld: "in" })).toBeNull();
    expect(pickDomainCatalogItem([IN, { ...IN, id: "IN2" }], { tld: "in" })).toBeNull();
    expect(domainRenewalCatalogCost(null).known).toBe(false);
    expect(domainRenewalCatalogCost({ ...IN, prices: {} }).known).toBe(false);   // no billing unit = per seat-month
    expect(domainRenewalCatalogCost({ ...IN, wholesale: 0 }).known).toBe(false);
  });
});

/* R-2736 independent review rev-r2736 F1: a confident match must be the SAME tier, with no extra qualifier. */
describe("R-2736 F1 — a match never picks another tier or an archived / flexible / voice / support row", () => {
  const ent = (id: string, name: string) => row({ id, name, msrp: 1500, wholesale: 1200 });
  it("'Business Standard' never → 'Enterprise Standard'", () => {
    expect(pickRenewalCatalogItem([ent("ES", "Google Workspace Enterprise Standard")], { plan: "Google Workspace Business Standard" })).toBeNull();
  });
  it("'Business Plus' never → 'Enterprise Plus'", () => {
    expect(pickRenewalCatalogItem([ent("EP", "Google Workspace Enterprise Plus")], { plan: "Google Workspace Business Plus" })).toBeNull();
  });
  it("'Business Starter' never → '… Starter Archived User'", () => {
    expect(pickRenewalCatalogItem([ent("AU", "Google Workspace Business Starter Archived User")], { plan: "Google Workspace Business Starter" })).toBeNull();
  });
  it("plan 'Google Workspace' (no tier) + one Starter row → nothing", () => {
    expect(pickRenewalCatalogItem([GW_STR], { plan: "Google Workspace" })).toBeNull();
  });
  it("inactive exact row + active Enterprise Standard → nothing", () => {
    const exactOff = row({ id: "X", name: "Google Workspace Business Standard", wholesale: 620, is_active: false });
    expect(pickRenewalCatalogItem([exactOff, ent("ES", "Google Workspace Enterprise Standard")], { plan: "Google Workspace Business Standard" })).toBeNull();
  });
  it("flexible / voice rows are not the annual licence", () => {
    expect(pickRenewalCatalogItem([ent("F", "Google Workspace Business Standard Flexible")], { plan: "Google Workspace Business Standard" })).toBeNull();
    expect(pickRenewalCatalogItem([ent("V", "Google Voice Standard")], { plan: "Google Workspace Business Standard" })).toBeNull();
  });
  it("…but a plan that says Flexible may match its Flexible row", () => {
    const f = ent("F", "E2E Google Workspace Business Standard Flexible");
    expect(pickRenewalCatalogItem([f, GW_STD], { plan: "Google Workspace Business Standard Flexible" })?.row).toBe(f);
  });
  it("the E2E-prefix case (Q-F588-27-0156) still matches, next to the other-tier rows", () => {
    expect(pickRenewalCatalogItem([GW_STR, GW_STD, ent("ES", "Google Workspace Enterprise Standard")], { plan: "Google Workspace Business Standard" })?.row).toBe(GW_STD);
  });
});

/* rev-r2736 F4: a domain renewal is costed from the Renewal row, else Registration — never Transfer. */
describe("R-2736 F4 — domain row: Renewal, then Registration, never Transfer", () => {
  const d = (id: string, name: string, wholesale: number) => row({ id, name, vendor: "domain", msrp: wholesale + 200, wholesale, prices: { billing_unit: "unit_year" } });
  const REN = d("REN", "Domain Renewal .in", 650);
  const REG = d("REG", "Domain Registration .in", 600);
  const TRF = d("TRF", "Domain Transfer .in", 550);
  it("renewal row wins over registration and transfer", () => {
    expect(pickDomainCatalogItem([TRF, REG, REN], { tld: "in" })?.row).toBe(REN);
  });
  it("no renewal row → registration", () => {
    expect(pickDomainCatalogItem([TRF, REG], { tld: "in" })?.row).toBe(REG);
  });
  it("only a transfer row → nothing", () => {
    expect(pickDomainCatalogItem([TRF], { tld: "in" })).toBeNull();
  });
  it("two renewal rows → nothing", () => {
    expect(pickDomainCatalogItem([REN, { ...REN, id: "REN2" }], { tld: "in" })).toBeNull();
  });
});
