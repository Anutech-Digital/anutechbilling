/**
 * R-1845 — the Balance Sheet equity section by business type. The layout changes; the totals
 * must not: every row adds up to what the page showed before, and Assets = Liabilities + Equity.
 */
import { describe, expect, it } from "vitest";

import { equitySection, equitySectionTotal, equityLineCategories, isReservesLine, registerShareCapital, type EquitySection } from "./equity-section";
import { balanceSheetTotals } from "./balance-sheet-totals";
import { movementTotals, unexplainedAfterEntries } from "./owner-equity";
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";

const AUTO = { cashAndBank: 500_000, receivables: 120_000, payables: 80_000, gstPayable: 18_000 } as BalanceSheetAuto;
const item = (id: string, label: string, amount: number, notes: string | null = null): BalanceSheetItem =>
  ({ id, section: "equity", label, amount, sort_order: 0, notes });
const MANUAL: BalanceSheetItem[] = [item("a", "Owner's capital", 200_000, "Owner's capital"), item("b", "Securities premium", 50_000, "Securities premium")];
const OPENING = { asOf: "2026-03-31", ownerCapital: 100_000, retainedEarnings: 40_000 };
const MOVES = [
  { kind: "drawings" as const, amount: 25_000, movement_date: "2026-10-05", partner_name: "Ravi" },
  { kind: "capital_introduced" as const, amount: 10_000, movement_date: "2026-10-07", partner_name: "Sita" },
  { kind: "drawings" as const, amount: 5_000, movement_date: "2026-03-01", partner_name: "Ravi" },   // before the opening date
];
const RANGE = { after: OPENING.asOf, upTo: "2026-10-24" };
const TOTALS = movementTotals(MOVES, RANGE);
const PROFIT = 60_000;

const build = (type: Parameters<typeof equitySection>[0]["businessType"], profit: number | null = PROFIT) =>
  equitySection({ businessType: type, manualLines: MANUAL, opening: OPENING, profit, totals: TOTALS, movements: MOVES, range: RANGE });

const labels = (s: EquitySection<BalanceSheetItem>) =>
  s.groups.flatMap((g) => [g.title ?? "", ...g.rows.flatMap((r) => (r.kind === "manual" ? r.items.map((i) => i.label) : [r.label])), g.total?.label ?? ""]);

describe("equitySection — headings and lines by business type", () => {
  it("proprietor: Proprietor's capital account, closing capital = opening + capital introduced + profit − drawings", () => {
    const s = build("proprietor");
    expect(s.heading).toBe("Proprietor's capital account");
    expect(s.groups).toHaveLength(1);
    expect(labels(s)).toEqual(expect.arrayContaining(["Owner's capital (opening)", "Profit since 2026-03-31", "Capital introduced", "Less: Owner drawings", "Closing capital"]));
    // hand lines 2,50,000 + opening 1,00,000 + b/f 40,000 + profit 60,000 + 10,000 − 25,000
    expect(s.groups[0].total?.amount).toBe(250_000 + 100_000 + 40_000 + 60_000 + 10_000 - 25_000);
    expect(s.byPartner).toEqual([]);
  });

  it("partnership / LLP: Partners' capital accounts, per partner only from entries in the range", () => {
    for (const t of ["partnership", "llp"] as const) {
      const s = build(t);
      expect(s.heading).toBe("Partners' capital accounts");
      expect(labels(s)).toContain("Partners' capital (opening)");
      expect(s.byPartner).toEqual([
        { partner: "Ravi", capitalIntroduced: 0, drawings: 25_000 },
        { partner: "Sita", capitalIntroduced: 10_000, drawings: 0 },
      ]);
    }
  });

  it("Pvt Ltd: Shareholders' funds = Share capital + Reserves & surplus, and no 'Drawings' anywhere", () => {
    const s = build("pvt_ltd", PROFIT);
    expect(s.heading).toBe("Shareholders' funds");
    expect(s.groups.map((g) => g.title)).toEqual(["Share capital", "Reserves & surplus"]);
    const [share, reserves] = s.groups;
    expect(share.total).toMatchObject({ label: "Total share capital", amount: 200_000 + 100_000 + 10_000 - 25_000 });
    expect(reserves.rows.map((r) => (r.kind === "manual" ? r.items.map((i) => i.label).join() : r.label)))
      .toEqual(["Securities premium", "Reserves & surplus b/f", "Profit since 2026-03-31"]);
    expect(reserves.total?.amount).toBe(50_000 + 40_000 + 60_000);
    const noEntries = equitySection({ businessType: "pvt_ltd", manualLines: MANUAL, opening: OPENING, profit: PROFIT, totals: { capitalIntroduced: 0, drawings: 0 } });
    expect(labels(noEntries).join(" ")).not.toMatch(/drawing/i);
  });

  it("empty type = Pvt Ltd (one resolver)", () => {
    expect(build(null)).toEqual(build("pvt_ltd"));
  });

  it("old hand lines keep their own labels", () => {
    const s = build("proprietor");
    const manual = s.groups[0].rows.find((r) => r.kind === "manual");
    expect(manual && manual.kind === "manual" && manual.items.map((i) => i.label)).toEqual(["Owner's capital", "Securities premium"]);
  });

  it("while the P&L loads there is no closing / reserves total", () => {
    expect(build("proprietor", null).groups[0].total).toBeNull();
    expect(build("pvt_ltd", null).groups[1].total).toBeNull();
  });

  it("without opening balances: Net profit (proprietor) / Profit and loss balance (company)", () => {
    const p = equitySection({ businessType: "proprietor", manualLines: [], opening: null, profit: 5, totals: { capitalIntroduced: 0, drawings: 0 } });
    expect(labels(p)).toEqual(["", "Net profit", "Closing capital"]);
    const c = equitySection({ businessType: "pvt_ltd", manualLines: [], opening: null, profit: 5, totals: { capitalIntroduced: 0, drawings: 0 } });
    expect(c.groups[0].total).toBeNull();   // no share capital line yet
    expect(labels(c)).toContain("Profit and loss balance");
  });
});

