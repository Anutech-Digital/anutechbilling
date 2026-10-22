/**
 * "Received in" on the desk Record payment sheet (R-404, 9 Oct 2026).
 *
 * WHY: the sheet's "Deposit To" list was five hard-coded rows — "Anutech Digital — Bank A/c",
 * "— Razorpay", "— Petty Cash" … — shown to EVERY company, and each one tagged the payment
 * with a made-up account id ("hdfc_primary", "cash_box"). payments.bank_account_id is a uuid
 * FK to bank_accounts, so that tag update failed on every payment (Abhishek, 8 Oct: all 7 test
 * payments had no bank account) and reconciliation never knew which account got the money.
 *
 * Now the method and the account are two separate choices: the method is a fixed list (no
 * company name in it), and the account comes from THIS company's own bank_accounts rows.
 * Rules are pure and unit-tested here; the sheet only renders them.
 */
import { bankLabel } from "@/lib/utils";

export type PaymentMethod = "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";

/** The method list — no company name in any label. */
export const PAYMENT_METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: "upi",           label: "UPI / QR code" },
  { value: "bank_transfer", label: "Bank transfer (NEFT / RTGS / IMPS)" },
  { value: "razorpay",      label: "Razorpay (online)" },
  { value: "cheque",        label: "Cheque" },
  { value: "cash",          label: "Cash" },
  { value: "other",         label: "Other" },
];

/** The fields of a bank_accounts row this sheet needs. */
export interface DepositAccount {
  id: string;
  name: string;
  bank_name?: string | null;
  account_number_last4?: string | null;
  account_type?: string | null;
  is_active?: boolean | null;
}

/** Shown in the list: "Current A/c · HDFC ••1234". */
export function depositAccountLabel(a: DepositAccount): string {
  return `${a.name} · ${bankLabel(a.bank_name, a.account_number_last4)}`;
}

/** Accounts that can receive money from a customer: active, and not a credit card. */
export function depositAccounts(accounts: ReadonlyArray<DepositAccount> | null | undefined): DepositAccount[] {
  return (accounts ?? []).filter((a) => a.is_active !== false && a.account_type !== "credit_card");
}

/**
 * The account to pre-pick for a method, or "" (not tagged) when it would be a guess.
 *   · cash → the company's one cash account, if it has exactly one;
 *   · other → nothing;
 *   · UPI / bank / Razorpay / cheque → the company's one bank account, if it has exactly one.
 * Several candidates → "" so the operator picks; a wrong tag is worse than none.
 */
export function defaultDepositAccountId(
  accounts: ReadonlyArray<DepositAccount> | null | undefined,
  method: PaymentMethod | string,
): string {
  if (method === "other") return "";
  const usable = depositAccounts(accounts);
  const pool = method === "cash"
    ? usable.filter((a) => a.account_type === "cash")
    : usable.filter((a) => a.account_type !== "cash");
  return pool.length === 1 ? pool[0].id : "";
}

/**
 * R-1730 — the account "Received in" opens on, in EVERY Record payment sheet (quote, dues row,
 * several invoices, imported Zoho invoice). Owner, 21 Oct: it opened on "Not sure yet" although
 * the usual account was obvious.
 *   1. one account fits the method → that one (defaultDepositAccountId above);
 *   2. else the account this company usually receives into: the one most of its recent tagged
 *      payments went to (`recentTags` = bank_account_id of its latest payments), counted only
 *      among accounts that fit the method — a strict winner, never a tie;
 *   3. else "" (Not sure yet) — 2+ accounts and none is usual; a wrong tag is worse than none.
 * bank_accounts has no "default account" column, so usage is the only notion of usual.
 */
export function usualDepositAccountId(
  accounts: ReadonlyArray<DepositAccount> | null | undefined,
  method: PaymentMethod | string,
  recentTags: ReadonlyArray<string | null | undefined> | null | undefined,
): string {
  if (method === "other") return "";
  const only = defaultDepositAccountId(accounts, method);
  if (only) return only;
  const usable = depositAccounts(accounts);
  const pool = new Set(
    (method === "cash" ? usable.filter((a) => a.account_type === "cash") : usable.filter((a) => a.account_type !== "cash"))
      .map((a) => a.id),
  );
  const counts = new Map<string, number>();
  for (const id of recentTags ?? []) if (id && pool.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "";
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return "";
  return ranked[0][0];
}

/** One default method for every Record payment sheet (R-1730). */
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = "upi";

/** True only for a real bank_accounts id — never a made-up one like "hdfc_primary". */
export function isBankAccountId(id: string | null | undefined): id is string {
  return typeof id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}
