// @vitest-environment jsdom
/**
 * R-1832 + R-1833 — the P&L page: the Compare control adds the compare columns (and the CSV
 * carries them); the statement lists the expense categories under Operating expenses.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { assemblePnl, type PnlRpcRow, type PnLNumbers } from "@/lib/accounting/pnl-assemble";

const csv = vi.hoisted(() => ({ calls: [] as { name: string; headers: string[]; rows: (string | number)[][] }[] }));
const seen = vi.hoisted(() => ({ ranges: [] as { from: string; to: string; enabled: boolean }[] }));

function rpc(scale: number): PnlRpcRow {
  return {
    inv_taxable: 400_000 * scale, inv_tax: 72_000 * scale, revenue_count: 4,
    cn_taxable: 10_000, cn_tax: 1_800, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
    expense_groups: [
      { category: "Rent", vendor_name: "Landlord", month: "2026-09", amount: 50_000, n: 1 },
      { category: "Salaries", vendor_name: null, month: "2026-09", amount: 120_000 * scale, n: 2 },
    ],
    itc_groups: [], unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
  };
}
const numbers = (r: { from: string; to: string }): PnLNumbers =>
  assemblePnl(r, rpc(r.from.slice(5, 7) === "09" ? 1 : 1.5), {
    vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(),
  });

vi.mock("@/lib/queries/pnl", () => ({
  usePnL: (range: { from: string; to: string }, enabled = true) => {
    seen.ranges.push({ ...range, enabled });
    return enabled
      ? { data: numbers(range), isLoading: false, isError: false, refetch: vi.fn() }
      : { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  },
  usePnLMonths: () => ({ data: undefined }),
}));
vi.mock("@/lib/csv", () => ({
  downloadCSV: (name: string, headers: string[], rows: (string | number)[][]) => { csv.calls.push({ name, headers, rows }); },
}));
vi.mock("@/components/shared/term", () => ({ Term: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/features/accounting/pnl-drilldown-dialog", () => ({ PnLDrilldownDialog: () => null }));
vi.mock("@/components/features/accounting/pnl-waterfall", () => ({ PnlWaterfall: () => null, HundredRupeeBar: () => null }));
vi.mock("@/components/features/accounting/money-flow", () => ({ MoneyFlow: () => null }));
vi.mock("@/components/features/accounting/pnl-charts", () => ({ ProfitDonut: () => null, MonthlyTrend: () => null }));
vi.mock("@/components/features/accounting/project-cost-dialog", () => ({ ProjectCostDialog: () => null }));
vi.mock("@/components/features/accounting/project-margin-card", () => ({ ProjectMarginCard: () => null }));

import PnLPage from "./page";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T06:00:00Z"));
  csv.calls = [];
  seen.ranges = [];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/* Use a whole past month so both periods are complete. */
function pickSeptember() {
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
}

describe("R-1832 Compare control", () => {
  it("None by default: no compare columns, no compare fetch, CSV has two columns", () => {
    render(<PnLPage />);
    expect(screen.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("pnl-compare-heading")).toBeNull();
    expect(screen.queryAllByTestId("pnl-tile-vs")).toHaveLength(0);
    expect(seen.ranges.every((r) => r.enabled || r.from === seen.ranges[0].from)).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
    expect(csv.calls.at(-1)!.headers).toEqual(["Line", "Amount (INR)"]);
  });

  it("Previous period: September compares with August — tiles, columns, heading and CSV", () => {
    render(<PnLPage />);
    pickSeptember();
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));

    expect(seen.ranges.some((r) => r.from === "2026-08-01" && r.to === "2026-08-31" && r.enabled)).toBe(true);
    expect(screen.getByTestId("pnl-compare-heading").textContent).toContain("1–30 Sep 2026 vs 1–31 Aug 2026");
    /* Statement column heads */
    expect(screen.getByText("This period")).toBeTruthy();
    expect(screen.getByText("Change")).toBeTruthy();
    /* Tiles: revenue Sep 3,90,000 vs Aug 5,90,000 → ▼ ₹2,00,000 (33.9%) */
    const vs = screen.getAllByTestId("pnl-tile-vs").map((n) => n.textContent);
    expect(vs[0]).toContain("vs ₹5,90,000 in Aug 2026");
    expect(vs[0]).toContain("▼ ₹2,00,000 (33.9%)");

    fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
    const out = csv.calls.at(-1)!;
    expect(out.name).toBe("pnl-2026-09-01-to-2026-09-30-vs-2026-08-01-to-2026-08-31.csv");
    expect(out.headers).toEqual(["Line", "Amount (INR)", "Compare amount (INR)", "Change (INR)", "Change %"]);
    expect(out.rows.find((r) => r[0] === "Revenue")).toEqual(["Revenue", 390_000, 590_000, -200_000, -33.9]);
  });

  it("Same period last year: September 2026 compares with September 2025", () => {
    render(<PnLPage />);
    pickSeptember();
    fireEvent.click(screen.getByRole("button", { name: "Same period last year" }));
    expect(screen.getByTestId("pnl-compare-heading").textContent).toContain("1–30 Sep 2026 vs 1–30 Sep 2025");
  });
});

describe("R-1833 statement sub-lines", () => {
  it("lists the expense categories under Operating expenses, largest first, and in the CSV", () => {
    render(<PnLPage />);
    pickSeptember();
    const groups = screen.getAllByTestId("pnl-sub-lines");
    const opex = groups.find((g) => within(g).queryByText("Salaries"))!;
    const names = within(opex).getAllByRole("button").map((b) => b.textContent);
    expect(names.slice(0, 2)).toEqual(["Salaries", "Rent"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
    const rows = csv.calls.at(-1)!.rows;
    expect(rows.find((r) => r[0] === "  Salaries")).toEqual(["  Salaries", -120_000]);
    expect(rows.find((r) => r[0] === "  Less: credit notes")).toEqual(["  Less: credit notes", -10_000]);
  });
});
