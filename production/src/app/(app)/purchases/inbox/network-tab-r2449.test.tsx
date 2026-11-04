// @vitest-environment jsdom
/**
 * R-2449 (G-NETWORK N2b) — Purchases → Inbox "From network": the owner's path.
 * Excel issues an invoice to Anutech → Anutech's owner opens the tab, sees it Pending, accepts it
 * with a category (one bill; the row then says "Accepted — bill <id>"), and rejects another with a
 * reason (refused without one). Only owner / manager / accountant see the tab.
 * The list is the buyer's own: it comes from network_inbox, which reads current_tenant_id() — the
 * screen passes no company at all (proved here) and the SQL proof is r2434_network_documents.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ role: "owner" as string | null, docs: [] as Record<string, unknown>[] }));
const net = vi.hoisted(() => ({
  list: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  undo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/purchases/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: state.role === null ? null : { role: state.role }, isLoading: false }),
}));
vi.mock("@/lib/queries/inbound-purchases", () => ({
  useInboundPurchases: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
  useImportPurchase: () => ({ mutateAsync: vi.fn() }),
  useIgnorePurchase: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/queries/vendor-bills", () => ({
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
  useOwnStateCode: () => ({ data: "07" }),
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/supabase/client", () => ({
  /* the vendor's default category lookup (vendors by GSTIN) */
  createClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [{ default_category: "COGS-M365" }], error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/network/documents", async (orig) => {
  const real = await orig<typeof import("@/lib/network/documents")>();
  return {
    ...real,
    listNetworkInbox: net.list,
    acceptNetworkDocument: net.accept,
    rejectNetworkDocument: net.reject,
    undoNetworkAccept: net.undo,
  };
});

import PurchaseInboxPage from "./page";
import { toInboxDoc } from "@/lib/network/documents";

const row = (p: Record<string, unknown>) => ({
  id: "d1", kind: "invoice", status: "pending", seller_name: "Excel Pvt Ltd", seller_gstin: "07AAACE1234F1Z5",
  doc_number: "EX-001", doc_date: "2026-11-04", fy: "2026-27", document_type: "tax_invoice",
  taxable_value: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800, currency: "INR",
  seller_invoice_id: "EX-001", parent_document_id: null, reject_reason: null, vendor_bill_id: null,
  linked_existing: false, apply_note: null, created_at: "2026-11-04T05:00:00Z", responded_at: null,
  payload: { lines: [{ description: "Workspace Starter", hsn_sac: "998315", quantity: 10, rate: 1000, amount: 10000 }] },
  ...p,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PurchaseInboxPage /></QueryClientProvider>);
}
const networkTab = () => screen.queryByRole("tab", { name: /From network/ });
async function openNetwork() {
  const t = await waitFor(() => { const x = networkTab(); expect(x).not.toBeNull(); return x!; });
  fireEvent.click(t);
}

beforeEach(() => {
  state.role = "owner";
  state.docs = [row({})];
  net.list.mockReset().mockImplementation(async () => state.docs.map(toInboxDoc));
  net.accept.mockReset();
  net.reject.mockReset();
  net.undo.mockReset();
});
afterEach(cleanup);

describe("R-2449 who sees From network", () => {
  it.each(["owner", "manager", "accountant"])("%s sees the tab with the pending count", async (role) => {
    state.role = role;
    mount();
    await openNetwork();
    expect(await screen.findByText("Excel Pvt Ltd")).toBeTruthy();
    expect(networkTab()!.textContent).toMatch(/1/);
  });
  it.each(["billing", "sales", "support", null])("%s sees no tab and nothing is asked for", async (role) => {
    state.role = role;
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(networkTab()).toBeNull();
    expect(net.list).not.toHaveBeenCalled();
  });
});

