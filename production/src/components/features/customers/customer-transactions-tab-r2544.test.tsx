// @vitest-environment jsdom
/* R-2544 (Pardeep, 6 Nov): Customer → Transactions shows each payment under the invoice it paid;
   money not against an invoice sits in "Advance / not yet against an invoice"; Payments has "For". */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/customer-instalment-links", () => ({
  useCustomerInstalmentBillings: () => ({ data: [{ invoice_id: "INV-I1", subscription_id: "sub-1" }], isError: false, error: null, refetch: vi.fn() }),
}));

import { CustomerTransactionsTab, ADVANCE_GROUP_TITLE, type CustomerTransactionsTabProps, type FlatTxn } from "./customer-transactions-tab";

afterEach(cleanup);

const baseInv = { net_payable: null, written_off_at: null, due_date: null };
const invoices = [
  { ...baseInv, id: "INV-A378-27-0100", quote_id: "Q-1", amount: 10000, paid_amount: 10000, status: "paid", invoice_date: "2026-09-01" },
  { ...baseInv, id: "INV/25-26/1913", quote_id: null, amount: 89208, paid_amount: 89208, status: "paid", invoice_date: "2026-01-05" },
  { ...baseInv, id: "INV-I1", quote_id: null, amount: 3000, paid_amount: 1000, status: "pending", invoice_date: "2026-10-01" },
];
const p = (o: Record<string, unknown>) => ({ quote_id: null, invoice_id: null, status: "received", refunded_at: null, reference: null, method: "bank_transfer", receipt_voucher_no: null, ...o }) as CustomerTransactionsTabProps["payments"][number];
const payments = [
  p({ id: "p1", quote_id: "Q-1", amount: 4000, received_at: "2026-09-05T05:00:00Z", receipt_voucher_no: "RV-A378-27-0168" }),
  p({ id: "p2", quote_id: "Q-1", amount: 6000, received_at: "2026-09-19T05:00:00Z", receipt_voucher_no: "RV-A378-27-0170" }),
  p({ id: "pz", invoice_id: "INV/25-26/1913", amount: 89208, received_at: "2026-01-05T05:00:00Z", receipt_voucher_no: "RV-Z-7097" }),
  p({ id: "ps", quote_id: "Q-S", amount: 1000, received_at: "2026-10-05T05:00:00Z", receipt_voucher_no: "RV-S-1" }),
  p({ id: "padv", quote_id: "Q-2", amount: 2500, received_at: "2026-10-20T05:00:00Z", receipt_voucher_no: "RV-ADV-1" }),
];
const quotes = [
  { id: "Q-1", invoice_id: "INV-A378-27-0100", created_date: "2026-08-20", amount: 10000, status: "accepted" },
  { id: "Q-2", invoice_id: null, created_date: "2026-10-18", amount: 9000, status: "accepted" },
  { id: "Q-S", invoice_id: null, created_date: "2026-06-01", amount: 36000, status: "accepted" },
];

function props(over: Partial<CustomerTransactionsTabProps> = {}): CustomerTransactionsTabProps {
  return {
    customerId: "c1", linkOpts: { canQuotes: true }, canDeletePay: false, onDeletePayment: vi.fn(),
    invoices, payments, quotes, projects: [], projPayments: [], invoiceProject: {}, invoicePaidByProject: {},
    subs: [{ id: "sub-1", quote_id: "Q-S" }], allPayments: payments, creditRows: [],
    tdsInfo: { pz: { tds: 1784, section: "194J" } },
    txnFilter: "all", setTxnFilter: vi.fn(),
    segments: [{ id: "all", label: "All", n: 8 }, { id: "invoices", label: "Invoices", n: 3 }, { id: "payments", label: "Payments", n: 5 }],
    filteredTxns: [], hasTxns: true, ...over,
  };
}

/** Desktop table rows' text, in order. */
const rowTexts = (c: HTMLElement) => [...c.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
const indexOf = (rows: string[], s: string) => rows.findIndex((r) => r.includes(s));

describe("R-2544 Customer → Transactions: payments under their invoice", () => {
  it("All: an invoice with 2 payments has both right under it, oldest first; status Paid", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    const rows = rowTexts(container);
    const inv = indexOf(rows, "INV-A378-27-0100");
    expect(rows[inv]).toContain("Paid");
    expect(rows[inv + 1]).toContain("RV-A378-27-0168");
    expect(rows[inv + 1]).toContain("Bank transfer");
    expect(rows[inv + 1]).toContain("₹4,000");
    expect(rows[inv + 2]).toContain("RV-A378-27-0170");
  });

  it("the Zoho-imported invoice's receipt (R-2542 path) is nested with its TDS line", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    const rows = rowTexts(container);
    const inv = indexOf(rows, "INV/25-26/1913");
    expect(rows[inv + 1]).toContain("RV-Z-7097");
    expect(rows[inv + 1]).toContain("Received ₹87,424 + TDS ₹1,784");
  });

  it("a subscription instalment shows its receipt and says Part-paid (₹X due) once", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    const rows = rowTexts(container);
    const inv = indexOf(rows, "INV-I1");
    expect(rows[inv]).toContain("Part-paid (₹2,000 due)");
    expect(rows[inv + 1]).toContain("RV-S-1");
  });

  it("an advance goes to its own group at the end, with its quote", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    const rows = rowTexts(container);
    const g = indexOf(rows, ADVANCE_GROUP_TITLE);
    expect(g).toBe(rows.length - 2);
    expect(rows[g + 1]).toContain("RV-ADV-1");
    expect(rows[g + 1]).toContain("Quote Q-2");
    // ...and not as a loose payment row anywhere else
    expect(rows.filter((r) => r.includes("RV-ADV-1"))).toHaveLength(1);
  });

  it("top-level rows newest first by date (invoice date / quote date)", () => {
    const { container } = render(<CustomerTransactionsTab {...props()} />);
    const rows = rowTexts(container);
    expect(indexOf(rows, "INV-I1")).toBeLessThan(indexOf(rows, "INV-A378-27-0100"));
    expect(indexOf(rows, "INV-A378-27-0100")).toBeLessThan(indexOf(rows, "INV/25-26/1913"));
  });

  it("Invoices tab: invoices with their payments, no advance group", () => {
    const { container } = render(<CustomerTransactionsTab {...props({ txnFilter: "invoices" })} />);
    const rows = rowTexts(container);
    expect(rows.some((r) => r.includes(ADVANCE_GROUP_TITLE))).toBe(false);
    expect(rows[indexOf(rows, "INV-A378-27-0100") + 1]).toContain("RV-A378-27-0168");
  });

  it("Payments tab: flat list with a For column (invoice number or Advance)", () => {
    const flat: FlatTxn[] = [
      { date: "2026-10-20", type: "Payment", ref: "RV-ADV-1", amount: 2500, status: "received", href: null, payId: "padv" },
      { date: "2026-09-05", type: "Payment", ref: "RV-A378-27-0168", amount: 4000, status: "received", href: null, payId: "p1" },
    ];
    const { container } = render(<CustomerTransactionsTab {...props({ txnFilter: "payments", filteredTxns: flat })} />);
    const head = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(head).toContain("For");
    const body = container.querySelector("tbody")!;
    const rows = [...body.querySelectorAll("tr")];
    expect(within(rows[0]).getByText("Advance")).toBeTruthy();
    expect(within(rows[1]).getByText("INV-A378-27-0100")).toBeTruthy();
  });
});
