/**
 * Payment run — the pure half (R-163, 5 Oct 2026). Pazy-style vendor payouts inside ResellerOS.
 *
 * Which bill to pay first, what the bank's bulk-upload file says, and what is missing before a
 * file can be made. The database (migration 20261005110000_payment_runs.sql) owns every rule
 * about WHO may create / approve / mark paid and what may not be paid twice; this file only
 * decides presentation and the file's rows, so it is tested without a database.
 *
 * ResellerOS never moves money. The file is uploaded by a person in their own net-banking.
 */

export type PayableSource = "vendor_bill" | "expense";

export interface Payable {
  source: PayableSource;
  docId: string;
  docRef: string | null;
  vendorId: string | null;
  vendorName: string;
  billDate: string | null;
  dueDate: string | null;
  /** ₹ still owed (whole rupees). */
  outstanding: number;
  /** MSMED Act s.15: pay a micro/small vendor within 45 days of the bill. */
  msmeDeadline: string | null;
  msmeOverLimit: boolean;
}

export type Urgency = "msme_late" | "overdue" | "msme_soon" | "due_soon" | "later";

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** How pressing one payable is, as of `today` (YYYY-MM-DD). */
export function urgencyOf(p: Payable, today: string): { level: Urgency; label: string } {
  if (p.msmeDeadline) {
    const left = days(today, p.msmeDeadline);
    if (p.msmeOverLimit || left < 0) return { level: "msme_late", label: `MSME 45 days crossed${left < 0 ? ` · ${-left}d late` : ""}` };
    if (left <= 7) return { level: "msme_soon", label: `MSME deadline in ${left}d` };
  }
  if (p.dueDate) {
    const left = days(today, p.dueDate);
    if (left < 0) return { level: "overdue", label: `Overdue ${-left}d` };
    if (left === 0) return { level: "due_soon", label: "Due today" };
    if (left <= 7) return { level: "due_soon", label: `Due in ${left}d` };
    return { level: "later", label: `Due ${p.dueDate}` };
  }
  return { level: "later", label: p.billDate ? `Bill ${p.billDate}` : "No due date" };
}

const RANK: Record<Urgency, number> = { msme_late: 0, overdue: 1, msme_soon: 2, due_soon: 3, later: 4 };

/** Most pressing first; then the earliest due / oldest bill. */
export function sortPayables(list: readonly Payable[], today: string): Payable[] {
  const key = (p: Payable) => p.msmeDeadline ?? p.dueDate ?? p.billDate ?? "9999-12-31";
  return [...list].sort((a, b) =>
    RANK[urgencyOf(a, today).level] - RANK[urgencyOf(b, today).level] || key(a).localeCompare(key(b)) || a.docId.localeCompare(b.docId));
}

// ─── The bank's bulk-upload file ────────────────────────────────────────────

export interface VendorBank {
  id: string;
  name: string;
  bank_account_name: string | null;
  bank_account_no: string | null;
  bank_ifsc: string | null;
  upi_id: string | null;
}

export interface RunItem { source: PayableSource; doc_id: string; doc_ref: string | null; vendor_id: string | null; vendor_name: string; amount: number }

export const BANK_FILE_HEADERS = ["Beneficiary Name", "Account Number", "IFSC", "UPI ID", "Amount", "Payment Mode", "Narration"] as const;

/** RBI: RTGS is for ₹2 lakh and above; below it NEFT (UPI when only a UPI id is known). */
export const RTGS_MIN = 200_000;
/** Most Indian banks cut the beneficiary narration at 30 characters. */
export const NARRATION_MAX = 30;

export function paymentMode(amount: number, hasAccount: boolean): "RTGS" | "NEFT" | "UPI" {
  if (!hasAccount) return "UPI";
  return amount >= RTGS_MIN ? "RTGS" : "NEFT";
}

/**
 * One row per BILL. A first version grouped a vendor's bills into one transfer, but the run
 * writes one bank entry per bill (that is what settles each bill), so the bank statement
 * would show ₹2,12,400 against two ledger lines of ₹1,18,000 + ₹94,400 and the BRS would not
 * match without a manual split. One transfer per bill matches 1:1 — and online NEFT/RTGS
 * is free at most banks now. Vendors with no account+IFSC and no UPI id come back in
 * `missing` and the file is not made, because a bank rejects the whole upload over one bad row.
 */
export function bankFileRows(runNo: string, items: readonly RunItem[], vendors: readonly VendorBank[]): {
  rows: (string | number)[][];
  missing: string[];
  total: number;
} {
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const byName = new Map(vendors.map((v) => [v.name.trim().toLowerCase(), v]));
  const rows: (string | number)[][] = [];
  const missing = new Set<string>();
  let total = 0;
  const sorted = [...items].sort((x, y) => x.vendor_name.localeCompare(y.vendor_name) || (x.doc_ref ?? x.doc_id).localeCompare(y.doc_ref ?? y.doc_id));
  for (const it of sorted) {
    const v = (it.vendor_id && byId.get(it.vendor_id)) || byName.get(it.vendor_name.trim().toLowerCase());
    const hasAccount = !!(v?.bank_account_no && v?.bank_ifsc);
    if (!hasAccount && !v?.upi_id) { missing.add(it.vendor_name); continue; }
    rows.push([
      (v?.bank_account_name || v?.name || it.vendor_name).slice(0, 50),
      hasAccount ? v!.bank_account_no! : "",
      hasAccount ? v!.bank_ifsc! : "",
      hasAccount ? "" : v!.upi_id!,
      it.amount,
      paymentMode(it.amount, hasAccount),
      `${runNo} ${it.doc_ref ?? it.doc_id}`.slice(0, NARRATION_MAX),
    ]);
    total += it.amount;
  }
  return { rows, missing: [...missing].sort(), total };
}

// ─── Form checks (the DB checks the same; these give the message before the save) ────────

// R-1905: the rules and their messages live in one place, lib/banking/bank-details.
export { IFSC_RE, ACCOUNT_RE, UPI_RE, cleanAccountNo, cleanIfsc } from "@/lib/banking/bank-details";

/** Show only the last 4 digits of an account number on screens that are not the vendor form. */
export const maskAccount = (n: string | null | undefined) => (n ? `••••${n.slice(-4)}` : "—");
