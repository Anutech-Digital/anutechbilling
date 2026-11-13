/**
 * R-2654 — Banking → "Razorpay settlements (N)": a whole month of Razorpay settlement lines at once.
 *
 * R-2099 reconciles one settlement line at a time (Reconcile → Razorpay settlement → Fetch → Reconcile,
 * 3-4 minutes a line). Here the month is read from Razorpay once; each open Razorpay line of this account
 * is paired with its settlement (UTR, else the one settlement of that amount — never a guess between
 * two) and checked by R-2099's own rules. The table says Ready, or Blocked and why. "Reconcile all
 * ready" books every ready line in one run (sent in chunks of RUN_CHUNK, the server plans each chunk
 * again — the browser sends no amounts); "Undo this run" takes the whole run back. The run id is kept
 * in this browser tab (per account) so Undo survives closing the sheet. Owner / accountant only.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import { describeError, toastError } from "@/lib/errors/toast-error";
import {
  invalidateBank, useRazorpayMonthBatch, useRunRazorpayMonth, useUndoRazorpayMonth,
  type BatchRow, type MonthRunResult, type MonthUndoResult,
} from "@/lib/queries/razorpay-settlement";
import { isRazorpaySettlementLine } from "@/lib/razorpay/settlement-match";

/** Lines per request — the server's RUN_CHUNK (settlement-batch.server.ts). */
export const RUN_CHUNK = 15;

type TxnLite = { matched_to_type: string | null; credit: number | null; description: string | null; txn_date: string };

/** Open Razorpay money-in lines per month (YYYY-MM → count), oldest first. */
export function razorpayMonths(txns: ReadonlyArray<TxnLite>): Array<{ month: string; count: number }> {
  const by = new Map<string, number>();
  for (const t of txns) {
    if (t.matched_to_type !== null || !isRazorpaySettlementLine(t)) continue;
    const m = t.txn_date.slice(0, 7);
    by.set(m, (by.get(m) ?? 0) + 1);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count }));
}

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

/* The last run of this account, kept in this browser tab so "Undo this run" survives closing the sheet. */
const runKey = (accountId: string) => `ros_rzp_month_run_v1:${accountId}`;
interface SavedRun { runId: string; month: string; booked: number; amount: number }
export function loadRun(accountId: string): SavedRun | null {
  try {
    const raw = window.sessionStorage.getItem(runKey(accountId));
    return raw ? (JSON.parse(raw) as SavedRun) : null;
  } catch { return null; }
}
function saveRun(accountId: string, run: SavedRun | null): void {
  try {
    if (run) window.sessionStorage.setItem(runKey(accountId), JSON.stringify(run));
    else window.sessionStorage.removeItem(runKey(accountId));
  } catch { /* storage blocked — Undo still works while the sheet stays open */ }
}

