"use client";

/**
 * Payment runs (R-163, 5 Oct 2026) — pay vendors in one go, the Pazy way, inside ResellerOS.
 *
 *   1. "To pay": every rupee bill and unpaid expense, most pressing first (MSME 45-day law,
 *      overdue, due soon). Tick the ones to pay.
 *   2. Create run → it waits for the owner / a manager to approve (the database enforces who).
 *   3. Approved → "Download bank file" (one transfer per bill) → upload it in your net-banking.
 *   4. When the bank has paid → "Bank paid it" → every bill is marked paid and a bank entry is
 *      written, in one step, or nothing is (a bill paid by hand meanwhile blocks it, by name).
 *
 * ResellerOS never moves money.
 */
import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/label";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { downloadCSV } from "@/lib/csv";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  usePayables, usePaymentRuns, useVendorBanks,
  useCreatePaymentRun, useApprovePaymentRun, useMarkRunPaid, useCancelPaymentRun, type PaymentRun,
} from "@/lib/queries/payment-runs";
import { sortPayables, urgencyOf, bankFileRows, BANK_FILE_HEADERS, type Urgency } from "@/lib/payables/payment-run";

const URGENCY_KIND: Record<Urgency, "danger" | "warning" | "info" | "muted"> = {
  msme_late: "danger", overdue: "danger", msme_soon: "warning", due_soon: "warning", later: "muted",
};
const STATUS_KIND: Record<PaymentRun["status"], "warning" | "info" | "success" | "muted"> = {
  draft: "warning", approved: "info", paid: "success", cancelled: "muted",
};
const STATUS_LABEL: Record<PaymentRun["status"], string> = {
  draft: "Waiting for approval", approved: "Approved — pay in bank", paid: "Paid", cancelled: "Cancelled",
};
const keyOf = (p: { source: string; docId?: string; doc_id?: string }) => `${p.source}:${p.docId ?? p.doc_id}`;

