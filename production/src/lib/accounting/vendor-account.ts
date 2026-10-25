/**
 * R-1868 (24 Oct 2026, Pardeep — split from R-1866): a vendor's account in one place — what we
 * still owe (COGS bills + unpaid expense bills), the advance still with them, the net, and the
 * payments made.
 *
 * Before: the Vendors list and popup said "₹X due / all settled" from COGS bills only, so a
 * vendor with ₹70,800 of unpaid professional-fee bills (expenses, paid = false) showed
 * "all settled", and an advance paid to a vendor was not shown at all.
 *
 * The rules are the ones the bank "This payment is for:" step already uses (R-1866,
 * supabase/migrations/20261024160000_r1866_bank_debit_vendor.sql → bank_debit_vendor_open_items):
 * an expense is an open BILL only when it is unpaid, not matched to a bank line, not salary /
 * payroll / statutory / EMI / an advance booking — so the popup and the bank step never disagree.
 */
import { rupee } from "@/lib/utils";

/* ─── Open expense bills ───────────────────────────────────────────────────────────── */

/** payment_method values that mark an expense row as NOT a vendor's bill (R-1866 list). */
export const NOT_VENDOR_BILL_METHODS: readonly string[] = ["payroll", "statutory", "reimbursement", "emi", "advance", "employee_advance"];

export interface ExpenseBillLike {
  amount: number | null;
  paid: boolean | null;
  tds_amount: number | null;
  reconciled_txn_id: string | null;
  category: string | null;
  payment_method: string | null;
  prepaid_advance_id: string | null;
  /** R-1913: the part already settled from the vendor's advance (Apply advance). */
  advance_applied?: number | null;
  /** R-1915: cash already paid on the bill from bank lines (part payments). */
  paid_amount?: number | null;
}

/** R-1915: cash still owed — amount less TDS, the advance applied and the bank parts paid
 *  (migration 20261025174159: amount − tds_amount − advance_applied − paid_amount). */
const cashLeft = (e: ExpenseBillLike) =>
  (e.amount ?? 0) - (e.tds_amount ?? 0) - (e.advance_applied ?? 0) - (e.paid_amount ?? 0);

export function isOpenExpenseBill(e: ExpenseBillLike): boolean {
  return e.paid === false
    && !e.reconciled_txn_id
    && e.category !== "Salaries"
    && !NOT_VENDOR_BILL_METHODS.includes(e.payment_method ?? "")
    && !e.prepaid_advance_id
    && cashLeft(e) > 0;
}

/** Cash still owed on an expense bill: its amount less the TDS recorded on it, (R-1913) the
 *  vendor's advance already applied to it and (R-1915) the part already paid from the bank. */
export function expenseBillDue(e: ExpenseBillLike): number {
  return isOpenExpenseBill(e) ? Math.max(0, cashLeft(e)) : 0;
}

/** R-1915: an unpaid bill with part of it already paid from the bank — "Partly paid". */
export function isPartlyPaidExpense(e: Pick<ExpenseBillLike, "paid" | "paid_amount">): boolean {
  return e.paid === false && (e.paid_amount ?? 0) > 0;
}

/**
 * R-1915: what an unpaid bill still owes, gross — the "To pay" totals. Before any bank part:
 * the bill less the advance applied (its TDS is still to be withheld when it is paid). After a
 * part: the cash rest (the bill's whole TDS went with the first part). Same as the Banking
 * step's amount_due (bank_debit_vendor_open_items).
 */
export function expenseStillOwed(e: Pick<ExpenseBillLike, "amount" | "tds_amount" | "advance_applied" | "paid_amount">): number {
  const paid = e.paid_amount ?? 0;
  return Math.max(0, (e.amount ?? 0) - (e.advance_applied ?? 0) - paid - (paid > 0 ? e.tds_amount ?? 0 : 0));
}

/* ─── Advance ──────────────────────────────────────────────────────────────────────── */

export interface AdvanceLike { total_amount: number | null; consumed_amount: number | null; closed_at: string | null }

/** What is left of an advance (Prepaid): paid less already adjusted against bills. */
export function advanceLeft(a: AdvanceLike): number {
  if (a.closed_at) return 0;
  return Math.max(0, (a.total_amount ?? 0) - (a.consumed_amount ?? 0));
}

