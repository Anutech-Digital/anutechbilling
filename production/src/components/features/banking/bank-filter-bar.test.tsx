// @vitest-environment jsdom
/* R-1869 — the bank page's filter row: In/Out chips with counts, removable chips + Clear all,
   the totals line, Export, and the coverage tile that replaced the negative "Balance in app". */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BankFilterBar } from "./bank-filter-bar";
import { ReconcileCoverageTile } from "./reconcile-coverage-tile";
import { DEFAULT_FILTERS, facetCounts, filterTotals, applyBankFilters, type BankFilters, type FilterLine } from "@/lib/banking/bank-filters";
import { reconcileCoverage } from "@/lib/banking/reconcile-coverage";

afterEach(cleanup);

const lines: FilterLine[] = [
  { id: "a", txn_date: "2026-09-30", description: "SALARY", reference: null, debit: 45000, credit: 0, balance_after: null, matched_to_type: "salary" },
  { id: "b", txn_date: "2026-09-12", description: "NEFT ACME", reference: null, debit: 0, credit: 118000, balance_after: null, matched_to_type: null },
  { id: "c", txn_date: "2026-09-21", description: "POS AMAZON", reference: null, debit: 1200, credit: 0, balance_after: null, matched_to_type: null },
];

function Harness({ initial = DEFAULT_FILTERS, onExport = () => {} }: { initial?: BankFilters; onExport?: () => void }) {
  const [f, setF] = React.useState(initial);
  const rows = applyBankFilters(lines, f);
  return (
    <>
      <BankFilterBar filters={f} onChange={setF} counts={facetCounts(lines, f)} totals={filterTotals(rows)}
        needs={["duplicates", "large"]} imports={[]} todayIso="2026-10-24" onExport={onExport} />
      <ul data-testid="rows">{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>
    </>
  );
}

const shown = () => screen.getByTestId("rows").textContent;

describe("BankFilterBar", () => {
  it("Money in / Money out chips carry counts and filter the list", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: /Money in\s*1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Money out\s*2/ }));
    expect(shown()).toBe("ac");
    expect(screen.getByRole("button", { name: /Money out/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("totals line for the current filter", () => {
    render(<Harness initial={{ ...DEFAULT_FILTERS, dir: "out" }} />);
    const text = screen.getByText(/lines?$/, { selector: "span" }).parentElement?.textContent ?? "";
    expect(text).toContain("2 lines");
    expect(text).toContain("In ₹0");
    expect(text).toContain("Out ₹46,200");
    expect(text).toContain("Net ₹-46,200");
  });

  it("active filters are removable chips; Clear all resets but keeps the sort", () => {
    render(<Harness initial={{ ...DEFAULT_FILTERS, dir: "out", min: 1000, q: "pos", sort: "high" }} />);
    expect(shown()).toBe("c");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Search: pos" }));
    expect(shown()).toBe("ac");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(shown()).toBe("bac"); // sort stays: amount high to low
    expect((screen.getByLabelText("Sort") as HTMLSelectElement).value).toBe("high");
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("the Filters button shows how many panel filters are on", () => {
    render(<Harness initial={{ ...DEFAULT_FILTERS, from: "2026-09-01", to: "2026-09-30", need: "large" }} />);
    expect(screen.getAllByRole("button", { name: "Filters (2)" }).length).toBeGreaterThan(0);
  });

  it("Export CSV is offered, and off when nothing matches", () => {
    const onExport = vi.fn();
    const { unmount } = render(<Harness onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(onExport).toHaveBeenCalledOnce();
    unmount();
    render(<Harness initial={{ ...DEFAULT_FILTERS, q: "nothing-like-this" }} />);
    expect((screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ReconcileCoverageTile — never a negative 'balance'", () => {
  it("shows reconciled of total, the percent bar and the gap", () => {
    const c = reconcileCoverage([
      { debit: 1_500_000, credit: 0, matched_to_type: "salary" },
      { debit: 0, credit: 2_600_000, matched_to_type: null },
    ]);
    const { container } = render(<ReconcileCoverageTile c={c} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Reconciled so far");
    expect(text).toContain("₹15,00,000 of ₹41,00,000");
    expect(text).toContain("₹26,00,000 still to reconcile (1 line)");
    expect(text).not.toMatch(/₹-/);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("36");
  });
  it("all done", () => {
    const c = reconcileCoverage([{ debit: 10, credit: 0, matched_to_type: "expense" }]);
    render(<ReconcileCoverageTile c={c} />);
    expect(screen.getByText("All 1 line reconciled ✓")).toBeTruthy();
  });
});
