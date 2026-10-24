/**
 * S17 mapper ke guards — DB ke bina. Asli numbers ka milaan tests/parity/reports-parity.test.ts
 * aur supabase/tests/report_functions.test.sql me hai; yahan sirf wo raaste jahan galti
 * "0" ya khaali report ban kar chhup sakti thi (AGENTS.md §2).
 */
import { describe, it, expect } from "vitest";
import { rpcRowOrThrow, rpcValueOrThrow } from "./report-rpc";
import { buildLedger, buildLedgerFromWindow, fyPeriod, type LedgerEntry } from "./ledger";

const FY26 = fyPeriod(2026);
const e = (date: string, amount: number, up = true, reference = `R-${date}`): LedgerEntry =>
  ({ date, amount, increasesLiability: up, reference, voucher: up ? "Sales" : "Receipt", narration: null });

describe("rpcRowOrThrow / rpcValueOrThrow", () => {
  it("names the missing migration instead of rendering an empty report", () => {
    expect(() => rpcRowOrThrow({ data: null, error: { code: "PGRST202", message: "not found" } }, "report_pnl"))
      .toThrow(/report_pnl.*migration/);
    expect(() => rpcValueOrThrow({ data: null, error: { code: "42883", message: "x" } }, "report_ledger_vendors"))
      .toThrow(/report_ledger_vendors/);
  });

  it("passes other database errors through unchanged", () => {
    expect(() => rpcRowOrThrow({ data: null, error: { code: "42501", message: "Balance sheet nahi ban sakti" } }, "report_balance_sheet"))
      .toThrow("Balance sheet nahi ban sakti");
  });

  it("an empty answer is an error, not a row of zeros", () => {
    expect(() => rpcRowOrThrow({ data: [], error: null }, "report_pnl")).toThrow(/returned no row/);
    expect(() => rpcValueOrThrow({ data: null, error: null }, "report_party_ledger")).toThrow(/returned nothing/);
  });

  it("takes the first row of a RETURNS TABLE, and a jsonb array whole", () => {
    expect(rpcRowOrThrow<{ a: number }>({ data: [{ a: 1 }], error: null }, "f")).toEqual({ a: 1 });
    expect(rpcValueOrThrow<number[]>({ data: [1, 2], error: null }, "f")).toEqual([1, 2]);
  });
});

describe("buildLedgerFromWindow", () => {
  it("equals buildLedger when handed the SQL-style opening + window", () => {
    const all = [e("2026-03-15", 11800), e("2026-05-10", 5000), e("2026-06-01", 3000, false)];
    const opening = 11800;
    const window = all.slice(1);
    expect(buildLedgerFromWindow("customer", opening, window, FY26)).toEqual(buildLedger("customer", all, FY26));
  });

  it("refuses an entry outside the window rather than folding it into the closing", () => {
    expect(() => buildLedgerFromWindow("customer", 0, [e("2026-03-31", 100)], FY26)).toThrow(/outside/);
    expect(() => buildLedgerFromWindow("customer", 0, [e("2027-04-01", 100)], FY26)).toThrow(/outside/);
  });

  it("refuses a fractional opening (paise leaking in)", () => {
    expect(() => buildLedgerFromWindow("vendor", 10.5, [], FY26)).toThrow(/whole number/);
  });
});
