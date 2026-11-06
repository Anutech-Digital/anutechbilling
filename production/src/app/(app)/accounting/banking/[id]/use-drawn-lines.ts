/**
 * R-2524 — two bank-page helpers kept out of page.tsx (max-lines):
 *   useDrawnBadges   — the Advance / "N payments" badge reads, only for the lines DRAWN (a page of
 *                      100), never every payment line of the account (2,800 ids were ~19 requests
 *                      each, again after every save);
 *   useMountWhenIdle — mount something heavy (the Reconcile sheet and its ~15 reads) once the list
 *                      has drawn and the browser is idle, then keep it.
 */
"use client";

import * as React from "react";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useBankAdvancePaymentIds, useBankSplitLinePayments } from "@/lib/queries/bank-credit-pay-for";

export function useDrawnBadges(drawnTxns: readonly BankTransactionRow[]) {
  /* R-2025 (0): lines booked as a customer advance (R-1863) read "Advance", not "Payment". */
  const paymentIdsOnLines = React.useMemo(
    () => drawnTxns.filter((t) => t.matched_to_type === "payment" && t.credit > 0 && t.matched_to_id).map((t) => String(t.matched_to_id)),
    [drawnTxns],
  );
  const { data: advancePayIds } = useBankAdvancePaymentIds(paymentIdsOnLines);
  const isAdvanceTxn = (t: BankTransactionRow) => t.matched_to_type === "payment" && Boolean(t.matched_to_id && advancePayIds?.has(String(t.matched_to_id)));
  /* R-2098: a line that paid several items — "N payments", each listed in the tooltip. */
  const paymentLineIds = React.useMemo(
    () => drawnTxns.filter((t) => t.matched_to_type === "payment" && t.credit > 0).map((t) => t.id),
    [drawnTxns],
  );
  const { data: splitPays } = useBankSplitLinePayments(paymentLineIds);
  return { isAdvanceTxn, splitPays };
}

/** True once `ready` and the browser is idle (or 2 s / 0.5 s without requestIdleCallback); stays true.
 *  The Reconcile sheet: the page does not wait on it, yet its data is in before the operator picks
 *  anything (a read landing after a pick would re-run the sheet's pre-fill). */
export function useMountWhenIdle(ready: boolean): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    if (mounted || !ready) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => setMounted(true), { timeout: 2000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const t = window.setTimeout(() => setMounted(true), 500);
    return () => window.clearTimeout(t);
  }, [mounted, ready]);
  return mounted;
}
