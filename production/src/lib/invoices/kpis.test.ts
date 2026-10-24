import { describe, it, expect } from "vitest";
import { INVOICE_CHIPS, invoiceBalance, invoiceChip, invoiceChipCounts, invoiceInFocus, invoiceKpis, type KpiInvoice } from "./kpis";

/* The rows as they sit in the local DB on 1 Oct 2026 (R-062). */
const FBB9: KpiInvoice[] = [
  { id: "INV-FBB9-2026-27-0001", status: "paid", amount: 590000, net_payable: 0, paid_amount: 0,      paid_date: "2026-08-07", due_date: null },
  { id: "INV-FBB9-2026-27-0002", status: "void", amount: 2360000, net_payable: 0, paid_amount: 0,     paid_date: null,         due_date: null },
  { id: "INV-FBB9-2026-27-0003", status: "paid", amount: 590000, net_payable: 0, paid_amount: 590000, paid_date: "2026-09-26", due_date: null },
];
const T1111_VOID: KpiInvoice = { id: "INV-1111-2026-27-0001", status: "void", amount: 540000, net_payable: 540000, paid_amount: 0, paid_date: null, due_date: "2026-08-20" };

const sept = new Date("2026-09-30T12:00:00+05:30");
const oct1 = new Date("2026-10-01T09:00:00+05:30");

describe("invoice KPIs (R-062)", () => {
  it("September: one invoice paid, ₹5.9L — -0001 was paid in August, -0002 is void", () => {
    const k = invoiceKpis(FBB9, sept);
    expect(k.paidThisMonth).toBe(590000);
    expect(k.paidThisMonthCount).toBe(1);
    expect(k.outstanding).toBe(0);
    expect(invoiceKpis(FBB9, oct1).paidThisMonth).toBe(0);   // new month, nothing paid yet
  });

  it("a void invoice is not money owed (was ₹5.4L of Outstanding + Overdue)", () => {
    const k = invoiceKpis([T1111_VOID], oct1);
    expect(k.outstanding).toBe(0);
    expect(k.overdueTotal).toBe(0);
    expect(invoiceBalance({ status: "draft", amount: 1000, due_date: null })).toBe(0);
  });

  it("outstanding is net of advances and of receipts against the invoice", () => {
    expect(invoiceBalance({ status: "pending", amount: 590000, net_payable: 590000, paid_amount: 200000, due_date: null })).toBe(390000);
    expect(invoiceBalance({ status: "pending", amount: 118000, net_payable: 18000, due_date: null })).toBe(18000);
    expect(invoiceBalance({ status: "pending", amount: 1000, paid_amount: 5000, due_date: null })).toBe(0);
    const k = invoiceKpis([{ status: "pending", amount: 100000, paid_amount: 40000, due_date: "2026-09-01" }], oct1);
    expect(k.outstanding).toBe(60000);
    expect(k.overdueTotal).toBe(60000);
  });

  it("the month is the IST month, by string — a paid_date of the 1st is this month in any browser", () => {
    const k = invoiceKpis([{ status: "paid", amount: 100, paid_date: "2026-10-01", due_date: null }], new Date("2026-09-30T19:00:00Z")); // 1 Oct 00:30 IST
    expect(k.paidThisMonth).toBe(100);
  });
});

describe("invoice status chips (R-063)", () => {
  it("every invoice is in exactly one chip, so the chips add up to All — Void included", () => {
    const rows = [
      ...FBB9, T1111_VOID,
      { status: "draft", amount: 1, due_date: null },
      { status: "pending", amount: 1, due_date: null },
      { status: "pending", amount: 1, due_date: null, adjusted_advances: [{ amount: 1 }] },
      { status: "pending", amount: 1, due_date: "2026-09-01" },
    ];
    const c = invoiceChipCounts(rows, "2026-10-01");
    expect(c.void).toBe(2);
    expect(INVOICE_CHIPS.reduce((s, k) => s + c[k], 0)).toBe(c.all);
    expect(c).toEqual({ all: 8, paid: 2, credited: 0, partial: 1, pending: 1, overdue: 1, draft: 1, void: 2 });
  });
});

/* R-1709 — the tile, the chip and the row read ONE money-based state (payment-state.ts). */
describe("R-1709: Paid this month, Credited and Partial from money", () => {
  const oct = new Date("2026-10-21T12:00:00+05:30");
  /* T-L5: settled by a credit note — ₹38,232 never came in. */
  const TL5: KpiInvoice = { id: "T-L5", status: "paid", amount: 38232, net_payable: 0, paid_amount: 0, paid_date: "2026-10-20", due_date: null };
  const PAID: KpiInvoice = { id: "P", status: "paid", amount: 50000, net_payable: 30000, paid_amount: 30000, adjusted_advances: [{ amount: 20000 }], paid_date: "2026-10-10", due_date: null };
  /* INV-0007: a receipt after the invoice, balance still due. */
  const INV7: KpiInvoice = { id: "INV-0007", status: "pending", amount: 38232, net_payable: 38232, paid_amount: 20000, due_date: "2026-11-30" };
  const notes = new Map([["T-L5", { credit: 38232, debit: 0 }]]);

  it.each([
    ["credit-note settled invoice is not money collected", [TL5, PAID], 50000, 1],
    ["only the money that came in", [PAID], 50000, 1],
    ["receipts capped at the value after notes", [{ ...PAID, id: "Q", paid_amount: 40000 }], 50000, 1],
  ] as const)("%s", (_l, rows, sum, count) => {
    const k = invoiceKpis([...rows], oct, notes);
    expect(k.paidThisMonth).toBe(sum);
    expect(k.paidThisMonthCount).toBe(count);
  });

  it("the credited invoice gets its own chip and badge; the chips still add up to All", () => {
    const c = invoiceChipCounts([TL5, PAID, INV7], "2026-10-21", notes);
    expect(c).toMatchObject({ all: 3, paid: 1, credited: 1, partial: 1, pending: 0 });
    expect(INVOICE_CHIPS.reduce((s, k) => s + c[k], 0)).toBe(c.all);
    expect(invoiceInFocus(TL5, "paid-month", oct, notes)).toBe(false);
  });

  it("Partial counts receipts after the invoice too (INV-0007 was 'Partial' on the row, 0 on the chip)", () => {
    expect(invoiceChip(INV7, "2026-10-21")).toBe("partial");
  });
});
