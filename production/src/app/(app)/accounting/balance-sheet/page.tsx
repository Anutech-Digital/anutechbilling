/**
 * Balance Sheet — statement of financial position.
 *
 * Assets = Liabilities + Equity, as of today. Auto figures come from ResellerOS
 * records (cash & bank, receivables, TDS receivable, payables, GST); the
 * operator adds manual lines for what the app doesn't track (fixed assets,
 * loans, owner's capital, drawings). Equity's "retained earnings" is derived so
 * the sheet always balances.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";
import {
  useBalanceSheetAuto,
  useBalanceSheetItems,
  useCreateBalanceSheetItem,
  useUpdateBalanceSheetItem,
  useDeleteBalanceSheetItem,
  useOpeningBalances,
  useSetOpeningBalances,
  type BalanceSheetItem,
  type OpeningBalances,
} from "@/lib/queries/balance-sheet";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";
import { usePnL, BOOKS_START } from "@/lib/queries/pnl";
import { balanceSheetTotals } from "@/lib/accounting/balance-sheet-totals";
import { istToday, addDaysISO } from "@/lib/dates/ist";
import { fyOf } from "@/lib/accounting/ledger";
import { fmtBS, parseWholeRupees } from "./format";

export default function BalanceSheetPage() {
  const { data: auto, isLoading: autoLoading, isError: autoFailed, refetch: refetchAuto } = useBalanceSheetAuto();
  const { data: items, isLoading: itemsLoading, isError: itemsFailed, refetch: refetchItems } = useBalanceSheetItems();
  const del = useDeleteBalanceSheetItem();
  const confirm = useConfirm();
  /* D16 (27 Sep 2026): the unexplained difference is almost always the owner's money that
     never got a line — capital put in, or drawings taken out. One click books it. */
  const createItem = useCreateBalanceSheetItem();
  async function bookUnexplained() {
    if (unexplained === null || unexplained === 0) return;
    const capital = unexplained > 0;
    const ok = await confirm({
      title: capital ? `Owner's capital ${rupee(unexplained)} jodein?` : `Drawings ${rupee(-unexplained)} jodein?`,
      body: capital
        ? "Assets books se zyada hain — matlab itna paisa business mein daala gaya jiski entry nahi thi (opening bank balance, khud ka paisa). Equity mein Owner's capital line banegi."
        : "Liabilities books se zyada hain — matlab itna paisa business se nikala gaya jiski entry nahi thi. Equity mein Drawings (negative) line banegi. Agar ye koi kharcha ya loss hai jo books mein nahi, to pehle wo entry karo.",
      confirmLabel: "Haan, line banao", cancelLabel: "Nahi",
    });
    if (!ok) return;
    await createItem.mutateAsync({
      section: "equity", label: capital ? "Owner's capital" : "Drawings", amount: unexplained,
      notes: `Balance Sheet ke unexplained difference se ${today} ko banaya — cumulative P&L se bacha hua farq.`,
    });
  }
  const [addOpen, setAddOpen] = React.useState(false);
  const [editItem, setEditItem] = React.useState<BalanceSheetItem | null>(null);
  const [retainedInfoOpen, setRetainedInfoOpen] = React.useState(false);
  const today = istToday();

  const loading = autoLoading || itemsLoading;
  /* R-270: a failed fetch must not print a ₹0 balance sheet that reads as "you own nothing". */
  const failed = autoFailed || itemsFailed;

  const manual = (section: BalanceSheetSection) => (items ?? []).filter((i) => i.section === section);
  const manualAssetRows = manual("asset");
  const manualLiabRows  = manual("liability");
  const manualEqRows    = manual("equity");

  /* Totals + solvency ratios ek tested pure function me (lib/accounting/balance-sheet-totals.ts).
     R-179: "Received, not yet in bank" bhi asset hai, Cash & bank ke saath — warna bina bank
     account wale workspace me mila hua paisa sirf liability (advance) me dikhta tha. */
  const {
    gstCredit, gstPayable, totalAssets, totalLiab, netWorth, retained, currentRatio, debtToEquity,
  } = balanceSheetTotals(auto, items ?? []);
  /* Retained earnings PER THE BOOKS — cumulative net profit from the P&L, all periods
     (27 Sep 2026). The plug above used to be shown AS retained earnings, which hid every
     missing entry inside a number that always looked right. Now the P&L figure is the
     retained earnings, and the gap between the two is printed as what it is. */
  /* S45 slice 2: CA ke opening balances bhare hon to retained earnings = unke "b/f" + us
     tareekh ke BAAD ka P&L; warna pehle jaisa — saare periods ka P&L. Opening query aane tak
     P&L nahi chalta (ek bekaar all-periods aggregation bachti hai). */
  const openingQ = useOpeningBalances();
  const opening: OpeningBalances | null = openingQ.data ?? null;
  const profitFrom = opening ? addDaysISO(opening.asOf, 1) : BOOKS_START;
  const profitRangeOpen = profitFrom <= today;
  const cumulative = usePnL({ from: profitRangeOpen ? profitFrom : today, to: today }, openingQ.data !== undefined && profitRangeOpen);
  const cumulativeProfit = openingQ.data === undefined ? null
    : !profitRangeOpen ? 0
    : cumulative.data ? (cumulative.data.model.netProfit ?? cumulative.data.netProfit) : null;
  const openingEquity = (opening?.ownerCapital ?? 0) + (opening?.retainedEarnings ?? 0);
  const unexplained = cumulativeProfit === null ? null : retained - openingEquity - cumulativeProfit;


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
        ["Employee loans (advances)", auto.employeeLoans ?? 0],
        ["Loans given", auto.loansGiven ?? 0],
        ["Prepaid / vendor advances", auto.prepaidAdvances ?? 0],
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
        ["Credit card payable", auto.creditCardPayable ?? 0],
        ["EMI loans payable", auto.emiLoansPayable ?? 0],
        ["Business loans payable", auto.businessLoansPayable ?? 0],
        ["GST payable", gstPayable],
        ...manualLiabRows.map((r): [string, number] => [r.label, r.amount]),
        ["Total liabilities", totalLiab],
        ["", ""],
        ["EQUITY", ""],
        ...manualEqRows.map((r): [string, number] => [r.label, r.amount]),
        ...(opening ? [
          [`Owner's capital (opening, from CA, ${opening.asOf})`, opening.ownerCapital ?? 0] as [string, number],
          [`Retained earnings b/f (from CA, ${opening.asOf})`, opening.retainedEarnings ?? 0] as [string, number],
          [`Profit since ${opening.asOf} (per P&L)`, cumulativeProfit ?? ""] as [string, number | string],
        ] : [
          ["Retained earnings (cumulative net profit per P&L)", cumulativeProfit ?? ""] as [string, number | string],
        ]),
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
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card className="p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total assets</div>
            <div className="font-serif text-2xl mt-1 tabular-nums text-ink">{fmtBS(totalAssets, { compact: true })}</div>
          </Card>
          <Card className="p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total liabilities</div>
            <div className="font-serif text-2xl mt-1 tabular-nums text-ink">{fmtBS(totalLiab, { compact: true })}</div>
          </Card>
          <Card className="p-4">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Net worth</div>
            <div className={`font-serif text-2xl mt-1 tabular-nums ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>{fmtBS(netWorth, { compact: true })}</div>
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
            fixed assets, loans, owner&apos;s capital, drawings — to make this a complete,
            CA-ready sheet. <b>Retained earnings comes from the P&amp;L; whatever the sheet still needs to balance is shown separately as an unexplained difference.</b>
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
                  ? "Books show the business owes more than it owns. Add owner's capital, collect receivables, or clear dues to turn this positive."
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
                  <BSLine label="Employee loans / advances" hint="outstanding, owed back" amount={auto?.employeeLoans ?? 0} kind="auto" source="Loans" href="/accounting/loans" />
                )}
                {(auto?.loansGiven ?? 0) > 0 && (
                  <BSLine label="Loans given" hint="lent to outside parties, still owed back" amount={auto?.loansGiven ?? 0} kind="auto" source="Loans given" href="/accounting/loans-given" />
                )}
                {(auto?.prepaidAdvances ?? 0) > 0 && (
                  <BSLine label="Prepaid / vendor advances" hint="paid, not yet consumed" amount={auto?.prepaidAdvances ?? 0} kind="auto" source="Prepaid" href="/accounting/prepaid" />
                )}
                {(auto?.fixedAssets ?? 0) > 0 && (
                  <BSLine label="Fixed assets" hint="register at WDV (Income-tax rates) + EMI purchases not yet registered, at cost" amount={auto?.fixedAssets ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
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
                  <BSLine label="Statutory dues payable" hint="TDS (salary + vendor), PF, ESI — not yet remitted" amount={auto?.salaryDuesPayable ?? 0} kind="auto" source="Payroll" href="/accounting/payroll" />
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
                {(auto?.creditCardPayable ?? 0) > 0 && (
                  <BSLine label="Credit card payable" hint="company credit cards ka owe / udhari" amount={auto?.creditCardPayable ?? 0} kind="auto" source="Banking" href="/accounting/banking" />
                )}
                {(auto?.emiLoansPayable ?? 0) > 0 && (
                  <BSLine label="EMI / asset loans" hint="outstanding financing on purchases" amount={auto?.emiLoansPayable ?? 0} kind="auto" source="Assets & EMIs" href="/accounting/assets" />
                )}
                {(auto?.businessLoansPayable ?? 0) > 0 && (
                  <BSLine label="Bank / business loans" hint="outstanding principal on borrowings" amount={auto?.businessLoansPayable ?? 0} kind="auto" source="Business Loans" href="/accounting/business-loans" />
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
                <SectionTitle>Equity (net worth)</SectionTitle>
                <div className="space-y-1 mt-3">
                  <ManualLines
                    rows={manualEqRows}
                    onEdit={setEditItem}
                    onDelete={async (r) => { if (await confirm({ title: "Remove line?", body: `Remove "${r.label}" from the balance sheet?`, confirmLabel: "Remove", danger: true })) del.mutate(r.id); }}
                  />
                  {opening && (opening.ownerCapital ?? 0) !== 0 && (
                    <BSLine label="Owner's capital (opening)" hint={`from your CA, as at ${formatDate(opening.asOf)}`} amount={opening.ownerCapital ?? 0} kind="manual" source="Opening balances" />
                  )}
                  {opening && (opening.retainedEarnings ?? 0) !== 0 && (
                    <BSLine label="Retained earnings b/f" hint={`earlier years' profit from your CA, as at ${formatDate(opening.asOf)}`} amount={opening.retainedEarnings ?? 0} kind="manual" source="Opening balances" />
                  )}
                  <BSLine
                    label={opening ? `Profit since ${formatDate(opening.asOf)}` : "Retained earnings"}
                    hint={cumulativeProfit === null ? "net profit per P&L — loading…" : opening ? "net profit per P&L after the opening date" : "cumulative net profit per P&L, all periods"}
                    amount={cumulativeProfit ?? 0}
                    kind="auto" source="P&L" href="/accounting/pnl"
                  />
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
                        <b>Assets = Liabilities + Equity</b> must hold. Equity per the books is owner&apos;s capital (manual lines)
                        plus retained earnings from the P&amp;L. Whatever is left over is an entry the books don&apos;t have —
                        it is shown here as a <b>balancing figure</b>, not hidden inside retained earnings.
                      </p>
                      <div className="font-mono text-xs space-y-1 bg-paper rounded p-2 border border-hairline">
                        <div className="flex justify-between gap-3"><span>Total assets</span><span className="tabular-nums">{fmtBS(totalAssets)}</span></div>
                        <div className="flex justify-between gap-3"><span>− Total liabilities</span><span className="tabular-nums">{fmtBS(totalLiab)}</span></div>
                        <div className="flex justify-between gap-3"><span>− Owner&apos;s capital &amp; other manual equity</span><span className="tabular-nums">{fmtBS(netWorth - retained)}</span></div>
                        {opening && (
                          <div className="flex justify-between gap-3"><span>− Opening capital + retained earnings b/f (CA)</span><span className="tabular-nums">{fmtBS(openingEquity)}</span></div>
                        )}
                        <div className="flex justify-between gap-3"><span>{opening ? "− Profit since the opening date (P&L)" : "− Retained earnings (P&L, all periods)"}</span><span className="tabular-nums">{fmtBS(cumulativeProfit ?? 0)}</span></div>
                        <div className="flex justify-between gap-3 border-t border-hairline pt-1 font-semibold text-ink"><span>= Unexplained difference</span><span className="tabular-nums">{fmtBS(unexplained ?? retained)}</span></div>
                      </div>
                      <p className="mt-2 text-xs text-ink-3">
                        Usual causes: bank opening balances entered without the matching capital line, owner drawings taken without an entry, or income / expense that never reached the books. Add the missing line (Owner&apos;s capital, Drawings) and this goes to zero.
                      </p>
                      {unexplained !== null && unexplained !== 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="primary" loading={createItem.isPending} onClick={bookUnexplained}>
                            {unexplained > 0 ? `Owner's capital ${rupee(unexplained)} jodo` : `Drawings ${rupee(-unexplained)} jodo`}
                          </Button>
                          <span className="text-xs text-ink-3">Ek click — equity line ban jaayegi, farq zero. Baad mein Edit/Delete kar sakte ho.</span>
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

          <OpeningBalancesCard opening={opening} loading={openingQ.isLoading} failed={openingQ.isError} fyStart={`${fyOf(today)}-04-01`} today={today} />

          {/* Balance check — always balanced by construction */}
          <Card className="mt-6 p-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Icon name="check_circle" size={18} className="text-emerald" />
              <span className="text-sm text-ink-2">
                Balanced: <b>Assets {fmtBS(totalAssets)}</b> = <b>Liabilities + Equity {fmtBS(totalLiab + netWorth)}</b>
              </span>
            </div>
            <span className={`font-serif text-2xl ${netWorth >= 0 ? "text-emerald" : "text-rose"}`}>
              Net worth {fmtBS(netWorth)}
            </span>
          </Card>
        </>
      )}

      <AddLineDialog open={addOpen} onClose={() => setAddOpen(false)} />
      {editItem && <EditLineDialog item={editItem} onClose={() => setEditItem(null)} />}
    </div>
  );
}

