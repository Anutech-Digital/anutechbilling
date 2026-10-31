// @vitest-environment jsdom
/**
 * R-2181 (G-ZOHO Wave 1) — a P&L row's drill-down opens only that row's documents, and the drill
 * total equals the number clicked (ex-GST, net of credit notes).
 *
 * Before: "Microsoft 365" under Revenue opened every invoice of the period, GST-inclusive, with a
 * fully credited invoice at full value; the vendor rows under Licence cost opened every bill.
 *
 * Fixture = supabase/tests/r2181_pnl_revenue_drill.test.sql (whose SQL proves the per-family rows):
 *   GW1 google 10,000 · MS1 microsoft 6,000 · MS2 microsoft 3,000 fully credited by CN-MS2 ·
 *   ZO1 zoho 2,400 · MIX google 1,001 + microsoft 1,000 → Revenue 20,401.
 *   Licence cost: a Microsoft bill 5,000 + ₹900 GST on a proforma (no credit) = 5,900; Google has
 *   no bill → estimated 20,401 × 12,000 / 30,000 = 8,160.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assemblePnl, type PnlRpcRow, type PnLNumbers } from "@/lib/accounting/pnl-assemble";
import type { RevenueLineRow } from "@/lib/accounting/pnl-drill";

const LINES: RevenueLineRow[] = [
  { doc_kind: "credit_note", doc_id: "CN-R2181-MS2", invoice_id: "R2181-MS2", customer_name: "Cust N", doc_date: "2026-10-20", status: null, family: "microsoft", amount: -3000 },
  { doc_kind: "invoice", doc_id: "R2181-MIX", invoice_id: "R2181-MIX", customer_name: "Cust X", doc_date: "2026-10-07", status: "paid", family: "google", amount: 1001 },
  { doc_kind: "invoice", doc_id: "R2181-MIX", invoice_id: "R2181-MIX", customer_name: "Cust X", doc_date: "2026-10-07", status: "paid", family: "microsoft", amount: 1000 },
  { doc_kind: "invoice", doc_id: "R2181-ZO1", invoice_id: "R2181-ZO1", customer_name: "Cust Z", doc_date: "2026-10-06", status: "overdue", family: "zoho", amount: 2400 },
  { doc_kind: "invoice", doc_id: "R2181-MS2", invoice_id: "R2181-MS2", customer_name: "Cust N", doc_date: "2026-10-05", status: "paid", family: "microsoft", amount: 3000 },
  { doc_kind: "invoice", doc_id: "R2181-MS1", invoice_id: "R2181-MS1", customer_name: "Cust M", doc_date: "2026-10-04", status: "pending", family: "microsoft", amount: 6000 },
  { doc_kind: "invoice", doc_id: "R2181-GW1", invoice_id: "R2181-GW1", customer_name: "Cust G", doc_date: "2026-10-03", status: "paid", family: "google", amount: 10000 },
];
const BILLS = [
  { id: "b1", vendor_name: "Microsoft India", bill_no: "MS-77", bill_date: "2026-10-10", subtotal: 5000, category: "COGS-M365",
    cgst: 450, sgst: 450, igst: 0, document_type: "proforma", vendor_gstin: "07AAACM0000A1Z5" },
];

const calls = vi.hoisted(() => ({ rpc: [] as { fn: string; args: Record<string, unknown> }[] }));

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
      rpc(fn: string, args: { p_families: string[] | null }) {
        calls.rpc.push({ fn, args });
        /* The SQL function's p_families filter (proven in the SQL test). */
        const data = LINES.filter((l) => !args.p_families || args.p_families.includes(l.family));
        return Promise.resolve({ data, error: null });
      },
      from: (t: string) => chain(t === "vendor_bills" ? BILLS : t === "tenants" ? { state_code: "07", gstin: null } : []),
    }),
  };
});

function rpcRow(): PnlRpcRow {
  return {
    inv_taxable: 23_401, inv_tax: 4_212, revenue_count: 5,
    cn_taxable: 3_000, cn_tax: 540, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 5_000, cogs_count: 1, bills_gst: 900,
    bill_itc_groups: [{ document_type: "proforma", category: "COGS-M365", vendorGstin: "07AAACM0000A1Z5", cgst: 450, sgst: 450, igst: 0, n: 1, ownStateCode: "07" }],
    cogs_by_category: [{ category: "COGS-M365", subtotal: 5_000, n: 1 }],
    revenue_by_product: [
      { family: "google", invoiced: 11_001, credit_notes: 0, debit_notes: 0, invoice_count: 2 },
      { family: "microsoft", invoiced: 10_000, credit_notes: 3_000, debit_notes: 0, invoice_count: 3 },
      { family: "zoho", invoiced: 2_400, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
    ],
    expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
  };
}
const numbers = (r: { from: string; to: string }): PnLNumbers =>
  assemblePnl(r, rpcRow(), {
    vendors: [
      { vendor: "google", revenue: 20_000, billedCost: null, estimatedCost: 12_000, seats: 20, subscriptions: 2 },
      { vendor: "microsoft", revenue: 10_000, billedCost: null, estimatedCost: 6_000, seats: 10, subscriptions: 1 },
    ],
    allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(),
  });

vi.mock("@/lib/queries/pnl", () => ({
  usePnL: (range: { from: string; to: string }, enabled = true) => enabled
    ? { data: numbers(range), isLoading: false, isError: false, refetch: vi.fn() }
    : { data: undefined, isLoading: false, isError: false, refetch: vi.fn() },
  usePnLMonths: () => ({ data: undefined }),
}));
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
  calls.rpc = [];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PnLPage /></QueryClientProvider>);
}
const group = (has: string, lacks?: string) => screen.getAllByTestId("pnl-sub-lines")
  .find((g) => within(g).queryByRole("button", { name: has }) && (!lacks || !within(g).queryByRole("button", { name: lacks })))!;
