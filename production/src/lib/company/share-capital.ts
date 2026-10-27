/**
 * R-1851 (epic R-1841, Phase 3 — Pvt Ltd) — share capital + shareholders register, as pure,
 * tested rules. Rows live in company_share_capital / company_shareholders (migration
 * 20261024205930_r1851_share_capital.sql); the database checks the same limits.
 *
 * One fact, one place: the number of paid-up shares is the shareholders' shares added up —
 * not typed a second time — so the holders' percentages always total 100 % of the paid-up
 * shares. Paid-up capital = paid-up shares × face value (shares are taken as fully paid;
 * partly-paid shares are not supported yet). It may not exceed the authorised capital
 * (Companies Act 2013 s.61 — raising it needs an ordinary resolution + SH-7 with the ROC).
 *
 * The Balance Sheet's "Share capital" reads paidUpCapital (lib/accounting/equity-section.ts).
 * Only a Pvt Ltd (the one resolver — an empty type is Pvt Ltd) has this register.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { panError } from "@/lib/accounting/partners";
import { isReservesLine } from "@/lib/accounting/equity-section";
import { num, rupee } from "@/lib/utils";

export interface ShareCapital {
  /** Whole rupees. */
  authorised_capital: number;
  /** Whole rupees per share (₹10, ₹1, ₹100 …). */
  face_value: number;
}

export interface Shareholder {
  id: string;
  name: string;
  pan: string | null;
  shares: number;
  allotted_on: string | null; // YYYY-MM-DD
}

export function showsShareCapital(type: BusinessType | null | undefined): boolean {
  return entityProfile(type).type === "pvt_ltd";
}

export interface ShareCapitalSummary {
  paidUpShares: number;
  paidUpCapital: number;
  /** Authorised − paid-up (can be negative only for data saved before a limit was lowered). */
  unissuedCapital: number;
  overAuthorised: boolean;
  holders: (Shareholder & { pct: number })[];
}

export function shareCapitalSummary(capital: ShareCapital | null, holders: readonly Shareholder[]): ShareCapitalSummary {
  const paidUpShares = holders.reduce((s, h) => s + Number(h.shares), 0);
  const fv = capital?.face_value ?? 0;
  const paidUpCapital = capital ? paidUpShares * fv : 0;
  const authorised = capital?.authorised_capital ?? 0;
  return {
    paidUpShares,
    paidUpCapital,
    unissuedCapital: authorised - paidUpCapital,
    overAuthorised: Boolean(capital) && paidUpCapital > authorised,
    holders: holders.map((h) => ({
      ...h,
      pct: paidUpShares ? Math.round((Number(h.shares) / paidUpShares) * 10000) / 100 : 0,
    })),
  };
}

const wholeRupees = (s: string) => s.trim().replace(/,/g, "");
const isWhole = (s: string) => /^\d+$/.test(s) && Number(s) > 0;

export interface CapitalFormInput { authorised_capital: string; face_value: string }
export interface CapitalFormErrors { authorised?: string; faceValue?: string }

/** `issuedShares` = the shareholders' shares today (the limit cannot drop below them). */
export function capitalFormErrors(input: CapitalFormInput, issuedShares: number): CapitalFormErrors {
  const e: CapitalFormErrors = {};
  const a = wholeRupees(input.authorised_capital);
  const f = wholeRupees(input.face_value);
  if (!isWhole(a)) e.authorised = "Enter the authorised capital in whole rupees, e.g. 1000000.";
  if (!isWhole(f)) e.faceValue = "Enter the face value of one share in whole rupees, e.g. 10.";
  if (!e.authorised && !e.faceValue && issuedShares * Number(f) > Number(a)) {
    e.authorised = `The shareholders already hold ${num(issuedShares)} shares × ${rupee(Number(f))} = ${rupee(issuedShares * Number(f))} — the authorised capital cannot be less.`;
  }
  return e;
}

export function normaliseCapitalInput(input: CapitalFormInput): ShareCapital {
  return { authorised_capital: Number(wholeRupees(input.authorised_capital)), face_value: Number(wholeRupees(input.face_value)) };
}

export interface ShareholderFormInput { name: string; pan: string; shares: string; allotted_on: string }
export interface ShareholderFormErrors { name?: string; pan?: string; shares?: string }

export function shareholderFormErrors(
  input: ShareholderFormInput,
  existing: readonly Shareholder[],
  editingId: string | null,
  capital: ShareCapital | null,
): ShareholderFormErrors {
  const e: ShareholderFormErrors = {};
  const others = existing.filter((h) => h.id !== editingId);
  const name = input.name.trim();
  if (!name) e.name = "Enter the shareholder's name.";
  else if (name.length > 200) e.name = "The name is too long (200 characters at most).";

  const pan = input.pan.trim().toUpperCase();
  const pe = panError(pan);
  if (pe) e.pan = pe;
  else if (pan && others.some((h) => (h.pan ?? "").toUpperCase() === pan)) e.pan = `PAN ${pan} is already used by another shareholder.`;

  const s = wholeRupees(input.shares);
  if (!capital) e.shares = "Set the authorised capital and face value first.";
  else if (!isWhole(s)) e.shares = "Enter the number of shares, a whole number above 0.";
  else {
    const total = others.reduce((t, h) => t + Number(h.shares), 0) + Number(s);
    const value = total * capital.face_value;
    if (value > capital.authorised_capital) {
      e.shares = `That makes ${num(total)} shares × ${rupee(capital.face_value)} = ${rupee(value)} — more than the authorised capital of ${rupee(capital.authorised_capital)}. Raise the authorised capital first.`;
    }
  }
  return e;
}

export function normaliseShareholderInput(input: ShareholderFormInput): Omit<Shareholder, "id"> {
  const nz = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    name: input.name.trim(),
    pan: nz(input.pan)?.toUpperCase() ?? null,
    shares: Number(wholeRupees(input.shares)),
    allotted_on: nz(input.allotted_on),
  };
}

/**
 * A company's hand-entered equity line that sits under Share capital on the Balance Sheet
 * (everything that is not a reserve — the same split as equity-section.ts). With the register
 * in use, such a line may be the same money counted twice.
 */
export function looksLikeShareCapitalLine(l: { label: string; notes: string | null }): boolean {
  return !isReservesLine(l);
}
