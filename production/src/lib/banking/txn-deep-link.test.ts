/* R-1895 — the bank page opened with ?txn=<id> must SHOW that line: even when it is an older
   month past the first page, or hidden by the filters the page opened with. */
import { describe, expect, it } from "vitest";
import { revealTxn } from "./txn-deep-link";
import { DEFAULT_FILTERS, PAGE_SIZE, applyBankFilters, type FilterLine } from "./bank-filters";

/* 250 newer lines (Oct 2026), then the Apr salary paid on 21 May 2026 — newest-first it is #251. */
const newer: FilterLine[] = Array.from({ length: 250 }, (_, i) => ({
  id: `n${i}`, txn_date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, description: "UPI", reference: null,
  debit: 100 + i, credit: 0, balance_after: null, matched_to_type: null,
}));
const salary: FilterLine = {
  id: "txn-21may", txn_date: "2026-05-21", description: "NEFT SAJAN SINGH NEGI SALARY APR", reference: null,
  debit: 105000, credit: 0, balance_after: null, matched_to_type: "salary",
};
const lines = [...newer, salary];

describe("R-1895 revealTxn", () => {
  it("an older-month line past page 1: keeps the filters, draws enough pages to include it", () => {
    const r = revealTxn(lines, DEFAULT_FILTERS, {}, "txn-21may");
    expect(r).not.toBeNull();
    expect(r!.filters).toEqual(DEFAULT_FILTERS);
    const visible = applyBankFilters(lines, r!.filters);
    const idx = visible.findIndex((t) => t.id === "txn-21may");
    expect(idx).toBeGreaterThanOrEqual(PAGE_SIZE);
    expect(r!.shownCount).toBeGreaterThan(idx);
    expect(r!.shownCount % PAGE_SIZE).toBe(0);
  });

  it("hidden by the opening filters (Unmatched, this month): clears them so the line shows", () => {
    const opened = { ...DEFAULT_FILTERS, status: "unmatched" as const, from: "2026-10-01", to: "2026-10-31", sort: "oldest" as const };
    const r = revealTxn(lines, opened, {}, "txn-21may")!;
    expect(r.filters.status).toBe("all");
    expect(r.filters.from).toBeNull();
    expect(r.filters.sort).toBe("oldest"); // sort is not a filter — kept
    const visible = applyBankFilters(lines, r.filters).slice(0, r.shownCount);
    expect(visible.some((t) => t.id === "txn-21may")).toBe(true);
  });

  it("a line not in this account → null (the page says so)", () => {
    expect(revealTxn(lines, DEFAULT_FILTERS, {}, "nope")).toBeNull();
  });
});
