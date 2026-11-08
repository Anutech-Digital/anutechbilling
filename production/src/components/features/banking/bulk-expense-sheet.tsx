/**
 * R-2611 — "Book no-vendor lines" on a bank account page: the "Money out · no vendor yet" lines in
 * one table, each with the category + paid-to the Reconcile sheet would pre-fill and a confidence
 * chip (lib/banking/bulk-expense.ts). The owner ticks rows ("Tick all high-confidence" never ticks
 * ₹1,00,000 or more), may change a row's category / paid-to, and presses Book selected: the server
 * books each row with the existing book_bank_txn_as_expense (/api/banking/bulk-expense) and answers
 * booked / refused per row. Undo stays per line (Un-reconcile on the line), as today.
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { EXPENSE_CATEGORIES, suggestCategory } from "@/lib/queries/expenses";
import { useTxnCategoryRules } from "@/lib/queries/txn-category-rules";
import { usePrepaidAdvances } from "@/lib/queries/prepaid-advances";
import { AUTO_TICK_MAX, BULK_MAX, bulkExcluded, bulkRows, type BulkRow } from "@/lib/banking/bulk-expense";
import type { BankTransactionRow } from "@/lib/queries/bank";
import type { BulkExpenseResult } from "@/app/api/banking/bulk-expense/route";

export const BULK_EXPENSE_URL = "/api/banking/bulk-expense";

type Result = BulkExpenseResult;

const CATEGORIES = EXPENSE_CATEGORIES.filter((c) => c !== "Salaries");

/** The bank page's "No-vendor lines (N)" button + its sheet (mounted only while open). */
export function BulkExpenseButton({ accountName, transactions, ids }: {
  accountName: string;
  transactions: readonly BankTransactionRow[] | undefined;
  /** The page's "Money out · no vendor yet" set. */
  ids: ReadonlySet<string>;
}) {
  const [open, setOpen] = React.useState(false);
  /* The lines the sheet offers: the page's set less challans / loans / salary (they have their own tiles). */
  const lines = React.useMemo(() => (transactions ?? []).filter((t) => ids.has(t.id) && !bulkExcluded(t)), [transactions, ids]);
  if (lines.length === 0 && !open) return null;
  return (
    <>
      <Button
        icon="receipt"
        variant="default"
        onClick={() => setOpen(true)}
        title="Book money-out lines with no vendor as expenses in one go — each line shows the suggested category; you tick which to book"
      >
        {`No-vendor lines (${lines.length})`}
      </Button>
      {/* Mounted only while open — closing it forgets ticks and edits. */}
      {open && <BulkExpenseSheet onOpenChange={setOpen} accountName={accountName} lines={lines} />}
    </>
  );
}

