// @vitest-environment jsdom
//
// R-1806 — Payments → Subscription dues heading on a FAILED dues read.
// When useOutstandingReceivables() failed but seat quotes were pending, the card still rendered
// and its heading read "Subscription dues · ₹0 · 0 subscriptions with a balance" — while 12
// subscriptions had a balance. A failed read shows no total; the page's load-error banner
// (R-1655) says what went wrong and offers Try again.
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

describe("SubscriptionDuesHeading (R-1806)", () => {
  it("shows the total, the count and the overdue count when the read worked", () => {
    render(<SubscriptionDuesHeading rows={[row(1000, 10), row(2500, 45)]} failed={false} />);
    expect(screen.getByRole("heading").textContent).toBe("Subscription dues · ₹3,500");
    expect(document.body.textContent).toMatch(/2 subscriptions with a balance/);
    expect(document.body.textContent).toMatch(/1 overdue 30\+ days/);
  });

  it("a failed read shows no ₹ total and no '0 subscriptions'", () => {
    render(<SubscriptionDuesHeading rows={[]} failed />);
    const h = screen.getByRole("heading");
    expect(h.textContent).toBe("Subscription dues");
    expect(document.body.textContent).not.toMatch(/₹\s*0/);
    expect(document.body.textContent).not.toMatch(/0 subscriptions/);
    expect(document.body.textContent).toMatch(/couldn.t load/i);
  });
});
