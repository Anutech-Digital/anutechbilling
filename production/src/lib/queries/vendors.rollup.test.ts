import { describe, it, expect } from "vitest";
import { rollupVendors } from "./vendors";
import type { VendorRow } from "@/lib/supabase/database.types";

const V = (id: string, name: string): VendorRow => ({
  id, tenant_id: "t1", name, gstin: null, pan: null, contact_name: null, contact_email: null,
  contact_phone: null, default_category: null, address: null, city: null, state: null,
  pincode: null, udyam: null, msme_category: null, notes: null, created_at: "", updated_at: "",
  bank_account_name: null, bank_account_no: null, bank_ifsc: null, upi_id: null,
});

describe("rollupVendors", () => {
  const vendors = [V("v1", "Google"), V("v2", "Anthropic"), V("v3", "Unused")];

  it("folds COGS bills + expenses into one supplier's totals", () => {
    const out = rollupVendors(
      vendors,
      [
        { vendor_id: "v1", total: 1000, paid_amount: 400, bill_date: "2026-07-01", currency: "INR", fx_rate: 1 },
        { vendor_id: "v1", total: 500,  paid_amount: 500, bill_date: "2026-07-05", currency: "INR", fx_rate: 1 },
      ],
      [{ vendor_id: "v1", amount: 300, expense_date: "2026-07-10" }],
    );
    const g = out.find((v) => v.id === "v1")!;
    expect(g.billCount).toBe(2);
    expect(g.totalBilled).toBe(1500);
    expect(g.outstanding).toBe(600);            // (1000-400) + 0
    expect(g.expenseCount).toBe(1);
    expect(g.expenseTotal).toBe(300);
    expect(g.totalSpend).toBe(1800);            // 1500 + 300
    expect(g.docCount).toBe(3);                  // 2 bills + 1 expense
    expect(g.lastBillDate).toBe("2026-07-10");   // latest across bills + expenses
  });

  it("handles an expense-only foreign vendor (e.g. Anthropic, moved to Expenses)", () => {
    const out = rollupVendors(
      vendors, [],
      [
        { vendor_id: "v2", amount: 24293, expense_date: "2026-07-25", currency: "USD", fx_rate: 91.5 },
        { vendor_id: "v2", amount: 5304,  expense_date: "2026-07-10", currency: "USD", fx_rate: 91.5 },
      ],
    );
    const a = out.find((v) => v.id === "v2")!;
    expect(a.billCount).toBe(0);
    expect(a.totalBilled).toBe(0);
    expect(a.outstanding).toBe(0);
    expect(a.expenseCount).toBe(2);
    expect(a.totalSpend).toBe(29597);
    expect(a.docCount).toBe(2);
    expect(a.billCurrency).toBe("USD");          // uniform foreign across its expenses
    expect(a.foreignBilled).toBe(323.46);        // 29597 / 91.5
  });

  it("keeps foreign-currency rollup on COGS bills", () => {
    const out = rollupVendors(
      [V("v1", "Google LLC")],
      [{ vendor_id: "v1", total: 9150, paid_amount: 0, bill_date: "2026-07-01", currency: "USD", fx_rate: 91.5 }],
      [],
    );
    const g = out[0];
    expect(g.billCurrency).toBe("USD");
    expect(g.foreignBilled).toBe(100);           // 9150 / 91.5
    expect(g.foreignOutstanding).toBe(100);
  });

  it("R-1868: unpaid expense bills are owed too (less their TDS); advances are counted", () => {
    const out = rollupVendors(
      [V("v1", "Kapoor Legal Associates"), V("v2", "Meta Ads India")],
      [{ vendor_id: "v1", total: 5900, paid_amount: 0, bill_date: "2026-09-01", currency: "INR", fx_rate: 1 }],
      [
        { vendor_id: "v1", amount: 47200, expense_date: "2026-09-01", paid: false, tds_amount: 4000, reconciled_txn_id: null, category: "Professional Services", payment_method: null, prepaid_advance_id: null },
        { vendor_id: "v1", amount: 23600, expense_date: "2026-09-02", paid: true,  tds_amount: 0,    reconciled_txn_id: "t1", category: "Professional Services", payment_method: "bank", prepaid_advance_id: null },
        { vendor_id: "v1", amount: 9999,  expense_date: "2026-09-03", paid: false, tds_amount: 0,    reconciled_txn_id: null, category: "Salaries", payment_method: "payroll", prepaid_advance_id: null },
      ],
      [
        { vendor_id: "v2", vendor_name: "Meta Ads India", total_amount: 5000, consumed_amount: 1200, closed_at: null },
        { vendor_id: null, vendor_name: "kapoor legal associates", total_amount: 1000, consumed_amount: 0, closed_at: null },
      ],
    );
    const k = out.find((v) => v.id === "v1")!;
    expect(k.billsOutstanding).toBe(5900);
    expect(k.expenseBillsOutstanding).toBe(43200);   // 47,200 − TDS 4,000; paid and salary rows are not bills
    expect(k.outstanding).toBe(49100);
    expect(k.advance).toBe(1000);                    // matched by name when the advance has no vendor id
    const m = out.find((v) => v.id === "v2")!;
    expect(m.outstanding).toBe(0);
    expect(m.advance).toBe(3800);
  });

  it("leaves an untouched vendor at zero", () => {
    const out = rollupVendors(vendors, [], []);
    const u = out.find((v) => v.id === "v3")!;
    expect(u.totalSpend).toBe(0);
    expect(u.docCount).toBe(0);
    expect(u.lastBillDate).toBeNull();
  });
});