describe("totals are the same as before (balanceSheetTotals untouched)", () => {
  const t = balanceSheetTotals(AUTO, MANUAL);
  it("balanceSheetTotals snapshot", () => {
    expect(t).toMatchObject({ totalAssets: 620_000, totalLiab: 98_000, netWorth: 522_000, retained: 272_000 });
  });

  for (const type of ["proprietor", "partnership", "llp", "pvt_ltd", null] as const) {
    it(`${type ?? "empty"}: section + unexplained difference = net worth (Assets = Liabilities + Equity)`, () => {
      const openingEquity = OPENING.ownerCapital + OPENING.retainedEarnings;
      const unexplained = unexplainedAfterEntries({ retained: t.retained, openingEquity, profit: PROFIT, totals: TOTALS });
      const section = equitySectionTotal(build(type));
      expect(section + unexplained).toBe(t.netWorth);
      expect(t.totalAssets).toBe(t.totalLiab + t.netWorth);
    });
  }
});

describe("R-1851: Share capital from the shareholders register", () => {
  const REG = { paidUpCapital: 1_000_000, paidUpShares: 100_000, faceValue: 10 };
  const withReg = (type: Parameters<typeof equitySection>[0]["businessType"], manualLines = MANUAL) =>
    equitySection({ businessType: type, manualLines, opening: OPENING, profit: PROFIT, totals: TOTALS, movements: MOVES, range: RANGE, shareRegister: REG });

  it("Pvt Ltd: the paid-up capital is the first Share capital line, from the register", () => {
    const s = withReg("pvt_ltd", []);
    const first = s.groups[0].rows[0];
    expect(first).toMatchObject({ kind: "line", key: "register_share_capital", label: "Equity share capital", amount: 1_000_000, origin: "auto", source: "Share register" });
    expect(first.kind === "line" && first.hint).toBe("1,00,000 shares × ₹10, fully paid — from the share capital register");
    expect(s.groups[0].total?.hint).toBe("paid-up capital from the share capital register");
    expect(registerShareCapital(s)).toBe(1_000_000);
  });

  it("a hand-entered Share capital line stays as it is (stored data unchanged) and is flagged", () => {
    const s = withReg("pvt_ltd");
    const manual = s.groups[0].rows.find((r) => r.kind === "manual");
    expect(manual && manual.kind === "manual" && manual.items.map((i) => i.label)).toEqual(["Owner's capital"]);
    expect(s.shareCapitalTwice).toBe(true);
    expect(withReg("pvt_ltd", []).shareCapitalTwice).toBe(false);
  });

  it("empty type = Pvt Ltd; other types ignore the register", () => {
    expect(withReg(null)).toEqual(withReg("pvt_ltd"));
    for (const t of ["proprietor", "partnership", "llp"] as const) {
      expect(withReg(t)).toEqual(build(t));
      expect(registerShareCapital(withReg(t))).toBe(0);
    }
  });

  it("no register (or nothing paid up): exactly as before", () => {
    expect(equitySection({ businessType: "pvt_ltd", manualLines: MANUAL, opening: OPENING, profit: PROFIT, totals: TOTALS, movements: MOVES, range: RANGE, shareRegister: null }))
      .toEqual(build("pvt_ltd"));
    expect(equitySection({ businessType: "pvt_ltd", manualLines: MANUAL, opening: OPENING, profit: PROFIT, totals: TOTALS, movements: MOVES, range: RANGE, shareRegister: { ...REG, paidUpCapital: 0, paidUpShares: 0 } }))
      .toEqual(build("pvt_ltd"));
  });

  it("Assets = Liabilities + Equity still holds: the register amount comes out of the unexplained difference", () => {
    const t = balanceSheetTotals(AUTO, MANUAL);
    const s = withReg("pvt_ltd");
    const unexplained = unexplainedAfterEntries({
      retained: t.retained - registerShareCapital(s), openingEquity: OPENING.ownerCapital + OPENING.retainedEarnings, profit: PROFIT, totals: TOTALS,
    });
    expect(equitySectionTotal(s) + unexplained).toBe(t.netWorth);
  });
});

describe("Add-line choices", () => {
  it("company: Share capital + Securities premium, never Drawings", () => {
    expect(equityLineCategories("pvt_ltd").map((c) => c.label)).toEqual(["Share capital", "Securities premium"]);
    expect(equityLineCategories(null).map((c) => c.label).join()).not.toMatch(/drawing/i);
  });
  it("proprietor / partnership: their capital line + drawings (contra)", () => {
    expect(equityLineCategories("proprietor").map((c) => c.label)).toEqual(["Owner's capital", "Owner drawings (–)"]);
    expect(equityLineCategories("partnership")[0].label).toBe("Partners' capital");
    expect(equityLineCategories("partnership")[1].contra).toBe(true);
  });
  it("Securities premium / reserves go under Reserves & surplus", () => {
    expect(isReservesLine({ label: "Share premium", notes: null })).toBe(true);
    expect(isReservesLine({ label: "ABC", notes: "Securities premium" })).toBe(true);
    expect(isReservesLine({ label: "Share capital", notes: "Share capital" })).toBe(false);
  });
});
