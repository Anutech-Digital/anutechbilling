/**
 * R-2388 — Private Vault → Loans: the two dialogs the Loans page uses.
 *
 *   LoanFormDialog     add / edit a loan (taken or given). For an EMI loan the EMI is
 *                      calculated (reducing balance) from amount, rate and months, and stays
 *                      editable — the bank's figure wins when it differs by a rupee.
 *   LoanPaymentDialog  Mark an EMI paid, a prepayment, interest, or (given) a repayment
 *                      received. Pre-filled with the scheduled split; ONE RPC books the
 *                      payment and its ledger entries (interest = expense "Loan EMI" /
 *                      interest income; principal = a transfer, not spend or income).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PersonalAccount } from "@/lib/queries/personal-vault";
import {
  useSavePersonalLoan,
  useRecordLoanPayment,
  type PersonalLoan,
} from "@/lib/queries/personal-loans";
import {
  GIVEN_KINDS,
  PAYMENT_KIND_LABEL,
  REPAY_TYPES,
  REPAY_TYPE_LABEL,
  TAKEN_KINDS,
  computeEmi,
  loanKindLabel,
  monthlyInterest,
  type LoanDirection,
  type LoanKind,
  type LoanPaymentKind,
  type LoanSummary,
  type NextDue,
  type RepayType,
} from "@/lib/vault/personal/loans";
import { isLiabilityAccount } from "@/lib/vault/personal/net-worth";
import { parseRupees, MAX_RUPEES } from "@/lib/vault/personal/parse-rupees";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

const NO_ACCOUNT = "none";
const LABEL = "block text-2xs uppercase tracking-wide text-ink-3 mb-1";

function AccountSelect({ id, value, onChange, accounts }: {
  id: string; value: string; onChange: (v: string) => void; accounts: PersonalAccount[];
}) {
  // EMIs leave / repayments land in a bank, cash or wallet — not a card.
  const pickable = accounts.filter((a) => a.is_active && !isLiabilityAccount(a.kind));
  const name = accounts.find((a) => a.id === value)?.label;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ACCOUNT}>Not linked</SelectItem>
        {pickable.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
        {value !== NO_ACCOUNT && !pickable.some((a) => a.id === value) && (
          <SelectItem value={value}>{name ?? "Removed account"}</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/* ── Add / edit a loan ───────────────────────────────────────────────────────────────────── */

interface LoanForm {
  loan_kind: LoanKind;
  party: string;
  principal: string;
  start_date: string;
  annual_rate: string;
  repay_type: RepayType;
  tenure_months: string;
  emi_amount: string;
  /** true once the owner typed their own EMI — then a change of amount/rate/months no longer overwrites it. */
  emiTyped: boolean;
  first_due_on: string;
  account_id: string;
  note: string;
}

function formFor(direction: LoanDirection, loan: PersonalLoan | null): LoanForm {
  if (loan) {
    return {
      loan_kind: loan.loan_kind, party: loan.party, principal: String(loan.principal), start_date: loan.start_date,
      annual_rate: loan.annual_rate == null ? "" : String(loan.annual_rate), repay_type: loan.repay_type,
      tenure_months: loan.tenure_months == null ? "" : String(loan.tenure_months),
      emi_amount: loan.emi_amount == null ? "" : String(loan.emi_amount), emiTyped: true,
      first_due_on: loan.first_due_on ?? "", account_id: loan.account_id ?? NO_ACCOUNT, note: loan.note ?? "",
    };
  }
  return {
    loan_kind: direction === "taken" ? "home" : "person", party: "", principal: "", start_date: istToday(),
    annual_rate: "", repay_type: direction === "taken" ? "emi" : "no_interest", tenure_months: "", emi_amount: "",
    emiTyped: false, first_due_on: "", account_id: NO_ACCOUNT, note: "",
  };
}

