/**
 * R-2376 — the interest already booked to each lender, read from every place the app books it:
 *   business_loan_payments.interest_part (term loan EMI, credit-line repayment; tds_part kept back),
 *   emi_payments.interest_part (EMI loan / asset on EMI — Bajaj, Tata Capital),
 *   emi_purchases.processing_fee (ex-GST; the GST is a separate column and is not interest).
 * A director's loan is a non-bank lender without asking.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { fetchLoanInterestEvents, fetchLoanTdsSettings } from "./loan-interest-tds";
import { loanInterestTds, lenderKey, readLoanTdsSettings } from "@/lib/accounting/loan-interest-tds";

type Row = Record<string, unknown>;
function fakeClient(tables: Record<string, Row[]>, errors: Record<string, string> = {}) {
  const builder = (t: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let offset = 0; let limit: number | undefined;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.gt = (c: string, v: number) => { filters.push((r) => Number(r[c]) > v); return b; };
    b.order = () => b;
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
    b.maybeSingle = () => Promise.resolve(errors[t]
      ? { data: null, error: { message: errors[t] } }
      : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (errors[t]) return Promise.resolve({ data: null, error: { message: errors[t] } }).then(res, rej);
      const rows = (tables[t] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: rows.slice(offset, offset + (limit ?? 1000)), error: null }).then(res, rej);
    };
    return b;
  };
  return { from: (t: string) => builder(t) } as never;
}

const tables = {
  business_loans: [
    { id: "L1", lender: "Bajaj Finance", director_id: null },
    { id: "L2", lender: "Rahul Sharma", director_id: "D1" },
  ],
  business_loan_payments: [
    { loan_id: "L1", interest_part: 46_000, tds_part: 4_600, paid_on: "2026-09-05" },
    { loan_id: "L1", interest_part: 46_000, tds_part: 0, paid_on: "2026-01-05" },   // before the window
    { loan_id: "L2", interest_part: 12_000, tds_part: 0, paid_on: "2026-06-30" },
  ],
  emi_purchases: [
    { id: "E1", lender: "Tata Capital", processing_fee: 4_000, processing_fee_gst: 720, purchased_on: "2026-04-10" },
    { id: "E2", lender: null, processing_fee: 0, processing_fee_gst: 0, purchased_on: "2026-04-10" },
  ],
  emi_payments: [
    { purchase_id: "E1", interest_part: 3_000, paid_on: "2026-05-05" },
    { purchase_id: "E1", interest_part: 3_000, paid_on: "2026-06-05" },
    { purchase_id: "E1", interest_part: 0, paid_on: "2026-07-05" },
    { purchase_id: "E2", interest_part: 900, paid_on: "2026-07-05" },
  ],
};

describe("R-2376 fetchLoanInterestEvents", () => {
  it("reads interest from loan payments, EMI payments and the processing fee ex-GST", async () => {
    const ev = await fetchLoanInterestEvents(fakeClient(tables), "2026-04-01");
    const by = (l: string) => ev.filter((e) => lenderKey(e.lender) === lenderKey(l));
    expect(by("Bajaj Finance")).toEqual([{ lender: "Bajaj Finance", on: "2026-09-05", amount: 46_000, kind: "interest", tdsKept: 4_600, lenderType: null }]);
    expect(by("Tata Capital").map((e) => [e.kind, e.amount, e.on])).toEqual([
      ["fee", 4_000, "2026-04-10"], ["interest", 3_000, "2026-05-05"], ["interest", 3_000, "2026-06-05"],
    ]);
    expect(by("Rahul Sharma")[0]).toMatchObject({ amount: 12_000, lenderType: "non_bank" });
    expect(ev.some((e) => !e.lender)).toBe(false);   // an EMI purchase with no lender is skipped
  });

  it("owner path: Tata Capital fee + 2 EMIs = ₹10,000 → not yet; Bajaj ₹46,000 with ₹4,600 kept → settled", async () => {
    const ev = await fetchLoanInterestEvents(fakeClient(tables), "2026-04-01");
    const s = readLoanTdsSettings({ lenders: { [lenderKey("Tata Capital")]: "non_bank", [lenderKey("Bajaj Finance")]: "non_bank" } });
    const r = loanInterestTds({ events: ev, settings: s, businessType: "pvt_ltd", fyStart: 2026 });
    const line = (l: string) => r.lines.find((x) => x.key === lenderKey(l));
    expect(line("Tata Capital")).toMatchObject({ total: 10_000, status: "below_limit" });
    expect(line("Bajaj Finance")).toMatchObject({ total: 46_000, tdsKept: 4_600, status: "settled" });
    expect(line("Rahul Sharma")).toMatchObject({ status: "due", tdsDue: 1_200 });
  });
});

describe("R-2376 fetchLoanTdsSettings", () => {
  it("reads the tenant's answers", async () => {
    const s = await fetchLoanTdsSettings(fakeClient({ tenants: [{ id: "T1", loan_interest_tds: { off: true } }] }), "T1");
    expect(s).toEqual({ ready: true, settings: { off: true, audited: {}, lenders: {} } });
  });
  it("before the migration (column missing) → not ready, empty answers (the screen hides the check)", async () => {
    const s = await fetchLoanTdsSettings(fakeClient({}, { tenants: 'column tenants.loan_interest_tds does not exist' }), "T1");
    expect(s.ready).toBe(false);
  });
});
