/**
 * R-2611 — "Book no-vendor lines" on a bank account page: the "Money out · no vendor yet" lines in
 * one table, each with the category + paid-to the Reconcile sheet would pre-fill and a confidence
 * chip (lib/banking/bulk-expense.ts). The owner ticks rows ("Tick all high-confidence" never ticks
 * ₹1,00,000 or more), may change a row's category / paid-to, and presses Book selected: the server
 * books each row with the existing book_bank_txn_as_expense (/api/banking/bulk-expense) and answers
 * booked / refused per row. Undo stays per line (Un-reconcile on the line), as today.
 *
 * R-2657 (G-RECON N4) — "By payee" view (the default): lines grouped by who was paid
 * (lib/banking/bulk-expense-groups.ts), one category pick per group, "Tick group", and "Always book
 * like this" (a Category Rule saved after the group's lines are booked, so the next statement comes
 * pre-filled and high-confidence). The bank's GST on its charges (DPO … CGST / SGST) is one group,
 * suggested as Bank Charges with GST ₹0. Pardeep's D1: lines a Zoho-imported expense / bill already
 * covers are left out (lib/banking/zoho-covered.ts — matched on the bank page instead); the server
 * refuses them too. Run id + "Undo this run" is R-2663.
 */
"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { EXPENSE_CATEGORIES, suggestCategory } from "@/lib/queries/expenses";
import { useCreateTxnCategoryRule, useTxnCategoryRules } from "@/lib/queries/txn-category-rules";
import { usePrepaidAdvances } from "@/lib/queries/prepaid-advances";
import { createClient } from "@/lib/supabase/client";
import { AUTO_TICK_MAX, BULK_MAX, bulkExcluded, bulkRows, type BulkRow } from "@/lib/banking/bulk-expense";
import { applyGroupCategory, payeeGroups, tickGroupIds, type PayeeGroup } from "@/lib/banking/bulk-expense-groups";
import { coveringDoc, loadImportedDocs, type DocsDb } from "@/lib/banking/zoho-covered";
import type { BankTransactionRow } from "@/lib/queries/bank";
import type { BulkExpenseResult } from "@/app/api/banking/bulk-expense/route";

export const BULK_EXPENSE_URL = "/api/banking/bulk-expense";

type Result = BulkExpenseResult;
type Edit = { category?: string; payee?: string; byRow?: boolean };

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
        title="Book money-out lines with no vendor as expenses in one go — grouped by payee, each with the suggested category; you tick which to book"
      >
        {`No-vendor lines (${lines.length})`}
      </Button>
      {/* Mounted only while open — closing it forgets ticks and edits. */}
      {open && <BulkExpenseSheet onOpenChange={setOpen} accountName={accountName} lines={lines} />}
    </>
  );
}