function StatusCell({ row }: { row: BatchRow }) {
  if (row.ready) return <span className="text-success font-medium">Ready</span>;
  return (
    <span className="text-warning-ink">
      <span className="font-medium">Blocked</span>
      <span className="block text-xs text-ink-2 whitespace-normal">{row.blockers[0] ?? "Not ready."}</span>
      {row.blockers.length > 1 && <span className="block text-xs text-ink-3">{`+${row.blockers.length - 1} more — open the line to see all`}</span>}
    </span>
  );
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
/* R-2745: fee expenses of GST-filed months are dated on the first open day — the lines keep their own dates. */
export function feeDatedLaterText(booked: MonthRunResult["booked"]): string {
  const moved = booked.filter((b) => b.feeDateWhy && b.feeDate);
  if (!moved.length) return "";
  const days = [...new Set(moved.map((b) => b.feeDate as string))].sort();
  const fees = moved.reduce((s, b) => s + b.fee, 0);
  return `Razorpay fees of ${plural(moved.length)} (${rupee(fees)}) are dated ${days.map((d) => formatDate(d)).join(", ")} — the first open day: ${moved[0].feeDateWhy}. The bank lines keep their own dates.`;
}

export function RazorpaySettlementBatch({ accountId, accountName, months, open, onOpenChange }: {
  accountId: string;
  accountName: string;
  months: Array<{ month: string; count: number }>;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [month, setMonth] = React.useState<string | null>(months[0]?.month ?? null);
  const batch = useRazorpayMonthBatch(accountId, open ? month : null);
  const run = useRunRazorpayMonth();
  const undo = useUndoRazorpayMonth();
  const [running, setRunning] = React.useState<{ done: number; of: number } | null>(null);
  const [lastRun, setLastRun] = React.useState<(MonthRunResult & { dates: Record<string, string> }) | null>(null);
  const [saved, setSaved] = React.useState<SavedRun | null>(() => loadRun(accountId));
  const [undone, setUndone] = React.useState<MonthUndoResult | null>(null);

  const lookup = batch.data;
  const rows = lookup?.state === "batch" ? lookup.batch.rows : [];
  const readyRows = rows.filter((r) => r.ready);

  const doRun = async () => {
    if (!month || !readyRows.length || running) return;
    setUndone(null);
    const todo = readyRows.map((r) => r.txnId);
    const dates = Object.fromEntries(rows.map((r) => [r.txnId, r.txnDate]));
    const total: MonthRunResult = { runId: null, booked: [], refused: [] };
    setRunning({ done: 0, of: todo.length });
    try {
      for (let i = 0; i < todo.length; i += RUN_CHUNK) {
        const r = await run.mutateAsync({ accountId, month, txnIds: todo.slice(i, i + RUN_CHUNK), runId: total.runId });
        total.runId = total.runId ?? r.runId;
        total.booked.push(...r.booked);
        total.refused.push(...r.refused);
        if (total.runId && total.booked.length) {
          const s = { runId: total.runId, month, booked: total.booked.length, amount: total.booked.reduce((a, b) => a + b.amount, 0) };
          saveRun(accountId, s);
          setSaved(s);
        }
        setRunning({ done: Math.min(i + RUN_CHUNK, todo.length), of: todo.length });
      }
      if (total.booked.length) toast.success(`Reconciled ${plural(total.booked.length)} of Razorpay settlements`);
      else toast.info("Nothing was booked — see the reasons below.");
    } catch (e) {
      toastError(e, { fallback: total.booked.length ? `Stopped after ${plural(total.booked.length)} — "Undo this run" can still take them back.` : "Could not reconcile the settlements — nothing was booked." });
    } finally {
      setLastRun({ ...total, dates });
      setRunning(null);
      invalidateBank(qc);
    }
  };
  const doUndo = () => {
    if (!saved) return;
    undo.mutate(saved.runId, {
      onSuccess: (u) => {
        setUndone(u);
        if (!u.left.length) { saveRun(accountId, null); setSaved(null); setLastRun(null); }
        const msg = `Undone: ${plural(u.undone)} un-reconciled${u.left.length ? `, ${u.left.length} left (see why below)` : ""}`;
        if (u.left.length) toast.warning(msg); else toast.success(msg);
      },
      onError: (e) => toastError(e, { fallback: "Could not undo the run." }),
    });
  };
  const dateOf = (id: string) => { const d = lastRun?.dates[id]; return d ? `${formatDate(d)}: ` : ""; };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[1100px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{`Razorpay settlements — ${accountName}`}</SheetTitle>
          <SheetDescription>
            One read of the month from Razorpay. Each line is paired with its settlement by UTR (else the only settlement of that amount) and checked like Reconcile → Razorpay settlement. Only Ready lines are booked.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Select value={month ?? undefined} onValueChange={(v) => { setMonth(v); setLastRun(null); setUndone(null); }}>
            <SelectTrigger className="w-56" aria-label="Month">
              <SelectValue placeholder="Pick a month" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m.month} value={m.month}>{`${monthLabel(m.month)} · ${m.count} open`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {lookup?.state === "batch" && (
            <span className="text-sm text-ink-2">
              {`${lookup.batch.ready} ready (${rupee(lookup.batch.readyAmount)}) · ${lookup.batch.blocked} blocked`}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            {saved && (
              <Button variant="default" icon="refresh" loading={undo.isPending} disabled={Boolean(running)} onClick={doUndo}
                title={`Un-reconcile the ${plural(saved.booked)} the last run booked (${monthLabel(saved.month)}) — the fee expenses go, the receipts wait for their bank line again`}>
                Undo this run
              </Button>
            )}
            <Button variant="primary" icon="check" loading={Boolean(running)} disabled={!readyRows.length || batch.isFetching} onClick={() => void doRun()}>
              {running ? `Reconciling… ${running.done} of ${running.of}` : `Reconcile all ready (${readyRows.length})`}
            </Button>
          </div>
        </div>

        {batch.isLoading && <p className="mt-6 text-sm text-ink-2">Reading the month from Razorpay…</p>}
        {lookup && lookup.state !== "batch" && (
          <p className="mt-6 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm">
            {lookup.message}{" "}
            {lookup.state === "no_keys" && <a className="underline" href="/settings?tab=integrations">Open Settings → Integrations</a>}
          </p>
        )}
        {batch.error && <p className="mt-6 text-sm text-danger">{describeError(batch.error, "Could not read the month from Razorpay — try again.").message}</p>}

        {saved && !lastRun && (
          <p className="mt-4 text-sm text-ink-2" role="status">{`Last run: ${plural(saved.booked)} of ${monthLabel(saved.month)} (${rupee(saved.amount)}) — "Undo this run" takes them back.`}</p>
        )}
        {lastRun && (
          <div className="mt-4 rounded-md border border-hairline px-3 py-2 text-sm" role="status">
            <p>{`This run reconciled ${plural(lastRun.booked.length)}${lastRun.booked.length ? ` (${rupee(lastRun.booked.reduce((s, b) => s + b.amount, 0))}, fees ${rupee(lastRun.booked.reduce((s, b) => s + b.fee, 0))})` : ""}.`}</p>
            {lastRun.booked.some((b) => b.feeDateWhy) && <p className="text-ink-2">{feeDatedLaterText(lastRun.booked)}</p>}
            {lastRun.refused.map((r) => <p key={r.txnId} className="text-warning-ink">{`${dateOf(r.txnId)}${r.message}`}</p>)}
          </div>
        )}
        {undone && undone.left.length > 0 && (
          <div className="mt-2 rounded-md border border-warning/40 px-3 py-2 text-sm" role="status">
            {undone.left.map((l) => <p key={l.txn_id}>{`${formatDate(l.txn_date)} ${rupee(l.credit)}: ${l.reason}`}</p>)}
          </div>
        )}

        {lookup?.state === "batch" && (
          rows.length === 0
            ? <p className="mt-6 text-sm text-ink-2">No open Razorpay settlement lines in this month.</p>
            : (
              <table className="mt-4 w-full table-fixed text-sm">
                <thead>
                  <tr className="text-left text-ink-2">
                    <th className="w-24 py-2">Date</th>
                    <th className="w-28 py-2 text-right">Bank line</th>
                    <th className="w-44 py-2 pl-4">Settlement</th>
                    <th className="w-20 py-2 text-right">Payments</th>
                    <th className="w-28 py-2 text-right">Fee (GST)</th>
                    <th className="py-2 pl-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.txnId} className="border-t border-hairline align-top">
                      <td className="py-2">{formatDate(r.txnDate)}</td>
                      <td className="py-2 text-right tabular-nums">{rupee(r.amount)}</td>
                      <td className="py-2 pl-4 truncate" title={r.settlementId ? `${r.settlementId}${r.utr ? ` · UTR ${r.utr}` : ""}` : undefined}>
                        {r.settlementId ?? "—"}
                        {r.pairedBy && <span className="block text-xs text-ink-3">{r.pairedBy === "utr" ? "by UTR" : "by amount"}</span>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{r.settlementId ? r.payments : "—"}</td>
                      <td className="py-2 text-right tabular-nums">{r.settlementId ? `${rupee(r.fee)} (${rupee(r.feeGst)})` : "—"}</td>
                      <td className="py-2 pl-4"><StatusCell row={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The bank page's button — open Razorpay lines per month; opens the sheet (mounted only while open). */
export function RazorpaySettlementBatchButton({ accountId, accountName, transactions }: {
  accountId: string;
  accountName: string;
  transactions: ReadonlyArray<TxnLite>;
}) {
  const [open, setOpen] = React.useState(false);
  const live = React.useMemo(() => razorpayMonths(transactions), [transactions]);
  /* Review: the month list is frozen while the sheet is open — booking the last open lines must not
     unmount the sheet (its result and "Undo this run" would vanish) nor blank the month picker. */
  const [frozen, setFrozen] = React.useState<typeof live | null>(null);
  /* A run kept in this tab keeps the button, so its Undo can be reached after all lines are booked. */
  const [hasSaved, setHasSaved] = React.useState(false);
  React.useEffect(() => { setHasSaved(loadRun(accountId) !== null); }, [accountId, open]);
  const total = live.reduce((s, m) => s + m.count, 0);
  if (!total && !open && !hasSaved) return null;
  return (
    <>
      <Button icon="layers" variant="default" onClick={() => { setFrozen(live); setOpen(true); }}
        title="Pair this account's open Razorpay settlement lines with Razorpay's settlements for a month and reconcile every ready one at once">
        {`Razorpay settlements (${total})`}
      </Button>
      {open && (
        <RazorpaySettlementBatch accountId={accountId} accountName={accountName} months={frozen ?? live} open={open}
          onOpenChange={(v) => { setOpen(v); if (!v) setFrozen(null); }} />
      )}
    </>
  );
}
