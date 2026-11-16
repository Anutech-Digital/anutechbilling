/**
 * R-2665 — a SYNTHETIC HDFC credit-card "Billed statements" workbook (.xls), same layout as the
 * bank's download (10 Nov 2026), every name and figure made up. Never put a real statement here.
 *
 * The layout: 25 columns; customer + summary block at the top; the transaction table header
 *   Transaction type (A) · Primary / Addon Customer Name (E) · Date & Time (J) · Description (M)
 *   · REWARDS (S) · AMT (U) · Debit / Credit (X)
 * Date & Time is ONE text cell ("03/04/2025 / 16:50"), AMT is text with Indian commas, and the
 * flag is "" for a spend and "Cr" for a payment / refund. There is NO running balance. Domestic
 * lines come first and International lines after them, each block in date order — so the dates
 * jump back where the second block starts. Reward-points and GST summary blocks follow.
 */
import * as XLSX from "xlsx";

export const HDFC_CARD_COLUMNS = 25;
const COL = { type: 0, name: 4, date: 9, desc: 12, rewards: 18, amt: 20, flag: 23 } as const;

export type CardLine = { type: "Domestic" | "International"; when: string; desc: string; amt: string; flag: "" | "Cr" | string };

/** The made-up statement: Domestic block (sorted), then International block (sorted, earlier dates). */
export const HDFC_CARD_LINES: CardLine[] = [
  { type: "Domestic",      when: "03/02/2026 / 08:06", desc: "AUTOPAY THANK YOU  (Ref# ST000000000000000000001)", amt: "2,00,351.57", flag: "Cr" },
  { type: "Domestic",      when: "03/02/2026 / 16:50", desc: "TESTCLOUD SERVICES MUMBAI ",                     amt: "1,793.53",    flag: "" },
  { type: "Domestic",      when: "05/02/2026 / 00:00", desc: "TESTCLOUD SERVICES MUMBAI ",                     amt: "2.00",        flag: "Cr" },
  { type: "Domestic",      when: "13/02/2026 / 11:15", desc: "FAKE FUEL STATION DELHI",                        amt: "0.56",        flag: "" },
  { type: "International", when: "21/01/2026 / 21:40", desc: "EXAMPLE SAAS INC SAN FRANCISCO",                 amt: "1,35,324.19", flag: "" },
  { type: "International", when: "22/01/2026 / 02:05", desc: "DCC MARKUP FEE",                                 amt: "852.54",      flag: "" },
  { type: "International", when: "14/02/2026 / 09:30", desc: "EXAMPLE SAAS INC REFUND",                        amt: "4,011.66",    flag: "Cr" },
];

function put(ws: XLSX.WorkSheet, r: number, c: number, v: string) {
  ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v };
}

/** The workbook as SheetJS objects (every cell text, as HDFC writes it). */
export function hdfcCardWorkbook(lines: readonly CardLine[] = HDFC_CARD_LINES): XLSX.WorkBook {
  const ws: XLSX.WorkSheet = {};
  let r = 0;
  const info: [string, string][] = [
    ["Name", "TEST CARDHOLDER"],
    ["Address", "1 EXAMPLE ROAD"],
    ["Address", "TESTNAGAR-000000"],
    ["CKYC ID", ""],
    ["Customer GSTN", "0"],
    ["Payment Due Date", "05 Mar, 2026"],
    ["Statement Date", "15 Feb, 2026"],
    ["Total Amount Due", "1,37,970.19"],
    ["Minimum Amount Due", "6,900.00"],
    ["Credit Limit", "5,00,000"],
    ["Available Limit", "3,62,029"],
    ["Available Cash Limit", "1,00,000"],
  ];
  for (const [k, v] of info) { put(ws, r, 0, k); put(ws, r, 4, v); r++; }
  put(ws, 2, 14, "Credit Card No.: 000000XXXXXX0000");
  r++;
  put(ws, r++, 0, "Account Summary");
  ["Opening Bal", "-", "Payment / Credit", "+", "Purchases / Debits", "+", "Finance Charges", "=", "Total Dues"]
    .forEach((h, i) => put(ws, r, i * 3, h));
  r++;
  ["2,00,351.57", "", "2,04,365.23", "", "1,37,972.82", "", "0.00", "", "1,37,970.19"].forEach((v, i) => put(ws, r, i * 3, v));
  r += 3;
  put(ws, r, COL.type, "Transaction type");
  put(ws, r, COL.name, "Primary / Addon Customer Name");
  put(ws, r, COL.date, "Date & Time");
  put(ws, r, COL.desc, "Description");
  put(ws, r, COL.rewards, "REWARDS");
  put(ws, r, COL.amt, "AMT");
  put(ws, r, COL.flag, "Debit / Credit");
  r++;
  for (const l of lines) {
    put(ws, r, COL.type, l.type);
    put(ws, r, COL.name, "TEST CARDHOLDER       ");
    put(ws, r, COL.date, l.when);
    put(ws, r, COL.desc, l.desc);
    put(ws, r, COL.rewards, "");
    put(ws, r, COL.amt, l.amt);
    put(ws, r, COL.flag, l.flag);
    r++;
  }
  r++;
  put(ws, r++, 0, "Reward Points Summary");
  ["Opening Balance", "Earned", "Disbursed", "Adjusted/Lapsed", "Reward Points"].forEach((h, i) => put(ws, r, [0, 5, 9, 12, 16][i], h));
  r++;
  ["1,000", "18", "0", "310", "708"].forEach((v, i) => put(ws, r, [0, 5, 9, 12, 16][i], v));
  r += 2;
  put(ws, r++, 0, "GST Summary");
  ["IGST", "CGST", "SGST", "Reversal", "Total"].forEach((h, i) => put(ws, r, i * 5, h));
  r++;
  ["0", "0", "0", "0", "0"].forEach((v, i) => put(ws, r, [0, 5, 9, 15, 20][i], v));
  r += 2;
  put(ws, r, 0, "*GST levied on statement date is always billed in the subsequent statement.");
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c: HDFC_CARD_COLUMNS - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  return wb;
}

/** The workbook written as an old Excel .xls (BIFF8) file, as HDFC's download is. */
export function hdfcCardXls(lines?: readonly CardLine[]): Uint8Array {
  return new Uint8Array(XLSX.write(hdfcCardWorkbook(lines), { type: "array", bookType: "biff8" }) as ArrayBuffer);
}
