/**
 * R-2496 (G-FY2526) — Books start: the first day whose money lives in the app (Excel: 1 Apr 2025).
 * One per company, set by the OWNER on Accounting → Overview; the Balance Sheet, Trial Balance and
 * Reconcile from Zoho all read it (lib/accounting/books-start.ts). The database decides through
 * set_books_start_date() (migration 20261105064050): owner only, never a future date, never later
 * than a money row already in the books, one activity-log row per change. Anyone else sees it.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useOpeningBalances } from "@/lib/queries/balance-sheet";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import { formatDate } from "@/lib/utils";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { booksStartOf, type BooksStart } from "@/lib/accounting/books-start";

const KEY = ["books-start"] as const;

/** The owner's stored setting (null = not set). A database without the column reads as not set. */
export function useBooksStartSetting() {
  const tenantId = useCurrentUser().data?.tenantId ?? null;
  return useQuery({
    queryKey: [...KEY, tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient().from("tenants").select("books_start_date").eq("id", tenantId!).limit(1).maybeSingle();
      if (error) {
        if (error.code === "42703") return null; /* migration not on this database yet */
        throw error;
      }
      const v = (data as { books_start_date?: string | null } | null)?.books_start_date ?? null;
      return v ? v.slice(0, 10) : null;
    },
    staleTime: 60_000,
  });
}

/** The company's books start (setting, else opening date + 1); undefined while either is loading. */
export function useBooksStart(): { data: BooksStart | undefined; isError: boolean; error: unknown; refetch: () => void } {
  const setting = useBooksStartSetting();
  const opening = useOpeningBalances();
  const data = React.useMemo(
    () => (setting.data === undefined || opening.data === undefined ? undefined
      : booksStartOf({ booksStartDate: setting.data, openingAsOf: opening.data?.asOf ?? null })),
    [setting.data, opening.data],
  );
  return {
    data, isError: setting.isError || opening.isError, error: setting.error ?? opening.error,
    refetch: () => { if (setting.isError) void setting.refetch(); if (opening.isError) void opening.refetch(); },
  };
}

type SetBooksStartRpc = (fn: "set_books_start_date", args: { p_date: string | null }) => PromiseLike<{ error: { message: string } | null }>;

export function useSetBooksStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (date: string | null) => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as SetBooksStartRpc;
      const { error } = await rpc.call(supabase, "set_books_start_date", { p_date: date });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: queryKeys.pnl() });
    },
    onError: (e) => toastError(e, { fallback: "Could not save the books start date" }),
  });
}

export function BooksStartCard() {
  const bs = useBooksStart();
  const save = useSetBooksStart();
  const confirm = useConfirm();
  const isOwner = useCurrentUser().data?.role === "owner";
  const current = bs.data?.setting ?? null;
  const [draft, setDraft] = React.useState("");
  React.useEffect(() => { if (bs.data) setDraft(bs.data.setting ?? ""); }, [bs.data]);
  const today = istToday();

  async function submit(next: string | null) {
    const ok = await confirm({
      title: next ? `Start the books on ${formatDate(next)}?` : "Clear the books start date?",
      body: next
        ? `Money dated before ${formatDate(next)} is the opening balance (enter opening balances as at ${formatDate(addDaysISO(next, -1))}). Reports and Reconcile from Zoho use this date.`
        : "Reports and Reconcile from Zoho go back to the day after your opening balances date.",
      confirmLabel: next ? "Save" : "Clear", cancelLabel: "Cancel",
    });
    if (ok) save.mutate(next);
  }

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Icon name="calendar" size={14} className={current ? "text-emerald" : "text-ink-3"} />
            Books start
          </p>
          <p className="text-xs text-ink-2 mt-0.5" data-testid="books-start-text">
            {bs.isError ? <span className="text-rose">Could not load the books start date. Reload the page.</span>
              : !bs.data ? "…"
              : current ? <>Your books in the app start on <b>{formatDate(current)}</b>. Money dated before it is the opening balance.</>
              : bs.data.start ? <>Not set — the app uses the day after your opening balances: <b>{formatDate(bs.data.start)}</b>.</>
              : <>Not set. Enter the first day of your books in the app (usually 1 April).</>}
          </p>
        </div>
        {isOwner ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Input type="date" value={draft} max={today} onChange={(e) => setDraft(e.target.value)} className="w-[170px]" aria-label="Books start date" />
            <Button size="sm" disabled={!bs.data || !draft || draft === (current ?? "") || save.isPending} onClick={() => submit(draft)}>Save</Button>
            {current && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => submit(null)}>Clear</Button>}
          </div>
        ) : (
          <span className="text-xs text-ink-3">Only the owner can change this</span>
        )}
      </div>
    </Card>
  );
}
