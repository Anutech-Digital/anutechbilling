/**
 * R-1891 — 194Q TDS on a goods (COGS) bill sits on the bank payment row
 * (bank_vendor_payment_lines, kind bill), not on an expense. Every "TDS we deducted" reader adds it:
 *   - statutory dues (TDS payable) — lib/queries/payroll.ts fetchStatutoryDues;
 *   - the months with a TDS deposit — lib/queries/compliance.ts fetchTdsMonths;
 *   - the 26Q working — app/(app)/accounting/expenses/tds-26q.ts.
 * Case: Ingram Micro, ₹10,00,000 of the year's goods above ₹50 lakh, 0.1% = ₹1,000 deducted 5 Oct 2026.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { fetchTdsMonths } from "@/lib/queries/compliance";
import { fetchStatutoryDues } from "@/lib/queries/payroll";
import { build26QRows, read26Q } from "@/app/(app)/accounting/expenses/tds-26q";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

/** A fake PostgREST: honours the filters these reads use, .order() and .range(). */
function fakeClient(tables: Record<string, Row[]>) {
  const builder = (source: () => Row[]) => {
    const filters: Filter[] = [];
    let limit: number | undefined;
    let offset = 0;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.gt = (c: string, v: number) => { filters.push((r) => Number(r[c]) > v); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.lte = (c: string, v: string) => { filters.push((r) => String(r[c]) <= v); return b; };
    b.order = () => b;
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const rows = source().filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: rows.slice(offset, offset + (limit ?? 1000)), error: null }).then(res, rej);
    };
    return b;
  };
  return { from: (t: string) => builder(() => tables[t] ?? []) } as never;
}

const line = (o: Row = {}): Row => ({
  id: "l1", kind: "bill", tds_on: "2026-10-05", tds_amount: 1000, tds_section: "194Q", tds_base: 1_000_000,
  vendor_id: "v1", vendor_bill_id: "B2", ...o,
});
const tables = (lines: Row[]) => ({
  salary_payments: [], statutory_dues_payments: [], expenses: [], referral_commissions: [], referral_partners: [],
  bank_vendor_payment_lines: lines,
  vendors: [{ id: "v1", name: "Ingram Micro India", pan: "AAACI1891A", gstin: "07AAACI1891A1Z5" }],
  vendor_bills: [{ id: "B2", vendor_name: "Ingram Micro India", bill_no: "IM-2" }],
});

describe("R-1891 — 194Q on goods bills reaches every TDS reader", () => {
  it("TDS payable counts it; an expense / advance row on the same table does not count twice", async () => {
    const d = await fetchStatutoryDues(fakeClient(tables([
      line(),
      line({ id: "l2", kind: "expense", tds_amount: 5000, tds_section: "194J" }),   // that TDS is on the expense row already
    ])));
    expect(d.tdsVendor).toBe(1000);
  });

  it("October has a TDS deposit because of it", async () => {
    const months = await fetchTdsMonths(fakeClient(tables([line()])), "2026-07-01");
    expect([...months]).toContain("2026-10");
  });

  it("26Q working: one 194Q row — vendor, PAN, amount above ₹50 lakh, date, TDS", async () => {
    const read = await read26Q(fakeClient(tables([line()])), { from: "2026-10-01", to: "2026-10-31" });
    const { rows, totalTds, missingPan } = build26QRows(read);
    expect(rows).toEqual([["Ingram Micro India", "AAACI1891A", "194Q", "2026-10-05", 1_000_000, 1000]]);
    expect(totalTds).toBe(1000);
    expect(missingPan).toBe(0);
  });
});
