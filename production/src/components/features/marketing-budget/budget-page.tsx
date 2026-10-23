"use client";
/**
 * Marketing → Budget & Payments (R-1793, Abhishek 23 Oct 2026).
 *
 * One page, three people:
 *   marketing — asks the owner for a budget, then asks billing to pay against it;
 *   owner     — approves (maybe for less) or rejects each budget;
 *   billing   — pays what is asked and presses "Paid" (the expense is written with it).
 * Up to what is left on an approved budget, billing pays without asking the owner again;
 * more needs a new budget. What is left carries into the next months.
 */
import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  BUDGET_CHANNELS, canApproveBudget, canAskBudget, canPay, channelLabel, paymentProblem,
} from "@/lib/marketing-budget/budget";
import {
  BudgetError, useAskBudget, useAskPayment, useBudgets, useCancelBudget, useClosePayment, useDecideBudget, useMarkPaid,
  type Budget, type BudgetPayment,
} from "@/lib/queries/marketing-budget";
import { useColdProducts } from "@/lib/queries/cold-calling";

type Kind = "muted" | "success" | "warning" | "danger" | "info" | "outline";
const BUDGET_STATUS: Record<Budget["status"], { label: string; kind: Kind }> = {
  pending:   { label: "Waiting for owner", kind: "warning" },
  approved:  { label: "Approved", kind: "success" },
  rejected:  { label: "Not approved", kind: "danger" },
  cancelled: { label: "Withdrawn", kind: "muted" },
};
const PAY_STATUS: Record<BudgetPayment["status"], { label: string; kind: Kind }> = {
  pending:   { label: "Waiting for billing", kind: "warning" },
  paid:      { label: "Paid", kind: "success" },
  rejected:  { label: "Sent back", kind: "danger" },
  cancelled: { label: "Cancelled", kind: "muted" },
};

const rs = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const monthLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const todayIso = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIso().slice(0, 7);

function fail(err: unknown, fallback: string) {
  if (err instanceof BudgetError) toast.error(err.message, { description: err.detail ?? "Check the details and try again." });
  else toast.error(fallback, { description: "Check your internet connection and try again." });
}

const selectCls = "w-full h-9 rounded-md border border-hairline bg-paper px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";
const labelCls = "block text-sm font-medium text-ink mb-1.5";