/** D1: the Zoho-imported purchases (no bank line yet) that could cover these lines. */
function useImportedDocs(lines: readonly BankTransactionRow[]) {
  const dates = React.useMemo(() => lines.map((l) => l.txn_date.slice(0, 10)).sort(), [lines]);
  const from = dates[0] ?? "";
  const to = dates[dates.length - 1] ?? "";
  return useQuery({
    queryKey: ["zoho-covered-docs", from, to],
    enabled: !!from,
    queryFn: () => loadImportedDocs(createClient() as unknown as DocsDb, from, to),
    staleTime: 60_000,
  });
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
  const docsQ = useImportedDocs(lines);
  const createRule = useCreateTxnCategoryRule();
  const known = React.useMemo(() => [...new Set((advances ?? []).map((a) => a.vendor_name.trim()))].sort(), [advances]);

  /* Lines a Zoho-imported expense / bill already covers are not offered (D1) — listed as a count. */
  const coveredIds = React.useMemo(() => {
    const docs = docsQ.data ?? [];
    return new Set(lines.filter((l) => coveringDoc({ debit: l.debit, txn_date: l.txn_date }, docs)).map((l) => l.id));
  }, [lines, docsQ.data]);

  /* Oldest first — booked lines leave the list, so the next ones come up. */
  const all = React.useMemo(() => {
    const sorted = lines.filter((l) => !coveredIds.has(l.id))
      .sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
    return bulkRows(sorted, rules ?? [], suggestCategory, known);
  }, [lines, coveredIds, rules, known]);
  const rows = React.useMemo(() => all.slice(0, BULK_MAX), [all]);
  const groups = React.useMemo(() => payeeGroups(all), [all]);

  const [view, setView] = React.useState<"payee" | "lines">("payee");
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());
  const [edits, setEdits] = React.useState<Record<string, Edit>>({});
  const [groupCat, setGroupCat] = React.useState<Record<string, string>>({});
  const [remember, setRemember] = React.useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<Result[] | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [rulesSaved, setRulesSaved] = React.useState(0);

  const catOf = (r: BulkRow) => edits[r.id]?.category ?? r.category;
  const payeeOf = (r: BulkRow) => edits[r.id]?.payee ?? r.payee;
  const highIds = all.filter((r) => r.autoTick).map((r) => r.id).slice(0, BULK_MAX);
  const picked = all.filter((r) => ticked.has(r.id));
  const missingCat = picked.filter((r) => !catOf(r)).length;
  const tooMany = picked.length > BULK_MAX;
  const pickedTotal = picked.reduce((s, r) => s + r.debit, 0);
  const toggle = (id: string, on: boolean) => setTicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleMany = (ids: readonly string[], on: boolean) => setTicked((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  const edit = (id: string, patch: Edit) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch, byRow: true } }));
  const pickGroup = (g: PayeeGroup, category: string) => {
    setGroupCat((m) => ({ ...m, [g.key]: category }));
    setEdits((e) => applyGroupCategory(g, category, e));
  };
  const groupCatOf = (g: PayeeGroup) => groupCat[g.key] ?? g.category;
  const flip = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string, on: boolean) =>
    setter((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });

  /* "Always book like this": after a group's lines are booked, its Category Rule is saved. */
  const saveRules = async (res: readonly Result[]) => {
    const okIds = new Set(res.filter((r) => r.ok).map((r) => r.txnId));
    let saved = 0;
    for (const g of groups) {
      const cat = groupCatOf(g);
      if (!remember.has(g.key) || !g.rulePattern || !cat) continue;
      const first = g.rows.find((r) => okIds.has(r.id));
      if (!first) continue;
      try {
        await createRule.mutateAsync({ pattern: g.rulePattern, category: cat, direction: "debit", fromTxnId: first.id });
        saved++;
      } catch { /* the hook shows its own message */ }
    }
    setRulesSaved(saved);
  };

  const book = async () => {
    if (busy || picked.length === 0 || missingCat > 0 || tooMany) return;
    setBusy(true); setFailure(null); setRulesSaved(0);
    try {
      const res = await fetch(BULK_EXPENSE_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: picked.map((r) => ({ txnId: r.id, category: catOf(r), payee: payeeOf(r).trim() || null })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* A 504 / proxy cut can come after some rows were booked — same as no answer. */
        setFailure(body?.error ?? "No clear answer from the server — some lines may have been booked. Check the refreshed list before booking again.");
        setTicked(new Set());
        return;
      }
      setResults(body.results as Result[]);
      setTicked(new Set());
      await saveRules(body.results as Result[]);
    } catch {
      /* R-2611 review: the request may have booked lines before the answer was lost — clear the
         ticks so the same lines are not sent again from memory. */
      setTicked(new Set());
      setFailure("No answer from the server — some lines may have been booked. Check the refreshed list before booking again.");
    } finally {
      /* Book selected stays disabled until the list has really refreshed (booked lines gone). */
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bank_transactions"] }),
        qc.invalidateQueries({ queryKey: ["expenses"] }),
        qc.invalidateQueries({ queryKey: ["balance-sheet"] }),
      ]).catch(() => undefined);
      setBusy(false);
    }
  };

  const booked = results?.filter((r) => r.ok).length ?? 0;
  const refused = (results ?? []).filter((r): r is Extract<Result, { ok: false }> => !r.ok);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const loading = rulesLoading || docsQ.isLoading;

  const lineRow = (r: BulkRow, nested = false) => {
    const cat = catOf(r);
    return (
      <tr key={r.id} data-testid={`bulk-expense-row-${r.id}`} className={`border-b border-hairline align-top${nested ? " bg-paper-2" : ""}`}>
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
  };

  const lineCols = (
    <colgroup>
      <col className="w-[32px]" />
      <col className="w-[92px]" />
      <col />
      <col className="w-[104px]" />
      <col className="w-[220px]" />
      <col className="w-[190px]" />
      <col className="w-[180px]" />
    </colgroup>
  );
  const lineHead = (
    <tr className="border-b border-hairline text-left text-2xs uppercase tracking-wide text-ink-3">
      <th className="py-2 pl-1" />
      <th className="py-2 pr-2">Date</th>
      <th className="py-2 pr-2">Narration</th>
      <th className="py-2 pr-2 text-right">Amount</th>
      <th className="py-2 pr-2">Category</th>
      <th className="py-2 pr-2">Paid to</th>
      <th className="py-2 pr-2">Suggestion</th>
    </tr>
  );

  const groupTable = (
    <table className="w-full table-fixed text-xs" data-testid="bulk-expense-groups">
      {lineCols}
      <thead className="sticky top-0 z-10 bg-paper">
        <tr className="border-b border-hairline text-left text-2xs uppercase tracking-wide text-ink-3">
          <th className="py-2 pl-1" />
          <th className="py-2 pr-2">Lines</th>
          <th className="py-2 pr-2">Paid to</th>
          <th className="py-2 pr-2 text-right">Amount</th>
          <th className="py-2 pr-2">Category (whole group)</th>
          <th className="py-2 pr-2">Next time</th>
          <th className="py-2 pr-2">Suggestion</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const tickable = tickGroupIds(g);
          const nTicked = g.rows.filter((r) => ticked.has(r.id)).length;
          const isOpen = openGroups.has(g.key);
          const cat = groupCatOf(g);
          const mixed = !cat && g.rows.some((r) => catOf(r));
          const first = g.rows[0];
          return (
            <React.Fragment key={g.key}>
              <tr data-testid={`bulk-expense-group-${g.key}`} className="border-b border-hairline align-top">
                <td className="py-2 pl-1">
                  <input
                    type="checkbox"
                    aria-label={`Tick the ${g.rows.length} line${g.rows.length === 1 ? "" : "s"} paid to ${g.label}`}
                    checked={tickable.length > 0 && tickable.every((id) => ticked.has(id))}
                    disabled={busy || tickable.length === 0}
                    onChange={(e) => toggleMany(tickable, e.target.checked)}
                  />
                </td>
                <td className="py-2 pr-2 text-ink-2 tabular-nums">
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-ink"
                    aria-expanded={isOpen}
                    onClick={() => flip(setOpenGroups, g.key, !isOpen)}
                  >
                    {`${g.rows.length} line${g.rows.length === 1 ? "" : "s"}`}
                  </button>
                  {nTicked > 0 && <span className="block text-2xs text-ink-3">{nTicked} ticked</span>}
                </td>
                <td className="py-2 pr-2 text-ink break-words" title={first?.description ?? ""}>
                  <span className="font-medium">{g.label}</span>
                  {g.rows.length === 1 && first?.description && <span className="block text-2xs text-ink-3 break-words">{first.description}</span>}
                </td>
                <td className="py-2 pr-2 text-right font-medium text-ink tabular-nums">
                  {rupee(g.total)}
                  {g.rows.length > 1 && <span className="block text-2xs font-normal text-ink-3">{g.min === g.max ? `${rupee(g.min)} each` : `${rupee(g.min)}–${rupee(g.max)}`}</span>}
                </td>
                <td className="py-2 pr-2">
                  <select
                    aria-label={`Category for every line paid to ${g.label}`}
                    className="w-full rounded-md border border-hairline bg-paper px-1.5 py-1 text-xs"
                    value={cat}
                    disabled={busy}
                    onChange={(e) => pickGroup(g, e.target.value)}
                  >
                    <option value="" disabled>{mixed ? "Mixed — choose one for all…" : "Choose category…"}</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="py-2 pr-2 text-ink-2">
                  {g.rulePattern ? (
                    <label className="inline-flex items-start gap-1.5" title={`Saves a Category Rule: a money-out narration with "${g.rulePattern}" → this category`}>
                      <input
                        type="checkbox"
                        checked={remember.has(g.key)}
                        disabled={busy}
                        onChange={(e) => flip(setRemember, g.key, e.target.checked)}
                      />
                      <span>Always book like this</span>
                    </label>
                  ) : <span className="text-ink-3">—</span>}
                </td>
                <td className="py-2 pr-2 text-ink-3 break-words">
                  {first?.confidence && g.rows.every((r) => r.confidence === first.confidence && r.reason === first.reason)
                    ? <><Badge size="sm" kind={first.confidence === "high" ? "success" : "warning"}>{first.confidence === "high" ? "High" : "Medium"}</Badge> {first.reason}</>
                    : g.rows.some((r) => r.confidence) ? <span>Suggestions differ — open the lines</span> : <span>No suggestion — pick a category</span>}
                </td>
              </tr>
              {isOpen && g.rows.map((r) => lineRow(r, true))}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[1200px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Book no-vendor lines — {accountName}</SheetTitle>
          <SheetDescription>
            Money-out lines with no vendor yet, grouped by who was paid. Pick one category for a group, tick it, then press
            Book selected — tick &quot;Always book like this&quot; to pre-fill that payee next time. Each line is booked as a paid
            expense (GST ₹0, no input GST claimed) — a line with a GST bill or an open vendor bill: open it on the bank page instead.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {results && (
            <div className="rounded-md border border-hairline bg-paper p-3 text-sm space-y-1" aria-live="polite" data-testid="bulk-expense-result">
              <p className="text-ink">
                <b>{booked}</b> booked · <b>{refused.length}</b> not booked
                {rulesSaved > 0 && <> · <b>{rulesSaved}</b> payee rule{rulesSaved === 1 ? "" : "s"} saved for next time</>}
              </p>
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
          {docsQ.isError && (
            <p className="text-sm text-rose-ink" role="alert">
              Could not check the Zoho-imported purchases — the server will still refuse any line they cover. Reload to try again.
            </p>
          )}
          {coveredIds.size > 0 && (
            <p className="text-xs text-ink-2" data-testid="bulk-expense-covered">
              {coveredIds.size} line{coveredIds.size === 1 ? " is" : "s are"} not shown: a Zoho-imported expense or bill of the same amount
              already covers {coveredIds.size === 1 ? "it" : "them"} — match {coveredIds.size === 1 ? "it" : "them"} to that document on the bank page, so the cost is not counted twice.
            </p>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-ink-2">
            <span className="flex items-center gap-2">
              <span role="group" aria-label="Show lines" className="inline-flex rounded-md border border-hairline bg-paper p-0.5">
                {([["payee", `By payee (${groups.length})`], ["lines", `All lines (${all.length})`]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap [@media(pointer:coarse)]:min-h-10 ${
                      view === v ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>
              <span>
                {view === "lines" && all.length > rows.length ? `Oldest ${rows.length} of ${all.length}. ` : ""}
                High = your own Category Rule or a sure default. Lines of {rupee(AUTO_TICK_MAX)} or more are never ticked for you.
              </span>
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="default" disabled={busy || highIds.length === 0} onClick={() => setTicked(new Set(highIds))}>
                {`Tick all high-confidence (${highIds.length})`}
              </Button>
              <Button size="sm" variant="default" disabled={busy || ticked.size === 0} onClick={() => setTicked(new Set())}>Clear ticks</Button>
            </span>
          </div>

          {loading ? (
            <p className="text-sm text-ink-3">Reading your Category Rules and Zoho-imported purchases…</p>
          ) : all.length === 0 ? (
            <p className="text-sm text-ink-3">No money-out lines without a vendor are left ✓</p>
          ) : view === "payee" ? groupTable : (
            <table className="w-full table-fixed text-xs">
              {lineCols}
              <thead className="sticky top-0 z-10 bg-paper">{lineHead}</thead>
              <tbody>{rows.map((r) => lineRow(r))}</tbody>
            </table>
          )}
        </div>

        <div className="border-t border-hairline px-5 py-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-2">
            {tooMany ? `${picked.length} ticked — book at most ${BULK_MAX} lines at a time; untick some.`
              : missingCat > 0 ? `${missingCat} ticked line${missingCat === 1 ? "" : "s"} still need a category.`
                : picked.length > 0 ? `${picked.length} ticked · ${rupee(pickedTotal)}` : "Tick the lines to book."}
          </span>
          <Button variant="primary" loading={busy} disabled={picked.length === 0 || missingCat > 0 || tooMany || docsQ.isLoading} onClick={() => void book()}>
            {picked.length > 0 ? `Book selected (${picked.length})` : "Book selected"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
