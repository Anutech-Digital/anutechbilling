import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  ownerEquityWords, movementTotals, capitalStatement, unexplainedAfterEntries, drawingsRegister,
  drawingsRegisterCsv, looksLikeDrawingsLine, DIRECTOR_CHOICES, type OwnerEquityMovement,
} from "./owner-equity";

const mv = (p: Partial<OwnerEquityMovement> & Pick<OwnerEquityMovement, "kind" | "amount" | "movement_date">): OwnerEquityMovement => ({
  id: `m-${p.movement_date}-${p.amount}`, bank_account_id: "acc-1", bank_txn_id: "t", own_line: true, partner_name: null, note: null, ...p,
});

describe("R-1839 proprietorship capital statement", () => {
  const movements = [
    mv({ kind: "capital_introduced", amount: 50_000, movement_date: "2026-04-10" }),
    mv({ kind: "drawings", amount: 12_000, movement_date: "2026-05-01" }),
    mv({ kind: "drawings", amount: 8_000, movement_date: "2026-06-15" }),
    mv({ kind: "drawings", amount: 3_000, movement_date: "2026-03-20" }),   // before the CA's opening date
  ];

  it("closing = opening + capital introduced + net profit − drawings", () => {
    const totals = movementTotals(movements, { after: "2026-03-31" });
    expect(totals).toEqual({ capitalIntroduced: 50_000, drawings: 20_000 });
    const s = capitalStatement({ opening: 2_00_000, netProfit: 1_20_000, totals });
    expect(s).toEqual({ opening: 2_00_000, capitalIntroduced: 50_000, netProfit: 1_20_000, drawings: 20_000, closing: 3_50_000 });
  });

  it("counts only entries after the CA's opening date (they are inside the opening figure)", () => {
    expect(movementTotals(movements).drawings).toBe(23_000);
    expect(movementTotals(movements, { after: "2026-03-31" }).drawings).toBe(20_000);
    expect(movementTotals(movements, { after: "2026-03-31", upTo: "2026-05-31" }).drawings).toBe(12_000);
  });

  it("a loss and drawings can take capital below zero — shown as it is", () => {
    const s = capitalStatement({ opening: 10_000, netProfit: -15_000, totals: { capitalIntroduced: 0, drawings: 5_000 } });
    expect(s.closing).toBe(-10_000);
  });

  it("drawings recorded with their cash line leave nothing unexplained", () => {
    /* Books: opening cash 1,00,000 = opening capital; profit 30,000 (cash); owner took 20,000.
       Cash now 1,10,000 → net worth 1,10,000. Before R-1839 the 20,000 sat in the difference. */
    const retained = 1_10_000;
    expect(unexplainedAfterEntries({ retained, openingEquity: 1_00_000, profit: 30_000, totals: { capitalIntroduced: 0, drawings: 0 } })).toBe(-20_000);
    expect(unexplainedAfterEntries({ retained, openingEquity: 1_00_000, profit: 30_000, totals: { capitalIntroduced: 0, drawings: 20_000 } })).toBe(0);
  });
});

describe("R-1839 labels by company type", () => {
  it("proprietor: owner drawings / capital introduced, no partner", () => {
    const w = ownerEquityWords("proprietor");
    expect(w).toMatchObject({ allowed: true, needsPartner: false, drawings: "Owner drawings", capital: "Capital introduced" });
  });
  it("partnership and LLP: per partner; LLP says partner withdrawal", () => {
    expect(ownerEquityWords("partnership")).toMatchObject({ allowed: true, needsPartner: true, drawings: "Partner drawings" });
    expect(ownerEquityWords("llp")).toMatchObject({ allowed: true, needsPartner: true, drawings: "Partner withdrawal" });
  });
  it("Pvt Ltd sees director options, never drawings", () => {
    const w = ownerEquityWords("pvt_ltd");
    expect(w.allowed).toBe(false);
    expect(w.drawings).toBe("Paid to director");
    expect(w.drawings).not.toMatch(/drawing/i);
    expect(DIRECTOR_CHOICES.map((c) => c.key)).toEqual(["salary", "loan", "reimbursement", "dividend"]);
    expect(DIRECTOR_CHOICES.find((c) => c.key === "loan")?.caution).toMatch(/s\.185/);
    expect(DIRECTOR_CHOICES.find((c) => c.key === "salary")?.href).toBe("/accounting/payroll");
    expect(DIRECTOR_CHOICES.find((c) => c.key === "loan")?.href).toBe("/accounting/loans-given");
  });
  it("company type not set reads as a proprietorship", () => {
    expect(ownerEquityWords(null).drawings).toBe("Owner drawings");
  });
});

