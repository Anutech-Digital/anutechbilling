/**
 * R-1579 — ITR pack ka "profit as per books" === P&L net profit, ek hi FY par.
 *
 * Bug (reproduced pehle, isi fixture par): ITR ₹4,59,000, P&L ₹5,13,064. ITR ne
 *   · COGS purchase orders (₹4,00,000) se liya — P&L vendor bills (₹3,00,000 + ₹18,000 blocked GST);
 *   · kharchon se SAARA gst_paid (₹21,060) ghataya — P&L sirf claimable (₹18,360);
 *   · commissions (₹25,000) aur settlement bank charge (₹236) chhod diye.
 * Aur invoices / expenses bina paging padhe — 1000 row par chup-chaap kat-te.
 *
 * Fixture FY 2026-27: 3 invoices ₹10,00,000; 2 placed PO ₹4,00,000; 2 COGS bills (ek tax
 * invoice ₹36,000 GST claimable, ek proforma ₹18,000 GST blocked); Hosting (GST claimable),
 * Travel (kaccha — blocked), Staff Welfare (s.17(5) — blocked), Bank Charges (claimable) +
 * settlement shortfall ₹236; commissions ₹25,000; laptop asset (₹24,000 depreciation).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { assemblePnl, type PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import type { AssetLike } from "@/lib/accounting/depreciation";
import { computeItrPack, financialYear } from "./itr";
import { itrBooksFromPnl } from "./itr-from-pnl";

const GSTIN = "07AABCU9603R1ZX";
const fy = financialYear(2026);
const laptop: AssetLike = { id: "fa1", name: "Laptop", block: "computers", cost: 120_000, put_to_use: "2026-10-05" };
const rawExpenses = [
  { category: "Hosting", amount: 118_000, gst_paid: 18_000, bill_type: "gst", gstin: GSTIN },
  { category: "Travel", amount: 11_800, gst_paid: 1_800, bill_type: "kaccha", gstin: null },
  { category: "Staff Welfare", amount: 5_900, gst_paid: 900, bill_type: "gst", gstin: GSTIN },
  { category: "Bank Charges", amount: 2_360, gst_paid: 360, bill_type: "gst", gstin: GSTIN },
];
const ROW: PnlRpcRow = {
  inv_taxable: 1_000_000, inv_tax: 180_000, revenue_count: 3,
  cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0, revenue_by_project: [],
  cogs: 300_000, cogs_count: 2, bills_gst: 54_000,
  bill_itc_groups: [
    { document_type: "tax_invoice", category: "COGS-Licence", vendorGstin: GSTIN, cgst: 18_000, sgst: 18_000, igst: 0, n: 1, ownStateCode: "07" },
    { document_type: "proforma", category: "COGS-Licence", vendorGstin: GSTIN, cgst: 0, sgst: 0, igst: 18_000, n: 1, ownStateCode: "07" },
  ],
  expense_groups: [
    ...rawExpenses.map((e) => ({ category: e.category, vendor_name: "V", month: "2026-06", amount: e.amount, n: 1 })),
    // report_pnl ki S45-SLICE2 line: settlement receipt se kam aaya → Bank Charges
    { category: "Bank Charges", vendor_name: "Settlement short of receipt", month: "2026-07", amount: 236, n: 1 },
  ],
  itc_groups: rawExpenses.map((e) => ({ bill_type: e.bill_type, category: e.category, vendorGstin: e.gstin, gst_paid: e.gst_paid, n: 1 })),
  unassigned_by_category: [], project_expenses: [],
  commissions: 25_000, commissions_count: 2,
};
const MASTERS = { vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };

const EXTRA = {
  creditNoteCount: 0, debitNoteCount: 0, placedPoCost: 400_000, placedPoCount: 2,
  tdsCredit: 0, tdsCount: 0, advanceTaxPaid: 0, assetCount: 1,
};

/* R-1808: depreciation stops at today (IST). These cases read a whole FY (2026-27) as a year
   already over, so the clock is pinned after it (at load: some cases compute while the
   describe is collected) — only Date is faked. */
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2028-04-10T06:00:00Z"));
afterAll(() => { vi.useRealTimers(); });

