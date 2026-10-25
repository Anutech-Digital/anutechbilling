/**
 * R-1864 — an asset bought on EMI / loan: the three dialogs, shared by Assets & EMIs and the
 * bank page (Reconcile → "EMI / loan repayment"), so both open the same form with the same
 * defaults (UI rule 6).
 *
 *  - EmiPurchaseDialog — "Bought on EMI / loan": asset + lender + rate / no-cost + tenure + EMI +
 *    first EMI date + processing fee, with the schedule shown live; one atomic save
 *    (record_emi_asset_purchase). From a bank line, that line is the down payment.
 *  - EmiScheduleDialog — the instalments (due / overdue / paid · in bank / paid · awaiting
 *    statement), what is due within 12 months, Pay next EMI, Prepay / close, Undo last.
 *  - EmiPrepayDialog — part prepayment (lower EMI or finish sooner) or foreclosure; from a bank
 *    line or a new manual line.
 *
 * The maths is lib/accounting/emi-schedule.ts; the database re-checks every schedule.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useBankAccounts } from "@/lib/queries/bank";
import { BLOCKS, type AssetBlock } from "@/lib/accounting/depreciation";
import {
  addMonthsIso, buildSchedule, currentVsNonCurrent, emiFor, recomputeRemaining, scheduleTotals,
  type Recompute, type ScheduleRow,
} from "@/lib/accounting/emi-schedule";
import {
  useRecordEmiAssetPurchase, useEmiSchedule, usePayNextEmi, usePrepayEmiLoan, useUndoEmiPayment,
  EMI_STATUS_LABEL, type EmiPurchase, type EmiRowStatus, type EmiScheduleLine,
} from "@/lib/queries/emi";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";
const num = (s: string) => Math.max(0, Math.round(Number(s) || 0));

/** A money-out bank line the dialog books against (Reconcile). */
export type EmiFromTxn = { id: string; amount: number; date: string; accountId: string; description: string };

function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