export function BudgetPage() {
  const q = useBudgets();
  const [asking, setAsking] = React.useState(false);
  const [payFor, setPayFor] = React.useState<Budget | null>(null);
  const role = q.data?.role ?? null;
  const budgets = q.data?.budgets ?? [];

  const approved = budgets.filter((b) => b.status === "approved");
  const left = approved.reduce((s, b) => s + b.left, 0);
  const waitingOwner = budgets.filter((b) => b.status === "pending");
  const waitingBilling = budgets.flatMap((b) => b.payments.filter((p) => p.status === "pending").map((p) => ({ p, b })));
  const paidThisMonth = budgets.flatMap((b) => b.payments)
    .filter((p) => p.status === "paid" && (p.paidOn ?? "").startsWith(thisMonth()))
    .reduce((s, p) => s + p.amount, 0);

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing Hub</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Budget &amp; Payments</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            {role === "owner"
              ? "Marketing asks you for a budget. Once you approve, billing pays their requests up to that amount — without asking you again."
              : canPay(role)
                ? "Pay what marketing asks from an approved budget, then press Paid. The expense is recorded for you."
                : "Ask the owner for a budget. Once approved, ask billing to pay from it — up to what is left. Unused money carries over."}
          </p>
        </div>
        {canAskBudget(role) && <Button variant="primary" icon="plus" onClick={() => setAsking(true)}>Ask for budget</Button>}
      </header>

      {q.isLoading ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : q.error ? (
        <Card className="p-6">
          <EmptyState icon="lock" title={q.error instanceof BudgetError ? q.error.message : "Could not load the budgets."}
            body={q.error instanceof BudgetError ? q.error.detail ?? undefined : "Refresh the page."} />
        </Card>
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { k: "Left to spend", v: rs(left), tone: "text-emerald" },
              { k: "Waiting for owner", v: `${waitingOwner.length} · ${rs(waitingOwner.reduce((s, b) => s + b.amountRequested, 0))}`, tone: "text-amber" },
              { k: "Waiting for billing", v: `${waitingBilling.length} · ${rs(waitingBilling.reduce((s, x) => s + x.p.amount, 0))}`, tone: "text-amber" },
              { k: "Paid this month", v: rs(paidThisMonth), tone: "text-ink" },
            ].map((x) => (
              <Card key={x.k} className="p-4">
                <p className="text-xs text-ink-3">{x.k}</p>
                <p className={cn("font-serif text-2xl mt-1", x.tone)}>{x.v}</p>
              </Card>
            ))}
          </section>

          {canApproveBudget(role) && waitingOwner.length > 0 && (
            <section aria-label="Budgets to approve" className="space-y-3">
              <h2 className="font-medium text-ink">Waiting for your approval</h2>
              {waitingOwner.map((b) => <ApproveRow key={b.id} budget={b} />)}
            </section>
          )}

          {canPay(role) && waitingBilling.length > 0 && (
            <section aria-label="Payments to make" className="space-y-3">
              <h2 className="font-medium text-ink">To pay</h2>
              {waitingBilling.map(({ p, b }) => <PayRow key={p.id} payment={p} budget={b} />)}
            </section>
          )}

          <section aria-label="Budgets" className="space-y-3">
            <h2 className="font-medium text-ink">Budgets</h2>
            {budgets.length === 0 ? (
              <Card className="p-6">
                <EmptyState icon="wallet" title="No budgets yet"
                  body={canAskBudget(role) ? "Ask the owner for a budget — for Google Ads, Facebook, LinkedIn or an event." : "Budgets marketing asks for show up here."}
                  action={canAskBudget(role) ? <Button variant="primary" icon="plus" onClick={() => setAsking(true)}>Ask for budget</Button> : undefined} />
              </Card>
            ) : budgets.map((b) => (
              <BudgetCard key={b.id} budget={b} role={role} me={q.data?.me ?? ""} onPay={() => setPayFor(b)} />
            ))}
          </section>
        </>
      )}

      {canAskBudget(role) && <AskBudgetDialog open={asking} onClose={() => setAsking(false)} />}
      <AskPaymentDialog budget={payFor} onClose={() => setPayFor(null)} />
    </div>
  );
}

