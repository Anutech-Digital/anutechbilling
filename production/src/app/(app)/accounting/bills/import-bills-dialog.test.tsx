// @vitest-environment jsdom
/* R-2324 — Bills → "Import bills": upload the sample CSV (made-up vendor), see the preview with the
   unknown vendor listed, import → ONE vendor_bills insert carrying every good bill (atomic per
   file) with the company's tenant_id; a bill already in the books is skipped and listed. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SAMPLE_BILL_CSV } from "@/lib/accounting/bill-import";

const state = vi.hoisted(() => ({
  insert: vi.fn(),
  existing: [] as Array<{ vendor_id: string | null; vendor_name: string; bill_no: string | null }>,
}));

vi.mock("@/lib/queries/vendors", () => ({
  useVendors: () => ({ data: [{ id: "v-mehta", name: "Mehta Cloud Distributors", gstin: null, default_category: "COGS-Workspace" }] }),
}));
vi.mock("@/lib/queries/vendor-bills", () => ({ useOwnStateCode: () => ({ data: "27" }) }));
vi.mock("@/lib/ops/fetch-all", () => ({ fetchAllRows: async () => state.existing }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      if (table === "users") return { select: () => ({ eq: () => ({ single: async () => ({ data: { tenant_id: "t-e2e" }, error: null }) }) }) };
      return { insert: async (rows: unknown) => { state.insert(table, rows); return { error: null }; } };
    },
  }),
}));

import { ImportBillsDialog } from "./import-bills-dialog";

afterEach(cleanup);
beforeEach(() => { state.insert.mockReset(); state.existing = []; });

const renderDialog = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <ImportBillsDialog open onOpenChange={() => {}} />
  </QueryClientProvider>,
);
const upload = (text: string) => {
  const file = new File([text], "bills.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(screen.getByLabelText(/Choose the bills CSV/), { target: { files: [file] } });
};

describe("R-2324 ImportBillsDialog", () => {
  it("sample file: 3 bills previewed, unknown vendor listed, one insert of 3 rows", async () => {
    renderDialog();
    upload(SAMPLE_BILL_CSV);
    expect((await screen.findByTestId("bill-import-summary")).textContent).toContain("3 bills to import · ₹88,500");
    expect(screen.getByText(/Vendor "T-Unknown Supplier" not found/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import 3 bills" }));
    await screen.findByText(/3 bills imported — ₹88,500/);
    expect(state.insert).toHaveBeenCalledTimes(1);
    const [table, rows] = state.insert.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(table).toBe("vendor_bills");
    expect(rows.map((r) => [r.bill_no, r.total, r.tenant_id, r.vendor_id, r.status])).toEqual([
      ["MCD-24001", 47200, "t-e2e", "v-mehta", "unpaid"],
      ["MCD-24002", 29500, "t-e2e", "v-mehta", "unpaid"],
      ["MCD-24003", 11800, "t-e2e", "v-mehta", "unpaid"],
    ]);
  });

  it("uploading again: bills already in the books are skipped, not added twice", async () => {
    state.existing = [
      { vendor_id: "v-mehta", vendor_name: "Mehta Cloud Distributors", bill_no: "MCD-24001" },
      { vendor_id: "v-mehta", vendor_name: "Mehta Cloud Distributors", bill_no: "MCD-24002" },
    ];
    renderDialog();
    upload(SAMPLE_BILL_CSV);
    expect((await screen.findByTestId("bill-import-summary")).textContent).toContain("1 bill to import");
    expect(screen.getByText("2 already in the books")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 bill" }));
    await waitFor(() => expect(state.insert).toHaveBeenCalledTimes(1));
    expect((state.insert.mock.calls[0][1] as unknown[]).length).toBe(1);
    expect((await screen.findByText(/Skipped \(already in the books\):/)).textContent).toContain("MCD-24001, MCD-24002");
  });

  it("a file without the needed columns says which are missing", async () => {
    renderDialog();
    upload("Name,Amount\nT-X,100\n");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Vendor Name, Bill Number, Bill Date/);
  });
});
