/**
 * Indian law checks for an entry before it is saved (2 Oct 2026).
 *
 * Pardeep: "ai data entry agent ko india ke accounts, business law aur india ke law ki
 * acchi samajh honi chahiye — agar entry law ke hisaab se nahi ho rahi to warning deni
 * chahiye".
 *
 * These are RULES IN CODE, each with its section, not the model's opinion: a language
 * model asked about tax law is fluent and sometimes wrong, and a confident wrong warning
 * (or a missing right one) on a money entry is worse than none. Every rule here is tested.
 * The model may add its own notes; the UI shows those separately as "AI note — check with
 * your CA".
 *
 * Severity:
 *  - "stop": the entry as written breaks a provision with a penalty or a disallowance
 *            (cash ≥ ₹2 lakh received, GST heads that cannot both apply). Saving needs an
 *            explicit "I understand" from the operator.
 *  - "check": something to act on (deduct TDS, claim ITC in time, fix a total).
 *
 * Thresholds are those in force for FY 2025-26 onwards (Finance Act 2025). They are kept in
 * one table so a future Budget is a one-line change — and the table says when it was set.
 */
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { fyStartYear } from "@/lib/dates/ist";

export type Severity = "stop" | "check";
export interface LawWarning { code: string; severity: Severity; law: string; message: string }

export const LAW = {
  /** Income-tax Act s.40A(3): a cash payment above this to one person in a day is disallowed. */
  CASH_EXPENSE_LIMIT: 10_000,
  /** Income-tax Act s.269ST: receiving this much or more in cash, from one person / one transaction / a day, is barred (penalty = amount, s.271DA). */
  CASH_RECEIPT_LIMIT: 2_00_000,
  /** TDS thresholds, FY 2025-26 onwards (Finance Act 2025). */
  TDS_194C_SINGLE: 30_000,
  TDS_194C_YEAR: 1_00_000,
  TDS_194J_YEAR: 50_000,
  TDS_194H_YEAR: 20_000,
  TDS_194I_MONTH: 50_000,
  /** Rounding slack when checking subtotal + tax = total. */
  TOTAL_SLACK: 2,
  SET_ON: "2026-10-02",
} as const;

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export interface Party { stateCode: string | null; gstin: string | null }

/* ── Expense ─────────────────────────────────────────────────────────────── */
export interface ExpenseCheck {
  amount: number | null; category: string; paid_by?: string | null; vendor_name?: string | null; expense_date?: string | null;
  /** Already paid to this vendor this financial year (from the books). TDS thresholds are yearly. */
  ytd?: number | null;
}