describe("R-1579 — ITR book profit = P&L net profit (same FY)", () => {
  const pnl = assemblePnl({ from: fy.start, to: fy.end }, ROW, { ...MASTERS, assets: [laptop] });
  const pack = computeItrPack(fy, { ...itrBooksFromPnl(pnl, ROW), ...EXTRA });

  it("P&L ka net profit haath se: 10,00,000 − 3,18,000 − 1,19,936 − 25,000 − 24,000", () => {
    expect(pnl.netProfit).toBe(513_064);
    // bills hain → P&L page ka `model` bhi wahi (andaza nahi)
    expect(pnl.model.netProfit).toBe(513_064);
  });

  it("ITR ka book profit rupaye tak wahi — aur koi 'P&L se alag' gap nahi", () => {
    expect(pack.bookProfit).toBe(pnl.netProfit);
    expect(pack.gaps.some((g) => g.includes("differs from the P&L net profit"))).toBe(false);
  });

  it("COGS vendor bills se (blocked GST samet), PO se nahi", () => {
    const cogs = pack.pnl.find((l) => l.label.startsWith("Licence purchases"))!;
    expect(cogs.amount).toBe(318_000);
    expect(cogs.count).toBe(2);
    expect(pack.gaps.some((g) => g.includes("placed purchase order"))).toBe(false);
  });

  it("sirf claimable ITC ghatta hai — blocked GST kharcha rehta hai", () => {
    const line = (c: string) => pack.pnl.find((l) => l.label === c)!.amount;
    expect(line("Hosting")).toBe(100_000);
    expect(line("Travel")).toBe(11_800);          // kaccha bill — GST kharcha
    expect(line("Staff Welfare")).toBe(5_900);    // s.17(5) — GST kharcha
    expect(line("Bank Charges")).toBe(2_000 + 236); // settlement shortfall bhi
  });

  it("commissions aur depreciation lines hain", () => {
    expect(pack.pnl.find((l) => l.label.startsWith("Referral"))).toMatchObject({ amount: 25_000, count: 2 });
    expect(pack.pnl.find((l) => l.label.startsWith("Depreciation"))).toMatchObject({ amount: 24_000 });
  });

  it("parity har FY par — revenue sirf, ya ghata", () => {
    for (const r of [
      { ...ROW, cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [] },
      { ...ROW, inv_taxable: 100_000, cn_taxable: 5_000, dn_taxable: 1_000 },
    ]) {
      const p = assemblePnl({ from: fy.start, to: fy.end }, r, { ...MASTERS, assets: [laptop] });
      expect(computeItrPack(fy, { ...itrBooksFromPnl(p, r), ...EXTRA }).bookProfit).toBe(p.netProfit);
    }
  });

  it("PO hain par bill nahi → note (gap), aur kharid ₹0 — andaza nahi", () => {
    const r = { ...ROW, cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [] };
    const p = assemblePnl({ from: fy.start, to: fy.end }, r, { ...MASTERS, assets: [laptop] });
    const pk = computeItrPack(fy, { ...itrBooksFromPnl(p, r), ...EXTRA });
    expect(pk.pnl.find((l) => l.label.startsWith("Licence purchases"))!.amount).toBe(0);
    expect(pk.gaps.some((g) => g.includes("2 placed purchase orders (₹4,00,000)"))).toBe(true);
  });

  it("book profit P&L se alag ho to gap chup nahi rehta", () => {
    const pk = computeItrPack(fy, { ...itrBooksFromPnl(pnl, ROW), ...EXTRA, pnlNetProfit: 1 });
    expect(pk.gaps.some((g) => g.includes("differs from the P&L net profit"))).toBe(true);
  });
});

