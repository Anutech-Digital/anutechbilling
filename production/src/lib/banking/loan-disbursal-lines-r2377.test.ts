/* R-2377 — Business Loans → "Add loan": which imported money-in lines can be the loan money.
   Owner example (OD audit 2 Nov): ₹40,00,000 from Bajaj Finance, imported as
   "FT 0606 BAJAJ FINANCE LTD LOAN DISB" on 6 Jun 2026; Add loan typed with "Taken on" 4 Jun. */
import { describe, expect, it } from "vitest";
import { businessLoanCandidates, lenderInNarration, takenOnWindow, type MoneyInLine } from "./loan-disbursal-lines";

const line = (id: string, txn_date: string, credit: number, description: string, extra: Partial<MoneyInLine> = {}): MoneyInLine =>
  ({ id, txn_date, credit, debit: 0, description, matched_to_type: null, ...extra });

const bajaj = line("b1", "2026-06-06", 4000000, "FT 0606 BAJAJ FINANCE LTD LOAN DISB");

describe("R-2377 — takenOnWindow", () => {
  it("is ±15 days around Taken on", () => {
    expect(takenOnWindow("2026-06-04")).toEqual({ anchor: "2026-06-04", from: "2026-05-20", to: "2026-06-19" });
  });
  it("is null without a date", () => {
    expect(takenOnWindow("")).toBeNull();
    expect(takenOnWindow(null)).toBeNull();
    expect(takenOnWindow("not-a-date")).toBeNull();
  });
});

describe("R-2377 — lenderInNarration", () => {
  it("finds the lender's own word, not the generic ones", () => {
    expect(lenderInNarration(bajaj.description, "Bajaj Finance")).toBe(true);
    expect(lenderInNarration("NEFT CR HDFC BANK LTD", "Bajaj Finance")).toBe(false);
    expect(lenderInNarration("NEFT CR ICICI FINANCE", "Bajaj Finance")).toBe(false);   // "finance" alone is not a match
    expect(lenderInNarration("NEFT CR HDFC BANK LTD", "HDFC Bank")).toBe(true);
    expect(lenderInNarration("NEFT CR XYZ", "Bank")).toBe(false);
    expect(lenderInNarration(null, "Bajaj Finance")).toBe(false);
  });
});

describe("R-2377 — businessLoanCandidates", () => {
  const lines = [
    line("near", "2026-06-04", 4000000, "NEFT CR SOMEONE"),          // nearest date, no lender name
    bajaj,
    line("rounded", "2026-06-10", 4000001, "RTGS CR XYZ"),             // ₹1 rounding is fine
    line("off2", "2026-06-05", 4000002, "NEFT CR BAJAJ"),              // ₹2 off
    line("late", "2026-06-20", 4000000, "NEFT CR BAJAJ"),              // 16 days after
    line("early", "2026-05-19", 4000000, "NEFT CR BAJAJ"),             // 16 days before
    line("done", "2026-06-06", 4000000, "BAJAJ", { matched_to_type: "payment" }),
    line("out", "2026-06-06", 0, "BAJAJ DR", { debit: 4000000 }),
  ];

  it("offers the Bajaj line first (names the lender), then the others in the window by nearest date", () => {
    expect(businessLoanCandidates(lines, 4000000, "2026-06-04", "Bajaj Finance").map((l) => l.id)).toEqual(["b1", "near", "rounded"]);
  });
  it("without a lender name, nearest date first", () => {
    expect(businessLoanCandidates(lines, 4000000, "2026-06-04", "").map((l) => l.id)).toEqual(["near", "b1", "rounded"]);
  });
  it("nothing when the amount or date is missing", () => {
    expect(businessLoanCandidates(lines, 0, "2026-06-04", "Bajaj Finance")).toEqual([]);
    expect(businessLoanCandidates(lines, 4000000, "", "Bajaj Finance")).toEqual([]);
  });
  it("nothing when no line matches — a new line is then the only way", () => {
    expect(businessLoanCandidates(lines, 1000000, "2026-06-04", "HDFC Bank")).toEqual([]);
  });
});
