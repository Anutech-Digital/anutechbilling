/**
 * R-2625 (9 Nov 2026, slice 5 of R-2156) — the Balance Sheet's Management view: Advance billing.
 *
 * The P&L "Management (matched)" view spreads prepaid revenue over the months it pays for (R-2624):
 * a ₹12,000 yearly invoice dated 1 Oct earns ₹1,000 a month. The part not earned yet must show
 * somewhere, or the management books stop balancing — it is Advance billing (unearned revenue):
 * money invoiced for service still owed.
 *
 * The sheet above stays the statutory (GST) Balance Sheet, exactly as the CA files it — this card
 * is extra, below it, and changes none of its figures (nor the Trial Balance or the CSV export).
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import type { AdvanceBilling } from "@/lib/accounting/balance-sheet-totals";
import { managementBalanceSheet } from "@/lib/accounting/balance-sheet-totals";
import { SectionTitle, BSLine, TotalLine } from "./bs-lines";
import { fmtBS } from "./format";

export function AdvanceBillingCard({
  data, failed, asOf, totals,
}: {
  /** undefined while loading; null = the database has no Management revenue yet (card hidden). */
  data: AdvanceBilling | null | undefined;
  failed: boolean;
  asOf: string;
  /** The statutory totals shown above. */
  totals: { totalAssets: number; totalLiab: number; netWorth: number };
}) {
  if (failed) {
    return (
      <Card className="mt-6 p-4" data-testid="advance-billing-card">
        <p role="status" className="text-sm text-rose">Advance billing (management view) could not load — the Balance Sheet above is not affected. Reload the page to try again.</p>
      </Card>
    );
  }
  if (!data || data.advance === 0) return null;
  const m = managementBalanceSheet(totals, data.advance);
  const owed = data.advance > 0;
  return (
    <Card className="mt-6 p-5 md:p-6" data-testid="advance-billing-card">
      <SectionTitle>Management view — prepaid revenue</SectionTitle>
      <p className="text-xs text-ink-3 mt-2 leading-relaxed">
        The Balance Sheet above is the statutory (GST) one, as your CA files it. In the management view
        (P&amp;L &ldquo;Management (matched)&rdquo;) a prepaid invoice is earned month by month, so the part not
        earned by {formatDate(asOf)} is shown here. Only the timing of revenue is adjusted — vendor bills stay as on the sheet above.
      </p>
      <div className="space-y-1 mt-3">
        <BSLine
          label={owed ? "Advance billing (unearned revenue)" : "Revenue earned, not yet invoiced"}
          hint={owed
            ? `invoiced ${fmtBS(data.invoiced)} − earned ${fmtBS(data.earned)} to date, before GST — service still owed on prepaid terms`
            : `earned ${fmtBS(data.earned)} − invoiced ${fmtBS(data.invoiced)} to date, before GST — more earned than invoiced so far (e.g. an invoice dated later for months already passed, or a credit note counted from its own month)`}
          amount={Math.abs(data.advance)}
          kind="auto"
          source="P&L (Management)"
          href="/accounting/pnl"
        />
      </div>
      {!owed && <TotalLine label="Total assets (management)" amount={m.totalAssets} muted />}
      <TotalLine label="Total liabilities (management)" amount={m.totalLiab} muted />
      <TotalLine label="Net worth (management)" amount={m.netWorth} muted />
      <p className="mt-2 text-xs text-ink-2" data-testid="advance-billing-balanced">
        Balanced: Assets {fmtBS(m.totalAssets)} = Liabilities + Equity {fmtBS(m.totalLiab + m.netWorth)} · net worth {owed ? "lower" : "higher"} than
        the statutory {fmtBS(totals.netWorth)} by {fmtBS(Math.abs(data.advance))}.
      </p>
    </Card>
  );
}
