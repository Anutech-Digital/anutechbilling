/**
 * R-2340 — Bank → Reconcile, a money-IN line → Loan / EMI: "A receipt on a loan you gave".
 *
 * The other side of R-1864 / R-2323 (EMIs the company PAYS): money that comes back on a loan the
 * company GAVE (lib/accounting/loans-given.ts, the R-544 loans-given model). An open loan given
 * whose next receipt is this amount (±₹1) is suggested first as receipt N; the split is shown
 * before saving: principal back (reduces the Loans given asset) + interest (P&L "Interest received").
 * When no loan given is in the books yet: "Set up loan given" — borrower, amount lent, rate, EMI,
 * receipts, first receipt (this line by default), and where the money went: "Lent before these
 * books — no bank entry" (default) or an imported unmatched money-out line of that amount. Save
 * sets the loan up AND reconciles this line as receipt 1, one transaction on the server.
 * Undo = Un-reconcile the line (latest receipt first).
 *
 * Owner and accountant only (R-544: who the company lent money to is not for every role).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { formatDate, rupee } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  canUseLoansGiven, emiReceiptSchedule, loanGivenSetupErrors, loanGivenSetupPayload, matchLoanGivenReceipts,
  splitRepayment, type LoanGivenSetupInput,
} from "@/lib/accounting/loans-given";
import {
  useLoanGivenDisbursalLines, useLoansGiven, useReconcileCreditToLoanGiven, useSetUpLoanGiven,
} from "@/lib/queries/loans-given";

type Txn = { id: string; credit: number | null; txn_date: string; description: string | null };

const inputCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";
const toNum = (s: string) => (s.trim() === "" ? NaN : Number(s));
/** "Lent before these books" in the money-lent select. */
const BEFORE_BOOKS = "";

