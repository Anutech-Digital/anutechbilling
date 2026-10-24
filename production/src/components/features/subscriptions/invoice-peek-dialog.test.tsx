// @vitest-environment jsdom
//
// R-1620: the Billing schedule's "Invoiced · INV-… · paid" chip opens that invoice in a
// popup. What is pinned here is what the owner does with it: click → the right invoice,
// Esc → gone, a failed read → a retry, and a role that cannot read invoices → plain text.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoicedChip } from "./billing-schedule-card";

let role = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role } }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const INVOICE = {
  id: "INV-5F40-27-0062", invoice_date: "2026-10-01", due_date: "2026-10-15",
  customer_name: "Sharma Traders", status: "paid", amount: 11800, net_payable: 11800, paid_amount: 11800,
  taxable_value: 10000, tax_amount: 1800, tax_rate: 18, inter_state: false,
  line_items: [{ name: "Google Workspace Business Starter", qty: 5, rate: 2000 }],
  quote_id: null, adjusted_advances: [], document_kind: null,
};
let failNext = 0;
let reads = 0;
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          reads++;
          if (failNext > 0) { failNext--; return { data: null, error: { message: "network down" } }; }
          return { data: INVOICE, error: null };
        },
      };
      return chain;
    },
  }),
}));

function renderChip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InvoicedChip inv={{ invoiceId: INVOICE.id, status: "paid" }} />
    </QueryClientProvider>,
  );
}

beforeEach(() => { role = "owner"; failNext = 0; reads = 0; });
afterEach(cleanup);

describe("Billing schedule invoice chip (R-1620)", () => {
  it("is a button that opens a popup with that invoice", async () => {
    renderChip();
    const chip = screen.getByRole("button", { name: /Invoiced · INV-5F40-27-0062 · paid/ });
    fireEvent.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("INV-5F40-27-0062");
    await waitFor(() => expect(dialog.textContent).toContain("Sharma Traders"));
    expect(dialog.textContent).toContain("Google Workspace Business Starter");
    // Same split the invoice page and PDF use (splitTaxHeads): 1,800 → 900 + 900.
    expect(dialog.textContent).toMatch(/CGST \(9%\)/);
    expect(dialog.textContent).toMatch(/SGST \(9%\)/);
    expect(dialog.textContent).toContain("Paid");
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeTruthy();
    const full = screen.getByRole("link", { name: /Open full invoice/ });
    expect(full.getAttribute("href")).toBe("/invoices/INV-5F40-27-0062");
  });

  it("closes on Esc", async () => {
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: /Invoiced ·/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a failed read says so and offers Try again, which reloads it", async () => {
    failNext = 1;
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: /Invoiced ·/ }));
    expect(await screen.findByText(/didn.t load/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Sharma Traders"));
    expect(reads).toBe(2);
  });

  it("a role that cannot read invoices sees plain text, not a dead button", () => {
    role = "delivery";
    renderChip();
    expect(screen.getByText(/Invoiced · INV-5F40-27-0062 · paid/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