export interface VendorAdvanceLike extends AdvanceLike {
  vendor_id: string | null;
  vendor_name: string | null;
  category?: string | null;
}

/**
 * R-1913: what is left of a vendor's advances — the same match as apply_vendor_advance
 * (migration 20261025164002): by vendor id, or by name for an advance with no vendor yet (or a
 * bill with no vendor record). Staff advances share the table and never count.
 */
export function vendorAdvanceLeft(advances: readonly VendorAdvanceLike[], vendorId: string | null, vendorName: string | null): number {
  const name = (vendorName ?? "").trim().toUpperCase();
  return advances.reduce((s, a) => {
    if (a.category === "Employee advance") return s;
    const byId = vendorId != null && a.vendor_id === vendorId;
    const byName = (a.vendor_id == null || vendorId == null) && name !== "" && (a.vendor_name ?? "").trim().toUpperCase() === name;
    return byId || byName ? s + advanceLeft(a) : s;
  }, 0);
}

/** R-1913: what "Apply advance" sets off on a bill — the advance left, at most the bill's due. */
export function advanceToApply(advanceLeftAmount: number, billDue: number): number {
  return Math.max(0, Math.min(Math.round(advanceLeftAmount || 0), Math.round(billDue || 0)));
}

export interface BillAdvanceView {
  /** Already settled from the advance. */
  applied: number;
  /** R-1915: cash already paid from the bank on a bill still to pay (part payments). */
  paidPart: number;
  /** Cash still owed on the bill (after TDS and the advance). */
  due: number;
  /** "Apply advance ₹X" — 0 hides the button. */
  canApply: number;
  /** "Undo advance" — only while no bank line / Mark-paid settled the rest. */
  canUndo: boolean;
}

/** R-1913: what an expense bill row shows about the vendor's advance. */
export function billAdvanceView(
  e: ExpenseBillLike & { vendor_id: string | null; vendor_name: string | null },
  advances: readonly VendorAdvanceLike[],
): BillAdvanceView {
  const applied = Math.max(0, e.advance_applied ?? 0);
  const paidPart = isPartlyPaidExpense(e) ? Math.max(0, e.paid_amount ?? 0) : 0;
  const open = isOpenExpenseBill(e);
  const due = expenseBillDue(e);
  const canApply = open && due > 0 ? advanceToApply(vendorAdvanceLeft(advances, e.vendor_id, e.vendor_name), due) : 0;
  /* R-1915: not while a bank part is on the bill (undo_vendor_advance refuses — un-reconcile first). */
  const canUndo = applied > 0 && !e.reconciled_txn_id && !((e.paid_amount ?? 0) > 0) && (e.paid === false || e.payment_method === "advance");
  return { applied, paidPart, due, canApply, canUndo };
}

/* ─── Balance ──────────────────────────────────────────────────────────────────────── */

export interface VendorBalance {
  /** Open bills: COGS bills still due + unpaid expense bills (less TDS on them). */
  bills: number;
  /** Advance paid to the vendor, not yet adjusted. */
  advance: number;
  /** bills − advance: > 0 we owe, < 0 the vendor holds our money. */
  net: number;
  state: "owe" | "advance" | "settled";
}

export function vendorBalance(billsDue: number, advance: number): VendorBalance {
  const bills = Math.max(0, Math.round(billsDue || 0));
  const adv = Math.max(0, Math.round(advance || 0));
  const net = bills - adv;
  return { bills, advance: adv, net, state: net > 0 ? "owe" : net < 0 ? "advance" : "settled" };
}

export function balanceWords(b: VendorBalance): { headline: string; detail: string | null; tone: "rose" | "emerald" | "ink" } {
  const both = b.bills > 0 && b.advance > 0 ? `Open bills ${rupee(b.bills)} − advance ${rupee(b.advance)}` : null;
  if (b.state === "owe") return { headline: `You owe ${rupee(b.net)}`, detail: both, tone: "rose" };
  if (b.state === "advance") return { headline: `Advance with vendor ${rupee(-b.net)}`, detail: both, tone: "emerald" };
  return { headline: "All settled", detail: both, tone: "ink" };
}

/* ─── Payments made ────────────────────────────────────────────────────────────────── */