describe("R-2449 the list — only my own copies, every fact the seller froze", () => {
  it("asks network_inbox with no company (the database scopes it to my tenant) and shows seller, GSTIN, number, amounts, lines", async () => {
    mount();
    await openNetwork();
    await screen.findByText("Excel Pvt Ltd");
    expect(net.list).toHaveBeenCalledWith();
    expect(screen.getByText("07AAACE1234F1Z5")).toBeTruthy();
    expect(screen.getByText("EX-001")).toBeTruthy();
    expect(screen.getByText("₹10,000")).toBeTruthy();
    expect(screen.getByText("₹1,800")).toBeTruthy();
    expect(screen.getByText("₹11,800")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 line/ }));
    expect(screen.getByText(/Workspace Starter/)).toBeTruthy();
  });

  it("a cancelled copy is greyed with no Accept; a credit note sits under its invoice and waits for it", async () => {
    state.docs = [
      row({}),
      row({ id: "c1", kind: "credit_note", doc_number: "CN-1", parent_document_id: "d1", total: 1180, taxable_value: 1000, cgst: 90, sgst: 90 }),
      row({ id: "x1", doc_number: "EX-002", status: "cancelled" }),
    ];
    mount();
    await openNetwork();
    fireEvent.click(await screen.findByRole("tab", { name: /^All/ }));
    const cancelled = screen.getByText("EX-002").closest("tr")!;
    expect(cancelled.className).toMatch(/opacity/);
    expect(within(cancelled).getByText("Cancelled by the seller")).toBeTruthy();
    expect(within(cancelled).queryByRole("button", { name: /Accept/ })).toBeNull();
    const note = screen.getByText("CN-1").closest("tr")!;
    const acceptNote = within(note).getByRole("button", { name: /Accept/ }) as HTMLButtonElement;
    expect(acceptNote.disabled).toBe(true);
    expect(within(note).getByText("Accept invoice EX-001 first.")).toBeTruthy();
  });
});

describe("R-2449 Accept → one bill", () => {
  it("defaults the category to the vendor's own, says the GST is credit, and the row then names the bill", async () => {
    net.accept.mockImplementation(async () => {
      state.docs = [row({ status: "accepted", vendor_bill_id: "VB-NET-1A2B" })];
      return { documentId: "d1", vendorBillId: "VB-NET-1A2B", linkedExisting: false, note: null };
    });
    mount();
    await openNetwork();
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const dlg = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dlg).getByRole("combobox").textContent).toContain("COGS-M365"));
    expect(within(dlg).getByText("GST ₹1,800 will be your input credit (ITC).")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Accept and create bill" }));
    await waitFor(() => expect(net.accept).toHaveBeenCalledTimes(1));
    expect(net.accept).toHaveBeenCalledWith("d1", "COGS-M365");
    fireEvent.click(await screen.findByRole("tab", { name: /^All/ }));
    expect(await screen.findByText("Accepted — bill VB-NET-1A2B")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open bill/ }).getAttribute("href")).toBe("/accounting/bills?q=EX-001&from=2026-04-01");
  });

  it("a database refusal stays in the dialog with its next step (no bill, no silent close)", async () => {
    net.accept.mockRejectedValue(new Error("Your connection with Excel Pvt Ltd no longer shares invoices (or a GSTIN is no longer proved) — record this document by hand from the copy."));
    mount();
    await openNetwork();
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Accept and create bill" }));
    expect(await within(dlg).findByText(/record this document by hand from the copy/)).toBeTruthy();
  });
});

describe("R-2449 Reject needs a reason", () => {
  it("refuses an empty reason, then sends the typed one", async () => {
    net.reject.mockImplementation(async () => { state.docs = [row({ status: "rejected", reject_reason: "Wrong rate" })]; });
    mount();
    await openNetwork();
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject invoice" }));
    expect(await within(dlg).findByText("Write the reason — the seller sees it on their invoice.")).toBeTruthy();
    expect(net.reject).not.toHaveBeenCalled();
    fireEvent.change(within(dlg).getByLabelText(/Reason/), { target: { value: "  Wrong rate " } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject invoice" }));
    await waitFor(() => expect(net.reject).toHaveBeenCalledWith("d1", "Wrong rate"));
    fireEvent.click(await screen.findByRole("tab", { name: /^All/ }));
    expect(await screen.findByText("Rejected: Wrong rate")).toBeTruthy();
  });
});