function BudgetCard({ budget: b, role, me, onPay }: { budget: Budget; role: string | null; me: string; onPay: () => void }) {
  const [open, setOpen] = React.useState(false);
  const cancel = useCancelBudget();
  const s = BUDGET_STATUS[b.status];
  const approved = b.amountApproved ?? 0;
  const used = approved - b.left;
  const pct = approved > 0 ? Math.min(100, Math.round((used / approved) * 100)) : 0;
  const mine = b.requestedBy === me;

  return (
    <Card className="p-4 md:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-ink">{b.channelLabel}{b.productName ? ` · ${b.productName}` : ""}</p>
            <Badge kind={s.kind} size="sm">{s.label}</Badge>
          </div>
          <p className="text-xs text-ink-3 mt-0.5">
            {monthLabel(b.month)} · asked by {b.requestedByName} · {rs(b.amountRequested)} asked
            {b.status === "approved" && approved !== b.amountRequested ? ` · ${rs(approved)} approved` : ""}
          </p>
          {b.note && <p className="text-sm text-ink-2 mt-1">“{b.note}”</p>}
          {b.decisionNote && <p className="text-xs text-ink-3 mt-1">Owner: {b.decisionNote}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {b.status === "approved" && canAskBudget(role) && b.left > 0 && (
            <Button size="sm" variant="primary" icon="send" onClick={onPay}>Ask billing to pay</Button>
          )}
          {b.status === "pending" && (mine || role === "owner") && (
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={async () => {
              try { await cancel.mutateAsync(b.id); toast.success("Request withdrawn", { description: "Ask again any time." }); }
              catch (err) { fail(err, "Could not withdraw it."); }
            }}>Withdraw</Button>
          )}
          {b.payments.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide payments" : `Payments (${b.payments.length})`}
            </Button>
          )}
        </div>
      </div>

      {b.status === "approved" && (
        <div>
          <div className="flex justify-between text-xs text-ink-3 mb-1">
            <span>{rs(used)} used of {rs(approved)} · {rs(b.paid)} paid</span>
            <span className="text-emerald font-medium">{rs(b.left)} left</span>
          </div>
          <div className="h-2 rounded-full bg-paper-2 overflow-hidden" aria-hidden>
            <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
          </div>
          {b.left > 0 && <p className="text-[11px] text-ink-3 mt-1">Unused money stays on this budget for the next months.</p>}
          {b.left === 0 && canAskBudget(role) && <p className="text-[11px] text-ink-3 mt-1">Used up — ask the owner for a new budget to spend more.</p>}
        </div>
      )}

      {open && (
        <ul className="rounded-md border border-hairline divide-y divide-hairline">
          {b.payments.map((p) => {
            const ps = PAY_STATUS[p.status];
            return (
              <li key={p.id} className="px-3 py-2 grid gap-1 sm:grid-cols-[minmax(0,1fr)_120px_160px] sm:items-center sm:gap-3 text-sm">
                <div className="min-w-0">
                  <p className="text-ink truncate"><span className="font-medium">{rs(p.amount)}</span> to {p.payTo}</p>
                  <p className="text-xs text-ink-3 truncate">
                    {p.purpose ?? "—"} · asked {dayLabel(p.createdAt)} by {p.requestedByName}
                    {p.billLink && <> · <a href={p.billLink} target="_blank" rel="noreferrer" className="text-amber hover:underline">bill</a></>}
                  </p>
                  {p.decisionNote && <p className="text-xs text-rose-ink">{p.decisionNote}</p>}
                </div>
                <Badge kind={ps.kind} size="sm">{ps.label}</Badge>
                <p className="text-xs text-ink-3">
                  {p.status === "paid" ? `Paid ${dayLabel(p.paidOn)} by ${p.paidByName ?? "billing"}${p.reference ? ` · ${p.reference}` : ""}` : p.dueOn ? `Due ${dayLabel(p.dueOn)}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Owner: approve as asked, for less, or reject with a reason. */
function ApproveRow({ budget: b }: { budget: Budget }) {
  const decide = useDecideBudget();
  const [amount, setAmount] = React.useState(String(b.amountRequested));
  const [note, setNote] = React.useState("");
  const act = async (decision: "approve" | "reject") => {
    const n = Number(amount);
    if (decision === "approve" && (!Number.isInteger(n) || n <= 0)) {
      toast.error("Enter the amount to approve in whole rupees.", { description: `Asked: ${rs(b.amountRequested)}.` });
      return;
    }
    if (decision === "reject" && !note.trim()) {
      toast.error("Write why it is not approved.", { description: "Marketing reads this — one line is enough." });
      return;
    }
    try {
      await decide.mutateAsync({ id: b.id, decision, amount: decision === "approve" ? n : null, note: note.trim() || null });
      toast.success(decision === "approve" ? `Approved ${rs(n)}` : "Not approved", {
        description: decision === "approve" ? "Billing can now pay marketing's requests up to this amount." : "Marketing has been told why.",
      });
    } catch (err) { fail(err, "Could not save your decision."); }
  };
  return (
    <Card className="p-4 border-amber/50">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium text-ink">{b.requestedByName} asks {rs(b.amountRequested)}</p>
          <p className="text-sm text-ink-3">{channelLabel(b.channel)}{b.productName ? ` · ${b.productName}` : ""} · {monthLabel(b.month)}</p>
          {b.note && <p className="text-sm text-ink-2 mt-1">“{b.note}”</p>}
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label htmlFor={`amt-${b.id}`} className="block text-xs text-ink-3 mb-1">Approve ₹</label>
            <Input id={`amt-${b.id}`} type="number" min={1} className="w-32" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`note-${b.id}`} className="block text-xs text-ink-3 mb-1">Note (needed to reject)</label>
            <Input id={`note-${b.id}`} className="w-52" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </div>
          <Button variant="primary" icon="check" loading={decide.isPending} onClick={() => act("approve")}>Approve</Button>
          <Button variant="ghost" loading={decide.isPending} onClick={() => act("reject")}>Reject</Button>
        </div>
      </div>
    </Card>
  );
}

const PAY_MODES = ["Bank transfer", "UPI", "Card", "Cheque", "Cash"];

/** Billing: mark paid (date, mode, UTR) or send it back with a reason. */
function PayRow({ payment: p, budget: b }: { payment: BudgetPayment; budget: Budget }) {
  const paid = useMarkPaid();
  const close = useClosePayment();
  const [on, setOn] = React.useState(todayIso());
  const [mode, setMode] = React.useState("Bank transfer");
  const [ref, setRef] = React.useState("");
  const [backNote, setBackNote] = React.useState("");
  const [sendingBack, setSendingBack] = React.useState(false);

  const markPaid = async () => {
    if (!on) { toast.error("Enter the date it was paid.", { description: "The day the money left the bank." }); return; }
    try {
      await paid.mutateAsync({ id: p.id, paidOn: on, mode, reference: ref.trim() || null });
      toast.success(`Paid ${rs(p.amount)} to ${p.payTo}`, { description: "Recorded as a marketing expense. Marketing has been told." });
    } catch (err) { fail(err, "Could not mark it paid."); }
  };
  const sendBack = async () => {
    if (!backNote.trim()) { toast.error("Write what is wrong.", { description: "e.g. bill missing, wrong account." }); return; }
    try {
      await close.mutateAsync({ id: p.id, status: "rejected", note: backNote.trim() });
      toast.success("Sent back to marketing", { description: "The amount is free on the budget again." });
    } catch (err) { fail(err, "Could not send it back."); }
  };

  return (
    <Card className="p-4 border-amber/50 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium text-ink">Pay {rs(p.amount)} to {p.payTo}</p>
          <p className="text-sm text-ink-3">
            {channelLabel(b.channel)}{b.productName ? ` · ${b.productName}` : ""} · asked by {p.requestedByName}
            {p.dueOn ? ` · due ${dayLabel(p.dueOn)}` : ""}
          </p>
          {p.purpose && <p className="text-sm text-ink-2 mt-1">“{p.purpose}”</p>}
          {p.billLink && <a href={p.billLink} target="_blank" rel="noreferrer" className="text-sm text-amber hover:underline">Open bill / link</a>}
          <p className="text-xs text-ink-3 mt-1">Approved budget: {rs(b.amountApproved ?? 0)} · {rs(b.paid)} paid so far</p>
        </div>
      </div>
      {sendingBack ? (
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor={`back-${p.id}`} className="block text-xs text-ink-3 mb-1">What is wrong?</label>
            <Input id={`back-${p.id}`} value={backNote} onChange={(e) => setBackNote(e.target.value)} placeholder="e.g. bill missing" />
          </div>
          <Button variant="danger" loading={close.isPending} onClick={sendBack}>Send back</Button>
          <Button variant="ghost" onClick={() => setSendingBack(false)}>Keep</Button>
        </div>
      ) : (
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label htmlFor={`on-${p.id}`} className="block text-xs text-ink-3 mb-1">Paid on</label>
            <Input id={`on-${p.id}`} type="date" className="w-40" value={on} onChange={(e) => setOn(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`mode-${p.id}`} className="block text-xs text-ink-3 mb-1">Mode</label>
            <select id={`mode-${p.id}`} className={cn(selectCls, "w-40")} value={mode} onChange={(e) => setMode(e.target.value)}>
              {PAY_MODES.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`ref-${p.id}`} className="block text-xs text-ink-3 mb-1">UTR / reference</label>
            <Input id={`ref-${p.id}`} className="w-44" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Optional" />
          </div>
          <Button variant="primary" icon="check" loading={paid.isPending} onClick={markPaid}>Paid</Button>
          <Button variant="ghost" onClick={() => setSendingBack(true)}>Send back</Button>
        </div>
      )}
    </Card>
  );
}

function AskBudgetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ask = useAskBudget();
  const products = useColdProducts();
  const [channel, setChannel] = React.useState<string>("google-ads");
  const [productId, setProductId] = React.useState("");
  const [month, setMonth] = React.useState(thisMonth());
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  React.useEffect(() => { if (open) { setChannel("google-ads"); setProductId(""); setMonth(thisMonth()); setAmount(""); setNote(""); } }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) { toast.error("Enter the amount in whole rupees.", { description: "For example 50000." }); return; }
    if (!month) { toast.error("Pick the month.", { description: "The month this budget is for." }); return; }
    const product = (products.data ?? []).find((p) => p.id === productId) ?? null;
    try {
      await ask.mutateAsync({ channel, productItemId: product?.id ?? null, productName: product?.name ?? null, month, amount: n, note: note.trim() || null });
      toast.success("Sent to the owner", { description: "You will get a notification when it is approved." });
      onClose();
    } catch (err) { fail(err, "Could not send the request."); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask for a budget</DialogTitle>
          <DialogDescription>The owner approves it. Then billing pays your requests up to this amount.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="b-channel" className={labelCls}>For</label>
              <select id="b-channel" className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {BUDGET_CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="b-product" className={labelCls}>Product</label>
              <select id="b-product" className={selectCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Any / brand</option>
                {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="b-month" className={labelCls}>Month</label>
              <Input id="b-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div>
              <label htmlFor="b-amount" className={labelCls}>Amount ₹</label>
              <Input id="b-amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" autoFocus />
            </div>
          </div>
          <div>
            <label htmlFor="b-note" className={labelCls}>Why / plan</label>
            <Input id="b-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Search ads for Google Workspace, Delhi NCR" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={ask.isPending}>Send to owner</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AskPaymentDialog({ budget: b, onClose }: { budget: Budget | null; onClose: () => void }) {
  const ask = useAskPayment();
  const [amount, setAmount] = React.useState("");
  const [payTo, setPayTo] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [billLink, setBillLink] = React.useState("");
  const [dueOn, setDueOn] = React.useState("");
  React.useEffect(() => {
    if (b) { setAmount(""); setPayTo(b.channel === "other" || b.channel === "trade-show" ? "" : b.channelLabel); setPurpose(""); setBillLink(""); setDueOn(""); }
  }, [b]);
  if (!b) return null;
  const n = Number(amount);
  const problem = amount ? paymentProblem(n, b.left, b.status) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const why = paymentProblem(n, b.left, b.status);
    if (why) { toast.error(why, { description: `Budget: ${b.channelLabel}, ${monthLabel(b.month)}.` }); return; }
    if (!payTo.trim()) { toast.error("Who is to be paid?", { description: "e.g. Google Ads, the event organiser." }); return; }
    try {
      await ask.mutateAsync({ budgetId: b.id, amount: n, payTo: payTo.trim(), purpose: purpose.trim() || null, billLink: billLink.trim() || null, dueOn: dueOn || null });
      toast.success(`Sent to billing: ${rs(n)}`, { description: "Billing pays it — no need to ask the owner. You will be told when it is paid." });
      onClose();
    } catch (err) { fail(err, "Could not send the request."); }
  };

  return (
    <Dialog open={!!b} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask billing to pay</DialogTitle>
          <DialogDescription>
            {b.channelLabel}{b.productName ? ` · ${b.productName}` : ""} · {monthLabel(b.month)} — <strong>{rs(b.left)} left</strong>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="p-amount" className={labelCls}>Amount ₹</label>
              <Input id="p-amount" type="number" min={1} max={b.left} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
              {problem && <p className="text-xs text-rose-ink mt-1">{problem}</p>}
            </div>
            <div>
              <label htmlFor="p-to" className={labelCls}>Pay to</label>
              <Input id="p-to" value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="Google Ads" />
            </div>
            <div>
              <label htmlFor="p-due" className={labelCls}>Needed by</label>
              <Input id="p-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </div>
            <div>
              <label htmlFor="p-link" className={labelCls}>Bill / payment link</label>
              <Input id="p-link" value={billLink} onChange={(e) => setBillLink(e.target.value)} placeholder="https://…" />
            </div>
          </div>
          <div>
            <label htmlFor="p-purpose" className={labelCls}>What for</label>
            <Input id="p-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Ads top-up for week 1–2" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={ask.isPending} disabled={!!problem}>Send to billing</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
