/**
 * R-2625 — the P&L "Management (matched)" view shows no revenue for months that have not happened.
 * R-2624 checker: in November "This FY" (1 Apr..31 Mar) on Management showed the Dec..Mar parts of
 * yearly invoices as earned. Now the range is cut at the end of the current month (whole months, so
 * "This month" keeps revenue and cost of goods on the same days); the later months are "not earned yet".
 */
import { describe, it, expect } from "vitest";
import { earnedRange, notYetEarnedRange, notYetEarnedNote, fetchRevenueDrillLines, netRevenueOf, monthEndOf } from "./pnl-basis";

const TODAY = "2026-11-09";
const FY = { from: "2026-04-01", to: "2027-03-31" };

describe("R-2625 earnedRange / notYetEarnedRange", () => {
  it("This FY in November: counted 1 Apr..30 Nov, not yet 1 Dec..31 Mar", () => {
    expect(earnedRange(FY, TODAY)).toEqual({ from: "2026-04-01", to: "2026-11-30" });
    expect(notYetEarnedRange(FY, TODAY)).toEqual({ from: "2026-12-01", to: "2027-03-31" });
  });
  it("This month (the current month) is whole and has no later part — same days as the cost of goods", () => {
    expect(earnedRange({ from: "2026-11-01", to: "2026-11-30" }, TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(notYetEarnedRange({ from: "2026-11-01", to: "2026-11-30" }, TODAY)).toBeNull();
  });
  it("a past range is untouched and has no later part", () => {
    expect(earnedRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(notYetEarnedRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toBeNull();
  });
  it("a custom range ending today has no later part and is not cut", () => {
    expect(notYetEarnedRange({ from: "2026-11-01", to: TODAY }, TODAY)).toBeNull();
    expect(earnedRange({ from: "2026-11-01", to: TODAY }, TODAY)).toEqual({ from: "2026-11-01", to: TODAY });
  });
  it("a range wholly after today earns nothing; all of it is not yet earned", () => {
    expect(earnedRange({ from: "2027-03-01", to: "2027-03-31" }, TODAY)).toBeNull();
    expect(notYetEarnedRange({ from: "2027-03-01", to: "2027-03-31" }, TODAY)).toEqual({ from: "2027-03-01", to: "2027-03-31" });
  });
  it("month end and year end roll over; February and leap years", () => {
    expect(notYetEarnedRange({ from: "2026-12-01", to: "2027-01-31" }, "2026-12-15")).toEqual({ from: "2027-01-01", to: "2027-01-31" });
    expect(monthEndOf("2027-02-10")).toBe("2027-02-28");
    expect(monthEndOf("2028-02-10")).toBe("2028-02-29");
    expect(monthEndOf("2026-11-30")).toBe("2026-11-30");
  });
});

describe("R-2625 notYetEarnedNote", () => {
  const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  const date = (iso: string) => iso;
  it("no cap → no note (GST view, past ranges)", () => {
    expect(notYetEarnedNote({}, money, date)).toBeNull();
  });
  it("says the amount already invoiced for later days is Advance billing", () => {
    expect(notYetEarnedNote({ revenueEarnedTo: "2026-11-30", revenueNotYetEarned: 4_000 }, money, date))
      .toBe("Management revenue is counted only up to the end of this month (2026-11-30) — later months have not happened yet. ₹4,000 already invoiced for them is not earned yet — it is part of the Advance billing on the Balance Sheet.");
  });
  it("nothing invoiced for later days", () => {
    expect(notYetEarnedNote({ revenueEarnedTo: "2026-11-30", revenueNotYetEarned: 0 }, money, date)).toContain("Nothing invoiced so far");
  });
});

describe("R-2625 drill on Management is cut at this month's end, like the card", () => {
  function rpcSpy() {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, client: { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: [], error: null }); } } };
  }
  it("This FY → matched lines to 30 Nov", async () => {
    const s = rpcSpy();
    await fetchRevenueDrillLines(s.client, FY, null, "management", TODAY);
    expect(s.calls).toEqual([{ fn: "report_pnl_revenue_matched_lines", args: { p_from: "2026-04-01", p_to: "2026-11-30", p_families: null } }]);
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
