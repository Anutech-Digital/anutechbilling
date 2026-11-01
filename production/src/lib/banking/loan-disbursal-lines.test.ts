/* R-2341 — which imported money-in lines can be a loan's money (Set up this loan → "came into"). */
import { describe, expect, it } from "vitest";
import { disbursalCandidates, disbursalWindow, type MoneyInLine } from "./loan-disbursal-lines";

const line = (id: string, txn_date: string, credit: number, extra: Partial<MoneyInLine> = {}): MoneyInLine =>
  ({ id, txn_date, credit, debit: 0, description: "NEFT CR", matched_to_type: null, ...extra });

describe("R-2341 — disbursalWindow", () => {
  it("no Received on: one month before the first EMI, ±15 days, never after the first EMI", () => {
    expect(disbursalWindow("", "2026-10-05")).toEqual({ anchor: "2026-09-05", from: "2026-08-21", to: "2026-09-20" });
    expect(disbursalWindow(null, "2026-03-31")?.anchor).toBe("2026-02-28");
    expect(disbursalWindow(null, "2026-01-10")?.anchor).toBe("2025-12-10");
  });
  it("Received on typed: around that date, capped at the first EMI", () => {
    expect(disbursalWindow("2026-09-28", "2026-10-05")).toEqual({ anchor: "2026-09-28", from: "2026-09-13", to: "2026-10-05" });
  });
  it("no first EMI date: nothing to look in", () => {
    expect(disbursalWindow(null, "")).toBeNull();
  });
});

describe("R-2341 — disbursalCandidates (bike loan ₹2,50,000, first EMI 5 Oct 2026)", () => {
  const w = disbursalWindow(null, "2026-10-05");
  const lines = [
    line("far", "2026-08-10", 250000),                              // 26 days before the anchor
    line("ok-near", "2026-09-04", 250000),                          // 1 day from 5 Sep
    line("ok-rupee", "2026-09-12", 249999),                         // ₹1 short — rounding
    line("two-off", "2026-09-05", 250002),                          // ₹2 off
    line("matched", "2026-09-05", 250000, { matched_to_type: "payment" }),
    line("out", "2026-09-05", 0, { debit: 250000, credit: 0 }),     // money out
  ];
  it("only unmatched money-in lines for the amount (±₹1) within 15 days, nearest first", () => {
    expect(disbursalCandidates(lines, 250000, w).map((l) => l.id)).toEqual(["ok-near", "ok-rupee"]);
  });
  it("no amount typed yet: nothing listed", () => {
    expect(disbursalCandidates(lines, NaN, w)).toEqual([]);
    expect(disbursalCandidates(lines, 0, w)).toEqual([]);
  });
});
