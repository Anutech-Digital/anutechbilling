/**
 * Statutory-compliance catalog for an Indian Private Limited company.
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
  /** Next actionable instance given today (upcoming, or a recently-passed one). */
  next: (today: Date) => ComplianceInstance;
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
 * Pick the "actionable" instance from a list of dated instances: the earliest
 * one whose due date is still upcoming, OR — if the most recent one passed less
 * than 45 days ago — that recently-due one (so an overdue filing stays visible
 * instead of jumping to next year). Falls back to the last instance.
 */
function pick(today: Date, instances: ComplianceInstance[]): ComplianceInstance {
  const t = day0(today).getTime();
  const sorted = [...instances].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const upcoming = sorted.find((i) => new Date(i.dueDate).getTime() >= t);
  const recentlyPassed = [...sorted].reverse().find((i) => {
    const diff = t - new Date(i.dueDate).getTime();
    return diff > 0 && diff <= 45 * 864e5;
  });
  return recentlyPassed ?? upcoming ?? sorted[sorted.length - 1];
}

// Annual obligation due on a fixed month/day; considers this year + next.
function annualNext(month: number, dayNum: number, periodIsFy = true): (t: Date) => ComplianceInstance {
  return (t: Date) => {
    const cands: ComplianceInstance[] = [-1, 0, 1].map((off) => {
      const y = t.getFullYear() + off;
      const start = fyStart(new Date(y, month - 1, dayNum));
      return {
        dueDate: iso(y, month, dayNum),
        periodKey: periodIsFy ? `fy${start}` : `${y}`,
        periodLabel: periodIsFy ? fyLabel(start) : String(y),
      };
    });
    return pick(t, cands);
  };
}

// Monthly obligation due on `dayNum` of every month (e.g. PF/ESI 15th, GST 20th).
// Each instance's PERIOD is the previous month (what you're filing FOR).
function monthlyNext(dayNum: number): (t: Date) => ComplianceInstance {
  return (t: Date) => {
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
    return pick(t, cands);
  };
}

// Fixed set of dated instances per FY (advance tax, quarterly TDS returns).
function fixedNext(build: (fyStartYear: number) => ComplianceInstance[]): (t: Date) => ComplianceInstance {
  return (t: Date) => {
    const s = fyStart(t);
    const all = [s - 1, s, s + 1].flatMap(build);
    return pick(t, all);
  };
}

// ── The catalog ─────────────────────────────────────────────────────────────
export const OBLIGATIONS: Obligation[] = [
  // ROC / MCA (annual)
  {
    key: "roc_aoc4", name: "AOC-4 — file financial statements", authority: "MCA / ROC",
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
    category: "income_tax", freq: "annual", form: "ITR-6",
    penalty: "₹5,000 late fee + interest u/s 234A", link: "https://www.incometax.gov.in",
    applies: "Audit case: by 31 Oct. Non-audit: by 31 Jul.",
    dataHref: { href: "/accounting/pnl", label: "Open P&L (for the income figures)" },
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
    dataHref: { href: "/accounting/pnl", label: "Open P&L (to estimate profit)" },
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

// ── Status derivation ─────────────────────────────────────────────────────
export type ComplianceStatus = "filed" | "overdue" | "due_soon" | "upcoming";

export interface ComplianceRow {
  ob: Obligation;
  inst: ComplianceInstance;
  status: ComplianceStatus;
  daysToDue: number;      // negative = overdue
  filedDate?: string | null;
}

/** Build the display rows for today, folding in the tenant's filed-log. */
export function buildComplianceRows(
  today: Date,
  filed: Map<string, string>, // `${key}|${periodKey}` → filedDate
  categories?: ComplianceCategory[],
): ComplianceRow[] {
  const t0 = day0(today).getTime();
  const list = categories?.length
    ? OBLIGATIONS.filter((o) => categories.includes(o.category))
    : OBLIGATIONS;
  return list
    .map((ob) => {
      const inst = ob.next(today);
      const filedDate = filed.get(`${ob.key}|${inst.periodKey}`) ?? null;
      const daysToDue = Math.round((new Date(inst.dueDate).getTime() - t0) / 864e5);
      let status: ComplianceStatus;
      if (filedDate) status = "filed";
      else if (daysToDue < 0) status = "overdue";
      else if (daysToDue <= 15) status = "due_soon";
      else status = "upcoming";
      return { ob, inst, status, daysToDue, filedDate };
    })
    .sort((a, b) => {
      // Overdue + due-soon first (by due date); filed sinks to the bottom.
      const rank = (r: ComplianceRow) => (r.status === "filed" ? 2 : r.status === "overdue" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.inst.dueDate.localeCompare(b.inst.dueDate);
    });
}
