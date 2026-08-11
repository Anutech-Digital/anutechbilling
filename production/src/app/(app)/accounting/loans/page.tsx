/**
 * Employee Loans & Advances.
 *
 * A loan to an employee is an ASSET (money owed back), never an expense.
 * Disbursing moves cash OUT of a chosen bank/cash account; repayments (cash /
 * bank) bring it back, while a salary-deduction repayment moves no cash — it
 * just reduces the outstanding. Total outstanding shows up as an asset on the
 * Balance Sheet automatically. All cash movement is atomic (migration 0085).
 */
"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate, cn } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  useEmployeeLoans,
  useDisburseLoan,
  useRecordLoanRepayment,
  useSettleExpenseAdvance,
  useUpdateLoanNote,
  useEditLoan,
  useDeleteEmployeeLoan,
  useLoanRepayments,
  LOAN_KIND_LABEL,
  type EmployeeLoan,
  type EmployeeLoanKind,
  type LoanRepaymentMethod,
} from "@/lib/queries/employee-loans";
import { EXPENSE_CATEGORIES } from "@/lib/queries/expenses";
import { useEmployees } from "@/lib/queries/payroll";
import {
  useExpenseClaims, useApproveClaim, useRejectClaim, useEditClaim, useDeleteClaim,
  useClaimLink, getClaimReceiptUrl,
  type ExpenseClaim,
} from "@/lib/queries/expense-claims";
import { toast } from "sonner";

