/**
 * R-1859 (epic R-1841, Phase 4) — does the tax audit apply this year, and why.
 *
 * The Compliance Calendar used to show "Tax audit report" to every business with the text
 * "If turnover > ₹1 cr (or ₹10 cr if ≤5% cash)". The app has the turnover (P&L revenue) and
 * the bank / cash lines, so it can answer the question itself.
 *
 * ══ THE RULE (Income-tax Act 1961, s.44AB(a) and its proviso) ═════════════════════════════
 *   A person carrying on BUSINESS needs a tax audit when total sales / turnover / gross
 *   receipts in the year EXCEED ₹1 crore. The limit is ₹10 crore when cash receipts do not
 *   exceed 5 % of all receipts AND cash payments do not exceed 5 % of all payments.
 *   The audit report is due 30 September after the FY ("specified date" = one month before
 *   the s.139(1) return due date); the return of an audited business (and of every company)
 *   is then due 31 October — Explanation 2(a) to s.139(1).
 *   Companies are covered by s.44AB too; separately, every company's accounts are audited
 *   under the Companies Act 2013 (statutory audit) whatever the turnover.
 *
 *   Official sources (read 25 Oct 2026, "last reviewed 08-Oct-2026" on the page):
 *   - CBDT FAQ, who is covered by tax audit — TAX_AUDIT_LIMITS.sources[0]
 *   - CBDT FAQ, due date of the audit report — sources[1]
 *   - CBDT press release 29-10-2025 (s.139(1) due date "31st October" for clause (a) of
 *     Explanation 2, i.e. audited assessees) — sources[2]
 *
 *   NOT modelled here (the CA's call — card step for Hitesh): presumptive tax (s.44AD, the
 *   FAQ's "₹2 crore" opt-out, and declaring profit below it), professions (₹50 lakh), and
 *   "cash" meaning non-account-payee cheques too. Income-tax Act 2025 (from tax year 2026-27)
 *   moves this to its own section (reportedly s.63) — same limits until the CA confirms.
 *   Government extensions of the dates are not modelled: the page already says "confirm with
 *   your CA".
 *
 * The cash share comes from the bank / cash account lines (cashShares): lines on a cash
 * account (Petty Cash …) over all lines, transfers between own accounts left out. With no
 * bank-statement lines at all it is unknown, and a ₹1–10 Cr business reads "maybe".
 * Pure — no I/O.
 */
import type { BusinessType } from "./obligations";
import { obligationsFor } from "./obligations";
import { entityProfile } from "./entity";

export const TAX_AUDIT_LIMITS = {
  /** s.44AB(a): turnover above this → tax audit. */
  basic: 1_00_00_000,
  /** s.44AB(a) proviso: the limit when cash receipts and cash payments are each ≤ cashPct. */
  raised: 10_00_00_000,
  cashPct: 5,
  /** Audit report: 30 Sep of the assessment year. */
  reportDue: { month: 9, day: 30 },
  /** Return of an audited business / a company: 31 Oct. Others: 31 Jul. */
  itrDueAudited: { month: 10, day: 31 },
  itrDueNotAudited: { month: 7, day: 31 },
  sources: [
    { what: "Who needs a tax audit (s.44AB, ₹1 Cr / ₹10 Cr with cash ≤ 5%)", url: "https://www.incometaxindia.gov.in/w/as-per-section-44ab-who-is-compulsorily-required-to-get-his-accounts-audited-i.e.-who-is-covered-by-tax-audit-" },
    { what: "Audit report due 30 September", url: "https://www.incometaxindia.gov.in/w/what-is-the-due-date-by-which-a-taxpayer-should-get-his-accounts-audited-" },
    { what: "Return of audited assessees due 31 October (s.139(1) Expl. 2(a))", url: "https://incometaxindia.gov.in/Lists/Press%20Releases/Attachments/1231/Press-Release-CBDT-extends-due-date-for-furnishing-Return-of-Income-for-the-Assessment-Year-2025-26-dated-29-10-2025.pdf" },
  ],
} as const;

export type TaxAuditVerdict = "applies" | "not_applicable" | "maybe";

export interface TaxAuditResult {
  verdict: TaxAuditVerdict;
  /** The FY the answer is for (start year: 2025 = FY 2025-26). */
  fyStartYear: number;
  /** One line, shown on the calendar row. */
  reason: string;
  /** Pvt Ltd only: the Companies Act statutory audit, which is separate and always needed. */
  companyNote: string | null;
}

