/**
 * R-2835 — Renewals drawer cost/margin: a seat cut scheduled for this renewal is priced at the cut seats
 * (the renewal quote's own renewalSeatCut), and a term outside 1–60 shows "unknown", not a 12-month number.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { drawerMoney, drawerSeatPlan, renewalCostForSub, termPriceable } from "./drawer-money";
import { renewalAmount } from "./queue";
import type { RenewalCatalogRow } from "@/lib/renewals/renewal-catalog-cost";
import type { ScheduledSeatCutRow } from "@/lib/renewals/scheduled-seat-cut";

const GW_STD: RenewalCatalogRow = { id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", vendor: "google", msrp: 736, wholesale: 620, prices: {}, is_active: true };
const SUB = { plan: "Google Workspace Business Standard", seats: 20, vendor: "google", item_id: null, term_months: 12, mrr: 17000, term_amount: null, renewal_date: "2026-12-01" };
const cut = (o: Partial<ScheduledSeatCutRow> = {}): ScheduledSeatCutRow =>
  ({ id: "c1", timing: "end_of_term", status: "scheduled", seats_before: 20, seats_after: 15, effective_date: "2026-12-01", ...o });

describe("R-2835 drawerSeatPlan = the renewal quote's rule", () => {
  it("a cut dated this renewal → price the cut seats, amount scaled, note says both", () => {
    expect(drawerSeatPlan(SUB, [cut()])).toEqual({ seats: 15, scale: 0.75, note: "on 20 seats, cut to 15 scheduled" });
  });
  it("no cut → current seats, no note", () => {
    expect(drawerSeatPlan(SUB, [])).toEqual({ seats: 20, scale: 1 });
  });
  it("a cut for another term's date is ignored", () => {
    expect(drawerSeatPlan(SUB, [cut({ effective_date: "2025-12-01" })])).toEqual({ seats: 20, scale: 1 });
  });
  it("seats changed since it was scheduled → the quote keeps current seats; the drawer says so", () => {
    const p = drawerSeatPlan(SUB, [cut({ seats_before: 25 })]);
    expect(p.seats).toBe(20);
    expect(p.scale).toBe(1);
    expect(p.note).toMatch(/does not match the 20 seats/);
  });
  it("the cuts could not be read → current seats and says so", () => {
    expect(drawerSeatPlan(SUB, null)).toMatchObject({ seats: 20, scale: 1, note: expect.stringMatching(/could not be read/) });
  });
});

describe("R-2835 cost + margin on the cut seats", () => {
  it("20 → 15 seats: cost ₹1,11,600, margin on the amount for 15 seats (₹1,53,000 − ₹1,11,600 = ₹41,400, 27%)", () => {
    const amt = renewalAmount(SUB, null);   // ₹2,04,000/yr for 20 seats
    const plan = drawerSeatPlan(SUB, [cut()]);
    const m = drawerMoney(amt, renewalCostForSub([GW_STD], { ...SUB, seats: plan.seats }), 12, plan);
    expect(m).toEqual({ kind: "known", cost: "₹1,11,600/yr", margin: "₹41,400/yr", pct: 27, loss: false, seatNote: "on 20 seats, cut to 15 scheduled" });
  });
  it("without a cut the numbers are R-2819's, unchanged", () => {
    const amt = renewalAmount(SUB, null);
    const plan = drawerSeatPlan(SUB, []);
    expect(drawerMoney(amt, renewalCostForSub([GW_STD], SUB), 12, plan)).toEqual({ kind: "known", cost: "₹1,48,800/yr", margin: "₹55,200/yr", pct: 27, loss: false });
  });
});

describe("R-2835 term outside 1–60", () => {
  it.each([0, 61, 120, -3])("term %s → termUnknown, whatever the catalogue says", (t) => {
    const amt = renewalAmount({ ...SUB, term_months: t }, null);
    expect(termPriceable(t)).toBe(false);
    expect(drawerMoney(amt, renewalCostForSub([GW_STD], { ...SUB, term_months: t }), t)).toEqual({ kind: "termUnknown" });
    expect(drawerMoney(amt, undefined, t)).toEqual({ kind: "termUnknown" });
  });
  it.each([1, 12, 24, 60, null, undefined])("term %s is priceable (empty = the 12-month default)", (t) => {
    expect(termPriceable(t)).toBe(true);
  });
});

describe("R-2835 wiring: the quote's own loader, no second copy", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it("the drawer's read calls loadScheduledSeatCuts and never queries subscription_seat_reductions itself", () => {
    const src = read("./drawer-seat-cut-data.ts");
    expect(src).toMatch(/loadScheduledSeatCuts\(createClient\(\), tenantId!, subscriptionId!\)/);
    expect(src).not.toMatch(/\.from\("subscription_seat_reductions"\)/);
    expect(read("./drawer-money.ts")).toMatch(/renewalSeatCut\(/);
  });
});