// ── Line + total primitives ─────────────────────────────────────────────────
/* S45 slice 2: CA ke opening balances. Khaali by default — app kabhi khud nahi bharta.
   Sirf owner badal sakta hai (set_opening_balances bhi yahi jaanchta hai); baaki dekh sakte hain. */
function OpeningBalancesCard({ opening, loading, failed, fyStart, today }: {
  opening: OpeningBalances | null; loading: boolean; failed: boolean; fyStart: string; today: string;
}) {
  const isOwner = useCurrentUser().data?.role === "owner";
  const save = useSetOpeningBalances();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState(false);
  const [asOf, setAsOf] = React.useState("");
  const [capital, setCapital] = React.useState("");
  const [reserves, setReserves] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  function startEdit() {
    setAsOf(opening?.asOf ?? addDaysISO(fyStart, -1));
    setCapital(opening?.ownerCapital != null ? String(opening.ownerCapital) : "");
    setReserves(opening?.retainedEarnings != null ? String(opening.retainedEarnings) : "");
    setNotes(opening?.notes ?? "");
    setErr(null);
    setEditing(true);
  }

  async function submit() {
    const c = parseWholeRupees(capital);
    const r = parseWholeRupees(reserves);
    if (c === "bad" || r === "bad") { setErr("Whole rupees only, e.g. 500000 (no paise)."); return; }
    if (c !== null && c < 0) { setErr("Owner's capital cannot be negative — add money taken out as a Drawings line."); return; }
    if (c === null && r === null) { setErr("Enter at least one figure, or use Remove."); return; }
    if (!asOf || asOf > today) { setErr("Pick the date of your CA's last balance sheet (not a future date)."); return; }
    await save.mutateAsync({ asOf, ownerCapital: c, retainedEarnings: r, notes: notes.trim() || null });
    setEditing(false);
  }

  async function remove() {
    if (!(await confirm({ title: "Remove opening balances?", body: "The Difference line comes back on the Balance Sheet and Trial Balance.", confirmLabel: "Remove", danger: true }))) return;
    await save.mutateAsync(null);
  }

  return (
    <Card id="opening-balances" className="mt-6 p-5 md:p-6 scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <SectionTitle>Opening balances</SectionTitle>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            Enter opening balances from your CA to remove the Difference line. Use the figures from your CA&apos;s last
            balance sheet (usually 31 March). If you already added an Owner&apos;s capital line above, don&apos;t enter it again here.
          </p>
        </div>
        {isOwner && !editing && !loading && !failed && (
          <div className="flex gap-2">
            <Button size="sm" variant={opening ? "default" : "primary"} icon={opening ? "edit" : "plus"} onClick={startEdit}>
              {opening ? "Edit" : "Enter opening balances"}
            </Button>
            {opening && <Button size="sm" variant="ghost" onClick={remove} loading={save.isPending}>Remove</Button>}
          </div>
        )}
      </div>

      {failed ? (
        <p role="alert" className="mt-3 text-sm text-rose">Could not load opening balances. Reload the page.</p>
      ) : loading ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : editing ? (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FormField label="As at (date of CA's balance sheet)" htmlFor="ob-as-of">
            <Input id="ob-as-of" name="ob-as-of" type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} />
          </FormField>
          <FormField label="Owner's capital (₹)" htmlFor="ob-capital">
            <Input id="ob-capital" name="ob-capital" inputMode="numeric" placeholder="From your CA" value={capital} onChange={(e) => setCapital(e.target.value)} />
          </FormField>
          <FormField label="Retained earnings b/f (₹, minus for a loss)" htmlFor="ob-retained">
            <Input id="ob-retained" name="ob-retained" inputMode="numeric" placeholder="From your CA" value={reserves} onChange={(e) => setReserves(e.target.value)} />
          </FormField>
          <div className="sm:col-span-3">
            <FormField label="Note (optional)" htmlFor="ob-notes">
              <Input id="ob-notes" name="ob-notes" maxLength={500} placeholder="e.g. As per audited balance sheet FY 2025-26" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </div>
          {err && <p role="alert" className="sm:col-span-3 text-sm text-rose">{err}</p>}
          <div className="sm:col-span-3 flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={submit} loading={save.isPending}>Save</Button>
          </div>
        </div>
      ) : opening ? (
        <div className="mt-3 space-y-1">
          <div className="text-xs text-ink-3">As at {formatDate(opening.asOf)}</div>
          <BSLine label="Owner's capital" amount={opening.ownerCapital ?? 0} hint={opening.ownerCapital == null ? "not entered" : undefined} />
          <BSLine label="Retained earnings b/f" amount={opening.retainedEarnings ?? 0} hint={opening.retainedEarnings == null ? "not entered" : undefined} />
          {opening.notes && <p className="text-xs text-ink-3">{opening.notes}</p>}
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-3">
          Not entered yet.{!isOwner && " Only the owner can enter these."}
        </p>
      )}
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold border-b border-hairline pb-2">
      {children}
    </h2>
  );
}