export function checkExpense(e: ExpenseCheck, todayIST: string): LawWarning[] {
  const w: LawWarning[] = [];
  const amt = e.amount ?? 0;
  const year = amt + Math.max(0, e.ytd ?? 0);
  const ytdNote = (e.ytd ?? 0) > 0 ? ` (${inr(e.ytd ?? 0)} already paid to them this year + this ${inr(amt)})` : "";
  if (e.paid_by === "cash" && amt > LAW.CASH_EXPENSE_LIMIT) {
    w.push({ code: "cash-40A3", severity: "stop", law: "Income-tax Act s.40A(3)",
      message: `Cash payment above ${inr(LAW.CASH_EXPENSE_LIMIT)} to one person in a day is not allowed as a business expense. Pay by bank/UPI, or split only if they are genuinely separate days and bills.` });
  }
  const cat = e.category.toLowerCase();
  if (cat.startsWith("professional") && year > LAW.TDS_194J_YEAR) {
    w.push({ code: "tds-194J", severity: "check", law: "Income-tax Act s.194J",
      message: `Professional / technical fees above ${inr(LAW.TDS_194J_YEAR)} in a year${ytdNote} need TDS (usually 10%; 2% for technical services). Deduct before paying and deposit by the 7th of next month.` });
  }
  if (cat.startsWith("commission") && year > LAW.TDS_194H_YEAR) {
    w.push({ code: "tds-194H", severity: "check", law: "Income-tax Act s.194H",
      message: `Commission above ${inr(LAW.TDS_194H_YEAR)} in a year${ytdNote} needs TDS at 2%.` });
  }
  if (cat.includes("rent") && amt > LAW.TDS_194I_MONTH) {
    w.push({ code: "tds-194I", severity: "check", law: "Income-tax Act s.194-I",
      message: `Rent above ${inr(LAW.TDS_194I_MONTH)} a month needs TDS (10% for building, 2% for plant/machinery).` });
  }
  if ((cat.startsWith("repairs") || cat.startsWith("advertising") || cat.startsWith("marketing")) && (amt > LAW.TDS_194C_SINGLE || year > LAW.TDS_194C_YEAR)) {
    w.push({ code: "tds-194C", severity: "check", law: "Income-tax Act s.194C",
      message: `A contract payment above ${inr(LAW.TDS_194C_SINGLE)} at once (or ${inr(LAW.TDS_194C_YEAR)} in the year to one contractor${ytdNote}) needs TDS — 1% to an individual/HUF, 2% to others.` });
  }
  if (e.expense_date && e.expense_date > todayIST) {
    w.push({ code: "future-date", severity: "check", law: "Books of account",
      message: "The expense date is in the future — an expense is booked on the day it was incurred." });
  }
  return w;
}

/* ── Vendor bill (GST input) ─────────────────────────────────────────────── */
export interface BillCheck {
  vendor_gstin: string | null; buyer_gstin?: string | null; bill_no: string | null; bill_date: string | null;
  subtotal: number | null; cgst: number | null; sgst: number | null; igst: number | null; total: number | null;
  paid_by?: string | null;
}

/** Last day to claim ITC on a bill — 30 Nov after the end of its financial year (CGST Act s.16(4)). */
export function itcDeadline(billDate: string): string {
  return `${fyStartYear(billDate) + 1}-11-30`;
}

