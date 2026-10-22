/**
 * R-1739 — the shared "is this our sale" rule, and the ledger of a Zoho opening balance.
 * Owner example: Zoho INV-000245, Total ₹59,000, Balance ₹20,000 → Debtors Dr ₹20,000 /
 * Opening Balance Adjustments Cr ₹20,000; no GST, no revenue; the customer statement shows
 * ₹20,000 owed (not ₹59,000).
 */
import { describe, expect, it, vi } from "vitest";
import { invoiceIsSale, isOpeningInvoice, onlySaleInvoices, OPENING_INVOICE_KIND } from "./sale-documents";
import { balanceSheetTotals } from "./balance-sheet-totals";
import { buildTrialBalance } from "./trial-balance";
import { invoiceMoney } from "@/lib/company/summary";
import { invoiceMarginMtd } from "@/lib/invoices/margin-mtd";
import { irnAgeingInvoices } from "@/lib/compliance/einvoice";
import { isTaxInvoiceRow } from "@/lib/invoices/document-kind";
import { buildCustomerStatement } from "@/components/features/customers/customer-statement";
import { openingDues } from "@/components/features/invoices/opening-invoice-dues-card";
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";
import type { PnLNumbers } from "./pnl-assemble";

const ZERO: BalanceSheetAuto = {
  cashAndBank: 0, undepositedFunds: 0, receivables: 0, advancesFromCustomers: 0, projectReceivable: 0,
  tdsReceivable: 0, employeeLoans: 0, prepaidAdvances: 0, fixedAssets: 0, payables: 0,
  salaryPayable: 0, salaryDuesPayable: 0, reimbursementsPayable: 0, creditCardPayable: 0,
  emiLoansPayable: 0, businessLoansPayable: 0, gstPayable: 0, gstPaid: 0, advanceTaxPaid: 0,
  expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0, fyLabel: "FY 2026-27",
};
const NO_PNL = { revenue: 0, cogs: 0, commissions: 0, expenses: 0, expensesByCategory: [] } as unknown as PnLNumbers;

describe("invoiceIsSale / isOpeningInvoice / onlySaleInvoices", () => {
  it("only an opening invoice is not a sale; absent kind = tax invoice", () => {
    expect(invoiceIsSale("tax_invoice")).toBe(true);
    expect(invoiceIsSale("bill_of_supply")).toBe(true);
    expect(invoiceIsSale(null)).toBe(true);
    expect(invoiceIsSale(undefined)).toBe(true);
    expect(invoiceIsSale(OPENING_INVOICE_KIND)).toBe(false);
    expect(isOpeningInvoice({ document_kind: "opening_invoice" })).toBe(true);
    expect(isOpeningInvoice({ document_kind: "tax_invoice" })).toBe(false);
    expect(isOpeningInvoice(null)).toBe(false);
    expect(isTaxInvoiceRow({ document_kind: "opening_invoice" })).toBe(false);
    expect(isTaxInvoiceRow({ document_kind: "tax_invoice" })).toBe(true);
  });

  it("adds document_kind <> opening_invoice to a PostgREST query", () => {
    const q = { neq: vi.fn() };
    q.neq.mockReturnValue(q);
    expect(onlySaleInvoices(q)).toBe(q);
    expect(q.neq).toHaveBeenCalledWith("document_kind", "opening_invoice");
  });
});

describe("ledger of a Zoho opening balance (₹20,000 due on INV-000245)", () => {
  const bs: BalanceSheetAuto = { ...ZERO, receivables: 20000, openingBalanceAdjustments: 20000 };

  it("trial balance: Debtors Dr 20,000 / Opening Balance Adjustments Cr 20,000 — no difference", () => {
    const tb = buildTrialBalance({ bs, pnl: NO_PNL, items: [] });
    expect(tb.rows.find((r) => r.head === "Trade receivables")).toMatchObject({ debit: 20000, credit: 0 });
    expect(tb.rows.find((r) => r.head === "Opening Balance Adjustments")).toMatchObject({ group: "Equity", debit: 0, credit: 20000 });
    expect(tb.difference).toBe(0);
    expect(tb.rows.some((r) => r.group === "Income")).toBe(false);
  });

  it("balance sheet: the equity line explains it — retained (and so 'unexplained') stays 0", () => {
    const t = balanceSheetTotals(bs, []);
    expect(t.netWorth).toBe(20000);
    expect(t.retained).toBe(0);
  });

  it("after ₹15,000 is received: Debtors 5,000 + cash 15,000 against the same 20,000", () => {
    const after: BalanceSheetAuto = { ...bs, receivables: 5000, undepositedFunds: 15000 };
    const tb = buildTrialBalance({ bs: after, pnl: NO_PNL, items: [] });
    expect(tb.difference).toBe(0);
  });
});

describe("screens that count sales leave it out; screens that count dues keep it", () => {
  const opening = {
    id: "INV-000245", status: "overdue", invoice_date: "2026-10-05", due_date: "2026-09-15", amount: 59000,
    net_payable: 59000, paid_amount: 39000, document_kind: "opening_invoice", opening_balance: 20000,
    customer_gstin: "07AAACT1234A1Z3", gst_irn: null, taxable_value: 0, tax_amount: 0, line_items: [],
  };
  const now = new Date("2026-10-22T06:00:00Z");

  it("dashboard: not 'invoiced this month', but in outstanding", () => {
    const m = invoiceMoney([opening], now);
    expect(m.invoicedThisMonth).toEqual({ count: 0, value: 0 });
    expect(m.outstanding.value).toBe(20000);
  });

  it("invoices page: no margin, no IRN warning", () => {
    expect(invoiceMarginMtd([opening], now).invoiceCount).toBe(0);
    expect(irnAgeingInvoices("10cr_plus", [opening], now).ageing).toEqual([]);
  });

  it("customer statement: Opening balance ₹20,000, a payment on it links to the invoice", () => {
    const st = buildCustomerStatement({
      invoices: [opening],
      payments: [{ id: "p1", quote_id: null, invoice_id: "INV-000245", amount: 15000, status: "received", received_at: "2026-10-21" }],
      creditNotes: [], debitNotes: [], projectPayments: [],
    });
    expect(st.rows[0]).toMatchObject({ desc: "Opening balance · INV-000245 (imported from Zoho Books)", debit: 20000 });
    expect(st.rows[1].link).toEqual({ kind: "invoice", invoiceId: "INV-000245" });
    expect(st.closing).toBe(5000);
  });

  it("payments dues card: ₹20,000, 37 days from its due date (owner example)", () => {
    const rows = openingDues([{ id: "INV-000245", customer_id: "c1", customer_name: "T-ABC Pvt Ltd", due_date: "2026-09-15", invoice_date: "2026-08-16", amount: 59000, net_payable: 59000, paid_amount: 39000 }], "2026-10-22");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ due: 20000, age: 37 });
  });
});
