// @vitest-environment jsdom
/* R-1531 — the /compliance card: the list with links + last day; nothing when none; an error says so. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { revisedInvoiceReminder, type RevisedInvoiceBill } from "@/lib/compliance/revised-invoice";

const state = vi.hoisted(() => ({ q: {} as Record<string, unknown> }));
vi.mock("@/lib/compliance/revised-invoice-query", () => ({ useRevisedInvoiceReminder: () => state.q }));
vi.mock("@/components/shared/load-error", () => ({
  LoadErrorInline: ({ what, onRetry }: { what: string; onRetry: () => void }) => (
    <div role="alert">{what} didn&apos;t load.<button onClick={onRetry}>Try again</button></div>
  ),
}));

import { RevisedInvoiceCard } from "./revised-invoice-card";

const bill = (id: string, invoice_date: string, amount = 5000): RevisedInvoiceBill => ({
  id, invoice_date, amount, taxable_value: amount, status: "paid", customer_name: "Acme Traders",
  document_kind: "bill_of_supply", supplier_gst_status: "unregistered",
});
const base = { isLoading: false, error: null, rcDateColumn: true, refetch: vi.fn() };

afterEach(cleanup);

describe("RevisedInvoiceCard", () => {
  it("lists each bill with a link, the total and the last day", () => {
    state.q = {
      ...base,
      reminder: revisedInvoiceReminder({
        settings: { saved: "registered", registeredFrom: "2026-09-01", rcDate: "2026-10-10" },
        bills: [bill("BOS-AB-2627-0001", "2026-09-05", 100000), bill("BOS-AB-2627-0002", "2026-09-20", 2500)],
        today: "2026-10-19",
      }),
    };
    const { container } = render(<RevisedInvoiceCard />);
    expect(screen.getByRole("heading", { name: "Issue revised tax invoices for 2 Bills of Supply" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "BOS-AB-2627-0001" }).getAttribute("href")).toBe("/invoices/BOS-AB-2627-0001");
    const text = container.textContent ?? "";
    expect(text).toContain("Last day: 10 Nov 2026 (22d left).");
    expect(text).toContain("Section 31(3)(a)");
    expect(text).toMatch(/2 bills/);
    expect(text).toContain("1,02,500");
    expect(container.querySelector("#revised-invoices")).not.toBeNull();
  });

  it("without a certificate date: asks for it in Settings", () => {
    state.q = {
      ...base,
      reminder: revisedInvoiceReminder({
        settings: { saved: "registered", registeredFrom: "2026-09-01", rcDate: null },
        bills: [bill("BOS-1", "2026-10-15")],
        today: "2026-10-19",
      }),
    };
    render(<RevisedInvoiceCard />);
    expect(screen.getByRole("link", { name: /Settings → Company → GST registration/ }).getAttribute("href")).toBe("/settings?tab=company");
    expect(screen.getByText("Add certificate date")).toBeTruthy();
  });

  it("nothing to revise: renders nothing", () => {
    state.q = { ...base, reminder: null };
    const { container } = render(<RevisedInvoiceCard />);
    expect(container.innerHTML).toBe("");
  });

  it("read failed: an alert with Try again, never silence", () => {
    const refetch = vi.fn();
    state.q = { ...base, reminder: null, error: new Error("boom"), refetch };
    render(<RevisedInvoiceCard />);
    expect(screen.getByRole("alert").textContent).toMatch(/Revised-invoice check/);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