export function checkVendorBill(b: BillCheck, us: Party, todayIST: string): LawWarning[] {
  const w: LawWarning[] = [];
  const cgst = b.cgst ?? 0, sgst = b.sgst ?? 0, igst = b.igst ?? 0;
  const tax = cgst + sgst + igst;

  if (igst > 0 && (cgst > 0 || sgst > 0)) {
    w.push({ code: "gst-both-heads", severity: "stop", law: "IGST Act s.7–8 / CGST Act s.9",
      message: "A bill cannot charge IGST and CGST/SGST together — a supply is either inter-state (IGST) or intra-state (CGST+SGST). Ask the vendor for a corrected invoice." });
  }
  if (Math.abs(cgst - sgst) > 1) {
    w.push({ code: "gst-cgst-sgst", severity: "check", law: "CGST Act s.9 / SGST Act",
      message: `CGST (${inr(cgst)}) and SGST (${inr(sgst)}) should be equal halves of the GST.` });
  }
  if (tax > 0 && !b.vendor_gstin) {
    w.push({ code: "gst-no-gstin", severity: "check", law: "CGST Act s.16(2)(a), Rule 46",
      message: "GST is charged but the vendor's GSTIN is missing — ITC cannot be claimed without a tax invoice showing it. Get the GSTIN or book this without ITC." });
  }
  const vState = stateCodeFromGstin(b.vendor_gstin);
  const ourState = us.stateCode || stateCodeFromGstin(us.gstin);
  if (vState && ourState && tax > 0) {
    if (vState === ourState && igst > 0 && cgst === 0) {
      w.push({ code: "gst-head-intra", severity: "check", law: "IGST Act s.8",
        message: "Vendor is in your state, so this should be CGST + SGST, not IGST. IGST charged wrongly cannot be adjusted against your CGST/SGST — ask for a corrected invoice." });
    }
    if (vState !== ourState && cgst + sgst > 0 && igst === 0) {
      w.push({ code: "gst-head-inter", severity: "check", law: "IGST Act s.7",
        message: "Vendor is in another state, so this should be IGST, not CGST + SGST — unless the place of supply is your state (e.g. a hotel/event here)." });
    }
  }
  if (b.buyer_gstin && us.gstin && b.buyer_gstin.toUpperCase() !== us.gstin.toUpperCase()) {
    w.push({ code: "gst-not-our-gstin", severity: "check", law: "CGST Act s.16(2)(aa)",
      message: `The bill is made out to GSTIN ${b.buyer_gstin}, not yours (${us.gstin}). ITC goes only to the GSTIN on the invoice — and only once the vendor files it in GSTR-1 (shows in your 2B).` });
  }
  if (!b.bill_no && tax > 0) {
    w.push({ code: "gst-no-bill-no", severity: "check", law: "CGST Rules, Rule 46",
      message: "A tax invoice must carry a serial number — add the bill number, it is how the vendor's GSTR-1 is matched to your ITC." });
  }
  if (b.subtotal && b.total && Math.abs(b.subtotal + tax - b.total) > LAW.TOTAL_SLACK) {
    w.push({ code: "bill-total", severity: "check", law: "Books of account",
      message: `Subtotal ${inr(b.subtotal)} + GST ${inr(tax)} = ${inr(b.subtotal + tax)}, but the total says ${inr(b.total)}. Check the figures.` });
  }
  if (b.bill_date && tax > 0) {
    const last = itcDeadline(b.bill_date);
    if (todayIST > last) {
      w.push({ code: "itc-time-barred", severity: "check", law: "CGST Act s.16(4)",
        message: `ITC on this bill had to be claimed by ${last}. It can still be booked as an expense, but the GST is no longer claimable.` });
    }
  }
  if (b.paid_by === "cash" && (b.total ?? 0) > LAW.CASH_EXPENSE_LIMIT) {
    w.push({ code: "cash-40A3", severity: "stop", law: "Income-tax Act s.40A(3)",
      message: `Paying this ${inr(b.total ?? 0)} bill in cash (above ${inr(LAW.CASH_EXPENSE_LIMIT)} in a day) makes it a disallowed expense. Pay by bank/UPI.` });
  }
  return w;
}

/* ── Money received ──────────────────────────────────────────────────────── */
export interface PaymentCheck { amount: number | null; method: string | null }

export function checkPayment(p: PaymentCheck): LawWarning[] {
  const w: LawWarning[] = [];
  const amt = p.amount ?? 0;
  if (p.method === "cash" && amt >= LAW.CASH_RECEIPT_LIMIT) {
    w.push({ code: "cash-269ST", severity: "stop", law: "Income-tax Act s.269ST / s.271DA",
      message: `Receiving ${inr(LAW.CASH_RECEIPT_LIMIT)} or more in cash from one person (in a day, or for one transaction) is prohibited — the penalty equals the amount received. Take it by bank/UPI.` });
  }
  if (amt > LAW.TDS_194J_YEAR) {
    w.push({ code: "tds-by-customer", severity: "check", law: "Income-tax Act s.194J / 194C",
      message: "A business customer may deduct TDS on a payment this size. Record what actually came in and the TDS separately, so Form 26AS matches." });
  }
  return w;
}

/* ── Customer ────────────────────────────────────────────────────────────── */
export function checkCustomer(c: { gstinTyped: string | null; gstinValid: boolean }): LawWarning[] {
  if (c.gstinTyped && !c.gstinValid) {
    return [{ code: "gstin-invalid", severity: "check", law: "CGST Rules, Rule 10",
      message: `“${c.gstinTyped}” is not a valid GSTIN (the check digit does not match). A B2B invoice with a wrong GSTIN does not give the customer ITC — confirm it with them.` }];
  }
  return [];
}

export const hasStop = (w: LawWarning[]) => w.some((x) => x.severity === "stop");
