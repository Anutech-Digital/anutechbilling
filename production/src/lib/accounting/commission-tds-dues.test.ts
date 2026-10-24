/**
 * R-1580 — TDS deducted on a partner's commission (s.194H) was nowhere in the books' TDS side.
 *
 * referral_commissions keeps gross_commission, tds_amount and net_payable (baseline.sql), and
 * pay_referral_commission sends only the net from the bank
 * (supabase/migrations/20261011120000_r718_money_roles.sql:1034-1045). But:
 *   - the 26Q working read only expenses (src/app/(app)/accounting/expenses/tds-26q.ts:13-19);
 *   - "Deposit TDS" months counted only salary + expense TDS (src/lib/queries/compliance.ts:66-75,
 *     src/lib/compliance/tds-not-applicable.ts:22-34) → a month with only commission TDS was
 *     "nothing to deposit";
 *   - statutory dues counted only expenses.tds_amount (src/lib/queries/payroll.ts:479-481 and
 *     report_balance_sheet dues_vendor_tds);
 *   - commission earned but not yet paid is a P&L cost with no payable anywhere
 *     (src/lib/accounting/trial-balance.ts:136 → Trial Balance Difference).
 *
 * Case: partner commission ₹50,000 earned 15 Oct 2026, 194H TDS at the codebase's rate.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { build26QRows, read26Q } from "@/app/(app)/accounting/expenses/tds-26q";
import { fetchTdsMonths } from "@/lib/queries/compliance";
import { fetchStatutoryDues } from "@/lib/queries/payroll";
import { buildComplianceRows } from "@/lib/compliance/obligations";
import { noTdsDeductedPredicate, tdsMonthsFrom } from "@/lib/compliance/tds-not-applicable";
import { balanceSheetFromRpc, type BalanceSheetRpcRow } from "./report-rpc";
import { balanceSheetTotals } from "./balance-sheet-totals";
import { buildTrialBalance } from "./trial-balance";
import { TDS_194H_RATE_PCT } from "./commission-tds";
import type { PnLNumbers } from "./pnl-assemble";

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

const GROSS = 50_000;
const TDS = Math.round((GROSS * TDS_194H_RATE_PCT) / 100);   // 194H rate from the codebase (2% → ₹1,000)
const NET = GROSS - TDS;

const partner = { id: "p1", name: "Sharma Associates", pan: "ABCPS1234K", gstin: null };
type CommRow = {
  id: string; partner_id: string; gross_commission: number; tds_amount: number; net_payable: number;
  status: string; earned_date: string; paid_date: string | null;
};
const comm = (extra: Partial<CommRow> = {}): CommRow => ({
  id: "c1", partner_id: "p1", gross_commission: GROSS, tds_amount: TDS, net_payable: NET,
  status: "earned", earned_date: "2026-10-15", paid_date: null, ...extra,
});
const OCT = { from: "2026-10-01", to: "2026-10-31" };

describe("R-1580 — 26Q working has the commission's 194H row", () => {
  it("Oct commission with TDS → one 194H row: partner, PAN, amount paid, TDS", async () => {
    const client = fakeClient({
      expenses: [],
      vendors: [],
      referral_commissions: [
        comm(),
        comm({ id: "c2", status: "cancelled" }),                       // cancelled — no TDS
        comm({ id: "c3", tds_amount: 0, net_payable: GROSS }),         // no TDS deducted
        comm({ id: "c4", earned_date: "2026-11-02" }),                 // next month
      ],
      referral_partners: [partner],
    });
    const out = build26QRows(await read26Q(client, OCT));
    expect(out.rows).toEqual([["Sharma Associates", "ABCPS1234K", "194H", "2026-10-15", GROSS, TDS]]);
    expect(out.totalTds).toBe(TDS);
    expect(out.missingPan).toBe(0);
  });

  it("a partner with no PAN is flagged, never dropped", async () => {
    const client = fakeClient({
      expenses: [], vendors: [],
      referral_commissions: [comm()],
      referral_partners: [{ ...partner, pan: null }],
    });
    const out = build26QRows(await read26Q(client, OCT));
    expect(out.rows).toHaveLength(1);
    expect(out.missingPan).toBe(1);
  });
});

describe("R-1580 — 'Deposit TDS' for October is due 7 Nov when only commission TDS was deducted", () => {
  const NOV_3 = new Date("2026-11-03T12:00:00+05:30");

  it("the TDS months read counts the commission month", async () => {
    const client = fakeClient({ salary_payments: [], expenses: [], referral_commissions: [comm(), comm({ id: "c9", status: "cancelled", earned_date: "2026-09-10" })] });
    const months = await fetchTdsMonths(client, "2026-07-01");
    expect([...months]).toEqual(["2026-10"]);
  });

  it("the reminder (cron) helper counts it too", () => {
    expect(tdsMonthsFrom([], [], [comm()]).has("2026-10")).toBe(true);
    expect(tdsMonthsFrom([], [], [comm({ status: "cancelled" })]).has("2026-10")).toBe(false);
  });

  it("Compliance shows Oct deposit due 2026-11-07 — not 'nothing to deposit'", () => {
    const row = buildComplianceRows(NOV_3, new Map(), ["tds"], noTdsDeductedPredicate(tdsMonthsFrom([], [], [comm()]), NOV_3))
      .find((r) => r.ob.key === "tds_payment")!;
    expect(row.inst.periodKey).toBe("2026-10");
    expect(row.inst.dueDate).toBe("2026-11-07");
  });
});

describe("R-1580 — statutory dues carry commission TDS until a challan is recorded", () => {
  it("earned or paid, the ₹1,000 is owed; a TDS challan clears it; cancelled never counts", async () => {
    const before = await fetchStatutoryDues(fakeClient({
      salary_payments: [], statutory_dues_payments: [], expenses: [],
      referral_commissions: [comm(), comm({ id: "c2", status: "paid", paid_date: "2026-10-20" }), comm({ id: "c3", status: "cancelled" })],
    }));
    expect(before.tdsVendor).toBe(2 * TDS);
    expect(before.payable).toBe(2 * TDS);

    const after = await fetchStatutoryDues(fakeClient({
      salary_payments: [], expenses: [],
      statutory_dues_payments: [{ id: "s1", kind: "tds", amount: 2 * TDS }],
      referral_commissions: [comm(), comm({ id: "c2", status: "paid", paid_date: "2026-10-20" })],
    }));
    expect(after.payable).toBe(0);
  });
});

describe("R-1580 — Balance Sheet: commission payable + its TDS payable", () => {
  const row = (extra: Partial<BalanceSheetRpcRow>): BalanceSheetRpcRow => ({
    as_of: "2026-10-31", fy_start_year: 2026, fy_label: "FY 2026-27",
    cash_and_bank: 0, credit_card_payable: 0, receivables: 0, advances_from_customers: 0,
    project_receivable: 0, tds_receivable: 0, employee_loans: 0, prepaid_advances: 0,
    emi_unregistered_cost: 0, emi_loans_payable: 0, business_loans_payable: 0, payables: 0,
    salary_payable: 0, dues_salary_tds: 0, dues_pf: 0, dues_esi: 0, dues_vendor_tds: 0, dues_paid: [],
    reimbursements_payable: 0, gst_output: 0, bills_gst: 0, itc_groups: [], fixed_assets: [], tax_payments: [],
    ...extra,
  });

  it("earned-unpaid commission is a liability (net), its TDS a statutory due", () => {
    const bs = balanceSheetFromRpc(row({ dues_vendor_tds: TDS, commissions_payable: NET }));
    expect(bs.commissionsPayable).toBe(NET);
    expect(bs.salaryDuesPayable).toBe(TDS);
    expect(balanceSheetTotals(bs, []).totalLiab).toBe(GROSS);
    expect(balanceSheetTotals(bs, []).currentLiab).toBe(GROSS);
  });

  it("before the migration (no column) commission payable is 0 — never NaN", () => {
    expect(balanceSheetFromRpc(row({})).commissionsPayable).toBe(0);
  });

  it("Trial Balance: ₹50,000 commission expense is matched by ₹49,000 payable + ₹1,000 TDS — Difference does not move", () => {
    const pnl0 = { revenue: 0, cogs: 0, commissions: 0, expenses: 0, expensesByCategory: [], depreciation: 0 } as unknown as PnLNumbers;
    const pnl1 = { ...pnl0, commissions: GROSS } as PnLNumbers;
    const base = buildTrialBalance({ bs: balanceSheetFromRpc(row({})), pnl: pnl0, items: [] });
    const t = buildTrialBalance({ bs: balanceSheetFromRpc(row({ dues_vendor_tds: TDS, commissions_payable: NET })), pnl: pnl1, items: [] });
    expect(t.rows.find((r) => r.head === "Commission payable (partners)")).toMatchObject({ debit: 0, credit: NET });
    expect(t.difference).toBe(base.difference);
  });
});
