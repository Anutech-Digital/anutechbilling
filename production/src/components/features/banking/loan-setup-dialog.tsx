/**
 * R-2323 — "Set up this loan" from an EMI line (Banking → Reconcile → Loan / EMI), for a loan the
 * company took that is not in the books yet (a bike / car loan, an NBFC loan).
 *
 * Starts from the line: lender from the narration, EMI = the line, first EMI = the line's date —
 * so the owner types only what the statement cannot tell: the amount still owed, the rate and the
 * EMIs left. The schedule is lib/accounting/loan-setup.ts (standard reducing balance, the bank's
 * EMI kept); EMI 1's split is shown before saving. When the first EMI is this line, Save also
 * reconciles it as EMI 1 (one transaction on the server). Later EMIs are then suggested on their
 * own bank lines (R-1864 matching).
 *
 * R-2341: "Loan money came into <account>" lists the unmatched money-in lines on that account for
 * the loan amount (±₹1) within 15 days of when the money came in (lib/banking/loan-disbursal-lines.ts)
 * and picks the nearest — Save links the loan to THAT line, no new line. A new money-in line is
 * made only when the owner says the credit is not in the imported statement (warned: otherwise it
 * is counted twice). The default stays "Taken before these books — no bank entry" (owner, 1 Nov).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { formatDate, rupee } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  guessLender, loanSetupErrors, loanSetupPayload, loanSetupSchedule, type LoanSetupInput,
} from "@/lib/accounting/loan-setup";
import { useLoanDisbursalLines, useSetUpEmiLoan } from "@/lib/banking/loan-setup-query";
import { disbursalCandidates, disbursalWindow } from "@/lib/banking/loan-disbursal-lines";

/* R-2341: which statement line is the loan money — undefined = the nearest one, "none" = not in the statement. */
const NOT_IN_STATEMENT = "none";

const inputCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";
const toNum = (s: string) => (s.trim() === "" ? NaN : Number(s));

export type LoanSetupFromTxn = { id: string; amount: number; date: string; description: string };