export interface TaxAuditInput {
  businessType: BusinessType | null | undefined;
  fyStartYear: number;
  /** FY turnover ex-GST, whole rupees. Null = not known. */
  turnover: number | null;
  /** 0–100. Null = not known. */
  cashReceiptsPct: number | null;
  cashPaymentsPct: number | null;
  /** The FY is still running — the turnover is "so far". */
  partialYear?: boolean;
}

/** ₹62L · ₹3 Cr · ₹1.25 Cr · ₹45,000 — Indian lakh / crore. */
export function inrShort(n: number): string {
  const trim = (v: number) => String(Math.round(v * 100) / 100);
  if (n >= 1_00_00_000) return `₹${trim(n / 1_00_00_000)} Cr`;
  if (n >= 1_00_000) return `₹${trim(n / 1_00_000)}L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const pct = (v: number) => `${Math.round(v * 10) / 10}%`;
const fyText = (y: number) => `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;

export function taxAuditStatus(i: TaxAuditInput): TaxAuditResult {
  const { basic, raised, cashPct } = TAX_AUDIT_LIMITS;
  const company = entityProfile(i.businessType).type === "pvt_ltd";
  const companyNote = company ? "Statutory audit under the Companies Act is needed every year, whatever the turnover." : null;
  const done = (verdict: TaxAuditVerdict, reason: string): TaxAuditResult => ({ verdict, fyStartYear: i.fyStartYear, reason, companyNote });
  const fy = fyText(i.fyStartYear);
  if (i.turnover === null || !Number.isFinite(i.turnover)) {
    return done("maybe", `Turnover for ${fy} is not known yet — tax audit applies above ₹1 Cr (₹10 Cr if cash is within 5%).`);
  }
  const t = `${i.partialYear ? `Turnover so far in ${fy}` : `${fy} turnover`} ${inrShort(i.turnover)}`;
  if (i.turnover <= basic) return done("not_applicable", `Not applicable — ${t} is not over the ₹1 Cr limit (s.44AB).`);
  if (i.turnover > raised) return done("applies", `Applies — ${t} is over ₹10 Cr (s.44AB).`);

  const r = i.cashReceiptsPct, p = i.cashPaymentsPct;
  const over = [r !== null && r > cashPct ? `cash receipts ${pct(r)}` : null, p !== null && p > cashPct ? `cash payments ${pct(p)}` : null].filter(Boolean);
  if (over.length) {
    return done("applies", `Applies — ${t} is over ₹1 Cr and ${over.join(" and ")} ${over.length > 1 ? "are" : "is"} over 5%, so the ₹10 Cr limit is not available (s.44AB).`);
  }
  if (r === null || p === null) {
    return done("maybe", `${t} is between ₹1 Cr and ₹10 Cr — no tax audit only if cash receipts and cash payments are each within 5%. Import the bank statements for ${fy} so the app can check, or ask your CA.`);
  }
  return done("not_applicable", `Not applicable — ${t} is under the ₹10 Cr limit: cash receipts ${pct(r)} and cash payments ${pct(p)} are within 5% (s.44AB).`);
}

export interface CashLine { credit: number; debit: number; isCash: boolean; isTransfer: boolean }

/**
 * Cash receipts / payments as % of all receipts / payments, from the FY's bank and cash
 * account lines. Transfers between own accounts (bank → petty cash) are not receipts or
 * payments. No line on a non-cash account at all → null (bank statements not imported).
 */
export function cashShares(lines: readonly CashLine[]): { receiptsPct: number | null; paymentsPct: number | null } | null {
  let inAll = 0, inCash = 0, outAll = 0, outCash = 0, bankLines = 0;
  for (const l of lines) {
    if (l.isTransfer) continue;
    if (!l.isCash) bankLines += 1;
    const c = Number(l.credit) || 0, d = Number(l.debit) || 0;
    inAll += c; outAll += d;
    if (l.isCash) { inCash += c; outCash += d; }
  }
  if (bankLines === 0) return null;
  return {
    receiptsPct: inAll > 0 ? (inCash / inAll) * 100 : null,
    paymentsPct: outAll > 0 ? (outCash / outAll) * 100 : null,
  };
}

/** The FY the next tax-audit report is for — the calendar row's own period. */
export function taxAuditFyFor(today: Date, isFiled: (periodKey: string) => boolean): number {
  const ob = obligationsFor().find((o) => o.key === "it_taxaudit");
  const key = ob ? ob.next(today, isFiled).periodKey : "";
  const m = /^fy(\d{4})$/.exec(key);
  return m ? Number(m[1]) : today.getFullYear() - (today.getMonth() < 3 ? 2 : 1);
}
