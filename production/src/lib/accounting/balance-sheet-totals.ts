/**
 * Balance Sheet ke totals — page se nikaala hua pure hisaab, taaki test ho sake (R-179).
 *
 * Pehle ye jod page.tsx me inline tha; "Undeposited funds" (customer se mila paisa jo kisi
 * bank line se match nahi hua) asset me juda hi nahi tha, aur koi test pakad nahi sakta tha.
 * Ab page, aur test, dono yahi function chalate hain.
 *
 * Equity = Total Assets − Total Liabilities (single-entry books-lite ka plug); retained =
 * wo equity jo manual equity lines ke baad bachti hai. Paisa poore rupees.
 */
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { PnLNumbers } from "@/lib/accounting/pnl-assemble";
import { addDaysISO } from "@/lib/dates/ist";

export interface BalanceSheetTotals {
  /** GST: positive → payable (liability); negative → ITC credit (asset). */
  gstCredit: number;
  gstPayable: number;
  totalAssets: number;
  totalLiab: number;
  /** = total equity. */
  netWorth: number;
  /** Equity jo manual equity lines (aur R-1739 Opening Balance Adjustments) ke baad sheet ko balance karne ke liye chahiye. */
  retained: number;
  currentAssets: number;
  currentLiab: number;
  /** ≥1 = short-term dues covered; null jab current liabilities 0. */
  currentRatio: number | null;
  /** null = equity negative ya 0. */
  debtToEquity: number | null;
}

/**
 * R-1646: the P&L range whose profit the Balance Sheet carries as retained earnings — after the
 * CA's opening date when one is entered, else the whole books. The Trial Balance reads its
 * licence provision from the same range, so the two show one figure.
 */
export function retainedProfitRange(openingAsOf: string | null, today: string, booksStart: string): { from: string; to: string; open: boolean } {
  const from = openingAsOf ? addDaysISO(openingAsOf, 1) : booksStart;
  const open = from <= today;
  return { from: open ? from : today, to: today, open };
}

/**
 * R-1646: the licence-cost provision — the part of that profit's cost that is the subscription
 * estimate, with no vendor bill yet (pnl.ts estimatedLicenceCogs). The P&L counts it as cost, so
 * the Balance Sheet carries it as a liability; without it the estimate sat in the "unexplained
 * difference" (and the one-click button could book it as owner's capital). Null until loaded;
 * 0 when the cost is unknown (no estimate in the profit).
 */
export function licenceProvisionOf(p: Pick<PnLNumbers, "model"> | undefined | null): number | null {
  if (!p) return null;
  return p.model.netProfit === null ? 0 : p.model.estimatedLicenceCogs;
}

export function balanceSheetTotals(
  auto: BalanceSheetAuto | undefined,
  items: readonly BalanceSheetItem[],
  opts: { licenceProvision?: number | null } = {},
): BalanceSheetTotals {
  const a = auto;
  const provision = opts.licenceProvision ?? 0;
  const sum = (section: BalanceSheetItem["section"]) =>
    items.filter((i) => i.section === section).reduce((s, r) => s + r.amount, 0);

  const gst = a?.gstPayable ?? 0;
  const gstCredit = gst < 0 ? -gst : 0;
  const gstPayable = gst > 0 ? gst : 0;

  /* Paisa haath me (bank + mila par bank line se match nahi) — dono current.
     S45 slice 2: cash / UPI se diya kharcha jiski bank line abhi match nahi — paisa ja chuka. */
  const cashLike = (a?.cashAndBank ?? 0) + (a?.undepositedFunds ?? 0) - (a?.expensesPaidUnbanked ?? 0);
  /* S45 slice 2: unpaid kharche + salary se kaata "other" — dono current liabilities.
     R-1580: + partner commission earned, abhi diya nahi (net; TDS dues me). */
  const otherPayables = (a?.expensesPayable ?? 0) + (a?.salaryOtherDeductions ?? 0) + (a?.commissionsPayable ?? 0)
    + provision;   // R-1646: licence cost estimated, not yet billed — due to the vendor

  const autoAssets =
    cashLike + (a?.receivables ?? 0) + (a?.projectReceivable ?? 0) + (a?.tdsReceivable ?? 0)
    + (a?.employeeLoans ?? 0) + (a?.loansGiven ?? 0) + (a?.prepaidAdvances ?? 0) + (a?.fixedAssets ?? 0) + gstCredit
    + (a?.advanceTaxPaid ?? 0);
  const autoLiab =
    (a?.payables ?? 0) + (a?.advancesFromCustomers ?? 0) + (a?.salaryPayable ?? 0) + (a?.salaryDuesPayable ?? 0)
    + (a?.reimbursementsPayable ?? 0) + (a?.creditCardPayable ?? 0) + (a?.emiLoansPayable ?? 0)
    + (a?.businessLoansPayable ?? 0) + gstPayable + otherPayables;

  const manualAssets = sum("asset");
  const manualLiab = sum("liability");
  const manualEquity = sum("equity");

  const totalAssets = autoAssets + manualAssets;
  const totalLiab = autoLiab + manualLiab;
  const netWorth = totalAssets - totalLiab;
  /* R-1739: Zoho se import hue khule invoices ka baaki receivables me Dr hai; uska Cr
     "Opening Balance Adjustments" equity line hai — retained (aur Unexplained) me nahi. */
  const retained = netWorth - manualEquity - (a?.openingBalanceAdjustments ?? 0);

  // Current = liquid within a year. Fixed assets, staff loans, EMI / business loans bahar.
  const currentAssets =
    cashLike + (a?.receivables ?? 0) + (a?.projectReceivable ?? 0)
    + (a?.tdsReceivable ?? 0) + gstCredit + (a?.advanceTaxPaid ?? 0) + manualAssets;
  const currentLiab =
    (a?.payables ?? 0) + (a?.advancesFromCustomers ?? 0) + (a?.salaryPayable ?? 0) + (a?.salaryDuesPayable ?? 0)
    + (a?.reimbursementsPayable ?? 0) + (a?.creditCardPayable ?? 0) + gstPayable + otherPayables + manualLiab;

  return {
    gstCredit, gstPayable, totalAssets, totalLiab, netWorth, retained, currentAssets, currentLiab,
    currentRatio: currentLiab > 0 ? currentAssets / currentLiab : null,
    debtToEquity: netWorth > 0 ? totalLiab / netWorth : null,
  };
}
