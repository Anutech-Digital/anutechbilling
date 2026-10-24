/**
 * R-062 — the money tiles on /invoices, as one pure function.
 *
 * ─── WHAT WAS CHECKED (1 Oct 2026, local data) ──────────────────────────────
 * The AI tester read "two invoices paid ₹5.9L each, but September GST shows one and
 * Collected MTD ₹5.9L" as a bug. It is not: INV-FBB9-2026-27-0001 is dated 7 Aug and was
 * settled 7 Aug; only -0003 (26 Sep) belongs to September, and -0002 is void. GST counts
 * by INVOICE date, this tile by PAID date. Both said ₹5.9L / 1 invoice for September.
 *
 * ─── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
 * · Outstanding summed every invoice whose status was not 'paid' — so a VOID invoice
 *   (and a draft) counted as money owed. INV-1111-2026-27-0001 (void, net_payable
 *   ₹5,40,000) made that tenant's Outstanding read ₹5.4L when nothing is owed.
 *   It also ignored `paid_amount`, so a half-paid project milestone read as fully owed.
 * · The month test used `new Date(paid_date).getMonth()` — the BROWSER's month of a UTC
 *   midnight, so on a machine west of UTC a payment on the 1st fell into last month.
 *   Now a string compare against the IST month, the same way every other screen does it.
 */
import { istMonth, istToday } from "@/lib/dates/ist";
import { invoiceIsOverdue, type OverdueInvoice } from "./overdue";
import { invoiceMoneyIn, invoicePaymentState } from "./payment-state";
import type { NoteTotals } from "./note-totals";

/** R-1709: credit / debit note totals per invoice id (useInvoiceNoteTotals). Absent = none. */
export type InvoiceNotes = ReadonlyMap<string, NoteTotals>;

/** The row plus its note totals, as payment-state.ts reads it. */
function withNotes<T extends KpiInvoice>(inv: T, notes?: InvoiceNotes) {
  const n = inv.id ? notes?.get(inv.id) : undefined;
  return { ...inv, credit_noted: n?.credit ?? (notes ? 0 : undefined), debit_noted: n?.debit ?? 0 };
}

export interface KpiInvoice extends OverdueInvoice {
  id?: string;
  net_payable?: number | null;
  paid_date?: string | null;
  /** invoices.adjusted_advances — advances adjusted at issue (money in, R-1709). */
  adjusted_advances?: unknown;
}

/** Statuses that are a real, issued claim on the customer. Void and draft are not. */
export const INVOICE_OWED_STATUSES = ["pending", "overdue"] as const;
const OWED = new Set<string>(INVOICE_OWED_STATUSES);

/** What the customer still owes on one invoice: net of advances adjusted at issue
 *  (`net_payable`) and of receipts against it since (`paid_amount`), never below 0. */
export function invoiceBalance(inv: KpiInvoice): number {
  if (!OWED.has(inv.status)) return 0;
  if (inv.written_off_at) return 0;   // R-1635: written off — not owed (amount-due.ts)
  return Math.max(0, (inv.net_payable ?? inv.amount) - (inv.paid_amount ?? 0));
}

/**
 * R-118: the exact set behind each money tile, so a click on the tile lists the same invoices
 * the tile added up. "" = no focus. The tiles below are computed WITH these predicates, so
 * the number and the list cannot drift apart.
 */
export const INVOICE_FOCI = ["", "unpaid", "paid-month"] as const;
export type InvoiceFocus = (typeof INVOICE_FOCI)[number];
export const INVOICE_FOCUS_LABEL: Record<Exclude<InvoiceFocus, "">, string> = {
  "unpaid": "Outstanding — still owed (pending, partial and overdue)",
  "paid-month": "Paid this month — fully paid in this IST month (credit-note settled ones are Credited, not paid)",
};

export function invoiceInFocus(inv: KpiInvoice, focus: InvoiceFocus, now: Date = new Date(), notes?: InvoiceNotes): boolean {
  if (focus === "") return true;
  if (focus === "unpaid") return invoiceBalance(inv) > 0;
  /* R-1709: paid by MONEY — an invoice a credit note closed is "credited", not paid. */
  return invoicePaymentState(withNotes(inv, notes)) === "paid" && !!inv.paid_date && inv.paid_date.slice(0, 7) === istMonth(now);
}

export interface InvoiceKpis {
  outstanding: number;
  overdueTotal: number;
  /** Invoices fully paid this IST month, by `paid_date` — the money that really came in on them
   *  (R-1709: receipts + advances, capped at the value after notes; was the full amount). */
  paidThisMonth: number;
  paidThisMonthCount: number;
  /** Invoices with something still owed — the Outstanding tile's count. */
  outstandingCount: number;
}

export function invoiceKpis(invoices: KpiInvoice[], now: Date = new Date(), notes?: InvoiceNotes): InvoiceKpis {
  const today = istToday(now);
  let outstanding = 0, overdueTotal = 0, paidThisMonth = 0, paidThisMonthCount = 0, outstandingCount = 0;
  for (const inv of invoices) {
    const bal = invoiceBalance(inv);
    outstanding += bal;
    if (invoiceInFocus(inv, "unpaid", now)) outstandingCount += 1;
    if (invoiceIsOverdue(inv, today)) overdueTotal += bal;
    if (invoiceInFocus(inv, "paid-month", now, notes)) {
      paidThisMonth += invoiceMoneyIn(withNotes(inv, notes));
      paidThisMonthCount += 1;
    }
  }
  return { outstanding, overdueTotal, paidThisMonth, paidThisMonthCount, outstandingCount };
}

/** The ids of the status chips on /invoices, in display order. Every invoice lands in
 *  exactly one, so the chip counts add up to All (R-063 — Void had no chip). */
export const INVOICE_CHIPS = ["paid", "credited", "partial", "pending", "overdue", "draft", "void"] as const;
export type InvoiceChip = (typeof INVOICE_CHIPS)[number];

/** Which chip an invoice belongs in: its bucket (R-060, overdue derived), with pending
 *  split into Partial (money in — advances OR receipts after the invoice) and Pending
 *  (nothing in yet), and paid split into Paid and Credited (a credit note closed it).
 *  R-1709: the same money state the row badge reads (payment-state.ts) — the chip counted
 *  advances only, so a row reading "Partial" sat under a "Partial 0" chip. */
export function invoiceChip(inv: KpiInvoice, today: string = istToday(), notes?: InvoiceNotes): string {
  const bucket = invoiceIsOverdue(inv, today) ? "overdue" : inv.status;
  const state = invoicePaymentState(withNotes(inv, notes));
  if (bucket === "paid") return state === "credited" ? "credited" : "paid";
  if (bucket !== "pending") return bucket;
  return state === "partial" ? "partial" : "pending";
}

export function invoiceChipCounts(invoices: KpiInvoice[], today: string = istToday(), notes?: InvoiceNotes): Record<string, number> {
  const map: Record<string, number> = { all: invoices.length };
  for (const c of INVOICE_CHIPS) map[c] = 0;
  for (const inv of invoices) {
    const c = invoiceChip(inv, today, notes);
    map[c] = (map[c] ?? 0) + 1;
  }
  return map;
}