/** One solvency ratio chip inside the Financial-health banner. */
function Ratio({ label, value, good, tip }: { label: string; value: string; good: boolean; tip: string }) {
  return (
    <div title={tip} className="min-w-0">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-lg tabular-nums leading-tight ${good ? "text-emerald" : "text-rose"}`}>{value}</div>
    </div>
  );
}

/** Source-origin badge: 'auto' (pulled from records) vs 'manual' (owner-added)
 *  vs 'derived' (a balancing figure). Distinct colour + icon + explaining tooltip. */
function OriginBadge({ kind, source }: { kind: "auto" | "manual" | "derived"; source?: string }) {
  const cfg = {
    auto:    { icon: "sparkles" as const, cls: "bg-indigo/10 text-indigo",     text: "auto",    tip: source ? `Auto — from ${source}` : "Auto — pulled from your ResellerOS records" },
    manual:  { icon: "edit" as const,     cls: "bg-amber-soft text-amber-ink", text: "manual",  tip: "Manual — you added this line by hand" },
    derived: { icon: "zap" as const,      cls: "bg-slate-soft text-slate",     text: "derived", tip: "Derived — computed so the sheet balances" },
  }[kind];
  return (
    <span title={cfg.tip} className={`inline-flex items-center gap-0.5 rounded-full ${cfg.cls} px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide align-middle`}>
      <Icon name={cfg.icon} size={9} /> {cfg.text}
    </span>
  );
}

function BSLine({
  label, hint, amount, kind, source, href, onEdit, onDelete, onInfo,
}: {
  label: string; hint?: string; amount: number;
  kind?: "auto" | "manual" | "derived";
  source?: string; href?: string;
  onEdit?: () => void; onDelete?: () => void; onInfo?: () => void;
}) {
  const router = useRouter();
  /* R-255: a line links to its source page only when this role may open it — the guard used to
     send the accountant to the P&L, silently, from a link it could not follow. */
  const role = useCurrentUser().data?.role;
  const clickable = !!href && canOpenRoute(role, href);
  const go = () => { if (href && clickable) router.push(href as never); };
  return (
    <div
      className={`flex items-start justify-between gap-3 py-1.5 group rounded-md ${clickable ? "cursor-pointer hover:bg-paper-2/50 -mx-2 px-2" : ""}`}
      {...(clickable ? {
        role: "button", tabIndex: 0, onClick: go,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } },
        title: "Open the source ledger",
      } : {})}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-ink">{label}</span>
          {kind && <OriginBadge kind={kind} source={source} />}
          {onInfo && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onInfo(); }}
              className="text-ink-3 hover:text-amber-ink transition-colors" aria-label={`How ${label} is calculated`} title="How this is calculated">
              <Icon name="info" size={13} />
            </button>
          )}
          {clickable && <Icon name="arrow_right" size={12} className="text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity" />}
          {onEdit && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-ink transition-opacity" aria-label={`Edit ${label}`}>
              <Icon name="edit" size={12} />
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-rose transition-opacity" aria-label={`Remove ${label}`}>
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
        {hint && <div className="text-xs text-ink-3 mt-0.5 leading-snug">{hint}</div>}
      </div>
      <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${amount < 0 ? "text-rose" : "text-ink"}`}>
        {fmtBS(amount)}
      </span>
    </div>
  );
}

