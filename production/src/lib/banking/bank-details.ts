/**
 * R-1905 — one place for the bank-detail rules and their messages (IFSC, account number,
 * UPI ID). The vendor form, Setup → "How customers pay you" and Banking → Add account all
 * read these, so the owner sees the same words everywhere.
 *
 * Owner, 25 Oct 2026: an IFSC of 10 characters ("IDFB002015") gave the toast "Bank details
 * are not complete — check the account number, IFSC or UPI ID", and he thought the UPI ID
 * was compulsory. Each field now says what is wrong with IT, and an empty UPI never blocks.
 *
 * The DB checks the same shapes (vendors_bank_ifsc_format, vendors_bank_account_no_format,
 * vendors_upi_id_format) — these only give the message before the save.
 */

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[0-9]{6,18}$/;
export const UPI_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;

/** "50100 1234 5678" → "5010012345678"; " hdfc0001234 " → "HDFC0001234". */
export const cleanAccountNo = (s: string) => s.replace(/[\s-]/g, "");
export const cleanIfsc = (s: string) => s.trim().toUpperCase();

const IFSC_RULE = "4 letters, 0, then 6 letters/digits), e.g. HDFC0001234";

/** What is wrong with this IFSC, or null when it is fine. Blank is not checked here. */
export function ifscProblem(raw: string): string | null {
  const v = cleanIfsc(raw);
  if (!v) return null;
  if (IFSC_RE.test(v)) return null;
  if (v.length !== 11) {
    const n = v.length;
    return `IFSC has ${n} character${n === 1 ? "" : "s"} — it needs 11 (${IFSC_RULE}. Copy it from a cheque or the bank's website.`;
  }
  if (!/^[A-Z]{4}/.test(v)) return `The first 4 characters of an IFSC are letters (the bank code) — e.g. HDFC0001234.`;
  if (v[4] !== "0") return `The 5th character of an IFSC is always 0 (zero) — e.g. HDFC0001234.`;
  return `The last 6 characters of an IFSC are letters or digits only — e.g. HDFC0001234.`;
}

/** What is wrong with this account number, or null. Spaces and dashes are allowed. */
export function accountNoProblem(raw: string): string | null {
  const v = cleanAccountNo(raw);
  if (!v) return null;
  if (!/^[0-9]+$/.test(v)) return "The account number has digits only — no letters or symbols.";
  if (!ACCOUNT_RE.test(v)) return `The account number has ${v.length} digit${v.length === 1 ? "" : "s"} — it needs 6 to 18.`;
  return null;
}

/** What is wrong with this UPI ID, or null. Empty is fine — the UPI ID is optional. */
export function upiProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (!UPI_RE.test(v)) return "This UPI ID looks wrong — it is like name@okhdfcbank. Leave it empty if there is none.";
  return null;
}

export type BankField = "accountNo" | "ifsc" | "upi";
export const BANK_FIELD_LABEL: Record<BankField, string> = {
  accountNo: "Account number",
  ifsc: "IFSC",
  upi: "UPI ID",
};

export interface BankDetailsInput { accountNo: string; ifsc: string; upi: string }
export interface BankDetailsCheck {
  /** One message per wrong field; a field that is fine is absent. */
  errors: Partial<Record<BankField, string>>;
  /** The first wrong field in screen order (account number, IFSC, UPI) — Save focuses it. */
  first: BankField | null;
}

/**
 * Check the bank block of a payee form. An account number and an IFSC go together (one
 * without the other is the "pairing" message on the empty one); the UPI ID is optional
 * and only checked when typed.
 */
export function checkBankDetails(b: BankDetailsInput): BankDetailsCheck {
  const errors: Partial<Record<BankField, string>> = {};
  const acc = accountNoProblem(b.accountNo);
  const ifsc = ifscProblem(b.ifsc);
  const upi = upiProblem(b.upi);
  const hasAcc = !!b.accountNo.trim();
  const hasIfsc = !!b.ifsc.trim();
  if (acc) errors.accountNo = acc;
  else if (!hasAcc && hasIfsc) errors.accountNo = "Add the account number that goes with this IFSC.";
  if (ifsc) errors.ifsc = ifsc;
  else if (hasAcc && !hasIfsc) errors.ifsc = "Add the IFSC that goes with this account number.";
  if (upi) errors.upi = upi;
  const order: BankField[] = ["accountNo", "ifsc", "upi"];
  return { errors, first: order.find((f) => errors[f]) ?? null };
}

/** The Save toast: names the first wrong field and says what is wrong with it. */
export function bankToast(c: BankDetailsCheck): { title: string; description: string } | null {
  if (!c.first) return null;
  return { title: `Check the ${BANK_FIELD_LABEL[c.first]}`, description: c.errors[c.first]! };
}