export function BulkExpenseSheet({ onOpenChange, accountName, lines }: {
  onOpenChange: (o: boolean) => void;
  accountName: string;
  /** The account's "Money out · no vendor yet" lines. */
  lines: readonly BankTransactionRow[];
}) {
  const qc = useQueryClient();
  const { data: rules, isLoading: rulesLoading } = useTxnCategoryRules();
  const { data: advances } = usePrepaidAdvances();
  const known = React.useMemo(() => [...new Set((advances ?? []).map((a) => a.vendor_name.trim()))].sort(), [advances]);

  /* Oldest first, 100 at a time — booked lines leave the list, so the next 100 come up. */
  const all = React.useMemo(() => {
    const sorted = [...lines].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
    return bulkRows(sorted, rules ?? [], suggestCategory, known);
  }, [lines, rules, known]);
  const rows = React.useMemo(() => all.slice(0, BULK_MAX), [all]);

  const [ticked, setTicked] = React.useState<Set<string>>(new Set());
  const [edits, setEdits] = React.useState<Record<string, { category?: string; payee?: string }>>({});
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<Result[] | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const catOf = (r: BulkRow) => edits[r.id]?.category ?? r.category;
  const payeeOf = (r: BulkRow) => edits[r.id]?.payee ?? r.payee;
  const highIds = rows.filter((r) => r.autoTick).map((r) => r.id);
  const picked = rows.filter((r) => ticked.has(r.id));
  const missingCat = picked.filter((r) => !catOf(r)).length;
  const pickedTotal = picked.reduce((s, r) => s + r.debit, 0);
  const toggle = (id: string, on: boolean) => setTicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const edit = (id: string, patch: { category?: string; payee?: string }) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));

  const book = async () => {
    if (busy || picked.length === 0 || missingCat > 0) return;
    setBusy(true); setFailure(null);
    try {
      const res = await fetch(BULK_EXPENSE_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: picked.map((r) => ({ txnId: r.id, category: catOf(r), payee: payeeOf(r).trim() || null })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setFailure(body?.error ?? "Could not book — nothing was saved. Try again."); return; }
      setResults(body.results as Result[]);
      setTicked(new Set());
    } catch {
      setFailure("No answer from the server — some lines may have been booked. The list refreshes; check it before booking again.");
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    }
  };

  const booked = results?.filter((r) => r.ok).length ?? 0;
  const refused = (results ?? []).filter((r): r is Extract<Result, { ok: false }> => !r.ok);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[1200px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Book no-vendor lines — {accountName}</SheetTitle>
          <SheetDescription>
            Money-out lines with no vendor yet, oldest first, with the category the Reconcile sheet suggests. Tick the right ones,
            change a category or paid-to if needed, then press Book selected. Each line is booked as a paid expense (GST ₹0) —
            a line with a GST bill or an open vendor bill: open it on the bank page instead.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {results && (
            <div className="rounded-md border border-hairline bg-paper p-3 text-sm space-y-1" aria-live="polite" data-testid="bulk-expense-result">
              <p className="text-ink"><b>{booked}</b> booked · <b>{refused.length}</b> not booked</p>
              {refused.map((r) => {
                const l = lineById.get(r.txnId);
                return (
                  <p key={r.txnId} className="text-xs text-rose-ink">
                    {l ? `${formatDate(l.txn_date)} · ${rupee(l.debit)}: ` : ""}{r.error}
                  </p>
                );
              })}
            </div>
          )}
          {failure && <p className="text-sm text-rose-ink" role="alert">{failure}</p>}

          <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-ink-2">
            <span>
              {all.length > rows.length ? `Showing the oldest ${rows.length} of ${all.length} lines — booked lines leave the list.` : `${rows.length} lines.`}
              {" "}High confidence = your own Category Rule. Lines of {rupee(AUTO_TICK_MAX)} or more are never ticked for you.
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="default" disabled={busy || highIds.length === 0} onClick={() => setTicked(new Set(highIds))}>
                {`Tick all high-confidence (${highIds.length})`}
              </Button>
              <Button size="sm" variant="default" disabled={busy || ticked.size === 0} onClick={() => setTicked(new Set())}>Clear ticks</Button>
            </span>
          </div>

          {rulesLoading ? (
            <p className="text-sm text-ink-3">Reading your Category Rules…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-3">No money-out lines without a vendor are left ✓</p>
          ) : (
            <table className="w-full table-fixed text-xs">
              <colgroup>
                <col className="w-[32px]" />
                <col className="w-[92px]" />
                <col />
                <col className="w-[104px]" />
                <col className="w-[220px]" />
                <col className="w-[190px]" />
                <col className="w-[180px]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-paper">
                <tr className="border-b border-hairline text-left text-2xs uppercase tracking-wide text-ink-3">
                  <th className="py-2 pl-1" />
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Narration</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                  <th className="py-2 pr-2">Category</th>
                  <th className="py-2 pr-2">Paid to</th>
                  <th className="py-2 pr-2">Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cat = catOf(r);
                  return (
                    <tr key={r.id} data-testid={`bulk-expense-row-${r.id}`} className="border-b border-hairline align-top">
                      <td className="py-2 pl-1">
                        <input
                          type="checkbox"
                          aria-label={`Book the ${rupee(r.debit)} line of ${formatDate(r.txn_date)}`}
                          checked={ticked.has(r.id)}
                          disabled={busy}
                          onChange={(e) => toggle(r.id, e.target.checked)}
                        />
                      </td>
                      <td className="py-2 pr-2 text-ink-2 tabular-nums">{formatDate(r.txn_date)}</td>
                      <td className="py-2 pr-2 text-ink break-words" title={r.description ?? ""}>{r.description || "—"}</td>
                      <td className="py-2 pr-2 text-right font-medium text-ink tabular-nums">{rupee(r.debit)}</td>
                      <td className="py-2 pr-2">
                        <select
                          aria-label={`Category for the ${rupee(r.debit)} line`}
                          className="w-full rounded-md border border-hairline bg-paper px-1.5 py-1 text-xs"
                          value={cat}
                          disabled={busy}
                          onChange={(e) => edit(r.id, { category: e.target.value })}
                        >
                          <option value="" disabled>Choose category…</option>
                          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          aria-label={`Paid to, for the ${rupee(r.debit)} line`}
                          className="w-full rounded-md border border-hairline bg-paper px-1.5 py-1 text-xs"
                          value={payeeOf(r)}
                          disabled={busy}
                          placeholder="Optional"
                          onChange={(e) => edit(r.id, { payee: e.target.value })}
                        />
                      </td>
                      <td className="py-2 pr-2 text-ink-3 break-words">
                        {r.confidence
                          ? <><Badge size="sm" kind={r.confidence === "high" ? "success" : "warning"}>{r.confidence === "high" ? "High" : "Medium"}</Badge> {r.reason}</>
                          : <span>No suggestion — pick a category</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t border-hairline px-5 py-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-2">
            {missingCat > 0 ? `${missingCat} ticked line${missingCat === 1 ? "" : "s"} still need a category.` : picked.length > 0 ? `${picked.length} ticked · ${rupee(pickedTotal)}` : "Tick the lines to book."}
          </span>
          <Button variant="primary" loading={busy} disabled={picked.length === 0 || missingCat > 0} onClick={() => void book()}>
            {picked.length > 0 ? `Book selected (${picked.length})` : "Book selected"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
