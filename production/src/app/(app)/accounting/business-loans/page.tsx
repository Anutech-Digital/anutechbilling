/**
 * Business Loans — money the company has BORROWED (e.g. a ₹10L HDFC term loan).
 *
 * Recording a loan drops the cash into a bank account and books the same amount
 * as a liability. Each EMI leaves the bank: its principal shrinks the loan, its
 * interest is booked as an expense. The outstanding shows on the Balance Sheet.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  useBusinessLoans, useRecordBusinessLoan, useRecordLoanEmi, useDeleteBusinessLoan, useLoanPayments,
  type BusinessLoan,
} from "@/lib/queries/business-loans";

function todayISO(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

export default function BusinessLoansPage() {
  const q = useBusinessLoans();
  const [addOpen, setAddOpen] = React.useState(false);
  const [emiFor, setEmiFor] = React.useState<BusinessLoan | null>(null);
  const [historyFor, setHistoryFor] = React.useState<BusinessLoan | null>(null);
  const del = useDeleteBusinessLoan();
  const confirm = useConfirm();

  const loans = q.data ?? [];
  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);
  const activeCount = loans.filter((l) => l.status === "active").length;
  const totalInterest = loans.reduce((s, l) => s + l.interestPaid, 0);

  const confirmDelete = async (l: BusinessLoan) => {
    if (await confirm({
      title: `Delete the ${l.lender} loan (${rupee(l.principal)})?`,
      body: "The cash added to the account will be reversed. (Only works before any EMI is recorded.)",
      confirmLabel: "Delete",
      danger: true,
    })) {
      del.mutate(l.id);
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Business Loans</h1>
          <p className="text-sm text-ink-3 mt-1">
            Company ne jo loan liya (bank / NBFC se). Loan record karte hi paisa aapke bank me aa jaata hai aur utna &quot;dena baaki&quot; ban jaata hai.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setAddOpen(true)}>Add loan</Button>
      </div>

      {/* How it works — only when there's nothing yet, so once loans exist the
          money (KPIs) reads first instead of an education banner. English-only. */}
      {loans.length === 0 && (
        <Card className="mb-5 p-3 md:p-4 border-amber/40 bg-amber-soft/25">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            <b className="text-ink">Note:</b> a loan isn&apos;t an expense — it&apos;s cash in the bank plus an equal liability. Each month&apos;s EMI: only the <b>interest</b> is an expense; the <b>principal</b> reduces the loan. The app handles this split for you.
          </p>
        </Card>
      )}

      {loans.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mb-5">
          <KPI label="Dena baaki (outstanding)" value={rupee(totalOutstanding)} tone="rose" />
          <KPI label="Active loans" value={String(activeCount)} />
          <KPI label="Byaaj diya (total)" value={rupee(totalInterest)} />
        </div>
      )}

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : loans.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No business loans yet"
            body="Jab company bank/NBFC se loan le, yahan add karo — paisa bank me aayega aur outstanding Balance Sheet par dikhega."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add a loan</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Lender</th>
                  <th className="text-left  px-4 py-3">Taken on</th>
                  <th className="text-right px-4 py-3">Loan amount</th>
                  <th className="text-right px-4 py-3">Repaid</th>
                  <th className="text-right px-4 py-3">Outstanding</th>
                  <th className="text-left  px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {loans.map((l) => (
                  <tr key={l.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{l.lender}</div>
                      {l.purpose && <div className="text-[11px] text-ink-3">{l.purpose}</div>}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(l.disbursed_on)}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(l.principal)}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald">{l.principalPaid > 0 ? rupee(l.principalPaid) : "—"}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(l.outstanding)}</td>
                    <td className="px-4 py-3">
                      <Badge kind={l.status === "closed" ? "success" : "warning"} dot>
                        {l.status === "closed" ? "Cleared" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <LoanActions
                          onEmi={l.status === "active" ? () => setEmiFor(l) : undefined}
                          onHistory={() => setHistoryFor(l)}
                          onDelete={l.emisPaid === 0 ? () => confirmDelete(l) : undefined}
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
            {loans.map((l) => (
              <li key={l.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-ink leading-tight">
                      {l.lender}
                      {l.purpose && <div className="text-[11px] text-ink-3 font-normal">{l.purpose}</div>}
                    </div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(l.outstanding)}</div>
                  </div>
                  <div className="text-[11px] text-ink-3 mb-2">
                    {formatDate(l.disbursed_on)} · {rupee(l.principal)} liya · {rupee(l.principalPaid)} chukaya · {l.emisPaid} EMI
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge kind={l.status === "closed" ? "success" : "warning"} dot>
                      {l.status === "closed" ? "Cleared" : "Active"}
                    </Badge>
                    <LoanActions
                      onEmi={l.status === "active" ? () => setEmiFor(l) : undefined}
                      onHistory={() => setHistoryFor(l)}
                      onDelete={l.emisPaid === 0 ? () => confirmDelete(l) : undefined}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <FAB icon="plus" label="Loan" onClick={() => setAddOpen(true)} ariaLabel="Add loan" />
      {addOpen && <AddLoanDialog onClose={() => setAddOpen(false)} />}
      {emiFor && <PayEmiDialog loan={emiFor} onClose={() => setEmiFor(null)} />}
      {historyFor && <HistoryDialog loan={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function KPI({ label, value, tone }: { label: string; value: string; tone?: "rose" | "emerald" }) {
  const color = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${color} leading-tight`}>{value}</div>
    </Card>
  );
}

function LoanActions({ onEmi, onHistory, onDelete }: {
  onEmi?: () => void; onHistory: () => void; onDelete?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {onEmi && <Button size="sm" variant="primary" onClick={onEmi}>Pay EMI</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Actions"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
          >
            <Icon name="more_h" size={20} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onHistory}>
            <Icon name="clock" size={16} /> EMI history
          </DropdownMenuItem>
          {onDelete && <DropdownMenuSeparator />}
          {onDelete && (
            <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}>
              <Icon name="trash" size={16} /> Delete loan
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AddLoanDialog({ onClose }: { onClose: () => void }) {
  const add = useRecordBusinessLoan();
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active);

  const [lender, setLender] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [principal, setPrincipal] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [tenure, setTenure] = React.useState("");
  const [emi, setEmi] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.round(Number(principal));
  const valid = lender.trim() && amt > 0 && Boolean(accountId);

  async function submit() {
    if (!valid) return;
    await add.mutateAsync({
      lender: lender.trim(), purpose: purpose.trim() || null, principal: amt,
      interestRate: rate ? Number(rate) : null,
      tenureMonths: tenure ? Math.round(Number(tenure)) : null,
      emiAmount: emi ? Math.round(Number(emi)) : null,
      disbursedOn: date, depositAccountId: accountId,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add business loan</DialogTitle>
          <DialogDescription>Company ne jo loan liya. Paisa neeche chune account me aa jayega.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Lender (bank / NBFC)</label>
              <Input value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. HDFC Bank" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Loan amount (₹)</label>
              <Input type="number" min={1} value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. 1000000" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Purpose (optional)</label>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Working capital" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Received into</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Taken on</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Interest %/yr</label>
              <Input type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="10.5" />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Tenure (mo)</label>
              <Input type="number" min={1} value={tenure} onChange={(e) => setTenure(e.target.value)} placeholder="24" />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">EMI (₹)</label>
              <Input type="number" min={0} value={emi} onChange={(e) => setEmi(e.target.value)} placeholder="e.g. 46000" />
            </div>
          </div>
          <p className="text-[11px] text-ink-3">Interest %, tenure aur EMI optional hai — sirf reference ke liye. Zaroori hai: lender, amount, account.</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={add.isPending} disabled={!valid} onClick={submit}>
            Add {amt > 0 ? rupee(amt) : "loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayEmiDialog({ loan, onClose }: { loan: BusinessLoan; onClose: () => void }) {
  const pay = useRecordLoanEmi();
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active);

  // Sensible default: EMI = the loan's recorded EMI; interest ≈ outstanding × rate/12.
  const estInterest = loan.interest_rate ? Math.round((loan.outstanding * loan.interest_rate) / 1200) : 0;
  const [amount, setAmount] = React.useState(loan.emi_amount ? String(loan.emi_amount) : "");
  const [interest, setInterest] = React.useState(estInterest ? String(estInterest) : "");
  const [date, setDate] = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.round(Number(amount) || 0);
  const intAmt = Math.max(0, Math.round(Number(interest) || 0));
  const principal = amt - intAmt;
  const tooMuchInt = intAmt > amt;
  const tooMuchPrin = principal > loan.outstanding;
  const valid = amt > 0 && !tooMuchInt && !tooMuchPrin && Boolean(accountId);

  async function submit() {
    if (!valid) return;
    await pay.mutateAsync({
      loanId: loan.id, amount: amt, interest: intAmt, paidOn: date, bankAccountId: accountId, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Pay EMI — {loan.lender}</DialogTitle>
          <DialogDescription>
            Outstanding: <b className="text-ink">{rupee(loan.outstanding)}</b> of {rupee(loan.principal)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">EMI amount (₹)</label>
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Interest part (₹)</label>
              <Input type="number" min={0} value={interest} onChange={(e) => setInterest(e.target.value)} />
            </div>
          </div>

          {/* Live split so a layman sees exactly what happens */}
          <div className="rounded-md border border-hairline bg-paper-2/40 p-2.5 text-[12px]">
            {tooMuchInt ? (
              <p className="text-rose">Interest EMI se zyada nahi ho sakta.</p>
            ) : tooMuchPrin ? (
              <p className="text-rose">Principal ({rupee(principal)}) outstanding {rupee(loan.outstanding)} se zyada hai.</p>
            ) : (
              <div className="flex items-center justify-between gap-2 text-ink-2">
                <span>Loan ghatega (principal): <b className="text-ink">{rupee(Math.max(0, principal))}</b></span>
                <span>Kharcha (interest): <b className="text-ink">{rupee(intAmt)}</b></span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Paid from</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
              {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Note (optional)</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Month 3" />
            </div>
          </div>
          {loan.interest_rate ? (
            <p className="text-[11px] text-ink-3">Interest apne-aap estimate kiya ({loan.interest_rate}%/yr par). Bank statement se sahi figure daal do.</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={pay.isPending} disabled={!valid} onClick={submit}>
            Record {amt > 0 && !tooMuchInt && !tooMuchPrin ? rupee(amt) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ loan, onClose }: { loan: BusinessLoan; onClose: () => void }) {
  const histQ = useLoanPayments(loan.id);
  const accountsQ = useBankAccounts();
  const acctName = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));
  const rows = histQ.data ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>EMI history — {loan.lender}</DialogTitle>
          <DialogDescription>
            {rupee(loan.principal)} liya · {rupee(loan.principalPaid)} principal chukaya · {rupee(loan.interestPaid)} byaaj · {rupee(loan.outstanding)} baaki
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {histQ.isLoading ? (
            <p className="text-xs text-ink-3">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-hairline p-6 text-center text-xs text-ink-3">
              Abhi tak koi EMI record nahi hui.
            </div>
          ) : (
            rows.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-3 rounded-md border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{rupee(h.amount)}</div>
                  <div className="text-[11px] text-ink-3">
                    {formatDate(h.paid_on)}
                    {h.bank_account_id ? ` · ${acctName.get(h.bank_account_id) ?? "account"}` : ""}
                    {h.notes ? ` · ${h.notes}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px]">
                  <div className="text-emerald">−{rupee(h.principal_part)} loan</div>
                  <div className="text-ink-3">{rupee(h.interest_part)} byaaj</div>
                </div>
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
