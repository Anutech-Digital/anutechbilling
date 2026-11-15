// @vitest-environment jsdom
/* R-2840 (renewals history audit 15 Nov, H5): the desktop table's "Last bill" cell shows the last
   payment as its third line — "Paid ₹40,000 · 2 Oct" (mode + receipt in the tooltip) — from the SAME
   last-paid read the card layout uses (useRenewalLastPaid; no new query), with R-2752's rule: a Paid
   invoice with no linked receipt says "Paid on invoice, no receipt", never "No payment yet".
   A foreign-currency invoice's payment shows in that currency. */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { LastPaidRowLine, lastPaidRowFacts } from "./row-cells";
import type { LastPaid, PaidLine } from "./last-paid";
import type { LastDocs, LastInvoice } from "./last-docs";

afterEach(cleanup);

const TODAY = "2026-11-15";

const line = (over: Partial<PaidLine> & { receiptNo?: string | null } = {}): PaidLine => ({
  paymentId: "p-1", amount: 40000, method: "upi", receivedAt: "2026-10-02T06:30:00Z",
  invoiceId: "INV-1", quoteId: "Q-1", covers: 1, ...over,
});
const paidOf = (...xs: PaidLine[]): LastPaid => ({ last: xs[0], history: xs });

const inv = (over: Partial<LastInvoice> = {}): LastInvoice => ({
  id: "INV-1", date: "2026-10-01", status: "sent", amount: 40000, paidAmount: 40000, currency: "INR",
  dueDate: "2026-10-15", netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null,
  sourceQuoteId: "Q-1", part: null, period: "Oct 2026", notes: undefined, ...over,
} as LastInvoice);
const docsOf = (...invoices: LastInvoice[]): LastDocs => ({ quote: null, invoice: invoices[0] ?? null, invoices, sent: null });

