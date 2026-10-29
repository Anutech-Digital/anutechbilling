/* R-2097 — the bank search box: an amount typed the way it is written ("2,950", "₹2,950",
   "₹ 2,950.00") finds the line, exactly as "2950" always did (staging reconcile, 29 Oct 2026:
   "2,950" found nothing). */
import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS, applyBankFilters, type BankFilters, type FilterLine } from "./bank-filters";

const line = (id: string, p: Partial<FilterLine>): FilterLine => ({
  id, txn_date: "2026-10-01", description: p.description ?? `LINE ${id}`, reference: p.reference ?? null,
  debit: p.debit ?? 0, credit: p.credit ?? 0, balance_after: null, matched_to_type: null,
});
const L = [
  line("in-2950", { credit: 2950, description: "NEFT FROM ACME" }),
  line("out-29500", { debit: 29500, description: "VENDOR PAY" }),
  line("in-1558", { credit: 1558.5, description: "UPI 9876" }),
  line("other", { credit: 410, description: "CHQ 2,950 RETURN" }),
];
const q = (s: string) => applyBankFilters(L, { ...DEFAULT_FILTERS, q: s } as BankFilters).map((r) => r.id).sort();

describe("R-2097 bank search amounts with commas / ₹", () => {
  it("'2950' (as before) finds the ₹2,950 line and the ₹29,500 line (substring)", () => {
    expect(q("2950")).toEqual(["in-2950", "out-29500"]);
  });
  it("'2,950', '₹2,950', '₹ 2,950', 'Rs 2950' match like '2950'", () => {
    for (const s of ["2,950", "₹2,950", "₹ 2,950", "Rs 2950", "rs. 2,950"]) {
      expect(q(s), s).toEqual(expect.arrayContaining(["in-2950", "out-29500"]));
    }
  });
  it("'2,950.00' finds exactly ₹2,950", () => {
    expect(q("2,950.00")).toContain("in-2950");
    expect(q("₹2,950.00")).not.toContain("out-29500");
  });
  it("paise: '1,558.50' finds ₹1,558.50", () => {
    expect(q("1,558.50")).toEqual(["in-1558"]);
  });
  it("text in the description still matches as typed (comma kept)", () => {
    expect(q("2,950")).toContain("other");
    expect(q("acme")).toEqual(["in-2950"]);
  });
});
