import { describe, it, expect } from "vitest";
import {
  summarizeDealStrip, dealReport, isOpenDeal, wonDate, lostDate, type DealRow,
} from "./pipeline-summary";
import { canSeeDeals } from "./access";

/* 30 Sep 2026, 20:00 IST = 14:30 UTC. */
const NOW = new Date("2026-09-30T14:30:00Z");

let n = 0;
const deal = (p: Partial<DealRow>): DealRow => ({
  id: `d${++n}`, company: `Co ${n}`, stage: "quote", value: 0, expected_close_date: null,
  stage_changed_at: null, created_at: "2026-09-01T05:00:00Z", owner_id: null, lost_at: null, ...p,
});

describe("isOpenDeal / wonDate / lostDate", () => {
  it("only demo, trial and quote are open deals", () => {
    expect(["demo", "trial", "quote"].map((stage) => isOpenDeal({ stage: stage as DealRow["stage"] }))).toEqual([true, true, true]);
    expect(["new", "contact", "won", "lost"].map((stage) => isOpenDeal({ stage: stage as DealRow["stage"] }))).toEqual([false, false, false, false]);
  });
  it("won date is read in IST — 19:00 UTC on the 30th is 1 Oct in India", () => {
    expect(wonDate({ stage: "won", stage_changed_at: "2026-09-30T19:00:00Z" })).toBe("2026-10-01");
    expect(wonDate({ stage: "quote", stage_changed_at: "2026-09-30T05:00:00Z" })).toBeNull();
    expect(wonDate({ stage: "won", stage_changed_at: null })).toBeNull();
  });
  it("lost date prefers lost_at, falls back to stage_changed_at", () => {
    expect(lostDate({ stage: "lost", lost_at: "2026-09-10T05:00:00Z", stage_changed_at: "2026-09-12T05:00:00Z" })).toBe("2026-09-10");
    expect(lostDate({ stage: "lost", lost_at: null, stage_changed_at: "2026-09-12T05:00:00Z" })).toBe("2026-09-12");
  });
});

describe("summarizeDealStrip", () => {
  it("adds up pipeline, weighted, closing-this-month and won-this-month", () => {
    const s = summarizeDealStrip([
      deal({ stage: "quote", value: 100_000, expected_close_date: "2026-09-15" }), // 80% · this month (even though past)
      deal({ stage: "demo",  value: 50_000,  expected_close_date: "2026-10-01" }), // 40% · next month
      deal({ stage: "trial", value: 10_000,  expected_close_date: "2026-09-30" }), // 60% · this month
      deal({ stage: "trial", value: null }),                                         // no value, still counted
      deal({ stage: "won",   value: 70_000,  stage_changed_at: "2026-09-02T05:00:00Z", paid: true }),
      deal({ stage: "won",   value: 5_000,   stage_changed_at: "2026-08-31T19:00:00Z", paid: true }), // 1 Sep IST → in
      deal({ stage: "won",   value: 9_000,   stage_changed_at: "2026-08-31T17:00:00Z", paid: true }), // 31 Aug IST → out
      deal({ stage: "lost",  value: 999_000, expected_close_date: "2026-09-20" }),
      deal({ stage: "new",   value: 1_000_000, expected_close_date: "2026-09-20" }),      // not a deal
    ], NOW);
    expect(s.pipeline).toEqual({ count: 4, value: 160_000 });
    expect(s.weighted).toBe(80_000 + 20_000 + 6_000);
    expect(s.closingThisMonth).toEqual({ count: 2, value: 110_000 });
    expect(s.wonThisMonth).toEqual({ count: 2, value: 75_000 });
  });

  it("is all zeros on no rows", () => {
    expect(summarizeDealStrip([], NOW)).toEqual({
      pipeline: { count: 0, value: 0 }, weighted: 0,
      closingThisMonth: { count: 0, value: 0 }, wonThisMonth: { count: 0, value: 0 },
      wonAwaitingPayment: { count: 0, value: 0 },
    });
  });

  it("'this month' is the IST month — 19:00 UTC on 31 Oct is already November", () => {
    const s = summarizeDealStrip([deal({ stage: "quote", value: 1, expected_close_date: "2026-11-05" })], new Date("2026-10-31T19:00:00Z"));
    expect(s.closingThisMonth.count).toBe(1);
  });

  /* R-375 (audit finding 8): accept_quote sets stage 'won' BEFORE any payment. */
  it("an accepted-but-unpaid won deal is counted as won but its ₹ is NOT won revenue", () => {
    const s = summarizeDealStrip([
      deal({ stage: "won", value: 70_000, stage_changed_at: "2026-09-02T05:00:00Z", paid: true }),
      deal({ stage: "won", value: 40_000, stage_changed_at: "2026-09-03T05:00:00Z", paid: false }),
      deal({ stage: "won", value: 25_000, stage_changed_at: "2026-09-04T05:00:00Z" }), // unknown = no money
    ], NOW);
    expect(s.wonThisMonth).toEqual({ count: 3, value: 70_000 });
    expect(s.wonAwaitingPayment).toEqual({ count: 2, value: 65_000 });
  });
});

