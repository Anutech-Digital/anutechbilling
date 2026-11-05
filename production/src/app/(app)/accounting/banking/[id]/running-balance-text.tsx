"use client";

import { balanceText, type RunningBalance } from "@/lib/banking/running-balance";

/** R-2400: the balance after this line (−₹ when overdrawn) + an amber dot when the bank's own
    statement balance on the line is more than ₹1 away. */
export function RunningBalanceText({ running }: { running?: RunningBalance }) {
  if (!running) return <span className="text-ink-3">—</span>;
  /* R-2497: dated before the opening date — already inside the opening balance. */
  if (running.beforeOpening) {
    return (
      <span data-testid="before-opening" className="text-ink-3" title="Dated before the opening balance date — already inside the opening balance, not counted again">
        Before opening
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {running.statementSays !== null && (
        <span
          data-testid="statement-mismatch"
          title={`Statement says ${balanceText(running.statementSays)}`}
          aria-label={`Statement says ${balanceText(running.statementSays)}`}
          role="img"
          className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber"
        />
      )}
      <span data-testid="running-balance" className={running.balance < 0 ? "text-rose" : "text-ink"}>
        {balanceText(running.balance)}
      </span>
    </span>
  );
}
