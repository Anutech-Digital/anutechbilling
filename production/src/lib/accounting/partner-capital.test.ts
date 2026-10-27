import { describe, it, expect } from "vitest";
import { partnerCapitalAccounts, splitProfit, partnerStatement, partnerCapitalCsv, partnerTdsInRange } from "./partner-capital";
import type { FirmPartner } from "./partners";
import type { OwnerEquityMovement } from "./owner-equity";

const fp = (id: string, name: string, pct: number, cap = 0, over: Partial<FirmPartner> = {}): FirmPartner => ({
  id, name, pan: null, din_dpin: null, is_designated: false, profit_share_pct: pct, capital_contribution: cap,
  joined_on: null, left_on: null, note: null, ...over,
});
let n = 0;
const mv = (over: Partial<OwnerEquityMovement>): OwnerEquityMovement => ({
  id: `m${++n}`, kind: "drawings", movement_date: "2026-10-05", amount: 0, bank_account_id: "acc", bank_txn_id: `t${n}`,
  own_line: true, partner_name: null, partner_id: null, note: null, ...over,
});

const A = fp("a", "Asha", 60, 100000);
const B = fp("b", "Bimal", 40, 50000);

describe("splitProfit — by ratio, whole rupees, adds up exactly", () => {
  it("60:40 of ₹1,00,001 → 60,001 + 40,000 (largest remainder)", () => {
    expect(splitProfit(100001, [60, 40])).toEqual([60001, 40000]);
  });
  it("thirds (33.33 % each) of ₹100: the parts add up to the rounded total", () => {
    const s = splitProfit(100, [33.33, 33.33, 33.33]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(Math.round(100 * 99.99 / 100));
  });
  it("a loss is shared too (negative)", () => {
    expect(splitProfit(-10000, [60, 40])).toEqual([-6000, -4000]);
  });
  it("shares totalling 90 leave 10 % unsplit", () => {
    expect(splitProfit(1000, [60, 30])).toEqual([600, 300]);
  });
});

describe("partnerCapitalAccounts — opening + introduced + share of profit − drawings = closing", () => {
  it("card example: A brought ₹1L, B took ₹20k → A +1L, B −20k (no profit)", () => {
    const res = partnerCapitalAccounts({
      partners: [fp("a", "A", 60), fp("b", "B", 40)],
      movements: [
        mv({ kind: "capital_introduced", amount: 100000, partner_id: "a", partner_name: "A" }),
        mv({ kind: "drawings", amount: 20000, partner_id: "b", partner_name: "B" }),
      ],
      profit: 0,
      sectionTotal: 80000,
    });
    expect(res.rows.map((r) => [r.name, r.closing])).toEqual([["A", 100000], ["B", -20000]]);
    expect(res.totalClosing).toBe(80000);
    expect(res.notSplit).toBe(0);
  });

  it("with opening capital and a profit estimate", () => {
    const res = partnerCapitalAccounts({
      partners: [A, B],
      movements: [
        mv({ kind: "capital_introduced", amount: 25000, partner_id: "a" }),
        mv({ kind: "drawings", amount: 12000, partner_id: "b" }),
        mv({ kind: "drawings", amount: 3000, partner_id: "b" }),
      ],
      profit: 200000,
      sectionTotal: null,
    });
    const a = res.rows.find((r) => r.name === "Asha")!;
    const b = res.rows.find((r) => r.name === "Bimal")!;
    expect(a).toMatchObject({ opening: 100000, capitalIntroduced: 25000, profitShare: 120000, drawings: 0, closing: 245000, linked: true, sharePct: 60 });
    expect(b).toMatchObject({ opening: 50000, capitalIntroduced: 0, profitShare: 80000, drawings: 15000, closing: 115000 });
    expect(res.profitShareIsEstimate).toBe(true);
    expect(res.notSplit).toBeNull();
  });

  it("only entries in the Balance Sheet range count", () => {
    const res = partnerCapitalAccounts({
      partners: [A],
      movements: [
        mv({ kind: "drawings", amount: 1000, partner_id: "a", movement_date: "2026-03-31" }),
        mv({ kind: "drawings", amount: 2000, partner_id: "a", movement_date: "2026-04-01" }),
        mv({ kind: "drawings", amount: 4000, partner_id: "a", movement_date: "2026-11-01" }),
      ],
      profit: 0,
      range: { after: "2026-03-31", upTo: "2026-10-31" },
      sectionTotal: null,
    });
    expect(res.rows[0].drawings).toBe(2000);
  });

  it("older free-text entries stay under their own name, not linked, no opening or profit share", () => {
    const res = partnerCapitalAccounts({
      partners: [A, B],
      movements: [mv({ kind: "drawings", amount: 700, partner_name: "Asha (old)" }), mv({ kind: "drawings", amount: 300, partner_name: "asha (old)" })],
      profit: 0,
      sectionTotal: null,
    });
    const old = res.rows.find((r) => !r.linked)!;
    expect(old).toMatchObject({ name: "Asha (old)", opening: 0, profitShare: 0, drawings: 1000, closing: -1000, partnerId: null });
    expect(res.unlinkedCount).toBe(2);
  });

  it("whatever the partners' accounts do not cover shows as 'not split', so the section total never changes", () => {
    const res = partnerCapitalAccounts({ partners: [A, B], movements: [], profit: 10000, sectionTotal: 400000 });
    // 1,50,000 opening + 10,000 profit = 1,60,000 in partners' accounts; the CA's lump says 4,00,000.
    expect(res.totalClosing).toBe(160000);
    expect(res.notSplit).toBe(240000);
  });

  it("a partner who left before the date keeps their entries but gets no profit share", () => {
    const C = fp("c", "Chetan", 10, 0, { left_on: "2026-06-30" });
    const res = partnerCapitalAccounts({
      partners: [A, B, C],
      movements: [mv({ kind: "drawings", amount: 500, partner_id: "c", movement_date: "2026-06-01" })],
      profit: 1000,
      range: { upTo: "2026-10-31" },
      sectionTotal: null,
    });
    const c = res.rows.find((r) => r.name === "Chetan")!;
    expect(c).toMatchObject({ profitShare: 0, drawings: 500, left: true });
    expect(res.rows.find((r) => r.name === "Asha")!.profitShare).toBe(600);
  });

  it("a partner who left with no entries in range is not listed", () => {
    const C = fp("c", "Chetan", 0, 9000, { left_on: "2025-03-31" });
    const res = partnerCapitalAccounts({ partners: [A, C], movements: [], profit: 0, range: { after: "2026-03-31" }, sectionTotal: null });
    expect(res.rows.map((r) => r.name)).toEqual(["Asha"]);
  });

  it("profit still loading → share 0 and closing null-safe", () => {
    const res = partnerCapitalAccounts({ partners: [A], movements: [], profit: null, sectionTotal: null });
    expect(res.rows[0].profitShare).toBe(0);
    expect(res.profitLoading).toBe(true);
  });
});

describe("partnerStatement — the drill-down", () => {
  it("opening, each dated entry, share of profit, closing", () => {
    const ms = [
      mv({ kind: "drawings", amount: 12000, partner_id: "b", movement_date: "2026-10-03", note: "Home rent" }),
      mv({ kind: "capital_introduced", amount: 5000, partner_id: "b", movement_date: "2026-09-01" }),
      mv({ kind: "drawings", amount: 99, partner_id: "a", movement_date: "2026-09-02" }),
    ];
    const res = partnerCapitalAccounts({ partners: [A, B], movements: ms, profit: 1000, sectionTotal: null });
    const b = res.rows.find((r) => r.name === "Bimal")!;
    const st = partnerStatement(b, ms, {});
    expect(st.map((l) => [l.label, l.amount])).toEqual([
      ["Opening capital", 50000],
      ["Capital introduced", 5000],
      ["Drawings", -12000],
      ["Share of profit (40%, estimate)", 400],
      ["Closing capital", 43400],
    ]);
    expect(st[1].date).toBe("2026-09-01");
    expect(st[2].note).toBe("Home rent");
  });
  it("CSV has one line per statement line", () => {
    const res = partnerCapitalAccounts({ partners: [A], movements: [], profit: 0, sectionTotal: null });
    const csv = partnerCapitalCsv(res.rows[0], [], {});
    expect(csv.header).toEqual(["Date", "Particulars", "Amount (INR)", "Note"]);
    expect(csv.rows[0]).toEqual(["", "Opening capital", 100000, ""]);
    expect(csv.rows.at(-1)).toEqual(["", "Closing capital", 100000, ""]);
  });
});

describe("R-1849 — a posted year-end split replaces the estimate for that year", () => {
  const split = {
    fyStart: 2025, postedOn: "2026-03-31", netProfit: 1_060_000,
    lines: [
      { partnerId: "a", interest: 60_000, remuneration: 433_333, profitShare: 132_000, tds: 49_333, tdsSection: "194T" },
      { partnerId: "b", interest: 0, remuneration: 346_667, profitShare: 88_000, tds: 34_667, tdsSection: "194T" },
    ],
  };

  it("posted interest, remuneration and share, less TDS; only the profit after it is estimated", () => {
    const res = partnerCapitalAccounts({ partners: [A, B], movements: [], profit: 1_260_000, posted: [split], sectionTotal: null });
    const a = res.rows.find((r) => r.name === "Asha")!;
    expect(a).toMatchObject({ interest: 60_000, remuneration: 433_333, profitShare: 252_000, estimatedShare: 120_000, tds: 49_333 });
    expect(a.closing).toBe(100_000 + 60_000 + 433_333 + 252_000 - 49_333);
    expect(res.profitShareIsEstimate).toBe(true);
    expect(res.estimatedProfit).toBe(200_000);
  });

  it("all the profit posted → nothing is an estimate", () => {
    const res = partnerCapitalAccounts({ partners: [A, B], movements: [], profit: 1_060_000, posted: [split], sectionTotal: null });
    expect(res.profitShareIsEstimate).toBe(false);
    expect(res.rows.find((r) => r.name === "Bimal")!.closing).toBe(50_000 + 346_667 + 88_000 - 34_667);
  });

  it("a split posted on or before the CA's opening date is inside the opening figure — not counted again", () => {
    const res = partnerCapitalAccounts({ partners: [A, B], movements: [], profit: 0, posted: [split], range: { after: "2026-03-31" }, sectionTotal: null });
    expect(res.rows.find((r) => r.name === "Asha")!.interest).toBe(0);
  });

  it("the statement shows the year's split dated 31 March, then the estimate", () => {
    const res = partnerCapitalAccounts({ partners: [A, B], movements: [], profit: 1_260_000, posted: [split], sectionTotal: null });
    const st = partnerStatement(res.rows.find((r) => r.name === "Asha")!, [], {});
    expect(st.map((l) => [l.date, l.label, l.amount])).toEqual([
      [null, "Opening capital", 100_000],
      ["2026-03-31", "Interest on capital FY 2025-26", 60_000],
      ["2026-03-31", "Remuneration FY 2025-26", 433_333],
      ["2026-03-31", "Share of profit FY 2025-26 (60%)", 132_000],
      ["2026-03-31", "Less: TDS u/s 194T FY 2025-26", -49_333],
      [null, "Share of profit (60%, estimate)", 120_000],
      [null, "Closing capital", 100_000 + 60_000 + 433_333 + 252_000 - 49_333],
    ]);
  });

  it("partnerTdsInRange: the TDS taken from partners in the range (for the equity section)", () => {
    expect(partnerTdsInRange([split], {})).toBe(84_000);
    expect(partnerTdsInRange([split], { after: "2026-03-31" })).toBe(0);
  });
});
