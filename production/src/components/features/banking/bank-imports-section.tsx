/**
 * BankImportsSection — R-1623. The account page's "Imports" list and "Ye import hatao".
 *
 * Every statement import of this account, newest first: when, which file, what kind (PDF /
 * CSV / XLS / pasted), how many lines, who, the statement dates it covers and its first →
 * last running balance. Imports from before 20 Oct 2026 carry no batch, so they show as
 * "Purana import", one per insert time (lib/banking/import-history.ts).
 *
 * "Ye import hatao" (owner / accountant) removes that one import's lines through the atomic
 * remove_bank_import RPC. A reconciled line blocks it (CLAUDE.md §24): the dialog lists those
 * lines with an Un-reconcile button each; the database refuses the same case, and a books-lock
 * refusal is shown in the dialog with its unlock step.
 *
 * R-1695: compact. Collapsed to one summary line by default (chalu / hataye counts, latest
 * import) — open when an active import has the amber chain warning, else the viewer's last
 * choice (localStorage). Open: active imports only, one line each, 5 then "Aur N dikhao";
 * removed imports behind their own "Hataye gaye (M)" toggle.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { toastError } from "@/lib/errors/toast-error";
import { useBankImportHistory, useRemoveBankImport, type BankTransactionRow } from "@/lib/queries/bank";
import {
  chainEffect,
  importKey,
  linesOfImport,
  reconciledLinesOf,
  removeImportArgs,
  sourceLabel,
  type BankImportRow,
} from "@/lib/banking/import-history";

/** Who may take an import back — the same two roles remove_bank_import allows. */
const REMOVE_ROLES = new Set(["owner", "accountant"]);

type Props = {
  accountId: string;
  transactions: BankTransactionRow[];
  openingBalance: number;
  role: string | null | undefined;
  /** Opens the page's Un-reconcile confirm for that line. */
  onUnreconcileLine: (txn: BankTransactionRow) => void;
};

function dateRange(from: string | null, to: string | null): string {
  if (!from) return "—";
  return from === to || !to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
}

/** R-1695: how many active imports show before "Aur N dikhao". */
const FIRST_ROWS = 5;
/** R-1695: the viewer's last open / closed choice for this card (per browser, any account). */
const OPEN_KEY = "reselleros.bank-imports.open";

