/**
 * Statutory-compliance catalog for an Indian business — written for a Private Limited
 * company, and since R-262 narrowed by business type (Proprietor / Partnership / LLP /
 * Pvt Ltd) and GST filing mode (monthly / QRMP): see obligationsFor().
 *
 * A curated, code-owned list of the recurring obligations a Pvt Ltd has to file
 * — ROC/MCA, Income-tax, TDS, GST, and PF/ESI — with the STANDARD due dates and
 * the next actionable instance computed from today. This is a reminder/tracker,
 * NOT tax advice: exact dates shift with government extensions and depend on the
 * company's turnover/audit status, so every date carries a "confirm with your CA"
 * caveat in the UI.
 *
 * Indian FY = 1 Apr → 31 Mar. All date maths runs in IST-agnostic calendar terms
 * (date-only), which is fine for due-date tracking.
 */

import { tdsDepositDueDate } from "./tds-due";
import type { TaxAuditResult } from "./tax-audit";
import { fyStartYear, fyLabelOfYear } from "@/lib/dates/ist";
import type { CompliancePerson } from "./people";

export type ComplianceCategory = "roc" | "income_tax" | "tds" | "gst" | "payroll";
export type ComplianceFreq = "monthly" | "quarterly" | "half_yearly" | "annual" | "every_3_years";

/**
 * R-262: who the business is, which decides what it files. Stored on
 * tenants.business_type / tenants.gst_filing (Settings → Company). Before those columns
 * exist, or while unset, both are null and the catalog behaves exactly as it always did:
 * a Pvt Ltd filing GST monthly.
 */
export type BusinessType = "proprietor" | "partnership" | "llp" | "pvt_ltd";
export type GstFiling = "monthly" | "qrmp";
export interface ComplianceProfile {
  businessType: BusinessType | null;
  gstFiling: GstFiling | null;
  /**
   * R-334: the seller has an LUT on file (tenants.lut_number set) — it exports without
   * paying IGST, so it must renew the LUT (Form GST RFD-11) before every FY. Optional:
   * omitted / false → no LUT reminder, and every other row is unchanged.
   */
  exportsUnderLut?: boolean;
  /**
   * R-1859: whether the tax audit applies for the FY of the next audit report (turnover +
   * cash share, lib/compliance/tax-audit.ts). Optional: omitted → rows as before.
   */
  taxAudit?: TaxAuditResult | null;
  /**
   * R-1857: directors (Pvt Ltd) and designated partners (LLP) from the registers — each gets
   * their own DIR-3 KYC row, a DSC-expiry row and a "details changed" row. Omitted / empty →
   * the one common DIR-3 KYC row, as before.
   */
  people?: readonly CompliancePerson[];
}
export const UNKNOWN_PROFILE: ComplianceProfile = { businessType: null, gstFiling: null };

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  proprietor: "Proprietor",
  partnership: "Partnership",
  llp: "LLP",
  pvt_ltd: "Pvt Ltd",
};
export const GST_FILING_LABEL: Record<GstFiling, string> = {
  monthly: "Monthly",
  qrmp: "QRMP (quarterly)",
};
const COMPANY_ONLY: readonly BusinessType[] = ["pvt_ltd"];

/** Narrow whatever the database returned to a known value, or null. */
export function toBusinessType(v: unknown): BusinessType | null {
  return v === "proprietor" || v === "partnership" || v === "llp" || v === "pvt_ltd" ? v : null;
}
export function toGstFiling(v: unknown): GstFiling | null {
  return v === "monthly" || v === "qrmp" ? v : null;
}

export interface ComplianceInstance {
  /** ISO due date of the next actionable instance. */
  dueDate: string;
  /** Stable key for this instance (obligation + period) — used for filed-log. */
  periodKey: string;
  /** Human label of the period, e.g. "FY 2025-26", "Jul 2026", "Q1 FY26-27". */
  periodLabel: string;
}

export interface Obligation {
  key: string;
  name: string;
  authority: string;
  category: ComplianceCategory;
  freq: ComplianceFreq;
  form?: string;
  penalty?: string;
  link?: string;
  /** Who it applies to — shown as a caveat (not every Pvt Ltd files every form). */
  applies?: string;
  /** In-app page that already holds the numbers for this return (e.g. GST Report). */
  dataHref?: { href: string; label: string };
  /** Step-by-step to actually file it (portal flow) — shown in a "How to file" guide. */
  filingSteps?: string[];
  /**
   * R-262: business types this applies to. Omitted = every business. A tenant whose
   * type is not set yet is treated as a Pvt Ltd (the catalog's original audience),
   * so nothing changes for it until the owner picks a type in Settings → Company.
   */
  entities?: readonly BusinessType[];
  /** R-262: only for this GST filing mode. Omitted = both. Not set yet = "monthly". */
  gstMode?: GstFiling;
  /** R-334: only for a seller exporting under an LUT (profile.exportsUnderLut). */
  lutOnly?: boolean;
  /**
   * R-1857: a row for one person (director / designated partner). Today shows it under its own
   * chip, and it links to the ROC calendar.
   */
  person?: { name: string; din: string };
  /**
   * R-1857: days ahead the row turns "due soon", enters Today and gets its first reminder mail
   * (a 30-day rung). Omitted → 15 / 7 days and the 15-7-3 ladder, as before.
   */
  remindDays?: number;
  /**
   * R-1857: the row is settled somewhere else, not by "Mark filed" (a DSC is settled by saving
   * the new expiry in the directors register) — the calendar shows this link as its button.
   */
  doneBy?: { href: string; label: string };
  /** R-1857: false → no row today (a DSC far away, a ceased director, an old settled change). */
  visible?: (today: Date, inst: ComplianceInstance, filed: boolean) => boolean;
  /**
   * Next actionable instance given today.
   *
   * `isFiled` lets the picker skip instances already filed, so the row advances
   * to the next real deadline the moment one is marked done. Optional so callers
   * that only want "what period is current" can omit it.
   */
  next: (today: Date, isFiled?: (periodKey: string) => boolean) => ComplianceInstance;
}

export const CATEGORY_META: Record<ComplianceCategory, { label: string; short: string; authority: string }> = {
  roc:        { label: "ROC / MCA",       short: "ROC",     authority: "Ministry of Corporate Affairs" },
  income_tax: { label: "Income Tax",      short: "IT",      authority: "Income Tax Dept" },
  tds:        { label: "TDS",             short: "TDS",     authority: "Income Tax Dept (TRACES)" },
  gst:        { label: "GST",             short: "GST",     authority: "GST Network" },
  payroll:    { label: "PF / ESI / PT",   short: "PF/ESI",  authority: "EPFO / ESIC / State" },
};

// ── Date helpers (date-only, no timezone drift) ────────────────────────────
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** midnight-normalised copy for comparisons */
const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** FY that a given date falls in → the starting calendar year (Apr–Mar). */
function fyStart(d: Date): number {
  // This module keeps dates as local-midnight Date objects (day0), so read the local calendar date.
  return fyStartYear(iso(d.getFullYear(), d.getMonth() + 1, d.getDate()));
}
const fyLabel = (startYear: number) => `FY ${fyLabelOfYear(startYear)}`;

