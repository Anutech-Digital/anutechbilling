/**
 * R-2741 — tiles, tabs and lists on one model: a tile's number = its list's rows = its tab's rows
 * less the closed rows the tile names ("+1 won't renew"). Header owed = the rows' owed added up.
 */
import { describe, expect, it } from "vitest";
import {
  monthOf, renewalTiles, tileMatches, renewedRowMatches, reconcileWindows, windowExtraNote, paidRenewalsInMonth,
  type RenewalQuotePayment, type TileRow,
} from "./tiles";
import { subscriptionDuesLine } from "@/lib/accounting/receivables-due";
import { toChaseSummary } from "@/lib/accounting/receivables-due";

const NOV = monthOf("2026-11-14");
const r = (id: string, tab: TileRow["tab"], amount: number, over: Partial<TileRow> = {}): TileRow => ({
  id, tab, amount, statusKey: tab === "overdue" ? "overdue" : "due", renewalDate: "2026-11-20", ...over,
});
const rows: TileRow[] = [
  r("o1", "overdue", 1000, { renewalDate: "2026-11-01" }),
  r("o-wont", "overdue", 2000, { statusKey: "non-renewing", renewalDate: "2026-11-01" }),
  r("a", "due7", 100), r("b", "d30", 200), r("c", "d30", 300),
  r("wont", "d30", 400, { statusKey: "non-renewing" }),       // the audit's 7-vs-8: tab lists it, tile does not
  r("done", "d30", 500, { statusKey: "renewed" }),
  r("d60a", "d60", 600), r("d90a", "d90", 700, { renewalDate: "2027-01-20" }),
];
const quote = (id: string, sub: string, amount: number): RenewalQuotePayment => ({
  id, amount, payment_amount: amount, payment_status: "received", renewal_subscription_id: sub, renewal_term_date: "2026-11-05", subtotal: amount, discount_pct: 0, tax_rate: 0,
});

describe("R-2741 tile = tab rows less the closed rows named", () => {
  const w = reconcileWindows(rows, NOV);
  it("every window: tab rows = tile rows + won't renew + renewed", () => {
    for (const k of ["overdue", "due30", "due60", "due90"] as const) {
      expect(w[k].tabRows).toBe(w[k].tileRows + w[k].wontRenew + w[k].renewed);
    }
  });
  it("Due in 30: tabs hold 5 rows, the tile counts 3 and names the rest", () => {
    expect(w.due30).toEqual({ tabRows: 5, tileRows: 3, wontRenew: 1, renewed: 1 });
    expect(windowExtraNote(w.due30)).toBe("(+1 won't renew, +1 renewed)");
  });
  it("Overdue no longer counts a Won't renew row twice", () => {
    expect(w.overdue).toEqual({ tabRows: 2, tileRows: 1, wontRenew: 1, renewed: 0 });
    expect(renewalTiles(rows, [], NOV).overdue).toEqual({ count: 1, amount: 1000 });
  });
  it("no extra words when tab and tile agree", () => {
    expect(windowExtraNote(w.due60)).toBe("");
    expect(windowExtraNote(w.due90)).toBe("");
  });
  it("each tile's number is the sum of the rows it lists", () => {
    const t = renewalTiles(rows, [], NOV);
    for (const k of ["overdue", "due30", "due60", "due90", "wontRenew"] as const) {
      const list = rows.filter((x) => tileMatches(k, x, NOV));
      expect(list.length).toBe(t[k].count);
      expect(list.reduce((s, x) => s + x.amount, 0)).toBe(t[k].amount);
    }
  });
  it("no row sits in two work tiles + Won't renew", () => {
    const keys = ["overdue", "due30", "due60", "due90", "wontRenew"] as const;
    for (const x of rows) expect(keys.filter((k) => tileMatches(k, x, NOV)).length).toBeLessThanOrEqual(1);
  });
});

describe("R-2741 Renewed tile opens exactly the renewals it counts", () => {
  const quotes = [quote("Q1", "a", 100), quote("Q2", "gone", 50)];   // 'gone' has no row in the tab windows
  const paidSubs = new Set(paidRenewalsInMonth(quotes, NOV).map((q) => q.renewal_subscription_id!));
  const t = renewalTiles(rows, quotes, NOV);
  it("lists the paid-quote rows and a Renewed row; the count minus the listed = the ones moved off the list", () => {
    const list = rows.filter((x) => renewedRowMatches(x, NOV, paidSubs));
    expect(list.map((x) => x.id).sort()).toEqual(["a", "done"]);
    expect(t.renewedMonth.count).toBe(3);            // Q1 + Q2 + the Renewed row
    expect(t.renewedMonth.count - list.length).toBe(1);   // Q2's row is not on the list any more
  });
});

describe("R-2741 header owed line", () => {
  it("leads with the rows' own owed total (R-2818), not outstanding_amount", () => {
    const line = subscriptionDuesLine(toChaseSummary([]), 482_128, false, 12_500);
    expect(line).toBe("Bills and instalments due: ₹12,500 unpaid on these renewals");   // R-2855: names what is owed
  });
  it("nothing owed on the rows: says so, even when outstanding_amount is stale", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 482_128, false, 0)).toBe("No bill or instalment unpaid on these renewals");
  });
  it("without the new figure the old line is unchanged", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 2000, false)).toMatch(/^₹2,000 unpaid on these renewals/);
  });
});
