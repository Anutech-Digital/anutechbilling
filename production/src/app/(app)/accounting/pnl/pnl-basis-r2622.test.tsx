// @vitest-environment jsdom
/**
 * R-2622 — the P&L page's View toggle: "Management (matched)" / "As invoiced (GST)".
 *
 * October 2026: Google bill 5667984259 dated 7 Oct is for August ("Google Portal Bill (Aug 2026)").
 *   GST view: Cost of goods = the Google bill ₹10,33,617 + Sidhshree ₹451.
 *   Management view: the Google bill is August's — October has only Sidhshree ₹451 + Google's
 *   subscription estimate; the drill lists the bill with its service month and how it was decided,
 *   and its total equals the card.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assemblePnl, type PnlRpcRow, type PnLNumbers } from "@/lib/accounting/pnl-assemble";
import { withMatchedCogs, type MatchedCogsRow } from "@/lib/accounting/pnl-basis";

const state = vi.hoisted(() => ({ role: "owner" as string | null, bases: [] as string[], rpc: [] as string[] }));

const BILLS = [
  { id: "b-google", vendor_name: "Google", bill_no: "5667984259", bill_date: "2026-10-07", subtotal: 1_033_617, category: "COGS-Workspace",
    cgst: 0, sgst: 0, igst: 186_051, document_type: "tax_invoice", vendor_gstin: "29AACCG0527D1Z8" },
  { id: "b-small", vendor_name: "Sidhshree", bill_no: "S-12", bill_date: "2026-10-12", subtotal: 451, category: "COGS-Other",
    cgst: 41, sgst: 40, igst: 0, document_type: "tax_invoice", vendor_gstin: "07AAAAA0000A1Z5" },
];
const MATCHED: MatchedCogsRow = {
  cogs: 451, cogs_count: 1, cogs_by_category: [{ category: "COGS-Other", subtotal: 451, n: 1 }],
  bills: [{ id: "b-small", vendor_name: "Sidhshree", bill_no: "S-12", bill_date: "2026-10-12", category: "COGS-Other",
    subtotal: 451, service_from: "2026-10-01", service_to: "2026-10-31", basis: "bill_month", amount: 451 }],
};

vi.mock("@/lib/supabase/client", () => {
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "gte", "lte", "like", "order", "eq", "in", "limit"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve({ data, error: null });
    q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok, bad);
    return q;
  };
  return {
    createClient: () => ({
      rpc(fn: string) {
        state.rpc.push(fn);
        return Promise.resolve({ data: fn === "report_pnl_cogs_matched" ? [MATCHED] : [], error: null });
      },
      from: (t: string) => chain(t === "vendor_bills" ? BILLS : t === "tenants" ? { state_code: "07", gstin: null } : []),
    }),
  };
});

function rpcRow(): PnlRpcRow {
  return {
    inv_taxable: 200_000, inv_tax: 36_000, revenue_count: 4, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 1_034_068, cogs_count: 2, bills_gst: 186_132,
    bill_itc_groups: [], cogs_by_category: [
      { category: "COGS-Other", subtotal: 451, n: 1 },
      { category: "COGS-Workspace", subtotal: 1_033_617, n: 1 },
    ],
    expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
  };
}
const masters = {
  vendors: [{ vendor: "google", revenue: 100_000, billedCost: null, estimatedCost: 70_000, seats: 100, subscriptions: 5 }],
  allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(),
};
const numbers = (r: { from: string; to: string }, basis: string): PnLNumbers =>
  basis === "management"
    ? { ...assemblePnl(r, withMatchedCogs(rpcRow(), MATCHED), masters), basis: "management" }
    : assemblePnl(r, rpcRow(), masters);

vi.mock("@/lib/queries/pnl", () => ({
  usePnL: (range: { from: string; to: string }, enabled = true, basis = "gst") => {
    if (enabled) state.bases.push(basis);
    return enabled
      ? { data: numbers(range, basis), isLoading: false, isError: false, refetch: vi.fn() }
      : { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  },
  usePnLMonths: () => ({ data: undefined }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: state.role ? { role: state.role } : undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/shared/term", () => ({ Term: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/features/accounting/pnl-waterfall", () => ({ PnlWaterfall: () => null, HundredRupeeBar: () => null }));
vi.mock("@/components/features/accounting/money-flow", () => ({ MoneyFlow: () => null }));
vi.mock("@/components/features/accounting/pnl-charts", () => ({ ProfitDonut: () => null, MonthlyTrend: () => null }));
vi.mock("@/components/features/accounting/project-cost-dialog", () => ({ ProjectCostDialog: () => null }));
vi.mock("@/components/features/accounting/project-margin-card", () => ({ ProjectMarginCard: () => null }));
vi.mock("@/components/features/accounting/expense-report-card", () => ({ ExpenseReportCard: () => null }));

import PnLPage from "./page";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T06:00:00Z"));
  state.role = "owner"; state.bases = []; state.rpc = [];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PnLPage /></QueryClientProvider>);
}
const viewButton = (name: string) => within(screen.getByRole("group", { name: "View" })).getByRole("button", { name });

describe("R-2622 P&L View toggle", () => {
  it("owner opens on Management (matched); accountant opens on As invoiced (GST)", () => {
    renderPage();
    expect(viewButton("Management (matched)").getAttribute("aria-pressed")).toBe("true");
    expect(state.bases).toContain("management");
    cleanup();
    state.role = "accountant"; state.bases = [];
    renderPage();
    expect(viewButton("As invoiced (GST)").getAttribute("aria-pressed")).toBe("true");
    expect(state.bases).not.toContain("management");
  });

  it("Management drill: the Google bill (August's cost) is not in October; Google's estimate is; total = the card", async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: /cost of goods/i })[0]);
    const d = await screen.findByRole("dialog");
    const tie = await within(d).findByTestId("pnl-drill-tie");
    expect(state.rpc).toContain("report_pnl_cogs_matched");
    expect(d.textContent).toContain("by the month the licence was used");
    expect(d.textContent).toContain("for Oct 2026 · bill month");
    expect(d.textContent).not.toContain("5667984259");
    expect(d.textContent).toContain("Estimated");
    expect(tie.textContent).toMatch(/^Total ₹[\d,]+ = (Cost of goods|Licence cost) ₹[\d,]+$/);
    expect(tie.getAttribute("role")).toBeNull();   // not the red "does not match" note
  });

  it("As invoiced (GST): one click switches the statement and the drill back to bill dates", async () => {
    renderPage();
    fireEvent.click(viewButton("As invoiced (GST)"));
    expect(state.bases.at(-1)).toBe("gst");
    expect(viewButton("As invoiced (GST)").getAttribute("aria-pressed")).toBe("true");
    state.rpc = [];
    fireEvent.click(screen.getAllByRole("button", { name: /cost of goods/i })[0]);
    const d = await screen.findByRole("dialog");
    const tie = await within(d).findByTestId("pnl-drill-tie");
    expect(state.rpc).not.toContain("report_pnl_cogs_matched");
    expect(d.textContent).toContain("5667984259");
    expect(tie.getAttribute("role")).toBeNull();
  });
});