/**
 * Pick the "actionable" instance: the earliest one still upcoming, OR — if the
 * most recent one passed less than 45 days ago and is NOT yet filed — that
 * recently-due one, so an overdue filing stays visible instead of the page
 * jumping ahead to next period.
 *
 * THE `isFiled` PREDICATE IS LOAD-BEARING. Without it this returned the same
 * instance whether or not it had been filed, and the consequence was severe:
 * file GSTR-3B for June on 20 July, and the page kept showing that filed June
 * row for the full 45 days — so the 20 August deadline for July was invisible
 * until roughly 3 September, two weeks after it had already gone late at ₹50/day.
 * A compliance page that hides the next deadline the moment you comply is worse
 * than no page, because the operator trusts it.
 */
function pick(
  today: Date,
  instances: ComplianceInstance[],
  isFiled?: (periodKey: string) => boolean,
): ComplianceInstance {
  const t = day0(today).getTime();
  const sorted = [...instances].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const done = (i: ComplianceInstance) => Boolean(isFiled?.(i.periodKey));

  // A recently-passed instance is only worth surfacing while it is still owed.
  const recentlyPassed = [...sorted].reverse().find((i) => {
    const diff = t - new Date(i.dueDate).getTime();
    return diff > 0 && diff <= 45 * 864e5 && !done(i);
  });
  if (recentlyPassed) return recentlyPassed;

  // Otherwise the soonest future instance that still needs filing. Falling back
  // to a filed upcoming one is right when EVERYTHING known is filed — the row
  // then reads "filed", which is the truth.
  const upcomingUnfiled = sorted.find((i) => new Date(i.dueDate).getTime() >= t && !done(i));
  const upcoming = sorted.find((i) => new Date(i.dueDate).getTime() >= t);
  return upcomingUnfiled ?? upcoming ?? sorted[sorted.length - 1];
}

/**
 * Annual obligation due on a fixed month/day.
 *
 * THE PERIOD IS THE FY THAT ENDED BEFORE THE DUE DATE, not the FY the due date
 * falls in. This was wrong and it mislabelled every annual filing by a full year:
 * AOC-4 due 29 Oct 2026 was shown as "FY 2026-27" when it is the return for
 * FY 2025-26 — the year ended 31 Mar 2026, whose accounts the September AGM
 * adopted. Same for MGT-7A, DIR-3 KYC, DPT-3, ADT-1, ITR-6, 3CD and GSTR-9: all
 * of them are filed in the year AFTER the one they report on.
 *
 * The label is not cosmetic. It is what the operator reads before attaching
 * financials and what `periodKey` records against in the filed-log, so being a
 * year out means either filing the wrong year's numbers or believing a year is
 * done when it is not — against a ₹100/day penalty with no cap.
 *
 * WORTH HAVING A CA CONFIRM. These are statutory semantics, not arithmetic. The
 * rule applied here — "an annual return filed in year Y reports on the FY ending
 * 31 Mar of year Y" — holds for every obligation in this catalog, but the UI's
 * "confirm with your CA" caveat matters most on exactly this point.
 */
function annualNext(month: number, dayNum: number, periodIsFy = true): Obligation["next"] {
  return (t, isFiled) => {
    const cands: ComplianceInstance[] = [-1, 0, 1].map((off) => {
      const y = t.getFullYear() + off;
      // FY the due date sits in, minus one → the FY being reported on.
      const reportedFy = fyStart(new Date(y, month - 1, dayNum)) - 1;
      return {
        dueDate: iso(y, month, dayNum),
        periodKey: periodIsFy ? `fy${reportedFy}` : `${y - 1}`,
        periodLabel: periodIsFy ? fyLabel(reportedFy) : String(y - 1),
      };
    });
    return pick(t, cands, isFiled);
  };
}

// Monthly obligation due on `dayNum` of every month (e.g. PF/ESI 15th, GST 20th).
// Each instance's PERIOD is the previous month (what you're filing FOR).
function monthlyNext(dayNum: number): Obligation["next"] {
  return (t, isFiled) => {
    const cands: ComplianceInstance[] = [];
    for (let off = -2; off <= 2; off++) {
      const base = new Date(t.getFullYear(), t.getMonth() + off, dayNum);
      const forMonth = new Date(base.getFullYear(), base.getMonth() - 1, 1); // period = prev month
      cands.push({
        dueDate: iso(base.getFullYear(), base.getMonth() + 1, dayNum),
        periodKey: `${forMonth.getFullYear()}-${String(forMonth.getMonth() + 1).padStart(2, "0")}`,
        periodLabel: `${MONTHS[forMonth.getMonth()]} ${forMonth.getFullYear()}`,
      });
    }
    return pick(t, cands, isFiled);
  };
}

/**
 * R-1583 — "Deposit TDS deducted": the period is the month the TDS was deducted in and its
 * due date comes from tdsDepositDueDate (7th of the next month; March → 30 April). Was
 * monthlyNext(7), which made March due 7 April and showed it "overdue" 8–30 April.
 */
