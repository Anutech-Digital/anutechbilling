/**
 * R-2376 — TDS on interest the business pays to a NON-BANK lender (NBFC such as Bajaj Finance /
 * Tata Capital, a director, any person). Pure — no I/O.
 *
 * THE RULE (owner-delegated tax decision, 3 Nov 2026 — Anutech-HQ/drafts/TAX-DECISIONS/
 * 2026-11-03.md §4; the CA confirms clause numbers):
 *   - s.393(1) Table Sl. 5(iii), Income-tax Act 2025, from 1 Apr 2026 (old s.194A, 1961 Act).
 *   - 10% once the interest credited/paid to ONE lender in a FY is MORE than ₹10,000 (₹5,000 up
 *     to FY 2024-25). Once above, TDS is on the whole year's amount, earlier entries included.
 *   - "Interest" includes a loan processing fee (s.2(28A)) — counted WITHOUT GST (CBDT Circ. 23/2017).
 *   - Banks (banking companies, co-op banks, LIC, insurers…) are exempt; NBFCs are not.
 *   - Who deducts: a company / LLP / firm always; an individual (proprietorship) only when its
 *     accounts were tax-audited (s.44AB, now s.63) in the PREVIOUS FY — asked once per FY,
 *     never silently assumed.
 *
 * The app never posts a TDS entry by itself: it shows "TDS 10% due" with the amount and the entry
 * (Dr lender / Cr TDS payable). The owner keeps it back on a repayment (Banking → Reconcile →
 * Loan / EMI, TDS box pre-filled by suggestTdsForPayment) — that lands in the existing TDS payable
 * (dues_vendor_tds), the one TDS list.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { TDS_SECTION_RATES } from "@/lib/accounting/tds-rates";
import { TDS_THRESHOLDS } from "@/lib/accounting/tds-deductor";
import { fyStartYear } from "@/lib/dates/ist";

export const LOAN_TDS = {
  /** The 194A row of the one TDS rate / limit table (tds-rates.ts, tds-deductor.ts). */
  ratePct: TDS_SECTION_RATES["194A"].ratePct,
  /** Above this (per lender per FY) TDS applies. Finance Act 2025: ₹10,000 from 1 Apr 2025. */
  threshold: TDS_THRESHOLDS["194A"].aggregate,
  oldThreshold: 5_000,
  /** The FY (start year) the ₹10,000 limit starts. */
  thresholdFromFy: 2025,
  /** The FY the Income-tax Act 2025 starts (s.393). */
  newActFromFy: 2026,
} as const;

export type LenderType = "bank" | "non_bank";

/** tenants.loan_interest_tds — written only by set_loan_interest_tds (R-2376). */
export interface LoanTdsSettings {
  /** The owner turned the check off. */
  off: boolean;
  /** Proprietorship: was the FY (key = start year, "2025" = FY 2025-26) tax-audited? */
  audited: Record<string, boolean>;
  /** lenderKey(name) → bank / non_bank. Unmarked = ask once. */
  lenders: Record<string, LenderType>;
}

export function emptyLoanTdsSettings(): LoanTdsSettings {
  return { off: false, audited: {}, lenders: {} };
}

/** Read the jsonb safely — anything odd is left out, never guessed. */
export function readLoanTdsSettings(raw: unknown): LoanTdsSettings {
  const out = emptyLoanTdsSettings();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  out.off = r.off === true;
  if (r.audited && typeof r.audited === "object") {
    for (const [k, v] of Object.entries(r.audited as Record<string, unknown>)) {
      if (/^\d{4}$/.test(k) && typeof v === "boolean") out.audited[k] = v;
    }
  }
  if (r.lenders && typeof r.lenders === "object") {
    for (const [k, v] of Object.entries(r.lenders as Record<string, unknown>)) {
      if (v === "bank" || v === "non_bank") out.lenders[k] = v;
    }
  }
  return out;
}

