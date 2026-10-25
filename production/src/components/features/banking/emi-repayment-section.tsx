/**
 * R-1864 — Bank → Reconcile, a money-OUT line: "EMI / loan repayment".
 *
 * The line is matched to an EMI the books already know (emi_matches_for_bank_txn — the same rule
 * Auto-reconcile uses): the loan's next instalment, an instalment paid by hand (its manual line is
 * replaced), or a down payment still on a manual line. The split is shown before saving:
 * principal reduces the loan, interest goes to the P&L. A line bigger than the EMI asks what the
 * extra is — a late fee / bounce charge (expense) or extra principal (part prepayment, the rest
 * of the schedule recomputed). A smaller line pays interest first; the rest of the schedule is
 * recomputed. "Down payment for a new asset on EMI" and "Prepayment / foreclosure" open the
 * same dialogs as Assets & EMIs.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { recomputeRemaining, splitDebit, type ExtraAs, type ScheduleRow } from "@/lib/accounting/emi-schedule";
import {
  useEmiMatches, useEmiPurchases, useEmiSchedule, useReconcileDebitToEmi, type EmiMatch,
} from "@/lib/queries/emi";
import { EmiPurchaseDialog, EmiPrepayDialog, type EmiFromTxn } from "@/components/features/accounting/emi-loan-dialogs";

type Txn = { id: string; debit: number; txn_date: string; bank_account_id: string; description: string | null };

const matchKey = (m: EmiMatch) => `${m.purchase_id}:${m.seq}`;

function matchTitle(m: EmiMatch): string {
  if (m.kind === "down_payment") return `Down payment · ${m.purchase_name}`;
  return `EMI ${m.seq} · ${m.purchase_name}${m.kind === "paid_by_hand" ? " (paid by hand — this line replaces it)" : ""}`;
}

export function EmiRepaymentSection({ transaction, onDone }: { transaction: Txn; onDone: () => void }) {
  const matchesQ = useEmiMatches(transaction.id);
  const purchasesQ = useEmiPurchases();
  const reconcile = useReconcileDebitToEmi();
  const matches = React.useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const activeLoans = (purchasesQ.data ?? []).filter((p) => p.status === "active" && p.outstanding > 0);

  const sure = matches.some((m) => m.confidence !== "low");
  const [open, setOpen] = React.useState(false);
  /* Any EMI candidate opens the section — a late-fee line is a "low" match but still an EMI. */
  const anyMatch = matches.length > 0;
  React.useEffect(() => { if (anyMatch) setOpen(true); }, [anyMatch]);
  const [picked, setPicked] = React.useState<string>("");
  React.useEffect(() => { if (!picked && matches.length > 0) setPicked(matchKey(matches[0])); }, [matches, picked]);
  const [extraAs, setExtraAs] = React.useState<ExtraAs>("late_fee");
  const [purchaseOpen, setPurchaseOpen] = React.useState(false);
  const [prepayFor, setPrepayFor] = React.useState<string>("");

  const m = matches.find((x) => matchKey(x) === picked) ?? null;
  const scheduleQ = useEmiSchedule(m && m.kind === "instalment" ? m.purchase_id : undefined);
  const purchase = m ? (purchasesQ.data ?? []).find((p) => p.id === m.purchase_id) : undefined;

  const amount = transaction.debit;
  const split = m && m.kind === "instalment" ? splitDebit({ emi: m.expected, principal: m.principal, interest: m.interest }, amount, extraAs) : null;

  // A payment that is not the scheduled EMI: the rest of the loan is re-worked out.
  let newSchedule: ScheduleRow[] | null = null;
  let recomputeError: string | null = null;
  if (m && split?.recompute && purchase) {
    const rest = (scheduleQ.data?.rows ?? []).filter((r) => !r.emi_payment_id && r.seq > m.seq);
    const left = purchase.outstanding - split.principal;
    try {
      newSchedule = left <= 0 ? [] : rest.length === 0 ? null : recomputeRemaining({
        outstanding: left, annualRatePct: purchase.no_cost ? 0 : Number(purchase.interest_rate ?? 0),
        nextSeq: m.seq + 1, nextDueOn: rest[0].due_on, remainingMonths: rest.length, currentEmi: rest[0].emi,
        mode: split.difference > 0 ? "reduce_tenure" : "reduce_emi",
      });
      if (newSchedule === null) recomputeError = "No EMIs are left after this one — use Prepayment / close instead.";
    } catch (e) { recomputeError = e instanceof Error ? e.message : "Check the amount"; }
  }

  const fromTxn: EmiFromTxn = {
    id: transaction.id, amount, date: transaction.txn_date, accountId: transaction.bank_account_id,
    description: transaction.description ?? "",
  };

  async function save() {
    if (!m) return;
    if (m.kind !== "instalment") {
      await reconcile.mutateAsync({ txnId: transaction.id, purchaseId: m.purchase_id, seq: m.seq });
    } else if (split) {
      await reconcile.mutateAsync({
        txnId: transaction.id, purchaseId: m.purchase_id, seq: m.seq,
        principal: split.principal, interest: split.interest, charges: split.charges,
        newSchedule: split.recompute ? newSchedule : null,
      });
    }
    onDone();
  }

  const prepayPurchase = (purchasesQ.data ?? []).find((p) => p.id === prepayFor);
  const busy = matchesQ.isLoading || purchasesQ.isLoading;
  const waitingForSchedule = Boolean(split?.recompute) && scheduleQ.isLoading;

  return (
    <div className={`rounded-md border p-3 ${sure ? "border-indigo/50 bg-indigo-soft/25" : "border-hairline"}`} data-testid="emi-repayment-section">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between text-left">
        <span className="text-xs font-semibold text-ink-2">
          {m ? <>{m.kind === "down_payment" ? "Looks like the down payment" : "Looks like an EMI"} — <b>{m.purchase_name}</b>{m.lender ? ` (${m.lender})` : ""}</> : "EMI / loan repayment?"}
        </span>
        <Icon name={open ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
      </button>
      {!open ? (
        <p className="text-xs text-ink-3 mt-1 leading-relaxed">
          An EMI is principal (reduces the loan) + interest (expense) — never the whole amount as an expense.
        </p>
      ) : busy ? (
        <p className="text-xs text-ink-3 mt-2">Looking for the loan…</p>
      ) : (
        <div className="mt-2 space-y-2">
          {matches.length > 0 ? (
            <>
              <ul className="space-y-1.5" role="radiogroup" aria-label="Which EMI">
                {matches.map((x) => (
                  <li key={matchKey(x)}>
                    <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${picked === matchKey(x) ? "border-indigo bg-paper" : "border-hairline"}`}>
                      <input type="radio" name="emi-match" className="mt-1" checked={picked === matchKey(x)} onChange={() => setPicked(matchKey(x))} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-ink">{matchTitle(x)}</span>
                        <span className="block text-xs text-ink-3">
                          {rupee(x.expected)} · {x.kind === "down_payment" ? "bought" : "due"} {formatDate(x.due_on)}
                          {x.difference !== 0 && <> · this line is {rupee(Math.abs(x.difference))} {x.difference > 0 ? "more" : "less"}</>}
                        </span>
                      </span>
                      {x.confidence !== "low" && <Badge kind="success" size="sm">{x.confidence === "exact" ? "Exact" : "Likely"}</Badge>}
                    </label>
                  </li>
                ))}
              </ul>

              {m && split && split.difference > 0 && (
                <div className="space-y-1" role="radiogroup" aria-label="The extra amount is">
                  <p className="text-xs text-ink-2">The extra {rupee(split.difference)} is:</p>
                  {([["late_fee", "Late fee / bounce charge (expense)"], ["prepay", "Extra paid toward the loan (part prepayment)"]] as const).map(([v, l]) => (
                    <label key={v} className="flex items-center gap-2 text-sm text-ink">
                      <input type="radio" name="emi-extra" checked={extraAs === v} onChange={() => setExtraAs(v)} /> {l}
                    </label>
                  ))}
                </div>
              )}
              {m && split && split.difference < 0 && (
                <p className="text-xs text-amber-ink">Less than the EMI: interest is paid first, the rest reduces the loan, and the remaining EMIs are worked out again.</p>
              )}

              {m && split && (
                <div className="rounded-md bg-paper-2/50 p-2.5 text-sm space-y-0.5" data-testid="emi-split">
                  <div className="flex justify-between"><span className="text-ink-2">Principal — reduces the loan</span><span className="font-mono tabular-nums">{rupee(split.principal)}</span></div>
                  <div className="flex justify-between"><span className="text-ink-2">Interest — expense (P&amp;L)</span><span className="font-mono tabular-nums">{rupee(split.interest)}</span></div>
                  {split.charges > 0 && <div className="flex justify-between"><span className="text-ink-2">Late fee — expense (P&amp;L)</span><span className="font-mono tabular-nums">{rupee(split.charges)}</span></div>}
                  {newSchedule && newSchedule.length > 0 && (
                    <p className="text-xs text-ink-3 pt-1">Then {newSchedule.length} EMIs of {rupee(newSchedule[0].emi)}.</p>
                  )}
                </div>
              )}
              {m && m.kind !== "instalment" && (
                <p className="text-xs text-ink-3">
                  {m.kind === "down_payment"
                    ? "The down payment was recorded with a manual line; this statement line takes its place (counted once)."
                    : "This EMI was recorded by hand; this statement line takes the place of that manual line (counted once)."}
                </p>
              )}
              {recomputeError && <p className="text-xs text-rose-ink">{recomputeError}</p>}

              <Button size="sm" variant="primary" icon="check" disabled={!m || Boolean(recomputeError) || waitingForSchedule}
                loading={reconcile.isPending} onClick={save}>
                {m ? (m.kind === "down_payment" ? `Match down payment ${rupee(amount)}` : `Reconcile as EMI ${m.seq}`) : "Pick the EMI"}
              </Button>
            </>
          ) : (
            <p className="text-xs text-ink-3">
              {activeLoans.length > 0
                ? `No EMI of ${rupee(amount)} is due around ${formatDate(transaction.txn_date)}.`
                : "No loan is recorded yet."}
            </p>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            <button type="button" className="text-indigo-ink font-medium underline hover:no-underline" onClick={() => setPurchaseOpen(true)}>
              Down payment for a new asset on EMI →
            </button>
            {activeLoans.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <label htmlFor="emi-prepay-loan" className="text-ink-2">Prepayment / foreclosure of</label>
                <select id="emi-prepay-loan" value={prepayFor} onChange={(e) => setPrepayFor(e.target.value)}
                  className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-xs text-ink">
                  <option value="">pick a loan…</option>
                  {activeLoans.map((p) => <option key={p.id} value={p.id}>{p.name} · {rupee(p.outstanding)} owed</option>)}
                </select>
              </span>
            )}
          </div>
        </div>
      )}
      {purchaseOpen && <EmiPurchaseDialog fromTxn={fromTxn} onSaved={onDone} onClose={() => setPurchaseOpen(false)} />}
      {prepayPurchase && (
        <EmiPrepayDialog purchase={prepayPurchase} fromTxn={fromTxn} onClose={() => setPrepayFor("")} onDone={onDone} />
      )}
    </div>
  );
}
