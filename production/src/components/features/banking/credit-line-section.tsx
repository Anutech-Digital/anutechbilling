/**
 * R-2374 — Bank → Reconcile → Loan / EMI: a line with a LENDER (bank / NBFC).
 *
 *   money in  → a drawdown on a credit line (OD / flexi): the outstanding goes up.
 *   money out → a repayment on a business loan or credit line, split into principal (reduces the
 *               loan) + interest (P&L Finance cost, head "Interest on loans / OD") − TDS u/s 194A
 *               kept back (default 0). Interest-only ACH: principal 0.
 *
 * "Set up a credit line" (lender, limit, rate, start, opening outstanding) is the same dialog the
 * Business Loans page uses (CreditLineDialog below — one way per task).
 * Undo = Un-reconcile the line on the bank page (the server reverses it).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import {
  useBusinessLoans, useRecordCreditLine, useReconcileCreditToCreditLine, useReconcileDebitToBusinessLoan,
  loanKind, creditLimitOf,
} from "@/lib/queries/business-loans";
import {
  loansForLine, repaymentSplitErrors, principalFromLine, headroom, INTEREST_ON_LOANS, type LenderLoan,
} from "@/lib/accounting/credit-line";
import { lenderInNarration } from "@/lib/banking/loan-disbursal-lines";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";
import { useLoanInterestTds } from "@/lib/queries/loan-interest-tds";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { suggestTdsForPayment, sectionLabel, fyStartOf } from "@/lib/accounting/loan-interest-tds";

type Txn = { id: string; credit: number | null; debit: number | null; txn_date: string; description: string | null };

const num = (s: string) => (s.trim() === "" ? 0 : Math.round(Number(s)));

export function CreditLineSection({ transaction, onDone, onFooterSave }: {
  transaction: Txn;
  onDone: () => void;
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const isIn = Number(transaction.credit ?? 0) > 0;
  const line = Math.round(Number(isIn ? transaction.credit : transaction.debit) || 0);
  const loansQ = useBusinessLoans();
  const draw = useReconcileCreditToCreditLine();
  const repay = useReconcileDebitToBusinessLoan();
  const [setUpOpen, setSetUpOpen] = React.useState(false);

  const loans: LenderLoan[] = React.useMemo(() => (loansQ.data ?? []).map((l) => ({
    id: l.id, lender: l.lender, kind: loanKind(l), status: l.status, outstanding: l.outstanding, creditLimit: creditLimitOf(l),
  })), [loansQ.data]);
  const choices = React.useMemo(() => loansForLine(loans, isIn ? "in" : "out", transaction.description), [loans, isIn, transaction.description]);

  const [picked, setPicked] = React.useState("");
  React.useEffect(() => { if (!choices.some((c) => c.id === picked)) setPicked(choices[0]?.id ?? ""); }, [choices, picked]);
  const loan = choices.find((c) => c.id === picked) ?? null;

  /* Money out: interest-only by default (the monthly ACH); type the interest → the rest is principal. */
  const [interest, setInterest] = React.useState(String(line));
  /* R-2376: once the owner types the interest, the TDS box is filled with the TDS due to a
     non-bank lender (s.393(1) T5(iii), old 194A) — 0 for a bank, an unmarked lender, a business
     that need not deduct, or while the FY total is not above ₹10,000. The owner's own figure stays. */
  const [tdsTxt, setTdsTxt] = React.useState<string | null>(null);
  const [interestTyped, setInterestTyped] = React.useState(false);
  const tdsQ = useLoanInterestTds();
  const profileQ = useComplianceProfile();
  const loanRows = loansQ.data;
  const businessType = profileQ.data?.businessType ?? null;
  const suggestedTds = React.useMemo(() => {
    const d = tdsQ.data;
    if (isIn || !loan || !d?.ready) return 0;
    const raw = (loanRows ?? []).find((l) => l.id === loan.id);
    return suggestTdsForPayment({
      events: d.events, settings: d.settings, businessType,
      lender: loan.lender, lenderType: raw?.director_id ? "non_bank" : null, on: transaction.txn_date, interest: num(interest),
    });
  }, [tdsQ.data, businessType, isIn, loan, loanRows, transaction.txn_date, interest]);
  const tds = tdsTxt ?? (interestTyped ? String(suggestedTds) : "0");
  const [principalTxt, setPrincipalTxt] = React.useState<string | null>(null);
  const principal = principalTxt !== null ? num(principalTxt) : principalFromLine(line, num(interest), num(tds));
  const errors = !isIn && loan
    ? repaymentSplitErrors({ line, principal, interest: num(interest), tds: num(tds), outstanding: loan.outstanding })
    : [];

  async function save() {
    if (!loan) return;
    if (isIn) await draw.mutateAsync({ txnId: transaction.id, loanId: loan.id });
    else {
      if (errors.length > 0) return;
      await repay.mutateAsync({ txnId: transaction.id, loanId: loan.id, principal, interest: num(interest), tds: num(tds) });
    }
    onDone();
  }

  const saveLabel = isIn ? "Reconcile as drawdown" : "Reconcile repayment";
  useFooterSaveReport(onFooterSave, !loansQ.isLoading && choices.length > 0
    ? { label: saveLabel, onSave: () => { void save().catch(() => { /* the hook shows the error */ }); },
        disabled: !loan || errors.length > 0, loading: draw.isPending || repay.isPending }
    : null);

  const named = loan ? lenderInNarration(transaction.description, loan.lender) : false;

  return (
    <div className={`rounded-md border p-3 space-y-2 ${named ? "border-indigo/50 bg-indigo-soft/25" : "border-hairline"}`} data-testid="credit-line-section">
      <p className="text-xs font-semibold text-ink-2">
        {isIn ? "Drawn from a credit line (OD / flexi)?" : "A repayment to a bank / NBFC lender?"}
      </p>
      <p className="text-xs text-ink-3 leading-relaxed">
        {isIn
          ? "Money drawn from the lender is not income — it adds to what the business owes."
          : <>Only the <b>interest</b> is an expense (Finance cost); the <b>principal</b> reduces what you owe.</>}
      </p>
      {loansQ.isLoading ? (
        <p className="text-xs text-ink-3">Looking for your loans…</p>
      ) : choices.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-ink-3">{isIn ? "No credit line is set up yet." : "No business loan or credit line with money owed."}</p>
          <Button size="sm" variant={onFooterSave ? "default" : "primary"} icon="plus" onClick={() => setSetUpOpen(true)}>Set up a credit line</Button>
        </div>
      ) : (
        <>
          <ul className="space-y-1.5" role="radiogroup" aria-label="Which loan">
            {choices.map((c) => {
              const room = headroom(c);
              return (
                <li key={c.id}>
                  <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${picked === c.id ? "border-indigo bg-paper" : "border-hairline"}`}>
                    <input type="radio" name="credit-line-pick" className="mt-1" checked={picked === c.id} onChange={() => setPicked(c.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">{c.lender} <span className="text-ink-3">· {c.kind === "credit_line" ? "credit line" : "loan"}</span></span>
                      <span className="block text-xs text-ink-3">
                        Owed {rupee(c.outstanding)}
                        {room !== null && <> · limit {rupee(c.creditLimit ?? 0)}{room < 0 ? <span className="text-rose-ink"> · over by {rupee(-room)}</span> : <> · {rupee(room)} free</>}</>}
                      </span>
                    </span>
                    {lenderInNarration(transaction.description, c.lender) && <Badge kind="success" size="sm">Named</Badge>}
                  </label>
                </li>
              );
            })}
          </ul>

          {!isIn && loan && (
            <div className="rounded-md bg-paper-2/50 p-2.5 space-y-2" data-testid="credit-line-split">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label htmlFor="cl-interest" className="block text-xs font-medium text-ink-2 mb-1">Interest (₹)</label>
                  <Input id="cl-interest" type="number" min={0} value={interest} onChange={(e) => { setInterest(e.target.value); setInterestTyped(true); setPrincipalTxt(null); }} />
                </div>
                <div>
                  <label htmlFor="cl-principal" className="block text-xs font-medium text-ink-2 mb-1">Principal (₹)</label>
                  <Input id="cl-principal" type="number" min={0} value={principalTxt ?? String(principal)} onChange={(e) => setPrincipalTxt(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="cl-tds" className="block text-xs font-medium text-ink-2 mb-1">TDS 194A (₹)</label>
                  <Input id="cl-tds" type="number" min={0} value={tds} onChange={(e) => { setTdsTxt(e.target.value); setPrincipalTxt(null); }} />
                </div>
              </div>
              <p className="text-xs text-ink-3">
                Loan reduces by {rupee(principal)} · {rupee(num(interest))} to {INTEREST_ON_LOANS} (Finance cost)
                {num(tds) > 0 && <> · {rupee(num(tds))} TDS kept back (payable to the government)</>}.
                {suggestedTds > 0
                  ? <> TDS 10% is due to {loan.lender} ({sectionLabel(fyStartOf(transaction.txn_date))}): {rupee(suggestedTds)} on this interest — set TDS to 0 if you paid the interest in full.</>
                  : <> TDS stays 0 unless you deducted it from the interest.</>}
              </p>
              {errors.length > 0 && <ul className="text-xs text-rose-ink space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!onFooterSave && (
              <Button size="sm" variant="primary" icon="check" disabled={!loan || errors.length > 0} loading={draw.isPending || repay.isPending} onClick={save}>
                {saveLabel}
              </Button>
            )}
            <button type="button" className="text-xs text-indigo-ink font-medium underline hover:no-underline" onClick={() => setSetUpOpen(true)}>
              A different lender — set up a credit line
            </button>
          </div>
        </>
      )}
      {setUpOpen && <CreditLineDialog startOn={transaction.txn_date} onClose={() => setSetUpOpen(false)} />}
    </div>
  );
}

/** Set up a credit line (OD / flexi): lender, limit, rate, start, what was already owed. */
export function CreditLineDialog({ onClose, startOn }: { onClose: () => void; startOn?: string }) {
  const add = useRecordCreditLine();
  const [lender, setLender] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [limit, setLimit] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [start, setStart] = React.useState(startOn ?? istToday());
  const [opening, setOpening] = React.useState("");
  const valid = Boolean(lender.trim()) && Boolean(start) && num(limit) >= 0 && num(opening) >= 0;

  async function submit() {
    if (!valid) return;
    await add.mutateAsync({
      lender: lender.trim(), purpose: purpose.trim() || null,
      limit: num(limit) > 0 ? num(limit) : null, interestRate: rate.trim() ? Number(rate) : null,
      startOn: start, opening: num(opening),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Set up a credit line</DialogTitle>
          <DialogDescription>
            An OD or flexi loan you draw from and repay any time. Each drawdown and repayment is booked from its bank line (Banking → Reconcile → Loan / EMI).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="cl-lender" className="block text-xs font-medium text-ink-2 mb-1">Lender (bank / NBFC)</label>
            <Input id="cl-lender" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Bajaj Finance" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cl-limit" className="block text-xs font-medium text-ink-2 mb-1">Limit (₹, optional)</label>
              <Input id="cl-limit" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 5000000" />
            </div>
            <div>
              <label htmlFor="cl-rate" className="block text-xs font-medium text-ink-2 mb-1">Interest %/yr (optional)</label>
              <Input id="cl-rate" type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="15" />
            </div>
            <div>
              <label htmlFor="cl-start" className="block text-xs font-medium text-ink-2 mb-1">Started on</label>
              <Input id="cl-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <label htmlFor="cl-opening" className="block text-xs font-medium text-ink-2 mb-1">Already owed (₹)</label>
              <Input id="cl-opening" type="number" min={0} value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" />
            </div>
          </div>
          <p className="text-xs text-ink-3">&quot;Already owed&quot; is only for money drawn before these books (no bank line). Leave it 0 when the drawdown is on your imported statement.</p>
          <div>
            <label htmlFor="cl-purpose" className="block text-xs font-medium text-ink-2 mb-1">Purpose (optional)</label>
            <Input id="cl-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Working capital" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={add.isPending} disabled={!valid} onClick={submit}>Set up credit line</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
