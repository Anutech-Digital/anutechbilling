/**
 * R-2935 (staging 18 Nov 2026, Excel HDFC 4523): a bank that pays FD interest GROSS and takes its
 * TDS on a separate money-out line ("FD REDEEM TAX −₹801"). That line is not a challan the company
 * paid and not an expense — it is TDS receivable (Sec 194A) on an interest already booked from its
 * own bank line. Tax tile → "TDS cut by bank": pick that interest, one save
 * (book_bank_debit_as_interest_tds: Dr TDS receivable, Cr Bank; the income stays as booked).
 */
"use client";

import * as React from "react";

import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useBookInterestTds, useInterestWithoutTds } from "@/lib/queries/bank-other-income";
import { pickInterestForTds } from "@/lib/banking/interest-income";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

export const INTEREST_FIRST = "Book the interest line first (Reconcile → Other / manual → Interest received) — then this TDS line can be booked against it.";
const PICK_INTEREST = "Pick the interest this TDS was cut on.";

const SOURCE_WORD: Record<string, string> = { fd: "FD interest", savings: "Savings interest", other: "Interest" };

export function InterestTdsSection({ transaction, onDone, onFooterSave }: {
  transaction: BankTransactionRow;
  onDone: () => void;
  onFooterSave: (save: FooterSave | null) => void;
}) {
  const amount = transaction.debit ?? 0;
  const rowsQ = useInterestWithoutTds(transaction.id);
  const book = useBookInterestTds();
  const rows = React.useMemo(() => rowsQ.data ?? [], [rowsQ.data]);
  const [picked, setPicked] = React.useState("");
  const touched = React.useRef(false);
  const guess = React.useMemo(() => pickInterestForTds(rows, amount, transaction.txn_date), [rows, amount, transaction.txn_date]);
  React.useEffect(() => { touched.current = false; }, [transaction.id]);
  React.useEffect(() => { if (!touched.current) setPicked(guess); }, [guess]);
  const row = rows.find((r) => r.id === picked) ?? null;

  async function submit() {
    if (!row) return;
    try {
      await book.mutateAsync({ transactionId: transaction.id, otherIncomeId: row.id });
      onDone();
    } catch { /* the hook toasts */ }
  }

  const reason = rowsQ.isLoading ? "Looking for the interest…"
    : rowsQ.isError ? "Couldn't load the booked interest — close and open this line again."
    : rows.length === 0 ? INTEREST_FIRST
    : !row ? PICK_INTEREST : null;
  useFooterSaveReport(onFooterSave, {
    label: `Book ${rupee(amount)} as TDS receivable`, onSave: () => { void submit(); },
    disabledReason: reason, loading: book.isPending,
  });

  const pct = row ? Math.round((amount * 1000) / row.amount) / 10 : null;
  return (
    <div className="space-y-2" data-testid="interest-tds-section">
      <p className="text-xs text-ink-3">
        TDS the bank cut on interest (Sec 194A). Not an expense and not a challan you paid — it goes to
        <b> TDS receivable</b> on the balance sheet; claim it in the ITR against Form 26AS.
      </p>
      {rows.length > 0 && (
        <label className="block text-xs text-ink-3 space-y-0.5">
          <span className="block">Interest this TDS was cut on</span>
          <select value={picked} onChange={(e) => { touched.current = true; setPicked(e.target.value); }} aria-label="Interest this TDS was cut on"
            className="w-full min-w-0 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-emerald/40">
            <option value="">Pick the interest…</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {formatDate(r.income_date)} · {rupee(r.amount)} · {SOURCE_WORD[r.source ?? "other"] ?? "Interest"}{r.fd_name ? ` · ${r.fd_name}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {row && (
        <p className="text-xs tabular-nums text-ink-2" aria-live="polite">
          TDS <b>{rupee(amount)}</b> is {pct}% of the {rupee(row.amount)} interest · net received <b>{rupee(row.amount - amount)}</b>. Interest income stays {rupee(row.amount)}.
        </p>
      )}
    </div>
  );
}
