/**
 * R-1586 — the accounting reports must read EVERY row, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. R-1519 paged the money lists; the
 * GST report (GSTR-1 / 3B), Customer Aging, Profitability, Profit by product and the 24Q /
 * 26Q TDS exports still read in one request — a quarter with 1000+ invoices, notes or
 * expenses filed short tax with no error.
 *
 * The fake client below behaves like the gateway (same shape as money-unbounded.test.ts):
 * it honours filters, .order() and .range(), and caps every answer at 1000 rows.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { loadGstReport } from "@/app/(app)/accounting/gst/report";
import { readOpenInvoices } from "@/app/(app)/accounting/aging/read";
import { readPoSummaries, readRevenueQuotes } from "@/app/(app)/accounting/profitability/read";
import { readRevenueQuoteLines } from "@/app/(app)/reports/profit/read";
import { read24Q } from "@/app/(app)/accounting/salary-register/tds-24q";
import { read26Q } from "@/app/(app)/accounting/expenses/tds-26q";
import { fetchBillPayments } from "../bill-payments";
import { fetchEmployeeLoans } from "../employee-loans";
import { fetchEmiPurchases } from "../emi";
import { fetchBusinessLoans } from "../business-loans";
import { fetchReimbursements } from "../reimbursements";
import { fetchPrepaidAdvances } from "../prepaid-advances";
import { fetchReferralCommissions } from "../referral-commissions";
import { fetchExpenseClaims } from "../expense-claims";
import { fetchTdsMonths } from "../compliance";

const GATEWAY_MAX_ROWS = 1000;
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

/** A fake PostgREST that caps like the real gateway. */
function gatewayClient(tables: Record<string, Row[]>, rpcs: Record<string, Row[]> = {}) {
  let requests = 0;
  const builder = (source: () => Row[]) => {
    requests++;
    const filters: Filter[] = [];
    const orders: [string, boolean][] = [];
    let limit: number | undefined;
    let offset = 0;
    let single = false;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
    b.is = (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.gt = (c: string, v: number) => { filters.push((r) => Number(r[c]) > v); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.lte = (c: string, v: string) => { filters.push((r) => String(r[c]) <= v); return b; };
    b.lt = (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return b; };
    b.not = (c: string, op: string, v: unknown) => { filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return b; };
    b.or = () => b;
    b.order = (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return b; };
    b.limit = (n: number) => { limit = n; return b; };
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
    b.maybeSingle = () => { single = true; return b; };
    b.single = () => { single = true; return b; };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let rows = source().filter((r) => filters.every((f) => f(r)));
      if (orders.length) {
        rows = [...rows].sort((a, z) => {
          for (const [c, asc] of orders) {
            const x = String(a[c]), y = String(z[c]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      const cap = Math.min(limit ?? GATEWAY_MAX_ROWS, GATEWAY_MAX_ROWS);
      const page = rows.slice(offset, offset + cap);
      return Promise.resolve({ data: single ? page[0] ?? null : page, error: null }).then(res, rej);
    };
    return b;
  };
  const client = {
    from: (table: string) => builder(() => tables[table] ?? []),
    rpc: (name: string) => builder(() => rpcs[name] ?? []),
  };
  return { client: client as never, requests: () => requests };
}

const pad = (i: number) => String(i).padStart(5, "0");
const N = 2500;
const RANGE = { from: "2026-04-01", to: "2026-06-30", label: "Q1 FY 2026-27" };
/** A day inside RANGE (91 days), spread so every date has many rows. */
const inQ = (i: number) => new Date(Date.UTC(2026, 3, 1) + (i % 91) * 86_400_000).toISOString().slice(0, 10);

describe("the fake gateway is honest", () => {
  it("an unpaged select comes back as 1000 rows, as on staging", async () => {
    const { client } = gatewayClient({ invoices: Array.from({ length: N }, (_, i) => ({ id: `i${pad(i)}` })) });
    const c = client as unknown as { from: (t: string) => { select: () => PromiseLike<{ data: Row[] }> } };
    expect((await c.from("invoices").select()).data).toHaveLength(GATEWAY_MAX_ROWS);
  });
});

describe("GST report reads the whole period (R-1586)", () => {
  it("2,500 invoices + 1,500 credit notes + 1,200 debit notes + 1,300 advances + 1,100 bills + 1,400 expenses", async () => {
    const customers = Array.from({ length: 1300 }, (_, i) => ({ id: `c${pad(i)}`, gstin: null, state_code: "07", state: "Delhi", country: "India" }));
    const invoices = Array.from({ length: N }, (_, i) => ({
      id: `i${pad(i)}`, amount: 1180, invoice_date: inQ(i), customer_name: `C ${i}`, customer_id: `c${pad(i % 1300)}`,
      status: "pending", taxable_value: 1000, tax_amount: 180, tax_rate: 18, inter_state: false, line_items: [],
      adjusted_advances: [], customer_gstin: null, pos_state_code: "07", customer_country: "India", billing_address: null,
      seller_state_code: "07", document_kind: "tax_invoice",
    }));
    // Notes amend invoices from before the period — 1,500 parent lookups past one page.
    const parents = Array.from({ length: 1500 }, (_, i) => ({
      id: `p${pad(i)}`, invoice_date: "2026-01-15", line_items: [], customer_gstin: null, pos_state_code: "07",
      customer_country: "India", billing_address: null, seller_state_code: "07", status: "paid", amount: 590,
    }));
    const creditNotes = Array.from({ length: 1500 }, (_, i) => ({
      id: `cn${pad(i)}`, invoice_id: `p${pad(i)}`, credit_date: inQ(i), customer_name: "X", customer_id: `c${pad(i % 1300)}`,
      amount: 118, taxable_value: 100, tax_amount: 18, tax_rate: 18, inter_state: false,
    }));
    const debitNotes = Array.from({ length: 1200 }, (_, i) => ({
      id: `dn${pad(i)}`, invoice_id: `p${pad(i)}`, debit_date: inQ(i), customer_name: "X", customer_id: `c${pad(i % 1300)}`,
      amount: 59, taxable_value: 50, tax_amount: 9, tax_rate: 18, inter_state: false,
    }));
    // 1,300 advances, each on its own quote whose invoice was issued after the period.
    const quotes = Array.from({ length: 1300 }, (_, i) => ({ id: `q${pad(i)}`, invoice_id: `later${pad(i)}`, tax_rate: 18, customer_id: `c${pad(i)}` }));
    const later = Array.from({ length: 1300 }, (_, i) => ({ id: `later${pad(i)}`, invoice_date: "2026-08-01", status: "pending", amount: 0 }));
    const payments = Array.from({ length: 1300 }, (_, i) => ({
      id: `pay${pad(i)}`, receipt_voucher_no: `RV-${i}`, amount: 1180, credit_applied: 0, status: "received",
      received_at: `${inQ(i)}T06:00:00.000Z`, quote_id: `q${pad(i)}`, customer_id: null,
    }));
    const bills = Array.from({ length: 1100 }, (_, i) => ({
      id: `b${pad(i)}`, bill_date: inQ(i), vendor_name: "V", vendor_gstin: null, subtotal: 1000, cgst: 90, sgst: 90, igst: 0,
      total: 1180, category: "Software", bill_no: `VB-${i}`, document_type: "tax_invoice",
    }));
    const expenses = Array.from({ length: 1400 }, (_, i) => ({
      id: `e${pad(i)}`, expense_date: inQ(i), vendor_name: "V", vendor_id: `v${pad(i % 1200)}`, bill_type: "gst",
      amount: 118, gst_paid: 18, igst: 0, cgst: 9, sgst: 9, category: "Office", bill_no: null, rcm: i < 1050, rcm_tax: i < 1050 ? 5 : 0,
    }));
    const vendors = Array.from({ length: 1200 }, (_, i) => ({ id: `v${pad(i)}`, gstin: null }));
    const { client } = gatewayClient({
      invoices: [...invoices, ...parents, ...later], credit_notes: creditNotes, debit_notes: debitNotes, payments, quotes,
      customers, vendor_bills: bills, expenses, vendors, tenants: [{ state_code: "07", state: "Delhi", gstin: null }],
    });

    const r = await loadGstReport(client, RANGE);

    expect(r.outputRows.filter((x) => x.docType === "invoice")).toHaveLength(N);
    expect(r.outputRows.filter((x) => x.docType === "credit_note")).toHaveLength(1500);
    expect(r.outputRows.filter((x) => x.docType === "debit_note")).toHaveLength(1200);
    // Output GST = 2,500 × 180 − 1,500 × 18 + 1,200 × 9 — the maths is unchanged, only the rows are all there.
    expect(r.outputGST).toBe(N * 180 - 1500 * 18 + 1200 * 9);
    expect(r.outputTotal).toBe(N * 1000 - 1500 * 100 + 1200 * 50);
    // Every advance found its quote and that quote's invoice (lookups past one page / one IN chunk).
    expect(r.advances).toHaveLength(1300);
    expect(r.advances.every((a) => a.adjustedOn === "2026-08-01")).toBe(true);
    // Every input document's GST is either credit or cost — none dropped at the cap.
    expect(r.blockedItc.eligible + r.blockedItc.blocked).toBe(1100 * 180 + 1400 * 18);
    expect(r.rcmRows).toHaveLength(1050);
  });
});

describe("Customer Aging reads every open invoice (R-1586)", () => {
  it("2,500 open invoices → 2,500, not 1000", async () => {
    const rows = Array.from({ length: N }, (_, i) => ({ id: `i${pad(i)}`, status: i % 2 ? "pending" : "overdue", amount: 100 }));
    const { client } = gatewayClient({ invoices: [...rows, { id: "paid", status: "paid", amount: 100 }] });
    const got = await readOpenInvoices(client);
    expect(got).toHaveLength(N);
    expect(new Set(got.map((r) => r.id)).size).toBe(N);
  });
});

describe("Profitability reads every quote in the range (R-1586)", () => {
  it("2,500 revenue quotes and 1,300 customers' PO summaries", async () => {
    const quotes = Array.from({ length: N }, (_, i) => ({ id: `q${pad(i)}`, created_date: inQ(i), payment_status: "received", amount: 100 }));
    const po = Array.from({ length: 1300 }, (_, i) => ({ purchase_order_id: `po${pad(i)}`, customer_id: `c${pad(i)}`, allocated_total: 10, allocation_count: 1 }));
    const { client } = gatewayClient({ quotes: [...quotes, { id: "draft", created_date: inQ(1), payment_status: "pending" }], purchase_order_summary: po });
    expect(await readRevenueQuotes(client, RANGE)).toHaveLength(N);
    const got = await readPoSummaries(client, po.map((p) => p.customer_id));
    expect(got.reduce((s, p) => s + p.allocated_total, 0)).toBe(13_000);
  });
});

describe("Profit by product reads every revenue quote ever (R-1586)", () => {
  it("2,500 quotes → 2,500 sets of lines", async () => {
    const quotes = Array.from({ length: N }, (_, i) => ({ id: `q${pad(i)}`, payment_status: "invoiced", line_items: [{ name: "Seat", qty: 1, rate: 10 }] }));
    const { client } = gatewayClient({ quotes });
    expect(await readRevenueQuoteLines(client)).toHaveLength(N);
  });
});

describe("24Q / 26Q TDS exports read every deductee row (R-1586)", () => {
  it("24Q: 2,500 salary payments, 1,200 employees", async () => {
    const pays = Array.from({ length: N }, (_, i) => ({ id: `s${pad(i)}`, employee_id: `emp${pad(i % 1200)}`, period: ["2026-04", "2026-05", "2026-06"][i % 3], tds: 100 }));
    const emps = Array.from({ length: 1200 }, (_, i) => ({ id: `emp${pad(i)}`, name: `E ${i}`, pan: "ABCDE1234F" }));
    const challans = [{ id: "ch1", period: "2026-04", kind: "tds", challan_no: "1", paid_on: "2026-05-07" }];
    const { client } = gatewayClient({ salary_payments: pays, employees: emps, statutory_dues_payments: challans });
    const got = await read24Q(client, ["2026-04", "2026-05", "2026-06"]);
    expect(got.pays).toHaveLength(N);
    expect(got.pays.reduce((s, p) => s + p.tds, 0)).toBe(N * 100);
    expect(got.emps).toHaveLength(1200);
    expect(got.challans).toHaveLength(1);
  });

  it("26Q: 2,500 TDS expenses, 1,300 vendors", async () => {
    const exps = Array.from({ length: N }, (_, i) => ({ id: `e${pad(i)}`, expense_date: inQ(i), vendor_id: `v${pad(i % 1300)}`, tds_amount: 10 }));
    const vends = Array.from({ length: 1300 }, (_, i) => ({ id: `v${pad(i)}`, gstin: null, pan: "ABCDE1234F" }));
    const { client } = gatewayClient({ expenses: [...exps, { id: "no-tds", expense_date: inQ(1), tds_amount: 0 }], vendors: vends });
    const got = await read26Q(client, RANGE);
    expect(got.exps).toHaveLength(N);
    expect(got.vends).toHaveLength(1300);
  });
});

describe("R-1582: the other money lists read every row", () => {
  it("bill payments: 1,500 bank lines matched to 1,300 bills — every line, every bill number", async () => {
    const bills = Array.from({ length: 1300 }, (_, i) => ({ id: `b${pad(i)}`, bill_no: `VB-${i}`, vendor_name: `V ${i}` }));
    const txns = Array.from({ length: 1500 }, (_, i) => ({
      id: `t${pad(i)}`, txn_date: inQ(i), description: "Bill payment: X", debit: 100, reference: null,
      bank_account_id: "acc1", matched_to_type: "vendor_bill", matched_to_id: `b${pad(i % 1300)}`,
    }));
    const { client } = gatewayClient({ bank_transactions: txns, vendor_bills: bills, bank_accounts: [{ id: "acc1", name: "HDFC" }] });
    const got = await fetchBillPayments(client);
    expect(got).toHaveLength(1500);
    expect(got.reduce((s, p) => s + p.amount, 0)).toBe(150_000);
    expect(got.every((p) => p.bill_no !== null && p.bank_account_name === "HDFC")).toBe(true);
  });

  it("employee loan: 1,100 repayments of ₹10 on a ₹20,000 loan → outstanding ₹9,000, not ₹10,000", async () => {
    const reps = Array.from({ length: 1100 }, (_, i) => ({ id: `r${pad(i)}`, loan_id: "L1", amount: 10 }));
    const { client } = gatewayClient({ employee_loans: [{ id: "L1", principal: 20_000, created_at: "2026-01-01" }], employee_loan_repayments: reps });
    const [loan] = await fetchEmployeeLoans(client);
    expect(loan.repaid).toBe(11_000);
    expect(loan.outstanding).toBe(9_000);
  });

  it("EMI purchase and business loan: 1,200 instalments each — principal paid counts all of them", async () => {
    const emi = Array.from({ length: 1200 }, (_, i) => ({ id: `ep${pad(i)}`, purchase_id: "P1", principal_part: 5 }));
    const blp = Array.from({ length: 1200 }, (_, i) => ({ id: `bp${pad(i)}`, loan_id: "BL1", principal_part: 5, interest_part: 1 }));
    const { client } = gatewayClient({
      emi_purchases: [{ id: "P1", financed: 10_000, created_at: "2026-01-01" }], emi_payments: emi,
      business_loans: [{ id: "BL1", principal: 10_000, created_at: "2026-01-01" }], business_loan_payments: blp,
    });
    const [p] = await fetchEmiPurchases(client);
    expect(p.emisPaid).toBe(1200);
    expect(p.outstanding).toBe(4_000);
    const [l] = await fetchBusinessLoans(client);
    expect(l.emisPaid).toBe(1200);
    expect(l.interestPaid).toBe(1200);
    expect(l.outstanding).toBe(4_000);
  });

  it("reimbursements, prepaid advances, commissions, expense claims: 1,300 rows each", async () => {
    const n = 1300;
    const { client } = gatewayClient({
      reimbursements: Array.from({ length: n }, (_, i) => ({ id: `rb${pad(i)}`, status: "pending", incurred_on: inQ(i), employee_id: `emp${pad(i)}` })),
      employees: Array.from({ length: n }, (_, i) => ({ id: `emp${pad(i)}`, name: `E ${i}` })),
      prepaid_advances: Array.from({ length: n }, (_, i) => ({ id: `pa${pad(i)}`, category: "Ads", paid_date: inQ(i), total_amount: 100, consumed_amount: 40 })),
      referral_commissions: Array.from({ length: n }, (_, i) => ({ id: `rc${pad(i)}`, earned_date: inQ(i) })),
      expense_claims: Array.from({ length: n }, (_, i) => ({ id: `ec${pad(i)}`, status: "pending", created_at: inQ(i), employee_id: `emp${pad(i)}` })),
    });
    const rb = await fetchReimbursements(client);
    expect(rb).toHaveLength(n);
    expect(rb.every((r) => r.employee_name)).toBe(true);
    const pa = await fetchPrepaidAdvances(client);
    expect(pa.reduce((s, a) => s + a.balance, 0)).toBe(n * 60);
    expect(await fetchReferralCommissions(client)).toHaveLength(n);
    const ec = await fetchExpenseClaims(client, "pending");
    expect(ec).toHaveLength(n);
    expect(ec.every((c) => c.employee_name !== "Employee")).toBe(true);
  });

  it("compliance: a TDS month whose rows sit past the first 1000 still counts", async () => {
    const exps = Array.from({ length: 1200 }, (_, i) => ({ id: `e${pad(i)}`, expense_date: i < 1100 ? "2026-05-10" : "2026-06-10", tds_amount: 10 }));
    const { client } = gatewayClient({ salary_payments: [], expenses: exps });
    const months = await fetchTdsMonths(client, "2026-04-01");
    expect(months.has("2026-06")).toBe(true);
  });
});
