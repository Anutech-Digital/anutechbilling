/**
 * Company ke ITR (ITR-6) ki taiyari — computation, advance tax, aur GAPS.
 *
 * ─── YE KYA HAI, AUR KYA NAHI ───────────────────────────────────────────────
 * Ye module ITR FILE NAHI karta. Company ka return sirf incometax.gov.in par,
 * DSC se sign hokar, audit ke baad jata hai — wo raasta kanoon ne tay kiya hai
 * aur koi app use badal nahi sakti (ERI registration ke bina to bilkul nahi).
 *
 * Ye module wo karta hai jo app KAR sakti hai: saal bhar ke darj aankdo se
 * computation jodna, tax ka andaza (dono regime), advance-tax ka schedule,
 * aur — sabse zaroori — ye SAAF kehna ki kya app ke paas hai hi nahi. Kyunki
 * 1 Sep 2026 ko naapa: ANUTECH tenant me TDS ki 32 entry hain (₹4.13L) par
 * invoices SHUNYA. Us din ye module chup-chaap "revenue ₹0, tax ₹0" bata deta
 * to wo jhooth hota jo sach jaisa dikhta hai. Isliye har source ke saath uska
 * gap bhi nikalta hai, aur screen ka farz hai use computation ke barabar
 * dikhana — footnote me nahi.
 *
 * ─── `buildPnl` KYUN NAHI ───────────────────────────────────────────────────
 * lib/accounting/pnl.ts ka COGS zaroorat padne par subscription-book se
 * ANDAZA lagata hai (ratio) — management report ke liye bilkul sahi faisla.
 * Tax ke kagaz par andaza nahi chal sakta: yahan sirf DARJ rows ginte hain,
 * aur jo darj nahi hai wo gap ban kar bolta hai.
 *
 * ─── R-1579: P&L ke SAATH, alag nahi ───────────────────────────────────────
 * Pehle queries/itr.ts apna hisaab khud jodta tha — COGS purchase_orders se,
 * kharchon se SAARA gst_paid ghata kar, commission aur settlement ke bank
 * charges ke bina, aur bina paging. Ek hi FY par ITR ₹4,59,000 aur P&L
 * ₹5,13,064 (itr-from-pnl.test.ts). Ab "profit as per books" wahi aankde hain
 * jo /accounting/pnl ke — `report_pnl` + `assemblePnl` (lib/tax/itr-from-pnl.ts):
 * revenue, COGS = vendor bills 'COGS-*' (blocked GST samet), kharche jinse sirf
 * CLAIMABLE ITC ghata (blocked GST kharcha hai), commissions, bank charges
 * (settlement shortfall), depreciation (R-1578). Farq sirf itna: P&L page bina
 * bill ke COGS ka ANDAZA (subscription book) dikhata hai — ITR nahi; isliye
 * ITR flat `netProfit` (darj bills) leta hai aur bill na ho to gap bolta hai.
 * Purchase orders ab sirf NOTE hain (order hua, bill nahi aaya).
 *
 * ─── DOUBLE COUNTING SE BACHAV ──────────────────────────────────────────────
 * Salary, loan-ki-kisht aur inbound purchases sab `expenses` me bhi book hote
 * hain (`salary_payments.expense_id` waghaira). Isliye kharcha SIRF `expenses`
 * se aata hai, category-wise — salary_payments ko alag se jodna wahi rakam do
 * baar ginna hota. Licence ki khareed vendor bills (COGS-*) se aati hai —
 * P&L jaisi (R-1579).
 *
 * ─── PAISE KI IKAI ──────────────────────────────────────────────────────────
 * Sab kuch POORE RUPAYE me (integers) — is app ka storage yahi hai (§13).
 *
 * ─── DAREIN (rates) KAHAN SE ────────────────────────────────────────────────
 * Domestic company, turnover ≤ ₹400 crore (ANUTECH ke liye sach):
 *   - Saadha raasta: 25% + surcharge (>₹1cr par 7%, >₹10cr par 12%) + 4% cess
 *   - 115BAA:        22% + 10% surcharge (hamesha)                  + 4% cess
 * Kaunsa chunna hai wo CA ka faisla hai (115BAA me kuch deduction chhodne
 * padte hain) — isliye DONO dikhte hain. Marginal relief nahi ginta — wo
 * sirf dehleez ke aas-paas farq karta hai aur ye ANDAZA hai, assessment
 * nahi; screen par yahi likha jata hai.
 */

