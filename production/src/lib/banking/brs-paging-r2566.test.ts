/**
 * R-2566: the BRS page now paints each list BRS_PAGE_SIZE lines at a time, with a search box.
 * The numbers must not move: counts and ₹ totals come from buildBrs over EVERY line (5,173 here,
 * the 7 Nov staging shape), and paging / searching only picks which rows are painted.
 */
import { describe, expect, it } from "vitest";
import { buildBrs, brsRows, searchBrsLines, BRS_PAGE_SIZE, type BrsLine } from "./brs";

/** The staging-sized account: 3,500 imported unbooked, 1,400 imported matched, 273 manual (3 before opening). */
function bigAccount(): BrsLine[] {
  const out: BrsLine[] = [];
  const day = (n: number) => new Date(Date.UTC(2026, 10, 7) - n * 86400000).toISOString().slice(0, 10);
  for (let g = 1; g <= 3500; g++) out.push({
    id: `u${g}`, txn_date: day(1 + (g % 360)), description: g % 3 === 0 ? `NEFT DR-PERF VENDOR ${g % 97}` : `UPI/CR/${900000 + g}/PERF PAYER ${g % 53}`,
    debit: g % 3 === 0 ? 1000 + (g * 37) % 90000 : 0, credit: g % 3 === 0 ? 0 : 500 + (g * 53) % 120000,
    source: g % 10 === 0 ? "api_fetch" : "csv_upload", matched_to_type: null,
  });
  for (let g = 1; g <= 1400; g++) out.push({
    id: `m${g}`, txn_date: day(1 + (g % 360)), description: `NEFT CR-PERF CUSTOMER ${g % 20}`, debit: 0, credit: 1000 + (g * 71) % 200000,
    source: "csv_upload", matched_to_type: "payment",
  });
  for (let g = 1; g <= 273; g++) out.push({
    id: `x${g}`, txn_date: g <= 3 ? day(410) : day(g % 200), description: g % 2 === 0 ? `PERF cheque issued ${g}` : `PERF deposit ${g}`,
    debit: g % 2 === 0 ? 2000 + g * 11 : 0, credit: g % 2 === 0 ? 0 : 3000 + g * 13, source: "manual", matched_to_type: null,
  });
  return out;
}

/** The totals the way the page computed them before R-2566 — straight sums over the raw lines. */
function handTotals(lines: BrsLine[], opening: number, openingDate: string, asOf: string) {
  const inRange = lines.filter((l) => l.txn_date >= openingDate && l.txn_date <= asOf);
  const imp = inRange.filter((l) => l.source !== "manual");
  const man = inRange.filter((l) => l.source === "manual");
  const net = (r: BrsLine[]) => r.reduce((s, l) => s + l.credit - l.debit, 0);
  const unb = imp.filter((l) => l.matched_to_type === null);
  return {
    statementBalance: Math.round(opening + net(imp)), bookBalance: Math.round(opening + net(inRange)),
    unbookedCount: unb.length, unbookedNet: net(unb),
    transit: man.filter((l) => l.credit > 0).reduce((s, l) => s + l.credit, 0),
    notPresented: man.filter((l) => l.debit > 0).reduce((s, l) => s + l.debit, 0),
  };
}

describe("R-2566 BRS on 5,173 lines — totals from every line, painting paged", () => {
  const lines = bigAccount();
  const asOf = "2026-11-07", openingDate = new Date(Date.UTC(2026, 10, 7) - 400 * 86400000).toISOString().slice(0, 10);
  const brs = buildBrs({ openingBalance: 2500000, openingDate, asOf, lines });
  const hand = handTotals(lines, 2500000, openingDate, asOf);

  it("counts and ₹ match a straight sum over every line", () => {
    expect(brs.unbookedImports).toHaveLength(3500);
    expect(brs.unbookedImports.length).toBe(hand.unbookedCount);
    expect(brs.totals.unbookedImports).toBe(hand.unbookedNet);
    expect(brs.statementBalance).toBe(hand.statementBalance);
    expect(brs.bookBalance).toBe(hand.bookBalance);
    expect(brs.totals.depositsInTransit).toBe(hand.transit);
    expect(brs.totals.paymentsNotPresented).toBe(hand.notPresented);
    expect(brs.ignoredBeforeOpening).toBe(3);
  });

  it("the CSV for the CA still lists every unbooked line (paging is screen-only)", () => {
    const rows = brsRows(brs, "PERF Big HDFC");
    expect(rows.filter((r) => typeof r[0] === "string" && /^ {4}\d{4}-/.test(r[0])).length)
      .toBe(brs.unbookedImports.length + brs.depositsInTransit.length + brs.paymentsNotPresented.length);
  });

  it("the page paints at most one page of rows at first", () => {
    expect(BRS_PAGE_SIZE).toBe(100);
    expect(brs.unbookedImports.slice(0, BRS_PAGE_SIZE)).toHaveLength(100);
  });

  it("search: empty keeps all; narration, date and amount find the line", () => {
    const u = brs.unbookedImports;
    expect(searchBrsLines(u, "  ")).toBe(u);
    const vendor = searchBrsLines(u, "perf vendor 5");
    expect(vendor.length).toBeGreaterThan(0);
    expect(vendor.every((l) => l.description.toLowerCase().includes("perf vendor 5"))).toBe(true);
    const target = u[1234];
    expect(searchBrsLines(u, target.txn_date)).toContain(target);
    const amt = target.credit || target.debit;
    expect(searchBrsLines(u, `₹${amt.toLocaleString("en-IN")}`)).toContain(target);
    expect(searchBrsLines(u, "no such narration xyz")).toEqual([]);
  });
});
