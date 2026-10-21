// @vitest-environment jsdom
/* R-1705 — the subscription drawer shows added seats whose pro-rata quote is still unpaid. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const SUB = "ecef869d-0c03-4b19-af8a-bb5843e6a9ae";
const rows = [
  {
    id: "Q-F588-27-0031", customer_id: "c1", customer_name: "T-A1", plan: "Business Starter", seats: 1,
    amount: 3813, payment_amount: null, status: "sent", payment_status: "awaiting", invoice_id: null,
    is_add_seats: true, superseded_by: null, add_seats_subscription_id: SUB, add_seats_taken_back_at: null, notes: null,
  },
  {
    id: "Q-OTHER", customer_id: "c1", customer_name: "T-A1", plan: "Business Starter", seats: 2,
    amount: 5000, payment_amount: null, status: "sent", payment_status: "awaiting", invoice_id: null,
    is_add_seats: true, superseded_by: null, add_seats_subscription_id: "sub-other", add_seats_taken_back_at: null, notes: null,
  },
];
/* Chainable stub of supabase.from("quotes").select(...).eq().in().is().is().is() */
const chain: Record<string, unknown> = {};
for (const m of ["select", "eq", "in", "is"]) chain[m] = () => chain;
(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => chain }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));

import { SeatQuotesPending } from "./seat-quotes-pending";

function renderIt(subscriptionId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SeatQuotesPending subscriptionId={subscriptionId} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("R-1705 SeatQuotesPending (subscription drawer)", () => {
  it("shows this subscription's unpaid seat quote, with a link to the quote", async () => {
    renderIt(SUB);
    await waitFor(() => expect(screen.getByText("Seat quote pending ₹3,813 · +1 seat")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Q-F588-27-0031" }).getAttribute("href")).toBe("/quotes/Q-F588-27-0031");
    expect(screen.queryByText(/Q-OTHER/)).toBeNull();
    expect(screen.getByText(/reject it to take the seats and MRR back/)).toBeTruthy();
  });

  it("renders nothing for a subscription with no open seat quote", async () => {
    const { container } = renderIt("sub-none");
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });
});
