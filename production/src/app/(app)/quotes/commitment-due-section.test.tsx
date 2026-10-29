// @vitest-environment jsdom
/**
 * R-2046 — the "Commitment due" strip and section on the Quotes list: columns, total, and the
 * two existing actions (Record payment, Customer stopped) keyed by each row's own quote id.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { CommitmentDueSection, CommitmentDueStrip } from "./commitment-due-section";
import type { CommitmentDueRow } from "./commitment-due";

afterEach(cleanup);

const rows: CommitmentDueRow[] = [
  {
    quoteId: "Q-A", customerId: "c-a", customerName: "Alpha Traders",
    period: "Advance payment for Q1 · 1 Oct–31 Dec 2026", amount: 2443, stillDue: 2443, partPaid: false,
    billOn: "2026-10-01", due: { days: 27, text: "27 days overdue", tone: "overdue" },
  },
  {
    quoteId: "Q-B", customerId: null, customerName: "Beta Apps",
    period: "Advance payment for Q2 · 28 Oct–27 Jan 2027", amount: 4814, stillDue: 3814, partPaid: true,
    billOn: "2026-10-28", due: { days: 0, text: "Due today", tone: "today" },
  },
];

function setup(over: Partial<React.ComponentProps<typeof CommitmentDueSection>> = {}) {
  const onRecordPayment = vi.fn();
  const onCustomerStopped = vi.fn();
  const onClose = vi.fn();
  render(
    <CommitmentDueSection
      rows={rows}
      total={2443 + 3814}
      mayRecordMoney
      onRecordPayment={onRecordPayment}
      onCustomerStopped={onCustomerStopped}
      onClose={onClose}
      {...over}
    />,
  );
  return { onRecordPayment, onCustomerStopped, onClose };
}

describe("CommitmentDueSection", () => {
  it("shows the columns and the total still due at the top", () => {
    setup();
    const table = screen.getByRole("table");
    for (const h of ["Customer", "Period", "Amount (incl. GST)", "Days overdue", "Action"]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeTruthy();
    }
    expect(screen.getByTestId("commitment-total").textContent).toContain("6,257");
    expect(screen.getByText(/2 payment requests/)).toBeTruthy();
    expect(within(table).getByText("Alpha Traders")).toBeTruthy();
    expect(within(table).getByText("Advance payment for Q1 · 1 Oct–31 Dec 2026")).toBeTruthy();
    expect(within(table).getByText("27 days overdue")).toBeTruthy();
    expect(within(table).getByText("Due today")).toBeTruthy();
    expect(within(table).getByText(/3,814 still due/)).toBeTruthy();
  });

  it("Record payment and Customer stopped act on the row's own quote", () => {
    const { onRecordPayment, onCustomerStopped } = setup();
    const rowsEls = screen.getAllByRole("row").slice(1);
    fireEvent.click(within(rowsEls[1]).getByRole("button", { name: /record payment/i }));
    expect(onRecordPayment).toHaveBeenCalledWith("Q-B");
    fireEvent.click(within(rowsEls[0]).getByRole("button", { name: /customer stopped/i }));
    expect(onCustomerStopped).toHaveBeenCalledWith("Q-A");
  });

  it("Customer stopped is not offered once money came in (same rule as the quote page)", () => {
    setup();
    const rowsEls = screen.getAllByRole("row").slice(1);
    expect(within(rowsEls[1]).queryByRole("button", { name: /customer stopped/i })).toBeNull();
  });

  it("no money role → no money buttons, the quote is still one click away", () => {
    setup({ mayRecordMoney: false });
    expect(screen.queryByRole("button", { name: /record payment/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /customer stopped/i })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Q-A" }).length).toBeGreaterThan(0);
  });

  it("empty → says nothing is due and offers the way back", () => {
    const { onClose } = setup({ rows: [], total: 0 });
    expect(screen.getByText(/No part payment requests are due/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show all quotes/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommitmentDueStrip", () => {
  it("is silent at zero", () => {
    const { container } = render(<CommitmentDueStrip count={0} total={0} onShow={() => {}} />);
    expect(container.textContent).toBe("");
  });
  it("names the count and the total and opens the list", () => {
    const onShow = vi.fn();
    render(<CommitmentDueStrip count={2} total={6257} onShow={onShow} />);
    expect(screen.getByText(/2 part payment requests unpaid/)).toBeTruthy();
    expect(screen.getByText(/6,257/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /commitment due/i }));
    expect(onShow).toHaveBeenCalled();
  });
});
