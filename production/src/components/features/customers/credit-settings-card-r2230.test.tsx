// @vitest-environment jsdom
//
// R-2230 (Zoho Billing audit A6): the customer page said "Unpaid invoices now ₹0" next to
// Outstanding ₹1,632 — the ₹1,632 was a part payment request, which has no invoice until paid.
// "Unpaid now" counts open part requests too (the same sum activate_quote_on_credit uses).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CreditSettingsCard } from "./credit-settings-card";
import { PartRequestChip } from "@/components/features/subscriptions/billing-schedule-card";

let invoices: unknown[] = [];
let requests: unknown[] | null | undefined = [];
vi.mock("@/lib/credit/queries", () => ({
  useCustomerOpenInvoices: () => ({ data: invoices }),
  useCustomerOpenPartRequests: () => ({ data: requests }),
  useUpdateCustomerCredit: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));

afterEach(() => { cleanup(); invoices = []; requests = []; });

const REQ = {
  quote_id: "Q-27-0101", customer_id: "c1", subscription_id: "S1", billing_id: "B1", term_start: "2026-08-01",
  period_index: 2, due_on: "2026-11-16", still_due: 1632, is_lead: true,
};

describe("R-2230 — customer page Unpaid now", () => {
  it("₹0 invoices + a ₹1,632 part request → Unpaid now ₹1,632 with its due date", () => {
    requests = [REQ];
    render(<CreditSettingsCard customer={{ id: "c1", allow_pay_later: true, credit_limit: 1000 }} isOwner />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Unpaid now: ₹1,632/);
    expect(text).toMatch(/invoices ₹0 \+ payment requests ₹1,632, due from 16 Nov 2026/);
    expect(text).toMatch(/above the limit/);
    expect(text).not.toMatch(/Unpaid invoices now: ₹0/);
  });

  it("no requests → just the invoices", () => {
    invoices = [{ id: "INV-1", status: "pending", amount: 1180, net_payable: 1180, paid_amount: 0 }];
    render(<CreditSettingsCard customer={{ id: "c1", allow_pay_later: true, credit_limit: null }} isOwner />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Unpaid now: ₹1,180/);
    expect(text).not.toMatch(/payment requests/);
  });
});

describe("R-2230 — billing schedule (subscription drawer) part request chip", () => {
  it("shows the request, what it owes and the due date; red when overdue", () => {
    const { container, rerender } = render(<PartRequestChip req={REQ} todayISO="2026-11-02" />);
    expect(container.textContent).toBe("Payment request Q-27-0101 · ₹1,632 due 16 Nov 2026");
    rerender(<PartRequestChip req={{ ...REQ, due_on: "2026-10-28" }} todayISO="2026-11-02" />);
    expect(container.textContent).toMatch(/5 days overdue \(due 28 Oct 2026\)/);
  });
});