describe("dealReport", () => {
  it("win rate, averages and per-owner table over the last 90 IST days", () => {
    const r = dealReport([
      deal({ stage: "won",  value: 100_000, owner_id: "a", created_at: "2026-09-01T05:00:00Z", stage_changed_at: "2026-09-11T05:00:00Z", paid: true }), // 10d
      deal({ stage: "won",  value: 50_000,  owner_id: "a", created_at: "2026-08-01T05:00:00Z", stage_changed_at: "2026-08-21T05:00:00Z", paid: true }), // 20d
      deal({ stage: "won",  value: 30_000,  owner_id: "b", created_at: "2026-09-20T05:00:00Z", stage_changed_at: "2026-09-25T05:00:00Z", paid: true }), // 5d
      deal({ stage: "lost", value: 80_000,  owner_id: "b", lost_at: "2026-09-10T05:00:00Z" }),
      deal({ stage: "lost", value: 1,       owner_id: null, lost_at: "2026-09-10T05:00:00Z" }),
      deal({ stage: "won",  value: 999_999, owner_id: "a", stage_changed_at: "2026-06-01T05:00:00Z" }), // outside window
      deal({ stage: "quote", value: 500_000, owner_id: "a" }),                                          // open, not decided
    ], NOW);
    expect(r.since).toBe("2026-07-03");
    expect([r.won, r.lost, r.winRatePct]).toEqual([3, 2, 60]);
    expect(r.wonValue).toBe(180_000);
    expect(r.avgWonValue).toBe(60_000);
    expect(r.avgDaysToClose).toBe(11.7);
    expect(r.byOwner).toEqual([
      { ownerId: "a", won: 2, wonValue: 150_000, lost: 0, winRatePct: 100 },
      { ownerId: "b", won: 1, wonValue: 30_000, lost: 1, winRatePct: 50 },
      { ownerId: null, won: 0, wonValue: 0, lost: 1, winRatePct: 0 },
    ]);
  });

  it("the window's first day is inclusive and the day before is out", () => {
    const at = (d: string) => `${d}T00:30:00+05:30`;
    const r = dealReport([
      deal({ stage: "won", value: 1, stage_changed_at: new Date(at("2026-07-03")).toISOString() }),
      deal({ stage: "won", value: 1, stage_changed_at: new Date(at("2026-07-02")).toISOString() }),
    ], NOW);
    expect(r.won).toBe(1);
  });

  it("nothing decided → nulls, never a fake 0%", () => {
    const r = dealReport([deal({ stage: "quote", value: 10 })], NOW);
    expect(r.winRatePct).toBeNull();
    expect(r.avgWonValue).toBeNull();
    expect(r.avgDaysToClose).toBeNull();
    expect(r.byOwner).toEqual([]);
  });

  it("R-375: won ₹, average and per-owner ₹ count only deals with a recorded payment", () => {
    const r = dealReport([
      deal({ stage: "won", value: 100_000, owner_id: "a", stage_changed_at: "2026-09-11T05:00:00Z", paid: true }),
      deal({ stage: "won", value: 400_000, owner_id: "a", stage_changed_at: "2026-09-12T05:00:00Z", paid: false }),
      deal({ stage: "lost", value: 1, owner_id: "a", lost_at: "2026-09-10T05:00:00Z" }),
    ], NOW);
    expect([r.won, r.lost, r.winRatePct]).toEqual([2, 1, 67]); // the decision still counts
    expect(r.wonValue).toBe(100_000);
    expect(r.paidWon).toBe(1);
    expect(r.awaitingPaymentValue).toBe(400_000);
    expect(r.avgWonValue).toBe(100_000);
    expect(r.byOwner[0]).toMatchObject({ ownerId: "a", won: 2, wonValue: 100_000 });
  });
});

describe("canSeeDeals follows the nav", () => {
  it.each(["owner", "manager", "sales", "sales_senior"])("%s sees deals", (r) => expect(canSeeDeals(r)).toBe(true));
  it.each(["billing", "accountant", "support", "delivery", null, undefined, "nobody"])("%s does not", (r) =>
    expect(canSeeDeals(r as string | null | undefined)).toBe(false));
});
