import { describe, it, expect } from "vitest";
import { parseStatement } from "./statement-parse";

const dates = (csv: string) => parseStatement(csv).rows.map((r) => r.txn_date);
const file = (...d: string[]) =>
  ["Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance", ...d.map((x, i) => `${x},Line ${i},100,,${1000 - i * 100}`)].join("\n");

describe("parseStatement dates (R-1890)", () => {
  it("ISO YYYY-MM-DD is kept exactly, future or not", () => {
    expect(dates(file("2026-10-20", "2026-11-05"))).toEqual(["2026-10-20", "2026-11-05"]);
  });

  it("Indian DD/MM is the default when every line is ambiguous", () => {
    expect(dates(file("05/11/2026", "06/11/2026"))).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("DD/MM when some line has a first part over 12", () => {
    expect(dates(file("25/10/2026", "05/11/2026"))).toEqual(["2026-10-25", "2026-11-05"]);
  });

  it("MM/DD for the WHOLE file when some line has a second part over 12", () => {
    // 11/05 alone would read as 11 May; the 10/25 line proves the file is month-first.
    expect(dates(file("10/25/2026", "11/05/2026"))).toEqual(["2026-10-25", "2026-11-05"]);
    const r = parseStatement(file("10/25/2026", "11/05/2026"));
    expect(r.warnings.join(" ")).toMatch(/month first/i);
  });

  it("HDFC DD/MM/YY and SBI DD-MM-YYYY past dates are unchanged", () => {
    expect(dates(file("03/08/26", "21/08/26"))).toEqual(["2026-08-03", "2026-08-21"]);
    expect(dates(file("03-08-2026", "21-08-2026"))).toEqual(["2026-08-03", "2026-08-21"]);
  });

  it("ICICI '28 Sep 2026' style still reads", () => {
    expect(dates(file("28 Sep 2026"))).toEqual(["2026-09-28"]);
  });
});