describe("R-2840 — lastPaidRowFacts (pure)", () => {
  it("a receipt: Paid ₹ amount · short date; mode, receipt no. and the invoice in the tooltip", () => {
    const f = lastPaidRowFacts({ paid: paidOf(line({ receiptNo: "RV-0012" } as never)), docs: docsOf(inv()), todayIst: TODAY });
    expect(f.kind).toBe("paid");
    expect(f.text).toBe("Paid ₹40,000 · 2 Oct");
    expect(f.title).toContain("UPI");
    expect(f.title).toContain("receipt RV-0012");
    expect(f.title).toContain("INV-1");
    expect(f.title).toContain("2 Oct 2026");
  });

  it("a payment from an earlier year keeps its year on the row", () => {
    const f = lastPaidRowFacts({ paid: paidOf(line({ receivedAt: "2025-12-30T10:00:00Z" })), docs: docsOf(inv()), todayIst: TODAY });
    expect(f.text).toBe("Paid ₹40,000 · 30 Dec 25");
  });

  it("the date is the IST day (a 23:00 IST payment is not the day before)", () => {
    const f = lastPaidRowFacts({ paid: paidOf(line({ receivedAt: "2026-10-01T18:30:00Z" })), docs: docsOf(inv()), todayIst: TODAY });
    expect(f.text).toBe("Paid ₹40,000 · 2 Oct");
  });

  it("USD invoice: the payment shows in dollars (₹ ÷ the invoice's fx rate), ₹ stays in the tooltip", () => {
    const usd = inv({ id: "INV-U", currency: "USD", fxRate: 80, amount: 96000, paidAmount: 96000 });
    const f = lastPaidRowFacts({ paid: paidOf(line({ amount: 96000, invoiceId: "INV-U" })), docs: docsOf(usd), todayIst: TODAY });
    expect(f.text).toBe("Paid $1,200 · 2 Oct");
    expect(f.title).toContain("₹96,000");
  });

  it("a payment on the quote (no invoice id) finds its USD invoice through the invoice's source quote", () => {
    const usd = inv({ id: "INV-U", currency: "USD", fxRate: 80, sourceQuoteId: "Q-U" });
    const f = lastPaidRowFacts({ paid: paidOf(line({ amount: 8000, invoiceId: null, quoteId: "Q-U" })), docs: docsOf(usd), todayIst: TODAY });
    expect(f.text).toBe("Paid $100 · 2 Oct");
  });

  it("an invoice not on the row: ₹ as the books hold it (never a guessed rate)", () => {
    const usd = inv({ id: "INV-U", currency: "USD", fxRate: 80, sourceQuoteId: "Q-U" });
    const f = lastPaidRowFacts({ paid: paidOf(line({ amount: 8000, invoiceId: "INV-OLD", quoteId: "Q-OLD" })), docs: docsOf(usd), todayIst: TODAY });
    expect(f.text).toBe("Paid ₹8,000 · 2 Oct");
  });

  it("one payment for several subscriptions says so in the tooltip", () => {
    const f = lastPaidRowFacts({ paid: paidOf(line({ covers: 2 })), docs: docsOf(inv()), todayIst: TODAY });
    expect(f.title).toContain("covers 2 subscriptions");
  });

  it("R-2752 (Greentin Behind): Paid invoice, no linked receipt → 'Paid on invoice, no receipt', never 'No payment yet'", () => {
    const f = lastPaidRowFacts({ paid: undefined, docs: docsOf(inv({ id: "INV-F588-27-0060" })), todayIst: TODAY });
    expect(f.kind).toBe("no-receipt");
    expect(f.text).toBe("Paid on invoice, no receipt");
    expect(f.title).toContain("INV-F588-27-0060");
    expect(f.text).not.toMatch(/never|No payment/i);
  });

  it("part-paid invoice with no linked receipt → 'Part paid on invoice, no receipt'", () => {
    const f = lastPaidRowFacts({ paid: undefined, docs: docsOf(inv({ paidAmount: 10000, dueDate: "2026-12-30" })), todayIst: TODAY });
    expect(f.kind).toBe("no-receipt");
    expect(f.text).toBe("Part paid on invoice, no receipt");
  });

  it("nothing received anywhere → 'No payment yet'", () => {
    const f = lastPaidRowFacts({ paid: undefined, docs: docsOf(inv({ paidAmount: 0, dueDate: "2026-12-30" })), todayIst: TODAY });
    expect(f).toMatchObject({ kind: "none", text: "No payment yet" });
    expect(lastPaidRowFacts({ paid: undefined, docs: docsOf(), todayIst: TODAY }).text).toBe("No payment yet");
  });
});

describe("R-2840 — LastPaidRowLine (table row, line 3 of Last bill)", () => {
  const base = { loading: false, failed: false, todayIst: TODAY };

  it("shows the last payment, wrapping (never truncated), tooltip with mode + receipt", () => {
    render(<LastPaidRowLine {...base} paid={paidOf(line({ receiptNo: "RV-0012" } as never))} docs={docsOf(inv())} />);
    const el = screen.getByTestId("renewal-row-last-paid");
    expect(el.textContent).toBe("Paid ₹40,000 · 2 Oct");
    expect(el.className).toContain("break-words");
    expect(el.className).not.toMatch(/truncate|line-clamp/);
    expect(el.getAttribute("title")).toMatch(/UPI.*receipt RV-0012/);
  });

  it("no payment → 'No payment yet'", () => {
    render(<LastPaidRowLine {...base} paid={undefined} docs={docsOf()} />);
    expect(screen.getByTestId("renewal-row-last-paid").textContent).toBe("No payment yet");
  });

  it("while either read loads it holds the line ('…'), never a false 'No payment yet'", () => {
    render(<LastPaidRowLine {...base} loading paid={undefined} docs={undefined} />);
    expect(screen.getByTestId("renewal-row-last-paid").textContent).toBe("…");
    expect(screen.queryByText(/No payment yet/)).toBeNull();
  });

  it("a failed read says so", () => {
    render(<LastPaidRowLine {...base} failed paid={undefined} docs={undefined} />);
    expect(screen.getByTestId("renewal-row-last-paid").textContent).toMatch(/couldn.t load/i);
  });
});
