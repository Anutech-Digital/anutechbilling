import { describe, it, expect } from "vitest";
import { computeTradeReceivables, computeCustomerAdvances, computeOwedBackToCustomers } from "./balance-sheet";

/**
 * These two figures were both WRONG on the live Balance Sheet until 2026-08-12,
 * and the errors ran in opposite directions on the same statement:
 *
 *   Trade receivables   Rs 0        →  Rs 97,639     (an asset was invisible)
 *   Advances liability  Rs 0        →  Rs 8,00,189   (a liability was missing)
 *   Net effect on reported retained earnings:  −Rs 7,02,550
 *
 * Because Equity is a balancing plug (see docs/ACCOUNTING-AUDIT.md §2), neither
 * error could ever make the sheet fail to balance — which is exactly why they
 * survived. These tests are the alarm the plug can't raise.
 */

describe("computeTradeReceivables — accrual, no double-count", () => {
  const openInvoices = [
    { id: "INV-1", amount: 118_000, net_payable: 100_000 }, // advance already frozen in
    { id: "INV-2", amount: 50_000, net_payable: null },     // no adjustment → fall back
    { id: "INV-PROJ-1", amount: 685_000, net_payable: 685_000 },
  ];

  it("prefers net_payable over amount so a frozen advance is not re-counted", () => {
    // Rule 53: 0005 freezes the advance into net_payable. Using `amount` would
    // count money the customer has already paid.
    expect(computeTradeReceivables([openInvoices[0]], new Set())).toBe(100_000);
  });

  it("falls back to amount when net_payable is null", () => {
    expect(computeTradeReceivables([openInvoices[1]], new Set())).toBe(50_000);
  });

  it("EXCLUDES project-milestone invoices — projectReceivable already counts them", () => {
    // The trap: without this filter the prod figure would have been Rs 7,82,639
    // instead of Rs 97,639, double-counting Rs 6,85,000 of project milestones.
    const projectIds = new Set(["INV-PROJ-1"]);
    expect(computeTradeReceivables(openInvoices, projectIds)).toBe(150_000);
    expect(computeTradeReceivables(openInvoices, new Set())).toBe(835_000); // the wrong answer
  });

  it("is zero for an empty ledger", () => {
    expect(computeTradeReceivables([], new Set())).toBe(0);
  });
});

describe("computeCustomerAdvances — money banked before invoicing is a LIABILITY", () => {
  const quotes = [
    { id: "Q-1", invoice_id: null },        // advance: paid, not yet invoiced
    { id: "Q-2", invoice_id: "INV-2" },     // already invoiced → not an advance
    { id: "Q-3", invoice_id: null },
  ];

  it("counts payments only against quotes with no invoice", () => {
    const payments = [
      { quote_id: "Q-1", amount: 500_189 },
      { quote_id: "Q-2", amount: 250_000 },  // invoiced → excluded
      { quote_id: "Q-3", amount: 300_000 },
    ];
    expect(computeCustomerAdvances(payments, quotes)).toBe(800_189);
  });

  it("drops out of the liability once the invoice is raised (it unwinds itself)", () => {
    const payments = [{ quote_id: "Q-1", amount: 500_189 }];
    const afterInvoicing = [{ id: "Q-1", invoice_id: "INV-9" }];
    expect(computeCustomerAdvances(payments, afterInvoicing)).toBe(0);
  });

  it("ignores payments with no quote link and treats null amounts as zero", () => {
    const payments = [
      { quote_id: null, amount: 99_000 },
      { quote_id: "Q-1", amount: null },
      { quote_id: "Q-UNKNOWN", amount: 1_000 },
    ];
    expect(computeCustomerAdvances(payments, quotes)).toBe(0);
  });

  it("is zero when nothing has been paid", () => {
    expect(computeCustomerAdvances([], quotes)).toBe(0);
  });
});

/**
 * S45 — each money event must keep Dr = Cr. Dr − Cr deltas measured on local DB by
 * supabase/tests/tb_money_events_balanced.test.sql before the fix: part payment +5,000,
 * TDS +1,000, overpayment +1,000, credit note on a paid invoice +1,180.
 */
describe("S45 — part payment: receivable is net_payable − paid_amount", () => {
  it("₹11,800 invoice with ₹5,000 received leaves ₹6,800 receivable (not ₹11,800)", () => {
    expect(computeTradeReceivables([{ id: "INV-1", amount: 11_800, net_payable: 11_800, paid_amount: 5_000 }], new Set())).toBe(6_800);
  });
  it("Dr side moves by 0: receivable −5,000 + money received +5,000", () => {
    const before = computeTradeReceivables([{ id: "INV-1", amount: 11_800, net_payable: 11_800, paid_amount: 0 }], new Set());
    const after = computeTradeReceivables([{ id: "INV-1", amount: 11_800, net_payable: 11_800, paid_amount: 5_000 }], new Set());
    expect(after - before + 5_000).toBe(0);
  });
  it("never goes negative when a credit note brings net_payable below what was paid", () => {
    expect(computeTradeReceivables([{ id: "INV-1", amount: 11_800, net_payable: 4_000, paid_amount: 5_000 }], new Set())).toBe(0);
  });
});

describe("S45 — money owed back to the customer after the invoice", () => {
  it("overpayment: ₹12,800 on a ₹11,800 invoice → ₹1,000 liability", () => {
    expect(computeOwedBackToCustomers([{ received: 12_800, invoice_amount: 11_800, credit_notes: 0, debit_notes: 0 }])).toBe(1_000);
  });
  it("credit note ₹1,180 on a fully paid invoice → ₹1,180 liability", () => {
    expect(computeOwedBackToCustomers([{ received: 11_800, invoice_amount: 11_800, credit_notes: 1_180, debit_notes: 0 }])).toBe(1_180);
  });
  it("TDS-settled invoice (payment amount includes the TDS) owes nothing back", () => {
    expect(computeOwedBackToCustomers([{ received: 11_800, invoice_amount: 11_800, credit_notes: 0, debit_notes: 0 }])).toBe(0);
  });
  it("part-paid invoice is a receivable, never a negative liability", () => {
    expect(computeOwedBackToCustomers([{ received: 5_000, invoice_amount: 11_800, credit_notes: 0, debit_notes: 590 }])).toBe(0);
  });
});