describe("R-1839 drawings register", () => {
  const movements = [
    mv({ kind: "drawings", amount: 5_000, movement_date: "2026-04-05", partner_name: "Ravi" }),
    mv({ kind: "drawings", amount: 7_000, movement_date: "2026-04-25", partner_name: "Sita" }),
    mv({ kind: "capital_introduced", amount: 20_000, movement_date: "2026-06-01", partner_name: "Ravi" }),
    mv({ kind: "drawings", amount: 1_000, movement_date: "2027-04-01", partner_name: "Ravi" }),   // next FY
  ];
  it("groups by month with a total for the FY", () => {
    const r = drawingsRegister(movements, 2026);
    expect(r.months).toEqual([
      { month: "2026-04", capitalIntroduced: 0, drawings: 12_000, count: 2 },
      { month: "2026-06", capitalIntroduced: 20_000, drawings: 0, count: 1 },
    ]);
    expect(r.totals).toEqual({ capitalIntroduced: 20_000, drawings: 12_000 });
    expect(r.byPartner).toEqual([
      { partner: "Ravi", capitalIntroduced: 20_000, drawings: 5_000 },
      { partner: "Sita", capitalIntroduced: 0, drawings: 7_000 },
    ]);
  });
  it("CSV has the partner column for a firm and a total line", () => {
    const csv = drawingsRegisterCsv(movements, 2026, () => "HDFC", ownerEquityWords("partnership"));
    expect(csv.header).toEqual(["Date", "Type", "Partner", "Account", "Capital introduced (INR)", "Drawings (INR)", "Note"]);
    expect(csv.rows[0]).toEqual(["2026-04-05", "Partner drawings", "Ravi", "HDFC", "", 5_000, ""]);
    expect(csv.rows.at(-1)).toEqual(["Total", "FY 2026-27", "", "", 20_000, 12_000, ""]);
    expect(csv.rows).toHaveLength(4);
  });
  it("flags a hand-entered Drawings line that could count twice", () => {
    expect(looksLikeDrawingsLine("Drawings")).toBe(true);
    expect(looksLikeDrawingsLine("Owner's capital")).toBe(false);
  });
});

describe("R-1839 drawings never reach the P&L", () => {
  /* Drawings are equity. The P&L is built from report_pnl (invoices, bills, expenses,
     commissions, depreciation) and the pnl* helpers — none of them may read the drawings
     table. supabase/tests/r1839_owner_equity.test.sql proves report_pnl is unchanged after
     recording drawings; this keeps the app side honest. */
  const files = [
    ...readdirSync("src/lib/accounting").filter((f) => /^pnl.*\.ts$/.test(f) && !f.includes(".test.")).map((f) => `src/lib/accounting/${f}`),
    "src/lib/queries/pnl.ts",
  ];
  it("scans the P&L sources", () => { expect(files.length).toBeGreaterThan(1); });
  it.each(files)("%s does not read owner_equity_movements", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/owner_equity|owner-equity/);
  });
  it("no migration puts owner_equity_movements into report_pnl", () => {
    const hits = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))
      .filter((f) => { const s = readFileSync(`supabase/migrations/${f}`, "utf8"); return /function\s+public\.report_pnl\b/i.test(s) && /owner_equity/i.test(s); });
    expect(hits).toEqual([]);
  });
});
