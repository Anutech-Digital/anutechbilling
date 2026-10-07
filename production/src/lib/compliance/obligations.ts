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

export type ComplianceCategory = "roc" | "income_tax" | "tds" | "gst" | "payroll";
export type ComplianceFreq = "monthly" | "quarterly" | "half_yearly" | "annual";

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
  return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
}
const fyLabel = (startYear: number) => `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;

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
    category: "roc", freq: "annual", form: "DIR-3 KYC",
    penalty: "₹5,000 per director if late", link: "https://www.mca.gov.in",
    applies: "Every director with a DIN — by 30 Sep each year.",
    filingSteps: [
      "Keep each director's PAN, Aadhaar, personal mobile and personal email ready (they're OTP-verified).",
      "Go to MCA → DIR-3 KYC: use the WEB service if nothing changed since last year, or the e-form if it's the first time / details changed.",
      "Verify the mobile + email via OTP.",
      "e-form path: affix the director's DSC + certification by a practising professional.",
      "Submit → note the SRN. Repeat for EVERY director holding a DIN.",
      "Mark filed here.",
    ],
    next: annualNext(9, 30),
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
      "Pay by the 7th → SAVE the challan (BSR code + serial + date) — you need it for the quarterly return.",
      "Mark filed here (challan number in Reference).",
    ],
    next: monthlyNext(7),
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
  return [...base, ...EXTRA_OBLIGATIONS].filter((ob) => appliesTo(ob, profile));
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
    .map((ob) => {
      // Tell the picker what is already done, so it advances past a filed period
      // to the next real deadline instead of showing a settled row for 45 days.
      const na = (periodKey: string) => Boolean(notApplicable?.(ob.key, periodKey));
      const inst = ob.next(today, (periodKey) => filed.has(`${ob.key}|${periodKey}`) || na(periodKey));
      const filedDate = filed.get(`${ob.key}|${inst.periodKey}`) ?? null;
      const daysToDue = Math.round((new Date(inst.dueDate).getTime() - t0) / 864e5);
      let status: ComplianceStatus;
      if (filedDate) status = "filed";
      else if (na(inst.periodKey)) status = "not_applicable";
      else if (daysToDue < 0) status = "overdue";
      else if (daysToDue <= 15) status = "due_soon";
      else status = "upcoming";
      return { ob, inst, status, daysToDue, filedDate };
    })
    .sort((a, b) => {
      // Overdue + due-soon first (by due date); filed / not-applicable sink to the bottom.
      const rank = (r: ComplianceRow) =>
        (r.status === "filed" || r.status === "not_applicable" ? 2 : r.status === "overdue" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.inst.dueDate.localeCompare(b.inst.dueDate);
    });
}
