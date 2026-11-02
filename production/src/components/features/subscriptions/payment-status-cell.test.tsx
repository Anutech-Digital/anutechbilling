// @vitest-environment jsdom
// R-2382 — the Payment cell (two lines, colour by status) and the Paid · Due · Overdue chips.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PaymentStatusCell, PaymentFilterChips } from "./payment-status-cell";
import { subscriptionPaymentStatus, type PaymentStatusSub } from "@/lib/subscriptions/payment-status";

afterEach(cleanup);

const TODAY = "2026-11-02";
const SUB: PaymentStatusSub = {
  id: "s1", status: "active", outstanding_amount: 0, renewal_date: "2027-03-01", start_date: "2026-03-01",
  quote_id: "q1", renewal_quote_id: null,
};

describe("PaymentStatusCell", () => {
  it("paid: one green line", () => {
    const { container } = render(<PaymentStatusCell status={subscriptionPaymentStatus({ sub: SUB, today: TODAY })} />);
    const line = screen.getByText("Paid till 1 Mar 2027");
    expect(line.className).toContain("text-emerald");
    expect(container.querySelector("[data-payment-kind='paid']")).not.toBeNull();
    expect(container.querySelectorAll("[data-payment-kind] > div")).toHaveLength(1);
  });

  it("overdue: red amount + small 'since … · N days' line", () => {
    render(<PaymentStatusCell status={subscriptionPaymentStatus({
      sub: { ...SUB, outstanding_amount: 14406 },
      due: { paid_amount: 0, pay_by: "2026-10-03", age_from: "2026-10-03" },
      today: TODAY,
    })} />);
    expect(screen.getByText("Due ₹14,406").className).toContain("text-rose");
    expect(screen.getByText("since 3 Oct 2026 · 30 days")).toBeTruthy();
  });

  it("request sent: amber", () => {
    render(<PaymentStatusCell status={subscriptionPaymentStatus({
      sub: { ...SUB, renewal_quote_id: "rq" },
      renewalQuote: { id: "rq", status: "sent", payment_status: null, amount: 900, created_date: "2026-10-30" },
      today: TODAY,
    })} />);
    expect(screen.getByText("Request sent 30 Oct 2026").className).toContain("text-amber-ink");
  });

  it("no bill: grey", () => {
    render(<PaymentStatusCell status={subscriptionPaymentStatus({ sub: { ...SUB, quote_id: null }, today: TODAY })} />);
    expect(screen.getByText("No bill for this period").className).toContain("text-ink-3");
  });
});

describe("PaymentFilterChips", () => {
  it("shows the three chips with counts; clicking picks, clicking again clears", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PaymentFilterChips counts={{ paid: 5, due: 3, overdue: 2 }} value="" onChange={onChange} />);
    const due = screen.getByRole("button", { name: /Due\s*3/ });
    expect(due.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Paid\s*5/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Overdue\s*2/ })).toBeTruthy();
    fireEvent.click(due);
    expect(onChange).toHaveBeenLastCalledWith("due");
    rerender(<PaymentFilterChips counts={{ paid: 5, due: 3, overdue: 2 }} value="due" onChange={onChange} />);
    const on = screen.getByRole("button", { name: /Due\s*3/ });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(on);
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
