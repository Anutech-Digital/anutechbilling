/**
 * R-1519 — money screens must read EVERY row, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. R-1509 fixed the bank page; the
 * same cut sat in Payment runs (only the first 1000 unpaid bills could be paid), Money out
 * (`.limit(2000)` → 1000 lines summed), the expense duplicate check, the outstanding-payable
 * KPI, statutory dues, loans given and the Google bill check.
 *
 * The fake client below behaves like the gateway (same shape as bank-unbounded.test.ts): it
 * honours filters, .order() and .range(), and caps every answer — table or set-returning
 * RPC — at 1000 rows whatever .limit() asked for.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { fetchPayables, fetchVendorBanks } from "../payment-runs";
import { fetchMoneyOut } from "../payments-made";
import { fetchExpenseDupList, fetchOutstandingPayable, findDuplicateExpense } from "../expenses";
import { fetchStatutoryDues } from "../payroll";
import { fetchLoansGiven } from "../loans-given";
import { fetchGoogleBillBooks } from "@/app/(app)/accounting/google-bill-check/books";

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
    b.or = () => b;   // the fixtures below never rely on an .or() filter
    b.order = (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return b; };
    b.limit = (n: number) => { limit = n; return b; };
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
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
      return Promise.resolve({ data: rows.slice(offset, offset + cap), error: null }).then(res, rej);
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
const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + (i % 600) * 86_400_000).toISOString().slice(0, 10);

describe("the fake gateway is honest", () => {
  it("the old reads — .limit(2000) / no range — come back as 1000 rows, as on staging", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `t${pad(i)}`, debit: 1 }));
    const { client } = gatewayClient({ bank_transactions: rows });
    const c = client as unknown as { from: (t: string) => { select: () => { limit: (n: number) => PromiseLike<{ data: Row[] }> } } };
    expect((await c.from("bank_transactions").select().limit(2000)).data).toHaveLength(1000);
    expect((await (c.from("bank_transactions").select() as unknown as PromiseLike<{ data: Row[] }>)).data).toHaveLength(1000);
  });
});

describe("Payment runs offer every unpaid bill (R-1519)", () => {
  it("1,500 unpaid vendor bills + 1,200 unpaid expenses → 2,700 payables, not 1000 + 1000", async () => {
    const bills = Array.from({ length: 1500 }, (_, i) => ({
      id: `b${pad(i)}`, bill_no: `VB-${i}`, vendor_id: `v${i % 40}`, vendor_name: `Vendor ${i % 40}`,
      bill_date: day(i), due_date: day(i + 30), total: 1_000 + i, paid_amount: i % 2 ? 500 : 0, currency: "INR",
      status: i % 2 ? "partial" : "unpaid",
    }));
    const paidBill = { ...bills[0], id: "b-paid", status: "paid", paid_amount: 1_000 };
    const exps = Array.from({ length: 1200 }, (_, i) => ({
      id: `e${pad(i)}`, bill_no: null, vendor_id: null, vendor_name: `Payee ${i}`, category: "Office",
      expense_date: day(i), due_date: null, amount: 200, currency: "INR", paid: false,
    }));
    // 1,100 MSME deadlines — the one for the 1,050th bill sits past the RPC's first page.
    const msme = bills.slice(0, 1100).map((b) => ({ source: "vendor_bill", doc_id: b.id, deadline: "2025-03-01", over_limit: false }));
    const { client } = gatewayClient({ vendor_bills: [...bills, paidBill], expenses: exps }, { msme_payables_aging: msme });

    const got = await fetchPayables(client);
    expect(got.filter((p) => p.source === "vendor_bill")).toHaveLength(1500);
    expect(got.filter((p) => p.source === "expense")).toHaveLength(1200);
    expect(new Set(got.map((p) => `${p.source}:${p.docId}`)).size).toBe(2700);
    // Amounts are what they always were: total − paid_amount, expense amount.
    const owedBills = bills.reduce((s, b) => s + (b.total - b.paid_amount), 0);
    expect(got.filter((p) => p.source === "vendor_bill").reduce((s, p) => s + p.outstanding, 0)).toBe(owedBills);
    expect(got.filter((p) => p.source === "expense").reduce((s, p) => s + p.outstanding, 0)).toBe(1200 * 200);
    expect(got.find((p) => p.docId === "b01050")?.msmeDeadline).toBe("2025-03-01");
  });

  it("every vendor's bank details, past the 1000th vendor", async () => {
    const vendors = Array.from({ length: 1300 }, (_, i) => ({
      id: `v${pad(i)}`, name: `Vendor ${i}`, bank_account_name: null, bank_account_no: `00${i}`, bank_ifsc: "HDFC0000001", upi_id: null,
    }));
    const { client } = gatewayClient({ vendors });
    const got = await fetchVendorBanks(client);
    expect(got).toHaveLength(1300);
    expect(got.some((v) => v.id === "v01299")).toBe(true);
  });
});

describe("Money out sums every debit line (R-1519)", () => {
  it("2,500 debit lines → 2,500 lines and their full total, payee resolved past the 1000th", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => ({
      id: `t${pad(i)}`, txn_date: day(i), description: `NEFT-PAYEE-${i}`, debit: 100 + (i % 7), credit: 0, reference: null,
      matched_to_type: i < 1500 ? "expense" : null, matched_to_id: i < 1500 ? `e${pad(i)}` : null, bank_account_id: "acc1",
    }));
    const transfer = { ...lines[0], id: "t-transfer", debit: 99_999, matched_to_type: "transfer", matched_to_id: null };
    const credit = { ...lines[0], id: "t-credit", debit: 0, credit: 5_000, matched_to_type: null, matched_to_id: null };
    const expenses = Array.from({ length: 1500 }, (_, i) => ({ id: `e${pad(i)}`, vendor_name: `Vendor ${i}`, category: "Hosting", bill_no: `B${i}`, description: null }));
    const { client } = gatewayClient({
      bank_transactions: [...lines, transfer, credit],
      bank_accounts: [{ id: "acc1", name: "HDFC" }],
      expenses,
    });

    const got = await fetchMoneyOut(client);
    expect(got).toHaveLength(2500);                                   // transfer + credit left out, as before
    expect(got.reduce((s, l) => s + l.amount, 0)).toBe(lines.reduce((s, l) => s + l.debit, 0));
    expect(got.filter((l) => l.group === "vendors")).toHaveLength(1500);
    expect(got.find((l) => l.id === "t01400")?.payee).toBe("Vendor 1400");   // the 1,400th expense was looked up
    expect(got.every((l) => l.account === "HDFC")).toBe(true);
  });
});

describe("Expenses — duplicate check and outstanding total see every row (R-1519)", () => {
  it("a bill entered 1,500 expenses ago is still caught as a duplicate", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${pad(i)}`, vendor_id: `v${i}`, vendor_name: `Vendor ${i}`, bill_no: `INV-${i}`,
      expense_date: day(i), amount: 1_000, currency: "INR", category: "Hosting",
    }));
    const { client } = gatewayClient({ expenses: rows });
    const list = await fetchExpenseDupList(client);
    expect(list).toHaveLength(1500);
    // The oldest bill — the one a 1000-row read dropped.
    const oldest = [...rows].sort((a, z) => (a.expense_date < z.expense_date ? -1 : 1))[0];
    const dup = findDuplicateExpense({ vendorId: oldest.vendor_id, billNo: oldest.bill_no, category: "Hosting" }, list);
    expect(dup?.id).toBe(oldest.id);
  });

  it("1,200 unpaid expenses of ₹100 → ₹1,20,000 owed, not ₹1,00,000", async () => {
    const unpaid = Array.from({ length: 1200 }, (_, i) => ({ id: `e${pad(i)}`, amount: 100, paid: false, payment_method: null, reconciled_txn_id: null }));
    const salaries = Array.from({ length: 1100 }, (_, i) => ({ id: `s${pad(i)}`, net: 50, paid_amount: 0, paid_status: "unpaid" }));
    const { client } = gatewayClient({ expenses: unpaid, salary_payments: salaries });
    const got = await fetchOutstandingPayable(client);
    expect(got).toEqual({ count: 2300, amount: 1200 * 100 + 1100 * 50 });
  });
});

describe("Statutory dues count every payslip (R-1519)", () => {
  it("1,500 payslips with ₹100 PF + ₹100 employer PF → ₹3,00,000 withheld PF", async () => {
    const slips = Array.from({ length: 1500 }, (_, i) => ({ id: `s${pad(i)}`, tds: 10, pf: 100, pf_employer: 100, esi: 0, esi_employer: 0 }));
    const vendorTds = Array.from({ length: 1100 }, (_, i) => ({ id: `e${pad(i)}`, tds_amount: 5 }));
    const { client } = gatewayClient({ salary_payments: slips, expenses: vendorTds, statutory_dues_payments: [] });
    const got = await fetchStatutoryDues(client);
    expect(got.pf).toBe(300_000);
    expect(got.tdsSalary).toBe(15_000);
    expect(got.tdsVendor).toBe(5_500);
  });
});

describe("Loans given read every repayment (R-1519)", () => {
  it("1,200 repayments on one loan are all on it", async () => {
    const loan = {
      id: "L1", borrower_name: "A", borrower_type: "person", principal: 2_000_000, given_on: "2020-01-01", interest_rate: 0,
      plan: "lump_sum", due_on: null, instalments: null, status: "active", tenant_id: "t1",
    };
    const reps = Array.from({ length: 1200 }, (_, i) => ({ id: `r${pad(i)}`, loan_id: "L1", repaid_on: day(i), amount: 1_000, principal_part: 1_000, interest_part: 0 }));
    const { client } = gatewayClient({ loans_given: [loan], loan_repayments: reps });
    const got = await fetchLoansGiven(client);
    expect(got).toHaveLength(1);
    expect(got[0].repayments).toHaveLength(1200);
  });
});

describe("Google bill check sees every subscription and customer (R-1519)", () => {
  it("1,200 Google subscriptions and 1,100 customers with a domain", async () => {
    const subs = Array.from({ length: 1200 }, (_, i) => ({ id: `s${pad(i)}`, vendor: "google", domain: `d${i}.in` }));
    const other = { id: "s-ms", vendor: "microsoft", domain: "x.in" };
    const customers = Array.from({ length: 1100 }, (_, i) => ({ id: `c${pad(i)}`, name: `C ${i}`, domain: `d${i}.in` }));
    const { client } = gatewayClient({ subscriptions: [...subs, other], customers: [...customers, { id: "c-nodomain", name: "N", domain: null }] });
    const got = await fetchGoogleBillBooks(client);
    expect(got.subs).toHaveLength(1200);
    expect(got.customers).toHaveLength(1100);
  });
});