function readOpen(): boolean | null {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function writeOpen(open: boolean) {
  try { window.localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* private mode — just not remembered */ }
}

function fileLabel(r: BankImportRow): string {
  return r.file_name ?? (r.kind === "legacy" || r.source === "legacy" ? "Old import" : "no file name");
}

const newestFirst = (a: BankImportRow, b: BankImportRow) => b.imported_at.localeCompare(a.imported_at);

export function BankImportsSection({ accountId, transactions, openingBalance, role, onUnreconcileLine }: Props) {
  const historyQ = useBankImportHistory(accountId);
  const [removing, setRemoving] = React.useState<BankImportRow | null>(null);
  const canRemove = REMOVE_ROLES.has(role ?? "");
  const imports = React.useMemo(() => historyQ.data ?? [], [historyQ.data]);
  const active = React.useMemo(() => imports.filter((r) => !r.removed_at).sort(newestFirst), [imports]);
  const gone = React.useMemo(() => imports.filter((r) => r.removed_at).sort(newestFirst), [imports]);

  /* Chain check per import: "Lines missing" with and without its lines. Only for live imports
     and only while there is something missing at all — one pass of checkStatement each. */
  const effects = React.useMemo(() => {
    const out = new Map<string, { before: number; after: number }>();
    if (active.length < 2) return out;
    for (const r of active) {
      const own = linesOfImport(r, transactions);
      if (own.length === 0) continue;
      const fx = chainEffect(transactions, own, openingBalance);
      if (!fx || fx.before <= 1) return new Map();   // the account chains — nothing to flag
      if (fx.before - fx.after > 1) out.set(importKey(r), fx);
    }
    return out;
  }, [active, transactions, openingBalance]);

  /* R-1695: collapsed by default; the viewer's last choice wins; an amber chain warning opens it.
     Storage is read after mount so the server and first client render agree. */
  const [stored, setStored] = React.useState<boolean | null>(null);
  const [choice, setChoice] = React.useState<boolean | null>(null);
  React.useEffect(() => { setStored(readOpen()); }, []);
  const warned = effects.size;
  const open = choice ?? (warned > 0 ? true : stored ?? false);
  const [showAll, setShowAll] = React.useState(false);
  const [showGone, setShowGone] = React.useState(false);
  const bodyId = React.useId();
  const goneId = React.useId();

  if (historyQ.isLoading || (imports.length === 0 && !historyQ.isError)) return null;

  const latest = active[0] ?? gone[0] ?? null;
  const shown = showAll ? active : active.slice(0, FIRST_ROWS);
  const toggle = () => { const next = !open; setChoice(next); writeOpen(next); };

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
        <p data-testid="imports-summary" className="min-w-0 flex-1 text-[13px] text-ink-3">
          <span className="text-sm font-semibold text-ink">Imports</span>
          {historyQ.isError ? null : (
            <>
              {" · "}{active.length} active{" · "}{gone.length} removed
              {latest && (
                <>
                  {" · "}last: {formatDate(latest.imported_at)}{" · "}
                  <span className="text-ink-2 break-all" title={fileLabel(latest)}>{fileLabel(latest)}</span>
                </>
              )}
              {warned > 0 && (
                <span className="text-amber-ink">
                  {" · "}{warned} import{warned === 1 ? "" : "s"} with a balance chain mismatch
                </span>
              )}
            </>
          )}
        </p>
        {!historyQ.isError && (
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
            {open ? "Hide" : "Show"}
          </Button>
        )}
      </div>

      {historyQ.isError ? (
        <p className="text-sm text-rose mt-2" role="alert">
          Could not load the imports list.{" "}
          <button type="button" className="underline" onClick={() => void historyQ.refetch()}>Try again</button>
        </p>
      ) : open ? (
        <div id={bodyId} className="mt-2">
          <p className="text-xs text-ink-3">
            Imported the wrong file? Use &quot;Remove import&quot; on that import.
            {!canRemove && <> Only the owner or an accountant can remove an import.</>}
          </p>

          {active.length > 0 && (
            <ul className="mt-1 divide-y divide-hairline">
              {shown.map((r) => {
                const fx = effects.get(importKey(r));
                const name = fileLabel(r);
                const tip = [name, r.imported_by ? `Imported by: ${r.imported_by}` : null,
                  r.first_balance !== null && r.last_balance !== null ? `Balance ${rupee(r.first_balance)} → ${rupee(r.last_balance)}` : null]
                  .filter(Boolean).join(" · ");
                return (
                  <li key={importKey(r)} className="py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[13px]">
                        <span className="flex min-w-0 max-w-full items-center gap-2">
                          <span className="whitespace-nowrap text-ink">{formatDate(r.imported_at, "long")}</span>
                          <Badge kind={r.kind === "legacy" ? "warning" : "muted"} size="sm">{sourceLabel(r.source)}</Badge>
                          <span className="truncate text-ink-2" title={tip}>{name}</span>
                        </span>
                        <span className="whitespace-nowrap text-xs text-ink-3">
                          {r.line_count} lines · {dateRange(r.txn_from, r.txn_to)}
                          {r.reconciled_count > 0 ? <> · {r.reconciled_count} reconciled</> : null}
                        </span>
                      </div>
                      {canRemove && (
                        <Button size="sm" variant="default" icon="trash" className="shrink-0" onClick={() => setRemoving(r)}>
                          Remove import
                        </Button>
                      )}
                    </div>
                    {fx && (
                      <p className="text-xs text-amber-ink mt-1">
                        This import's balance chain does not match the other lines — removing it changes &quot;Lines missing&quot;{" "}
                        from {rupee(fx.before)} to {rupee(fx.after)}.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {active.length > FIRST_ROWS && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show ${active.length - FIRST_ROWS} more`}
            </Button>
          )}

          {gone.length > 0 && (
            <div className="mt-1">
              <Button size="sm" variant="ghost" aria-expanded={showGone} aria-controls={goneId} onClick={() => setShowGone((v) => !v)}>
                Removed ({gone.length})
              </Button>
              {showGone && (
                <ul id={goneId} className="divide-y divide-hairline">
                  {gone.map((r) => (
                    <li key={importKey(r) + (r.removed_at ?? "")} className="py-1.5 text-xs text-ink-3 min-w-0">
                      <span className="whitespace-nowrap">{formatDate(r.imported_at)}</span>
                      {" · "}<span className="break-all" title={fileLabel(r)}>{fileLabel(r)}</span>
                      {" · "}{r.removed_lines ?? r.line_count} lines
                      {" · "}Removed {formatDate(r.removed_at)}{r.removed_by ? ` · ${r.removed_by}` : ""}
                      {r.remove_reason ? <> · &ldquo;{r.remove_reason}&rdquo;</> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : null}

      <RemoveImportDialog
        accountId={accountId}
        imp={removing}
        transactions={transactions}
        onClose={() => setRemoving(null)}
        onUnreconcileLine={(t) => { setRemoving(null); onUnreconcileLine(t); }}
      />
    </Card>
  );
}

function RemoveImportDialog({ accountId, imp, transactions, onClose, onUnreconcileLine }: {
  accountId: string;
  imp: BankImportRow | null;
  transactions: BankTransactionRow[];
  onClose: () => void;
  onUnreconcileLine: (txn: BankTransactionRow) => void;
}) {
  const remove = useRemoveBankImport();
  const [reason, setReason] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => { setReason(""); setProblem(null); }, [imp]);

  const own = React.useMemo(() => (imp ? linesOfImport(imp, transactions) : []), [imp, transactions]);
  const reconciled = React.useMemo(() => (imp ? reconciledLinesOf(imp, transactions) : []), [imp, transactions]);
  const count = own.length || imp?.line_count || 0;

  async function confirm() {
    if (!imp) return;
    if (reason.trim().length < 3) {
      setProblem("Enter a reason for removing this import (at least 3 characters) — it is saved in the activity log.");
      return;
    }
    setProblem(null);
    try {
      await remove.mutateAsync(removeImportArgs(imp, accountId, reason));
      onClose();
    } catch (err) {
      const msg = (err as { message?: string } | null)?.message ?? "Could not remove the import.";
      setProblem(msg);
      toastError(err, { fallback: "Could not remove the import.", description: "Nothing was removed — the dialog shows the reason and the next step." });
    }
  }

  return (
    <Dialog open={!!imp} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        {reconciled.length > 0 ? (
          <>
            <DialogHeader>
              <DialogTitle>This import cannot be removed yet</DialogTitle>
              <DialogDescription>
                {reconciled.length} of its lines are reconciled — un-reconcile them first.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-ink-2">
              A payment, expense or booking is linked to these lines. Removing the import would leave them without a bank line, so
              un-reconcile each line first, then click &quot;Remove import&quot; again.
            </p>
            <ul className="mt-2 max-h-72 overflow-auto divide-y divide-hairline rounded-md border border-hairline">
              {reconciled.slice(0, 100).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                  <span className="min-w-0">
                    <span className="text-ink-3 mr-2">{formatDate(t.txn_date)}</span>
                    <span className="font-mono">{t.debit > 0 ? `-${rupee(t.debit)}` : `+${rupee(t.credit)}`}</span>
                    <span className="block truncate text-ink-2">{t.description}</span>
                  </span>
                  <Button size="sm" variant="default" onClick={() => onUnreconcileLine(t)}>Un-reconcile</Button>
                </li>
              ))}
            </ul>
            {reconciled.length > 100 && (
              <p className="text-xs text-ink-3 mt-1">
                Showing the first 100 — the rest are in the account's &quot;Reconciled&quot; tab.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="default" onClick={onClose}>OK</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Remove this import?</DialogTitle>
              <DialogDescription>
                {imp ? `${imp.file_name ?? sourceLabel(imp.source)} · ${formatDate(imp.imported_at, "long")}` : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm text-ink-2">
              <p>
                This import's <b>{count} lines</b> ({imp ? dateRange(imp.txn_from, imp.txn_to) : ""}) will be removed from this account.
                Other imports and manually added lines stay as they are. You can import the correct statement later.
              </p>
              <div>
                <label htmlFor="r1623-reason" className="block text-xs font-semibold text-ink-2 mb-1">Reason for removing</label>
                <Textarea
                  id="r1623-reason"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Wrong file imported — will import the correct PDF"
                />
              </div>
              {problem && (
                <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft/30 p-3 text-[13px] text-rose-ink">
                  {problem}
                  {/Month-end close/.test(problem) && (
                    <> {" "}<Link href={"/accounting/close" as never} className="underline">Open Month-end close</Link></>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
              <Button type="button" variant="danger" loading={remove.isPending} onClick={confirm}>
                Remove {count} lines
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
