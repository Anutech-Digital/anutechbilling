/**
 * R-1918 — the payee's bank details as a bank narration shows them, for the "＋ New vendor" form
 * on a money-out line (Banking → Reconcile). Saved on the vendor, they let the NEXT line from the
 * same vendor be guessed (guessVendor / bank_debit_vendor_guess read upi_id and bank_account_no).
 *
 * The rails write fixed slots (see narration.ts for the payee name):
 *   NEFT DR-<IFSC>-<NAME>-NETBANK, MUM-<utr>-<remark>      RTGS DR-<IFSC>-<NAME>-…
 *   IMPS-<ref>-<NAME>-<bank>-<account, often XXXX-masked>-<remark>
 *   UPI-<NAME>-<vpa>-<IFSC>-<rrn>-<remark>    UPI/<rrn>/<NAME>/<vpa>/…
 *   <full account>-TPT-<remark>-<NAME>         (HDFC to HDFC)
 * A reference / UTR / RRN is never taken as an account number: an account is read only from
 * its own slot. A masked tail ("XXXXXX4521", "…4521") is NOT an account number — it is only
 * shown as a hint, since the vendor's account must be the full number (6–18 digits, R-1905).
 */
import { payeeFromNarration } from "./narration";
import { ACCOUNT_RE, IFSC_RE, UPI_RE, cleanAccountNo } from "./bank-details";

export interface NarrationBankDetails {
  name: string | null;
  ifsc: string | null;
  /** The full account number, only when the line shows it unmasked in the account slot. */
  accountNo: string | null;
  /** The last digits of a masked account ("XXXXXX4521" → "4521"). */
  accountTail: string | null;
  upi: string | null;
}

const titleCase = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
const isName = (s: string | undefined): s is string =>
  !!s && /^[A-Za-z][A-Za-z .&']*[A-Za-z.]$/.test(s.trim()) && s.trim().length >= 3;
const MASKED = /^[X*•.…]+\s*([0-9]{3,6})$/i;
const fullAccount = (s: string | undefined) => {
  const v = cleanAccountNo(s ?? "");
  return ACCOUNT_RE.test(v) ? v : null;
};

export function bankDetailsFromNarration(description: string | null | undefined): NarrationBankDetails {
  const text = (description ?? "").trim();
  const out: NarrationBankDetails = { name: null, ifsc: null, accountNo: null, accountTail: null, upi: null };
  if (!text) return out;

  const dash = text.split("-").map((s) => s.trim());
  const tokens = text.split(/[-/,\s]+/).filter(Boolean);

  out.ifsc = tokens.map((t) => t.toUpperCase()).find((t) => IFSC_RE.test(t)) ?? null;
  out.upi = tokens.find((t) => t.includes("@") && UPI_RE.test(t))?.toLowerCase() ?? null;

  /* Name: narration.ts's rails, plus the two it does not read — HDFC's "UPI-<NAME>-<vpa>" and TPT. */
  const isTpt = /^TPT$/i.test(dash[1] ?? "");
  if (/^UPI$/i.test(dash[0] ?? "") && (dash[2] ?? "").includes("@") && isName(dash[1])) out.name = titleCase(dash[1]);
  else if (isTpt && isName(dash[dash.length - 1])) out.name = titleCase(dash[dash.length - 1]);
  else out.name = payeeFromNarration(text);

  /* Account: only from its slot — TPT's first part, IMPS's fifth; a masked tail anywhere. */
  if (isTpt) out.accountNo = fullAccount(dash[0]);
  else if (/^IMPS$/i.test(dash[0] ?? "")) out.accountNo = fullAccount(dash[4]);
  if (!out.accountNo) {
    for (const seg of [...dash, ...tokens]) {
      const m = MASKED.exec(seg.trim());
      if (m) { out.accountTail = m[1]; break; }
    }
  }
  return out;
}

export type NewVendorField = "name" | "accountNo" | "ifsc" | "upi";

export interface NewVendorDraftFromLine {
  name: string;
  accountNo: string;
  ifsc: string;
  upi: string;
  accountTail: string | null;
  /** The fields that were filled from the bank line, in form order — the form says so beside them. */
  fromLine: NewVendorField[];
}

/** The "＋ New vendor" form's starting values for this bank line. */
export function newVendorFromNarration(description: string | null | undefined): NewVendorDraftFromLine {
  const d = bankDetailsFromNarration(description);
  const f: NewVendorDraftFromLine = {
    name: d.name ?? "", accountNo: d.accountNo ?? "", ifsc: d.ifsc ?? "", upi: d.upi ?? "",
    accountTail: d.accountTail, fromLine: [],
  };
  (["name", "accountNo", "ifsc", "upi"] as const).forEach((k) => { if (f[k]) f.fromLine.push(k); });
  return f;
}

/** The typed account does not end with the digits the bank line shows — likely a typo. */
export function tailMismatch(accountNo: string, tail: string | null): string | null {
  const v = cleanAccountNo(accountNo);
  if (!tail || !v || v.endsWith(tail)) return null;
  return `The bank line shows an account that ends with ${tail} — check this number.`;
}