function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function LoanSetupDialog({ fromTxn, onClose, onSaved }: { fromTxn: LoanSetupFromTxn; onClose: () => void; onSaved: () => void }) {
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active && a.account_type !== "credit_card");
  const save = useSetUpEmiLoan();

  const [lender, setLender] = React.useState(() => guessLender(fromTxn.description));
  const [owed, setOwed] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [emi, setEmi] = React.useState(String(Math.round(fromTxn.amount)));
  const [months, setMonths] = React.useState("");
  const [firstDue, setFirstDue] = React.useState(fromTxn.date);
  const [accountId, setAccountId] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState("");
  const [linePick, setLinePick] = React.useState<string | undefined>(undefined);

  const principal = Math.round(toNum(owed));
  /* R-2341: the statement's money-in lines that can be this loan's money. */
  const lineWindow = accountId ? disbursalWindow(receivedOn, firstDue) : null;
  const linesQ = useLoanDisbursalLines(accountId || null, principal, lineWindow);
  const candidates = accountId ? disbursalCandidates(linesQ.data ?? [], principal, lineWindow) : [];
  const chosenLine = linePick === NOT_IN_STATEMENT
    ? null
    : candidates.find((c) => c.id === linePick) ?? candidates[0] ?? null;

  const input: LoanSetupInput = {
    lender,
    principal,
    annualRatePct: toNum(rate),
    emi: Number(emi) > 0 ? Math.round(Number(emi)) : null,
    months: Math.round(toNum(months)),
    firstDueOn: firstDue,
    receivedInto: accountId ? { accountId, receivedOn: chosenLine ? chosenLine.txn_date : receivedOn } : null,
  };
  const errors = loanSetupErrors(input);
  const sched = errors.length === 0 ? loanSetupSchedule(input) : null;
  const first = sched?.rows[0];
  /* EMI 1 is this line → reconcile it in the same save (the server refuses unless it is exactly EMI 1). */
  const reconcilesThisLine = firstDue === fromTxn.date && input.emi === Math.round(fromTxn.amount);
  const canSave = errors.length === 0 && Boolean(sched && sched.rows.length > 0 && !sched.error);

  async function submit() {
    if (!canSave || !sched) return;
    await save.mutateAsync({
      ...loanSetupPayload(input, sched.rows, reconcilesThisLine ? fromTxn.id : null),
      received_txn_id: chosenLine?.id ?? null,
    });
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up this loan</DialogTitle>
          <DialogDescription>
            A loan you took (bank / NBFC). Each EMI is split into principal (reduces the loan) and interest (expense).
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Field htmlFor="loan-setup-lender" label="Lender (bank / NBFC)">
              <Input id="loan-setup-lender" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. HDFC Bank" />
            </Field>
          </div>
          <Field htmlFor="loan-setup-owed" label="Amount still owed (₹)" hint="Principal owed before the first EMI below — from the loan statement">
            <Input id="loan-setup-owed" type="number" min={1} value={owed} onChange={(e) => setOwed(e.target.value)} />
          </Field>
          <Field htmlFor="loan-setup-rate" label="Interest rate (% a year)">
            <Input id="loan-setup-rate" type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field htmlFor="loan-setup-emi" label="EMI (₹)" hint="As the bank takes it">
            <Input id="loan-setup-emi" type="number" min={1} value={emi} onChange={(e) => setEmi(e.target.value)} />
          </Field>
          <Field htmlFor="loan-setup-months" label="EMIs left (with the first one)">
            <Input id="loan-setup-months" type="number" min={1} value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          <Field htmlFor="loan-setup-first" label="First EMI date">
            <Input id="loan-setup-first" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Field htmlFor="loan-setup-account" label="Loan money came into">
            <select id="loan-setup-account" className={inputCls} value={accountId} onChange={(e) => { setAccountId(e.target.value); setLinePick(undefined); }}>
              <option value="">Taken before these books — no bank entry</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          {accountId && !chosenLine && (
            <Field htmlFor="loan-setup-received" label="Received on">
              <Input id="loan-setup-received" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
            </Field>
          )}
          {accountId && (
            <div className="sm:col-span-2 space-y-1.5" data-testid="loan-setup-statement-line">
              {!(principal > 0) ? (
                <p className="text-xs text-ink-3">Enter the amount still owed to find the loan money in your imported statement.</p>
              ) : candidates.length > 0 ? (
                <fieldset className="space-y-1">
                  <legend className={labelCls}>The loan money in your statement</legend>
                  {candidates.map((c) => (
                    <label key={c.id} className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                      <input type="radio" name="loan-setup-statement-line" className="mt-1" checked={chosenLine?.id === c.id}
                        onChange={() => setLinePick(c.id)} />
                      <span>
                        <span className="font-mono tabular-nums">{formatDate(c.txn_date)} · {rupee(Number(c.credit))}</span>
                        <span className="text-ink-2"> · {c.description || "Money in"}</span>
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                    <input type="radio" name="loan-setup-statement-line" className="mt-1" checked={!chosenLine}
                      onChange={() => setLinePick(NOT_IN_STATEMENT)} />
                    <span>Not in my imported statement — add a new money-in line</span>
                  </label>
                  {chosenLine && (
                    <p className="text-xs text-ink-3">This line is reconciled to the loan — no new bank entry is made.</p>
                  )}
                </fieldset>
              ) : (
                <p className="text-xs text-ink-3">
                  No unmatched money-in line of {rupee(principal)} on this account
                  {lineWindow ? ` from ${formatDate(lineWindow.from)} to ${formatDate(lineWindow.to)}` : ""}.
                </p>
              )}
              {!chosenLine && (
                <p className="text-xs text-amber-ink">
                  A new money-in line will be added. Only if this credit is not in your imported statement — otherwise it is counted twice.
                </p>
              )}
            </div>
          )}
        </div>

        {first && sched && (
          <div className="rounded-md bg-paper-2/50 p-2.5 text-sm space-y-0.5" data-testid="loan-setup-first-emi">
            <div className="flex justify-between"><span className="text-ink-2">EMI 1 — principal (reduces the loan)</span><span className="font-mono tabular-nums">{rupee(first.principal)}</span></div>
            <div className="flex justify-between"><span className="text-ink-2">EMI 1 — interest (expense)</span><span className="font-mono tabular-nums">{rupee(first.interest)}</span></div>
            <p className="text-xs text-ink-3 pt-1">
              {sched.rows.length} EMIs · total interest {rupee(sched.totalInterest)}
            </p>
            {sched.bankEmiDiffers && (
              <p className="text-xs text-ink-3">
                The bank&apos;s EMI {rupee(Number(emi))} is used (the standard EMI would be {rupee(sched.computedEmi)}); each month&apos;s
                interest is worked out on what is still owed, and the last EMI clears the rest.
              </p>
            )}
          </div>
        )}
        {sched?.error && <p className="text-xs text-rose-ink">{sched.error}</p>}
        {errors.length > 0 && (owed || rate || months || accountId) && (
          <ul className="text-xs text-rose-ink space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!canSave} loading={save.isPending} onClick={submit}>
            {reconcilesThisLine ? "Save loan & reconcile EMI 1" : "Save loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
