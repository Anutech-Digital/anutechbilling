/**
 * ITR pack ka assembler — tables se `ItrSources` jodta hai, ginti lib/tax/itr.ts karta hai.
 *
 * Kaunsa aankda kahan se aur KYUN — ye faisle yahan ek jagah likhe hain:
 *
 *  - Revenue = `invoices.taxable_value` (pending/paid/overdue) − credit notes
 *    + debit notes. Wahi pinned formula jo /accounting/pnl use karta hai:
 *    revenue ki kanooni pehchan invoice ka JAARI hona hai (accrual), paisa
 *    aana nahi; aur output GST sarkar ka hai, aamdani nahi. Purani rows par
 *    `taxable_value` null ho sakta hai (migration 0116 se pehle) — wahi
 *    reverse-derive fallback.
 *  - COGS = `purchase_orders.total_cost`, sirf placed/provisioned/closed —
 *    draft abhi order hi nahi hua, cancelled hua hi nahi.
 *  - Opex = `expenses` category-wise. Salary/loan/inbound sab isi me book
 *    hote hain (unke `expense_id` link), isliye SIRF yahi source — alag se
 *    salary_payments jodna double counting hai (lib/tax/itr.ts ka header).
 *  - TDS = `tds_receivable` jahan `fiscal_year` FY se milta hai.
 *
 * Tenant scoping RLS karta hai — `.eq("tenant_id", …)` yahan nahi likha
 * jata (queries/leads.ts:24 wahi kehta hai).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  computeItrPack, financialYear,
  type ExpenseCategoryLine, type ItrPack, type ItrSources,
} from "@/lib/tax/itr";
import { incomeTaxPaidForFy } from "@/lib/accounting/tax-payments";

/** pnl/page.tsx ka pinned fallback — purani rows jinke breakdown persist nahi hue. */
function invTaxable(i: { amount: number | null; taxable_value: number | null; tax_rate: number | null }): number {
  return i.taxable_value ?? Math.round(((i.amount ?? 0) * 100) / (100 + (i.tax_rate ?? 18)));
}

export function useItrPack(fyStartYear: number) {
  return useQuery({
    queryKey: ["itr-pack", fyStartYear],
    queryFn: async (): Promise<ItrPack> => {
      const fy = financialYear(fyStartYear);
      const supabase = createClient();

      const [inv, cn, dn, po, exp, tds, taxPay] = await Promise.all([
        supabase
          .from("invoices")
          .select("amount, taxable_value, tax_rate, status, invoice_date")
          .gte("invoice_date", fy.start)
          .lte("invoice_date", fy.end)
          .in("status", ["pending", "paid", "overdue"]),
        supabase
          .from("credit_notes")
          .select("taxable_value, credit_date")
          .gte("credit_date", fy.start)
          .lte("credit_date", fy.end),
        supabase
          .from("debit_notes")
          .select("taxable_value, debit_date")
          .gte("debit_date", fy.start)
          .lte("debit_date", fy.end),
        supabase
          .from("purchase_orders")
          .select("total_cost, status, placed_at")
          .gte("placed_at", fy.start)
          // placed_at timestamptz hai; FY ke aakhri din ka poora din chahiye.
          .lt("placed_at", `${fy.startYear + 1}-04-01`)
          .in("status", ["placed", "provisioned", "closed"]),
        supabase
          .from("expenses")
          .select("category, amount, gst_paid, expense_date")
          .gte("expense_date", fy.start)
          .lte("expense_date", fy.end),
        supabase
          .from("tds_receivable")
          .select("tds_amount, fiscal_year")
          .eq("fiscal_year", fy.fiscalKey)
          // R-1567: a refunded / deleted payment's TDS is 'reversed' — not a credit to claim
          // (filter(): the generated TdsStatus type does not list it).
          .filter("status", "neq", "reversed"),
        // Advance + self-assessment tax jo bank line se "tax payment" book hua (tax_payments).
        supabase
          .from("tax_payments")
          .select("kind, amount, period, fy")
          .in("kind", ["advance_tax", "self_assessment_tax"]),
      ]);

      for (const r of [inv, cn, dn, po, exp, tds, taxPay]) {
        if (r.error) throw r.error;
      }

      const invoiceRows = inv.data ?? [];
      const cnRows = cn.data ?? [];
      const dnRows = dn.data ?? [];
      const revenueExGst =
        invoiceRows.reduce((s, i) => s + invTaxable(i), 0) -
        cnRows.reduce((s, n) => s + (n.taxable_value ?? 0), 0) +
        dnRows.reduce((s, n) => s + (n.taxable_value ?? 0), 0);

      const poRows = po.data ?? [];
      const purchaseCost = poRows.reduce((s, p) => s + (p.total_cost ?? 0), 0);

      const byCategory = new Map<string, ExpenseCategoryLine>();
      for (const e of exp.data ?? []) {
        const key = e.category || "Other";
        const line = byCategory.get(key) ?? { category: key, amount: 0, gst: 0, count: 0 };
        line.amount += e.amount ?? 0;
        line.gst += e.gst_paid ?? 0;
        line.count += 1;
        byCategory.set(key, line);
      }

      const tdsRows = tds.data ?? [];

      const sources: ItrSources = {
        revenueExGst,
        invoiceCount: invoiceRows.length,
        creditNoteCount: cnRows.length,
        debitNoteCount: dnRows.length,
        purchaseCost,
        purchaseCount: poRows.length,
        expenses: [...byCategory.values()],
        tdsCredit: tdsRows.reduce((s, t) => s + (t.tds_amount ?? 0), 0),
        tdsCount: tdsRows.length,
        // Banking me bank line ko "Income tax" payment book karne se aata hai. Kuch book
        // nahi hua to 0 — aur pack ka gap wahi kehta rahega.
        advanceTaxPaid: incomeTaxPaidForFy(taxPay.data ?? [], fyStartYear),
      };

      return computeItrPack(fy, sources);
    },
  });
}
