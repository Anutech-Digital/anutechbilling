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
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  guessLender, loanSetupErrors, loanSetupPayload, loanSetupSchedule, type LoanSetupInput,
} from "@/lib/accounting/loan-setup";
import { useSetUpEmiLoan } from "@/lib/banking/loan-setup-query";

const inputCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";
const toNum = (s: string) => (s.trim() === "" ? NaN : Number(s));

export type LoanSetupFromTxn = { id: string; amount: number; date: string; description: string };

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
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

  const input: LoanSetupInput = {
    lender,
    principal: Math.round(toNum(owed)),
    annualRatePct: toNum(rate),
    emi: Number(emi) > 0 ? Math.round(Number(emi)) : null,
    months: Math.round(toNum(months)),
    firstDueOn: firstDue,
    receivedInto: accountId ? { accountId, receivedOn } : null,
  };
  const errors = loanSetupErrors(input);
  const sched = errors.length === 0 ? loanSetupSchedule(input) : null;
  const first = sched?.rows[0];
  /* EMI 1 is this line → reconcile it in the same save (the server refuses unless it is exactly EMI 1). */
  const reconcilesThisLine = firstDue === fromTxn.date && input.emi === Math.round(fromTxn.amount);
  const canSave = errors.length === 0 && Boolean(sched && sched.rows.length > 0 && !sched.error);

  async function submit() {
    if (!canSave || !sched) return;
    await save.mutateAsync(loanSetupPayload(input, sched.rows, reconcilesThisLine ? fromTxn.id : null));
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
            <Field id="loan-setup-lender" label="Lender (bank / NBFC)">
              <Input id="loan-setup-lender" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. HDFC Bank" />
            </Field>
          </div>
          <Field id="loan-setup-owed" label="Amount still owed (₹)" hint="Principal owed before the first EMI below — from the loan statement">
            <Input id="loan-setup-owed" type="number" min={1} value={owed} onChange={(e) => setOwed(e.target.value)} />
          </Field>
          <Field id="loan-setup-rate" label="Interest rate (% a year)">
            <Input id="loan-setup-rate" type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field id="loan-setup-emi" label="EMI (₹)" hint="As the bank takes it">
            <Input id="loan-setup-emi" type="number" min={1} value={emi} onChange={(e) => setEmi(e.target.value)} />
          </Field>
          <Field id="loan-setup-months" label="EMIs left (with the first one)">
            <Input id="loan-setup-months" type="number" min={1} value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          <Field id="loan-setup-first" label="First EMI date">
            <Input id="loan-setup-first" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Field id="loan-setup-account" label="Loan money came into">
            <select id="loan-setup-account" className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Taken before these books — no bank entry</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          {accountId && (
            <Field id="loan-setup-received" label="Received on">
              <Input id="loan-setup-received" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
            </Field>
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
