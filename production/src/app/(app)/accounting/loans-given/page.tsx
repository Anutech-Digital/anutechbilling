/**
 * Loans given (R-544) — money this business LENT to an outside person or company.
 *
 * Staff loans and salary advances are NOT here: they live in /accounting/loans, expense
 * advances in /accounting/advances. Loans the company TOOK are /accounting/business-loans.
 *
 * Giving a loan takes the money out of the chosen account and books it as an asset (owed
 * back). A repayment brings money in: interest due first, then principal. Outstanding,
 * schedule and overdue come from lib/accounting/loans-given.ts. Owner + accountant only.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { FAB } from "@/components/ui/fab";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate, cn } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import { useCustomers } from "@/lib/queries/customers";
import { useVendors } from "@/lib/queries/vendors";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canUseLoansGiven, splitRepayment, type RepaymentPlan, type ScheduleState } from "@/lib/accounting/loans-given";
import {
  useLoansGiven, useGiveLoan, useRecordLoanRepayment, useDeleteLoanGiven,
  MODE_LABEL, type LoanGiven, type RepaymentMode,
} from "@/lib/queries/loans-given";
import { istToday } from "@/lib/dates/ist";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";

export default function LoansGivenPage() {
  const me = useCurrentUser();
  const allowed = canUseLoansGiven(me.data?.role);
  const q = useLoansGiven(allowed);
  const [giveOpen, setGiveOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [repayId, setRepayId] = React.useState<string | null>(null);
  const [showClosed, setShowClosed] = React.useState(false);

  const loans = React.useMemo(() => q.data ?? [], [q.data]);
  const openLoan = loans.find((l) => l.id === openId) ?? null;
  const repayLoan = loans.find((l) => l.id === repayId) ?? null;

  if (me.isLoading) {
    return <div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-24 w-full" /></div>;
  }
  if (!allowed) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
        <Card className="py-2">
          <EmptyState
            icon="lock"
            title="Only the owner or the accountant can open Loans given"
            body="This list shows who the company lent money to. Ask your owner if you need a figure from it."
            action={<Link href="/accounting"><Button variant="primary">Back to Accounting</Button></Link>}
          />
        </Card>
      </div>
    );
  }

  const open = loans.filter((l) => l.status === "open");
  const shown = showClosed ? loans : open;
  const totalOut = open.reduce((s, l) => s + l.position.outstanding, 0);
  const totalOverdue = open.reduce((s, l) => s + l.overdue, 0);
  const overdueCount = open.filter((l) => l.overdue > 0).length;
  const interestIn = loans.reduce((s, l) => s + l.position.interestReceived, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto pb-24 md:pb-8">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Loans given</h1>
          <p className="text-sm text-ink-3 mt-1">Money you lent to other people or companies, and what they still owe.</p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setGiveOpen(true)}>Give a loan</Button>
      </div>

      {loans.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-5">
          <KPI label="Owed to you" value={rupee(totalOut)} />
          <KPI label="Open loans" value={String(open.length)} />
          <KPI label="Overdue" value={overdueCount > 0 ? `${rupee(totalOverdue)} · ${overdueCount}` : "None"} tone={overdueCount > 0 ? "rose" : undefined} />
          <KPI label="Interest received" value={rupee(interestIn)} tone="emerald" />
        </div>
      )}

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : q.isError ? (
        <LoadError what="Loans given" onRetry={() => void q.refetch()} />
      ) : loans.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No loans given yet"
            body={
              <>
                Record money you lent to someone outside the company. A loan is not an expense — it shows on the Balance Sheet as money owed back.
                <br />
                Lending to staff? Use <Link href="/accounting/loans" className="text-amber underline">Loans &amp; Salary Advances</Link> or{" "}
                <Link href="/accounting/advances" className="text-amber underline">Employee Advances</Link>.
              </>
            }
            action={<Button variant="primary" icon="plus" onClick={() => setGiveOpen(true)}>Give a loan</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm text-ink-3">{shown.length} {showClosed ? "loans" : "open loans"}</p>
            <Button size="sm" variant="default" aria-pressed={showClosed} onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? "Hide repaid" : `Show repaid (${loans.length - open.length})`}
            </Button>
          </div>

          {shown.length === 0 ? (
            <Card className="py-2">
              <EmptyState compact icon="check" title="Everything is repaid" body="All loans you gave have come back." />
            </Card>
          ) : (
            <>
              {/* Desktop table */}
              <Card className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                    <tr>
                      <th className="text-left  px-4 py-3">Borrower</th>
                      <th className="text-left  px-4 py-3">Given</th>
                      <th className="text-right px-4 py-3">Outstanding</th>
                      <th className="text-left  px-4 py-3">Next due</th>
                      <th className="text-left  px-4 py-3">Status</th>
                      <th className="text-right px-4 py-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {shown.map((l) => (
                      <tr key={l.id} className="hover:bg-paper-2/40">
                        <td className="px-4 py-3">
                          <button type="button" className="text-left font-medium text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded" onClick={() => setOpenId(l.id)}>
                            {l.borrower_name}
                          </button>
                          <div className="text-xs text-ink-3">{l.borrower_type === "company" ? "Company" : "Person"}{Number(l.interest_rate) > 0 ? ` · ${Number(l.interest_rate)}% a year` : " · interest-free"}</div>
                        </td>
                        <td className="px-4 py-3 text-ink-2">
                          <div className="font-mono">{rupee(l.principal)}</div>
                          <div className="text-xs text-ink-3">{formatDate(l.given_on)}</div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="font-mono font-semibold text-ink">{rupee(l.position.outstanding)}</div>
                          {l.position.interestDue > 0 && <div className="text-xs text-ink-3">incl. {rupee(l.position.interestDue)} interest</div>}
                        </td>
                        <td className="px-4 py-3 text-ink-2"><NextDueText loan={l} /></td>
                        <td className="px-4 py-3"><StatusBadge loan={l} /></td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            {l.status === "open" && <Button size="sm" variant="primary" onClick={() => setRepayId(l.id)}>Record repayment</Button>}
                            <Button size="sm" variant="default" onClick={() => setOpenId(l.id)}>Open</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Mobile cards */}
              <ul className="md:hidden space-y-2.5">
                {shown.map((l) => (
                  <li key={l.id}>
                    <Card className="p-4">
                      <button type="button" className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded" onClick={() => setOpenId(l.id)}>
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="font-medium text-ink leading-tight">{l.borrower_name}</div>
                          <div className="font-serif text-xl text-ink leading-none">{rupee(l.position.outstanding)}</div>
                        </div>
                        <div className="text-sm text-ink-3 mb-2">
                          {rupee(l.principal)} given {formatDate(l.given_on)} · <NextDueText loan={l} />
                        </div>
                      </button>
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge loan={l} />
                        {l.status === "open" && <Button size="sm" variant="primary" className="min-h-[44px]" onClick={() => setRepayId(l.id)}>Record repayment</Button>}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <FAB icon="plus" label="Give a loan" onClick={() => setGiveOpen(true)} ariaLabel="Give a loan" />
      {giveOpen && <GiveLoanDialog onClose={() => setGiveOpen(false)} />}
      {openLoan && !repayLoan && (
        <LoanDetailDialog loan={openLoan} onClose={() => setOpenId(null)} onRepay={() => setRepayId(openLoan.id)} />
      )}
      {repayLoan && <RepayDialog loan={repayLoan} onClose={() => setRepayId(null)} />}
    </div>
  );
}

function KPI({ label, value, tone }: { label: string; value: string; tone?: "rose" | "emerald" }) {
  const color = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${color} leading-tight`}>{value}</div>
    </Card>
  );
}

function StatusBadge({ loan }: { loan: LoanGiven }) {
  if (loan.status === "closed") return <Badge kind="success" dot>Repaid</Badge>;
  if (loan.overdue > 0) return <Badge kind="danger" dot>Overdue {rupee(loan.overdue)}</Badge>;
  return <Badge kind="warning" dot>Open</Badge>;
}

function NextDueText({ loan }: { loan: LoanGiven }) {
  if (loan.status === "closed") return <span>Repaid{loan.closed_on ? ` ${formatDate(loan.closed_on)}` : ""}</span>;
  const n = loan.next;
  if (!n) return <span>—</span>;
  if (!n.dueOn) return <span>{rupee(n.unpaid)} · no fixed date</span>;
  return <span className={cn(n.state === "overdue" && "text-rose font-medium")}>{rupee(n.unpaid)} on {formatDate(n.dueOn)}</span>;
}

const STATE_LABEL: Record<ScheduleState, string> = { paid: "Paid", part: "Part paid", overdue: "Overdue", due: "Due" };
const STATE_KIND: Record<ScheduleState, "success" | "info" | "danger" | "muted"> = {
  paid: "success", part: "info", overdue: "danger", due: "muted",
};

function LoanDetailDialog({ loan, onClose, onRepay }: { loan: LoanGiven; onClose: () => void; onRepay: () => void }) {
  const del = useDeleteLoanGiven();
  const confirm = useConfirm();
  const accountsQ = useBankAccounts();
  const acctName = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));
  const p = loan.position;

  const remove = async () => {
    if (await confirm({
      title: `Delete the loan to ${loan.borrower_name} (${rupee(loan.principal)})?`,
      body: "The money taken out of the account is put back. Only possible before any repayment.",
      confirmLabel: "Delete",
      danger: true,
    })) {
      await del.mutateAsync(loan.id);
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{loan.borrower_name}</DialogTitle>
          <DialogDescription>
            {rupee(loan.principal)} given {formatDate(loan.given_on)}
            {loan.paid_from_account_id ? ` from ${acctName.get(loan.paid_from_account_id) ?? "account"}` : ""}
            {" · "}{Number(loan.interest_rate) > 0 ? `${Number(loan.interest_rate)}% a year, simple` : "interest-free"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Fig label="Outstanding" value={rupee(p.outstanding)} strong />
            <Fig label="Loan left" value={rupee(p.principalLeft)} />
            <Fig label="Interest due" value={rupee(p.interestDue)} />
            <Fig label="Received so far" value={rupee(p.principalRepaid + p.interestReceived)} />
          </div>

          <section aria-labelledby="lg-schedule">
            <h3 id="lg-schedule" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
              {loan.repayment_plan === "instalments" ? `Schedule — ${loan.instalments} monthly parts` : "Due"}
            </h3>
            <ul className="space-y-1.5">
              {loan.schedule.map((r) => (
                <li key={r.n} className="flex items-center justify-between gap-3 rounded-md border border-hairline px-3 py-2 text-sm">
                  <span className="text-ink-2">{r.dueOn ? formatDate(r.dueOn) : "No fixed date"}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-ink">{rupee(r.unpaid > 0 && r.unpaid < r.principal ? r.unpaid : r.principal)}</span>
                    <Badge kind={STATE_KIND[r.state]}>{STATE_LABEL[r.state]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
            {Number(loan.interest_rate) > 0 && <p className="mt-1.5 text-xs text-ink-3">Loan amounts only. Interest is added on what is still owed.</p>}
          </section>

          <section aria-labelledby="lg-repayments">
            <h3 id="lg-repayments" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Repayments</h3>
            {loan.repayments.length === 0 ? (
              <p className="rounded-md border border-dashed border-hairline p-4 text-center text-sm text-ink-3">Nothing received yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {[...loan.repayments].reverse().map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-hairline px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{rupee(r.amount)}</div>
                      <div className="text-xs text-ink-3">
                        {formatDate(r.repaid_on)} · {MODE_LABEL[r.mode as RepaymentMode] ?? r.mode}
                        {r.reference ? ` · ${r.reference}` : ""}
                        {r.bank_account_id ? ` · ${acctName.get(r.bank_account_id) ?? "account"}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs">
                      <div className="text-ink-2">{rupee(r.principal_part)} loan</div>
                      {r.interest_part > 0 && <div className="text-emerald">{rupee(r.interest_part)} interest</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {loan.notes && <p className="text-sm text-ink-2"><span className="text-ink-3">Note:</span> {loan.notes}</p>}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {loan.repayments.length === 0 && (
            <Button type="button" variant="danger" loading={del.isPending} onClick={remove}>Delete</Button>
          )}
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
          {loan.status === "open" && <Button type="button" variant="primary" onClick={onRepay}>Record repayment</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("font-mono", strong ? "text-lg text-ink font-semibold" : "text-ink-2")}>{value}</div>
    </div>
  );
}

function GiveLoanDialog({ onClose }: { onClose: () => void }) {
  const give = useGiveLoan();
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active && a.account_type !== "credit_card");
  const customersQ = useCustomers();
  const vendorsQ = useVendors();

  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<"person" | "company">("person");
  const [principal, setPrincipal] = React.useState("");
  const [givenOn, setGivenOn] = React.useState(istToday());
  const [accountId, setAccountId] = React.useState("");
  const [rate, setRate] = React.useState("0");
  const [plan, setPlan] = React.useState<RepaymentPlan>("one_shot");
  const [dueOn, setDueOn] = React.useState("");
  const [months, setMonths] = React.useState("");
  const [link, setLink] = React.useState("");   // "c:<id>" | "v:<id>" | ""
  const [notes, setNotes] = React.useState("");
  const [tried, setTried] = React.useState(false);

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.round(Number(principal) || 0);
  const rateNum = Number(rate) || 0;
  const monthsNum = Math.round(Number(months) || 0);
  const problems: string[] = [];
  if (!name.trim()) problems.push("Add the borrower's name.");
  if (amt <= 0) problems.push("Add the amount you lent.");
  if (!accountId) problems.push("Pick the account the money went from (add one in Banking if the list is empty).");
  if (rateNum < 0 || rateNum > 100) problems.push("Interest must be between 0 and 100% a year.");
  if (plan === "instalments" && (monthsNum < 1 || monthsNum > 360)) problems.push("Add the number of monthly instalments (1–360).");
  if (plan === "instalments" && !dueOn) problems.push("Add the first instalment date.");
  if (dueOn && dueOn < givenOn) problems.push("The due date is before the loan date.");

  async function submit() {
    setTried(true);
    if (problems.length > 0) return;
    await give.mutateAsync({
      borrowerName: name.trim(), borrowerType: type, principal: amt, givenOn, paidFromAccountId: accountId,
      interestRate: rateNum, plan, dueOn: dueOn || null, instalments: plan === "instalments" ? monthsNum : null,
      customerId: link.startsWith("c:") ? link.slice(2) : null,
      vendorId: link.startsWith("v:") ? link.slice(2) : null,
      notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Give a loan</DialogTitle>
          <DialogDescription>The money leaves the account you pick and shows as owed back to you.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto pr-1 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <div>
              <label htmlFor="lg-name" className={labelCls}>Borrower</label>
              <Input id="lg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of person or company" autoFocus />
            </div>
            <fieldset>
              <legend className={labelCls}>Type</legend>
              <div className="flex gap-1.5">
                {(["person", "company"] as const).map((t) => (
                  <Button key={t} type="button" size="sm" variant={type === t ? "primary" : "default"} aria-pressed={type === t} className="min-h-[40px]" onClick={() => setType(t)}>
                    {t === "person" ? "Person" : "Company"}
                  </Button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="lg-amount" className={labelCls}>Amount (₹)</label>
              <Input id="lg-amount" type="number" inputMode="numeric" min={1} value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. 50000" />
            </div>
            <div>
              <label htmlFor="lg-date" className={labelCls}>Given on</label>
              <Input id="lg-date" type="date" value={givenOn} onChange={(e) => setGivenOn(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="lg-account" className={labelCls}>Paid from</label>
              <select id="lg-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="lg-rate" className={labelCls}>Interest % a year (0 = none)</label>
              <Input id="lg-rate" type="number" inputMode="decimal" min={0} max={100} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
          </div>

          <fieldset>
            <legend className={labelCls}>Repaid</legend>
            <div className="flex gap-1.5 flex-wrap">
              <Button type="button" size="sm" variant={plan === "one_shot" ? "primary" : "default"} aria-pressed={plan === "one_shot"} className="min-h-[40px]" onClick={() => setPlan("one_shot")}>All at once</Button>
              <Button type="button" size="sm" variant={plan === "instalments" ? "primary" : "default"} aria-pressed={plan === "instalments"} className="min-h-[40px]" onClick={() => setPlan("instalments")}>Monthly instalments</Button>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {plan === "instalments" && (
              <div>
                <label htmlFor="lg-months" className={labelCls}>Number of months</label>
                <Input id="lg-months" type="number" inputMode="numeric" min={1} max={360} value={months} onChange={(e) => setMonths(e.target.value)} placeholder="e.g. 10" />
              </div>
            )}
            <div>
              <label htmlFor="lg-due" className={labelCls}>{plan === "instalments" ? "First instalment on" : "Due on (optional)"}</label>
              <Input id="lg-due" type="date" value={dueOn} min={givenOn} onChange={(e) => setDueOn(e.target.value)} />
            </div>
          </div>
          {plan === "instalments" && monthsNum > 0 && amt > 0 && (
            <p className="text-xs text-ink-3">{monthsNum} parts of about {rupee(Math.floor(amt / monthsNum))}{rateNum > 0 ? ", plus interest on what is still owed" : ""}.</p>
          )}

          <div>
            <label htmlFor="lg-link" className={labelCls}>Also a customer or vendor? (optional)</label>
            <select id="lg-link" value={link} onChange={(e) => setLink(e.target.value)} className={selectCls}>
              <option value="">No</option>
              {(customersQ.data ?? []).length > 0 && (
                <optgroup label="Customers">
                  {(customersQ.data ?? []).map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
                </optgroup>
              )}
              {(vendorsQ.data ?? []).length > 0 && (
                <optgroup label="Vendors">
                  {(vendorsQ.data ?? []).map((v) => <option key={v.id} value={`v:${v.id}`}>{v.name}</option>)}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label htmlFor="lg-notes" className={labelCls}>Note (optional)</label>
            <Input id="lg-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Agreement signed, cheque no." />
          </div>

          {tried && problems.length > 0 && (
            <ul role="alert" className="rounded-md border border-rose/40 bg-rose/5 p-2.5 text-sm text-ink-2 list-disc pl-6">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={give.isPending} onClick={submit}>
            Give {amt > 0 ? rupee(amt) : "loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepayDialog({ loan, onClose }: { loan: LoanGiven; onClose: () => void }) {
  const repay = useRecordLoanRepayment();
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active && a.account_type !== "credit_card");

  const [date, setDate] = React.useState(istToday());
  const split0 = splitRepayment(loan.terms, loan.parts, istToday(), 0);
  const suggested = loan.next ? Math.min(loan.next.unpaid + loan.position.interestDue, split0.maxAmount) : split0.maxAmount;
  const [amount, setAmount] = React.useState(suggested > 0 ? String(suggested) : "");
  const [mode, setMode] = React.useState<RepaymentMode>("bank");
  const [accountId, setAccountId] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [tried, setTried] = React.useState(false);

  React.useEffect(() => {
    if (accountId || accounts.length === 0) return;
    const pick = mode === "cash" ? accounts.find((a) => a.account_type === "cash") : accounts.find((a) => a.account_type !== "cash");
    setAccountId((pick ?? accounts[0]).id);
  }, [accounts, accountId, mode]);

  const amt = Math.round(Number(amount) || 0);
  const s = splitRepayment(loan.terms, loan.parts, date || istToday(), amt);
  const problems: string[] = [];
  if (amt <= 0) problems.push("Add the amount received.");
  if (s.tooMuch) problems.push(`That is more than is owed on ${formatDate(date)}: at most ${rupee(s.maxAmount)}.`);
  if (!date || date < loan.given_on) problems.push(`The date must be on or after ${formatDate(loan.given_on)}.`);
  if (!accountId) problems.push("Pick the account the money came into.");

  async function submit() {
    setTried(true);
    if (problems.length > 0) return;
    await repay.mutateAsync({
      loanId: loan.id, repaidOn: date, amount: amt, interestPart: s.interestPart, bankAccountId: accountId,
      mode, reference: reference.trim() || null, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Record repayment — {loan.borrower_name}</DialogTitle>
          <DialogDescription>
            Owed today: <b className="text-ink">{rupee(loan.position.outstanding)}</b>
            {loan.position.interestDue > 0 ? ` (incl. ${rupee(loan.position.interestDue)} interest)` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="lg-r-amount" className={labelCls}>Amount (₹)</label>
              <Input id="lg-r-amount" type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </div>
            <div>
              <label htmlFor="lg-r-date" className={labelCls}>Received on</label>
              <Input id="lg-r-date" type="date" value={date} min={loan.given_on} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div className="rounded-md border border-hairline bg-paper-2/40 p-2.5 text-sm text-ink-2" aria-live="polite">
            {s.tooMuch ? (
              <p className="text-rose">More than is owed — at most {rupee(s.maxAmount)}.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Interest: <b className="text-ink">{rupee(s.interestPart)}</b></span>
                <span>Loan: <b className="text-ink">{rupee(s.principalPart)}</b></span>
                {s.closes && <Badge kind="success">Closes the loan</Badge>}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="lg-r-mode" className={labelCls}>How</label>
              <select id="lg-r-mode" value={mode} onChange={(e) => { setMode(e.target.value as RepaymentMode); setAccountId(""); }} className={selectCls}>
                {(Object.keys(MODE_LABEL) as RepaymentMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="lg-r-account" className={labelCls}>Into</label>
              <select id="lg-r-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="lg-r-ref" className={labelCls}>Reference (optional)</label>
              <Input id="lg-r-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
            </div>
            <div>
              <label htmlFor="lg-r-notes" className={labelCls}>Note (optional)</label>
              <Input id="lg-r-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          {tried && problems.length > 0 && (
            <ul role="alert" className="rounded-md border border-rose/40 bg-rose/5 p-2.5 text-sm text-ink-2 list-disc pl-6">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={repay.isPending} onClick={submit}>
            Record {amt > 0 && !s.tooMuch ? rupee(amt) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