function parseRate(s: string): number | null | "bad" {
  const t = s.replace(/[%\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : "bad";
}

export function LoanFormDialog({ open, onOpenChange, direction, loan, accounts }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  direction: LoanDirection;
  /** null = a new loan. */
  loan: PersonalLoan | null;
  accounts: PersonalAccount[];
}) {
  const save = useSavePersonalLoan();
  const [f, setF] = React.useState<LoanForm>(() => formFor(direction, loan));
  const [issue, setIssue] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) { setF(formFor(direction, loan)); setIssue(null); }
  }, [open, direction, loan]);

  const principal = parseRupees(f.principal);
  const rate = parseRate(f.annual_rate);
  const months = Math.round(Number(f.tenure_months));
  const calcEmi = principal.ok && rate !== "bad" && f.tenure_months.trim() !== ""
    ? computeEmi(principal.value, rate, months) : 0;

  // The EMI follows amount / rate / months until the owner types their own figure.
  React.useEffect(() => {
    if (f.repay_type === "emi" && !f.emiTyped) {
      setF((s) => ({ ...s, emi_amount: calcEmi > 0 ? String(calcEmi) : "" }));
    }
  }, [calcEmi, f.repay_type, f.emiTyped]);

  const kinds = direction === "taken" ? TAKEN_KINDS : GIVEN_KINDS;
  const set = (patch: Partial<LoanForm>) => { setF((s) => ({ ...s, ...patch })); setIssue(null); };

  const handleSave = async () => {
    if (!f.party.trim()) {
      setIssue(direction === "taken" ? "Type the lender — e.g. SBI Home Loan or a person's name." : "Type who you lent the money to.");
      return;
    }
    if (!principal.ok || principal.value <= 0) {
      setIssue(!principal.ok && principal.reason === "too_big"
        ? `Amount too large — up to ${rupee(MAX_RUPEES)}. Check for extra zeros.`
        : "Type the loan amount in digits, like 2000000 or 20,00,000.");
      return;
    }
    if (rate === "bad") { setIssue("Interest rate is a % a year between 0 and 100, like 8.5."); return; }
    if (!f.start_date) { setIssue("Pick the date the loan started."); return; }
    let tenure: number | null = null;
    let emi: number | null = null;
    if (f.repay_type === "emi") {
      if (!Number.isInteger(months) || months < 1 || months > 600) { setIssue("Type the tenure in months (1 to 600), like 240 for 20 years."); return; }
      const e = parseRupees(f.emi_amount);
      if (!e.ok || e.value <= 0) { setIssue("Type the EMI in rupees, or fill amount, rate and months to calculate it."); return; }
      tenure = months;
      emi = e.value;
    } else if (f.tenure_months.trim() !== "") {
      if (!Number.isInteger(months) || months < 1 || months > 600) { setIssue("Tenure is in months, 1 to 600 — or leave it empty."); return; }
      tenure = months;
    }
    if (f.repay_type === "interest_only" && !(typeof rate === "number" && rate > 0)) {
      setIssue("Interest-only needs the interest rate.");
      return;
    }
    try {
      await save.mutateAsync({
        id: loan?.id,
        direction,
        loan_kind: f.loan_kind,
        party: f.party.trim(),
        principal: principal.value,
        start_date: f.start_date,
        annual_rate: rate,
        repay_type: f.repay_type,
        tenure_months: tenure,
        emi_amount: emi,
        first_due_on: f.first_due_on || null,
        account_id: f.account_id === NO_ACCOUNT ? null : f.account_id,
        note: f.note.trim() || null,
      });
      toast.success(loan ? "Loan updated." : direction === "taken" ? "Loan added — Net worth now counts it as owed." : "Loan added — Net worth now counts it as money owed to you.");
      onOpenChange(false);
    } catch {
      /* the hook already showed why */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{loan ? "Edit loan" : direction === "taken" ? "Add a loan you took" : "Add money you lent"}</DialogTitle>
          <DialogDescription className="text-xs">
            {direction === "taken"
              ? "Home, car, personal or gold loan, or money borrowed from someone. What is still to repay counts as owed in Net worth."
              : "Money you lent to family or a friend. What is still to come back counts as yours in Net worth."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ln-kind" className={LABEL}>Type of loan</label>
              <Select value={f.loan_kind} onValueChange={(v) => set({ loan_kind: v as LoanKind })}>
                <SelectTrigger id="ln-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => <SelectItem key={k} value={k}>{loanKindLabel(k, direction)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="ln-party" className={LABEL}>{direction === "taken" ? "Lender" : "Lent to"}</label>
              <Input id="ln-party" value={f.party} onChange={(e) => set({ party: e.target.value })}
                placeholder={direction === "taken" ? "SBI Home Loan" : "Brother"} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="ln-principal" className={LABEL}>Amount (₹)</label>
              <Input id="ln-principal" value={f.principal} inputMode="numeric" placeholder="2000000"
                onChange={(e) => set({ principal: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ln-start" className={LABEL}>Start date</label>
              <Input id="ln-start" type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ln-rate" className={LABEL}>Interest (% a year)</label>
              <Input id="ln-rate" value={f.annual_rate} inputMode="decimal" placeholder="optional — 8.5"
                onChange={(e) => set({ annual_rate: e.target.value })} />
            </div>
          </div>

          <div>
            <label htmlFor="ln-repay" className={LABEL}>How it is repaid</label>
            <Select value={f.repay_type} onValueChange={(v) => set({ repay_type: v as RepayType })}>
              <SelectTrigger id="ln-repay"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REPAY_TYPES.map((t) => <SelectItem key={t} value={t}>{REPAY_TYPE_LABEL[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="ln-tenure" className={LABEL}>Tenure (months)</label>
              <Input id="ln-tenure" value={f.tenure_months} inputMode="numeric"
                placeholder={f.repay_type === "emi" ? "240" : "optional"}
                onChange={(e) => set({ tenure_months: e.target.value })} />
            </div>
            {f.repay_type === "emi" && (
              <div>
                <label htmlFor="ln-emi" className={LABEL}>EMI (₹)</label>
                <Input id="ln-emi" value={f.emi_amount} inputMode="numeric"
                  onChange={(e) => set({ emi_amount: e.target.value, emiTyped: true })} />
                {calcEmi > 0 && String(calcEmi) !== f.emi_amount.replace(/[,\s₹]/g, "") && (
                  <button type="button" className="mt-1 text-3xs text-primary hover:underline"
                    onClick={() => set({ emi_amount: String(calcEmi), emiTyped: false })}>
                    Use calculated {rupee(calcEmi)}
                  </button>
                )}
                {calcEmi > 0 && String(calcEmi) === f.emi_amount.replace(/[,\s₹]/g, "") && (
                  <p className="mt-1 text-3xs text-ink-3">Calculated (reducing balance)</p>
                )}
              </div>
            )}
            {f.repay_type !== "no_interest" && (
              <div>
                <label htmlFor="ln-first" className={LABEL}>First {f.repay_type === "emi" ? "EMI" : "interest"} date</label>
                <Input id="ln-first" type="date" value={f.first_due_on} onChange={(e) => set({ first_due_on: e.target.value })} />
                {!f.first_due_on && <p className="mt-1 text-3xs text-ink-3">Empty = one month after start</p>}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ln-account" className={LABEL}>{direction === "taken" ? "EMIs paid from" : "Repayments come into"}</label>
              <AccountSelect id="ln-account" value={f.account_id} onChange={(v) => set({ account_id: v })} accounts={accounts} />
            </div>
            <div>
              <label htmlFor="ln-note" className={LABEL}>Note</label>
              <Input id="ln-note" value={f.note} placeholder="optional" onChange={(e) => set({ note: e.target.value })} />
            </div>
          </div>

          {issue && <p role="alert" className="text-xs text-rose">{issue}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} loading={save.isPending}>{loan ? "Update" : "Add loan"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Record a payment ────────────────────────────────────────────────────────────────────── */

export function paymentKindsFor(direction: LoanDirection, repay: RepayType): LoanPaymentKind[] {
  if (direction === "given") return repay === "no_interest" ? ["repayment"] : ["repayment", "interest"];
  if (repay === "emi") return ["emi", "prepayment"];
  if (repay === "interest_only") return ["interest", "prepayment"];
  return ["prepayment"];
}

/** Label of the type choice in the dialog — "Prepayment" reads as "Repay part" on a no-EMI loan. */
function kindChoiceLabel(k: LoanPaymentKind, repay: RepayType): string {
  if (k === "prepayment" && repay !== "emi") return "Repay principal";
  if (k === "interest") return "Interest";
  return PAYMENT_KIND_LABEL[k];
}

export function LoanPaymentDialog({ open, onOpenChange, loan, summary, next, initialKind, accounts }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loan: PersonalLoan | null;
  summary: LoanSummary | null;
  next: NextDue | null;
  initialKind: LoanPaymentKind | null;
  accounts: PersonalAccount[];
}) {
  const record = useRecordLoanPayment();
  const [kind, setKind] = React.useState<LoanPaymentKind>("emi");
  const [on, setOn] = React.useState(istToday());
  const [principal, setPrincipal] = React.useState("");
  const [interest, setInterest] = React.useState("");
  const [account, setAccount] = React.useState(NO_ACCOUNT);
  const [note, setNote] = React.useState("");
  const [issue, setIssue] = React.useState<string | null>(null);

  const prefill = React.useCallback((k: LoanPaymentKind) => {
    if (!loan || !summary) return;
    setKind(k);
    setIssue(null);
    if (k === "emi" && next) {
      setPrincipal(String(next.principal)); setInterest(String(next.interest)); setOn(next.dueOn <= istToday() ? next.dueOn : istToday());
    } else if (k === "interest") {
      setPrincipal("0"); setInterest(String(monthlyInterest(summary.outstanding, loan.annual_rate)));
      setOn(next && next.dueOn <= istToday() ? next.dueOn : istToday());
    } else if (k === "repayment") {
      setPrincipal(String(summary.outstanding)); setInterest("0"); setOn(istToday());
    } else {
      setPrincipal(""); setInterest("0"); setOn(istToday());
    }
  }, [loan, summary, next]);

  // Fill once per opening — never again while the owner types (the parent re-renders often).
  const prefillRef = React.useRef(prefill);
  React.useEffect(() => { prefillRef.current = prefill; }, [prefill]);
  const loanId = loan?.id;
  React.useEffect(() => {
    if (!open || !loan) return;
    const kinds = paymentKindsFor(loan.direction, loan.repay_type);
    setAccount(loan.account_id ?? NO_ACCOUNT);
    setNote("");
    prefillRef.current(initialKind && kinds.includes(initialKind) ? initialKind : kinds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open / loan
  }, [open, loanId, initialKind]);

  if (!loan || !summary) return null;
  const kinds = paymentKindsFor(loan.direction, loan.repay_type);
  const p = parseRupees(principal);
  const i = parseRupees(interest);
  const total = (p.ok ? p.value : 0) + (i.ok ? i.value : 0);
  const taken = loan.direction === "taken";

  const handleSave = async () => {
    if (!p.ok || !i.ok) { setIssue("Type amounts in digits, like 3189 or 14,167."); return; }
    if (p.value + i.value <= 0) { setIssue("Type the amount paid."); return; }
    if (kind === "interest" && p.value > 0) { setIssue("An interest payment has no principal — use Prepayment for principal."); return; }
    if (p.value > summary.outstanding) {
      setIssue(`Principal ${rupee(p.value)} is more than the ${rupee(summary.outstanding)} still outstanding.`);
      return;
    }
    if (!on) { setIssue("Pick the date."); return; }
    try {
      const r = await record.mutateAsync({
        loan_id: loan.id, kind, paid_on: on, principal: p.value, interest: i.value,
        account_id: account === NO_ACCOUNT ? null : account, note: note.trim() || null,
      });
      toast.success(r?.closed
        ? `${rupee(total)} recorded — the loan is fully repaid and closed.`
        : `${rupee(total)} recorded — ${rupee(Number(r?.outstanding ?? summary.outstanding - p.value))} still outstanding.`);
      onOpenChange(false);
    } catch {
      /* the hook already showed why */
    }
  };

  const title = kind === "emi" ? `Mark EMI ${next ? next.instalmentNo : ""} paid`
    : kind === "prepayment" ? (loan.repay_type === "emi" ? "Prepayment" : "Repay principal")
    : kind === "interest" ? (taken ? "Pay interest" : "Interest received")
    : "Repayment received";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{title.trim()}</DialogTitle>
          <DialogDescription className="text-xs">
            {loan.party} · {rupee(summary.outstanding)} outstanding.{" "}
            {taken
              ? "Interest is saved as an expense (Loan EMI); principal as a loan repayment — it lowers what you owe, it is not spending."
              : "Principal back is your own money returning (not income); interest is saved as income from Interest."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {kinds.length > 1 && (
            <div className="flex gap-1" role="group" aria-label="Payment type">
              {kinds.map((k) => (
                <Button key={k} size="sm" variant={k === kind ? "primary" : "outline"} aria-pressed={k === kind} onClick={() => prefill(k)}>
                  {kindChoiceLabel(k, loan.repay_type)}
                </Button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="lp-principal" className={LABEL}>Principal (₹)</label>
              <Input id="lp-principal" value={principal} inputMode="numeric" disabled={kind === "interest"}
                onChange={(e) => { setPrincipal(e.target.value); setIssue(null); }} />
            </div>
            <div>
              <label htmlFor="lp-interest" className={LABEL}>Interest (₹)</label>
              <Input id="lp-interest" value={interest} inputMode="numeric"
                onChange={(e) => { setInterest(e.target.value); setIssue(null); }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="lp-date" className={LABEL}>{taken ? "Paid on" : "Received on"}</label>
              <Input id="lp-date" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
            </div>
            <div>
              <label htmlFor="lp-account" className={LABEL}>{taken ? "Paid from" : "Received into"}</label>
              <AccountSelect id="lp-account" value={account} onChange={setAccount} accounts={accounts} />
            </div>
          </div>
          <div>
            <label htmlFor="lp-note" className={LABEL}>Note</label>
            <Input id="lp-note" value={note} placeholder="optional" onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-ink">Total: <b>{rupee(total)}</b></p>
          {issue && <p role="alert" className="text-xs text-rose">{issue}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} loading={record.isPending}>{taken ? "Mark paid" : "Record"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
