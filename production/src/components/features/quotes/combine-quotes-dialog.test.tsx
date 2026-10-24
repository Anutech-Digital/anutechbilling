// @vitest-environment jsdom
/* R-1527 — "Combine quotes into one": only accepted, un-invoiced quotes are listed; a quote
   that cannot join shows why; the confirm step lists the quotes and the total; the RPC gets
   exactly the ticked ids and the page opens the new quote. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const push = vi.fn();
const rpc = vi.fn();
const filters: Array<[string, string, unknown]> = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const base = {
  status: "accepted", invoice_id: null, superseded_by: null, payment_status: "awaiting",
  approval_status: "not_required", is_renewal: false, is_extension: false, is_add_seats: false,
  credit_activated_at: null, discount_pct: 0, currency: "INR", exchange_rate: 1, tax_rate: 18,
  billing_cycle: "yearly", is_one_off: false, payment_terms_days: null,
};
const rows = [
  { ...base, id: "Q-1", amount: 11800, plan: "Workspace Business", created_date: "2026-10-01" },
  { ...base, id: "Q-2", amount: 5901, plan: "Setup", created_date: "2026-10-02" },
  { ...base, id: "Q-3", amount: 1179, plan: "Zoho Mail", created_date: "2026-10-03" },
  { ...base, id: "Q-USD", amount: 1000, plan: "Consulting", created_date: "2026-10-04", currency: "USD" },
  { ...base, id: "Q-PAID", amount: 1180, plan: "Consulting", created_date: "2026-10-05", payment_status: "partial" },
];

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return chain; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return chain; },
      order: () => Promise.resolve({ data: rows, error: null }),
    };
    return { from: () => chain, rpc };
  },
}));

import { CombineQuotesDialog } from "./combine-quotes-dialog";

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CombineQuotesDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />
    </QueryClientProvider>,
  );

beforeEach(() => {
  push.mockReset(); rpc.mockReset(); filters.length = 0;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("R-1527 combine quotes dialog", () => {
  it("asks only for accepted quotes of this customer with no invoice and not replaced", async () => {
    renderIt();
    await screen.findByText("Q-1");
    expect(filters).toEqual(expect.arrayContaining([
      ["eq", "customer_id", "c1"], ["eq", "status", "accepted"], ["is", "invoice_id", null], ["is", "superseded_by", null],
    ]));
  });

  it("explains why a quote cannot join, and the button needs two quotes", async () => {
    renderIt();
    await screen.findByText("Q-PAID");
    expect(screen.getByText(/Money is already recorded on it/)).toBeTruthy();
    expect(screen.getByText(/Tick at least two quotes/)).toBeTruthy();

    fireEvent.click(document.getElementById("combine-Q-1")!);
    await waitFor(() => expect(screen.getByText(/Different currency from Q-1/)).toBeTruthy());
    expect((document.getElementById("combine-Q-USD") as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms the list and total, sends exactly the ticked ids, opens the new quote", async () => {
    rpc.mockResolvedValue({
      data: { quote_id: "Q-NEW", combined: ["Q-1", "Q-2", "Q-3"], subtotal: 16000, tax: 2880, amount: 18880, sum_of_quotes: 18880 },
      error: null,
    });
    renderIt();
    await screen.findByText("Q-1");
    for (const id of ["Q-1", "Q-2", "Q-3"]) fireEvent.click(document.getElementById(`combine-${id}`)!);
    fireEvent.click(await screen.findByRole("button", { name: /Combine 3 quotes/ }));

    const confirm = await screen.findByTestId("combine-confirm");
    expect(confirm.textContent).toMatch(/Q-1/);
    expect(confirm.textContent).toMatch(/₹18,880/);

    fireEvent.click(screen.getByRole("button", { name: /Make one quote/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("combine_quotes", { p_quote_ids: ["Q-1", "Q-2", "Q-3"] }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/Q-NEW"));
  });

  it("a refusal from the server goes back to the list and changes nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Quote Q-2 has a payment or advance (receipt voucher) recorded." } });
    renderIt();
    await screen.findByText("Q-1");
    fireEvent.click(document.getElementById("combine-Q-1")!);
    fireEvent.click(document.getElementById("combine-Q-2")!);
    fireEvent.click(await screen.findByRole("button", { name: /Combine 2 quotes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Make one quote/ }));
    await waitFor(() => expect(screen.getByTestId("combine-list")).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });
});