function tdsDepositNext(): Obligation["next"] {
  return (t, isFiled) => {
    const cands: ComplianceInstance[] = [];
    for (let off = -3; off <= 1; off++) {
      const p = new Date(t.getFullYear(), t.getMonth() + off, 1);
      const periodKey = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`;
      cands.push({ dueDate: tdsDepositDueDate(periodKey), periodKey, periodLabel: `${MONTHS[p.getMonth()]} ${p.getFullYear()}` });
    }
    return pick(t, cands, isFiled);
  };
}

/**
 * R-1856 — DIR-3 KYC Web: once every third consecutive FY, by 30 June.
 *
 * G.S.R. 943(E) — Companies (Appointment and Qualification of Directors) Amendment Rules, 2025,
 * dated 31 Dec 2025, in force 31 Mar 2026 — substituted Rule 12A: "Every individual who holds a
 * Director Identification Number as on the 31st March of a financial year … shall file KYC
 * intimation in Form No. DIR-3 KYC Web … on or before the 30th June of the immediately following
 * every third consecutive financial year." The MCA press release (1 Jan 2026) says directors whose
 * KYC is up to date are next due by 30 June 2028. Sources: ICAI CLCGC 02-01-2026
 * https://www.icai.org/post/clcgc-director-kyc-compliance-02012026 ; gazette text as reproduced at
 * https://taxguru.in/?p=1014465 ; MCA notification
 * https://www.mca.gov.in/bin/dms/getdocument?mds=Vk%252FT5sIBKBare6St1b%252FznQ%253D%253D&type=open
 * (MCA's server refused a direct fetch on 24 Oct 2026 — confirm with a CA/CS).
 *
 * The cycle is per director: one who got a DIN recently or missed the last KYC can be due on a
 * different 30 June. R-1857: once the directors register (or, for an LLP, the partners register)
 * has someone in it, personObligations() below replaces this row with one row per person; with
 * an empty register this row shows the common cycle (2028, 2031, …).
 */
const DIR3_KYC_FIRST_CYCLE_YEAR = 2028;
function dir3KycNext(): Obligation["next"] {
  return (t, isFiled) => {
    const y = t.getFullYear();
    // The first cycle year on or after this year, then one cycle either side.
    const ahead = Math.max(0, Math.ceil((y - DIR3_KYC_FIRST_CYCLE_YEAR) / 3));
    const c = DIR3_KYC_FIRST_CYCLE_YEAR + 3 * ahead;
    const cands = [c - 3, c, c + 3]
      .filter((yr) => yr >= DIR3_KYC_FIRST_CYCLE_YEAR)
      .map((yr) => ({
        dueDate: iso(yr, 6, 30),
        periodKey: `kyc${yr}`,
        periodLabel: `3-year KYC due ${yr}`,
      }));
    return pick(t, cands, isFiled);
  };
}

// ── R-1857: one row per person (directors / LLP designated partners) ───────────────────────
/*
 * Source: Rule 12A as substituted by G.S.R. 943(E) (31 Dec 2025, in force 31 Mar 2026) — see
 * dir3KycNext above. 12A(1): every DIN holder files DIR-3 KYC Web by 30 June once every third
 * consecutive FY. 12A(2): "in the event of change in his personal mobile number, email address or
 * residential address" → DIR-3 KYC Web within 30 days of the change. Per person we read
 * "last KYC year + 3 → 30 June" (R-1850's reading; CA/CS confirm step on R-1856 / R-1857).
 * DSC: every ROC form is signed with a director's DSC, so an expired one blocks filing — the
 * register's expiry date is reminded 30 days ahead.
 */
const DAY_MS = 864e5;
const isoOf = (d: Date) => iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
const daysFrom = (today: Date, dateIso: string) => {
  const [y, m, d] = dateIso.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - day0(today).getTime()) / DAY_MS);
};
const addDays = (dateIso: string, n: number) => {
  const [y, m, d] = dateIso.split("-").map(Number);
  return isoOf(new Date(y, m - 1, d + n));
};
const longDate = (dateIso: string) => {
  const [y, m, d] = dateIso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** Days before a DSC expiry / a details-change deadline that the person's row starts. */
export const PERSON_REMIND_DAYS = 30;
/** Rule 12A(2): days to file DIR-3 KYC Web after a personal mobile / email / address change. */
export const KYC_DETAILS_CHANGE_DAYS = 30;

/**
 * One person's next DIR-3 KYC date: last KYC year + 3 → 30 June; no year recorded → the common
 * cycle (the calendar's own DIR-3 KYC row for this day). The one copy of the per-person rule —
 * the directors register (lib/company/directors.ts kycDue) reads it from here.
 */
export function personKycDueDate(lastKycYear: number | null | undefined, today: Date): string {
  if (lastKycYear) return iso(lastKycYear + 3, 6, 30);
  return dir3KycNext()(today).dueDate;
}

const isActiveOn = (p: CompliancePerson, today: Date) => !p.ceasedOn || isoOf(today) <= p.ceasedOn;

function personKycObligation(p: CompliancePerson, base: Obligation): Obligation {
  const idLabel = p.role === "director" ? "DIN" : "DPIN";
  const reading = p.lastKycYear
    ? `Last DIR-3 KYC in ${p.lastKycYear} — due again 3 years later, by 30 June.`
    : `No last KYC year in the ${p.role === "director" ? "directors" : "partners"} register — showing the common cycle (30 June 2028 for KYC that is up to date). Add the year to be exact.`;
  return {
    ...base,
    key: `roc_dir3kyc:${p.din}`,
    name: `DIR-3 KYC — ${p.name} (${idLabel} ${p.din})`,
    person: { name: p.name, din: p.din },
    applies: `${reading} Changed mobile, email or address? Update it on DIR-3 KYC Web within 30 days.`,
    visible: (t) => isActiveOn(p, t),
    next: (t, isFiled) => {
      const first = Number(personKycDueDate(p.lastKycYear, t).slice(0, 4));
      // Never skip an overdue KYC to a later cycle: the first unfiled one is the one owed.
      const cands = [first, first + 3, first + 6].map((yr) => ({
        dueDate: iso(yr, 6, 30), periodKey: `kyc${yr}`, periodLabel: `3-year KYC due ${yr}`,
      }));
      return cands.find((c) => !isFiled?.(c.periodKey)) ?? cands[cands.length - 1];
    },
  };
}

function personDscObligation(p: CompliancePerson & { dscExpiry: string }): Obligation {
  const expiry = p.dscExpiry;
  return {
    key: `roc_dsc:${p.din}`,
    name: `Renew DSC — ${p.name} (DIN ${p.din})`,
    authority: "Certifying Authority",
    category: "roc", freq: "annual", form: "DSC",
    person: { name: p.name, din: p.din },
    remindDays: PERSON_REMIND_DAYS,
    penalty: "No ROC form (AOC-4, MGT-7, DIR-3 KYC…) can be signed without a valid DSC",
    applies: `Renew ${p.name}'s Digital Signature Certificate before it expires, then save the new expiry date in Settings → Company → Directors.`,
    doneBy: { href: "/settings/company", label: "Update DSC expiry" },
    filingSteps: [
      "Apply for a new Class 3 DSC (individual) with a licensed Certifying Authority — PAN, Aadhaar and a video / OTP check.",
      "On MCA V3, register the new DSC against the DIN (My Workspace → Associate DSC).",
      "Settings → Company → Directors → edit the director → save the new DSC expiry date. This row then goes away.",
    ],
    visible: (t, inst, filed) => isActiveOn(p, t)
      && daysFrom(t, inst.dueDate) <= PERSON_REMIND_DAYS
      && !(filed && daysFrom(t, inst.dueDate) < 0),
    next: () => ({ dueDate: expiry, periodKey: `dsc${expiry}`, periodLabel: "Certificate expiry" }),
  };
}

function personDetailsChangeObligation(p: CompliancePerson & { detailsChangedOn: string }): Obligation {
  const changed = p.detailsChangedOn;
  const due = addDays(changed, KYC_DETAILS_CHANGE_DAYS);
  return {
    key: `roc_dir3kyc_update:${p.din}`,
    name: `DIR-3 KYC Web — update ${p.name}'s details`,
    authority: "MCA / ROC",
    category: "roc", freq: "annual", form: "DIR-3 KYC Web",
    person: { name: p.name, din: p.din },
    remindDays: PERSON_REMIND_DAYS,
    penalty: "Fee for late filing; the DIN can be deactivated until it is filed",
    link: "https://www.mca.gov.in",
    applies: `${p.name}'s mobile or email changed in the directors register. If it is the personal mobile / email (or address) registered with MCA, file DIR-3 KYC Web within 30 days (Rule 12A(2)). Not an MCA detail? Mark filed with a note.`,
    filingSteps: [
      "Log in to MCA V3 (mca.gov.in) → DIR-3 KYC Web.",
      "Enter the DIN, verify the NEW personal mobile + email by OTP, and confirm the address.",
      "Submit → note the SRN.",
      "Mark filed here (SRN in Reference).",
    ],
    visible: (t, inst, filed) => isActiveOn(p, t) && !(filed && daysFrom(t, inst.dueDate) < -30),
    next: () => ({ dueDate: due, periodKey: `chg${changed}`, periodLabel: `Changed ${longDate(changed)}` }),
  };
}

/**
 * The person rows for this business: directors for a Pvt Ltd (or a type not set yet), DPIN-holding
 * designated partners for an LLP, nobody for a proprietor / partnership. Returns [] when nobody
 * fits — the caller then keeps the common DIR-3 KYC row.
 */
export function personObligations(
  people: readonly CompliancePerson[] | undefined,
  businessType: BusinessType | null,
  kycBase: Obligation,
): Obligation[] {
  const type = businessType ?? "pvt_ltd";
  const role = type === "pvt_ltd" ? "director" : type === "llp" ? "designated_partner" : null;
  if (!role || !people?.length) return [];
  const mine = people.filter((p) => p.role === role);
  return mine.flatMap((p) => [
    personKycObligation(p, kycBase),
    ...(p.dscExpiry ? [personDscObligation({ ...p, dscExpiry: p.dscExpiry })] : []),
    ...(p.detailsChangedOn ? [personDetailsChangeObligation({ ...p, detailsChangedOn: p.detailsChangedOn })] : []),
  ]);
}

// Fixed set of dated instances per FY (advance tax, quarterly TDS returns).
function fixedNext(build: (fyStartYear: number) => ComplianceInstance[]): Obligation["next"] {
  return (t, isFiled) => {
    const s = fyStart(t);
    const all = [s - 1, s, s + 1].flatMap(build);
    return pick(t, all, isFiled);
  };
}

// ── The catalog ─────────────────────────────────────────────────────────────
export const OBLIGATIONS: Obligation[] = [
  // ROC / MCA (annual)
  {
    key: "roc_aoc4", name: "AOC-4 — file financial statements", authority: "MCA / ROC",
    entities: COMPANY_ONLY,
    category: "roc", freq: "annual", form: "AOC-4",
    penalty: "₹100/day of delay, no cap", link: "https://www.mca.gov.in",
    applies: "Every Pvt Ltd — within 30 days of the AGM (AGM by 30 Sep → due ~29 Oct).",
    dataHref: { href: "/accounting/balance-sheet", label: "Open Balance Sheet (for the financials)" },
    filingSteps: [
      "Get the audited financials — Balance Sheet, P&L, notes — signed by your auditor + two directors.",
      "Hold the AGM and adopt the accounts (AOC-4 is filed AFTER the AGM).",
      "Log in to MCA V3 (mca.gov.in) → MCA Services → Company e-Filing → AOC-4 (AOC-4 XBRL only if applicable).",
      "Fill company + financial details; attach audited financials, Board's report and auditor's report.",
      "Pay the government fee (based on your authorised capital).",
      "Affix DSC of a director + a practising professional (CA/CS/CMA) → submit → note the SRN.",
      "Come back here → Mark filed (SRN in Reference).",
    ],
    next: annualNext(10, 29),
  },
  {
    key: "roc_mgt7", name: "MGT-7 / MGT-7A — annual return", authority: "MCA / ROC",
    entities: COMPANY_ONLY,
    category: "roc", freq: "annual", form: "MGT-7A",
    penalty: "₹100/day of delay, no cap", link: "https://www.mca.gov.in",
    applies: "Every Pvt Ltd — within 60 days of the AGM (due ~28 Nov).",
    filingSteps: [
      "After the AGM, prepare the annual return: shareholders, directors/KMP, shareholding pattern, meetings held during the year.",
      "Log in to MCA V3 → Company e-Filing → MGT-7A (small company / OPC) or MGT-7.",
      "Fill capital structure, shareholding, list of directors + changes, and meeting details.",
      "Attach the list of shareholders and any required documents.",
      "Pay the fee → affix DSC of a director (and a CS for MGT-7) → submit → note the SRN.",
      "Mark filed here (SRN in Reference).",
    ],
    next: annualNext(11, 28),
  },
  {
    key: "roc_dir3kyc", name: "DIR-3 KYC — director KYC", authority: "MCA / ROC",
    entities: ["pvt_ltd", "llp"],
    category: "roc", freq: "every_3_years", form: "DIR-3 KYC Web",
    penalty: "₹5,000 per director if late; the DIN is deactivated until filed", link: "https://www.mca.gov.in",
    applies:
      "Every director with a DIN — due once every 3 years by 30 June (next 30 Jun 2028 for directors whose KYC is up to date). " +
      "A new DIN or a missed KYC can make it due sooner — check each director's last KYC year. " +
      "Changed mobile, email or address? Update it on DIR-3 KYC Web within 30 days.",
    filingSteps: [
      "Keep each director's PAN, Aadhaar, personal mobile and personal email ready (they're OTP-verified).",
      "Log in to MCA V3 (mca.gov.in) and open DIR-3 KYC Web — since 31 Mar 2026 the only director KYC form.",
      "Enter the DIN, verify the mobile + email via OTP, and confirm the address.",
      "Submit → note the SRN. Repeat for EVERY director holding a DIN.",
      "Mark filed here.",
    ],
    next: dir3KycNext(),
  },
  {
    key: "roc_dpt3", name: "DPT-3 — return of deposits", authority: "MCA / ROC",
    entities: COMPANY_ONLY,
    category: "roc", freq: "annual", form: "DPT-3",
    penalty: "Company + officers penalty", link: "https://www.mca.gov.in",
    applies: "Companies with loans/advances outstanding — by 30 Jun for the prior FY.",
    dataHref: { href: "/accounting/balance-sheet", label: "Open Balance Sheet (loans / advances)" },
    filingSteps: [
      "List every loan/advance/deposit outstanding as on 31 Mar — including director & related-party loans (check your Balance Sheet).",
      "Get the auditor's certificate on the figures if required.",
      "MCA V3 → Company e-Filing → DPT-3.",
      "Fill 'money received not considered as deposits' + deposits (if any).",
      "Pay the fee → DSC of a director + practising professional → submit → note the SRN.",
      "Mark filed here.",
    ],
    next: annualNext(6, 30),
  },
  {
    key: "roc_adt1", name: "ADT-1 — auditor appointment", authority: "MCA / ROC",
    entities: COMPANY_ONLY,
    category: "roc", freq: "annual", form: "ADT-1",
    penalty: "₹100/day of delay", link: "https://www.mca.gov.in",
    applies: "Only in a year an auditor is appointed/re-appointed at AGM (within 15 days).",
    filingSteps: [
      "The Board/AGM appoints or re-appoints the auditor; get the auditor's written consent + eligibility certificate (Sec 139/141).",
      "MCA V3 → Company e-Filing → ADT-1, within 15 days of the AGM.",
      "Attach the board/AGM resolution + the auditor's consent letter.",
      "Pay the fee → affix a director's DSC → submit → note the SRN.",
      "Mark filed here.",
    ],
    next: annualNext(10, 14),
  },
  {
    key: "roc_agm", name: "Hold the AGM", authority: "Companies Act",
    entities: COMPANY_ONLY,
    category: "roc", freq: "annual",
    penalty: "Up to ₹1,00,000 + ₹5,000/day", link: "https://www.mca.gov.in",
    applies: "Within 6 months of FY-end — by 30 Sep.",
    filingSteps: [
      "Board approves the audited accounts and fixes the AGM date, time and venue (physical or video).",
      "Send the AGM notice with agenda to all members, directors and the auditor — at least 21 clear days in advance.",
      "Hold the AGM by 30 Sep: adopt the accounts, appoint/ratify the auditor, declare dividend (if any).",
      "Record the minutes + attendance register — these back your AOC-4 and MGT-7 filings.",
      "Mark done here once the AGM is held (this is an event, not a portal filing).",
    ],
    next: annualNext(9, 30),
  },

  // Income tax
  {
    key: "it_itr6", name: "Company ITR (ITR-6)", authority: "Income Tax",
    entities: COMPANY_ONLY,
    category: "income_tax", freq: "annual", form: "ITR-6",
    penalty: "₹5,000 late fee + interest u/s 234A", link: "https://www.incometax.gov.in",
    applies: "Audit case: by 31 Oct. Non-audit: by 31 Jul.",
    dataHref: { href: "/accounting/itr", label: "Open the ITR pack (computation + CA export)" },
    filingSteps: [
      "Finalise the audited accounts; get the tax-audit report accepted first (if applicable).",
      "Compute total income — disallowances, depreciation as per IT Act, MAT if it applies.",
      "incometax.gov.in → Login with the company PAN → e-File → Income Tax Return → pick the AY + ITR-6.",
      "Import the JSON from your CA/tax software; reconcile with Form 26AS + AIS.",
      "Pay any self-assessment tax via challan → attach → submit.",
      "e-Verify with a director's DSC (mandatory for companies) → note the acknowledgement number.",
      "Mark filed here.",
    ],
    next: annualNext(10, 31),
  },
  {
    key: "it_taxaudit", name: "Tax audit report (3CA/3CD)", authority: "Income Tax",
    category: "income_tax", freq: "annual", form: "3CD",
    penalty: "0.5% of turnover (max ₹1.5L)", link: "https://www.incometax.gov.in",
    applies: "If turnover > ₹1 cr (or ₹10 cr if ≤5% cash) — by 30 Sep.",
    dataHref: { href: "/accounting/pnl", label: "Open P&L (share with your CA)" },
    filingSteps: [
      "A practising CA conducts the audit and prepares Form 3CA-3CD from your books.",
      "The CA uploads the report on incometax.gov.in from their own login.",
      "You (company) log in → Pending Actions → Worklist → ACCEPT the uploaded audit report with a director's DSC.",
      "This must be done BEFORE filing the ITR.",
      "Mark filed here once accepted.",
    ],
    next: annualNext(9, 30),
  },
  {
    key: "it_advance_tax", name: "Advance tax instalment", authority: "Income Tax",
    category: "income_tax", freq: "quarterly",
    penalty: "Interest u/s 234B / 234C", link: "https://www.incometax.gov.in",
    applies: "If tax liability ≥ ₹10,000/yr. Due 15 Jun (15%), 15 Sep (45%), 15 Dec (75%), 15 Mar (100%).",
    dataHref: { href: "/accounting/itr", label: "Open the ITR pack (instalment schedule)" },
    filingSteps: [
      "Estimate the year's total income + tax liability (include MAT).",
      "Work out this instalment's cumulative % (15 / 45 / 75 / 100) minus what you've already paid.",
      "incometax.gov.in → e-Pay Tax → Income Tax → pick the AY → type 'Advance Tax (100)'.",
      "Enter the amount → pay via net-banking / UPI → save the challan (BSR code + serial + date).",
      "Mark filed here (challan number in Reference).",
    ],
    next: fixedNext((s) => [
      { dueDate: iso(s, 6, 15),  periodKey: `${s}-q1`, periodLabel: `15% · ${fyLabel(s)}` },
      { dueDate: iso(s, 9, 15),  periodKey: `${s}-q2`, periodLabel: `45% · ${fyLabel(s)}` },
      { dueDate: iso(s, 12, 15), periodKey: `${s}-q3`, periodLabel: `75% · ${fyLabel(s)}` },
      { dueDate: iso(s + 1, 3, 15), periodKey: `${s}-q4`, periodLabel: `100% · ${fyLabel(s)}` },
    ]),
  },

  // TDS
  {
    key: "tds_payment", name: "Deposit TDS deducted", authority: "Income Tax (TRACES)",
    category: "tds", freq: "monthly",
    penalty: "1.5%/month interest", link: "https://www.tin-nsdl.com",
    applies: "By the 7th of the next month (Mar TDS → 30 Apr).",
    filingSteps: [
      "Total the TDS you deducted in the month — salary (sec 192) + non-salary (194C/J/I/H etc.).",
      "incometax.gov.in → e-Pay Tax → select TDS/TCS (challan 281) with the correct section codes.",
      "Pay by the 7th (March TDS by 30 April) → SAVE the challan (BSR code + serial + date) — you need it for the quarterly return.",
      "Mark filed here (challan number in Reference).",
    ],
    next: tdsDepositNext(),
  },
  {
    key: "tds_return", name: "TDS return (24Q / 26Q)", authority: "Income Tax (TRACES)",
    category: "tds", freq: "quarterly", form: "26Q",
    penalty: "₹200/day (max = TDS amount)", link: "https://www.tin-nsdl.com",
    applies: "Q1 31 Jul · Q2 31 Oct · Q3 31 Jan · Q4 31 May.",
    dataHref: { href: "/accounting/salary-register", label: "Salary Register — 24Q working export" },
    filingSteps: [
      "Collect deductee details: PAN, amount paid, TDS, section — plus each challan's BSR code, serial and date.",
      "In ResellerOS: Salary Register → '24Q working' (salary TDS); Expenses → '26Q (TDS)' (non-salary). Export both.",
      "Open the NSDL RPU (or TDS software like ClearTDS) → import the workings + challan details.",
      "Run the FVU validation utility → it produces the .fvu file.",
      "Upload the .fvu on the TRACES / e-filing portal → verify with DSC or EVC → note the token number.",
      "Mark filed here. (The app prepares the data; it can't generate the FVU itself.)",
    ],
    next: fixedNext((s) => [
      { dueDate: iso(s, 7, 31),     periodKey: `${s}-q1`, periodLabel: `Q1 ${fyLabel(s)}` },
      { dueDate: iso(s, 10, 31),    periodKey: `${s}-q2`, periodLabel: `Q2 ${fyLabel(s)}` },
      { dueDate: iso(s + 1, 1, 31), periodKey: `${s}-q3`, periodLabel: `Q3 ${fyLabel(s)}` },
      { dueDate: iso(s + 1, 5, 31), periodKey: `${s}-q4`, periodLabel: `Q4 ${fyLabel(s)}` },
    ]),
  },

  // GST (the app also has a full GST report — this is the filing reminder)
  {
    key: "gst_gstr1", name: "GSTR-1 — outward supplies", authority: "GST",
    category: "gst", freq: "monthly", form: "GSTR-1",
    penalty: "₹50/day (₹20 nil)", link: "https://www.gst.gov.in/",
    applies: "Monthly filers — by the 11th of the next month.",
    dataHref: { href: "/accounting/gst", label: "Open GST Report — Output GST (sales) + CSV" },
    filingSteps: [
      "In ResellerOS, open GST Report → set this return's month → note Output GST (sales) and download the Output CSV.",
      "Go to gst.gov.in → Login → Returns Dashboard → pick the period → GSTR-1.",
      "Prepare online, or use the GST Offline Tool with the CSV, and enter/upload your B2B + B2C sales.",
      "These must match your issued invoices + the ResellerOS Output figure — reconcile any difference first.",
      "Generate summary → verify totals → Submit → file with DSC or EVC (OTP).",
      "Copy the ARN and come back here → Mark filed (paste the ARN in Reference).",
    ],
    next: monthlyNext(11),
  },
  {
    key: "gst_gstr3b", name: "GSTR-3B — summary + tax", authority: "GST",
    category: "gst", freq: "monthly", form: "GSTR-3B",
    penalty: "₹50/day + 18% interest", link: "https://www.gst.gov.in/",
    applies: "Monthly filers — by the 20th of the next month.",
    dataHref: { href: "/accounting/gst", label: "Open GST Report — net GST payable (output − input)" },
    filingSteps: [
      "File GSTR-1 for the month first (outward supplies feed 3B).",
      "In ResellerOS, open GST Report → note Output GST (sales) and Input GST (ITC) for the month.",
      "Go to gst.gov.in → Returns Dashboard → period → GSTR-3B → Prepare online.",
      "Enter outward supplies + eligible ITC → the portal computes net tax payable.",
      "Pay any balance via challan (net-banking / NEFT) → offset the liability.",
      "Submit → file with DSC/EVC → copy the ARN → Mark filed here with the ARN.",
    ],
    next: monthlyNext(20),
  },
  {
    key: "gst_gstr9", name: "GSTR-9 — annual return", authority: "GST",
    category: "gst", freq: "annual", form: "GSTR-9",
    penalty: "₹200/day (max % of turnover)", link: "https://www.gst.gov.in/",
    applies: "Turnover > ₹2 cr — by 31 Dec for the prior FY.",
    dataHref: { href: "/accounting/gst", label: "Open GST Report for the year's figures" },
    filingSteps: [
      "File all 12 GSTR-1 and GSTR-3B for the year first, then reconcile them with your books.",
      "gst.gov.in → Returns → Annual Return → GSTR-9 for the FY.",
      "Most tables auto-populate from your 1/3B; fill the remaining (HSN summary, ITC break-up).",
      "Reconcile GSTR-9 vs books vs GSTR-2B; prepare GSTR-9C too if turnover > ₹5 cr.",
      "Pay any extra liability via DRC-03.",
      "File with DSC/EVC → note the ARN → Mark filed here.",
    ],
    next: annualNext(12, 31),
  },

  // PF / ESI / PT
  {
    key: "pf_ecr", name: "PF payment + ECR", authority: "EPFO",
    category: "payroll", freq: "monthly",
    penalty: "Damages 5–25% + interest", link: "https://www.epfindia.gov.in",
    applies: "By the 15th of the next month.",
    dataHref: { href: "/accounting/salary-register", label: "Salary Register — wages + PF for the month" },
    filingSteps: [
      "Prepare the ECR (Electronic Challan cum Return): each member's wages + EPF/EPS/EDLI split.",
      "epfindia.gov.in → Unified Employer Portal → Payments → ECR Upload.",
      "Upload the ECR text file → verify → generate the challan (TRRN).",
      "Pay via net-banking by the 15th → save the challan.",
      "Mark filed here.",
    ],
    next: monthlyNext(15),
  },
  {
    key: "esi_payment", name: "ESI contribution", authority: "ESIC",
    category: "payroll", freq: "monthly",
    penalty: "12% p.a. interest", link: "https://www.esic.gov.in",
    applies: "By the 15th of the next month (if ≥10 employees).",
    dataHref: { href: "/accounting/salary-register", label: "Salary Register — wages for the month" },
    filingSteps: [
      "Work out the monthly contribution: employee 0.75% + employer 3.25% of wages (for employees ≤ ₹21,000/month).",
      "esic.gov.in → Employer login → File Monthly Contribution → enter/upload the wages.",
      "Generate the challan → pay by the 15th → save it.",
      "Mark filed here.",
    ],
    next: monthlyNext(15),
  },
  {
    key: "pt_payment", name: "Professional Tax", authority: "State",
    category: "payroll", freq: "monthly",
    penalty: "State-specific interest/penalty", link: "https://www.mahagst.gov.in",
    applies: "State rules (Maharashtra: monthly if PT > ₹1L/yr, else annual). Confirm your state.",
    filingSteps: [
      "Compute PT deducted from each salary per your state's slab (PT is a state tax — rules differ).",
      "Log in to your state PT portal (Maharashtra: mahagst.gov.in → PTRC).",
      "Enter the number of employees + total PT deducted → generate the challan → pay.",
      "File the PTRC return at your state's frequency (monthly/annual) → note the acknowledgement.",
      "Mark filed here.",
    ],
    next: monthlyNext(21),
  },
];

// ── R-262: business type + GST filing mode ──────────────────────────────────
/*
 * The catalog above was written for a Pvt Ltd filing GST monthly, and it told a
 * proprietor to file AOC-4 and MGT-7 (₹100/day penalties he can never owe) and a QRMP
 * filer that GSTR-1 was due on the 11th every month. The entries below are what those
 * other businesses file instead. They are NOT in OBLIGATIONS, so a tenant whose profile
 * is not set (or whose database has no columns for it yet) sees exactly today's list.
 */

/** GST quarters: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. The return falls due in the month after. */
function gstQuarterNext(dayNum: number): Obligation["next"] {
  return fixedNext((s) => [
    { dueDate: iso(s, 7, dayNum),     periodKey: `${s}-q1`, periodLabel: `Q1 (Apr–Jun) ${fyLabel(s)}` },
    { dueDate: iso(s, 10, dayNum),    periodKey: `${s}-q2`, periodLabel: `Q2 (Jul–Sep) ${fyLabel(s)}` },
    { dueDate: iso(s + 1, 1, dayNum), periodKey: `${s}-q3`, periodLabel: `Q3 (Oct–Dec) ${fyLabel(s)}` },
    { dueDate: iso(s + 1, 4, dayNum), periodKey: `${s}-q4`, periodLabel: `Q4 (Jan–Mar) ${fyLabel(s)}` },
  ]);
}

/** PMT-06: tax for the first two months of each quarter, by the 25th of the next month. */
function pmt06Next(): Obligation["next"] {
  return fixedNext((s) => {
    const firstTwo: [number, number][] = [[s, 4], [s, 5], [s, 7], [s, 8], [s, 10], [s, 11], [s + 1, 1], [s + 1, 2]];
    return firstTwo.map(([y, m]) => {
      const due = new Date(y, m, 25); // month m (1-based) + 1 → JS month index m
      return {
        dueDate: iso(due.getFullYear(), due.getMonth() + 1, 25),
        periodKey: `${y}-${String(m).padStart(2, "0")}`,
        periodLabel: `${MONTHS[m - 1]} ${y}`,
      };
    });
  });
}

/**
 * R-334: LUT renewal. An LUT (Form GST RFD-11) is valid for one financial year and has to
 * be furnished before the year starts, so the due date is 31 March and the PERIOD is the FY
 * that begins the next day — unlike annualNext(), which labels the FY just ended.
 */
function lutRenewNext(): Obligation["next"] {
  return (t, isFiled) => {
    const cands: ComplianceInstance[] = [-1, 0, 1].map((off) => {
      const y = t.getFullYear() + off;
      return { dueDate: iso(y, 3, 31), periodKey: `fy${y}`, periodLabel: fyLabel(y) };
    });
    return pick(t, cands, isFiled);
  };
}

/** Replaces the monthly GSTR-1 / GSTR-3B rows for a QRMP filer — same keys, quarterly periods. */
const QRMP_REPLACEMENTS: Record<string, Partial<Obligation>> = {
  gst_gstr1: {
    freq: "quarterly",
    applies: "QRMP filers — quarterly, by the 13th of the month after the quarter (IFF for B2B invoices in months 1–2 is optional, by the 13th).",
    next: gstQuarterNext(13),
  },
  gst_gstr3b: {
    freq: "quarterly",
    applies: "QRMP filers — quarterly, by the 22nd or 24th of the month after the quarter depending on your state. Shown on the 22nd, the earlier date — confirm your state with your CA.",
    next: gstQuarterNext(22),
  },
};

export const EXTRA_OBLIGATIONS: Obligation[] = [
  {
    key: "gst_lut_rfd11", name: "Renew LUT (Form GST RFD-11)", authority: "GST",
    category: "gst", freq: "annual", form: "GST RFD-11", lutOnly: true,
    penalty: "Without a valid LUT, IGST is payable on every export invoice (refund claim later)",
    link: "https://www.gst.gov.in/",
    applies: "Exporters billing at 0% GST under an LUT — a fresh LUT for each financial year, before 31 March.",
    filingSteps: [
      "gst.gov.in → Services → User Services → Furnish Letter of Undertaking (LUT).",
      "Pick the next financial year; enter the previous LUT's ARN if asked.",
      "Fill the two independent witnesses (name, address, occupation) and the place.",
      "Sign with DSC or EVC → submit → download the acknowledgement and note the new ARN.",
      "Settings → Company → LUT number: save the new ARN (it prints on every export invoice), then Mark filed here.",
    ],
    next: lutRenewNext(),
  },
  {
    key: "gst_pmt06", name: "PMT-06 — monthly GST payment (QRMP)", authority: "GST",
    category: "gst", freq: "monthly", form: "PMT-06", gstMode: "qrmp",
    penalty: "18% interest on tax paid late", link: "https://www.gst.gov.in/",
    applies: "QRMP filers — tax for months 1 and 2 of each quarter, by the 25th of the next month (fixed-sum 35% or self-assessed).",
    dataHref: { href: "/accounting/gst", label: "Open GST Report — net GST for the month" },
    filingSteps: [
      "In ResellerOS, open GST Report → set the month → note the net GST payable (output − input).",
      "gst.gov.in → Services → Payments → Create Challan → reason 'Monthly payment for quarterly return'.",
      "Choose fixed sum (35% of last quarter's cash tax) or self-assessment (this month's actual tax).",
      "Pay by net-banking / NEFT by the 25th → save the CPIN / CIN.",
      "Mark filed here (CIN in Reference). Nothing to pay in the month? Mark it filed with a note.",
    ],
    next: pmt06Next(),
  },
  {
    key: "llp_form11", name: "LLP Form 11 — annual return", authority: "MCA / ROC",
    category: "roc", freq: "annual", form: "Form 11", entities: ["llp"],
    penalty: "₹100/day of delay", link: "https://www.mca.gov.in",
    applies: "Every LLP — by 30 May for the year ended 31 Mar.",
    filingSteps: [
      "List the partners and designated partners, their contributions and any changes during the year.",
      "MCA V3 → LLP e-Filing → Form 11.",
      "Fill partner + contribution details; attach anything the form asks for.",
      "Pay the fee → affix a designated partner's DSC → submit → note the SRN.",
      "Mark filed here (SRN in Reference).",
    ],
    next: annualNext(5, 30),
  },
  {
    key: "llp_form8", name: "LLP Form 8 — statement of account & solvency", authority: "MCA / ROC",
    category: "roc", freq: "annual", form: "Form 8", entities: ["llp"],
    penalty: "₹100/day of delay", link: "https://www.mca.gov.in",
    applies: "Every LLP — by 30 Oct for the year ended 31 Mar.",
    dataHref: { href: "/accounting/balance-sheet", label: "Open Balance Sheet (for the statement)" },
    filingSteps: [
      "Close the year's accounts — Statement of Assets & Liabilities + Income & Expenditure.",
      "Get them audited if turnover > ₹40 lakh or contribution > ₹25 lakh.",
      "MCA V3 → LLP e-Filing → Form 8 → fill Part A (solvency) and Part B (accounts).",
      "Pay the fee → DSC of two designated partners (+ a practising professional) → submit → note the SRN.",
      "Mark filed here.",
    ],
    next: annualNext(10, 30),
  },
  {
    key: "it_itr_business", name: "Business ITR (ITR-3 / ITR-5)", authority: "Income Tax",
    category: "income_tax", freq: "annual", form: "ITR-3/5",
    entities: ["proprietor", "partnership", "llp"],
    penalty: "₹5,000 late fee + interest u/s 234A", link: "https://www.incometax.gov.in",
    applies: "Proprietor: ITR-3 on the owner's PAN. Partnership / LLP: ITR-5. Non-audit: by 31 Jul. If your accounts are audited: 31 Oct.",
    dataHref: { href: "/accounting/itr", label: "Open the ITR pack (computation + CA export)" },
    filingSteps: [
      "Close the year's books; get the tax-audit report accepted first if you need one.",
      "Compute business income — depreciation as per the IT Act, disallowances, partner remuneration/interest limits.",
      "incometax.gov.in → e-File → Income Tax Return → pick the AY + ITR-3 (proprietor) or ITR-5 (firm / LLP).",
      "Reconcile with Form 26AS + AIS; pay any self-assessment tax via challan.",
      "Submit → e-Verify (Aadhaar OTP / DSC; DSC mandatory if audited) → note the acknowledgement number.",
      "Mark filed here.",
    ],
    next: annualNext(7, 31),
  },
];

function appliesTo(ob: Obligation, p: ComplianceProfile): boolean {
  const type = p.businessType ?? "pvt_ltd";
  const gst = p.gstFiling ?? "monthly";
  if (ob.entities && !ob.entities.includes(type)) return false;
  if (ob.gstMode && ob.gstMode !== gst) return false;
  if (ob.lutOnly && !p.exportsUnderLut) return false;
  return true;
}

/**
 * The obligations this business actually files. An unknown profile gives back
 * OBLIGATIONS unchanged — same entries, same order — which is what keeps the app
 * working before the tenants.business_type / gst_filing migration is applied.
 */
export function obligationsFor(profile: ComplianceProfile = UNKNOWN_PROFILE): Obligation[] {
  const qrmp = (profile.gstFiling ?? "monthly") === "qrmp";
  const base = OBLIGATIONS.map((ob) =>
    qrmp && QRMP_REPLACEMENTS[ob.key] ? { ...ob, ...QRMP_REPLACEMENTS[ob.key] } : ob,
  );
  const list = [...base, ...EXTRA_OBLIGATIONS]
    .filter((ob) => appliesTo(ob, profile))
    .map((ob) => withTaxAudit(ob, profile.taxAudit ?? null));
  return withPeople(list, profile);
}

/**
 * R-1857: add each person's rows. The common DIR-3 KYC row stays in the list but only shows on
 * a day nobody in the register is current (all ceased) — so an empty or all-former register
 * still gets its reminder.
 */
function withPeople(list: Obligation[], profile: ComplianceProfile): Obligation[] {
  const kycBase = list.find((o) => o.key === "roc_dir3kyc");
  if (!kycBase || !profile.people?.length) return list;
  const rows = personObligations(profile.people, profile.businessType, kycBase);
  const kycRows = rows.filter((o) => o.key.startsWith("roc_dir3kyc:"));
  if (kycRows.length === 0) return list;
  const anyCurrent = (t: Date, i: ComplianceInstance, f: boolean) => kycRows.some((k) => k.visible?.(t, i, f) ?? true);
  return [
    ...list.map((o) => (o === kycBase ? { ...o, visible: (t: Date, i: ComplianceInstance, f: boolean) => !anyCurrent(t, i, f) } : o)),
    ...rows,
  ];
}

/**
 * R-1859: the tax-audit answer (lib/compliance/tax-audit.ts) rewrites two rows — the Tax
 * audit row says whether it applies and why, and a business ITR moves to 31 Oct when the
 * accounts are audited (31 Jul otherwise). A company's ITR is 31 Oct either way. No answer
 * (not loaded / "maybe") → both rows exactly as before.
 */
function withTaxAudit(ob: Obligation, ta: TaxAuditResult | null): Obligation {
  if (!ta) return ob;
  if (ob.key === "it_taxaudit") {
    return { ...ob, applies: [ta.reason, ta.companyNote].filter(Boolean).join(" ") };
  }
  /* Only "applies" moves the date. "Not applicable" keeps the row's own text (31 Jul, or
     31 Oct if audited): the ITR row can be for a later FY than the audit answer. */
  if (ob.key === "it_itr_business" && ta.verdict === "applies") {
    return { ...ob, applies: "Your accounts need a tax audit (see the Tax audit row), so the return is due 31 Oct — after the audit report.", next: annualNext(10, 31) };
  }
  return ob;
}

// ── Status derivation ─────────────────────────────────────────────────────
/** `not_applicable` — nothing to file for that period (e.g. no TDS deducted that month, R-181). */
export type ComplianceStatus = "filed" | "not_applicable" | "overdue" | "due_soon" | "upcoming";

export interface ComplianceRow {
  ob: Obligation;
  inst: ComplianceInstance;
  status: ComplianceStatus;
  daysToDue: number;      // negative = overdue
  filedDate?: string | null;
}

/**
 * Build the display rows for today, folding in the tenant's filed-log.
 *
 * `notApplicable` marks periods with nothing to file (R-181: a month with no TDS
 * deducted has no TDS to deposit). The picker skips them exactly like filed ones,
 * so the row moves on to the next real deadline instead of a false "overdue".
 * Omitted → every period counts, as before.
 */
export function buildComplianceRows(
  today: Date,
  filed: Map<string, string>, // `${key}|${periodKey}` → filedDate
  categories?: ComplianceCategory[],
  notApplicable?: (obligationKey: string, periodKey: string) => boolean,
  /** R-262: business type + GST mode. Omitted / unknown → the Pvt Ltd, monthly-GST list. */
  profile?: ComplianceProfile,
): ComplianceRow[] {
  const t0 = day0(today).getTime();
  const catalog = obligationsFor(profile);
  const list = categories?.length
    ? catalog.filter((o) => categories.includes(o.category))
    : catalog;
  return list
    .flatMap((ob): ComplianceRow[] => {
      // Tell the picker what is already done, so it advances past a filed period
      // to the next real deadline instead of showing a settled row for 45 days.
      const na = (periodKey: string) => Boolean(notApplicable?.(ob.key, periodKey));
      const inst = ob.next(today, (periodKey) => filed.has(`${ob.key}|${periodKey}`) || na(periodKey));
      const filedDate = filed.get(`${ob.key}|${inst.periodKey}`) ?? null;
      /* R-1857: a person row decides whether it shows today (DSC far away, ceased director…). */
      if (ob.visible && !ob.visible(today, inst, Boolean(filedDate) || na(inst.periodKey))) return [];
      const daysToDue = Math.round((new Date(inst.dueDate).getTime() - t0) / 864e5);
      let status: ComplianceStatus;
      /* R-1859: the tax audit does not apply for this FY — N/A, the row keeps its FY and reason. */
      const noAudit = ob.key === "it_taxaudit" && profile?.taxAudit?.verdict === "not_applicable"
        && inst.periodKey === `fy${profile.taxAudit.fyStartYear}`;
      if (filedDate) status = "filed";
      else if (na(inst.periodKey) || noAudit) status = "not_applicable";
      else if (daysToDue < 0) status = "overdue";
      else if (daysToDue <= (ob.remindDays ?? 15)) status = "due_soon";
      else status = "upcoming";
      return [{ ob, inst, status, daysToDue, filedDate }];
    })
    .sort((a, b) => {
      // Overdue + due-soon first (by due date); filed / not-applicable sink to the bottom.
      const rank = (r: ComplianceRow) =>
        (r.status === "filed" || r.status === "not_applicable" ? 2 : r.status === "overdue" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.inst.dueDate.localeCompare(b.inst.dueDate);
    });
}
