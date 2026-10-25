/**
 * R-1842 — what a business type means, in one place.
 *
 * tenants.business_type (proprietor | partnership | llp | pvt_ltd) used to change only the
 * Compliance Calendar; every other screen assumed one kind of business. This module is the
 * single answer to "for this type, what are the people called, what is the capital called,
 * are there drawings, which ITR, which ROC filings" — later cards (BS equity R-1845, ITR pack
 * R-1844, onboarding R-1843) read it instead of hard-coding their own words.
 *
 * Null / unknown type = Pvt Ltd, exactly as obligationsFor() treats it today (the catalog's
 * original audience). One rule for the whole app (coordinator decision, 24 Oct 2026): every
 * reader resolves the type through resolveBusinessType() — R-1839's drawings words included.
 *
 * ROC filings and the calendar diff are DERIVED from obligationsFor(), never listed twice.
 * Pure — no I/O.
 */
import {
  BUSINESS_TYPE_LABEL, obligationsFor,
  type BusinessType, type GstFiling, type Obligation,
} from "./obligations";

export type ItrForm = "ITR-3" | "ITR-5" | "ITR-6";

export interface EntityProfile {
  type: BusinessType;
  label: string;
  /** Who runs / owns it: Owner · Partners · Designated partners · Directors. */
  peopleLabel: string;
  /** The capital line: Owner's capital · Partners' capital · Share capital. */
  capitalLabel: string;
  /** Balance Sheet equity section heading (R-1845). */
  equityTitle: string;
  /** What that section holds, in one line — the "What will change" row. */
  equityHeading: string;
  /** Money the owners take out. Null for a company — directors are paid, they do not draw. */
  drawingsLabel: string | null;
  itrForm: ItrForm;
  /** "ITR-3 on the owner's PAN", "ITR-5 for the firm", … */
  itrText: string;
  /** The Compliance Calendar row the ITR pack's "Mark as filed" writes (R-1844). */
  itrObligationKey: "it_itr6" | "it_itr_business";
  /** One line under the choice at sign-up (R-1843). */
  help: string;
  /** Short names of the ROC / MCA filings the calendar shows for this type. */
  rocFilings: string[];
}

interface Words {
  peopleLabel: string;
  capitalLabel: string;
  equityTitle: string;
  equityHeading: string;
  drawingsLabel: string | null;
  itrForm: ItrForm;
  itrText: string;
  help: string;
}

const WORDS: Record<BusinessType, Words> = {
  proprietor: {
    peopleLabel: "Owner", capitalLabel: "Owner's capital",
    equityTitle: "Proprietor's capital account", equityHeading: "Proprietor's capital account",
    drawingsLabel: "Owner drawings", itrForm: "ITR-3", itrText: "ITR-3 on the owner's PAN",
    help: "One owner, not registered as a firm or company — the business runs on the owner's PAN.",
  },
  partnership: {
    peopleLabel: "Partners", capitalLabel: "Partners' capital",
    equityTitle: "Partners' capital accounts", equityHeading: "Partners' capital accounts",
    drawingsLabel: "Partner drawings", itrForm: "ITR-5", itrText: "ITR-5 for the firm",
    help: "Two or more partners under a partnership deed; the firm has its own PAN.",
  },
  llp: {
    peopleLabel: "Designated partners", capitalLabel: "Partners' capital",
    equityTitle: "Partners' capital accounts", equityHeading: "Partners' capital accounts",
    drawingsLabel: "Partner withdrawal", itrForm: "ITR-5", itrText: "ITR-5 for the LLP",
    help: "Limited Liability Partnership registered with the MCA (it has an LLPIN).",
  },
  pvt_ltd: {
    peopleLabel: "Directors", capitalLabel: "Share capital",
    equityTitle: "Shareholders' funds", equityHeading: "Shareholders' funds: Share capital + Reserves and surplus",
    drawingsLabel: null, itrForm: "ITR-6", itrText: "ITR-6 for the company",
    help: "Private limited company registered with the MCA (it has a CIN and directors).",
  },
};

