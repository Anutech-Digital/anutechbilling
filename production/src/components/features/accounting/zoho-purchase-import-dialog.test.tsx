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
    otherByMonth: [{ month: "2025-05", count: 4, amount: 3300 }],
    accounts: [{ zohoName: "Director - Rakesh", count: 2, amount: 900, appAccountId: null, suggested: false }],
    skipReasons: [{ reason: "Void in Zoho — not a purchase, not in the P&L or ITC.", count: 1 }],
    tdsBySection: [{ section: "194J", amount: 100, count: 1 }],
    unmapped: [{ accountId: "A9", accountName: "Misc Expenses", count: 2, taxable: 2000 }],
    skipped: [],
  },
  payments: null,
  categories: ["Software", "Office Rent", "COGS-Other"],
  bankAccounts: [{ id: "acc-1", name: "HDFC Current", last4: "4523", type: "current" }, { id: "acc-cash", name: "Petty Cash", last4: null, type: "cash" }],
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

  it("payments not booked here are listed for Reconcile WITH their TDS (COGS bill / part payment)", async () => {
    const withPay = { ...preview, payments: { counts: { scanned: 3, import: 1, already: 0, skip: 2, advanceAmount: 0, amount: 1180, cogsAmount: 500, partsAmount: 300 }, parts: 1,
      accounts: [], skipReasons: [], toReconcile: [
        { why: "cogs", number: "7", date: "2025-06-01", vendor: "Mehta", bill: "C-1", amount: 500, tds: 200, tdsSection: "194C" },
        { why: "parts", number: "8", date: "2025-06-02", vendor: "Mehta", bill: "TP-1", amount: 300, tds: 0, tdsSection: null }] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withPay))));
    renderIt();
    const list = await screen.findByTestId("to-reconcile");
    expect(list.textContent).toMatch(/C-1.*TDS ₹200 194C.*COGS bill/);
    expect(list.textContent).toMatch(/TP-1.*part payment/);
  });

  it("R-2502c: paid-from accounts — choose one, and it goes with the preview; other purchases per month shown", async () => {
    renderIt();
    expect((await screen.findByText(/In the app, not from Zoho/))).toBeTruthy();
    expect(screen.getByText(/\(1 not chosen/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("App account for Director - Rakesh"), { target: { value: "acc-cash" } });
    await waitFor(() => expect(calls.some((c) => c.action === "preview" && (c.accounts as Record<string, string>)?.["Director - Rakesh"] === "acc-cash")).toBe(true));
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
