// @vitest-environment jsdom
/**
 * R-2965 — Scorecards: every KPI tile is a button that opens a Sheet with the records behind
 * its number. The Sheet shows the tile's own number, a list that adds up to it (each row a
 * link), a plain empty reason, sort and CSV; Activity shows counts by type with bulk apart.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  reads: [] as string[],
  csv: [] as { name: string; headers: string[]; rows: (string | number)[][] }[],
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "order", "eq", "neq", "gte", "lt", "in", "range", "not", "limit"]) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    h.reads.push(table);
    return Promise.resolve({ data: h.tables[table] ?? [], error: null }).then(ok, bad);
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => chainFor(t) }) }));
vi.mock("@/lib/queries/team", () => ({
  useTeamMembers: () => ({
    data: [{ id: "u-asha", full_name: "Asha", role: "sales" }, { id: "u-ravi", full_name: "Ravi", role: "accountant" }],
    isLoading: false, isError: false, error: null, refetch: () => {},
  }),
  memberLabel: (m: { full_name?: string }) => m.full_name ?? "",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/scorecard",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/csv", () => ({
  downloadCSV: (name: string, headers: string[], rows: (string | number)[][]) => { h.csv.push({ name, headers, rows }); },
}));

afterEach(() => { cleanup(); h.tables = {}; h.reads = []; h.csv = []; });

function seed() {
  const bulkAt = "2026-11-03T05:00:00.123+00:00";
  h.tables = {
    users: [{ id: "u-asha", employee_id: "e-asha" }, { id: "u-ravi", employee_id: null }],
    payments: [
      { id: "p1", recorded_by: "u-ravi", amount: 60000, received_at: "2026-11-10T10:00:00+00:00", status: "received", quote_id: "Q-7", customer_id: "c1", method: "bank" },
      { id: "p2", recorded_by: "u-ravi", amount: 4900, received_at: "2026-11-12T10:00:00+00:00", status: "received", quote_id: null, invoice_id: "INV-9", customer_id: "c2", method: "upi" },
    ],
    customers: [{ id: "c1", name: "First Customer" }, { id: "c2", name: "Second Customer" }],
    tasks: [
      { id: "t1", owner_id: "u-asha", status: "done", due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-07T11:00:00+00:00", title: "Call back" },
      { id: "t2", owner_id: "u-asha", status: "done", due_at: "2026-11-08T09:00:00+00:00", completed_at: "2026-11-08T10:00:00+00:00", title: "Hours late" },
    ],
    activity_log: [
      ...Array.from({ length: 12 }, () => ({ user_id: "u-asha", created_at: bulkAt, action: "update", entity: "bank_lines" })),
      { user_id: "u-asha", created_at: "2026-11-04T05:00:00+00:00", action: "insert", entity: "quotes" },
    ],
  };
}

async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { ConfirmProvider } = await import("@/components/providers/confirm-provider");
  const { default: Page } = await import("./page");
  render(<QueryClientProvider client={qc}><ConfirmProvider><Page /></ConfirmProvider></QueryClientProvider>);
}

describe("R-2965: KPI tiles open their records", () => {
  it("every tile is a button with a clear label", async () => {
    seed();
    await renderPage();
    const rev = await screen.findByRole("button", { name: /^Revenue ₹64\.9K — show the records$/ });
    expect(rev.tagName).toBe("BUTTON");
    for (const label of ["Deals won", "Quotes", "Payments", "Present days", "Tasks on-time", "Tasks late", "Activity"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${label} .* show the records$`) }).length).toBe(2);
    }
  });

  it("Revenue: same number as the tile, payments that add up to it, each row links to its record; CSV", async () => {
    seed();
    await renderPage();
    fireEvent.click(await screen.findByTestId("kpi-revenue-u-ravi"));
    const sheet = await screen.findByTestId("kpi-records-sheet");
    expect(within(sheet).getByTestId("kpi-sheet-value").textContent).toBe("₹64.9K");
    expect(screen.getByTestId("kpi-revenue-u-ravi").textContent).toContain("₹64.9K");
    expect(within(sheet).getByTestId("kpi-sheet-exact").textContent).toContain("₹64,900.00");
    const table = within(sheet).getByRole("table");
    expect(within(table).getByRole("link", { name: "Q-7" }).getAttribute("href")).toBe("/quotes/Q-7");
    expect(within(table).getByRole("link", { name: "INV-9" }).getAttribute("href")).toBe("/invoices/INV-9");
    await waitFor(() => expect(within(table).getByText("First Customer")).toBeTruthy());
    expect(h.reads.filter((t) => t === "customers")).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole("button", { name: /Export CSV/ }));
    expect(h.csv[0].name).toBe("scorecard-revenue-ravi-" + h.csv[0].name.slice(-11));
    expect(h.csv[0].rows.reduce((s, r) => s + Number(r[4]), 0)).toBe(64900);
  });

  it("customers are read only when a payments Sheet opens (not on page open)", async () => {
    seed();
    await renderPage();
    await screen.findByTestId("kpi-revenue-u-ravi");
    expect(h.reads).not.toContain("customers");
  });

  it("sorting a column reorders the list", async () => {
    seed();
    await renderPage();
    fireEvent.click(await screen.findByTestId("kpi-payments-u-ravi"));
    const table = within(await screen.findByTestId("kpi-records-sheet")).getByRole("table");
    const amounts = () => within(table).getAllByRole("row").slice(1).map((r) => r.lastElementChild?.textContent);
    fireEvent.click(within(table).getByRole("button", { name: /Amount/ }));
    const first = amounts();
    fireEvent.click(within(table).getByRole("button", { name: /Amount/ }));
    expect(amounts()).toEqual([...first].reverse());
  });

  it("Tasks late: days late; late by hours on the due day says Same day", async () => {
    seed();
    await renderPage();
    fireEvent.click(await screen.findByTestId("kpi-tasksLate-u-asha"));
    const table = within(await screen.findByTestId("kpi-records-sheet")).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(table).getByRole("link", { name: "Call back" }).getAttribute("href")).toBe("/tasks?task=t1");
    expect(rows.find((r) => r.textContent?.includes("Call back"))?.lastElementChild?.textContent).toBe("2");
    expect(rows.find((r) => r.textContent?.includes("Hours late"))?.lastElementChild?.textContent).toBe("Same day");
  });

  it("empty: a plain reason with the person and month; Present days without a linked employee says why", async () => {
    seed();
    await renderPage();
    fireEvent.click(await screen.findByTestId("kpi-payments-u-asha"));
    let sheet = await screen.findByTestId("kpi-records-sheet");
    expect(within(sheet).getByText(/No payments recorded by Asha in \w+ \d{4}\./)).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("kpi-records-sheet")).toBeNull());
    fireEvent.click(screen.getByTestId("kpi-present-u-ravi"));
    sheet = await screen.findByTestId("kpi-records-sheet");
    expect(within(sheet).getByText(/not linked to an employee/)).toBeTruthy();
  });

  it("Activity: counts by type, bulk writes apart, adding up to the number", async () => {
    seed();
    await renderPage();
    fireEvent.click(await screen.findByTestId("kpi-activity-u-asha"));
    const sheet = await screen.findByTestId("kpi-records-sheet");
    expect(within(sheet).getByTestId("kpi-sheet-value").textContent).toBe("13");
    const byType = within(sheet).getByRole("table", { name: "Activity by type" });
    expect(within(byType).getByText("Changed · bank lines")).toBeTruthy();
    expect(within(sheet).getByRole("table", { name: "Bulk changes by type" })).toBeTruthy();
    expect(sheet.textContent).toMatch(/1 one at a time, and 12 written in bulk \(1 operation/);
  });
});