export default function PaymentRunsPage() {
  const today = istToday();
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;
  const canCreate = !!role && ["owner", "manager", "billing", "accountant"].includes(role);
  const canApprove = role === "owner" || role === "manager";

  const payablesQ = usePayables();
  const runsQ = usePaymentRuns();
  const vendorsQ = useVendorBanks();
  const banksQ = useBankAccounts();
  const create = useCreatePaymentRun();

  const runs = React.useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const openRuns = React.useMemo(() => runs.filter((r) => r.status === "draft" || r.status === "approved"), [runs]);
  const history = runs.filter((r) => r.status === "paid" || r.status === "cancelled");
  /** doc → the open run it is already in (it cannot go in a second one). */
  const inRun = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of openRuns) for (const it of r.items) m.set(keyOf(it), r.run_no);
    return m;
  }, [openRuns]);

  const payables = React.useMemo(() => sortPayables(payablesQ.data ?? [], today), [payablesQ.data, today]);
  const free = React.useMemo(() => payables.filter((p) => !inRun.has(keyOf(p))), [payables, inRun]);
  const banks = (banksQ.data ?? []).filter((b) => b.is_active !== false);

  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [bankId, setBankId] = React.useState("");
  const [payOn, setPayOn] = React.useState(today);
  React.useEffect(() => { if (!bankId && banks[0]) setBankId(banks.find((b) => b.account_type !== "cash")?.id ?? banks[0].id); }, [banks, bankId]);
  // Drop picks that left the list (paid elsewhere, or put in a run).
  React.useEffect(() => {
    setPicked((s) => { const ok = new Set(free.map(keyOf)); const n = new Set([...s].filter((k) => ok.has(k))); return n.size === s.size ? s : n; });
  }, [free]);

  const pickedRows = free.filter((p) => picked.has(keyOf(p)));
  const pickedTotal = pickedRows.reduce((a, p) => a + p.outstanding, 0);
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const urgentKeys = free.filter((p) => ["msme_late", "overdue", "msme_soon", "due_soon"].includes(urgencyOf(p, today).level)).map(keyOf);

  async function createRun() {
    if (!pickedRows.length || !bankId) return;
    await create.mutateAsync({
      items: pickedRows.map((p) => ({ source: p.source, doc_id: p.docId, amount: p.outstanding })),
      bankAccountId: bankId, payOn,
    });
    setPicked(new Set());
  }

  const owedTotal = free.reduce((a, p) => a + p.outstanding, 0);
  const msmeLate = free.filter((p) => urgencyOf(p, today).level === "msme_late");

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto pb-32">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Payment runs</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-2xl">
          Pick the bills to pay → owner approves → download one bank file → upload it in net-banking → mark paid.
          ResellerOS never sends money; your bank does.
        </p>
      </div>

      {msmeLate.length > 0 && (
        <Card className="mb-5 p-3 border-rose/40 bg-rose-soft/40 text-sm flex items-start gap-2">
          <Icon name="alert" size={16} className="text-rose mt-0.5 shrink-0" />
          <div>
            <b>{msmeLate.length} MSME bill{msmeLate.length > 1 ? "s" : ""} past 45 days</b> ({rupee(msmeLate.reduce((a, p) => a + p.outstanding, 0))}).
            The MSMED Act charges compound interest on these, and the delay is not tax-deductible (s.43B(h)). Pay them first.
          </div>
        </Card>
      )}

      {/* ── Runs that need someone ─────────────────────────────── */}
      {openRuns.length > 0 && (
        <section className="mb-8 space-y-3" aria-label="Open payment runs">
          <h2 className="text-sm font-semibold text-ink">In progress</h2>
          {openRuns.map((r) => (
            <RunCard key={r.id} run={r} vendors={vendorsQ.data ?? []} bankName={banks.find((b) => b.id === r.bank_account_id)?.name}
              canApprove={canApprove && !(role === "manager" && r.created_by === me?.userId)} canMark={canCreate} canCancel={canApprove || (r.status === "draft" && r.created_by === me?.userId)}
              meId={me?.userId ?? null} />
          ))}
        </section>
      )}

      {/* ── To pay ─────────────────────────────────────────────── */}
      <section aria-label="Bills to pay">
        <div className="flex items-end justify-between gap-3 flex-wrap mb-2">
          <h2 className="text-sm font-semibold text-ink">To pay {!payablesQ.isError && !runsQ.isError && <span className="text-ink-3 font-normal">· {free.length} bills · {rupee(owedTotal)}</span>}</h2>
          {canCreate && urgentKeys.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(urgentKeys))}>Pick all urgent ({urgentKeys.length})</Button>
          )}
        </div>
        <Card className="overflow-hidden">
          {payablesQ.isLoading || runsQ.isLoading ? (
            <div className="p-4 space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : payablesQ.isError || runsQ.isError ? (
            // Without the open runs we cannot tell which bills are already in one —
            // listing them as "to pay" would invite paying the same bill twice.
            <LoadError what="Bills to pay" onRetry={() => { void payablesQ.refetch(); void runsQ.refetch(); }} />
          ) : free.length === 0 ? (
            <EmptyState compact icon="check" title="Nothing to pay" body="Every rupee bill and expense is paid or already in a run." />
          ) : (
            <ul className="divide-y divide-hairline">
              {free.map((p) => {
                const k = keyOf(p);
                const u = urgencyOf(p, today);
                return (
                  <li key={k}>
                    <label className={`flex items-center gap-3 px-3 py-2.5 ${canCreate ? "cursor-pointer hover:bg-paper-2" : ""}`}>
                      <input type="checkbox" className="h-4 w-4 accent-[var(--color-primary,#c2410c)]" checked={picked.has(k)} onChange={() => toggle(k)} disabled={!canCreate}
                        aria-label={`Pay ${p.vendorName} ${p.docRef ?? p.docId}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink truncate">{p.vendorName}</div>
                        <div className="text-xs text-ink-3 truncate">
                          {p.source === "vendor_bill" ? "Bill" : "Expense"} {p.docRef ?? p.docId}{p.billDate ? ` · ${formatDate(p.billDate)}` : ""}
                          {u.level !== "later" && <span className={`sm:hidden ml-1 font-semibold ${u.level === "msme_late" || u.level === "overdue" ? "text-rose" : "text-amber-ink"}`}>· {u.label}</span>}
                        </div>
                      </div>
                      <Badge size="sm" kind={URGENCY_KIND[u.level]} className="hidden sm:inline-flex shrink-0">{u.label}</Badge>
                      <div className="text-sm font-semibold tabular-nums w-24 text-right">{rupee(p.outstanding)}</div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {payables.length > free.length && (
          <p className="text-xs text-ink-3 mt-2">{payables.length - free.length} more are already in an open run above.</p>
        )}
      </section>

      {/* ── History ────────────────────────────────────────────── */}
      {history.length > 0 && (
        <details className="mt-8">
          <summary className="text-sm font-semibold text-ink cursor-pointer">Past runs ({history.length})</summary>
          <div className="mt-3 space-y-3">
            {history.map((r) => <RunCard key={r.id} run={r} vendors={vendorsQ.data ?? []} bankName={banks.find((b) => b.id === r.bank_account_id)?.name} canApprove={false} canMark={false} canCancel={false} meId={me?.userId ?? null} />)}
          </div>
        </details>
      )}

      {/* ── Sticky create bar ──────────────────────────────────── R-298: phones sit on the
          shared --bottom-nav-h (it already carries the home-indicator inset); from md the bar
          touches the screen edge, so only there is the inset padded. */}
      {canCreate && pickedRows.length > 0 && (
        <div className="fixed left-0 right-0 bottom-[var(--bottom-nav-h,56px)] md:bottom-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur px-4 py-3 md:pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <div className="max-w-[1400px] mx-auto flex flex-wrap items-center gap-3">
            <div className="text-sm"><b>{pickedRows.length}</b> selected · <b className="tabular-nums">{rupee(pickedTotal)}</b></div>
            <label className="text-xs text-ink-3 flex items-center gap-1.5">Pay from
              <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="text-sm rounded-md border border-hairline bg-paper px-2 py-1">
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.account_number_last4 ? ` ••${b.account_number_last4}` : ""}</option>)}
              </select>
            </label>
            <label className="text-xs text-ink-3 flex items-center gap-1.5">Pay on
              <input type="date" value={payOn} min={today} onChange={(e) => setPayOn(e.target.value)} className="text-sm rounded-md border border-hairline bg-paper px-2 py-1" />
            </label>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
              <Button size="sm" variant="primary" loading={create.isPending} disabled={!bankId} onClick={() => void createRun()}>Create payment run</Button>
            </div>
            {!banks.length && <p className="w-full text-xs text-rose">Add a bank account first (Banking).</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({ run, vendors, bankName, canApprove, canMark, canCancel, meId }: {
  run: PaymentRun; vendors: Parameters<typeof bankFileRows>[2]; bankName?: string;
  canApprove: boolean; canMark: boolean; canCancel: boolean; meId: string | null;
}) {
  const approve = useApprovePaymentRun();
  const cancel = useCancelPaymentRun();
  const confirm = useConfirm();
  const [markOpen, setMarkOpen] = React.useState(false);
  const file = React.useMemo(() => bankFileRows(run.run_no, run.items, vendors), [run, vendors]);
  const vendorCount = new Set(run.items.map((i) => i.vendor_id ?? i.vendor_name)).size;

  async function doApprove() {
    const selfNote = run.created_by === meId ? "\nYou created this run too — approving it yourself is recorded." : "";
    if (!(await confirm({ title: `Approve ${run.run_no}?`, body: `${rupee(run.total)} to ${vendorCount} vendor${vendorCount > 1 ? "s" : ""} from ${bankName ?? "the chosen account"}.${selfNote}`, confirmLabel: "Approve" }))) return;
    approve.mutate(run.id);
  }
  async function doCancel() {
    if (!(await confirm({ title: `Cancel ${run.run_no}?`, body: "The bills go back to the To pay list. Nothing is paid or changed.", confirmLabel: "Cancel run", danger: true }))) return;
    cancel.mutate(run.id);
  }
  function download() {
    if (file.missing.length) return;
    downloadCSV(`${run.run_no}-bank-upload.csv`, [...BANK_FILE_HEADERS], file.rows);
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink">{run.run_no}</span>
            <Badge size="sm" kind={STATUS_KIND[run.status]}>{STATUS_LABEL[run.status]}</Badge>
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            {run.items.length} bill{run.items.length > 1 ? "s" : ""} · {vendorCount} vendor{vendorCount > 1 ? "s" : ""} · from {bankName ?? "—"} · pay on {formatDate(run.pay_on)}
            {run.paid_on ? ` · paid ${formatDate(run.paid_on)}` : ""}
          </div>
        </div>
        <div className="text-lg font-semibold tabular-nums">{rupee(run.total)}</div>
      </div>

      <details className="mt-2">
        <summary className="text-xs text-ink-3 cursor-pointer">Show bills</summary>
        <ul className="mt-2 text-xs space-y-1">
          {run.items.map((i) => (
            <li key={`${i.source}:${i.doc_id}`} className="flex justify-between gap-3">
              <span className="truncate">{i.vendor_name} · {i.doc_ref ?? i.doc_id}</span>
              <span className="tabular-nums">{rupee(i.amount)}</span>
            </li>
          ))}
        </ul>
      </details>

      {run.status === "approved" && file.missing.length > 0 && (
        <div className="mt-3 text-xs rounded-md bg-amber-soft text-amber-ink px-2.5 py-2">
          Bank details missing for <b>{file.missing.join(", ")}</b>. Add account + IFSC (or UPI) in{" "}
          <Link href="/accounting/vendors" className="underline font-semibold">Vendors</Link>, then download the file.
        </div>
      )}

      {(run.status === "draft" || run.status === "approved") && (
        <div className="mt-3 flex flex-wrap gap-2">
          {run.status === "draft" && canApprove && <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => void doApprove()}>Approve</Button>}
          {run.status === "draft" && !canApprove && <span className="text-xs text-ink-3 self-center">Waiting for the owner or a manager to approve.</span>}
          {run.status === "approved" && (
            <Button size="sm" variant="primary" icon="download" disabled={file.missing.length > 0} onClick={download}>Download bank file</Button>
          )}
          {run.status === "approved" && canMark && <Button size="sm" variant="outline" onClick={() => setMarkOpen(true)}>Bank paid it</Button>}
          {canCancel && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => void doCancel()}>Cancel run</Button>}
        </div>
      )}

      {markOpen && <MarkPaidDialog run={run} onClose={() => setMarkOpen(false)} />}
    </Card>
  );
}

function MarkPaidDialog({ run, onClose }: { run: PaymentRun; onClose: () => void }) {
  const mark = useMarkRunPaid();
  const [paidOn, setPaidOn] = React.useState(run.pay_on <= istToday() ? run.pay_on : istToday());
  const [checked, setChecked] = React.useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Did the bank pay {run.run_no}?</DialogTitle>
          <DialogDescription>
            All {run.items.length} bills ({rupee(run.total)}) will be marked paid and a bank entry added for each. Do this only after your bank shows the transfers as done.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Paid on" htmlFor="run-paid-on">
            <input id="run-paid-on" type="date" value={paidOn} max={istToday()} onChange={(e) => setPaidOn(e.target.value)} className="w-full text-sm rounded-md border border-hairline bg-paper px-3 py-2" />
          </FormField>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>I checked the bank — every transfer in this file went through.</span>
          </label>
          <p className="text-xs text-ink-3">If a transfer failed, do not mark this run: cancel it, mark the bills that did go through from Bills / Expenses, and make a new run for the rest.</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Not yet</Button>
            <Button variant="primary" disabled={!checked || !paidOn} loading={mark.isPending}
              onClick={() => mark.mutate({ id: run.id, paidOn }, { onSuccess: onClose })}>Mark all paid</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