const revenueGroup = () => group("Zoho");
const licenceGroup = () => group("Microsoft 365", "Zoho");
async function openedDialog() {
  const d = await screen.findByRole("dialog");
  await within(d).findByTestId("pnl-drill-tie");
  return d;
}

describe("R-2181 P&L drill-down = the row clicked", () => {
  it("Revenue › Microsoft 365 lists only Microsoft documents, ex-GST, and its total = the row", async () => {
    renderPage();
    const row = within(revenueGroup()).getByRole("button", { name: "Microsoft 365" }).closest("div")!;
    expect(row.textContent).toContain("₹7,000");
    fireEvent.click(within(revenueGroup()).getByRole("button", { name: "Microsoft 365" }));
    const d = await openedDialog();
    expect(calls.rpc.at(-1)).toEqual({ fn: "report_pnl_revenue_lines", args: { p_from: "2026-10-01", p_to: "2026-10-31", p_families: ["microsoft"] } });
    const text = d.textContent!;
    for (const id of ["R2181-MS1", "R2181-MS2", "CN-R2181-MS2", "R2181-MIX"]) expect(text).toContain(id);
    for (const id of ["R2181-GW1", "R2181-ZO1"]) expect(text).not.toContain(id);
    /* MIX shows only its Microsoft share; ex-GST (MS1 is 6,000 — 7,080 with GST). */
    expect(text).toContain("₹1,000");
    expect(text).not.toContain("₹7,080");
    expect(within(d).getByTestId("pnl-drill-tie").textContent).toBe("Total ₹7,000 = Microsoft 365 ₹7,000");
  });

  it("a fully credited invoice and its credit note net to ₹0", async () => {
    renderPage();
    fireEvent.click(within(revenueGroup()).getByRole("button", { name: "Microsoft 365" }));
    const d = await openedDialog();
    const amountOf = (id: string) => within(d).getByText(new RegExp(`^${id} ·`)).closest("li")!.querySelector(".font-mono")!.textContent;
    expect(amountOf("R2181-MS2")).toBe("₹3,000");
    expect(amountOf("CN-R2181-MS2")).toBe("−₹3,000");
  });

  it("the Revenue card opens every family and its total = the card (no GST)", async () => {
    renderPage();
    fireEvent.click(screen.getAllByText("₹20,401")[0]);
    const d = await openedDialog();
    expect(calls.rpc.at(-1)?.args.p_families).toBeNull();
    expect(within(d).getByTestId("pnl-drill-tie").textContent).toBe("Total ₹20,401 = Revenue ₹20,401");
    /* MIX is one row again when the whole line is open. */
    expect(within(d).getAllByText(/^R2181-MIX ·/)).toHaveLength(1);
  });

  it("Licence cost › Google Workspace (no bill) lists its estimate and ties; Microsoft 365 lists only its bill incl. GST not claimable", async () => {
    renderPage();
    fireEvent.click(within(licenceGroup()).getByRole("button", { name: /Google Workspace/ }));
    let d = await openedDialog();
    expect(d.textContent).toContain("Estimated — no vendor bill yet");
    expect(d.textContent).not.toContain("MS-77");
    expect(within(d).getByTestId("pnl-drill-tie").textContent).toBe("Total ₹8,160 = Google Workspace ₹8,160");
    fireEvent.keyDown(d, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(licenceGroup()).getByRole("button", { name: "Microsoft 365" }));
    d = await openedDialog();
    expect(d.textContent).toContain("MS-77");
    expect(d.textContent).not.toContain("Estimated — no vendor bill yet");
    expect(within(d).getByTestId("pnl-drill-tie").textContent).toBe("Total ₹5,900 = Microsoft 365 ₹5,900");
  });

  it("the Licence cost line = its bills + the estimate rows", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^1 vendor bill \+ ₹8,160 estimated/ }));
    const d = await openedDialog();
    expect(within(d).getByTestId("pnl-drill-tie").textContent).toBe("Total ₹14,060 = Licence cost ₹14,060");
  });
});