export function LoanGivenReceiptSection({ transaction, onDone }: { transaction: Txn; onDone: () => void }) {
  const role = useCurrentUser().data?.role;
  const allowed = canUseLoansGiven(role);
  const loansQ = useLoansGiven(allowed);
  const reconcile = useReconcileCreditToLoanGiven();
  const amount = Math.round(transaction.credit ?? 0);

  const loans = React.useMemo(() => loansQ.data ?? [], [loansQ.data]);
  const matches = React.useMemo(() => matchLoanGivenReceipts(loans.map((l) => ({
    id: l.id, borrowerName: l.borrower_name, status: l.status, terms: l.terms,
    principalRepaid: l.position.principalRepaid, receipts: l.repayments.length,
  })), amount), [loans, amount]);
  const [picked, setPicked] = React.useState("");
  React.useEffect(() => { if (!picked && matches.length > 0) setPicked(matches[0].loanId); }, [matches, picked]);
  const [setUpOpen, setSetUpOpen] = React.useState(false);

  if (!allowed) return null;

  const m = matches.find((x) => x.loanId === picked) ?? null;
  const loan = m ? loans.find((l) => l.id === m.loanId) : undefined;
  const split = loan ? splitRepayment(loan.terms, loan.parts, transaction.txn_date, amount) : null;
  const exact = matches.some((x) => x.confidence === "exact");

  async function save() {
    if (!m || !loan || !split || split.tooMuch) return;
    await reconcile.mutateAsync({
      txnId: transaction.id, loanId: loan.id,
      interestPart: loan.terms.plan === "emi" ? null : split.interestPart,
    });
    onDone();
  }

  return (
    <div className={`rounded-md border p-3 space-y-2 ${exact ? "border-indigo/50 bg-indigo-soft/25" : "border-hairline"}`} data-testid="loan-given-receipt-section">
      <p className="text-xs font-semibold text-ink-2">
        {m && exact ? <>Looks like receipt {m.seq} of the loan you gave — <b>{m.borrowerName}</b></> : "A receipt on a loan you gave?"}
      </p>
      <p className="text-xs text-ink-3 leading-relaxed">
        Principal back reduces the loan (an asset); the interest is income — never the whole amount as income.
      </p>
      {loansQ.isLoading ? (
        <p className="text-xs text-ink-3">Looking for the loan…</p>
      ) : matches.length > 0 ? (
        <>
          <ul className="space-y-1.5" role="radiogroup" aria-label="Which loan given">
            {matches.map((x) => (
              <li key={x.loanId}>
                <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${picked === x.loanId ? "border-indigo bg-paper" : "border-hairline"}`}>
                  <input type="radio" name="loan-given-match" className="mt-1" checked={picked === x.loanId} onChange={() => setPicked(x.loanId)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">Receipt {x.seq} · {x.borrowerName}</span>
                    <span className="block text-xs text-ink-3">
                      {x.expected !== null ? <>Expected {rupee(x.expected)}</> : "No fixed receipt"}
                      {x.expected !== null && x.expected !== amount && <> · this line is {rupee(Math.abs(amount - x.expected))} {amount > x.expected ? "more" : "less"}</>}
                    </span>
                  </span>
                  {x.confidence === "exact" && <Badge kind="success" size="sm">Exact</Badge>}
                </label>
              </li>
            ))}
          </ul>
          {split && (
            <div className="rounded-md bg-paper-2/50 p-2.5 text-sm space-y-0.5" data-testid="loan-given-split">
              <div className="flex justify-between"><span className="text-ink-2">Principal back — reduces the loan</span><span className="font-mono tabular-nums">{rupee(split.principalPart)}</span></div>
              <div className="flex justify-between"><span className="text-ink-2">Interest — income (P&amp;L)</span><span className="font-mono tabular-nums">{rupee(split.interestPart)}</span></div>
              {split.closes && <p className="text-xs text-emerald pt-1">This receipt clears the loan.</p>}
            </div>
          )}
          {split?.tooMuch && <p className="text-xs text-rose-ink">More than is owed — at most {rupee(split.maxAmount)} can come in on this loan.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="primary" icon="check" disabled={!m || !split || split.tooMuch} loading={reconcile.isPending} onClick={save}>
              {m ? `Reconcile as receipt ${m.seq}` : "Pick the loan"}
            </Button>
            <button type="button" className="text-xs text-indigo-ink font-medium underline hover:no-underline" onClick={() => setSetUpOpen(true)}>
              A different loan — set up loan given
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-ink-3">No loan you gave is recorded yet.</p>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setSetUpOpen(true)}>Set up loan given</Button>
        </div>
      )}
      {setUpOpen && (
        <LoanGivenSetupDialog
          fromTxn={{ id: transaction.id, amount, date: transaction.txn_date }}
          onClose={() => setSetUpOpen(false)}
          onSaved={() => { setSetUpOpen(false); onDone(); }}
        />
      )}
    </div>
  );
}

function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function LoanGivenSetupDialog({ fromTxn, onClose, onSaved }: {
  fromTxn: { id: string; amount: number; date: string }; onClose: () => void; onSaved: () => void;
}) {
  const save = useSetUpLoanGiven();
  const accountsQ = useBankAccounts();
  const acctName = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));

  const [borrower, setBorrower] = React.useState("");
  const [lent, setLent] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [emi, setEmi] = React.useState(String(fromTxn.amount));
  const [months, setMonths] = React.useState("");
  const [firstDue, setFirstDue] = React.useState(fromTxn.date);
  const [lineId, setLineId] = React.useState(BEFORE_BOOKS);

  const principal = Math.round(toNum(lent));
  const linesQ = useLoanGivenDisbursalLines(principal > 0 ? principal : 0, firstDue);
  const lines = linesQ.data ?? [];
  React.useEffect(() => { if (lineId && !lines.some((l) => l.id === lineId)) setLineId(BEFORE_BOOKS); }, [lines, lineId]);

  const input: LoanGivenSetupInput = {
    borrower, principal, annualRatePct: toNum(rate), emi: Math.round(toNum(emi)), months: Math.round(toNum(months)),
    firstDueOn: firstDue, disbursalTxnId: lineId || null,
  };
  const errors = loanGivenSetupErrors(input);
  const rows = errors.length === 0 ? emiReceiptSchedule(input.principal, input.annualRatePct, input.emi, input.months, input.firstDueOn) : [];
  const first = rows[0];
  /* Receipt 1 is this line → reconcile it in the same save (the server works out the same split). */
  const reconcilesThisLine = firstDue === fromTxn.date && Boolean(first) && Math.abs(first.amount - fromTxn.amount) <= 1;
  const canSave = errors.length === 0 && rows.length > 0;

  async function submit() {
    if (!canSave) return;
    await save.mutateAsync(loanGivenSetupPayload(input, reconcilesThisLine ? fromTxn.id : null));
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up loan given</DialogTitle>
          <DialogDescription>
            Money you lent that comes back each month. Each receipt is split into principal (reduces the loan) and interest (income).
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Field htmlFor="loan-given-borrower" label="Borrower">
              <Input id="loan-given-borrower" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="e.g. Vinod Hem Raj" />
            </Field>
          </div>
          <Field htmlFor="loan-given-principal" label="Amount lent (₹)" hint="Principal owed before the first receipt below">
            <Input id="loan-given-principal" type="number" min={1} value={lent} onChange={(e) => setLent(e.target.value)} />
          </Field>
          <Field htmlFor="loan-given-rate" label="Interest rate (% a year)" hint="0 = interest-free">
            <Input id="loan-given-rate" type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field htmlFor="loan-given-emi" label="Monthly receipt (₹)" hint="As the borrower pays it">
            <Input id="loan-given-emi" type="number" min={1} value={emi} onChange={(e) => setEmi(e.target.value)} />
          </Field>
          <Field htmlFor="loan-given-months" label="Receipts (with the first one)">
            <Input id="loan-given-months" type="number" min={1} value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          <Field htmlFor="loan-given-first" label="First receipt date">
            <Input id="loan-given-first" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Field htmlFor="loan-given-lent-from" label="Money lent"
            hint={lineId ? "This statement line is reconciled to the loan — no new bank entry is made." : undefined}>
            <select id="loan-given-lent-from" className={inputCls} value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value={BEFORE_BOOKS}>Given before these books — no bank entry</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {formatDate(l.txn_date)} · {rupee(Number(l.debit))} · {acctName.get(l.bank_account_id) ?? "account"} · {l.description || "Money out"}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {first && (
          <div className="rounded-md bg-paper-2/50 p-2.5 text-sm space-y-0.5" data-testid="loan-given-first-receipt">
            <div className="flex justify-between"><span className="text-ink-2">Receipt 1 — principal back (reduces the loan)</span><span className="font-mono tabular-nums">{rupee(first.principal)}</span></div>
            <div className="flex justify-between"><span className="text-ink-2">Receipt 1 — interest (income)</span><span className="font-mono tabular-nums">{rupee(first.interest)}</span></div>
            <p className="text-xs text-ink-3 pt-1">
              {rows.length} receipts · total interest {rupee(rows.reduce((s, r) => s + r.interest, 0))} · the last receipt clears what is left
            </p>
            {!reconcilesThisLine && (
              <p className="text-xs text-amber-ink">Receipt 1 is not this line ({rupee(fromTxn.amount)} on {formatDate(fromTxn.date)}) — the loan is saved, and this line stays to reconcile.</p>
            )}
          </div>
        )}
        {errors.length > 0 && (borrower || lent || rate || months) && (
          <ul className="text-xs text-rose-ink space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!canSave} loading={save.isPending} onClick={submit}>
            {reconcilesThisLine ? "Save loan & reconcile receipt 1" : "Save loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
