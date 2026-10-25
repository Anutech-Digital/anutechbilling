/**
 * Balance Sheet — statement of financial position.
 *
 * Assets = Liabilities + Equity, as of today. Auto figures come from ResellerOS
 * records (cash & bank, receivables, TDS receivable, payables, GST); the
 * operator adds manual lines for what the app doesn't track (fixed assets,
 * loans, owner's capital, drawings). Equity's "retained earnings" is derived so
 * the sheet always balances.
 *
 * R-1845 (24 Oct 2026): the equity section follows the business type (lib/accounting/
 * equity-section.ts) — Proprietor's capital account / Partners' capital accounts /
 * Shareholders' funds (Share capital + Reserves & surplus). Same totals; a company never
 * sees "Drawings".
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useBalanceSheetAuto, useBalanceSheetItems, useCreateBalanceSheetItem, useDeleteBalanceSheetItem, useOpeningBalances, type BalanceSheetItem, type OpeningBalances } from "@/lib/queries/balance-sheet";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";
import { usePnL, BOOKS_START } from "@/lib/queries/pnl";
import { balanceSheetTotals, retainedProfitRange, licenceProvisionOf } from "@/lib/accounting/balance-sheet-totals";
import { reportProfit } from "@/lib/accounting/pnl-assemble";
import { istToday } from "@/lib/dates/ist";
import { fyOf } from "@/lib/accounting/ledger";
import { fmtBS } from "./format";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { ownerEquityWords, movementTotals, unexplainedAfterEntries, looksLikeDrawingsLine } from "@/lib/accounting/owner-equity";
import { useOwnerEquityMovements, isOwnerEquityTableMissing } from "@/lib/queries/owner-equity";
import { OwnerEquityCard, RecordOwnerEquityDialog, type RecordInit } from "./owner-equity-card";
import { equitySection, equitySectionTotal, registerShareCapital } from "@/lib/accounting/equity-section";
import { useShareCapital } from "@/lib/queries/share-capital";
import { shareCapitalSummary } from "@/lib/company/share-capital";
import { useFirmPartners } from "@/lib/queries/partners";
import { PartnerCapitalBox } from "./partner-capital-box";
import { usePartnerAppropriations } from "@/lib/queries/partner-appropriations";
import { partnerTdsInRange } from "@/lib/accounting/partner-capital";
import { entityProfile } from "@/lib/compliance/entity";
import type { BusinessType } from "@/lib/compliance/obligations";
import { useBusinessLoans } from "@/lib/queries/business-loans";
import { showsDirectorLoans, splitLoansTaken, undeclaredDirectorLoans } from "@/lib/accounting/director-loans";
import { useEmployeeAdvances } from "@/lib/queries/advances";
import { splitPrepaidAdvances } from "@/lib/accounting/employee-advance";
import { SectionTitle, Ratio, BSLine, ManualLines, TotalLine, equityCsvRows } from "./bs-lines";
import { OpeningBalancesCard } from "./opening-balances-card";
import { EditLineDialog, AddLineDialog } from "./line-dialogs";

export default function BalanceSheetPage() {
  const { data: auto, isLoading: autoLoading, isError: autoFailed, refetch: refetchAuto } = useBalanceSheetAuto();
  const { data: items, isLoading: itemsLoading, isError: itemsFailed, refetch: refetchItems } = useBalanceSheetItems();
  /* R-1872: employee advances sit inside the Prepaid total (both are prepaid_advances rows) —
     shown as their own line by taking them out of Prepaid, so total assets do not move. */
  const { data: employeeAdvances } = useEmployeeAdvances();
  const advanceSplit = splitPrepaidAdvances(auto?.prepaidAdvances ?? 0, employeeAdvances ?? []);
  const del = useDeleteBalanceSheetItem();
  const confirm = useConfirm();
  /* D16 (27 Sep 2026): the unexplained difference is almost always the owner's money that
     never got a line — capital put in, or drawings taken out. One click books it.
     R-1839: money taken out is now recorded as real drawings entries (date, amount, account),
     which move the bank / cash balance too — not a lump equity line. A company has no drawings. */
  const createItem = useCreateBalanceSheetItem();
  /* R-1845: a company's unexplained money-in is share capital or a director's loan — the owner picks. */
  async function bookUnexplained(as: "capital" | "director_loan" = "capital") {
    if (unexplained === null || unexplained === 0) return;
    const capital = unexplained > 0;
    if (!capital) {
      if (words.allowed) setRecordInit({ kind: "drawings", amount: -unexplained });
      return;
    }
    const loan = as === "director_loan";
    const label = loan ? "Loan from director" : profile.capitalLabel;
    const ok = await confirm({
      title: `Add ${label} of ${rupee(unexplained)}?`,
      body: loan
        ? "Assets are more than the books explain — a director lent the company this money without an entry. A Loan from director line is added under Liabilities."
        : `Assets are more than the books explain — this much money was put into the business without an entry (opening bank balance, ${profile.type === "pvt_ltd" ? "shares issued" : "your own money"}). A ${label} line is added under Equity.`,
      confirmLabel: "Add line", cancelLabel: "Cancel",
    });
    if (!ok) return;
    await createItem.mutateAsync({
      section: loan ? "liability" : "equity", label, amount: unexplained,
      notes: `Created on ${today} from the Balance Sheet's unexplained difference — the gap left after cumulative P&L.`,
    });
  }
  const [addOpen, setAddOpen] = React.useState(false);
  const [editItem, setEditItem] = React.useState<BalanceSheetItem | null>(null);
  const [retainedInfoOpen, setRetainedInfoOpen] = React.useState(false);
  const today = istToday();

  /* R-1839: owner drawings / capital introduced — real entries, labelled by company type. */
  const profileQ = useComplianceProfile();
  const businessType: BusinessType | null = profileQ.data?.businessType ?? null;
  const words = ownerEquityWords(businessType);
  const profile = entityProfile(businessType);
  const movementsQ = useOwnerEquityMovements();
  const movementsMissing = movementsQ.isError && isOwnerEquityTableMissing(movementsQ.error);
  const movements = React.useMemo(() => movementsQ.data ?? [], [movementsQ.data]);
  const [recordInit, setRecordInit] = React.useState<RecordInit | null>(null);
  /* R-1847: a firm's partners come from the partners register (Settings → Company → Partners). */
  const partnersQ = useFirmPartners(words.needsPartner);
  const partners = React.useMemo(() => partnersQ.data ?? [], [partnersQ.data]);
  /* R-1849: posted year-end splits — per-partner interest / remuneration / share, and the TDS
     taken from partners (in TDS payable; lowers their capital). Read for every type: the TDS
     is in the report's TDS payable whatever the type is now. */
  const splitsQ = usePartnerAppropriations();
  const splits = React.useMemo(() => splitsQ.data ?? [], [splitsQ.data]);
  /* R-1851: a company's paid-up capital comes from the share capital register (Settings → Company). */
  const shareQ = useShareCapital(profile.type === "pvt_ltd");
  const shareRegister = React.useMemo(() => {
    if (!shareQ.data?.capital) return null;
    const s = shareCapitalSummary(shareQ.data.capital, shareQ.data.holders);
    return { paidUpCapital: s.paidUpCapital, paidUpShares: s.paidUpShares, faceValue: shareQ.data.capital.face_value };
  }, [shareQ.data]);

  /* R-1853: loans FROM directors show apart from bank loans — the split of the report's one
     "business loans payable" total (lib/accounting/director-loans.ts). Only a company has them. */
  const companyLoans = showsDirectorLoans(businessType);
  const bizLoansQ = useBusinessLoans(companyLoans);
  const bizLoans = React.useMemo(() => bizLoansQ.data ?? [], [bizLoansQ.data]);
  const loansTaken = splitLoansTaken(auto?.businessLoansPayable ?? 0, bizLoans);
  const undeclared = undeclaredDirectorLoans(bizLoans);

  const loading = autoLoading || itemsLoading || (movementsQ.isLoading && !movementsMissing) || shareQ.isLoading || (companyLoans && bizLoansQ.isLoading) || splitsQ.isLoading;
  /* R-270: a failed fetch must not print a ₹0 balance sheet that reads as "you own nothing". */
  const failed = autoFailed || itemsFailed || (movementsQ.isError && !movementsMissing) || shareQ.isError || (companyLoans && bizLoansQ.isError) || splitsQ.isError;

  const manual = (section: BalanceSheetSection) => (items ?? []).filter((i) => i.section === section);
  const manualAssetRows = manual("asset");
  const manualLiabRows  = manual("liability");
  const manualEqRows    = manual("equity");

  /* Totals + solvency ratios ek tested pure function me (lib/accounting/balance-sheet-totals.ts).
     R-179: "Received, not yet in bank" bhi asset hai, Cash & bank ke saath — warna bina bank
     account wale workspace me mila hua paisa sirf liability (advance) me dikhta tha. */
  /* Retained earnings PER THE BOOKS — cumulative net profit from the P&L, all periods
     (27 Sep 2026). The plug above used to be shown AS retained earnings, which hid every
     missing entry inside a number that always looked right. Now the P&L figure is the
     retained earnings, and the gap between the two is printed as what it is. */
  /* S45 slice 2: CA ke opening balances bhare hon to retained earnings = unke "b/f" + us
     tareekh ke BAAD ka P&L; warna pehle jaisa — saare periods ka P&L. Opening query aane tak
     P&L nahi chalta (ek bekaar all-periods aggregation bachti hai). */
  const openingQ = useOpeningBalances();
  const opening: OpeningBalances | null = openingQ.data ?? null;
  const profitRange = retainedProfitRange(opening?.asOf ?? null, today, BOOKS_START);
  const cumulative = usePnL({ from: profitRange.from, to: profitRange.to }, openingQ.data !== undefined && profitRange.open);
  /* R-1646: one profit with the P&L and Trial Balance (reportProfit), and the licence cost it
     estimates (no vendor bill yet) carried as a provision — not left in the unexplained gap. */
  const cumulativeProfit = openingQ.data === undefined ? null
    : !profitRange.open ? 0
    : cumulative.data ? reportProfit(cumulative.data) : null;
  const licenceProvision = !profitRange.open ? 0 : licenceProvisionOf(cumulative.data);
  /* Totals + solvency ratios ek tested pure function me (lib/accounting/balance-sheet-totals.ts).
     R-179: "Received, not yet in bank" bhi asset hai, Cash & bank ke saath — warna bina bank
     account wale workspace me mila hua paisa sirf liability (advance) me dikhta tha. */
  const {
    gstCredit, gstPayable, totalAssets, totalLiab, netWorth, retained, currentRatio, debtToEquity,
  } = balanceSheetTotals(auto, items ?? [], { licenceProvision });
  const openingEquity = (opening?.ownerCapital ?? 0) + (opening?.retainedEarnings ?? 0);
  /* R-1839: entries after the CA's opening date (earlier ones are inside the opening figure), up
     to today. Each has its bank / cash line, so cash & bank already moved — this is the equity side. */
  const ownerTotals = movementTotals(movements, { after: opening?.asOf ?? null, upTo: today });
  const hasOwnerEntries = ownerTotals.capitalIntroduced !== 0 || ownerTotals.drawings !== 0;
  /* R-1845: the equity section by business type — same lines, same total, arranged and named
     the way a proprietor / firm / company Balance Sheet is. */
  const equityRange = React.useMemo(() => ({ after: opening?.asOf ?? null, upTo: today }), [opening?.asOf, today]);
  const partnerTds = partnerTdsInRange(splits, equityRange);
  const equity = equitySection({
    businessType, manualLines: manualEqRows, opening, profit: cumulativeProfit, totals: ownerTotals,
    movements, range: equityRange, formatDate, shareRegister, partnerTds,
  });
  /* R-1851: share capital from the register is explained money — it leaves the unexplained gap
     (equity total = net worth, so the sheet still balances). R-1849: so is the partners' TDS
     (in TDS payable, taken from their capital). */
  const unexplained = cumulativeProfit === null ? null
    : unexplainedAfterEntries({ retained: retained - registerShareCapital(equity) + partnerTds, openingEquity, profit: cumulativeProfit, totals: ownerTotals });
  /* Old hand-entered "Drawings" lines stay as they are; if real entries exist too, say it once. */
  const drawingsTwice = ownerTotals.drawings > 0 && manualEqRows.some((r) => looksLikeDrawingsLine(r.label));


  // Export the full sheet as a CSV the owner can hand to their CA (mirrors GST/P&L).
  function exportCSV() {
    if (!auto) return;
    downloadCSV(
      `balance-sheet-${today}.csv`,
      ["Line", "Amount (INR)"],
      [
        ["As of date", today],
        ["", ""],
        ["ASSETS", ""],
        ["Cash & bank", auto.cashAndBank ?? 0],
        ["Received, not yet in bank (undeposited funds)", auto.undepositedFunds ?? 0],
        ["Less: expenses paid, not yet matched in bank", -(auto.expensesPaidUnbanked ?? 0)],
        ["Accounts receivable", auto.receivables ?? 0],
        ["Project receivable", auto.projectReceivable ?? 0],
        ["TDS receivable", auto.tdsReceivable ?? 0],
        ["Employee loans", auto.employeeLoans ?? 0],
        ["Loans given", auto.loansGiven ?? 0],
        ["Advances to employees", advanceSplit.employee],
        ["Prepaid / vendor advances", advanceSplit.vendor],
        ["Fixed assets", auto.fixedAssets ?? 0],
        ["GST input credit (ITC)", gstCredit],
        [`Advance tax paid (${auto.fyLabel})`, auto.advanceTaxPaid ?? 0],
        ...manualAssetRows.map((r): [string, number] => [r.label, r.amount]),
        ["Total assets", totalAssets],
        ["", ""],
        ["LIABILITIES", ""],
        ["Accounts payable", auto.payables ?? 0],
        ["Advances from customers", auto.advancesFromCustomers ?? 0],
        ["Salary payable", auto.salaryPayable ?? 0],
        ["Statutory dues payable", auto.salaryDuesPayable ?? 0],
        ["Reimbursements payable", auto.reimbursementsPayable ?? 0],
        ["Expenses payable", auto.expensesPayable ?? 0],
        ["Salary deductions held (other)", auto.salaryOtherDeductions ?? 0],
        ["Commission payable (partners)", auto.commissionsPayable ?? 0],
        ["Licence cost provision (estimate, no vendor bill yet)", licenceProvision ?? 0],
        ["Credit card payable", auto.creditCardPayable ?? 0],
        ["EMI loans payable", auto.emiLoansPayable ?? 0],
        ...(loansTaken.fromDirectors > 0 ? [["Loans from directors (unsecured)", loansTaken.fromDirectors] as [string, number]] : []),
        ["Business loans payable", loansTaken.others],
        ["GST payable", gstPayable],
        ...manualLiabRows.map((r): [string, number] => [r.label, r.amount]),
        ["Total liabilities", totalLiab],
        ["", ""],
        [`EQUITY — ${equity.heading.toUpperCase()}`, ""],
        ...equityCsvRows(equity.groups),
        ...((auto.openingBalanceAdjustments ?? 0) !== 0 ? [["Opening Balance Adjustments (invoices imported from Zoho Books)", auto.openingBalanceAdjustments ?? 0] as [string, number]] : []),
        ["Unexplained difference (balancing figure)", unexplained ?? retained],
        ["Net worth (total equity)", netWorth],
      ],
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Balance Sheet</h1>
          <p className="text-sm text-ink-3 mt-1">
            What you own vs what you owe · as of {formatDate(today)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon="download" onClick={exportCSV} disabled={loading || !auto}>
            Export CSV
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add line
          </Button>
        </div>
      </div>

      {/* Headline summary — Net worth reads FIRST (was buried at the very bottom
          after ~15 detail lines). Assets · Liabilities · Net worth up top. */}
      {!loading && !failed && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          <Card className="min-w-0 p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total assets</div>
            <div className="font-serif text-xl sm:text-2xl mt-1 tabular-nums break-words text-ink">{fmtBS(totalAssets, { compact: true })}</div>
          </Card>
          <Card className="min-w-0 p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total liabilities</div>
            <div className="font-serif text-xl sm:text-2xl mt-1 tabular-nums break-words text-ink">{fmtBS(totalLiab, { compact: true })}</div>
          </Card>
          <Card className="min-w-0 col-span-2 sm:col-span-1 p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Net worth</div>
            <div className={`font-serif text-xl sm:text-2xl mt-1 tabular-nums break-words ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>{fmtBS(netWorth, { compact: true })}</div>
          </Card>
        </div>
      )}

      {/* Honesty note */}
      <Card className="mb-6 bg-paper-2/40 p-3">
        <p className="text-xs text-ink-3 leading-relaxed flex items-start gap-1.5">
          <Icon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>
            Auto figures (cash &amp; bank, receivables, TDS, payables, GST) come from your
            ResellerOS records. Add manual lines for anything the app doesn&apos;t track —
            fixed assets, loans, owner&apos;s opening capital — to make this a complete,
            CA-ready sheet{words.allowed ? <> (money the {words.person} takes out goes in <b>{words.register}</b> below)</> : null}. <b>Retained earnings comes from the P&amp;L; whatever the sheet still needs to balance is shown separately as an unexplained difference.</b>
          </span>
        </p>
      </Card>

      {/* Financial-health / solvency indicator — prominent rose banner when net
          worth is negative, subtle green strip when solvent. Shows the key
          liquidity + leverage ratios with plain-English tooltips. */}
      {!loading && !failed && auto && (
        <Card className={`mb-6 p-4 ${netWorth < 0 ? "border-rose/40 bg-rose/5" : "border-emerald/30 bg-emerald-soft/20"}`}>
          <div className="flex items-start gap-3">
            <Icon name={netWorth < 0 ? "alert" : "check_circle"} size={18} className={`mt-0.5 shrink-0 ${netWorth < 0 ? "text-rose" : "text-emerald"}`} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${netWorth < 0 ? "text-rose" : "text-emerald"}`}>
                {netWorth < 0
                  ? `Net worth negative — liabilities exceed assets by ${rupee(Math.abs(netWorth))}`
                  : "Solvent — assets exceed liabilities"}
              </p>
              <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">
                {netWorth < 0
                  ? `Books show the business owes more than it owns. Add ${profile.capitalLabel.toLowerCase()}, collect receivables, or clear dues to turn this positive.`
                  : "Healthy net worth. Keep the current ratio above 1 to comfortably cover short-term dues."}
              </p>
              <div className="flex gap-x-6 gap-y-2 flex-wrap mt-2.5">
                <Ratio label="Current ratio"  value={currentRatio == null ? "—" : currentRatio.toFixed(2)}
                  good={currentRatio != null && currentRatio >= 1}
                  tip="Current assets ÷ current liabilities. ≥ 1 means short-term dues are covered." />
                <Ratio label="Debt-to-equity" value={debtToEquity == null ? "n/a" : debtToEquity.toFixed(2)}
                  good={debtToEquity != null && debtToEquity <= 2}
                  tip="Total liabilities ÷ net worth. Lower = less leveraged. n/a when equity is negative." />
                <Ratio label="Net worth" value={fmtBS(netWorth)} good={netWorth >= 0}
                  tip="Total assets − total liabilities." />
              </div>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2].map((i) => <Skeleton key={i} className="h-96 rounded-lg" />)}
        </div>
      ) : failed ? (
        <LoadError what="Balance sheet" onRetry={() => { void refetchAuto(); void refetchItems(); }} />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── ASSETS ── */}
            <Card className="p-5 md:p-6">
              <SectionTitle>Assets</SectionTitle>
              <div className="space-y-1 mt-3">
                <BSLine label="Cash & bank balances" amount={auto?.cashAndBank ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                {(auto?.undepositedFunds ?? 0) !== 0 && (
                  <BSLine label="Received, not yet in bank" hint="customer receipts not matched to a bank line yet" amount={auto?.undepositedFunds ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                )}
                {(auto?.expensesPaidUnbanked ?? 0) > 0 && (
                  <BSLine label="Less: expenses paid, not yet in bank" hint="cash / UPI expenses marked paid, no bank line matched yet — match them in Banking" amount={-(auto?.expensesPaidUnbanked ?? 0)} kind="auto" source="Expenses" href="/accounting/banking" />
                )}
                <BSLine label="Trade receivables" hint="invoiced but unpaid (excl. projects)" amount={auto?.receivables ?? 0} kind="auto" source="unpaid invoices" href="/invoices" />
                {(auto?.projectReceivable ?? 0) > 0 && (
                  <BSLine label="Project receivables" hint="one-time / custom project sales, unpaid" amount={auto?.projectReceivable ?? 0} kind="auto" source="project invoices" href="/invoices" />
                )}
                <BSLine label="TDS receivable" hint="credits from customers' TDS" amount={auto?.tdsReceivable ?? 0} kind="auto" source="TDS Receivable" href="/accounting/tds-receivable" />
                {(auto?.employeeLoans ?? 0) > 0 && (
                  <BSLine label="Employee loans" hint="lent to staff, owed back (office-expense advances are their own line)" amount={auto?.employeeLoans ?? 0} kind="auto" source="Loans" href="/accounting/loans" />
                )}
                {(auto?.loansGiven ?? 0) > 0 && (
                  <BSLine label="Loans given" hint="lent to outside parties, still owed back" amount={auto?.loansGiven ?? 0} kind="auto" source="Loans given" href="/accounting/loans-given" />
                )}
                {advanceSplit.employee > 0 && (
                  <BSLine label="Advances to employees" hint="office-expense money still with staff (given − bills − returned)" amount={advanceSplit.employee} kind="auto" source="Advances" href="/accounting/advances" />
                )}
                {advanceSplit.vendor > 0 && (
                  <BSLine label="Prepaid / vendor advances" hint="paid, not yet consumed" amount={advanceSplit.vendor} kind="auto" source="Prepaid" href="/accounting/prepaid" />
                )}
                {(auto?.fixedAssets ?? 0) > 0 && (
                  <BSLine label="Fixed assets" hint={auto?.fixedAssetsCost != null && auto.accumulatedDepreciation != null
                    ? `net block: cost ${rupee(auto.fixedAssetsCost)} − depreciation ${rupee(auto.accumulatedDepreciation)} charged in the P&L (Income-tax WDV rates)`
                    : "register at WDV (Income-tax rates) + EMI purchases not yet registered, at cost"} amount={auto?.fixedAssets ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
                )}
                {gstCredit > 0 && <BSLine label="GST input credit (ITC)" amount={gstCredit} kind="auto" source="GST Reports" href="/accounting/gst" />}
                {(auto?.advanceTaxPaid ?? 0) > 0 && (
                  <BSLine label="Advance tax paid" hint={`advance + self-assessment income tax, ${auto?.fyLabel ?? "this FY"}`} amount={auto?.advanceTaxPaid ?? 0} kind="auto" source="Banking (tax payments)" href="/accounting/banking" />
                )}
                <ManualLines
                  rows={manualAssetRows}
                  onEdit={setEditItem}
                  onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                />
              </div>
              <TotalLine label="Total Assets" amount={totalAssets} />
            </Card>

            {/* ── LIABILITIES + EQUITY ── */}
            <Card className="p-5 md:p-6">
              <SectionTitle>Liabilities</SectionTitle>
              <div className="space-y-1 mt-3">
                <BSLine label="Trade payables" hint="unpaid vendor bills" amount={auto?.payables ?? 0} kind="auto" source="COGS Bills" href="/accounting/bills" />
                {(auto?.advancesFromCustomers ?? 0) > 0 && (
                  <BSLine label="Advances from customers" hint="paid to you, not yet invoiced — service still owed" amount={auto?.advancesFromCustomers ?? 0} kind="auto" source="advance receipts" href="/invoices" />
                )}
                {(auto?.salaryPayable ?? 0) > 0 && (
                  <BSLine label="Salary payable" hint="payroll run, not yet paid out" amount={auto?.salaryPayable ?? 0} kind="auto" source="Payroll" href="/accounting/payroll" />
                )}
                {(auto?.salaryDuesPayable ?? 0) > 0 && (
                  <BSLine label="Statutory dues payable" hint="TDS (salary + vendor + partner commission), PF, ESI — not yet remitted" amount={auto?.salaryDuesPayable ?? 0} kind="auto" source="Payroll" href="/accounting/payroll" />
                )}
                {(auto?.reimbursementsPayable ?? 0) > 0 && (
                  <BSLine label="Reimbursements payable" hint="expenses paid from someone's own card, not yet repaid" amount={auto?.reimbursementsPayable ?? 0} kind="auto" source="Reimbursements" href="/accounting/reimbursements" />
                )}
                {(auto?.expensesPayable ?? 0) > 0 && (
                  <BSLine label="Expenses payable" hint="expenses marked unpaid (after TDS)" amount={auto?.expensesPayable ?? 0} kind="auto" source="Expenses" href="/accounting/expenses" />
                )}
                {(auto?.salaryOtherDeductions ?? 0) > 0 && (
                  <BSLine label="Salary deductions held" hint={'"other" deductions withheld from salary, owed onward or back'} amount={auto?.salaryOtherDeductions ?? 0} kind="auto" source="Payroll" href="/accounting/payroll" />
                )}
                {(auto?.commissionsPayable ?? 0) > 0 && (
                  <BSLine label="Commission payable (partners)" hint="partner commission earned, not yet paid (after TDS)" amount={auto?.commissionsPayable ?? 0} kind="auto" source="Referrals" />
                )}
                {(licenceProvision ?? 0) > 0 && (
                  <BSLine label="Licence cost provision (estimate)" hint="licence cost the P&L estimates from your wholesale rates — no vendor bill entered yet" amount={licenceProvision ?? 0} kind="auto" source="P&L" href="/accounting/pnl" />
                )}
                {(auto?.creditCardPayable ?? 0) > 0 && (
                  <BSLine label="Credit card payable" hint="amount owed on company credit cards" amount={auto?.creditCardPayable ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                )}
                {(auto?.emiLoansPayable ?? 0) > 0 && (
                  <BSLine label="EMI / asset loans" hint="outstanding financing on purchases" amount={auto?.emiLoansPayable ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
                )}
                {loansTaken.fromDirectors > 0 && (
                  <BSLine
                    label="Loans from directors"
                    hint={undeclared > 0
                      ? `unsecured — ${undeclared} without the director's written declaration on file`
                      : "unsecured — money the directors lent the company"}
                    amount={loansTaken.fromDirectors} kind="auto" source="Business Loans" href="/accounting/business-loans"
                  />
                )}
                {loansTaken.others > 0 && (
                  <BSLine label="Bank / business loans" hint="outstanding principal on borrowings" amount={loansTaken.others} kind="auto" source="Business Loans" href="/accounting/business-loans" />
                )}
                {gstPayable > 0 && (
                  <BSLine
                    label="GST payable"
                    hint={(auto?.gstPaid ?? 0) > 0
                      ? `net, ${auto?.fyLabel ?? "this FY"} — after ${rupee(auto?.gstPaid ?? 0)} already paid`
                      : `net, ${auto?.fyLabel ?? "this FY"} — before filing`}
                    amount={gstPayable} kind="auto" source="GST Reports" href="/accounting/gst"
                  />
                )}
                <ManualLines
                  rows={manualLiabRows}
                  onEdit={setEditItem}
                  onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                />
              </div>
              <TotalLine label="Total Liabilities" amount={totalLiab} muted />

              <div className="mt-6">
                <SectionTitle>{equity.heading}</SectionTitle>
                <div className="space-y-1 mt-3">
                  {equity.groups.map((g) => (
                    <div key={g.key} className={g.title ? "pt-1" : ""}>
                      {g.title && <p className="text-xs font-semibold uppercase tracking-wider text-ink-3 pb-0.5">{g.title}</p>}
                      {g.rows.map((r) => r.kind === "manual" ? (
                        <ManualLines key={r.key} rows={r.items} onEdit={setEditItem}
                          onDelete={async (row) => { if (await confirm({ title: "Remove line?", body: `Remove "${row.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(row.id); }} />
                      ) : (
                        <BSLine key={r.key} label={r.label} hint={r.hint} amount={r.amount} kind={r.origin} source={r.source} href={r.href} />
                      ))}
                      {g.total && (
                        <div className="flex items-start justify-between gap-3 py-1.5 border-t border-hairline mt-1">
                          <span className="text-sm text-ink font-medium">
                            {g.total.label}
                            <span className="block text-xs text-ink-3 font-normal">{g.total.hint}</span>
                          </span>
                          <span className="text-sm font-semibold tabular-nums">{fmtBS(g.total.amount)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {/* R-1848: each partner's capital account — breaks the section total down, never changes it. */}
                  {words.needsPartner && !movementsMissing && (
                    <PartnerCapitalBox partners={partners} movements={movements} profit={cumulativeProfit} posted={splits}
                      range={equityRange} sectionTotal={cumulativeProfit === null ? null : equitySectionTotal(equity)} />
                  )}
                  {/* R-1739: Cr side of the balances imported from Zoho Books (their Dr is in receivables). */}
                  {(auto?.openingBalanceAdjustments ?? 0) !== 0 && (
                    <BSLine label="Opening Balance Adjustments" hint="balance due on invoices imported from Zoho Books, as imported — account name to confirm with your CA" amount={auto?.openingBalanceAdjustments ?? 0} kind="auto" source="Zoho import" href="/invoices" />
                  )}
                  {equity.shareCapitalTwice && (
                    <p className="text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1.5 my-1">
                      Share capital now comes from the share capital register, and a hand-entered share capital line above is counted too. If it is the same money, delete the hand-entered line.
                    </p>
                  )}
                  {drawingsTwice && (
                    <p className="text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1.5 my-1">
                      A hand-entered Drawings line above and the recorded drawings are both counted. If they are the same money, delete the hand-entered line.
                    </p>
                  )}
                  {(unexplained === null || unexplained !== 0) && (
                    <BSLine
                      label="Unexplained difference"
                      hint={unexplained === null ? "assets − liabilities − equity, before the P&L loads" : unexplained > 0 ? "assets exceed what the books explain — an opening balance, capital or income not entered" : "liabilities exceed what the books explain — drawings, a loss or an expense not entered"}
                      amount={unexplained ?? retained}
                      kind="derived"
                      onInfo={() => setRetainedInfoOpen((o) => !o)}
                    />
                  )}
                  {retainedInfoOpen && (
                    <div className="mt-1 mb-1 rounded-md border border-hairline bg-paper-2/40 p-3 text-[12px] text-ink-2 leading-relaxed">
                      <p className="font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                        <Icon name="info" size={13} className="text-amber-ink" /> What the unexplained difference is
                      </p>
                      <p className="mb-2">
                        <b>Assets = Liabilities + Equity</b> must hold. Equity per the books is {profile.capitalLabel.toLowerCase()} (hand-entered lines)
                        plus the profit from the P&amp;L. Whatever is left over is an entry the books don&apos;t have —
                        it is shown here as a <b>balancing figure</b>, not hidden inside retained earnings.
                      </p>
                      <div className="font-mono text-xs space-y-1 bg-paper rounded p-2 border border-hairline">
                        <div className="flex justify-between gap-3"><span>Total assets</span><span className="tabular-nums">{fmtBS(totalAssets)}</span></div>
                        <div className="flex justify-between gap-3"><span>− Total liabilities</span><span className="tabular-nums">{fmtBS(totalLiab)}</span></div>
                        <div className="flex justify-between gap-3"><span>− {profile.capitalLabel} &amp; other hand-entered equity</span><span className="tabular-nums">{fmtBS(netWorth - retained)}</span></div>
                        {registerShareCapital(equity) !== 0 && (
                          <div className="flex justify-between gap-3"><span>− Share capital (share capital register)</span><span className="tabular-nums">{fmtBS(registerShareCapital(equity))}</span></div>
                        )}
                        {opening && (
                          <div className="flex justify-between gap-3"><span>− Opening capital + profit b/f (CA)</span><span className="tabular-nums">{fmtBS(openingEquity)}</span></div>
                        )}
                        <div className="flex justify-between gap-3"><span>{opening ? "− Profit since the opening date (P&L)" : "− Profit (P&L, all periods)"}</span><span className="tabular-nums">{fmtBS(cumulativeProfit ?? 0)}</span></div>
                        {hasOwnerEntries && (
                          <div className="flex justify-between gap-3"><span>− Capital introduced + drawings (entries)</span><span className="tabular-nums">{fmtBS(ownerTotals.capitalIntroduced - ownerTotals.drawings)}</span></div>
                        )}
                        {partnerTds !== 0 && (
                          <div className="flex justify-between gap-3"><span>− TDS on partners&apos; interest &amp; remuneration (profit split)</span><span className="tabular-nums">{fmtBS(-partnerTds)}</span></div>
                        )}
                        <div className="flex justify-between gap-3 border-t border-hairline pt-1 font-semibold text-ink"><span>= Unexplained difference</span><span className="tabular-nums">{fmtBS(unexplained ?? retained)}</span></div>
                      </div>
                      <p className="mt-2 text-xs text-ink-3">
                        {words.allowed
                          ? `Usual causes: bank opening balances entered without the matching capital line, money the ${words.person} took out without an entry, or income / expense that never reached the books. Record the missing drawings (date, amount, account) or add the capital line and this goes to zero.`
                          : "Usual causes: bank opening balances entered without the matching share capital line, money paid to a director that was not booked (salary, loan, reimbursement), or income / expense that never reached the books."}
                      </p>
                      {unexplained !== null && unexplained !== 0 && (unexplained > 0 || words.allowed) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {/* R-1851: with the share register in use, shares are added there, not as a hand-entered line. */}
                          {profile.type === "pvt_ltd" && unexplained > 0 && registerShareCapital(equity) !== 0 ? (
                            <span className="text-xs text-ink-2">Shares issued? Add them in Settings → Company → Share capital.</span>
                          ) : (
                            <Button size="sm" variant="primary" loading={createItem.isPending} onClick={() => void bookUnexplained("capital")}>
                              {unexplained > 0 ? `Add ${profile.capitalLabel} ${rupee(unexplained)}` : `Record ${words.drawings.toLowerCase()} ${rupee(-unexplained)}`}
                            </Button>
                          )}
                          {unexplained > 0 && profile.type === "pvt_ltd" && (
                            <Button size="sm" loading={createItem.isPending} onClick={() => void bookUnexplained("director_loan")}>
                              Loan from director {rupee(unexplained)}
                            </Button>
                          )}
                          <span className="text-xs text-ink-3">
                            {unexplained > 0
                              ? profile.type === "pvt_ltd"
                                ? "Shares issued → Share capital. Money a director lent the company → Loan from director (a liability). You can edit or delete the line later."
                                : "One click adds the equity line and the difference becomes zero. You can edit or delete it later."
                              : "Pick the date and the account the money left from — split it into several entries if it was taken out more than once."}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <TotalLine label="Total Equity" amount={netWorth} muted />
              </div>

              <div className="mt-4 border-t-2 border-ink pt-3">
                <TotalLine label="Total Liabilities + Equity" amount={totalLiab + netWorth} />
              </div>
            </Card>
          </div>

          <OpeningBalancesCard capitalLabel={profile.capitalLabel} opening={opening} loading={openingQ.isLoading} failed={openingQ.isError} fyStart={`${fyOf(today)}-04-01`} today={today} />

          {!movementsMissing && (
            <OwnerEquityCard words={words} movements={movements} partners={partners} loading={movementsQ.isLoading} error={movementsQ.error}
              onRetry={() => void movementsQ.refetch()} onRecord={setRecordInit} />
          )}

          {/* Balance check — always balanced by construction */}
          <Card className="mt-6 p-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Icon name="check_circle" size={18} className="text-emerald" />
              <span className="text-sm text-ink-2">
                Balanced: <b>Assets {fmtBS(totalAssets)}</b> = <b>Liabilities + Equity {fmtBS(totalLiab + netWorth)}</b>
              </span>
            </div>
            <span className={`font-serif text-xl sm:text-2xl tabular-nums break-words ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>
              Net worth {fmtBS(netWorth)}
            </span>
          </Card>
        </>
      )}

      <AddLineDialog open={addOpen} onClose={() => setAddOpen(false)} businessType={businessType} hideDrawings={words.allowed && !movementsMissing}
        onRecordDrawings={() => { setAddOpen(false); setRecordInit({ kind: "drawings" }); }} />
      {editItem && <EditLineDialog item={editItem} onClose={() => setEditItem(null)} />}
      <RecordOwnerEquityDialog init={recordInit} words={words} partners={partners} onClose={() => setRecordInit(null)} />
    </div>
  );
}
