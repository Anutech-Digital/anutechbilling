/**
 * R-2339 — Edit a loan set up from an EMI line (Accounting › Business Loans → Edit).
 *
 * Fixes a typing mistake in the lender, loan number, rate, EMIs left or EMI without undoing the
 * loan. Paid EMIs and the principal still owed stay as they are; the unpaid EMIs from the next
 * one on are recomputed with the set-up's rule (lib/accounting/loan-edit.ts) and shown before
 * saving. The server re-checks every row (edit_emi_loan).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { formatDate, rupee } from "@/lib/utils";
import { useEmiSchedule, type EmiPurchase } from "@/lib/queries/emi";
import { loanEditBase, loanEditErrors, loanEditPayload, loanEditSchedule, type LoanEditInput } from "@/lib/accounting/loan-edit";
import { useEditEmiLoan } from "./emi-loan-edit-query";

const labelCls = "block text-xs font-medium text-ink-2 mb-1";
const toNum = (s: string) => (s.trim() === "" ? NaN : Number(s));

function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function EmiLoanEditDialog({ loan, onClose }: { loan: EmiPurchase; onClose: () => void }) {
  const schedQ = useEmiSchedule(loan.id);
  const save = useEditEmiLoan();
  const base = schedQ.data ? loanEditBase(schedQ.data.rows, loan.outstanding) : null;
  const unpaidNow = schedQ.data ? schedQ.data.rows.filter((r) => !r.emi_payment_id).length : 0;

  const [lender, setLender] = React.useState(loan.lender ?? "");
  const [lenderRef, setLenderRef] = React.useState(loan.lender_ref ?? "");
  const [rate, setRate] = React.useState(loan.interest_rate == null ? "" : String(Number(loan.interest_rate)));
  const [emi, setEmi] = React.useState(loan.emi_amount ? String(loan.emi_amount) : "");
  const [months, setMonths] = React.useState<string | null>(null);  // null → the EMIs left now
  const monthsText = months ?? (unpaidNow ? String(unpaidNow) : "");

  const input: LoanEditInput = {
    lender, lenderRef,
    annualRatePct: toNum(rate),
    months: Math.round(toNum(monthsText)),
    emi: emi.trim() === "" ? null : Number(emi),
  };
  const errors = loanEditErrors(input);
  const sched = base && errors.length === 0 ? loanEditSchedule(base, input) : null;
  const first = sched?.rows[0];
  const canSave = Boolean(base && sched && !sched.error && sched.rows.length > 0) && errors.length === 0;

  async function submit() {
    if (!canSave || !sched) return;
    await save.mutateAsync(loanEditPayload(loan.id, input, sched.rows));
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit loan</DialogTitle>
          <DialogDescription>
            Paid EMIs and the {rupee(loan.outstanding)} still owed stay as they are. The EMIs not paid yet are worked out again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field htmlFor="loan-edit-lender" label="Lender (bank / NBFC)">
            <Input id="loan-edit-lender" value={lender} onChange={(e) => setLender(e.target.value)} />
          </Field>
          <Field htmlFor="loan-edit-ref" label="Loan number (optional)">
            <Input id="loan-edit-ref" value={lenderRef} onChange={(e) => setLenderRef(e.target.value)} />
          </Field>
          <Field htmlFor="loan-edit-rate" label="Interest rate (% a year)">
            <Input id="loan-edit-rate" type="number" min={0} max={60} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field htmlFor="loan-edit-emi" label="EMI (₹)" hint="As the bank takes it — blank: the standard EMI">
            <Input id="loan-edit-emi" type="number" min={1} value={emi} onChange={(e) => setEmi(e.target.value)} />
          </Field>
          <Field htmlFor="loan-edit-months" label="EMIs left (not paid yet)"
            hint={base ? `From EMI ${base.nextSeq}, due ${formatDate(base.nextDueOn)}` : undefined}>
            <Input id="loan-edit-months" type="number" min={1} value={monthsText} onChange={(e) => setMonths(e.target.value)} />
          </Field>
        </div>

        {schedQ.isLoading && <p className="text-xs text-ink-3">Loading the schedule…</p>}
        {schedQ.data && !base && <p className="text-xs text-ink-3">This loan is cleared — there is no EMI left to change.</p>}

        {first && sched && (
          <div className="rounded-md bg-paper-2/50 p-2.5 text-sm space-y-0.5" data-testid="loan-edit-preview">
            <div className="flex justify-between"><span className="text-ink-2">EMI {first.seq} — principal (reduces the loan)</span><span className="font-mono tabular-nums">{rupee(first.principal)}</span></div>
            <div className="flex justify-between"><span className="text-ink-2">EMI {first.seq} — interest (expense)</span><span className="font-mono tabular-nums">{rupee(first.interest)}</span></div>
            <p className="text-xs text-ink-3 pt-1">
              {sched.rows.length} EMIs of {rupee(sched.emi)}
              {sched.lastEmi !== sched.emi ? ` (last one ${rupee(sched.lastEmi)})` : ""} · interest still to pay {rupee(sched.totalInterest)}
            </p>
            {sched.lastEmi > sched.emi * 1.5 && (
              <p className="text-xs text-amber-ink">The last EMI is much bigger than the others — check the EMIs left.</p>
            )}
          </div>
        )}
        {sched?.error && <p className="text-xs text-rose-ink">{sched.error}</p>}
        {errors.length > 0 && (
          <ul className="text-xs text-rose-ink space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!canSave} loading={save.isPending} onClick={submit}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
