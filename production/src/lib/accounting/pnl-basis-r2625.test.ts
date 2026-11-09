/**
 * R-2625 — the P&L "Management (matched)" view counts revenue as EARNED only up to today.
 * R-2624 checker: in November "This FY" (1 Apr..31 Mar) on Management showed the Dec..Mar parts of
 * yearly invoices as earned. Now the range is cut at today; the later days' part is "not earned yet".
 */
import { describe, it, expect } from "vitest";
import { earnedRange, notYetEarnedRange, notYetEarnedNote, fetchRevenueDrillLines, netRevenueOf } from "./pnl-basis";

const TODAY = "2026-11-09";
const FY = { from: "2026-04-01", to: "2027-03-31" };

describe("R-2625 earnedRange / notYetEarnedRange", () => {
  it("This FY in November: earned 1 Apr..9 Nov, not yet 10 Nov..31 Mar", () => {
    expect(earnedRange(FY, TODAY)).toEqual({ from: "2026-04-01", to: "2026-11-09" });
    expect(notYetEarnedRange(FY, TODAY)).toEqual({ from: "2026-11-10", to: "2027-03-31" });
  });
  it("a past range is untouched and has no later part", () => {
    expect(earnedRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(notYetEarnedRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toBeNull();
  });
  it("a range ending today has no later part", () => {
    expect(notYetEarnedRange({ from: "2026-11-01", to: TODAY }, TODAY)).toBeNull();
  });
  it("a range wholly after today earns nothing; all of it is not yet earned", () => {
    expect(earnedRange({ from: "2027-03-01", to: "2027-03-31" }, TODAY)).toBeNull();
    expect(notYetEarnedRange({ from: "2027-03-01", to: "2027-03-31" }, TODAY)).toEqual({ from: "2027-03-01", to: "2027-03-31" });
  });
  it("month end and year end roll over", () => {
    expect(notYetEarnedRange({ from: "2026-12-01", to: "2027-01-31" }, "2026-12-31")).toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });
});

describe("R-2625 notYetEarnedNote", () => {
  const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  const date = (iso: string) => iso;
  it("no cap → no note (GST view, past ranges)", () => {
    expect(notYetEarnedNote({}, money, date)).toBeNull();
  });
  it("says the amount already invoiced for later days is Advance billing", () => {
    expect(notYetEarnedNote({ revenueEarnedTo: TODAY, revenueNotYetEarned: 4_700 }, money, date))
      .toBe("Management revenue is counted only up to today (2026-11-09). ₹4,700 already invoiced for the rest of this period is not earned yet — the Balance Sheet shows it as Advance billing.");
  });
  it("nothing invoiced for later days", () => {
    expect(notYetEarnedNote({ revenueEarnedTo: TODAY, revenueNotYetEarned: 0 }, money, date)).toContain("Nothing invoiced so far");
  });
});

describe("R-2625 drill on Management is cut at today, like the card", () => {
  function rpcSpy() {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, client: { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: [], error: null }); } } };
  }
  it("This FY → matched lines to today", async () => {
    const s = rpcSpy();
    await fetchRevenueDrillLines(s.client, FY, null, "management", TODAY);
    expect(s.calls).toEqual([{ fn: "report_pnl_revenue_matched_lines", args: { p_from: "2026-04-01", p_to: "2026-11-09", p_families: null } }]);
  });
  it("a future month → no rows, no call (card ₹0)", async () => {
    const s = rpcSpy();
    expect(await fetchRevenueDrillLines(s.client, { from: "2027-03-01", to: "2027-03-31" }, null, "management", TODAY)).toEqual([]);
    expect(s.calls).toEqual([]);
  });
  it("GST view is not cut", async () => {
    const s = rpcSpy();
    await fetchRevenueDrillLines(s.client, FY, ["google"], "gst", TODAY);
    expect(s.calls).toEqual([{ fn: "report_pnl_revenue_lines", args: { p_from: "2026-04-01", p_to: "2027-03-31", p_families: ["google"] } }]);
  });
});

describe("R-2625 netRevenueOf", () => {
  it("invoices − credit notes + debit notes", () => {
    expect(netRevenueOf({ inv_taxable: 12_000, cn_taxable: 6_000, dn_taxable: 500 })).toBe(6_500);
  });
});
