/**
 * Trial Balance — CA ka pehla sawaal. Har head ka Dr / Cr, ek page par, aaj tak.
 *
 * Aankde naye nahi: Balance Sheet (report_balance_sheet) aur is FY ka P&L (report_pnl)
 * — lib/accounting/trial-balance.ts dono ko Tally jaisi shakal deta hai. "As of today"
 * isliye ki receivables / payables ke status ka itihaas record nahi hota; beeti tareekh ka
 * TB banana jhootha hota. Farq wali line saaf label ke saath dikhti hai — chhupti nahi.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { rupee, cn, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { localDateISO } from "@/lib/leads/outcomes";
import { fyOf } from "@/lib/accounting/ledger";
import { useBalanceSheetAuto, useBalanceSheetItems, useOpeningBalances } from "@/lib/queries/balance-sheet";
import { usePnL } from "@/lib/queries/pnl";
import { buildTrialBalance, trialBalanceCsvRows, type TbGroup } from "@/lib/accounting/trial-balance";

const GROUPS: TbGroup[] = ["Assets", "Liabilities", "Equity", "Income", "Expenses", "Difference"];

export default function TrialBalancePage() {
  const today = React.useMemo(() => localDateISO(new Date()), []);
  const fyStart = `${fyOf(today)}-04-01`;

  const bsQ = useBalanceSheetAuto();
  const itemsQ = useBalanceSheetItems();
  const pnlQ = usePnL({ from: fyStart, to: today });
  const openingQ = useOpeningBalances();

  const tb = React.useMemo(() => {
    if (!bsQ.data || !pnlQ.data || !itemsQ.data || openingQ.data === undefined) return null;
    return buildTrialBalance({ bs: bsQ.data, pnl: pnlQ.data, items: itemsQ.data, opening: openingQ.data });
  }, [bsQ.data, pnlQ.data, itemsQ.data, openingQ.data]);

  const error = bsQ.error ?? pnlQ.error ?? itemsQ.error ?? openingQ.error;

  const exportCsv = () => {
    if (!tb) return;
    downloadCSV(`trial-balance-${today}.csv`, ["Group", "Ledger head", "Debit (INR)", "Credit (INR)"], trialBalanceCsvRows(tb));
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Trial Balance</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            As of {formatDate(today)}. Balance-sheet heads are today&apos;s balances; income and expense heads are{" "}
            {tb?.fyLabel ?? "this FY"} to date. Same numbers as the{" "}
            <Link href="/accounting/balance-sheet" className="underline">Balance Sheet</Link> and{" "}
            <Link href="/accounting/pnl" className="underline">P&amp;L</Link>.
          </p>
        </div>
        <Button size="sm" onClick={exportCsv} disabled={!tb}>
          <Icon name="download" size={12} /> Export CSV
        </Button>
      </div>

      {error ? (
        <Card className="p-4 border-rose/40 bg-rose-soft/30">
          <p role="alert" className="text-sm text-ink-2">
            Could not build the Trial Balance: {(error as Error).message}
          </p>
        </Card>
      ) : !tb ? (
        <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : (
        <>
          {tb.difference !== 0 && (
            <Card className="p-4 mb-4 border-amber/40 bg-amber-soft/30">
              <p className="text-sm text-ink-2 leading-relaxed">
                <Icon name="alert" size={14} className="inline mr-1.5 align-text-bottom text-amber-ink" />
                The records alone differ by <b>{rupee(Math.abs(tb.difference))}</b>. ResellerOS keeps single-entry books,
                so that gap — earlier years&apos; profit, owner&apos;s capital, anything not recorded in the app — is shown on its
                own line at the bottom, not hidden inside another head.{" "}
                {openingQ.data
                  ? <>Opening balances from your CA are already in Equity; what is left is not recorded anywhere in the app.</>
                  : <>Enter opening balances from your CA on the{" "}
                      <Link href="/accounting/balance-sheet#opening-balances" className="underline">Balance Sheet</Link> to remove the Difference line.</>}
              </p>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-4 py-3">Ledger head</th>
                    <th className="text-right px-4 py-3 w-40">Debit</th>
                    <th className="text-right px-4 py-3 w-40">Credit</th>
                  </tr>
                </thead>
                {GROUPS.map((g) => {
                  const rows = tb.rows.filter((r) => r.group === g);
                  if (rows.length === 0) return null;
                  return (
                    <tbody key={g} className="divide-y divide-hairline">
                      <tr className="bg-paper-2/30">
                        <td colSpan={3} className="px-4 py-2 text-2xs uppercase tracking-wider font-semibold text-ink-3">{g}</td>
                      </tr>
                      {rows.map((r) => (
                        <tr key={`${g}-${r.head}`} className={cn(g === "Difference" && "bg-amber-soft/20")}>
                          <td className="px-4 py-2">
                            <div className="text-ink">{r.head}{g === "Difference" && <Badge kind="warning" className="ml-2">derived</Badge>}</div>
                            <div className="text-xs text-ink-3">{r.source}</div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono">{r.debit ? rupee(r.debit) : ""}</td>
                          <td className="px-4 py-2 text-right font-mono">{r.credit ? rupee(r.credit) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
                <tfoot className="border-t-2 border-ink bg-paper-2/30">
                  <tr>
                    <td className="px-4 py-3 text-2xs uppercase tracking-wider font-semibold text-ink-3">Total</td>
                    <td className="px-4 py-3 text-right font-serif text-lg">{rupee(tb.totalDebit)}</td>
                    <td className="px-4 py-3 text-right font-serif text-lg">{rupee(tb.totalCredit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
