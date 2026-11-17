/**
 * R-2884 — the pure half of the Customer page's balance (statement-core.ts).
 *
 * The Customer page and Help AI's customer_overview must give the SAME number, so the arithmetic lives in a
 * file with no React and no client imports. These tests pin: the page's module still exports the same
 * functions (so nothing about the page changed), the page's working equals customerBalance on one fixture,
 * the Outstanding / credit split, the not-yet-invoiced dues, and that the module stays pure.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as page from "@/components/features/customers/customer-statement";
import * as core from "./statement-core";
import { deriveCustomerInsights } from "@/components/features/customers/customer-insights";
import { uninvoicedSubscriptionDue as owedUninvoiced } from "@/lib/renewals/owed";

const ROOT = path.resolve(__dirname, "../../..");

describe("statement-core is the page's own module, moved", () => {
  it("the page module re-exports the very same functions (no second copy)", () => {
    expect(page.buildCustomerStatement).toBe(core.buildCustomerStatement);
    expect(page.groupProjectReceipts).toBe(core.groupProjectReceipts);
    expect(page.statementBalanceText).toBe(core.statementBalanceText);
    expect(page.statementUninvoicedDues).toBe(core.statementUninvoicedDues);
    expect(page.outstandingFromClosing).toBe(core.outstandingFromClosing);
    expect(owedUninvoiced).toBe(core.uninvoicedSubscriptionDue);
    expect(page.uninvoicedSubscriptionDue).toBe(core.uninvoicedSubscriptionDue);
  });

  it("it is pure: no React, no react-query, no Supabase client, no app-route import, no 'use client'", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/customers/statement-core.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      "@/lib/accounting/sale-documents", "@/lib/payments/amount-due", "@/lib/payments/cash-received", "@/lib/payments/receivables", "@/lib/utils",
    ]);
    expect(src).not.toMatch(/use client|from "react|tanstack|supabase|process\.env|\bfetch\(/);
  });
});

describe("outstandingFromClosing (the Customer page's Outstanding / credit split)", () => {
  it("owed: the closing to the paisa; credit 0", () => {
    expect(core.outstandingFromClosing(1632.4)).toEqual({ closing: 1632.4, outstanding: 1632.4, credit: 0 });
    expect(core.outstandingFromClosing(10.005 * 100)).toMatchObject({ credit: 0 });
  });
  it("in credit: Outstanding 0 and the credit is how far below zero", () => {
    expect(core.outstandingFromClosing(-1554)).toEqual({ closing: -1554, outstanding: 0, credit: 1554 });
  });
  it("paise noise rounds away both ways, and -0 is not a credit", () => {
    const r = core.outstandingFromClosing(-0.001);
    expect(r.outstanding).toBe(0);
    expect(Object.is(r.credit, 0)).toBe(true);
    expect(core.outstandingFromClosing(0.1 + 0.2).outstanding).toBe(0.3);
  });
  it("deriveCustomerInsights takes its Outstanding / credit from it", () => {
    const c = { id: "c", name: "x" } as never;
    for (const closing of [0, 5000, -5000, 1632.4, -0.004]) {
      const i = deriveCustomerInsights(c, [], [], [], [], 0, { closing, advanceNotes: [] });
      const o = core.outstandingFromClosing(closing);
      expect([i.outstanding, i.credit]).toEqual([o.outstanding, o.credit]);
    }
  });
});

describe("statementUninvoicedDues", () => {
  const sub = (quote_id: string | null, outstanding_amount: number, extra: object = {}) => ({ quote_id, outstanding_amount, ...extra });
  it("a subscription's balance counts only with a quote, only while that quote has no invoice, never when written off", () => {
    const dues = core.statementUninvoicedDues(
      [sub("Q-1", 2000, { start_date: "2026-07-01" }), sub("Q-2", 700), sub(null, 9000), sub("Q-3", 500, { written_off_at: "2026-09-01" }), sub("Q-4", 0)],
      [{ quote_id: "Q-2" }, { quote_id: null }],
    );
    expect(dues).toEqual([{ quoteId: "Q-1", date: "2026-07-01", due: 2000 }]);
  });
  it("an invoice of any status (void too) makes its quote 'invoiced'", () => {
    expect(core.statementUninvoicedDues([sub("Q-9", 100)], [{ quote_id: "Q-9" }])).toEqual([]);
  });
});

describe("customerBalance = the page's own working", () => {
  const invoices = [
    { id: "INV-1", invoice_date: "2026-10-01", amount: 10000, status: "pending", net_payable: 10000, paid_amount: 0, written_off_at: null, quote_id: null },
    { id: "INV-2", invoice_date: "2026-10-02", amount: 4000, status: "pending", net_payable: 4000, paid_amount: 0, written_off_at: "2026-10-20T00:00:00Z", quote_id: null },
  ];
  const payments = [
    { id: "P-1", quote_id: "Q-A", amount: 6000, credit_applied: 1000, status: "received", received_at: "2026-10-05T10:00:00Z" },
    { id: "P-2", quote_id: null, amount: 500, status: "refunded", received_at: "2026-10-06T10:00:00Z", refunded_at: "2026-10-07T10:00:00Z" },
  ];
  const creditNotes = [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-08", amount: 1000 }];
  const debitNotes = [{ id: "DN-1", invoice_id: "INV-1", debit_date: "2026-10-09", amount: 250 }];
  const projectPayments = [
    { received_at: "2026-10-10", amount: 3000, project_title: "P", project_id: "PRJ", method: "bank", bank_txn_id: "b1", milestone_id: "m1" },
    { received_at: "2026-10-10", amount: 300, project_title: "P", project_id: "PRJ", method: "tds", bank_txn_id: null, milestone_id: "m1" },
  ];
  const subscriptions = [{ quote_id: "Q-S", outstanding_amount: 1200, start_date: "2026-09-01" }];

  it("same closing as buildCustomerStatement over the same rows, and the page's Outstanding", () => {
    const b = core.customerBalance({ invoices, payments, creditNotes, debitNotes, projectPayments, subscriptions });
    const direct = core.buildCustomerStatement({
      invoices, payments, creditNotes, debitNotes, projectPayments,
      uninvoicedDues: [{ quoteId: "Q-S", date: "2026-09-01", due: 1200 }],
    });
    expect(b.statement.closing).toBe(direct.closing);
    // debits 10,000 + 4,000 + 250 + 500 (refund) + 1,200 (instalment) = 15,950; credits 4,000 (write-off) + 5,000 (cash of P-1) + 500 + 1,000 + 3,300 = 13,800
    expect(b.closing).toBe(2150);
    const i = deriveCustomerInsights({ id: "c", name: "x" } as never, [], invoices as never, [], [], 0, direct);
    expect(b.outstanding).toBe(i.outstanding);
    expect(b.credit).toBe(i.credit);
  });
  it("project receipts: dropping the reference / bank link does not move the closing (rows only are merged)", () => {
    const bare = projectPayments.map(({ received_at, amount, project_title, project_id, method }) => ({ received_at, amount, project_title, project_id, method }));
    const a = core.customerBalance({ invoices, payments, creditNotes, debitNotes, projectPayments, subscriptions });
    const b = core.customerBalance({ invoices, payments, creditNotes, debitNotes, projectPayments: bare, subscriptions });
    expect(b.closing).toBe(a.closing);
  });
});
