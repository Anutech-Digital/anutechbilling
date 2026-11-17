/**
 * R-1855 — the Schedule III view as the CA sees it: statutory headings in order, totals equal the
 * Balance Sheet, the Unmapped line is visible, the previous period says n/a, and the CSV button
 * hands over the same rows.
 */
// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";
import { balanceSheetTotals } from "@/lib/accounting/balance-sheet-totals";
import { equitySection } from "@/lib/accounting/equity-section";
import { loansAdvancesSplit, loanSplitLines } from "@/lib/accounting/loans-current-split";

const downloads: { name: string; headers: string[]; rows: (string | number)[][] }[] = [];
vi.mock("@/lib/csv", () => ({ downloadCSV: (name: string, headers: string[], rows: (string | number)[][]) => downloads.push({ name, headers, rows }) }));
vi.mock("@/lib/reports/print", () => ({ printReport: vi.fn() }));
vi.mock("@/lib/queries/day-book", () => ({ useMsmePayables: () => ({ data: [{ amount_due: 30_000 }], isLoading: false }) }));

import { ScheduleIIIView } from "./schedule-iii-view";

const AUTO = {
  cashAndBank: 400_000, undepositedFunds: 0, receivables: 150_000, advancesFromCustomers: 0, projectReceivable: 0, tdsReceivable: 0,
  employeeLoans: 0, loansGiven: 0, prepaidAdvances: 0, fixedAssets: 100_000, payables: 90_000, salaryPayable: 0, salaryDuesPayable: 0,
  reimbursementsPayable: 0, creditCardPayable: 0, emiLoansPayable: 0, businessLoansPayable: 200_000, gstPayable: 0, gstPaid: 0,
  advanceTaxPaid: 0, expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0, fyLabel: "FY 2026-27",
} as BalanceSheetAuto;
const ITEMS = [
  { id: "a", section: "equity" as const, label: "Equity share capital", amount: 100_000, sort_order: 0, notes: null },
  { id: "b", section: "asset" as const, label: "Rent deposit", amount: 10_000, sort_order: 0, notes: null },
];

function setup() {
  const t = balanceSheetTotals(AUTO, ITEMS);
  const equity = equitySection({ businessType: "pvt_ltd", manualLines: [ITEMS[0]], opening: null, profit: 150_000, totals: { capitalIntroduced: 0, drawings: 0 } as never });
  const unexplained = t.netWorth - 100_000 - 150_000;
  const input = {
    auto: AUTO, gstCredit: 0, gstPayable: 0, licenceProvision: 0, loanLines: loanSplitLines(loansAdvancesSplit(AUTO)),
    advanceSplit: { employee: 0, vendor: 0 }, loansTaken: { fromDirectors: 0, others: 200_000 },
    manualAssets: [ITEMS[1]], manualLiabilities: [], equity, openingBalanceAdjustments: 0, unexplained,
  };
  return { t, input };
}

beforeEach(() => { downloads.length = 0; });
afterEach(cleanup);

describe("ScheduleIIIView", () => {
  it("shows the statutory headings in order, ties to the sheet, flags the unmapped line", () => {
    const { t, input } = setup();
    const { container } = render(<ScheduleIIIView input={input} asOf="2026-11-17" sheet={t} />);
    const text = container.textContent ?? "";
    const order = ["I. EQUITY AND LIABILITIES", "Shareholders' funds", "Share capital", "Reserves and surplus", "Non-current liabilities", "Long-term borrowings",
      "Current liabilities", "Trade payables", "II. ASSETS", "Non-current assets", "Property, Plant and Equipment", "Current assets", "Trade receivables", "Cash and cash equivalents"];
    let at = -1;
    for (const h of order) { const i = text.indexOf(h, at + 1); expect(i, h).toBeGreaterThan(at); at = i; }
    expect(screen.queryByText(/does not tie/i)).toBeNull();
    expect(screen.getAllByText("Unmapped — please classify").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 hand-entered line is/)).toBeTruthy();
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(5);        // previous period, never invented
    expect(container.querySelector("th")?.textContent).toBeTruthy();
  });

  it("splits MSME dues from other trade payables", () => {
    const { t, input } = setup();
    const { container } = render(<ScheduleIIIView input={input} asOf="2026-11-17" sheet={t} />);
    const rows = [...container.querySelectorAll("tr")].map((r) => r.textContent ?? "");
    expect(rows.find((r) => /micro and small enterprises \(MSME\)/.test(r))).toContain("30,000");
    expect(rows.find((r) => /other than micro and small/.test(r))).toContain("60,000");
  });

  it("says plainly when the totals do not tie (sheet total moved)", () => {
    const { t, input } = setup();
    render(<ScheduleIIIView input={input} asOf="2026-11-17" sheet={{ ...t, totalAssets: t.totalAssets + 500 }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/does not tie/i);
  });

  it("Export CSV hands over the rows that are on screen", () => {
    const { t, input } = setup();
    const { container } = render(<ScheduleIIIView input={input} asOf="2026-11-17" sheet={t} />);
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("balance-sheet-schedule-iii-2026-11-17.csv");
    const screenRows = [...container.querySelectorAll("tbody tr")];
    expect(downloads[0].rows.length).toBe(screenRows.length + 2);
    const totalRow = downloads[0].rows.find((r) => String(r[0]).includes("TOTAL ASSETS"));
    expect(totalRow?.[2]).toBe(t.totalAssets);
  });

  it("waits while the P&L is still loading (no half-built sheet)", () => {
    const { t, input } = setup();
    render(<ScheduleIIIView input={{ ...input, unexplained: null }} asOf="2026-11-17" sheet={t} />);
    expect(screen.getByRole("status").textContent).toMatch(/Preparing/);
    expect(screen.queryByText("II. ASSETS")).toBeNull();
  });
});
