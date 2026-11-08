/**
 * R-2405 — Renewals top tiles: Due in 30 / 31–60 / 61–90 (count + ₹), Overdue, Won't renew,
 * Renewed this month (₹ + % of what was due). Each tile's ₹ is the sum of the renewal amounts of
 * exactly the rows its click shows (the card's doneWhen: "the tile's ₹ = the sum of their
 * renewal amounts"), in the table's money — not MRR/ARR mixed (audit: "Urgent MRR ₹5.8L ·
 * Upcoming 30d MRR ₹7.0K · At risk ARR ₹69.2L").
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  TILE_KEYS, monthOf, isFullyPaidRenewal, tileMatches, renewalTiles, paidRenewalsInMonth,
  type TileRow, type RenewalQuotePayment,
} from "./tiles";

const NOV = monthOf("2026-11-03");

const r = (id: string, tab: TileRow["tab"], amount: number, over: Partial<TileRow> = {}): TileRow => ({
  id, tab, amount, statusKey: tab === "overdue" ? "overdue" : "due", renewalDate: "2026-11-20", ...over,
});
const q = (id: string, sub: string, amount: number, over: Partial<RenewalQuotePayment> = {}): RenewalQuotePayment => ({
  id, amount, payment_amount: amount, payment_status: "received", status: "accepted",
  renewal_subscription_id: sub, renewal_term_date: "2026-11-05", ...over,
});

/* A book shaped on the staging audit: yearly renewals, one billed monthly, one won't renew. */
const rows: TileRow[] = [
  r("lapsed", "overdue", 92_040, { renewalDate: "2026-10-31" }),
  r("lapsed-nov", "overdue", 11_800, { renewalDate: "2026-11-01" }),
  r("stopped", "overdue", 5_000, { statusKey: "stopped", renewalDate: "2026-10-14" }),
  r("today", "due7", 78_000, { renewalDate: "2026-11-03" }),
  r("in20", "d30", 24_000, { renewalDate: "2026-11-23" }),
  r("paid-not-moved", "d30", 30_000, { statusKey: "renewed", renewalDate: "2026-11-25" }),
  r("wont-soon", "d30", 50_000, { statusKey: "non-renewing", renewalDate: "2026-11-28" }),
  r("dec", "d30", 6_000, { renewalDate: "2026-12-02" }),
  r("in45", "d60", 120_000, { renewalDate: "2026-12-18" }),
  r("in80", "d90", 15_000, { renewalDate: "2027-01-22" }),
  r("wont-later", "d90", 9_000, { statusKey: "non-renewing", renewalDate: "2027-01-25" }),
];
const quotes: RenewalQuotePayment[] = [
  q("Q-1", "early-paid", 59_000),                                                           // renewed for 5 Nov, date moved on
  q("Q-2", "partial", 40_000, { payment_amount: 10_000, payment_status: "partial" }),       // not a renewal yet
  q("Q-3", "invoiced-paid", 23_600, { payment_status: "invoiced" }),                        // paid, then invoiced
  q("Q-4", "oct", 99_000, { renewal_term_date: "2026-10-30" }),                             // last month
  q("Q-5", "invoiced-unpaid", 12_000, { payment_status: "invoiced", payment_amount: 0 }),  // invoice raised, no money
];

describe("R-2405 tile maths", () => {
  const t = renewalTiles(rows, quotes, NOV);

  it("Overdue = the Overdue tab's rows, in renewal amounts", () => {
    expect(t.overdue).toEqual({ count: 3, amount: 92_040 + 11_800 + 5_000 });
  });

  it("Due in 30 = today..+30, without paid or Won't renew rows; 31–60 and 61–90 are windows", () => {
    expect(t.due30).toEqual({ count: 3, amount: 78_000 + 24_000 + 6_000 });
    expect(t.due60).toEqual({ count: 1, amount: 120_000 });
    expect(t.due90).toEqual({ count: 1, amount: 15_000 });
  });

  it("Won't renew = the money that is leaving, wherever its date falls", () => {
    expect(t.wontRenew).toEqual({ count: 2, amount: 59_000 });
  });

  it("Renewed this month = fully paid renewals for a November date (+ a Renewed row), % of all due in November", () => {
    /* Q-1 + Q-3 paid (Q-2 partial, Q-4 October, Q-5 invoiced without money) + the paid row whose date has not moved */
    expect(t.renewedMonth.count).toBe(3);
    expect(t.renewedMonth.amount).toBe(59_000 + 23_600 + 30_000);
    /* still due in November: lapsed-nov, today, in20 (not the Won't renew row, not December) */
    expect(t.renewedMonth.stillDue).toEqual({ count: 3, amount: 11_800 + 78_000 + 24_000 });
    expect(t.renewedMonth.dueAmount).toBe(112_600 + 113_800);
    expect(t.renewedMonth.pct).toBe(Math.round((112_600 / 226_400) * 100)); // 50
  });

  it("nothing due this month → no % (never a 0% or a divide by zero)", () => {
    expect(renewalTiles([], [], NOV).renewedMonth.pct).toBeNull();
  });

  it("a subscription paid this month is not also 'still due' if its row is still listed", () => {
    const listed = [r("early-paid", "overdue", 59_000, { renewalDate: "2026-11-05" })];
    const tt = renewalTiles(listed, [q("Q-1", "early-paid", 59_000)], NOV);
    expect(tt.renewedMonth.stillDue.count).toBe(0);
    expect(tt.renewedMonth.pct).toBe(100);
  });

  it("whole rupees only", () => {
    const tt = renewalTiles([r("a", "due7", 100.4), r("b", "due7", 200.6)], [], NOV);
    expect(tt.due30.amount).toBe(301);
    expect(Number.isInteger(tt.due30.amount)).toBe(true);
  });
});

