// @vitest-environment jsdom
/* R-2853 (Pardeep, 16 Nov): "agar invoice subscription ka hai to uske neeche subscription period bhi show ho" —
   Customer → Transactions shows the subscription period under a subscription invoice's number; a part bill says
   its part; a one-time invoice shows nothing new. */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/customer-instalment-links", () => ({
  useCustomerInstalmentBillings: () => ({
    data: [{
      invoice_id: "INV-PART-2", subscription_id: "sub-1", period_index: 2,
      period_start: "2026-10-01", period_end: "2026-11-01", billing_cycle: "monthly", term_months: 12,
    }],
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }),
}));

import { CustomerTransactionsTab, type CustomerTransactionsTabProps } from "./customer-transactions-tab";

afterEach(cleanup);

const base = { net_payable: null, written_off_at: null, due_date: null, paid_amount: 0, status: "pending" };
const invoices = [
  { ...base, id: "INV-YEAR-1", quote_id: "Q-1", amount: 10000, invoice_date: "2026-10-01",
    line_items: [{ name: "Google Workspace Business Starter", service_period: { from: "2026-10-01", to: "2027-09-30", months: 12 } }] },
  { ...base, id: "INV-PART-2", quote_id: null, amount: 1000, invoice_date: "2026-10-01", line_items: [{ name: "Part 2" }] },
  { ...base, id: "INV-TOG-3", quote_id: "Q-3", amount: 20000, invoice_date: "2026-10-02",
    line_items: [
      { name: "Google Workspace Business Starter", subscription_id: "s1", service_period: { from: "2026-10-01", to: "2027-09-30", months: 12 } },
      { name: "Google Workspace Business Standard", subscription_id: "s2", service_period: { from: "2026-11-15", to: "2027-11-14", months: 12 } },
    ] },
  { ...base, id: "INV-ONEOFF-4", quote_id: "Q-4", amount: 5000, invoice_date: "2026-10-03",
    line_items: [{ name: "Setup fee", service_period: null }] },
];

function props(): CustomerTransactionsTabProps {
  return {
    customerId: "c1", linkOpts: { canQuotes: true }, canDeletePay: false, onDeletePayment: vi.fn(),
    invoices, payments: [], quotes: [], projects: [], projPayments: [], invoiceProject: {}, invoicePaidByProject: {},
    subs: [{ id: "sub-1", quote_id: null }], notes: { creditNotes: [], debitNotes: [] }, allPayments: [], creditRows: [],
    tdsInfo: {}, txnFilter: "invoices", setTxnFilter: vi.fn(),
    segments: [{ id: "invoices", label: "Invoices", n: 4 }], filteredTxns: [], hasTxns: true,
  };
}

const rowOf = (c: HTMLElement, id: string) => [...c.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(id))!;
const periodIn = (tr: Element) => tr.querySelector("[data-testid='invoice-period']")?.textContent ?? null;

describe("R-2853 Customer → Transactions: subscription period under the invoice number", () => {
  it("a yearly subscription invoice: '<plan> · 1 Oct 2026 – 30 Sep 2027'", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    expect(periodIn(rowOf(container, "INV-YEAR-1"))).toBe("Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027");
  });

  it("a part bill: 'Part 2 of 12 · 1–31 Oct 2026' from its billed part", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    expect(periodIn(rowOf(container, "INV-PART-2"))).toBe("Part 2 of 12 · 1–31 Oct 2026");
  });

  it("two subscriptions billed together: '2 subscriptions · earliest – latest'", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    expect(periodIn(rowOf(container, "INV-TOG-3"))).toBe("2 subscriptions · 1 Oct 2026 – 14 Nov 2027");
  });

  it("a one-time invoice shows no period line", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    expect(periodIn(rowOf(container, "INV-ONEOFF-4"))).toBeNull();
  });
});