/** Manual lines for a section — identical labels (e.g. two "Owner's capital")
 *  fold under ONE parent showing the combined total, expandable to the entries. */
function ManualLines({
  rows, onEdit, onDelete,
}: {
  rows: BalanceSheetItem[];
  onEdit: (r: BalanceSheetItem) => void;
  onDelete: (r: BalanceSheetItem) => void;
}) {
  // Preserve first-seen order of labels.
  const order: string[] = [];
  const byLabel = new Map<string, BalanceSheetItem[]>();
  for (const r of rows) {
    if (!byLabel.has(r.label)) { byLabel.set(r.label, []); order.push(r.label); }
    byLabel.get(r.label)!.push(r);
  }
  return (
    <>
      {order.map((label) => {
        const rs = byLabel.get(label)!;
        if (rs.length === 1) {
          return <BSLine key={rs[0].id} label={label} amount={rs[0].amount} kind="manual"
            onEdit={() => onEdit(rs[0])} onDelete={() => onDelete(rs[0])} />;
        }
        return <ManualGroup key={label} label={label} rows={rs} onEdit={onEdit} onDelete={onDelete} />;
      })}
    </>
  );
}

function ManualGroup({
  label, rows, onEdit, onDelete,
}: {
  label: string; rows: BalanceSheetItem[];
  onEdit: (r: BalanceSheetItem) => void;
  onDelete: (r: BalanceSheetItem) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div>
      <div
        className="flex items-start justify-between gap-3 py-1.5 rounded-md cursor-pointer hover:bg-paper-2/50 -mx-2 px-2"
        role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
          <Icon name={open ? "chevron_down" : "arrow_right"} size={13} className="text-ink-3 shrink-0" />
          <span className="text-sm text-ink">{label}</span>
          <OriginBadge kind="manual" />
          <span className="text-xs text-ink-3">· {rows.length} entries</span>
        </div>
        <span className={`font-mono text-sm tabular-nums whitespace-nowrap shrink-0 ${total < 0 ? "text-rose" : "text-ink"}`}>{fmtBS(total)}</span>
      </div>
      {open && (
        <div className="pl-5 border-l border-hairline ml-1">
          {rows.map((r) => (
            <BSLine key={r.id} label={r.notes?.trim() || label} amount={r.amount}
              onEdit={() => onEdit(r)} onDelete={() => onDelete(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TotalLine({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <div className={`mt-3 pt-2 border-t ${muted ? "border-hairline" : "border-ink-2 border-t-2"} flex items-baseline justify-between gap-3`}>
      <span className={`${muted ? "text-sm text-ink-2" : "text-sm font-semibold text-ink"}`}>{label}</span>
      <span className={`font-mono tabular-nums whitespace-nowrap ${muted ? "text-base text-ink" : "font-serif text-xl text-ink"} ${amount < 0 ? "!text-rose" : ""}`}>
        {fmtBS(amount)}
      </span>
    </div>
  );
}

// ── Add manual line dialog ────────────────────────────────────────────────
const SECTIONS: { value: BalanceSheetSection; label: string; examples: string }[] = [
  { value: "asset",     label: "Asset",     examples: "Fixed assets, deposits, investments" },
  { value: "liability", label: "Liability", examples: "Bank loan, unsecured loan, other dues" },
  { value: "equity",    label: "Equity",    examples: "Owner's capital, drawings (as negative)" },
];

// Guided categories for the Add-line dialog — a non-CA owner picks what a line
// *is*, and we file it under the correct section automatically. `contra` items
// (drawings, depreciation) reduce their side, so we store them as negative even
// if the owner types a positive number — removing the classic sign mistake.
type BSCategory = {
  value: string; label: string; section: BalanceSheetSection;
  examples: string; contra?: boolean;
};
const CATEGORIES: BSCategory[] = [
  { value: "fixed_asset",     label: "Fixed asset",        section: "asset",     examples: "Laptop, furniture, vehicle, machinery" },
  { value: "current_asset",   label: "Deposit / advance",  section: "asset",     examples: "Security deposit, advance paid, investment" },
  { value: "depreciation",    label: "Depreciation (–)",   section: "asset",     examples: "Wear-down of a fixed asset — reduces its value", contra: true },
  { value: "long_term_loan",  label: "Long-term loan",     section: "liability", examples: "Bank term loan, vehicle / equipment loan" },
  { value: "short_term_due",  label: "Short-term due",     section: "liability", examples: "Unsecured loan, friend/family loan, other payable" },
  { value: "owners_capital",  label: "Owner's capital",    section: "equity",    examples: "Money you put into the business" },
  { value: "drawings",        label: "Owner's drawings (–)", section: "equity",  examples: "Money you took out for personal use", contra: true },
];

const schema = z.object({
  label:  z.string().min(2, "Name required"),
  amount: z.coerce.number().int(),
  notes:  z.string().optional(),
});
type FormData = z.infer<typeof schema>;

function EditLineDialog({ item, onClose }: { item: BalanceSheetItem; onClose: () => void }) {
  const update = useUpdateBalanceSheetItem();
  const [label, setLabel] = React.useState(item.label);
  const [amount, setAmount] = React.useState(String(item.amount));

  async function submit() {
    const amt = Math.round(Number(amount));
    if (!label.trim() || !Number.isFinite(amt)) return;
    await update.mutateAsync({ id: item.id, label: label.trim(), amount: amt });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Edit line</DialogTitle>
          <DialogDescription>Update this manual balance-sheet line — e.g. reduce a loan balance after an EMI.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="balance-sheet-label" className="block text-xs font-medium text-ink-2 mb-1">Label</label>
            <Input id="balance-sheet-label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </div>
          <div>
            <label htmlFor="balance-sheet-amount" className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input id="balance-sheet-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="mt-1 text-xs text-ink-3">Negative allowed (e.g. depreciation, drawings).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} disabled={!label.trim()} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateBalanceSheetItem();
  const [categoryValue, setCategoryValue] = React.useState<string>("fixed_asset");

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 0 },
  });

  React.useEffect(() => { if (!open) { reset(); setCategoryValue("fixed_asset"); } }, [open, reset]);

  const category = CATEGORIES.find((c) => c.value === categoryValue) ?? CATEGORIES[0];

  const onSubmit = async (data: FormData) => {
    // File under the category's section; contra items (drawings/depreciation)
    // are stored negative so they reduce their side even if typed positive.
    const amt = category.contra ? -Math.abs(data.amount) : data.amount;
    await create.mutateAsync({
      section: category.section,
      label: data.label.trim(),
      amount: amt,
      notes: category.label,          // remember what kind of line this is
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add balance-sheet line</DialogTitle>
          <DialogDescription>
            Add something the app doesn&apos;t track automatically — a fixed asset, a loan,
            owner&apos;s capital, etc. Pick what it is and we&apos;ll file it correctly.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="What kind of line?" required htmlFor="bs-category">
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger id="bs-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["asset", "liability", "equity"] as BalanceSheetSection[]).map((sec) => {
                  const group = CATEGORIES.filter((c) => c.section === sec);
                  const secLabel = SECTIONS.find((s) => s.value === sec)?.label ?? sec;
                  return (
                    <SelectGroup key={sec}>
                      <SelectLabel>{secLabel}</SelectLabel>
                      {group.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-ink-3 mt-1">
              Goes under <b>{SECTIONS.find((s) => s.value === category.section)?.label}</b> · e.g. {category.examples}
            </p>
          </FormField>

          <FormField label="Name" required htmlFor="bs-label">
            <Input id="bs-label" placeholder="e.g. Office laptop, HDFC term loan, Owner's capital" error={errors.label?.message} {...register("label")} />
          </FormField>

          <FormField label="Amount (₹)" required htmlFor="bs-amount">
            <Input id="bs-amount" type="number" prefix="₹" error={errors.amount?.message} {...register("amount")} />
            <p className="text-xs text-ink-3 mt-1">
              {category.contra
                ? "Just type the amount — we'll record it as a reduction automatically."
                : "Enter the current value / outstanding balance."}
            </p>
          </FormField>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting || create.isPending}>Add line</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