describe("R-2405 a tile's click shows exactly the rows its ₹ adds up", () => {
  const paidSubs = new Set(paidRenewalsInMonth(quotes, NOV).map((x) => x.renewal_subscription_id!));
  const t = renewalTiles(rows, quotes, NOV);
  for (const key of TILE_KEYS) {
    it(key, () => {
      const shown = rows.filter((x) => tileMatches(key, x, NOV, paidSubs));
      const fig = key === "renewedMonth" ? t.renewedMonth.stillDue : t[key];
      expect(shown.length).toBe(fig.count);
      expect(shown.reduce((s, x) => s + x.amount, 0)).toBe(fig.amount);
    });
  }

  it("the three Due tiles never hold the same row", () => {
    const ids = (["due30", "due60", "due90"] as const).flatMap((k) => rows.filter((x) => tileMatches(k, x, NOV)).map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("R-2405 helpers", () => {
  it("monthOf gives the IST calendar month", () => {
    expect(monthOf("2026-11-03")).toEqual({ start: "2026-11-01", end: "2026-11-30", label: "Nov" });
    expect(monthOf("2027-02-10").end).toBe("2027-02-28");
    expect(monthOf("2028-02-10").end).toBe("2028-02-29");
  });

  it("isFullyPaidRenewal: received or invoiced with the full total in; never partial or rejected", () => {
    expect(isFullyPaidRenewal(q("a", "s", 100))).toBe(true);
    expect(isFullyPaidRenewal(q("a", "s", 100, { payment_status: "invoiced" }))).toBe(true);
    expect(isFullyPaidRenewal(q("a", "s", 100, { payment_status: "partial", payment_amount: 50 }))).toBe(false);
    expect(isFullyPaidRenewal(q("a", "s", 100, { payment_status: "invoiced", payment_amount: 0 }))).toBe(false);
    expect(isFullyPaidRenewal(q("a", "s", 100, { status: "rejected" }))).toBe(false);
    expect(isFullyPaidRenewal(q("a", "s", 0))).toBe(false);
  });
});

describe("R-2405 page wiring", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  const tiles = readFileSync("src/app/(app)/renewals/tiles-card.tsx", "utf8");

  it("the old Insights money line (MRR and ARR mixed) is gone", () => {
    expect(page).not.toMatch(/Urgent MRR|Upcoming 30d MRR|At risk ARR/);
    expect(page).not.toContain('title="Insights"');
  });

  it("the tiles sit above the queue and a press filters it (the table shows the tile's rows)", () => {
    expect(page).toMatch(/<RenewalTileRow[\s\S]*?onPick=\{pickTile\}/);
    expect(page.indexOf("<RenewalTileRow")).toBeLessThan(page.indexOf("<RenewalQueue"));
    expect(page).toMatch(/tile \? allItems\.filter\(\(i\) => \{[^}]*tileMatches\(tile, /);   // R-2586: Later rows have no tile row
    expect(page).toMatch(/rows=\{tile \? tileShown : shown\[bucketTab\]\}/);
  });

  it("every tile is a button that says whether it is pressed", () => {
    expect(tiles).toMatch(/<button[\s\S]*?type="button"[\s\S]*?aria-pressed=\{active === key\}/);
    expect(tiles).toMatch(/TILE_KEYS\.map/);
  });
});