export interface VendorBankLine {
  id: string; txn_date: string; debit: number; reference: string | null;
  matched_to_type: string | null; matched_to_id: string | null; bank_account_id: string;
}
/** bank_vendor_payment_lines rows (R-1866): what one bank line paid. */
export interface VendorPayLine {
  bank_txn_id: string; kind: string; cash: number; tds_amount: number;
  expense_id: string | null; vendor_bill_id: string | null;
}
/** Expense bills marked paid without a bank line (cash, card, paid at entry). */
export interface PaidOutsideBank {
  id: string; bill_no: string | null; paid_date: string | null; amount: number; tds_amount: number | null; payment_method: string | null;
}

export interface VendorPaymentRow {
  key: string;
  date: string;
  /** Money that left us. */
  cash: number;
  /** TDS withheld on it (paid to the government for the vendor). */
  tds: number;
  /** Bank account, or how it was paid. */
  via: string;
  /** What it paid: "Bills KL-201, KL-202", "Advance", … */
  what: string;
  href: string;
}

const billsWord = (nos: string[]) => (nos.length === 0 ? "Vendor payment" : `${nos.length === 1 ? "Bill" : "Bills"} ${nos.join(", ")}`);

export function vendorPaymentRows(i: {
  bankLines: readonly VendorBankLine[];
  paymentLines: readonly VendorPayLine[];
  /** expense / bill id → its bill number. */
  docNo: ReadonlyMap<string, string | null>;
  paidOutsideBank: readonly PaidOutsideBank[];
  /** Advances (Prepaid) paid without a bank line — cash, card. */
  advancesOutsideBank?: readonly { id: string; paid_date: string | null; total_amount: number | null; payment_method: string | null }[];
  accounts: ReadonlyMap<string, string>;
}): VendorPaymentRow[] {
  const linesOf = new Map<string, VendorPayLine[]>();
  for (const l of i.paymentLines) linesOf.set(l.bank_txn_id, [...(linesOf.get(l.bank_txn_id) ?? []), l]);
  const no = (id: string | null) => (id ? i.docNo.get(id) || id : null);

  const rows: VendorPaymentRow[] = i.bankLines.map((t) => {
    let tds = 0, what = "Vendor payment";
    if (t.matched_to_type === "vendor_payment") {
      const ls = linesOf.get(t.id) ?? [];
      tds = ls.reduce((s, l) => s + (l.tds_amount || 0), 0);
      const nos = ls.filter((l) => l.kind !== "advance" && l.kind !== "bank_charge").map((l) => no(l.vendor_bill_id ?? l.expense_id)).filter((x): x is string => !!x);
      const parts = [
        nos.length ? billsWord(nos) : null,
        ls.some((l) => l.kind === "advance") ? "advance" : null,
        ls.some((l) => l.kind === "bank_charge") ? "bank charge" : null,
      ].filter((x): x is string => !!x);
      what = parts.length ? parts[0][0].toUpperCase() + parts.join(" + ").slice(1) : "Vendor payment";
    } else if (t.matched_to_type === "vendor_bill" || t.matched_to_type === "expense") {
      what = billsWord([no(t.matched_to_id) ?? ""].filter(Boolean));
    } else if (t.matched_to_type === "prepaid") {
      what = "Advance";
    }
    return {
      key: `bank:${t.id}`, date: t.txn_date, cash: t.debit, tds, via: i.accounts.get(t.bank_account_id) ?? "Bank",
      what, href: `/accounting/banking/${encodeURIComponent(t.bank_account_id)}?focus=${encodeURIComponent(t.id)}`,
    };
  });
  for (const e of i.paidOutsideBank) {
    if (!e.paid_date) continue;
    rows.push({
      key: `exp:${e.id}`, date: e.paid_date, cash: Math.max(0, e.amount - (e.tds_amount ?? 0)), tds: e.tds_amount ?? 0,
      via: e.payment_method || "Paid", what: billsWord([e.bill_no || e.id]), href: `/accounting/expenses?edit=${encodeURIComponent(e.id)}`,
    });
  }
  for (const a of i.advancesOutsideBank ?? []) {
    if (!a.paid_date || !(a.total_amount && a.total_amount > 0)) continue;
    rows.push({ key: `adv:${a.id}`, date: a.paid_date, cash: a.total_amount, tds: 0, via: a.payment_method || "Paid", what: "Advance", href: "/accounting/prepaid" });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}
