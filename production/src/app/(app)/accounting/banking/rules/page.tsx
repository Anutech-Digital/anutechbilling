/**
 * Banking → Category Rules — the tenant's own "when a bank line says X, file it as Y".
 *
 * These rules are the first layer of statement categorisation (lib/banking/categorise.ts):
 * they read machine narrations like "…/PAYUFACEBOOK" that the built-in keyword list
 * deliberately cannot. Until now they could only be created from the import preview and
 * never seen, changed or removed again.
 *
 * What the page shows per rule, and why:
 *  • "Matches" — how many bank lines ALREADY imported contain the text, on that side.
 *    Computed with the same categoriseByRules the import uses, so a rule that matches
 *    nothing (a typo) or far too much ("PAY") shows up before it files the next statement.
 *  • The side (money out / in / both) — a direction-blind "SALARY" rule would file a
 *    salary REFUND as a wage expense.
 * Rules only suggest a category at import; changing or deleting one never rewrites lines
 * already in the books.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { ViewOnlyNote } from "@/components/shared/view-only-note";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canWriteMoney } from "@/lib/nav";
import { createClient } from "@/lib/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { categoriseByRules, type BankLine } from "@/lib/banking/categorise";
import {
  useTxnCategoryRuleList,
  useCreateTxnCategoryRule,
  useUpdateTxnCategoryRule,
  useDeleteTxnCategoryRule,
} from "@/lib/queries/txn-category-rules";
import type { TxnRuleDirection } from "@/lib/supabase/database.types";
import { formatDate } from "@/lib/utils";

const DIRECTIONS: Array<[TxnRuleDirection, string]> = [
  ["debit", "Money out"],
  ["credit", "Money in"],
  ["any", "Both"],
];
const directionLabel = (d: TxnRuleDirection) => DIRECTIONS.find(([k]) => k === d)?.[1] ?? d;

/** Every imported bank line's narration and side — enough to count what each rule matches. */
function useBankLinesForRules() {
  return useQuery({
    queryKey: ["bank_transactions", "rule-match-sample"],
    queryFn: async (): Promise<BankLine[]> => {
      const supabase = createClient();
      /* R-1509: paged — `.limit(10000)` came back as 1000 rows, so "Matches" undercounted. */
      const data = await fetchAllRows<{ description: string | null; debit: number | null; credit: number | null }>(
        (from, to) => supabase
          .from("bank_transactions")
          .select("description, debit, credit")
          .order("id", { ascending: true })
          .range(from, to));
      return data.map((t) => ({ description: t.description ?? null, debit: t.debit ?? 0, credit: t.credit ?? 0 }));
    },
    staleTime: 60_000,
  });
}