/** One key per lender, whatever the spelling: "Tata Capital Ltd." = "TATA CAPITAL". */
export function lenderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["ltd", "limited", "pvt", "private", "the", "co", "company"].includes(w))
    .join(" ");
}

/** FY start year of an ISO date (April–March) — lib/dates/ist fyStartYear, the one FY rule. */
export function fyStartOf(dateISO: string): number {
  return fyStartYear(dateISO);
}

export function thresholdFor(fyStart: number): number {
  return fyStart >= LOAN_TDS.thresholdFromFy ? LOAN_TDS.threshold : LOAN_TDS.oldThreshold;
}

/** Both labels from FY 2026-27 (new Act), the old section before. */
export function sectionLabel(fyStart: number): string {
  return fyStart >= LOAN_TDS.newActFromFy ? "s.393(1) Table 5(iii) (old 194A)" : "194A";
}

export type DeductorGate =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "ask_audit"; prevFyStart: number }
  | { kind: "not_required"; prevFyStart: number };

/** Must THIS business deduct TDS on interest in the FY? */
export function deductorGate(businessType: BusinessType | null | undefined, s: LoanTdsSettings, fyStart: number): DeductorGate {
  if (s.off) return { kind: "off" };
  if (businessType !== "proprietor") return { kind: "on" };   // company / LLP / firm (or not set: safest)
  const prev = fyStart - 1;
  const a = s.audited[String(prev)];
  if (a === undefined) return { kind: "ask_audit", prevFyStart: prev };
  return a ? { kind: "on" } : { kind: "not_required", prevFyStart: prev };
}

export interface InterestEvent {
  lender: string;
  /** ISO date the interest / fee was credited or paid. */
  on: string;
  /** Rupees; a processing fee WITHOUT GST. */
  amount: number;
  kind: "interest" | "fee";
  /** TDS already kept back on it. */
  tdsKept: number;
  /** Known without asking (a director's loan = non_bank). */
  lenderType?: LenderType | null;
  /** Booked as an EMI (emi_payments / emi_purchases): the EMI reconcile has no TDS box yet. */
  viaEmi?: boolean;
}

/** not_required = above the limit, but this business need not deduct (setting off / proprietor not audited). */
export type LenderTdsStatus = "due" | "settled" | "below_limit" | "bank_exempt" | "ask_type" | "not_required";

export interface LenderTdsLine {
  lender: string;
  key: string;
  fyStart: number;
  type: LenderType | null;
  /** Interest + fee (ex-GST) to this lender in the FY. */
  total: number;
  tdsKept: number;
  /** 10% of total − kept (0 unless above the limit and not a bank). */
  tdsDue: number;
  /** The date of the booking that took the FY total above the limit. */
  crossedOn: string | null;
  status: LenderTdsStatus;
  section: string;
  /** The entry to post when the owner confirms. */
  entry: { dr: string; cr: string; amount: number } | null;
  /** Every booking to this lender is an EMI — the TDS cannot be kept back in the app yet. */
  onlyEmi: boolean;
}

function typeOf(key: string, evs: readonly InterestEvent[], s: LoanTdsSettings): LenderType | null {
  return s.lenders[key] ?? evs.find((e) => e.lenderType)?.lenderType ?? null;
}

