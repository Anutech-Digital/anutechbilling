// @vitest-environment jsdom
//
// R-1806 — Payments → dues card heading on a FAILED read.
// When useOutstandingReceivables() failed but seat quotes were pending, the card still rendered
// and its heading read "Subscription dues · ₹0 · 0 subscriptions with a balance" — while 12
// subscriptions had a balance. A failed read shows no total; the page's load-error banner
// (R-1655) says what went wrong and offers Try again.
// R-1708: the heading's total is now "Owed to you" — the shared receivables number
// (lib/payments/receivables.ts, the same as Payment Follow-up), not the sum of the rows.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import type { OutstandingRow } from "@/lib/queries/payments";
import { SubscriptionDuesHeading } from "./dues-list";

afterEach(cleanup);

const row = (amount: number, days: number): OutstandingRow => ({
  subscription_id: `sub-${amount}-${days}`,
  customer_id: "c-1",
  customer_name: "Customer",
  plan: "Google Workspace Business Starter",
  outstanding_amount: amount,
  total_quote_amount: amount * 2,
  paid_amount: amount,
  status: "active",
  started_at: "2026-01-01",
  age_from: "2026-10-01",
  last_reminder_at: null,
  days_outstanding: days,
  quote_id: "Q-1",
  payment_due_date: null,
});

const totals = { invoiced: 2000, notYetInvoiced: 1500, total: 3500 };

describe("SubscriptionDuesHeading (R-1806, R-1708)", () => {
  it("shows the shared total, its two parts, the row count and the overdue count when the reads worked", () => {
    render(<SubscriptionDuesHeading rows={[row(1000, 10), row(2500, 45)]} failed={false} receivables={{ totals, failed: false }} />);
    expect(screen.getByRole("heading").textContent).toBe("Owed to you · ₹3,500");
    expect(document.body.textContent).toMatch(/₹2,000 on open invoices \+ ₹1,500 subscription dues not yet invoiced/);
    expect(document.body.textContent).toMatch(/2 subscriptions with a balance/);
    expect(document.body.textContent).toMatch(/1 overdue 30\+ days/);
  });

  it("a failed dues read shows no '0 subscriptions'", () => {
    render(<SubscriptionDuesHeading rows={[]} failed receivables={{ totals, failed: false }} />);
    expect(document.body.textContent).not.toMatch(/0 subscriptions/);
    expect(document.body.textContent).toMatch(/couldn.t load the subscription dues/i);
  });

  it("a failed receivables read shows no ₹ total", () => {
    render(<SubscriptionDuesHeading rows={[]} failed receivables={{ totals: null, failed: true }} />);
    expect(screen.getByRole("heading").textContent).toBe("Owed to you");
    expect(document.body.textContent).not.toMatch(/₹\s*0/);
    expect(document.body.textContent).toMatch(/couldn.t load what is owed/i);
  });

  it("while loading, no total yet (never ₹0)", () => {
    render(<SubscriptionDuesHeading rows={[]} failed={false} receivables={{ totals: null, failed: false }} />);
    expect(screen.getByRole("heading").textContent).toBe("Owed to you");
    expect(document.body.textContent).not.toMatch(/₹\s*0/);
  });
});
