/**
 * S17 report RPCs ke jawab ko app ke types me badalna — pure, taaki test ho sake.
 *
 * Balance sheet: `report_balance_sheet` (migration 20260928110000) jode hue aankde deta
 * hai; jo niyam TS me tested hain (WDV, ITC, statutory dues, income-tax FY) wo yahin chalte
 * hain, chhote grouped inputs par. Purana per-row hisaab reports-reference.ts me oracle hai.
 */
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";
import { splitItc } from "@/lib/gst/itc";
import { statutoryDues } from "@/lib/accounting/tds-deductor";
import { bookValueNow, type AssetLike } from "@/lib/accounting/depreciation";
import { incomeTaxPaidForFy, type TaxPaymentLike } from "@/lib/accounting/tax-payments";

/**
 * RPC ka nateeja → ek row, ya saaf error.
 *
 * Function hi na mile (migration abhi lagi nahi) to "0" ya khaali report dikhana §2 wali
 * galti hoti — ek bharosemand dikhne wala galat number. Isliye naam leke fail.
 */
export function rpcRowOrThrow<T>(
  res: { data: unknown; error: { code?: string; message: string } | null },
  fn: string,
): T {
  const d = rpcValueOrThrow<unknown>(res, fn);
  const row = Array.isArray(d) ? d[0] : d;
  if (row == null) {
    throw new Error(`Report nahi ban saka: \`${fn}\` ne koi row nahi lautayi. Page reload karein; phir bhi ho to support ko batayein.`);
  }
  return row as T;
}

/** jsonb lautane wale RPC ke liye — jawab jaisa hai waisa (array ho to bhi poora). */
export function rpcValueOrThrow<T>(
  res: { data: unknown; error: { code?: string; message: string } | null },
  fn: string,
): T {
  if (res.error) {
    const missing = res.error.code === "PGRST202" || res.error.code === "42883";
    throw new Error(missing
      ? `Report nahi ban saka: database me \`${fn}\` function nahi mila. Migration abhi lagi nahi hai — admin se lagwayein, phir page reload karein.`
      : res.error.message);
  }
  if (res.data == null) {
    throw new Error(`Report nahi ban saka: \`${fn}\` ne kuch nahi lautaya. Page reload karein; phir bhi ho to support ko batayein.`);
  }
  return res.data as T;
}

/** `report_balance_sheet` ki row — naam migration ke RETURNS TABLE jaise. */
export interface BalanceSheetRpcRow {
  as_of: string;
  fy_start_year: number;
  fy_label: string;
  cash_and_bank: number;
  /** R-179 (migration 20261006140000). Migration lagne se pehle column hota hi nahi. */
  undeposited_funds?: number | null;
  credit_card_payable: number;
  receivables: number;
  advances_from_customers: number;
  project_receivable: number;
  tds_receivable: number;
  employee_loans: number;
  prepaid_advances: number;
  emi_unregistered_cost: number;
  emi_loans_payable: number;
  business_loans_payable: number;
  payables: number;
  salary_payable: number;
  dues_salary_tds: number;
  dues_pf: number;
  dues_esi: number;
  dues_vendor_tds: number;
  dues_paid: { kind: string; amount: number }[];
  reimbursements_payable: number;
  gst_output: number;
  bills_gst: number;
  itc_groups: { bill_type: string | null; category: string | null; vendorGstin: string | null; gst_paid: number; n: number }[];
  fixed_assets: (AssetLike & { emi_purchase_id: string | null })[];
  tax_payments: TaxPaymentLike[];
}

export function balanceSheetFromRpc(r: BalanceSheetRpcRow): BalanceSheetAuto {
  /* WDV har register asset ka (as_of par); EMI jo register me nahi wo cost par (SQL ne joda). */
  const fixedAssets = r.fixed_assets.reduce((s, a) => s + bookValueNow(a, r.as_of), 0) + r.emi_unregistered_cost;

  /* statutoryDues rows par sum karta hai; SQL ne hisse pehle hi jod diye, isliye ek row. */
  const salaryDuesPayable = statutoryDues({
    salaries: [{ tds: r.dues_salary_tds, pf: r.dues_pf, esi: r.dues_esi }],
    vendorTds: r.dues_vendor_tds,
    paid: r.dues_paid,
  }).payable;

  const expGst = splitItc(r.itc_groups).eligible;
  const gstPaid = r.tax_payments.filter((p) => p.kind === "gst").reduce((s, p) => s + p.amount, 0);
  const advanceTaxPaid = incomeTaxPaidForFy(r.tax_payments, r.fy_start_year);
  const gstPayable = r.gst_output - r.bills_gst - expGst - gstPaid;

  return {
    cashAndBank: r.cash_and_bank,
    /* Migration 20261006140000 se pehle column nahi aata: tab 0 — yaani aaj tak wala hi
       number, koi naya galat number nahi. Migration lagte hi asli raqam. */
    undepositedFunds: r.undeposited_funds ?? 0,
    receivables: r.receivables,
    advancesFromCustomers: r.advances_from_customers,
    projectReceivable: r.project_receivable,
    tdsReceivable: r.tds_receivable,
    employeeLoans: r.employee_loans,
    prepaidAdvances: r.prepaid_advances,
    fixedAssets,
    payables: r.payables,
    salaryPayable: r.salary_payable,
    salaryDuesPayable,
    reimbursementsPayable: r.reimbursements_payable,
    creditCardPayable: r.credit_card_payable,
    emiLoansPayable: r.emi_loans_payable,
    businessLoansPayable: r.business_loans_payable,
    gstPayable,
    gstPaid,
    advanceTaxPaid,
    fyLabel: r.fy_label,
  };
}