function SumRow({ label, value, strong }: { label: React.ReactNode; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>
      <span>{label}</span><span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function useActiveAccounts() {
  const q = useBankAccounts();
  return (q.data ?? []).filter((a) => a.is_active && a.account_type !== "credit_card");
}

/* ── Bought on EMI / loan ─────────────────────────────────────────────────────────────── */
export function EmiPurchaseDialog({ onClose, fromTxn, onSaved }: { onClose: () => void; fromTxn?: EmiFromTxn | null; onSaved?: () => void }) {
  const accounts = useActiveAccounts();
  const record = useRecordEmiAssetPurchase();

  const [name, setName] = React.useState("");
  const [block, setBlock] = React.useState<AssetBlock>("computers");
  const [cost, setCost] = React.useState("");
  const [date, setDate] = React.useState(fromTxn?.date ?? istToday());
  const [down, setDown] = React.useState("");
  const [accountId, setAccountId] = React.useState(fromTxn?.accountId ?? "");
  const [lender, setLender] = React.useState("");
  const [lenderRef, setLenderRef] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [noCost, setNoCost] = React.useState(false);
  const [months, setMonths] = React.useState("12");
  const [emiText, setEmiText] = React.useState("");
  const [firstDue, setFirstDue] = React.useState("");
  const [fee, setFee] = React.useState("");
  const [feeGst, setFeeGst] = React.useState("");

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const costN = num(cost);
  const feeN = num(fee);
  const feeGstN = num(feeGst);
  // From a bank line, the line is down payment + fee: the down payment follows from it.
  const downN = fromTxn ? Math.max(0, fromTxn.amount - feeN - feeGstN) : num(down);
  const loan = Math.max(0, costN - downN);
  const monthsN = num(months);
  const rateN = noCost ? 0 : Math.max(0, Number(rate) || 0);
  const firstDueOn = firstDue || (date ? addMonthsIso(date, 1) : "");
  const standardEmi = emiFor(loan, rateN, monthsN);
  const emiN = emiText.trim() ? num(emiText) : standardEmi;

  let schedule: ScheduleRow[] = [];
  let scheduleError: string | null = null;
  try {
    schedule = buildSchedule({ principal: loan, annualRatePct: rateN, months: monthsN, firstDueOn, emi: emiText.trim() ? emiN : null });
  } catch (e) {
    scheduleError = e instanceof Error ? e.message : "Check the rate and EMI";
  }
  const totals = scheduleTotals(schedule);

  const problems = [
    !name.trim() && "Enter what was bought",
    costN <= 0 && "Enter the cost",
    loan <= 0 && costN > 0 && "Nothing is financed — use the Fixed asset register for a cash purchase",
    !lender.trim() && "Enter the lender",
    !noCost && rate.trim() === "" && "Enter the interest rate, or tick No-cost EMI",
    monthsN <= 0 && "Enter the number of EMIs",
    (downN + feeN + feeGstN) > 0 && !accountId && "Pick the account the down payment was paid from",
    fromTxn && fromTxn.amount < feeN + feeGstN && "The bank line is smaller than the processing fee",
    scheduleError,
  ].filter((x): x is string => Boolean(x));

  async function submit() {
    if (problems.length > 0) return;
    await record.mutateAsync({
      name: name.trim(), block, cost: costN, purchasedOn: date, downPayment: downN,
      accountId: fromTxn ? null : (downN + feeN + feeGstN > 0 ? accountId : null), downBankTxnId: fromTxn?.id ?? null,
      lender: lender.trim(), lenderRef: lenderRef.trim() || null, interestRate: rateN, noCost,
      processingFee: feeN, processingFeeGst: feeGstN, schedule,
    });
    onSaved?.();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle>Bought on EMI / loan</DialogTitle>
          <DialogDescription>
            {fromTxn
              ? <>This {rupee(fromTxn.amount)} bank line is the down payment (with any processing fee). The asset, the loan and its EMI schedule are recorded in one step.</>
              : "The asset goes into the register at cost, the financed part becomes a loan, and every EMI is split into principal and interest."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field htmlFor="emi-item" label="Item">
              <Input id="emi-item" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dell laptop" autoFocus maxLength={120} />
            </Field>
            <Field htmlFor="emi-block" label="Asset type" hint={`Depreciation ${BLOCKS[block].ratePct}% a year`}>
              <select id="emi-block" value={block} onChange={(e) => setBlock(e.target.value as AssetBlock)} className={selectCls}>
                {(Object.keys(BLOCKS) as AssetBlock[]).map((b) => <option key={b} value={b}>{BLOCKS[b].label}</option>)}
              </select>
            </Field>
            <Field htmlFor="emi-cost" label="Cost (₹)" hint="Without GST if you claim the GST as input credit">
              <Input id="emi-cost" type="number" min={1} inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 120000" />
            </Field>
            <Field htmlFor="emi-date" label="Purchase date">
              <Input id="emi-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={Boolean(fromTxn)} />
            </Field>
            {fromTxn ? (
              <div className="sm:col-span-2 rounded-md bg-paper-2/50 px-3 py-2 text-sm text-ink-2">
                Down payment <b className="text-ink">{rupee(downN)}</b> = bank line {rupee(fromTxn.amount)}{feeN + feeGstN > 0 ? <> − fee {rupee(feeN + feeGstN)}</> : null}
              </div>
            ) : (
              <>
                <Field htmlFor="emi-down" label="Down payment (₹)">
                  <Input id="emi-down" type="number" min={0} inputMode="numeric" value={down} onChange={(e) => setDown(e.target.value)} placeholder="0" />
                </Field>
                <Field htmlFor="emi-account" label="Paid from" hint="Matched to the statement line later — never counted twice">
                  <select id="emi-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                    {accounts.length === 0 && <option value="">Add an account in Banking</option>}
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
              </>
            )}
          </div>

          <div className="rounded-md border border-hairline p-3 space-y-3">
            <p className="text-xs font-semibold text-ink-2">Loan · {rupee(loan)}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field htmlFor="emi-lender" label="Lender">
                <Input id="emi-lender" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Bajaj Finance" />
              </Field>
              <Field htmlFor="emi-ref" label="Loan account no. (optional)" hint="Helps match the EMI in the bank statement">
                <Input id="emi-ref" value={lenderRef} onChange={(e) => setLenderRef(e.target.value)} placeholder="e.g. LAN4455" maxLength={60} />
              </Field>
              <Field htmlFor="emi-rate" label="Interest rate (% a year)">
                <Input id="emi-rate" type="number" min={0} step="0.01" inputMode="decimal" value={noCost ? "0" : rate}
                  onChange={(e) => setRate(e.target.value)} disabled={noCost} placeholder="e.g. 14" />
              </Field>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={noCost} onChange={(e) => setNoCost(e.target.checked)} />
                  No-cost EMI (no interest)
                </label>
              </div>
              <Field htmlFor="emi-months" label="Number of EMIs">
                <Input id="emi-months" type="number" min={1} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
              </Field>
              <Field htmlFor="emi-amount" label="EMI (₹)" hint={emiText.trim() ? "As per the lender" : "Worked out from rate and tenure — type the lender's EMI if different"}>
                <Input id="emi-amount" type="number" min={1} inputMode="numeric" value={emiText.trim() ? emiText : String(standardEmi || "")}
                  onChange={(e) => setEmiText(e.target.value)} />
              </Field>
              <Field htmlFor="emi-first" label="First EMI date">
                <Input id="emi-first" type="date" value={firstDueOn} onChange={(e) => setFirstDue(e.target.value)} />
              </Field>
              <Field htmlFor="emi-fee" label="Processing fee (₹)" hint="An expense (Bank Charges), paid with the down payment">
                <Input id="emi-fee" type="number" min={0} inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
              </Field>
              {feeN > 0 && (
                <Field htmlFor="emi-fee-gst" label="GST on the fee (₹)" hint="Input credit, if the lender's invoice shows your GSTIN">
                  <Input id="emi-fee-gst" type="number" min={0} inputMode="numeric" value={feeGst} onChange={(e) => setFeeGst(e.target.value)} placeholder="0" />
                </Field>
              )}
            </div>
          </div>

          <div className="rounded-md bg-paper-2/50 p-3 text-sm space-y-1">
            <SumRow label="Asset (register, at cost)" value={rupee(costN)} />
            <SumRow label="Paid now (down payment + fee)" value={rupee(downN + feeN + feeGstN)} />
            <SumRow label="Loan" value={rupee(loan)} strong />
            {schedule.length > 0 && (
              <>
                <SumRow label={`${schedule.length} EMIs from ${formatDate(schedule[0].dueOn)}`} value={`${rupee(schedule[0].emi)} / month`} />
                <SumRow label="Total interest (P&L, over the loan)" value={rupee(totals.interest)} />
                {schedule.at(-1)!.emi !== schedule[0].emi && (
                  <p className="text-xs text-ink-3">The last EMI is {rupee(schedule.at(-1)!.emi)} — it takes the rounding.</p>
                )}
              </>
            )}
          </div>

          {schedule.length > 0 && (
            <details className="rounded-md border border-hairline">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-2">Schedule preview</summary>
              <ScheduleList rows={schedule.map((r) => ({ ...r, status: null }))} />
            </details>
          )}
          {problems.length > 0 && (name || cost) && <p className="text-xs text-rose-ink">{problems[0]}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={record.isPending}>Cancel</Button>
          <Button variant="primary" loading={record.isPending} disabled={problems.length > 0} onClick={submit}>
            Record purchase &amp; loan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_KIND: Record<EmiRowStatus, "success" | "info" | "warning" | "danger"> = {
  linked: "success", paid_by_hand: "info", due: "warning", overdue: "danger",
};

type ListRow = Pick<ScheduleRow, "seq" | "dueOn" | "emi" | "principal" | "interest" | "balanceAfter"> & { status: EmiRowStatus | null; charges?: number };

/** One line per instalment — fits a phone (no wide table). */
function ScheduleList({ rows }: { rows: ListRow[] }) {
  return (
    <ul className="divide-y divide-hairline text-sm">
      {rows.map((r) => (
        <li key={r.seq} className="px-3 py-2" data-testid={`emi-row-${r.seq}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink">
              <b>EMI {r.seq}</b> <span className="text-ink-3">· {formatDate(r.dueOn)}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-mono tabular-nums text-ink">{rupee(r.emi + (r.charges ?? 0))}</span>
              {r.status && <Badge kind={STATUS_KIND[r.status]} size="sm">{EMI_STATUS_LABEL[r.status]}</Badge>}
            </span>
          </div>
          <div className="text-xs text-ink-3 tabular-nums">
            {rupee(r.principal)} principal + {rupee(r.interest)} interest{r.charges ? ` + ${rupee(r.charges)} late fee` : ""} · balance {rupee(r.balanceAfter)}
          </div>
        </li>
      ))}
    </ul>
  );
}

const toListRow = (r: EmiScheduleLine): ListRow => ({
  seq: r.seq, dueOn: r.due_on, emi: r.emi, principal: r.principal, interest: r.interest, balanceAfter: r.balance_after,
  status: r.status, charges: r.charges,
});

/* ── The schedule of one loan ─────────────────────────────────────────────────────────── */
export function EmiScheduleDialog({ purchase, onClose }: { purchase: EmiPurchase; onClose: () => void }) {
  const q = useEmiSchedule(purchase.id);
  const accounts = useActiveAccounts();
  const payNext = usePayNextEmi();
  const undo = useUndoEmiPayment();
  const [accountId, setAccountId] = React.useState("");
  const [prepayOpen, setPrepayOpen] = React.useState(false);
  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const rows = q.data?.rows ?? [];
  const payments = q.data?.payments ?? [];
  const next = rows.find((r) => !r.emi_payment_id);
  const today = istToday();
  const split = currentVsNonCurrent(rows.map((r) => ({ dueOn: r.due_on, principal: r.principal, paid: Boolean(r.emi_payment_id) })), today);
  const interestPaid = payments.reduce((s, p) => s + p.interest_part, 0);
  const lastPayment = payments.length > 0
    ? [...payments].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0]
    : null;
  const prepayments = payments.filter((p) => p.kind !== "emi");

  return (
    <>
      <Dialog open={!prepayOpen} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="md:!max-w-xl">
          <DialogHeader>
            <DialogTitle>EMI schedule — {purchase.name}</DialogTitle>
            <DialogDescription>
              {purchase.lender ?? "Loan"} · {rupee(purchase.financed)} at {purchase.no_cost ? "no cost" : `${Number(purchase.interest_rate ?? 0)}%`} ·{" "}
              <b className="text-ink">{rupee(purchase.outstanding)} owed</b> · interest paid {rupee(interestPaid)}
            </DialogDescription>
          </DialogHeader>
          {/* No ₹0 tiles while the schedule loads. */}
          {purchase.outstanding > 0 && q.data && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-paper-2/50 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Due within 12 months</div>
                <div className="font-mono tabular-nums text-ink">{rupee(split.current)}</div>
              </div>
              <div className="rounded-md bg-paper-2/50 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Due later</div>
                <div className="font-mono tabular-nums text-ink">{rupee(split.nonCurrent)}</div>
              </div>
            </div>
          )}
          <div className="max-h-[48vh] overflow-y-auto rounded-md border border-hairline">
            {q.isLoading ? <p className="p-3 text-xs text-ink-3">Loading…</p>
              : q.isError ? <p className="p-3 text-xs text-rose-ink">The schedule could not be loaded — close and open it again.</p>
              : <ScheduleList rows={rows.map(toListRow)} />}
            {prepayments.map((p) => (
              <div key={p.id} className="border-t border-hairline px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-ink"><b>{p.kind === "foreclosure" ? "Loan closed" : "Prepayment"}</b> <span className="text-ink-3">· {formatDate(p.paid_on)}</span></span>
                  <span className="font-mono tabular-nums">{rupee(p.amount)}</span>
                </div>
                <div className="text-xs text-ink-3">{rupee(p.principal_part)} principal{p.interest_part ? ` + ${rupee(p.interest_part)} interest` : ""}{p.charges ? ` + ${rupee(p.charges)} charges` : ""}</div>
              </div>
            ))}
          </div>
          {next && purchase.status === "active" && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="emi-pay-from" className={labelCls}>Pay EMI {next.seq} ({rupee(next.emi)}) from</label>
                <select id="emi-pay-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <Button variant="primary" loading={payNext.isPending} disabled={!accountId}
                onClick={() => payNext.mutate({ purchaseId: purchase.id, accountId, paidOn: next.due_on <= today ? next.due_on : today })}>
                Pay EMI {next.seq}
              </Button>
            </div>
          )}
          <p className="text-xs text-ink-3">
            Already in the bank statement? Reconcile that line in Banking instead — it is split the same way and never counted twice.
          </p>
          <DialogFooter className="flex-wrap gap-2">
            {lastPayment && (
              <Button variant="ghost" loading={undo.isPending} onClick={() => undo.mutate(lastPayment.id)}>Undo last payment</Button>
            )}
            {purchase.status === "active" && purchase.outstanding > 0 && (
              <Button variant="default" onClick={() => setPrepayOpen(true)}>Prepay / close loan</Button>
            )}
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {prepayOpen && <EmiPrepayDialog purchase={purchase} onClose={() => setPrepayOpen(false)} />}
    </>
  );
}

/* ── Prepayment / foreclosure ─────────────────────────────────────────────────────────── */
export function EmiPrepayDialog({ purchase, onClose, fromTxn, onDone }: {
  purchase: EmiPurchase; onClose: () => void; fromTxn?: EmiFromTxn | null; onDone?: () => void;
}) {
  const q = useEmiSchedule(purchase.id);
  const accounts = useActiveAccounts();
  const prepay = usePrepayEmiLoan();
  const [foreclose, setForeclose] = React.useState(false);
  const [principal, setPrincipal] = React.useState("");
  const [interest, setInterest] = React.useState("");
  const [charges, setCharges] = React.useState("");
  const [date, setDate] = React.useState(fromTxn?.date ?? istToday());
  const [accountId, setAccountId] = React.useState("");
  const [mode, setMode] = React.useState<Recompute>("reduce_emi");
  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const owed = purchase.outstanding;
  const unpaid = (q.data?.rows ?? []).filter((r) => !r.emi_payment_id);
  const next = unpaid[0];
  const intN = num(interest);
  const chgN = num(charges);
  const prinN = foreclose ? owed : fromTxn ? Math.max(0, fromTxn.amount - intN - chgN) : num(principal);
  const cash = prinN + intN + chgN;
  const left = owed - prinN;

  let newRows: ScheduleRow[] = [];
  let calcError: string | null = null;
  if (!foreclose && left > 0 && next) {
    try {
      newRows = recomputeRemaining({
        outstanding: left, annualRatePct: purchase.no_cost ? 0 : Number(purchase.interest_rate ?? 0), nextSeq: next.seq,
        nextDueOn: next.due_on, remainingMonths: unpaid.length, currentEmi: next.emi, mode,
      });
    } catch (e) { calcError = e instanceof Error ? e.message : "Check the amounts"; }
  }

  const problems = [
    prinN <= 0 && "Enter the principal being prepaid",
    prinN > owed && `More than the ${rupee(owed)} still owed`,
    fromTxn && cash !== fromTxn.amount && `Principal + interest + charges must equal the bank line (${rupee(fromTxn.amount)})`,
    !fromTxn && !accountId && "Pick the account it was paid from",
    !foreclose && left > 0 && !next && "This loan has no schedule left to recompute",
    calcError,
  ].filter((x): x is string => Boolean(x));

  async function submit() {
    if (problems.length > 0) return;
    await prepay.mutateAsync({
      purchaseId: purchase.id, principal: prinN, interest: intN, charges: chgN, paidOn: date,
      accountId: fromTxn ? null : accountId, txnId: fromTxn?.id ?? null, foreclose: foreclose || left === 0,
      newSchedule: foreclose || left === 0 ? null : newRows,
    });
    onDone?.();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Prepay / close — {purchase.name}</DialogTitle>
          <DialogDescription>{rupee(owed)} still owed to {purchase.lender ?? "the lender"}. Principal reduces the loan; interest and charges go to the P&amp;L.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Prepayment type">
            {([[false, "Part prepayment"], [true, "Close the loan"]] as const).map(([v, l]) => (
              <button key={l} type="button" role="radio" aria-checked={foreclose === v} onClick={() => setForeclose(v)}
                className={`rounded-md border px-3 py-2 text-sm ${foreclose === v ? "border-amber bg-amber-soft/40 text-ink" : "border-hairline text-ink-2"}`}>
                {l}
              </button>
            ))}
          </div>
          {!foreclose && !fromTxn && (
            <Field htmlFor="emi-prepay-principal" label="Principal prepaid (₹)">
              <Input id="emi-prepay-principal" type="number" min={1} inputMode="numeric" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="emi-prepay-interest" label="Interest till today (₹)">
              <Input id="emi-prepay-interest" type="number" min={0} inputMode="numeric" value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="0" />
            </Field>
            <Field htmlFor="emi-prepay-charges" label={foreclose ? "Foreclosure charge (₹)" : "Prepayment charge (₹)"}>
              <Input id="emi-prepay-charges" type="number" min={0} inputMode="numeric" value={charges} onChange={(e) => setCharges(e.target.value)} placeholder="0" />
            </Field>
          </div>
          {!fromTxn && (
            <div className="grid grid-cols-2 gap-3">
              <Field htmlFor="emi-prepay-date" label="Date">
                <Input id="emi-prepay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field htmlFor="emi-prepay-from" label="Paid from">
                <select id="emi-prepay-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          {!foreclose && left > 0 && (
            <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label="After the prepayment">
              {([["reduce_emi", "Lower EMI, same number of EMIs"], ["reduce_tenure", "Same EMI, finish sooner"]] as const).map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 text-sm text-ink">
                  <input type="radio" name="emi-recompute" checked={mode === v} onChange={() => setMode(v)} /> {l}
                </label>
              ))}
            </div>
          )}
          <div className="rounded-md bg-paper-2/50 p-3 text-sm space-y-1">
            <SumRow label="Principal (reduces the loan)" value={rupee(prinN)} />
            {intN > 0 && <SumRow label="Interest (P&L)" value={rupee(intN)} />}
            {chgN > 0 && <SumRow label="Charge (P&L)" value={rupee(chgN)} />}
            <SumRow label={fromTxn ? "Bank line" : "Paid now"} value={rupee(fromTxn ? fromTxn.amount : cash)} strong />
            <SumRow label="Still owed after" value={rupee(Math.max(0, left))} />
            {newRows.length > 0 && (
              <p className="text-xs text-ink-3">New schedule: {newRows.length} EMIs of {rupee(newRows[0].emi)} from {formatDate(newRows[0].dueOn)}.</p>
            )}
          </div>
          {problems.length > 0 && (prinN > 0 || foreclose) && <p className="text-xs text-rose-ink">{problems[0]}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={prepay.isPending}>Cancel</Button>
          <Button variant="primary" loading={prepay.isPending} disabled={problems.length > 0} onClick={submit}>
            {foreclose || left === 0 ? "Close the loan" : "Record prepayment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