/* ─── Reads: report_pnl (SQL jod) + baaki sab paged — 1000 par nahi rukte ─── */

type Rows = Record<string, unknown[]>;
const state: { rows: Rows; rpcArgs: unknown[]; ranges: string[] } = { rows: {}, rpcArgs: [], ranges: [] };

vi.mock("@tanstack/react-query", () => ({ useQuery: (o: unknown) => o }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: (fn: string, args: unknown) => { state.rpcArgs.push([fn, args]); return Promise.resolve({ data: [ROW], error: null }); },
    from: (table: string) => {
      let head = false;
      const q = {
        select: (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return q; },
        gte: () => q, lte: () => q, lt: () => q, in: () => q, eq: () => q, filter: () => q, order: () => q,
        // PostgREST max_rows = 1000: ek page me 1000 se zyada kabhi nahi
        range: (a: number, b: number) => {
          state.ranges.push(`${table}:${a}-${b}`);
          const all = state.rows[table] ?? [];
          return Promise.resolve({ data: all.slice(a, Math.min(b + 1, a + 1000)), error: null });
        },
        then: (res: (v: unknown) => unknown) => res(head
          ? { data: null, count: (state.rows[table] ?? []).length, error: null }
          : { data: (state.rows[table] ?? []).slice(0, 1000), error: null }),
      };
      return q;
    },
  }),
}));

describe("R-1579 — useItrPack: report_pnl FY range, saare reads paged", () => {
  beforeEach(() => {
    state.rpcArgs = []; state.ranges = [];
    state.rows = {
      purchase_orders: Array.from({ length: 1_200 }, (_, i) => ({ id: `po${i}`, total_cost: 100 })),
      tds_receivable: Array.from({ length: 1_500 }, (_, i) => ({ id: `t${i}`, tds_amount: 10 })),
      tax_payments: [], fixed_assets: [laptop],
      credit_notes: [{}, {}], debit_notes: [{}],
    };
  });

  it("book profit = P&L, aur 1000+ rows poori padhi jaati hain", async () => {
    const { useItrPack } = await import("@/lib/queries/itr");
    const opts = useItrPack(2026) as unknown as { queryFn: () => Promise<ReturnType<typeof computeItrPack>> };
    const pack = await opts.queryFn();

    expect(state.rpcArgs).toEqual([["report_pnl", { p_from: "2026-04-01", p_to: "2027-03-31" }]]);
    expect(pack.bookProfit).toBe(513_064);
    expect(pack.sources.tdsCount).toBe(1_500);
    expect(pack.sources.tdsCredit).toBe(15_000);
    expect(pack.sources.placedPoCount).toBe(1_200);
    expect(pack.sources.creditNoteCount).toBe(2);
    expect(pack.sources.debitNoteCount).toBe(1);
    expect(state.ranges).toContain("tds_receivable:1000-1999");
    expect(state.ranges).toContain("purchase_orders:1000-1999");
  });

  it("invoices > 1000: revenue aur ginti SQL (report_pnl) se — koi browser-side cap nahi", async () => {
    const { useItrPack } = await import("@/lib/queries/itr");
    const big = { ...ROW, inv_taxable: 12_345_000, revenue_count: 2_469 };
    const orig = ROW.inv_taxable;
    Object.assign(ROW, { inv_taxable: big.inv_taxable, revenue_count: big.revenue_count });
    try {
      const opts = useItrPack(2026) as unknown as { queryFn: () => Promise<ReturnType<typeof computeItrPack>> };
      const pack = await opts.queryFn();
      expect(pack.sources.invoiceCount).toBe(2_469);
      expect(pack.sources.revenueExGst).toBe(12_345_000);
      expect(state.ranges.some((r) => r.startsWith("invoices") || r.startsWith("expenses"))).toBe(false);
    } finally {
      Object.assign(ROW, { inv_taxable: orig, revenue_count: 3 });
    }
  });
});