function todayISO(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

const METHOD_LABEL: Record<LoanRepaymentMethod, string> = {
  cash: "Cash", bank: "Bank transfer", salary_deduction: "Salary deduction", expense: "Spent (expense)",
};

export default function EmployeeLoansPage() {
  // useSearchParams (in the inner component) needs a Suspense boundary so the
  // production build doesn't bail out of static rendering.
  return (
    <React.Suspense fallback={null}>
      <EmployeeLoansInner />
    </React.Suspense>
  );
}

function EmployeeLoansInner() {
  const q = useEmployeeLoans();
  const params = useSearchParams();
  const [disburseOpen, setDisburseOpen] = React.useState(false);
  const [giveKind, setGiveKind] = React.useState<EmployeeLoanKind | null>(null);
  const giveOpenedRef = React.useRef(false);
  const [repayFor, setRepayFor] = React.useState<EmployeeLoan | null>(null);
  const [settleFor, setSettleFor] = React.useState<EmployeeLoan | null>(null);
  const [purposeFor, setPurposeFor] = React.useState<EmployeeLoan | null>(null);
  const [editFor, setEditFor] = React.useState<EmployeeLoan | null>(null);
  const [historyFor, setHistoryFor] = React.useState<EmployeeLoan | null>(null);
  const [typeFilter, setTypeFilter] = React.useState<"all" | EmployeeLoanKind>("all");
  const [claimLinkOpen, setClaimLinkOpen] = React.useState(false);
  const [rejectClaimFor, setRejectClaimFor] = React.useState<ExpenseClaim | null>(null);
  const [editClaimFor, setEditClaimFor] = React.useState<ExpenseClaim | null>(null);
  const deleteLoan = useDeleteEmployeeLoan();
  const confirm = useConfirm();
  const pendingClaimsQ = useExpenseClaims("pending");
  const pendingClaims = pendingClaimsQ.data ?? [];

  // Deep-link: /accounting/loans?give=salary_advance opens the give dialog
  // pre-set to that kind (used by the Payroll "Give salary advance" button).
  React.useEffect(() => {
    if (giveOpenedRef.current) return;
    const g = params.get("give");
    if (g === "loan" || g === "salary_advance" || g === "expense_advance") {
      giveOpenedRef.current = true;
      setGiveKind(g);
      setDisburseOpen(true);
      if (g !== "loan") setTypeFilter(g);
    }
  }, [params]);

  const confirmDelete = async (l: EmployeeLoan) => {
    if (await confirm({
      title: `Delete this ${LOAN_KIND_LABEL[l.kind].toLowerCase()} to ${l.employee_name} (${rupee(l.principal)})?`,
      body: "The disbursed cash will be restored to the account.",
      confirmLabel: "Delete",
      danger: true,
    })) {
      deleteLoan.mutate(l.id);
    }
  };

  const openAction = (l: EmployeeLoan) =>
    l.kind === "expense_advance" ? setSettleFor(l) : setRepayFor(l);
  const actionLabel = (l: EmployeeLoan) =>
    l.kind === "expense_advance" ? "Settle" : "Record repayment";

  const loans     = q.data ?? [];
  const isLoading = q.isLoading;
  const shown     = typeFilter === "all" ? loans : loans.filter((l) => l.kind === typeFilter);
  const kindCount = (k: EmployeeLoanKind) => loans.filter((l) => l.kind === k).length;

  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);
  const activeCount       = loans.filter((l) => l.status === "active").length;
  const totalDisbursed    = loans.reduce((s, l) => s + l.principal, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Employee Loans &amp; Advances</h1>
          <p className="text-sm text-ink-3 mt-1">
            Money lent to staff — an asset the company is owed back, not an expense. Cash moves through your bank/cash accounts and the outstanding shows on the Balance Sheet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" icon="link" onClick={() => setClaimLinkOpen(true)}>
            Expense claim link
          </Button>
          <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setDisburseOpen(true)}>
            Give loan / advance
          </Button>
        </div>
      </div>

      {pendingClaims.length > 0 && (
        <PendingClaimsPanel
          claims={pendingClaims}
          onReject={(c) => setRejectClaimFor(c)}
          onEdit={(c) => setEditClaimFor(c)}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <KPI label="Outstanding (owed back)" value={rupee(totalOutstanding)} tone="amber" />
        <KPI label="Active loans" value={String(activeCount)} />
        <KPI label="Total disbursed" value={rupee(totalDisbursed)} />
      </div>

      {loans.length > 0 && (kindCount("salary_advance") > 0 || kindCount("expense_advance") > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {([["all", "All"], ["loan", "Loans"], ["salary_advance", "Salary advances"], ["expense_advance", "Expense advances"]] as const).map(([k, label]) => {
            const count = k === "all" ? loans.length : kindCount(k);
            if (k !== "all" && count === 0) return null;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setTypeFilter(k)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  typeFilter === k ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
                )}
              >
                {label} <span className="opacity-70 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : loans.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No employee loans yet"
            body="Record a loan or advance you've given a team member. It's tracked as money owed back — repayments reduce it, and the balance shows as an asset."
            action={<Button variant="primary" icon="plus" onClick={() => setDisburseOpen(true)}>Give loan / advance</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Employee</th>
                  <th className="text-left  px-4 py-3">Purpose</th>
                  <th className="text-left  px-4 py-3">Disbursed</th>
                  <th className="text-right px-4 py-3">Principal</th>
                  <th className="text-right px-4 py-3">Repaid</th>
                  <th className="text-right px-4 py-3">Outstanding</th>
                  <th className="text-left  px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {shown.map((l) => (
                  <tr key={l.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3 text-ink font-medium">
                      <div className="flex items-center gap-2">
                        {l.employee_name}
                        <Badge kind={l.kind === "expense_advance" ? "warning" : l.kind === "salary_advance" ? "info" : "muted"}>
                          {LOAN_KIND_LABEL[l.kind]}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setPurposeFor(l)}
                        className="group inline-flex max-w-[220px] items-center gap-1.5 text-left text-ink-2 hover:text-ink"
                        title="Edit purpose"
                      >
                        <span className="truncate">{l.notes || <span className="italic text-ink-3">Add purpose</span>}</span>
                        <Icon name="edit" size={12} className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(l.disbursed_on)}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(l.principal)}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald">{l.repaid > 0 ? rupee(l.repaid) : "—"}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(l.outstanding)}</td>
                    <td className="px-4 py-3">
                      <Badge kind={l.status === "closed" ? "success" : "warning"} dot>
                        {l.status === "closed" ? "Cleared" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <LoanRowActions
                          loan={l}
                          onPrimary={l.status === "active" ? () => openAction(l) : undefined}
                          primaryLabel={l.status === "active" ? actionLabel(l) : undefined}
                          onHistory={() => setHistoryFor(l)}
                          onEdit={l.repaid === 0 ? () => setEditFor(l) : undefined}
                          onDelete={l.repaid === 0 ? () => confirmDelete(l) : undefined}
                        />
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
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-ink leading-tight">
                      {l.employee_name}
                      <span className="ml-1.5 align-middle">
                        <Badge kind={l.kind === "expense_advance" ? "warning" : l.kind === "salary_advance" ? "info" : "muted"}>
                          {LOAN_KIND_LABEL[l.kind]}
                        </Badge>
                      </span>
                    </div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(l.outstanding)}</div>
                  </div>
                  <div className="text-[11px] text-ink-3 mb-1.5">
                    {formatDate(l.disbursed_on)} · {rupee(l.principal)} lent · {rupee(l.repaid)} repaid
                  </div>
                  <button
                    type="button"
                    onClick={() => setPurposeFor(l)}
                    className="mb-2 inline-flex items-center gap-1.5 text-xs text-ink-2"
                  >
                    <Icon name="edit" size={11} className="text-ink-3" />
                    <span>{l.notes || <span className="italic text-ink-3">Add purpose</span>}</span>
                  </button>
                  <div className="flex items-center justify-between">
                    <Badge kind={l.status === "closed" ? "success" : "warning"} dot>
                      {l.status === "closed" ? "Cleared" : "Active"}
                    </Badge>
                    <LoanRowActions
                      loan={l}
                      onPrimary={l.status === "active" ? () => openAction(l) : undefined}
                      primaryLabel={l.status === "active" ? actionLabel(l) : undefined}
                      onHistory={() => setHistoryFor(l)}
                      onEdit={l.repaid === 0 ? () => setEditFor(l) : undefined}
                      onDelete={l.repaid === 0 ? () => confirmDelete(l) : undefined}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <FAB icon="plus" label="Loan / advance" onClick={() => setDisburseOpen(true)} ariaLabel="Give loan or advance" />
      {disburseOpen && <DisburseDialog initialKind={giveKind ?? undefined} onClose={() => { setDisburseOpen(false); setGiveKind(null); }} />}
      {repayFor && <RepaymentDialog loan={repayFor} onClose={() => setRepayFor(null)} />}
      {settleFor && <SettleDialog loan={settleFor} onClose={() => setSettleFor(null)} />}
      {purposeFor && <EditPurposeDialog loan={purposeFor} onClose={() => setPurposeFor(null)} />}
      {editFor && <EditLoanDialog loan={editFor} onClose={() => setEditFor(null)} />}
      {historyFor && <LoanHistoryDialog loan={historyFor} onClose={() => setHistoryFor(null)} />}
      {claimLinkOpen && <ClaimLinkDialog onClose={() => setClaimLinkOpen(false)} />}
      {rejectClaimFor && <RejectClaimDialog claim={rejectClaimFor} onClose={() => setRejectClaimFor(null)} />}
      {editClaimFor && <EditClaimDialog claim={editClaimFor} onClose={() => setEditClaimFor(null)} />}
    </div>
  );
}

/** Pending employee expense claims — owner approves (settles the advance) or rejects. */
function PendingClaimsPanel({
  claims, onReject, onEdit,
}: {
  claims: ExpenseClaim[];
  onReject: (c: ExpenseClaim) => void;
  onEdit: (c: ExpenseClaim) => void;
}) {
  const approve = useApproveClaim();
  const del     = useDeleteClaim();
  const confirm = useConfirm();
  const confirmDeleteClaim = async (c: ExpenseClaim) => {
    if (await confirm({
      title: `Delete ${c.employee_name}'s claim (${c.category} · ${rupee(c.amount)})?`,
      body: "This just removes the claim — nothing was booked.",
      confirmLabel: "Delete",
      danger: true,
    })) {
      del.mutate(c.id);
    }
  };
  return (
    <Card className="mb-6 border-amber/40 bg-amber-soft/30 p-4 md:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="inbox" size={16} className="text-amber-ink" />
        <h2 className="font-medium text-ink">Expense claims to review</h2>
        <Badge kind="warning">{claims.length}</Badge>
      </div>
      <ul className="space-y-2">
        {claims.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{c.employee_name}</span>
                <Badge kind="warning">{c.category}</Badge>
                <span className="font-mono text-sm text-ink">{rupee(c.amount)}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-3">
                {formatDate(c.spent_on)}
                {c.purpose ? ` · ${c.purpose}` : ""}
                {c.receipt_path ? " · 📎 receipt" : ""}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {c.receipt_path && <ReceiptLink path={c.receipt_path} />}
              <Button variant="ghost" size="sm" icon="edit" aria-label="Edit claim" onClick={() => onEdit(c)} />
              <Button variant="ghost" size="sm" icon="trash" aria-label="Delete claim" onClick={() => confirmDeleteClaim(c)} />
              <Button variant="ghost" size="sm" onClick={() => onReject(c)}>Reject</Button>
              <Button variant="primary" size="sm" loading={approve.isPending} onClick={() => approve.mutate(c.id)}>
                Approve
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-ink-3">
        Approving books the expense under its category and reduces that employee&apos;s advance. No cash moves — it already left when the advance was given.
      </p>
    </Card>
  );
}

function ReceiptLink({ path }: { path: string }) {
  const [loading, setLoading] = React.useState(false);
  async function open() {
    setLoading(true);
    try {
      const url = await getClaimReceiptUrl(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast.error("Couldn't open the receipt");
    } finally { setLoading(false); }
  }
  return <Button variant="ghost" size="sm" icon="eye" loading={loading} onClick={open}>Receipt</Button>;
}

function RejectClaimDialog({ claim, onClose }: { claim: ExpenseClaim; onClose: () => void }) {
  const reject = useRejectClaim();
  const [reason, setReason] = React.useState("");
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-sm">
        <DialogHeader>
          <DialogTitle>Reject claim</DialogTitle>
          <DialogDescription>
            {claim.employee_name} · {claim.category} · {rupee(claim.amount)}. Nothing is booked and the advance is unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <label className="mb-1 block text-sm text-ink-2">Reason (optional)</label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No receipt attached" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            onClick={() => reject.mutate({ claimId: claim.id, reason: reason || null }, { onSuccess: onClose })}
          >
            Reject claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditClaimDialog({ claim, onClose }: { claim: ExpenseClaim; onClose: () => void }) {
  const edit = useEditClaim();
  const [amount, setAmount]     = React.useState(String(claim.amount));
  const [category, setCategory] = React.useState(claim.category);
  const [purpose, setPurpose]   = React.useState(claim.purpose ?? "");
  const [spentOn, setSpentOn]   = React.useState(claim.spent_on);
  const amt = Math.round(Number(amount));
  const valid = Number.isFinite(amt) && amt > 0 && Boolean(category);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit claim — {claim.employee_name}</DialogTitle>
          <DialogDescription>Fix the details before approving. Nothing is booked until you approve.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-ink-3">Amount (₹)</label>
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-3">Date</label>
              <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-3">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-3">Purpose</label>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What was it for?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={edit.isPending}
            disabled={!valid}
            onClick={() => edit.mutate(
              { claimId: claim.id, amount: amt, category, purpose: purpose || null, spentOn },
              { onSuccess: onClose },
            )}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClaimLinkDialog({ onClose }: { onClose: () => void }) {
  const linkQ = useClaimLink();
  const link  = linkQ.data ?? "";
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("Couldn't copy"); }
  }
  const waHref = `https://wa.me/?text=${encodeURIComponent(`Log your expenses from your advance here: ${link}`)}`;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Expense claim link</DialogTitle>
          <DialogDescription>
            Share this with staff who have an expense advance. They pick their name, enter their attendance PIN, and log what they spent — you approve it here before it&apos;s recorded.
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          {linkQ.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
              </div>
              <a href={waHref} target="_blank" rel="noopener noreferrer"
                 className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline">
                <Icon name="whatsapp" size={15} /> Share on WhatsApp
              </a>
              <p className="mt-3 text-[11px] text-ink-3">
                Anyone with this link can open the form, but they must enter a valid employee PIN and every claim needs your approval — so it stays safe.
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoanHistoryDialog({ loan, onClose }: { loan: EmployeeLoan; onClose: () => void }) {
  const histQ     = useLoanRepayments(loan.id);
  const accountsQ = useBankAccounts();
  const acctName  = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));
  const rows      = histQ.data ?? [];
  const totalRepaid = rows.reduce((s, r) => s + r.amount, 0);
  const settled   = loan.kind === "expense_advance";

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Transactions — {loan.employee_name}</DialogTitle>
          <DialogDescription>
            {LOAN_KIND_LABEL[loan.kind]} · {rupee(loan.principal)} given · {rupee(totalRepaid)} {settled ? "settled" : "repaid"} · {rupee(loan.principal - totalRepaid)} outstanding
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {histQ.isLoading ? (
            <p className="text-xs text-ink-3">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-hairline p-6 text-center text-xs text-ink-3">
              No {settled ? "settlements" : "repayments"} yet.
            </div>
          ) : (
            rows.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-3 rounded-md border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-ink">{METHOD_LABEL[h.method]}</span>
                    {h.method === "expense" && h.expense_category && (
                      <Badge kind="warning">{h.expense_category}</Badge>
                    )}
                  </div>
                  {h.notes && (
                    <div className="text-xs text-ink-2">{h.method === "expense" ? "For: " : ""}{h.notes}</div>
                  )}
                  <div className="text-[11px] text-ink-3">
                    {formatDate(h.repaid_on)}
                    {h.bank_account_id ? ` · ${acctName.get(h.bank_account_id) ?? "account"}` : ""}
                  </div>
                </div>
                <div className="shrink-0 font-mono text-sm text-emerald">{rupee(h.amount)}</div>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditLoanDialog({ loan, onClose }: { loan: EmployeeLoan; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const edit      = useEditLoan();
  const accounts  = (accountsQ.data ?? []).filter((a) => a.is_active);

  const [name, setName]       = React.useState(loan.employee_name);
  const [amount, setAmount]   = React.useState(String(loan.principal));
  const [date, setDate]       = React.useState(loan.disbursed_on);
  const [accountId, setAccountId] = React.useState(loan.bank_account_id ?? "");
  const [kind, setKind]       = React.useState<EmployeeLoanKind>(loan.kind);
  const [notes, setNotes]     = React.useState(loan.notes ?? "");

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.round(Number(amount) || 0);
  const valid = name.trim().length > 0 && amt > 0 && Boolean(accountId);

  async function submit() {
    if (!valid) return;
    await edit.mutateAsync({
      loanId: loan.id, employeeName: name.trim(), principal: amt, disbursedOn: date,
      bankAccountId: accountId, kind, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Edit — {loan.employee_name}</DialogTitle>
          <DialogDescription>Fix a mistake. Changing the amount or account adjusts the bank entry automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as EmployeeLoanKind)} className={selectCls}>
              <option value="loan">Loan (repaid back)</option>
              <option value="salary_advance">Salary advance</option>
              <option value="expense_advance">Expense advance</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Employee name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Paid from</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Purpose (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={edit.isPending}>Cancel</Button>
          <Button variant="primary" loading={edit.isPending} disabled={!valid} onClick={submit}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoanRowActions({ loan, onPrimary, primaryLabel, onHistory, onEdit, onDelete }: {
  loan: EmployeeLoan;
  onPrimary?: () => void; primaryLabel?: string;
  onHistory: () => void; onEdit?: () => void; onDelete?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Actions"
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
        >
          <Icon name="more_h" size={20} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {onPrimary && primaryLabel && (
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onPrimary}>
            <Icon name={loan.kind === "expense_advance" ? "check_circle" : "rupee"} size={16} /> {primaryLabel}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onHistory}>
          <Icon name="clock" size={16} /> Transaction history
        </DropdownMenuItem>
        {(onEdit || onDelete) && <DropdownMenuSeparator />}
        {onEdit && (
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}>
            <Icon name="edit" size={16} /> Edit
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}>
            <Icon name="trash" size={16} /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditPurposeDialog({ loan, onClose }: { loan: EmployeeLoan; onClose: () => void }) {
  const update = useUpdateLoanNote();
  const [text, setText] = React.useState(loan.notes ?? "");

  async function submit() {
    await update.mutateAsync({ loanId: loan.id, notes: text.trim() || null });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Purpose — {loan.employee_name}</DialogTitle>
          <DialogDescription>What was this {LOAN_KIND_LABEL[loan.kind].toLowerCase()} for? Shown in the list.</DialogDescription>
        </DialogHeader>
        <div>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. medical advance · Mumbai client visit · festival bonus"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KPI({ label, value, tone }: { label: string; value: string; tone?: "amber" | "emerald" }) {
  const color = tone === "amber" ? "text-amber" : tone === "emerald" ? "text-emerald" : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${color} leading-tight`}>{value}</div>
    </Card>
  );
}

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

function DisburseDialog({ onClose, initialKind }: { onClose: () => void; initialKind?: EmployeeLoanKind }) {
  const accountsQ = useBankAccounts();
  const disburse  = useDisburseLoan();
  const empQ      = useEmployees();
  const accounts  = (accountsQ.data ?? []).filter((a) => a.is_active);
  const employees = (empQ.data ?? []).filter((e) => e.is_active);

  const [name, setName]         = React.useState("");
  const [nameOpen, setNameOpen] = React.useState(false);
  const [amount, setAmount]     = React.useState("");
  const [date, setDate]         = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");
  const [kind, setKind]         = React.useState<EmployeeLoanKind>(initialKind ?? "loan");
  const [notes, setNotes]       = React.useState("");

  React.useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const amt = Math.round(Number(amount));

  async function submit() {
    if (!name.trim()) return;
    if (!Number.isFinite(amt) || amt <= 0) return;
    if (!accountId) return;
    await disburse.mutateAsync({
      employeeName: name.trim(), principal: amt, disbursedOn: date, bankAccountId: accountId, kind, notes: notes.trim() || null,
    });
    onClose();
  }

  const kindHint =
    kind === "expense_advance"
      ? "To spend on company work (travel, purchases). You'll settle it against expense bills, not repay it."
      : kind === "salary_advance"
        ? "Advance pay, recovered later — usually deducted from salary."
        : "A personal loan, repaid back in cash / bank / salary deduction.";
  const kindNoun = kind === "salary_advance" ? "salary advance" : kind === "expense_advance" ? "expense advance" : "loan";

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Give a loan / advance</DialogTitle>
          <DialogDescription>Money leaves the chosen account and is tracked as owed back to you.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1.5">What are you giving?</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {([
                { k: "loan", label: "Loan", desc: "Repaid back" },
                { k: "salary_advance", label: "Salary advance", desc: "Recovered from pay" },
                { k: "expense_advance", label: "Expense advance", desc: "Spent on company work" },
              ] as const).map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => setKind(opt.k)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    kind === opt.k ? "border-amber bg-amber-soft" : "border-hairline hover:bg-paper-2",
                  )}
                >
                  <div className={cn("text-sm font-medium", kind === opt.k ? "text-amber-ink" : "text-ink")}>{opt.label}</div>
                  <div className="text-[10px] text-ink-3 mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-3">{kindHint}</p>
          </div>
          <div className="relative">
            <label className="block text-xs font-medium text-ink-2 mb-1">Employee</label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); setNameOpen(true); }}
              onFocus={() => setNameOpen(true)}
              onBlur={() => setTimeout(() => setNameOpen(false), 130)}
              placeholder={employees.length ? "Search employees…" : "Type a name"}
            />
            {nameOpen && employees.length > 0 && (() => {
              const q = name.trim().toLowerCase();
              const matches = q ? employees.filter((e) => e.name.toLowerCase().includes(q)) : employees;
              if (matches.length === 0) return null;
              return (
                <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                  {matches.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onMouseDown={(ev) => { ev.preventDefault(); setName(e.name); setNameOpen(false); }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2"
                    >
                      <span className="text-ink">{e.name}</span>
                      <span className="text-[11px] text-ink-3">{rupee(e.monthly_gross)}/mo</span>
                    </button>
                  ))}
                </div>
              );
            })()}
            {employees.length === 0 && (
              <p className="mt-1 text-[11px] text-ink-3">No employees yet — add them in Payroll → Employees. You can still type a name.</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25000" />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Paid from</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
              {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.current_balance != null ? ` · ${rupee(a.current_balance)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Note (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. medical advance, interest-free" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={disburse.isPending}>Cancel</Button>
          <Button
            variant="primary"
            loading={disburse.isPending}
            disabled={!name.trim() || !(amt > 0) || !accountId}
            onClick={submit}
          >
            Give {kindNoun}{amt > 0 ? ` · ${rupee(amt)}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepaymentDialog({ loan, onClose }: { loan: EmployeeLoan; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const repay     = useRecordLoanRepayment();
  const historyQ  = useLoanRepayments(loan.id);
  const accounts  = (accountsQ.data ?? []).filter((a) => a.is_active);

  const [amount, setAmount] = React.useState(String(loan.outstanding));
  const [date, setDate]     = React.useState(todayISO());
  const [method, setMethod] = React.useState<LoanRepaymentMethod>("cash");
  const [accountId, setAccountId] = React.useState("");
  const [notes, setNotes]   = React.useState("");

  React.useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const amt = Math.round(Number(amount));
  const needsAccount = method === "cash" || method === "bank";
  const tooMuch = amt > loan.outstanding;
  const valid = amt > 0 && !tooMuch && (!needsAccount || Boolean(accountId));

  async function submit() {
    if (!valid) return;
    await repay.mutateAsync({
      loanId: loan.id, amount: amt, repaidOn: date, method,
      bankAccountId: needsAccount ? accountId : null, notes: notes.trim() || null,
    });
    onClose();
  }

  const history = historyQ.data ?? [];

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Record repayment — {loan.employee_name}</DialogTitle>
          <DialogDescription>
            Outstanding: <b className="text-ink">{rupee(loan.outstanding)}</b> of {rupee(loan.principal)}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            {tooMuch && <p className="mt-1 text-[11px] text-rose">Can&apos;t exceed the outstanding {rupee(loan.outstanding)}.</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Repaid via</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as LoanRepaymentMethod)} className={selectCls}>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="salary_deduction">Salary deduction (no cash moves)</option>
            </select>
          </div>
          {needsAccount && (
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Received in</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Note (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {history.length > 0 && (
            <div className="rounded-md border border-hairline bg-paper-2/40 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Repayments so far</div>
              <ul className="space-y-1">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between text-xs text-ink-2">
                    <span>{formatDate(h.repaid_on)} · {METHOD_LABEL[h.method]}</span>
                    <span className="font-mono text-emerald">{rupee(h.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={repay.isPending}>Cancel</Button>
          <Button variant="primary" loading={repay.isPending} disabled={!valid} onClick={submit}>
            Record {amt > 0 && !tooMuch ? rupee(amt) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettleDialog({ loan, onClose }: { loan: EmployeeLoan; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const settle    = useSettleExpenseAdvance();
  const accounts  = (accountsQ.data ?? []).filter((a) => a.is_active);

  const [spent, setSpent]       = React.useState(String(loan.outstanding));
  const [category, setCategory] = React.useState<string>("Travel");
  const [ret, setRet]           = React.useState("0");
  const [accountId, setAccountId] = React.useState("");
  const [date, setDate]         = React.useState(todayISO());
  const [notes, setNotes]       = React.useState("");

  React.useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const spentAmt = Math.max(0, Math.round(Number(spent) || 0));
  const retAmt   = Math.max(0, Math.round(Number(ret) || 0));
  const total    = spentAmt + retAmt;
  const tooMuch  = total > loan.outstanding;
  const needAccount = retAmt > 0;
  const valid = total > 0 && !tooMuch && (spentAmt === 0 || Boolean(category)) && (!needAccount || Boolean(accountId));

  async function submit() {
    if (!valid) return;
    await settle.mutateAsync({
      loanId: loan.id, spentAmount: spentAmt, category, returnAmount: retAmt,
      returnAccountId: needAccount ? accountId : null, date, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Settle expense advance — {loan.employee_name}</DialogTitle>
          <DialogDescription>
            Outstanding: <b className="text-ink">{rupee(loan.outstanding)}</b>. Book what was spent as a company
            expense and return any unspent cash. (No fresh cash leaves — it already left when you gave the advance.)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Spent on company work (₹)</label>
            <Input type="number" min={0} value={spent} onChange={(e) => setSpent(e.target.value)} />
          </div>
          {spentAmt > 0 && (
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Expense category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectCls}>
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Unspent cash returned (₹)</label>
            <Input type="number" min={0} value={ret} onChange={(e) => setRet(e.target.value)} />
          </div>
          {needAccount && (
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Returned into</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Note (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Mumbai client visit" />
          </div>

          {tooMuch && <p className="text-[11px] text-rose">Spent + returned ({rupee(total)}) can&apos;t exceed the outstanding {rupee(loan.outstanding)}.</p>}
          {!tooMuch && total > 0 && total < loan.outstanding && (
            <p className="text-[11px] text-ink-3">
              {rupee(loan.outstanding - total)} will stay outstanding after this.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={settle.isPending}>Cancel</Button>
          <Button variant="primary" loading={settle.isPending} disabled={!valid} onClick={submit}>
            Settle {total > 0 && !tooMuch ? rupee(total) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
