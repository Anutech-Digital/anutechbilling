// @vitest-environment jsdom
/**
 * R-2502 — Expenses → FY 2025-26 purchases from Zoho: the preview shows the counts, the unmapped
 * Zoho accounts with a category picker (saved through the route), and Import stays off until the
 * check (dry run) ran. fetch is mocked; no Zoho, no database. Values are made up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ZohoPurchaseImportDialog } from "./zoho-purchase-import-dialog";

const calls: Array<Record<string, unknown>> = [];
const preview = {
  ok: true,
  purchases: {
    counts: { scanned: 3, import: 2, already: 0, skip: 1, voidOrDraft: 1, newVendors: 1 },
    parts: { bills: 1, expenses: 0 },
    zohoByMonth: [{ month: "2025-05", count: 2, taxable: 2000, igst: 360, cgst: 0, sgst: 0, itc: 360, rcmTax: 0, tds: 100 }],
    importByMonth: [{ month: "2025-05", count: 2, taxable: 2000, igst: 360, cgst: 0, sgst: 0, itc: 360, rcmTax: 0, tds: 100 }],
    appByMonth: [],
    skipReasons: [{ reason: "Void in Zoho — not a purchase, not in the P&L or ITC.", count: 1 }],
    tdsBySection: [{ section: "194J", amount: 100, count: 1 }],
    unmapped: [{ accountId: "A9", accountName: "Misc Expenses", count: 2, taxable: 2000 }],
    skipped: [],
  },
  payments: null,
  categories: ["Software", "Office Rent", "COGS-Other"],
  batches: [],
};

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.action === "preview") return new Response(JSON.stringify(preview));
    if (body.action === "import") return new Response(JSON.stringify({ ok: true, result: { imported: 2, already: 0, skipped: [] } }));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderIt() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ZohoPurchaseImportDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ZohoPurchaseImportDialog", () => {
  it("shows the plan, the TDS by section and the unmapped account", async () => {
    renderIt();
    expect((await screen.findByTestId("fy-purchases-summary")).textContent).toMatch(/3 Zoho bills \+ expenses · 2 to import/);
    expect(screen.getByText(/194J/)).toBeTruthy();
    expect(screen.getByLabelText("Category for Misc Expenses")).toBeTruthy();
  });

  it("saves a mapping through the route", async () => {
    renderIt();
    fireEvent.change(await screen.findByLabelText("Category for Misc Expenses"), { target: { value: "Office Rent" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the map" }));
    await waitFor(() => expect(calls.some((c) => c.action === "saveMap")).toBe(true));
    expect(calls.find((c) => c.action === "saveMap")).toMatchObject({ rows: [{ zohoAccountId: "A9", category: "Office Rent", zohoAccountName: "Misc Expenses" }] });
  });

  it("payments on COGS bills are listed for Reconcile — no bank-account picker (no manual bank line)", async () => {
    const withPay = { ...preview, payments: { counts: { scanned: 2, import: 1, already: 0, skip: 1, advanceAmount: 0, amount: 1180, cogsAmount: 500 }, parts: 1,
      paidThrough: [{ name: "HDFC 4523", count: 1, amount: 1180 }], skipReasons: [], cogs: [{ number: "7", date: "2025-06-01", vendor: "Mehta", bill: "C-1", amount: 500 }] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withPay))));
    renderIt();
    expect(await screen.findByText(/payments on COGS bills .* Banking → Reconcile/)).toBeTruthy();
    expect(screen.queryByText(/Pick the bank account/)).toBeNull();
  });

  it("Import is off until the check (dry run) ran; the check sends dryRun true", async () => {
    renderIt();
    await screen.findByTestId("fy-purchases-summary");
    const imp = screen.getByRole("button", { name: /^Import\s+bills/ }) as HTMLButtonElement;
    expect(imp.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check first (nothing saved)" }));
    await waitFor(() => expect(calls.some((c) => c.action === "import" && c.dryRun === true && c.kind === "bills")).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: /Import 2 bills/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});
