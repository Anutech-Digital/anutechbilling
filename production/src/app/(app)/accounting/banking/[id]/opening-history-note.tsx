"use client";

import { useBankOpeningHistory } from "@/lib/queries/bank";
import { formatDate, rupee } from "@/lib/utils";

/** The account page's "Opening balance" tile — R-2497: + how many lines are dated before it
    (inside the opening, not counted) and the last opening change. */
export function OpeningBalanceTile({ account, beforeOpeningCount }: {
  account: { id: string; opening_balance: number | null; opening_balance_date: string | null };
  beforeOpeningCount: number;
}) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Opening balance</p>
      <p className="font-serif text-2xl text-ink-2 mt-1">{rupee(account.opening_balance ?? 0)}</p>
      <p className="text-xs text-ink-3 mt-0.5">as of {formatDate(account.opening_balance_date)}</p>
      {beforeOpeningCount > 0 && (
        <p data-testid="before-opening-count" className="text-xs text-amber-ink mt-0.5">
          {beforeOpeningCount} line{beforeOpeningCount === 1 ? "" : "s"} before this date — inside the opening, not counted
        </p>
      )}
      <OpeningHistoryNote accountId={account.id} />
    </div>
  );
}

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
