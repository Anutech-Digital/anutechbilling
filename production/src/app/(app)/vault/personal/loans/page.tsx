/**
 * R-2388 — Private Vault → Loans. Pardeep (2 Nov): "personal loan management system hona
 * chahiye".
 *
 *   Taken — home / car / personal / gold loan, overdraft, money borrowed from someone. EMI
 *           schedule (reducing balance), "Mark paid" books the EMI from the linked account
 *           (interest = expense "Loan EMI", principal = loan repayment, not spend),
 *           prepayment, close. Home loans: interest (Sec 24b) and principal (Sec 80C) paid
 *           this financial year, for the ITR.
 *   Given — money lent to a person: repayment received (principal back, not income) and
 *           interest received (income, source Interest).
 *
 * Net worth on the Overview adds loans given (asset) and subtracts loans taken (owed).
 * Data: lib/queries/personal-loans.ts; maths: lib/vault/personal/loans.ts.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import { LoanFormDialog, LoanPaymentDialog } from "@/components/features/vault/loans-section";
import { usePersonalAccounts } from "@/lib/queries/personal-vault";
import {
  usePersonalLoans,
  usePersonalLoanPayments,
  useDeletePersonalLoan,
  useSetLoanStatus,
  useUndoLoanPayment,
  type PersonalLoan,
} from "@/lib/queries/personal-loans";
import {
  PAYMENT_KIND_LABEL,
  SEC_24B_SELF_OCCUPIED_CAP,
  SEC_80C_CAP,
  buildSchedule,
  financialYear,
  homeLoanItr,
  loanKindLabel,
  loanTotals,
  nextDue,
  summariseLoan,
  type LoanDirection,
  type LoanPaymentKind,
} from "@/lib/vault/personal/loans";
import { istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";

const SCHEDULE_PREVIEW = 12;

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Number(rate).toLocaleString("en-IN", { maximumFractionDigits: 3 })}%`;
}

export default function PersonalLoansPage() {
  const accountsQ = usePersonalAccounts(true);
  const loansQ = usePersonalLoans();
  const paymentsQ = usePersonalLoanPayments();
  const setStatus = useSetLoanStatus();
  const del = useDeletePersonalLoan();
  const undo = useUndoLoanPayment();
  const confirm = useConfirm();

  const [tab, setTab] = React.useState<LoanDirection>("taken");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PersonalLoan | null>(null);
  const [paying, setPaying] = React.useState<{ loanId: string; kind: LoanPaymentKind | null } | null>(null);

  const loans = React.useMemo(() => loansQ.data ?? [], [loansQ.data]);
  const payments = React.useMemo(() => paymentsQ.data ?? [], [paymentsQ.data]);
  const accounts = accountsQ.data ?? [];

  // One summary per loan, recomputed only when the data changes.
  const info = React.useMemo(() => {
    const m = new Map<string, { summary: ReturnType<typeof summariseLoan>; next: ReturnType<typeof nextDue> }>();
    for (const l of loans) {
      const summary = summariseLoan(l, payments);
      m.set(l.id, { summary, next: nextDue(l, summary) });
    }
    return m;
  }, [loans, payments]);
  const totals = React.useMemo(() => loanTotals(loans, payments), [loans, payments]);
  const today = istToday();
  const fy = financialYear(today);
  const itr = React.useMemo(() => homeLoanItr(loans, payments, fy), [loans, payments, fy.start, fy.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // Links from the Overview: ?tab=given, ?pay=<loan id> (the "Next EMI due" reminder).
  const linkHandled = React.useRef(false);
  React.useEffect(() => {
    if (linkHandled.current || loansQ.isLoading || typeof window === "undefined") return;
    linkHandled.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("tab") === "given") setTab("given");
    const pay = sp.get("pay");
    const loan = pay ? loans.find((l) => l.id === pay && l.status === "open") : undefined;
    if (loan) { setTab(loan.direction); setSelected(loan.id); setPaying({ loanId: loan.id, kind: null }); }
  }, [loansQ.isLoading, loans]);

  const error = accountsQ.error || loansQ.error || paymentsQ.error;
  if (error) {
    return <VaultLoadError error={error} onRetry={() => { void accountsQ.refetch(); void loansQ.refetch(); void paymentsQ.refetch(); }} />;
  }
  if (accountsQ.isLoading || loansQ.isLoading || paymentsQ.isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  const rows = loans.filter((l) => l.direction === tab);
  const openRows = rows.filter((l) => l.status === "open");
  const closedRows = rows.filter((l) => l.status === "closed");
  const tabOutstanding = tab === "taken" ? totals.takenOutstanding : totals.givenOutstanding;
  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.label ?? null : null);

  const sel = selected ? loans.find((l) => l.id === selected && l.direction === tab) ?? null : null;
  const selInfo = sel ? info.get(sel.id) ?? null : null;
  const payLoan = paying ? loans.find((l) => l.id === paying.loanId) ?? null : null;
  const payInfo = payLoan ? info.get(payLoan.id) ?? null : null;

  const openNew = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (l: PersonalLoan) => { setEditing(l); setFormOpen(true); };

  const handleClose = async (l: PersonalLoan) => {
    const out = info.get(l.id)?.summary.outstanding ?? 0;
    const ok = await confirm({
      title: `Close "${l.party}"?`,
      body: out > 0
        ? `${rupee(out)} is still outstanding. Closing means it was settled or written off — it will no longer count in Net worth. You can re-open it later.`
        : "The loan is fully repaid. It moves to Closed and no longer counts in Net worth.",
      confirmLabel: "Close loan",
    });
    if (!ok) return;
    try {
      await setStatus.mutateAsync({ id: l.id, status: "closed", closed_on: istToday() });
      toast.success("Loan closed.");
    } catch { /* the hook already showed why */ }
  };

  const handleReopen = async (l: PersonalLoan) => {
    try {
      await setStatus.mutateAsync({ id: l.id, status: "open", closed_on: null });
      toast.success("Loan re-opened.");
    } catch { /* the hook already showed why */ }
  };

  const handleDelete = async (l: PersonalLoan) => {
    const count = payments.filter((p) => p.loan_id === l.id).length;
    if (count > 0) {
      toast.error("This loan has payments.", { description: "Undo its payments first, or use Close loan so the history stays. Nothing was deleted." });
      return;
    }
    const ok = await confirm({
      title: `Delete "${l.party}"?`,
      body: "Use this only for a mistake. A repaid loan should be closed, not deleted.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(l.id);
      if (selected === l.id) setSelected(null);
      toast.success("Loan deleted.");
    } catch { /* the hook already showed why */ }
  };

  const handleUndo = async (paymentId: string, label: string) => {
    const ok = await confirm({
      title: `Undo this ${label}?`,
      body: "The payment and the entries it made in Income & Expenses are removed. The outstanding goes back up.",
      confirmLabel: "Undo payment",
      danger: true,
    });
    if (!ok) return;
    try {
      await undo.mutateAsync(paymentId);
      toast.success("Payment removed.");
    } catch { /* the hook already showed why */ }
  };

  const schedule = sel ? buildSchedule(sel, payments) : [];
  const paidRows = schedule.filter((r) => r.state === "paid");
  const plannedRows = schedule.filter((r) => r.state !== "paid");
  const visiblePlanned = showAll ? plannedRows : plannedRows.slice(0, SCHEDULE_PREVIEW);
  const selPayments = sel ? payments.filter((p) => p.loan_id === sel.id).slice().reverse() : [];

  return (
    <div className="space-y-4">
      {/* ── Taken / Given + Add ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-hairline p-0.5 bg-paper" role="group" aria-label="Loans taken or given">
          {(["taken", "given"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={tab === d}
              onClick={() => { setTab(d); setSelected(null); setShowAll(false); }}
              className={`px-3 py-1.5 text-sm rounded-md ${tab === d ? "bg-paper-2 text-ink font-medium" : "text-ink-3 hover:text-ink"}`}
            >
              {d === "taken" ? "Taken (I owe)" : "Given (owed to me)"}
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={openNew}>
          <Icon name="plus" size={14} className="mr-1" />
          {tab === "taken" ? "Add loan" : "Add money lent"}
        </Button>
      </div>

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-4">
          <p className="text-2xs uppercase tracking-wide text-ink-3">{tab === "taken" ? "Still to repay" : "Still to come back"}</p>
          <div className="mt-0.5">
            <Money amount={tabOutstanding} size="display" tone={tab === "taken" && tabOutstanding > 0 ? "negative" : "default"} autoNegative={false} />
          </div>
          <p className="text-3xs text-ink-3 mt-0.5">
            {openRows.length} open loan{openRows.length === 1 ? "" : "s"} · {tab === "taken" ? "counted as owed in Net worth" : "counted as yours in Net worth"}
          </p>
        </Card>
        {tab === "taken" ? (
          <Card className="p-4">
            <p className="text-2xs uppercase tracking-wide text-ink-3">Next EMI due</p>
            {totals.nextEmi ? (
              <>
                <p className="mt-1 text-sm text-ink">
                  <b>{formatDate(totals.nextEmi.dueOn)}</b> · {rupee(totals.nextEmi.amount)}
                  {totals.nextEmi.dueOn < today && <Badge kind="danger" size="sm" className="ml-2">Overdue</Badge>}
                </p>
                <p className="text-3xs text-ink-3 mt-0.5">{totals.nextEmi.party}</p>
                <Button size="sm" variant="outline" className="mt-2"
                  onClick={() => { setSelected(totals.nextEmi!.loanId); setPaying({ loanId: totals.nextEmi!.loanId, kind: null }); }}>
                  Mark paid
                </Button>
              </>
            ) : (
              <p className="mt-1 text-xs text-ink-3">No EMI due on an open loan.</p>
            )}
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-2xs uppercase tracking-wide text-ink-3">Received back so far</p>
            <div className="mt-0.5">
              <Money amount={rows.reduce((s, l) => s + (info.get(l.id)?.summary.principalPaid ?? 0), 0)} size="display" />
            </div>
            <p className="text-3xs text-ink-3 mt-0.5">
              + interest {rupee(rows.reduce((s, l) => s + (info.get(l.id)?.summary.interestPaid ?? 0), 0))}
            </p>
          </Card>
        )}
        {tab === "taken" && itr.loans > 0 ? (
          <Card className="p-4" aria-labelledby="loan-itr-title">
            <p id="loan-itr-title" className="text-2xs uppercase tracking-wide text-ink-3">Home loan · FY {fy.label} (for ITR)</p>
            <div className="mt-1 space-y-1 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink">Interest paid · Sec 24(b)</span>
                <Money amount={itr.interest} size="cell" />
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink">Principal repaid · Sec 80C</span>
                <Money amount={itr.principal} size="cell" />
              </div>
            </div>
            <p className="text-3xs text-ink-3 mt-1">
              Limits: 24(b) up to {rupee(SEC_24B_SELF_OCCUPIED_CAP)} for a self-occupied house; 80C up to {rupee(SEC_80C_CAP)} in total
              (with PPF, LIC, ELSS). Old tax regime only — check with your CA.
            </p>
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-2xs uppercase tracking-wide text-ink-3">Interest {tab === "taken" ? "paid" : "received"} · FY {fy.label}</p>
            <div className="mt-0.5">
              <Money
                amount={payments
                  .filter((p) => p.paid_on >= fy.start && p.paid_on <= fy.end && loans.some((l) => l.id === p.loan_id && l.direction === tab))
                  .reduce((s, p) => s + p.interest_part, 0)}
                size="display"
              />
            </div>
            <p className="text-3xs text-ink-3 mt-0.5">{tab === "taken" ? "Saved in Income & Expenses as Loan EMI" : "Saved in Income & Expenses as Interest income"}</p>
          </Card>
        )}
      </div>

      {/* ── The list ────────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon="rupee"
            title={tab === "taken" ? "No loans yet" : "No money lent yet"}
            body={tab === "taken"
              ? "Add your home, car or personal loan. You get the EMI schedule, a reminder for the next EMI, and your Net worth counts what you still owe."
              : "Lent money to family or a friend? Add it here — record repayments as they come back, and your Net worth counts what is still owed to you."}
            action={<Button variant="primary" onClick={openNew}>{tab === "taken" ? "Add loan" : "Add money lent"}</Button>}
          />
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper-2 text-2xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="text-left font-medium px-4 py-2">{tab === "taken" ? "Lender" : "Lent to"}</th>
                <th className="text-right font-medium px-3 py-2">Amount</th>
                <th className="text-right font-medium px-3 py-2">Rate</th>
                <th className="text-right font-medium px-3 py-2">EMI</th>
                <th className="text-right font-medium px-3 py-2">Outstanding</th>
                <th className="text-left font-medium px-3 py-2">Next due</th>
                <th className="text-right font-medium px-4 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {[...openRows, ...closedRows].map((l) => {
                const li = info.get(l.id)!;
                const isOpen = l.status === "open";
                const isSel = selected === l.id;
                return (
                  <tr key={l.id} className={`${isSel ? "bg-amber-soft/40" : ""} ${isOpen ? "" : "opacity-70"}`}>
                    <td className="px-4 py-2.5">
                      <button type="button" className="text-left hover:underline font-medium text-ink"
                        aria-expanded={isSel} onClick={() => { setSelected(isSel ? null : l.id); setShowAll(false); }}>
                        {l.party}
                      </button>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <Badge kind="muted" size="sm">{loanKindLabel(l.loan_kind, l.direction)}</Badge>
                        {!isOpen && <Badge kind="muted" size="sm">Closed{l.closed_on ? ` · ${formatDate(l.closed_on)}` : ""}</Badge>}
                        <span className="text-3xs text-ink-3">since {formatDate(l.start_date)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right"><Money amount={l.principal} size="cell" /></td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{pct(l.annual_rate)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {l.repay_type === "emi" && l.emi_amount ? <Money amount={l.emi_amount} size="cell" />
                        : <span className="text-2xs text-ink-3">{l.repay_type === "interest_only" ? "Interest only" : "—"}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Money amount={li.summary.outstanding} size="cell" tone={isOpen && tab === "taken" && li.summary.outstanding > 0 ? "negative" : "default"} autoNegative={false} />
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {li.next ? (
                        <span className={li.next.dueOn < today ? "text-rose" : "text-ink"}>
                          {formatDate(li.next.dueOn)} · {rupee(li.next.amount)}
                        </span>
                      ) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {isOpen ? (
                        <Button size="sm" variant="primary" onClick={() => { setSelected(l.id); setPaying({ loanId: l.id, kind: null }); }}>
                          {tab === "taken" ? (l.repay_type === "emi" ? "Mark EMI paid" : "Record payment") : "Record repayment"}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setSelected(isSel ? null : l.id)}>Details</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── One loan: actions, schedule, payments ───────────────────────── */}
      {sel && selInfo && (
        <Card className="p-0 overflow-hidden" aria-labelledby="loan-detail-title">
          <div className="px-4 py-3 border-b border-hairline bg-paper-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 id="loan-detail-title" className="text-sm font-medium text-ink">{sel.party}</h2>
              <p className="text-2xs text-ink-3 mt-0.5">
                {rupee(sel.principal)} · {pct(sel.annual_rate)}
                {sel.tenure_months ? ` · ${sel.tenure_months} months` : ""}
                {accountName(sel.account_id) && ` · ${sel.direction === "taken" ? "paid from" : "into"} ${accountName(sel.account_id)}`}
                {" · "}repaid {rupee(selInfo.summary.principalPaid)} + interest {rupee(selInfo.summary.interestPaid)}
                {sel.note && ` · ${sel.note}`}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {sel.status === "open" && sel.direction === "taken" && (
                <Button size="sm" variant="outline" onClick={() => setPaying({ loanId: sel.id, kind: "prepayment" })}>
                  {sel.repay_type === "emi" ? "Prepayment" : "Repay principal"}
                </Button>
              )}
              {sel.status === "open" && sel.direction === "given" && sel.repay_type !== "no_interest" && (
                <Button size="sm" variant="outline" onClick={() => setPaying({ loanId: sel.id, kind: "interest" })}>Interest received</Button>
              )}
              {sel.status === "open"
                ? <Button size="sm" variant="outline" onClick={() => handleClose(sel)}>Close loan</Button>
                : <Button size="sm" variant="outline" onClick={() => handleReopen(sel)}>Re-open</Button>}
              <Button size="sm" variant="ghost" onClick={() => openEdit(sel)} aria-label={`Edit ${sel.party}`}>
                <Icon name="edit" size={14} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleDelete(sel)} aria-label={`Delete ${sel.party}`} className="text-rose">
                <Icon name="trash" size={14} />
              </Button>
            </div>
          </div>

          {schedule.length > 0 ? (
            <table className="w-full text-sm" aria-label="Repayment schedule">
              <thead className="text-2xs uppercase tracking-wide text-ink-3">
                <tr className="border-b border-hairline">
                  <th className="text-left font-medium px-4 py-2">#</th>
                  <th className="text-left font-medium px-3 py-2">Due / paid</th>
                  <th className="text-right font-medium px-3 py-2">Opening</th>
                  <th className="text-right font-medium px-3 py-2">Interest</th>
                  <th className="text-right font-medium px-3 py-2">Principal</th>
                  <th className="text-right font-medium px-3 py-2">Closing</th>
                  <th className="text-right font-medium px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {[...paidRows, ...visiblePlanned].map((r, idx) => (
                  <tr key={`${r.state}-${idx}`} className={r.state === "due" ? "bg-amber-soft/40" : ""}>
                    <td className="px-4 py-1.5 tabular-nums text-ink-3">{r.no || "—"}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.state === "paid" ? <>{PAYMENT_KIND_LABEL[r.kind]} · {formatDate(r.paidOn ?? r.dueOn)}</> : formatDate(r.dueOn)}
                    </td>
                    <td className="px-3 py-1.5 text-right"><Money amount={r.opening} size="cell" /></td>
                    <td className="px-3 py-1.5 text-right"><Money amount={r.interest} size="cell" /></td>
                    <td className="px-3 py-1.5 text-right"><Money amount={r.principal} size="cell" /></td>
                    <td className="px-3 py-1.5 text-right"><Money amount={r.closing} size="cell" /></td>
                    <td className="px-4 py-1.5 text-right text-xs whitespace-nowrap">
                      {r.state === "paid" && <Badge kind="success" size="sm">Paid</Badge>}
                      {r.state === "due" && (
                        <Button size="sm" variant="primary" onClick={() => setPaying({ loanId: sel.id, kind: r.kind })}>Mark paid</Button>
                      )}
                      {r.state === "planned" && <span className="text-ink-3">Planned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-4 py-3 text-xs text-ink-3">
              {sel.repay_type === "no_interest"
                ? "No schedule for a loan without interest — record each repayment as it comes."
                : "Nothing left to schedule."}
            </p>
          )}
          {plannedRows.length > SCHEDULE_PREVIEW && (
            <div className="px-4 py-2 border-t border-hairline">
              <Button size="sm" variant="link" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${plannedRows.length} remaining instalments`}
              </Button>
            </div>
          )}

          {selPayments.length > 0 && (
            <div className="border-t border-hairline">
              <h3 className="px-4 pt-3 text-2xs font-bold uppercase tracking-wider text-ink-3">Payments recorded</h3>
              <ul className="divide-y divide-hairline">
                {selPayments.map((p) => (
                  <li key={p.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                    <span className="flex-1 min-w-0 text-ink">
                      {PAYMENT_KIND_LABEL[p.kind]} · {formatDate(p.paid_on)}
                      <span className="text-2xs text-ink-3"> · principal {rupee(p.principal_part)} + interest {rupee(p.interest_part)}{p.note ? ` · ${p.note}` : ""}</span>
                    </span>
                    <Money amount={p.principal_part + p.interest_part} size="cell" />
                    <Button size="sm" variant="ghost" onClick={() => handleUndo(p.id, PAYMENT_KIND_LABEL[p.kind].toLowerCase())}>Undo</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <LoanFormDialog open={formOpen} onOpenChange={setFormOpen} direction={editing?.direction ?? tab} loan={editing} accounts={accounts} />
      <LoanPaymentDialog
        open={paying !== null && payLoan !== null}
        onOpenChange={(v) => { if (!v) setPaying(null); }}
        loan={payLoan}
        summary={payInfo?.summary ?? null}
        next={payInfo?.next ?? null}
        initialKind={paying?.kind ?? null}
        accounts={accounts}
      />
    </div>
  );
}