/** Null / undefined → Pvt Ltd, the calendar's meaning of "not set yet". */
export function resolveBusinessType(t: BusinessType | null | undefined): BusinessType {
  return t ?? "pvt_ltd";
}

/** The short name a filing goes by (its form, or the event for the AGM). */
function shortName(ob: Obligation, type: BusinessType): string {
  if (ob.key === "it_itr_business") return WORDS[type].itrForm;
  return ob.form ?? ob.name.replace(/^Hold the /, "");
}

/** The income-tax return rows — shown once, as the "Income-tax return" change, not in the calendar lists. */
const ITR_KEYS = new Set(["it_itr6", "it_itr_business"]);

function calendarNames(type: BusinessType, gstFiling: GstFiling | null): Map<string, string> {
  return new Map(obligationsFor({ businessType: type, gstFiling })
    .filter((ob) => !ITR_KEYS.has(ob.key))
    .map((ob) => [ob.key, shortName(ob, type)]));
}

export function entityProfile(t: BusinessType | null | undefined): EntityProfile {
  const type = resolveBusinessType(t);
  const rocFilings = obligationsFor({ businessType: type, gstFiling: null })
    .filter((ob) => ob.category === "roc")
    .map((ob) => shortName(ob, type));
  return {
    type, label: BUSINESS_TYPE_LABEL[type], ...WORDS[type],
    itrObligationKey: type === "pvt_ltd" ? "it_itr6" : "it_itr_business",
    rocFilings,
  };
}

/** The one-line hint under the Business type choice in Settings → Company. */
export function businessTypeHint(t: BusinessType | null | undefined): string {
  const p = entityProfile(t);
  return `${p.rocFilings.length ? p.rocFilings.join(", ") : "No ROC filings"}. ${p.itrText}.`;
}

export interface BusinessTypeChange {
  from: EntityProfile;
  to: EntityProfile;
  /** Compliance Calendar rows that will appear / disappear (short names). The ITR swap is in `rows`. */
  added: string[];
  removed: string[];
  /** Other things that read differently — only the ones that actually differ. */
  rows: { what: string; from: string; to: string }[];
}

/**
 * What changes when the stored type goes from `from` to `to`. Null when nothing changes
 * (same type, or not set → Pvt Ltd, since not set already means Pvt Ltd).
 */
export function businessTypeChange(
  from: BusinessType | null | undefined,
  to: BusinessType | null | undefined,
  gstFiling: GstFiling | null = null,
): BusinessTypeChange | null {
  const a = entityProfile(from);
  const b = entityProfile(to);
  if (a.type === b.type) return null;

  const before = calendarNames(a.type, gstFiling);
  const after = calendarNames(b.type, gstFiling);
  const beforeNames = new Set(before.values());
  const afterNames = new Set(after.values());
  const added = [...new Set([...after.values()].filter((n) => !beforeNames.has(n)))];
  const removed = [...new Set([...before.values()].filter((n) => !afterNames.has(n)))];

  const drawings = (p: EntityProfile) => p.drawingsLabel ?? "Not used — money to a director is salary, a loan or a reimbursement";
  const rows = [
    { what: "Income-tax return", from: a.itrText, to: b.itrText },
    { what: "People", from: a.peopleLabel, to: b.peopleLabel },
    { what: "Capital", from: a.capitalLabel, to: b.capitalLabel },
    { what: "Drawings", from: drawings(a), to: drawings(b) },
    { what: "Balance Sheet equity", from: a.equityHeading, to: b.equityHeading },
  ].filter((r) => r.from !== r.to);

  return { from: a, to: b, added, removed, rows };
}

/**
 * R-1843 — the four choices at sign-up, in this order, with their full names and one line of
 * help each. Nothing is pre-selected: skipping leaves the type empty (= Pvt Ltd until set).
 */
export const BUSINESS_TYPE_CHOICES: readonly { type: BusinessType; title: string; help: string }[] = (
  [
    ["proprietor", "Proprietorship"],
    ["partnership", "Partnership"],
    ["llp", "LLP"],
    ["pvt_ltd", "Private Limited"],
  ] as const
).map(([type, title]) => ({ type, title, help: WORDS[type].help }));
