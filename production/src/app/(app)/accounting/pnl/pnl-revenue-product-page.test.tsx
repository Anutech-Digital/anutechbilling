// @vitest-environment jsdom
/**
 * R-1835 — the P&L page lists Revenue by what was sold (Google Workspace, Microsoft 365, Hosting,
 * Software projects …) under the Revenue line, with the compare columns, and in the CSV.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { assemblePnl, type PnlRpcRow, type PnLNumbers } from "@/lib/accounting/pnl-assemble";

const csv = vi.hoisted(() => ({ calls: [] as { name: string; headers: string[]; rows: (string | number)[][] }[] }));

/* September: Google 3,00,000 (credit note 10,000), Hosting 40,000, a project 60,000.
   August: Google 2,00,000, and a ₹5,000 credit note on a July Microsoft invoice. */
function rpc(sep: boolean): PnlRpcRow {
  return {
    inv_taxable: sep ? 400_000 : 200_000, inv_tax: 0, revenue_count: 3,
    cn_taxable: sep ? 10_000 : 5_000, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
    revenue_by_product: sep
      ? [
          { family: "google", invoiced: 300_000, credit_notes: 10_000, debit_notes: 0, invoice_count: 2 },
          { family: "hosting", invoiced: 40_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
          { family: "projects", invoiced: 60_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
        ]
      : [
          { family: "google", invoiced: 200_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
          { family: "microsoft", invoiced: 0, credit_notes: 5_000, debit_notes: 0, invoice_count: 0 },
        ],
    expense_groups: [{ category: "Rent", vendor_name: "Landlord", month: "2026-09", amount: 50_000, n: 1 }],
    itc_groups: [], unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
  };
}
const numbers = (r: { from: string; to: string }): PnLNumbers =>
  assemblePnl(r, rpc(r.from.slice(5, 7) === "09"), {
    vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(),
  });

vi.mock("@/lib/queries/pnl", () => ({
  usePnL: (range: { from: string; to: string }, enabled = true) => enabled
    ? { data: numbers(range), isLoading: false, isError: false, refetch: vi.fn() }
    : { data: undefined, isLoading: false, isError: false, refetch: vi.fn() },
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
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function pickSeptember() {
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
}
const revenueGroup = () => screen.getAllByTestId("pnl-sub-lines").find((g) => within(g).queryByText("Google Workspace"))!;

describe("R-1835 Revenue by what was sold", () => {
  it("lists the products under Revenue, largest first, net of their credit notes", () => {
    render(<PnLPage />);
    pickSeptember();
    const g = revenueGroup();
    expect(within(g).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Google Workspace", "Software projects", "Hosting",
    ]);
    expect(g.textContent).toContain("₹2,90,000");
    expect(g.textContent).not.toContain("credit notes");
  });

  it("compare: each product has its August figure; a product only in August reads ₹0 now, and a minus stays a minus", () => {
    render(<PnLPage />);
    pickSeptember();
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    const g = revenueGroup();
    const ms = within(g).getByText("Microsoft 365").closest("div")!;
    expect(ms.textContent).toContain("₹0");
    expect(ms.textContent).toContain("−₹5,000");
    const google = within(g).getByText("Google Workspace").closest("div")!;
    expect(google.textContent).toContain("₹2,00,000");

    fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
    const rows = csv.calls.at(-1)!.rows;
    expect(rows.find((r) => r[0] === "  Google Workspace")).toEqual(["  Google Workspace", 290_000, 200_000, 90_000, 45]);
    expect(rows.find((r) => r[0] === "  Microsoft 365")).toEqual(["  Microsoft 365", 0, -5_000, 5_000, 100]);
    const idx = rows.findIndex((r) => r[0] === "Revenue");
    let now = 0, was = 0;
    for (let i = idx + 1; String(rows[i][0]).startsWith("  "); i++) { now += rows[i][1] as number; was += rows[i][2] as number; }
    expect([now, was]).toEqual([rows[idx][1], rows[idx][2]]);
  });
});