import { fyStartYear, fyLabelOfYear, fyCodeOfYear } from "@/lib/dates/ist";

/* ─────────────────────────── Financial year ─────────────────────────── */

export interface FinancialYear {
  /** Jis calendar saal me FY shuru hota hai — FY 2026-27 ke liye 2026. */
  startYear: number;
  /** "FY 2026-27" — insaan ke padhne ke liye. */
  label: string;
  /** "AY 2027-28" — jis saal return bharte hain. */
  assessmentYear: string;
  /** Samet — '2026-04-01'. */
  start: string;
  /** Samet — '2027-03-31'. Queries `gte(start)` + `lte(end)` (pnl page jaisa). */
  end: string;
  /** `tds_receivable.fiscal_year` / compliance period_key ka format — "FY2627". */
  fiscalKey: string;
  /** Audit wali company ka return due — AY ka 31 October (139(1)). */
  itrDue: string;
}

export function financialYear(startYear: number): FinancialYear {
  return {
    startYear,
    label: `FY ${fyLabelOfYear(startYear)}`,
    assessmentYear: `AY ${fyLabelOfYear(startYear + 1)}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
    fiscalKey: fyCodeOfYear(startYear),
    itrDue: `${startYear + 1}-10-31`,
  };
}

/**
 * Aaj kaunsa FY chal raha hai — IST me, kyunki 31 March ki raat UTC-ghadi se
 * poochhne par galat saal milta hai (IST raat 12 baje naya FY shuru hota hai,
 * UTC me tab 18:30 hi baje hote hain).
 */
export function currentFinancialYear(now: Date): FinancialYear {
  return financialYear(fyStartYear(now));   // fyStartYear reads a Date in IST
}

/* ─────────────────────────── Sources (input) ─────────────────────────── */

/** Ek category ka jod — `expenses` se (report_pnl ke groups), jaisa darj hai. */
export interface ExpenseCategoryLine {
  category: string;
  /** `expenses.amount` ka jod — GST-SAMET kul (dialog ka "of which GST"). */
  amount: number;
  /**
   * Sirf CLAIMABLE input credit (lib/gst/itc.ts) — wahi jo P&L ghatata hai. Blocked GST
   * (kaccha bill, vendor ka GSTIN nahi, s.17(5)) kharcha hai aur `amount` me hi rehta hai.
   * R-1579: pehle yahan saara gst_paid ghatta tha.
   */
  itc: number;
  count: number;
}

/**
 * App ki tables se joda hua kachcha maal — sab poore rupaye.
 * Assembler (queries/itr.ts) inhe bharta hai; ye module sirf ginta hai.
 */
export interface ItrSources {
  /**
   * `taxable_value` ka jod: invoices (pending/paid/overdue) − credit notes
   * + debit notes. GST ke BINA — output GST sarkar ka paisa hai, aamdani
   * nahi (pnl page ka pinned formula).
   */
  revenueExGst: number;
  invoiceCount: number;
  creditNoteCount: number;
  debitNoteCount: number;
  /**
   * R-1579: COGS — vendor bills 'COGS-*' ka subtotal + unka BLOCKED GST (R-1576), wahi jo
   * P&L ka `cogs` hai. Purchase order nahi: order bill nahi hai.
   */
  cogs: number;
  cogsCount: number;
  /** Placed/provisioned/closed purchase orders is FY ke — sirf NOTE (bill aaya ya nahi). */
  placedPoCost: number;
  placedPoCount: number;
  /** `expenses` category-wise — salary/loan/bank charges sab isi ke andar (upar dekho). */
  expenses: ExpenseCategoryLine[];
  /** Referral / channel-partner commissions (gross) — P&L ki wahi line. */
  commissions: number;
  commissionsCount: number;
  /**
   * P&L (assemblePnl) ka net profit isi FY ka. Diya ho aur book profit se na mile to gap
   * bolta hai — do "profit" CA ke saamne kabhi chup-chaap nahi.
   */
  pnlNetProfit?: number;
  /** `tds_receivable.tds_amount` (is FY ka) — tax me se KATEGA. */
  tdsCredit: number;
  tdsCount: number;
  /** Ab tak bhara advance tax, agar kahin darj ho. Na ho to 0 + gap. */
  advanceTaxPaid: number;
  /**
   * R-1578: is FY ka depreciation — asset register (lib/accounting/depreciation.ts), IT Act
   * WDV (s.32, Rule 5; 180 din se kam to aadhi dar). Jo expense asset bana wo `expenses` me
   * nahi aata (capitalised) — uska kharcha sirf isi line se. Optional: purane callers = 0.
   */
  depreciation?: number;
  /** Register me kitne asset is FY me rakhe the — 0 = register khaali (gap). */
  assetCount?: number;
}

/* ─────────────────────────── Output shapes ─────────────────────────── */

export interface PnlLine {
  label: string;
  /** Rupaye. Kharcha bhi positive — `kind` side batata hai. */
  amount: number;
  kind: "income" | "expense";
  /** Kis table/column se aaya — screen par chhota sa likha jata hai. */
  source: string;
  /** Rows kitni thi — 0 ka matlab "darj hi nahi", jo apne aap gap hai. */
  count: number;
}

export interface TaxEstimate {
  regime: "normal" | "s115BAA";
  regimeLabel: string;
  ratePct: number;
  baseTax: number;
  surcharge: number;
  cess: number;
  total: number;
}

export interface AdvanceTaxInstallment {
  dueDate: string;
  label: string;
  /** Kul ka kitna % is tareekh tak jama hona chahiye. */
  cumulativePct: number;
  /** Rupaye — is tareekh tak kul kitna jama hona chahiye. */
  cumulativeDue: number;
}

export interface ItrPack {
  fy: FinancialYear;
  /** Jodne me jo istemal hua — screen/CSV counts aur TDS yahi se padhte hain. */
  sources: ItrSources;
  pnl: PnlLine[];
  totalIncome: number;
  totalExpense: number;
  /** Kitab ka munafa (ghata ho to negative). */
  bookProfit: number;
  /** 288A: das ke nikattam ank par gol. Ghate me 0. */
  taxableIncome: number;
  /** Dono regime — chunav CA ka. Ghate me khaali. */
  estimates: TaxEstimate[];
  /** Kam wala estimate — advance-tax schedule isi par banta hai. */
  cheaperEstimate: TaxEstimate | null;
  /** TDS ghata kar jo bacha — advance tax isi par lagta hai (Section 209). */
  netPayableAfterTds: number;
  /** Section 208: ₹10,000 se kam ho to advance tax zaroori nahi. */
  advanceTaxRequired: boolean;
  advanceTaxSchedule: AdvanceTaxInstallment[];
  /** Jo app ke paas NAHI hai — insaan ke padhne layak vaakya, naam ke saath. */
  gaps: string[];
}

/* ─────────────────────────── Computation ─────────────────────────── */

const r0 = (n: number): number => Math.round(n);

/** 288A — taxable income das ke nikattam ank par. */
export function roundTaxable(income: number): number {
  return Math.round(income / 10) * 10;
}

function estimate(
  regime: TaxEstimate["regime"], regimeLabel: string, ratePct: number,
  surchargeOf: (baseTax: number, taxable: number) => number, taxable: number,
): TaxEstimate {
  const baseTax = r0((taxable * ratePct) / 100);
  const surcharge = surchargeOf(baseTax, taxable);
  const cess = r0(((baseTax + surcharge) * 4) / 100);
  return { regime, regimeLabel, ratePct, baseTax, surcharge, cess, total: baseTax + surcharge + cess };
}

/** Saadha raasta: surcharge sirf badi aamdani par. */
const normalSurcharge = (baseTax: number, taxable: number): number =>
  taxable > 100_000_000 ? r0((baseTax * 12) / 100)
  : taxable > 10_000_000 ? r0((baseTax * 7) / 100)
  : 0;

/** 115BAA: 10% hamesha — aamdani kitni bhi ho. */
const s115baaSurcharge = (baseTax: number): number => r0((baseTax * 10) / 100);

/** Advance tax ki chaar kishtein — Section 211, cumulative. */
const INSTALLMENTS: ReadonlyArray<{ month: string; label: string; pct: number; nextYear: boolean }> = [
  { month: "06-15", label: "15 June", pct: 15, nextYear: false },
  { month: "09-15", label: "15 September", pct: 45, nextYear: false },
  { month: "12-15", label: "15 December", pct: 75, nextYear: false },
  { month: "03-15", label: "15 March", pct: 100, nextYear: true },
];

/** `expenses` me salary is naam ki category se book hoti hai. */
const SALARY_CATEGORY = "Salaries";

export function computeItrPack(fy: FinancialYear, s: ItrSources): ItrPack {
  const pnl: PnlLine[] = [
    {
      label: "Revenue (GST ke bina, credit/debit notes samet)",
      amount: s.revenueExGst, kind: "income",
      source: "invoices.taxable_value − CN + DN",
      count: s.invoiceCount,
    },
    {
      label: "Licence ki khareed (vendor bills, COGS)",
      amount: s.cogs, kind: "expense",
      source: "vendor_bills COGS-* (blocked GST samet) — P&L jaisa",
      count: s.cogsCount,
    },
    /* Har category apni line — sirf CLAIMABLE GST ghata kar (wo input credit hai); blocked
       GST kharcha hai. Khaali categories nahi chhapti; unki jagah gaps bolte hain. */
    ...s.expenses
      .filter((c) => c.count > 0 || c.itc !== 0)
      .sort((a, b) => (b.amount - b.itc) - (a.amount - a.itc) || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
      .map((c): PnlLine => ({
        label: c.category,
        amount: c.amount - c.itc, kind: "expense",
        source: "expenses (sirf claimable ITC ghata kar)",
        count: c.count,
      })),
    ...(s.commissions !== 0
      ? [{
          label: "Referral / partner commissions",
          amount: s.commissions, kind: "expense",
          source: "referral_commissions (gross) — P&L jaisa",
          count: s.commissionsCount,
        } satisfies PnlLine]
      : []),
    ...((s.depreciation ?? 0) > 0
      ? [{
          label: "Depreciation (IT Act WDV, asset register)",
          amount: s.depreciation ?? 0, kind: "expense",
          source: "fixed_assets — block ki dar par WDV (s.32)",
          count: s.assetCount ?? 0,
        } satisfies PnlLine]
      : []),
  ];

  const totalIncome = pnl.filter((l) => l.kind === "income").reduce((a, l) => a + l.amount, 0);
  const totalExpense = pnl.filter((l) => l.kind === "expense").reduce((a, l) => a + l.amount, 0);
  const bookProfit = totalIncome - totalExpense;
  const taxableIncome = bookProfit > 0 ? roundTaxable(bookProfit) : 0;

  const estimates: TaxEstimate[] =
    taxableIncome > 0
      ? [
          estimate("normal", "Saadha raasta (25%)", 25, normalSurcharge, taxableIncome),
          estimate("s115BAA", "Section 115BAA (22%)", 22, s115baaSurcharge, taxableIncome),
        ]
      : [];
  const cheaperEstimate =
    estimates.length > 0 ? estimates.reduce((a, b) => (b.total < a.total ? b : a)) : null;

  const netPayableAfterTds = Math.max(0, (cheaperEstimate?.total ?? 0) - s.tdsCredit);
  const advanceTaxRequired = netPayableAfterTds >= 10_000;
  const advanceTaxSchedule: AdvanceTaxInstallment[] = advanceTaxRequired
    ? INSTALLMENTS.map((i) => ({
        dueDate: `${i.nextYear ? fy.startYear + 1 : fy.startYear}-${i.month}`,
        label: i.label,
        cumulativePct: i.pct,
        cumulativeDue: r0((netPayableAfterTds * i.pct) / 100),
      }))
    : [];

  /* Gaps — jo nahi hai use NAAM se kehna hi is module ka asli kaam hai. */
  const gaps: string[] = [];
  if (s.invoiceCount === 0)
    gaps.push(
      "Is saal ki EK BHI invoice app me nahi — revenue ₹0 dikh raha hai, jo aapki asli revenue nahi hai. Jab tak sales invoices darj nahi hoti, ye poora computation adhoora hai.",
    );
  if (s.tdsCount > 0 && s.invoiceCount === 0)
    gaps.push(
      `TDS ki ${s.tdsCount} entry darj hain (customers ne ₹${s.tdsCredit.toLocaleString("en-IN")} tax kata) par unki invoices nahi — matlab bikri kahin aur ho rahi hai. Bina aamdani dikhaye TDS claim nahi hota.`,
    );
  if (s.cogsCount === 0 && s.placedPoCount > 0)
    gaps.push(
      `Is saal ${s.placedPoCount} placed purchase order (₹${s.placedPoCost.toLocaleString("en-IN")}) hain par koi COGS vendor bill nahi — licence ki khareed ₹0 gini gayi. Kharcha bill se banta hai, order se nahi: vendor ka bill Purchases → Bills me 'COGS' category se daaliye.`,
    );
  else if (s.cogsCount === 0)
    gaps.push(
      "Licence ki khareed ₹0 hai kyunki is saal koi COGS vendor bill darj nahi. P&L page aise me subscription book se ANDAZA dikhata hai — tax ke kagaz par andaza nahi chalta: vendor ke bill Purchases → Bills me daaliye.",
    );
  const salaryBooked = s.expenses.some((c) => c.category === SALARY_CATEGORY && c.count > 0);
  if (!salaryBooked)
    gaps.push(
      "Salary ka koi kharcha book nahi hua — agar company tankhwah deti hai to wo yahan ginti me nahi aaya (payroll chalane par ye apne aap Salaries category me aata hai).",
    );
  if (s.expenses.every((c) => c.count === 0))
    gaps.push("Kharcho ki koi entry nahi — kiraya, bijli, software, sab chhoota hua hai.");
  /* R-1578: depreciation ab asset register se aata hai (upar ki line). Register khaali ho tabhi gap. */
  if (!s.assetCount)
    gaps.push(
      "Asset register me koi asset nahi — computer/furniture/gaadi kharidi ho to Accounting → Assets me jodiye; tab unka depreciation (IT Act WDV) yahan apne aap ghatega.",
    );
  gaps.push(
    "Bank ka byaaj, FD, ya koi aur aamdani app me nahi aati — CA bank statement se jodega.",
  );
  if (s.pnlNetProfit !== undefined && s.pnlNetProfit !== bookProfit)
    gaps.push(
      `Ye book profit (₹${bookProfit.toLocaleString("en-IN")}) P&L ke net profit (₹${s.pnlNetProfit.toLocaleString("en-IN")}) se alag hai — CA ko dene se pehle support ko batayein.`,
    );
  if (s.advanceTaxPaid === 0 && advanceTaxRequired)
    gaps.push(
      "Advance tax ka koi bhugtan darj nahi — agar bhara hai to Banking me us challan ki bank line ko Reconcile → Statutory → Income tax book kijiye (aur challan CA ko dijiye); nahi bhara to schedule upar hai, aur der par Section 234B/C ka byaaj lagta hai.",
    );

  return {
    fy, sources: s, pnl, totalIncome, totalExpense, bookProfit, taxableIncome,
    estimates, cheaperEstimate, netPayableAfterTds, advanceTaxRequired,
    advanceTaxSchedule, gaps,
  };
}