/** Every lender's line for one FY. */
export function loanInterestTds(i: {
  events: readonly InterestEvent[];
  settings: LoanTdsSettings;
  businessType: BusinessType | null | undefined;
  fyStart: number;
}): { gate: DeductorGate; lines: LenderTdsLine[] } {
  const gate = deductorGate(i.businessType, i.settings, i.fyStart);
  const limit = thresholdFor(i.fyStart);
  const section = sectionLabel(i.fyStart);
  const groups = new Map<string, InterestEvent[]>();
  for (const e of i.events) {
    if (fyStartOf(e.on) !== i.fyStart || !(e.amount > 0 || e.tdsKept > 0)) continue;
    const k = lenderKey(e.lender);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const lines: LenderTdsLine[] = [];
  for (const [key, evs] of groups) {
    const sorted = [...evs].sort((a, b) => a.on.localeCompare(b.on));
    let run = 0;
    let crossedOn: string | null = null;
    for (const e of sorted) {
      run += Math.max(0, Math.round(e.amount));
      if (crossedOn === null && run > limit) crossedOn = e.on;
    }
    const total = run;
    const tdsKept = sorted.reduce((s, e) => s + Math.max(0, Math.round(e.tdsKept)), 0);
    const type = typeOf(key, sorted, i.settings);
    const gross = crossedOn ? Math.round((total * LOAN_TDS.ratePct) / 100) : 0;
    const left = Math.max(0, gross - tdsKept);
    let status: LenderTdsStatus;
    if (type === "bank") status = "bank_exempt";
    else if (!crossedOn) status = "below_limit";
    else if (type === null) status = "ask_type";
    else status = left > 0 ? "due" : "settled";
    if ((status === "due" || status === "ask_type") && (gate.kind === "off" || gate.kind === "not_required")) status = "not_required";
    const tdsDue = status === "due" || status === "ask_type" ? left : 0;
    lines.push({
      lender: sorted[0].lender, key, fyStart: i.fyStart, type, total, tdsKept, tdsDue, crossedOn, status, section,
      entry: status === "due" ? { dr: sorted[0].lender, cr: `TDS payable — ${section}`, amount: tdsDue } : null,
      onlyEmi: sorted.every((e) => e.viaEmi === true),
    });
  }
  const order: Record<LenderTdsStatus, number> = { due: 0, ask_type: 1, settled: 2, not_required: 3, below_limit: 4, bank_exempt: 5 };
  lines.sort((a, b) => order[a.status] - order[b.status] || b.tdsDue - a.tdsDue || a.lender.localeCompare(b.lender));
  return { gate, lines };
}

export interface PaymentTdsInput {
  events: readonly InterestEvent[];
  settings: LoanTdsSettings;
  businessType: BusinessType | null | undefined;
  lender: string;
  lenderType?: LenderType | null;
  on: string;
  interest: number;
}

/**
 * What to tell the owner on a repayment being booked now (the TDS box of the Loan / EMI split),
 * once this interest is added to the lender's FY:
 *   due        — TDS `amount` (never more than this interest) to keep back;
 *   ask_type   — above the limit but the lender is not marked bank / non-bank yet;
 *   ask_audit  — above the limit, a proprietorship that has not answered the tax-audit question;
 *   none       — nothing (bank, below the limit, setting off, not required).
 */
export function paymentTdsAdvice(i: PaymentTdsInput): { status: "due" | "ask_type" | "ask_audit" | "none"; amount: number } {
  const interest = Math.max(0, Math.round(i.interest));
  if (interest <= 0) return { status: "none", amount: 0 };
  const fyStart = fyStartOf(i.on);
  const key = lenderKey(i.lender);
  const mine = i.events.filter((e) => lenderKey(e.lender) === key);
  const r = loanInterestTds({
    events: [...mine, { lender: i.lender, on: i.on, amount: interest, kind: "interest", tdsKept: 0, lenderType: i.lenderType ?? null }],
    settings: i.settings, businessType: i.businessType, fyStart,
  });
  const line = r.lines.find((l) => l.key === key);
  if (!line || r.gate.kind === "off" || r.gate.kind === "not_required") return { status: "none", amount: 0 };
  const amount = Math.min(line.tdsDue, interest);
  if (line.status === "ask_type") return { status: "ask_type", amount };
  if (line.status !== "due") return { status: "none", amount: 0 };
  return r.gate.kind === "ask_audit" ? { status: "ask_audit", amount } : { status: "due", amount };
}

/** The TDS to keep back on this repayment — 0 unless paymentTdsAdvice says "due". */
export function suggestTdsForPayment(i: PaymentTdsInput): number {
  const a = paymentTdsAdvice(i);
  return a.status === "due" ? a.amount : 0;
}
