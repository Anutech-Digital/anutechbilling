"use client";

import { useBankOpeningHistory } from "@/lib/queries/bank";
import { formatDate, rupee } from "@/lib/utils";

/** R-2497: the last change of the account's opening balance (old → new), from bank_opening_history,
    so a statement import never overwrites it silently. Nothing when it was never changed. */
export function OpeningHistoryNote({ accountId }: { accountId: string }) {
  const { data } = useBankOpeningHistory(accountId);
  const last = data?.[0];
  if (!last) return null;
  const was = last.old_date
    ? `${rupee(last.old_balance ?? 0)} as of ${formatDate(last.old_date)}`
    : rupee(last.old_balance ?? 0);
  return (
    <p data-testid="opening-history" className="text-xs text-ink-3 mt-0.5" title={`${data!.length} change${data!.length === 1 ? "" : "s"} recorded`}>
      Was {was} — changed {formatDate(last.changed_at)}
      {last.source === "statement" ? " from a statement" : ""}
      {last.accepted_difference && last.difference !== null
        ? <span className="text-amber-ink"> (owner accepted a {rupee(Math.abs(last.difference))} difference)</span>
        : null}
    </p>
  );
}
