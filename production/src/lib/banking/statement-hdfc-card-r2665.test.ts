/**
 * R-2665 — HDFC credit-card "Billed statements" .xls. Before: "Couldn't parse" — the header
 * "Debit / Credit" (the side FLAG) was taken for the Debit amount column, AMT was never read and
 * every line was skipped. Synthetic file only (lib/testing/fixtures/hdfc-card-statement.ts).
 */
import { describe, expect, it } from "vitest";

import { excelToRows } from "./statement-xlsx";
import { parseStatement, parseStatementRows, rowsToCsv } from "./statement-parse";
import { checkPreview } from "./statement-verify";
import { hdfcCardXls, type CardLine } from "@/lib/testing/fixtures/hdfc-card-statement";

const card = async (lines?: CardLine[]) => parseStatementRows(await excelToRows(hdfcCardXls(lines)));
const line = (when: string, amt: string, flag: string, desc = "TEST MERCHANT"): CardLine =>
  ({ type: "Domestic", when, desc, amt, flag });

describe("R-2665 HDFC credit-card billed statement (.xls)", () => {
  it("reads every line of the card statement — the owner's real path (was: Couldn't parse)", async () => {
    const res = await card();
    expect(res.rows.map((r) => [r.txn_date, r.debit, r.credit])).toEqual([
      ["2026-02-03", 0, 200352],
      ["2026-02-03", 1794, 0],
      ["2026-02-05", 0, 2],
      ["2026-02-13", 1, 0],
      ["2026-01-21", 135324, 0],
      ["2026-01-22", 853, 0],
      ["2026-02-14", 0, 4012],
    ]);
    expect(res.skipped).toBe(0);
    expect(res.warnings.filter((w) => /auto-detect/i.test(w))).toEqual([]);
  });

  it("flag decides the side: '' = spend (HDFC), Cr / CR / C / Credit = money in", async () => {
    const res = await card([
      line("01/02/2026 / 10:00", "100.00", ""),
      line("01/02/2026 / 10:01", "200.00", "Cr"),
      line("01/02/2026 / 10:02", "300.00", "CR"),
      line("01/02/2026 / 10:03", "400.00", "C"),
      line("01/02/2026 / 10:04", "500.00", "Credit"),
    ]);
    expect(res.rows.map((r) => [r.debit, r.credit])).toEqual([[100, 0], [0, 200], [0, 300], [0, 400], [0, 500]]);
  });

  it("a file that writes Dr itself: Dr / Debit = out, and a BLANK flag is not guessed", async () => {
    const res = await card([
      line("01/02/2026 / 10:00", "600.00", "Dr"),
      line("01/02/2026 / 10:01", "700.00", "Debit"),
      line("01/02/2026 / 10:02", "200.00", "Cr"),
      line("01/02/2026 / 10:03", "999.00", ""),
    ]);
    expect(res.rows.map((r) => [r.debit, r.credit])).toEqual([[600, 0], [700, 0], [0, 200]]);
    expect(res.skipped).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/1 line was skipped.*nothing \(blank\)/);
  });

  it("unknown flag: the line is skipped and counted, never guessed", async () => {
    const res = await card([line("01/02/2026 / 10:00", "100.00", "Cr"), line("02/02/2026 / 10:00", "250.00", "XYZ")]);
    expect(res.rows).toHaveLength(1);
    expect(res.skipped).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/1 line.*Debit \/ Credit.*XYZ/);
  });

  it("paise kept by the R-2528 rule; AMT 0 / blank skipped", async () => {
    const res = await card([
      line("01/02/2026 / 10:00", "2,00,351.57", "Cr"),
      line("01/02/2026 / 11:00", "0.56", ""),
      line("01/02/2026 / 12:00", "0.00", ""),
      line("01/02/2026 / 13:00", "", "Cr"),
    ]);
    expect(res.rows).toEqual([
      expect.objectContaining({ credit: 200352, debit: 0, amount_paise: 20035157 }),
      expect.objectContaining({ debit: 1, credit: 0, amount_paise: 56 }),
    ]);
    expect(res.skipped).toBe(2);
  });

  it("negative AMT follows the reversal rule (R-2495) — opposite side, never dropped", async () => {
    const res = await card([line("01/02/2026 / 10:00", "-2,000.00", "")]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ debit: 0, credit: 2000 });
    expect(res.rows[0].reversal ?? res.rows[0].checkSign).toBe(true);
  });

  it("date + time cell split: the date part only, day first; time dropped", async () => {
    const res = await card([line("03/04/2025 / 16:50", "10.00", ""), line("31/12/2025 / 23:59", "20.00", "")]);
    expect(res.rows.map((r) => r.txn_date)).toEqual(["2025-04-03", "2025-12-31"]);
  });

  it("summary rows after the table are not lines (GST '0' cell is not a date of 2000)", async () => {
    const res = await card();
    expect(res.rows.some((r) => r.txn_date < "2025-01-01")).toBe(false);
    expect(res.rows).toHaveLength(7);
  });

  it("no balance column → no balance invented; the chain check says it did not run", async () => {
    const res = await card();
    expect(res.rows.every((r) => r.balance_after === null && r.balance_paise === undefined)).toBe(true);
    expect(checkPreview(res.rows).ran).toBe(false);
  });

  it("the CSV of the same sheet reads the same (one parser for CSV and Excel)", async () => {
    const rows = await excelToRows(hdfcCardXls());
    expect(parseStatement(rowsToCsv(rows))).toEqual(parseStatementRows(rows));
  });

  it("other flag files: text dates read, 'AMT (INR)' header, a stray 'Credit Limit' column ignored", () => {
    const res = parseStatement([
      "Date,Description,Credit Limit,AMT (INR),Dr/Cr",
      "03 Feb 2026,SHOP,500000,1000.00,Dr",
      "05-Feb-2026,REFUND,500000,250.00,Cr",
    ].join("\n"));
    expect(res.rows.map((r) => [r.txn_date, r.debit, r.credit])).toEqual([["2026-02-03", 1000, 0], ["2026-02-05", 0, 250]]);
  });

  it("a balance with its own Dr / Cr column keeps its sign (Dr = owed, below 0)", () => {
    const res = parseStatement([
      "Date,Description,Amount,Dr/Cr,Balance,Dr/Cr",
      "01/02/2026,SHOP,1000.00,Dr,12000.00,Dr",
      "02/02/2026,PAYMENT,15000.00,Cr,3000.00,Cr",
    ].join("\n"));
    expect(res.rows.map((r) => [r.debit, r.credit, r.balance_after])).toEqual([[1000, 0, -12000], [0, 15000, 3000]]);
    expect(checkPreview(res.rows).gaps).toEqual([]);
  });

  it("a bare number in the date column is never a date (was: a footer '0' became a line of 2000)", () => {
    const res = parseStatement([
      "Date,Narration,Debit,Credit,Balance",
      "01/02/2026,ATM,500,,9500",
      "0,TOTAL,500,0,",
    ].join("\n"));
    expect(res.rows.map((r) => r.txn_date)).toEqual(["2026-02-01"]);
    expect(res.skipped).toBe(1);
  });

  it("a bank file with real Debit and Credit columns is NOT read as a flag layout", () => {
    const res = parseStatement([
      "Date,Narration,Debit,Credit,Balance",
      "01/02/2026,ATM,500,,9500",
      "02/02/2026,SALARY,,1000,10500",
    ].join("\n"));
    expect(res.rows.map((r) => [r.debit, r.credit, r.balance_after])).toEqual([[500, 0, 9500], [0, 1000, 10500]]);
  });
});
