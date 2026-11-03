// @vitest-environment jsdom
/* R-2292 — the Manage seats preview names the rate it uses and where it came from, warns when the
   last invoice for the item billed a different rate (> ₹5/seat/year), and lets the operator type
   the rate for this quote only — which is what the server is sent. */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { Subscription } from "@/lib/supabase/database.types";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries/customers", () => ({ useCustomer: () => ({ data: null }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantStateCode: "07", tenantGstin: null } }) }));
const expected = vi.hoisted(() => ({ value: null as null | { annualPerSeat: number; invoiceId: string; invoiceDate: string } }));
vi.mock("./use-expected-seat-rate", () => ({ useExpectedSeatRate: () => ({ data: expected.value }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-01" }));

import AddSeatsDialog from "./add-seats-dialog";

afterEach(cleanup);
beforeEach(() => { expected.value = null; });

/* 34 seats at ₹8,917/mo → ₹3,147/seat/year from the subscription (the staging case's rate). */
const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: null, customer_name: "E2E Test Co", domain: "testco.example",
  plan: "Google Workspace Business Starter", vendor: "google", seats: 34, used: 0, mrr: 8917, status: "active",
  start_date: "2026-11-01", renewal_date: "2027-10-31", term_months: 12, billing_cycle: "yearly",
  item_id: null, quote_id: "Q-SALE", renewal_quote_id: null,
} as unknown as Subscription;

const show = () => render(<AddSeatsDialog sub={sub} open onOpenChange={() => {}} />);

describe("Manage seats — rate and its source (R-2292)", () => {
  it("shows the rate and that it comes from the subscription", () => {
    show();
    expect(screen.getByTestId("add-seats-rate-source").textContent).toBe("From this subscription (₹8,917/mo ÷ 34 seats × 12)");
    expect(document.body.textContent).toContain("₹3,147");
    expect(screen.queryByTestId("add-seats-rate-warning")).toBeNull();
  });

  it("warns when the last invoice billed a different rate, with both numbers; 'Use' types it in", () => {
    expected.value = { annualPerSeat: 3055, invoiceId: "INV-0042", invoiceDate: "2026-06-01" };
    show();
    const warn = screen.getByTestId("add-seats-rate-warning");
    expect(warn.textContent).toContain("₹3,147");
    expect(warn.textContent).toContain("₹3,055");
    expect(warn.textContent).toContain("INV-0042");
    fireEvent.click(screen.getByRole("button", { name: "Use ₹3,055" }));
    expect((screen.getByLabelText("Rate for this quote (₹/seat/year)") as HTMLInputElement).value).toBe("3055");
    expect(screen.queryByTestId("add-seats-rate-warning")).toBeNull();
    expect(screen.getByTestId("add-seats-rate-source").textContent).toBe("Typed for this quote only (subscription rate ₹3,147 stays)");
  });

  it("no warning within ₹5", () => {
    expected.value = { annualPerSeat: 3150, invoiceId: "INV-0043", invoiceDate: "2026-06-01" };
    show();
    expect(screen.queryByTestId("add-seats-rate-warning")).toBeNull();
  });

  it("a typed rate changes the quote and is sent to the server; the new MRR stays at the stored rate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ quoteId: "Q-1", amount: 1, newSeats: 35, newMrr: 9179, poId: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      show();
      const before = document.body.textContent ?? "";
      expect(before).toContain("₹9,179/mo");
      fireEvent.change(screen.getByLabelText("Rate for this quote (₹/seat/year)"), { target: { value: "3055" } });
      const after = document.body.textContent ?? "";
      expect(after).toContain("₹9,179/mo");               // subscription's rate unchanged
      expect(after).not.toBe(before);                      // the quote figures moved
      fireEvent.click(screen.getByRole("button", { name: "Add 1 seat" }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body.annual_rate_per_seat).toBe(3055);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a bad rate blocks the add with a plain message", () => {
    show();
    fireEvent.change(screen.getByLabelText("Rate for this quote (₹/seat/year)"), { target: { value: "30.5" } });
    expect(document.body.textContent).toContain("Enter the rate in whole rupees per seat per year");
    expect((screen.getByRole("button", { name: "Add 1 seat" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/* R-2372 — "Also draft a purchase order" is an explicit, unticked-by-default choice. */
describe("Manage seats — purchase order only when chosen (R-2372)", () => {
  const post = async (tick: boolean) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ quoteId: "Q-1", amount: 1, newSeats: 35, newMrr: 9179, poId: tick ? "PO-1" : null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      show();
      const box = screen.getByRole("checkbox", { name: /Also draft a purchase order/ }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      if (tick) fireEvent.click(box);
      fireEvent.click(screen.getByRole("button", { name: "Add 1 seat" }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("unticked by default → the server is told NOT to draft a PO", async () => {
    expect((await post(false)).draft_purchase_order).toBe(false);
  });

  it("ticked → the server is asked to draft one", async () => {
    expect((await post(true)).draft_purchase_order).toBe(true);
  });
});