export default function CategoryRulesPage() {
  const { data: rules, isLoading, error, refetch } = useTxnCategoryRuleList();
  const { data: lines } = useBankLinesForRules();
  const create = useCreateTxnCategoryRule();
  const update = useUpdateTxnCategoryRule();
  const del = useDeleteTxnCategoryRule();
  const confirm = useConfirm();
  /* R-1130: billing reads Banking (R-254) — it sees the rules, but only owner / manager /
   * accountant may add, re-file or delete them (the database refuses the rest). */
  const canWrite = canWriteMoney(useCurrentUser().data?.role);

  // Add form
  const [pattern, setPattern] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [direction, setDirection] = React.useState<TxnRuleDirection>("debit");

  // Tester
  const [probe, setProbe] = React.useState("");
  const [probeSide, setProbeSide] = React.useState<"debit" | "credit">("debit");

  const matchCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules ?? []) {
      m.set(r.id, (lines ?? []).filter((l) => categoriseByRules(l, [r]) !== null).length);
    }
    return m;
  }, [rules, lines]);

  /* The would-be rule's reach, live, before it is saved. */
  const draftMatches = React.useMemo(() => {
    const p = pattern.trim();
    if (!p || !lines) return null;
    return lines.filter((l) => categoriseByRules(l, [{ id: "draft", pattern: p, category: "x", direction }]) !== null).length;
  }, [pattern, direction, lines]);

  const probeResult = React.useMemo(() => {
    if (!probe.trim() || !rules) return null;
    const line: BankLine = { description: probe, debit: probeSide === "debit" ? 1 : 0, credit: probeSide === "credit" ? 1 : 0 };
    return categoriseByRules(line, rules);
  }, [probe, probeSide, rules]);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || !pattern.trim() || !category) return;
    try {
      await create.mutateAsync({ pattern, category, direction });
      setPattern(""); setCategory("");
    } catch { /* hook toasts */ }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      <Link href={"/accounting/banking" as never} className="text-xs text-ink-3 hover:text-ink inline-flex items-center gap-1 mb-2">
        <Icon name="arrow_left" size={12} /> All accounts
      </Link>
      <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Banking</p>
      <h1 className="font-serif text-3xl md:text-4xl leading-tight">Category Rules</h1>
      <p className="text-sm text-ink-3 mt-1 max-w-3xl">
        When a bank line&apos;s narration contains the text, it is filed under the category when you import a
        statement. Matching ignores capitals and works inside words — <code className="font-mono text-xs">FACEBOOK</code> matches{" "}
        <code className="font-mono text-xs">…/PAYUFACEBOOK</code>. Rules only suggest; lines already imported are never changed.
      </p>

      {!canWrite && <div className="mt-5"><ViewOnlyNote what="add or change category rules" /></div>}

      {/* Add a rule */}
      {canWrite && (
      <Card className="mt-5 p-4">
        <form onSubmit={onAdd} className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_0.8fr_auto] gap-2 items-end">
          <label className="text-xs text-ink-3 space-y-1">
            <span className="block font-medium text-ink-2">When the narration contains</span>
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. FACEBOOK" aria-label="Text to match" />
          </label>
          <label className="text-xs text-ink-3 space-y-1">
            <span className="block font-medium text-ink-2">File it as</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Category"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="" disabled>Choose category…</option>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-3 space-y-1">
            <span className="block font-medium text-ink-2">On</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as TxnRuleDirection)}
              aria-label="Which side"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              {DIRECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending} disabled={!pattern.trim() || !category}>
            Add rule
          </Button>
        </form>
        {draftMatches !== null && (
          <p className={`mt-2 text-xs ${draftMatches === 0 ? "text-amber-ink" : "text-ink-3"}`}>
            {draftMatches === 0
              ? "Matches none of your imported lines yet — check the spelling against a real narration."
              : `Would match ${draftMatches} of your imported line${draftMatches === 1 ? "" : "s"} (${directionLabel(direction).toLowerCase()}).`}
            {" "}Same text on the same side as an existing rule updates that rule instead.
          </p>
        )}
      </Card>
      )}

      {/* Test a narration */}
      <Card className="mt-4 p-4">
        <p className="text-sm font-semibold text-ink mb-2">Test a narration</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Paste a narration from your statement" aria-label="Narration to test" />
          <select
            value={probeSide}
            onChange={(e) => setProbeSide(e.target.value as "debit" | "credit")}
            aria-label="Side of the test line"
            className="rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink sm:w-40"
          >
            <option value="debit">Money out</option>
            <option value="credit">Money in</option>
          </select>
        </div>
        {probe.trim() && (
          <p className="mt-2 text-xs">
            {probeResult
              ? <>Filed as <b className="text-ink">{probeResult.category}</b> <span className="text-ink-3">— {probeResult.reason}</span></>
              : <span className="text-ink-3">No rule matches — the import falls back to the built-in keywords, then leaves it unset.</span>}
          </p>
        )}
      </Card>

      {/* The rules */}
      <Card flush className="mt-4">
        {error ? (
          <EmptyState icon="alert" title="Could not load the rules" body={error.message}
            action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
        ) : isLoading ? (
          <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : (rules ?? []).length === 0 ? (
          <EmptyState icon="list" title="No rules yet"
            body="Add one above, or correct a category while importing a statement and pick the text to remember." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr className="text-3xs uppercase tracking-wider text-ink-3">
                  <th className="text-left px-3 py-2.5 font-semibold">Narration contains</th>
                  <th className="text-left px-3 py-2.5 font-semibold">File as</th>
                  <th className="text-left px-3 py-2.5 font-semibold">On</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Matches</th>
                  <th className="text-left px-3 py-2.5 font-semibold">Added</th>
                  <th className="px-3 py-2.5"><span className="sr-only">Delete</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {(rules ?? []).map((r) => {
                  const n = matchCounts.get(r.id) ?? 0;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2 font-mono text-xs text-ink">{r.pattern}</td>
                      <td className="px-3 py-2">
                        {canWrite ? (
                        <select
                          value={r.category}
                          onChange={(e) => update.mutate({ id: r.id, category: e.target.value })}
                          aria-label={`Category for ${r.pattern}`}
                          className="rounded border border-hairline bg-paper px-1.5 py-1 text-xs text-ink"
                        >
                          {/* Keep a category that is no longer in the list visible, not silently swapped. */}
                          {!(EXPENSE_CATEGORIES as readonly string[]).includes(r.category) && <option value={r.category}>{r.category}</option>}
                          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        ) : <span className="text-xs text-ink">{r.category}</span>}
                      </td>
                      <td className="px-3 py-2">
                        {canWrite ? (
                        <select
                          value={r.direction}
                          onChange={(e) => update.mutate({ id: r.id, direction: e.target.value as TxnRuleDirection })}
                          aria-label={`Side for ${r.pattern}`}
                          className="rounded border border-hairline bg-paper px-1.5 py-1 text-xs text-ink"
                        >
                          {DIRECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                        ) : <span className="text-xs text-ink-2">{directionLabel(r.direction)}</span>}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums text-xs ${n === 0 ? "text-amber-ink" : "text-ink-2"}`}
                          title={n === 0 ? "No imported line contains this text on this side" : undefined}>
                        {lines ? n : "…"}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-3 whitespace-nowrap">{formatDate(r.created_at)}</td>
                      <td className="px-3 py-2 text-right">
                        {canWrite && (
                        <button
                          type="button"
                          aria-label={`Delete rule ${r.pattern}`}
                          onClick={async () => {
                            if (await confirm({
                              title: "Delete this rule?",
                              body: `Lines containing "${r.pattern}" will no longer be filed as ${r.category} on import. Lines already imported keep their category.`,
                              confirmLabel: "Delete",
                              danger: true,
                            })) del.mutate(r.id);
                          }}
                          className="text-ink-3 hover:text-rose p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
