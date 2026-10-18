/**
 * R-1576 — the Balance Sheet's GST payable and the P&L's input GST / COGS follow the bill
 * ITC rule. Before: report-rpc.ts `gstPayable = gst_output − bills_gst − …` and
 * pnl-assemble.ts `inputGST = billsGst + expensesGst` took every bill's GST as credit.
 */
import { describe, it, expect } from "vitest";
import { balanceSheetFromRpc, type BalanceSheetRpcRow } from "./report-rpc";
import { assemblePnl, type PnlRpcRow } from "./pnl-assemble";
import type { BillItcGroup } from "@/lib/gst/bill-itc";

const GSTIN_DL = "07AAACA1234A1Z5";
const g = (extra: Partial<BillItcGroup>): BillItcGroup => ({
  document_type: "tax_invoice", category: "COGS-Workspace", vendorGstin: GSTIN_DL,
  cgst: 900, sgst: 900, igst: 0, n: 1, ownStateCode: "07", ...extra,
});

const bsRow = (extra: Partial<BalanceSheetRpcRow>): BalanceSheetRpcRow => ({
  as_of: "2026-10-18", fy_start_year: 2026, fy_label: "FY 2026-27",
  cash_and_bank: 0, credit_card_payable: 0, receivables: 0, advances_from_customers: 0,
  project_receivable: 0, tds_receivable: 0, employee_loans: 0, prepaid_advances: 0,
  emi_unregistered_cost: 0, emi_loans_payable: 0, business_loans_payable: 0, payables: 0,
  salary_payable: 0, dues_salary_tds: 0, dues_pf: 0, dues_esi: 0, dues_vendor_tds: 0, dues_paid: [],
  reimbursements_payable: 0, gst_output: 10000, bills_gst: 0, itc_groups: [], fixed_assets: [], tax_payments: [],
  ...extra,
});

describe("Balance Sheet GST payable — bill ITC rule", () => {
  it("a tax invoice's GST still cuts GST payable", () => {
    expect(balanceSheetFromRpc(bsRow({ bills_gst: 1800, bill_itc_groups: [g({})] })).gstPayable).toBe(10000 - 1800);
  });

  it("a proforma's GST does NOT cut GST payable", () => {
    expect(balanceSheetFromRpc(bsRow({ bills_gst: 1800, bill_itc_groups: [g({ document_type: "proforma" })] })).gstPayable).toBe(10000);
  });

  it("a bill with no vendor GSTIN does NOT cut GST payable", () => {
    expect(balanceSheetFromRpc(bsRow({ bills_gst: 1800, bill_itc_groups: [g({ document_type: null, vendorGstin: null })] })).gstPayable).toBe(10000);
  });

  it("before the migration (no bill_itc_groups) — the old figure, not 0 credit", () => {
    expect(balanceSheetFromRpc(bsRow({ bills_gst: 1800 })).gstPayable).toBe(10000 - 1800);
  });
});

const pnlRow = (extra: Partial<PnlRpcRow>): PnlRpcRow => ({
  inv_taxable: 50000, inv_tax: 9000, revenue_count: 1, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 10000, cogs_count: 1, bills_gst: 1800,
  expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [],
  commissions: 0, commissions_count: 0, ...extra,
});
const masters = { vendors: [], allocations: [], monthlyGross: new Map<string, number>(), projects: [], employeeNames: new Map<string, string>() };
const range = { from: "2026-10-01", to: "2026-10-31" };

describe("P&L — bill ITC rule", () => {
  it("tax invoice: GST is input credit, COGS is the subtotal (unchanged)", () => {
    const p = assemblePnl(range, pnlRow({ bill_itc_groups: [g({})] }), masters);
    expect(p.inputGST).toBe(1800);
    expect(p.cogs).toBe(10000);
    expect(p.itcBlocked).toBe(0);
  });

  it("proforma: no input credit, the GST is added to COGS", () => {
    const p = assemblePnl(range, pnlRow({ bill_itc_groups: [g({ document_type: "proforma" })] }), masters);
    expect(p.inputGST).toBe(0);
    expect(p.cogs).toBe(11800);
    expect(p.itcBlocked).toBe(1800);
    expect(p.grossMargin).toBe(50000 - 11800);
  });

  it("no GSTIN: no input credit", () => {
    const p = assemblePnl(range, pnlRow({ bill_itc_groups: [g({ document_type: null, vendorGstin: null })] }), masters);
    expect(p.inputGST).toBe(0);
    expect(p.cogs).toBe(11800);
  });

  it("before the migration (no bill_itc_groups) — the old figures", () => {
    const p = assemblePnl(range, pnlRow({}), masters);
    expect(p.inputGST).toBe(1800);
    expect(p.cogs).toBe(10000);
  });
});
