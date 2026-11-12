// @vitest-environment jsdom
/* R-2704 (G-FY2526) — FY Zoho import dialogs, 12 Nov staging check:
   (b) FY sales: the month table shows Zoho's adjustment / round-off, so total = taxable + GST + adjustment
       is visible (staging: 22 invoices taxable ₹8,83,063, GST 0, total ₹8,83,243 — the ₹180 was nowhere).
   (c) the Zoho → app account choice is saved per company (receipts "Where the money went", purchases
       "Paid from") — reopening keeps it.
   (d) the receipts check line adds up: new receipts = matched + waiting; an earlier receipt whose bank line
       came in since is counted apart (staging: "62 receipts · 49 matched · 14 wait").
   fetch is mocked; names and numbers are made up. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFySalesImportDialog, adjustmentOf } from "./zoho-fy-sales-import-dialog";
import { ZohoFyReceiptsImportDialog, receiptsCountText } from "./zoho-fy-receipts-import-dialog";
import { ZohoPurchaseImportDialog } from "@/components/features/accounting/zoho-purchase-import-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(answer: (b: Record<string, unknown>) => unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(b);
    return { ok: true, json: async () => answer(b) } as Response;
  }));
  return bodies;
}

describe("R-2704 (b) FY sales — adjustment / round-off shown", () => {
  const month = (m: string, taxable: number, gst: number, amount: number, count: number) =>
    ({ month: m, count, taxable, igst: gst, cgst: 0, sgst: 0, amount });

  it("adjustment = total − taxable − GST (a round-off up or down; 0 when none)", () => {
    expect(adjustmentOf(month("2025-04", 883063, 0, 883243, 22))).toBe(180);
    expect(adjustmentOf(month("2025-04", 1000, 180, 1179.6, 1))).toBeCloseTo(-0.4);
    expect(adjustmentOf(month("2025-04", 1000, 180, 1180, 1))).toBe(0);
  });

  it("the month table shows the adjustment and a total row where taxable + GST + adjustment = total", async () => {
    const zoho = [month("2025-04", 883063, 0, 883243, 22), month("2025-05", 1000, 180, 1180, 1)];
    stubFetch(() => ({
      ok: true, scanned: 23, parts: 1, counts: { scanned: 23, import: 23, already: 0, skip: 0, voidOrDraft: 0 },
      zohoByMonth: zoho, importByMonth: zoho, appByMonth: [], skipReasons: [], skipped: [], batches: [], gstinChoices: [],
    }));
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    const table = await screen.findByTestId("fy-sales-months");
    expect(table.textContent).toMatch(/Adjustment/);
    const apr = screen.getByTestId("fy-sales-month-2025-04");
    expect(apr.textContent).toMatch(/₹180/);
    expect(apr.textContent).toMatch(/₹8,83,243/);
    const total = screen.getByTestId("fy-sales-month-total");
    expect(total.textContent).toMatch(/₹8,84,063/);   // taxable
    expect(total.textContent).toMatch(/₹180\b/);      // GST (May) and adjustment (April)
    expect(total.textContent).toMatch(/₹8,84,423/);   // 8,84,063 + 180 + 180
  });
});

describe("R-2704 (d) FY receipts — the check line adds up", () => {
  it("new receipts = matched + waiting; an earlier receipt matched now is said apart", () => {
    const t = receiptsCountText({ imported: 62, banked: 49, bankLater: 14, already: 120 });
    expect(t).toBe("62 new receipts (48 matched to bank lines · 14 wait for their bank line) · 120 already recorded (1 of them matched to its bank line now)");
    expect(receiptsCountText({ imported: 13, banked: 1, bankLater: 12, already: 0 })).toBe("13 new receipts (1 matched to bank lines · 12 wait for their bank line)");
    expect(receiptsCountText({ imported: 0, banked: 3, bankLater: 0, already: 5 })).toBe("0 new receipts · 5 already recorded (3 of them matched to their bank lines now)");
  });
});

describe("R-2704 (c) the Zoho account choice is saved per company", () => {
  const receiptsPreview = {
    ok: true, parts: 1, counts: { scanned: 2, import: 2, already: 0, alreadyNotBanked: 0, skip: 0 },
    totals: { cash: 2000, tds: 0, excess: 0 }, skipReasons: [], skipped: [], batches: [], canRemove: true,
    deposits: [{ zohoAccountId: "za", zohoName: "M/S. Main Bank Co", count: 2, amount: 2000, appAccountId: null, suggested: false, leftOut: false }],
    accounts: [{ id: "11111111-1111-4111-8111-111111111111", name: "HDFC 4523" }],
  };

  it("receipts: choosing the app account saves it (saveAccount) and previews again with it", async () => {
    const bodies = stubFetch((b) => (b.action === "status" ? { ok: true, listed: 2, detailed: 2, complete: true, running: false }
      : b.action === "preview" ? receiptsPreview : { ok: true }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText("App account for Zoho's M/S. Main Bank Co"), { target: { value: "11111111-1111-4111-8111-111111111111" } });
    await waitFor(() => expect(bodies.some((b) => b.action === "saveAccount")).toBe(true));
    expect(bodies.find((b) => b.action === "saveAccount")).toMatchObject({ zohoKey: "za", choice: "11111111-1111-4111-8111-111111111111" });
    await waitFor(() => expect(bodies.filter((b) => b.action === "preview").at(-1)).toMatchObject({ accounts: { za: "11111111-1111-4111-8111-111111111111" } }));
  });

  it("receipts: payments Zoho gave no deposit account (\"\" key) are used but not saved — nothing to remember them by", async () => {
    const noAcct = { ...receiptsPreview, deposits: [{ ...receiptsPreview.deposits[0], zohoAccountId: "", zohoName: "(no account in Zoho)" }] };
    const bodies = stubFetch((b) => (b.action === "status" ? { ok: true, listed: 2, detailed: 2, complete: true, running: false }
      : b.action === "preview" ? noAcct : { ok: true }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText("App account for Zoho's (no account in Zoho)"), { target: { value: "11111111-1111-4111-8111-111111111111" } });
    await waitFor(() => expect(bodies.filter((b) => b.action === "preview").length).toBe(2));
    expect(bodies.some((b) => b.action === "saveAccount")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("purchases: a saved Leave these out comes back as that choice (not 'not chosen')", async () => {
    const preview = {
      ok: true,
      purchases: {
        counts: { scanned: 1, import: 0, already: 0, skip: 1, voidOrDraft: 0, newVendors: 0 }, parts: { bills: 0, expenses: 0 },
        zohoByMonth: [], importByMonth: [], appByMonth: [], otherByMonth: [],
        accounts: [{ zohoName: "Director - Rakesh", count: 1, amount: 500, appAccountId: null, suggested: false }],
        skipReasons: [], tdsBySection: [], unmapped: [], skipped: [],
      },
      payments: null, categories: ["Software"], batches: [], accountChoices: { "Director - Rakesh": "none" },
      bankAccounts: [{ id: "acc-1", name: "HDFC Current", last4: "4523", type: "current" }],
    };
    stubFetch(() => preview);
    render(<ZohoPurchaseImportDialog open onOpenChange={() => {}} />);
    const select = await screen.findByLabelText("App account for Director - Rakesh") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("none"));
    expect(screen.queryByText(/not chosen/)).toBeNull();
  });

  it("purchases: choosing where a Zoho account paid from saves it (saveAccount) too", async () => {
    const preview = {
      ok: true,
      purchases: {
        counts: { scanned: 1, import: 1, already: 0, skip: 0, voidOrDraft: 0, newVendors: 0 }, parts: { bills: 0, expenses: 1 },
        zohoByMonth: [], importByMonth: [], appByMonth: [], otherByMonth: [],
        accounts: [{ zohoName: "M/S. Main Bank Co", count: 1, amount: 500, appAccountId: null, suggested: false }],
        skipReasons: [], tdsBySection: [], unmapped: [], skipped: [],
      },
      payments: null, categories: ["Software"], batches: [],
      bankAccounts: [{ id: "acc-1", name: "HDFC Current", last4: "4523", type: "current" }],
    };
    const bodies = stubFetch((b) => (b.action === "preview" ? preview : { ok: true }));
    render(<ZohoPurchaseImportDialog open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText("App account for M/S. Main Bank Co"), { target: { value: "acc-1" } });
    await waitFor(() => expect(bodies.some((b) => b.action === "saveAccount")).toBe(true));
    expect(bodies.find((b) => b.action === "saveAccount")).toMatchObject({ zohoKey: "M/S. Main Bank Co", choice: "acc-1" });
  });
});
