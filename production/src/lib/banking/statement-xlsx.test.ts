/**
 * R-1512 — bank statement Excel upload. Synthetic HDFC-like workbooks (15 info rows, then the
 * real header) are built here with SheetJS, written as .xlsx and as old .xls (BIFF8), read
 * back through excelToRows → the SAME parse as the CSV path, and must give the CSV result.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { excelToRows, isExcelFile } from "./statement-xlsx";
import { parseStatement, parseStatementRows, rowsToCsv } from "./statement-parse";

const HEADER = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"];

/** Excel serial (days since 1899-12-30) of a calendar date. */
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;

function hdfcWorkbook(): XLSX.WorkBook {
  const info: (string | number)[][] = [
    ["HDFC BANK Ltd."],
    ["Page No .: 1"],
    ["ANUTECH DIGITAL PVT LTD"],
    ["SCO 12, SECTOR 9"],
    ["CHANDIGARH"],
    ["PUNJAB 160009"],
    ["Account Branch : CHANDIGARH"],
    ["Account No : 50200012345678"],
    ["Currency : INR"],
    ["Email : accounts@example.test"],
    ["Cust ID : 12345678"],
    ["A/C Open Date : 01/04/20"],
    ["Account Status : Regular"],
    ["Statement From : 01/04/26 To : 30/04/26"],
    ["Opening Balance : 1,00,000.00"],
  ];
  const aoa: (string | number)[][] = [
    ...info,
    HEADER,
    ["********", "********", "********", "********", "********", "********", "********"],
    ["01/04/26", "PLACEHOLDER-SERIAL", "0000412345", "01/04/26", 0, 25000, 125000],
    ["03/04/26", "UPI-RAZORPAY-ACME, PUNE", "UPI0099", "03/04/26", "1,250.40", "", "1,23,749.60"],
    ["05/04/26", "NEFT-GOOGLE CLOUD", "N123456", "05/04/26", 18500, 0, 105249.6],
    ["", "", "", "", "", "", ""],
    ["STATEMENT SUMMARY :-"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Row 18 (index 17): the date cell as a real Excel date — serial + date format.
  ws["A18"] = { t: "n", v: serial(2026, 4, 1), z: "dd/mm/yy" };
  ws["B18"] = { t: "s", v: "IMPS-CUSTOMER PAYMENT" };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  return wb;
}

/** What the same statement looks like when downloaded as CSV ("Delimited"). */
const CSV = [
  ...Array.from({ length: 15 }, (_, i) => `Info line ${i + 1}`),
  HEADER.join(","),
  "********,********,********,********,********,********,********",
  "01/04/26,IMPS-CUSTOMER PAYMENT,0000412345,01/04/26,0,25000,125000",
  '03/04/26,"UPI-RAZORPAY-ACME, PUNE",UPI0099,03/04/26,"1,250.40",,"1,23,749.60"',
  "05/04/26,NEFT-GOOGLE CLOUD,N123456,05/04/26,18500,0,105249.6",
  "STATEMENT SUMMARY :-",
].join("\n");

const toBytes = (wb: XLSX.WorkBook, bookType: "xlsx" | "biff8") =>
  XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;

describe("R-1512 statement Excel → same lines as the CSV path", () => {
  const expected = parseStatement(CSV);

  it("the CSV path itself reads the three lines (whole rupees)", () => {
    expect(expected.rows).toEqual([
      { txn_date: "2026-04-01", description: "IMPS-CUSTOMER PAYMENT", debit: 0, credit: 25000, balance_after: 125000, reference: "0000412345" },
      { txn_date: "2026-04-03", description: "UPI-RAZORPAY-ACME, PUNE", debit: 1250, credit: 0, balance_after: 123750, reference: "UPI0099" },
      { txn_date: "2026-04-05", description: "NEFT-GOOGLE CLOUD", debit: 18500, credit: 0, balance_after: 105250, reference: "N123456" },
    ]);
  });

  for (const bookType of ["xlsx", "biff8"] as const) {
    it(`${bookType === "xlsx" ? ".xlsx" : ".xls"}: skips 15 info rows, serial date → 2026-04-01, rows match CSV`, async () => {
      const rows = await excelToRows(toBytes(hdfcWorkbook(), bookType));
      expect(rows[15]).toEqual(HEADER);
      expect(rows[17][0]).toBe("2026-04-01");
      expect(parseStatementRows(rows).rows).toEqual(expected.rows);
      // The dialog puts the rows in the textarea as CSV — that round trip is lossless too.
      expect(parseStatement(rowsToCsv(rows)).rows).toEqual(expected.rows);
    });
  }

  it("a serial date is the same calendar day whatever the time zone (no JS Date)", async () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        const rows = await excelToRows(toBytes(hdfcWorkbook(), "xlsx"));
        expect(rows[17][0]).toBe("2026-04-01");
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it("empty workbook → no rows, parse says Empty file", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "S");
    const rows = await excelToRows(toBytes(wb, "xlsx"));
    expect(rows).toEqual([]);
    expect(parseStatementRows(rows).warnings).toEqual(["Empty file"]);
  });

  it("isExcelFile by extension or MIME", () => {
    expect(isExcelFile({ name: "Acct_Statement.XLS", type: "" })).toBe(true);
    expect(isExcelFile({ name: "stmt.xlsx", type: "" })).toBe(true);
    expect(isExcelFile({ name: "blob", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(true);
    expect(isExcelFile({ name: "stmt.csv", type: "text/csv" })).toBe(false);
    expect(isExcelFile({ name: "stmt.pdf", type: "application/pdf" })).toBe(false);
  });

  it("SheetJS stays lazy: no static value import of xlsx in the dialog or the reader", () => {
    const root = path.resolve(__dirname, "../../..");
    for (const f of ["src/components/features/banking/import-statement-dialog.tsx", "src/lib/banking/statement-xlsx.ts"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']xlsx["']/m);
    }
  });
});
