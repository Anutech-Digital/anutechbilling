/**
 * Books lock — the period-close control (migration 20260927120000).
 *
 * The owner or the accountant sets a date (R-1132 — the accountant does the month-end close);
 * every money row dated on or before it (expenses, bank lines, salaries, tax payments,
 * invoices, payments, notes…) can no longer be added, edited or deleted from the app. Set it
 * the day a GSTR-3B / TDS return is filed, so the books stay equal to what was filed. Only the
 * owner can open the books again (clear the lock or move it back). Anyone else on the team
 * sees the date, read-only. The database decides through set_books_lock() (migration
 * 20261017002400); booksLockRights() only shapes the screen.
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
import { toastError } from "@/lib/errors/toast-error";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";

const KEY = ["books-lock"] as const;

export type BooksLockRights = {
  /** May set the lock or move it forward. */
  canLock: boolean;
  /** May clear the lock or move it to an earlier date. */
  canUnlock: boolean;
  /** Earliest date this role may pick (the current lock, for the accountant), or null. */
  minDate: string | null;
};

/** Who may change the books lock — the same rule as set_books_lock() in the database. */
export function booksLockRights(role: string | null | undefined, current: string | null): BooksLockRights {
  if (role === "owner") return { canLock: true, canUnlock: true, minDate: null };
  if (role === "accountant") return { canLock: true, canUnlock: false, minDate: current };
  return { canLock: false, canUnlock: false, minDate: null };
}

type SetBooksLockRpc = (fn: "set_books_lock", args: { p_until: string | null }) => PromiseLike<{ error: { message: string } | null }>;

/** Sets (or, for the owner, clears) the lock through set_books_lock() and refreshes every reader. */
export function useSetBooksLock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (until: string | null) => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as SetBooksLockRpc;
      const { error } = await rpc.call(supabase, "set_books_lock", { p_until: until });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["month-close"] });
      qc.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not change the books lock" }),
  });
}

export function useBooksLock() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<string | null> => {
      /* RLS returns only this company's row. */
      const { data, error } = await createClient().from("tenants").select("books_locked_until").limit(1).maybeSingle();
      if (error) throw error;
      return (data as { books_locked_until?: string | null } | null)?.books_locked_until ?? null;
    },
    staleTime: 60_000,
  });
}

export function BooksLockCard() {
  const lock = useBooksLock();
  const update = useSetBooksLock();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const [draft, setDraft] = React.useState<string>("");
  React.useEffect(() => { if (lock.data !== undefined) setDraft(lock.data ?? ""); }, [lock.data]);

  const today = istToday();
  const current = lock.data ?? null;
  const rights = booksLockRights(me?.role, current);
  const movesBack = !!draft && !!current && draft < current;

  async function save(next: string | null) {
    const ok = await confirm({
      title: next ? `Lock books up to ${formatDate(next)}?` : "Remove the lock?",
      body: next
        ? "No entry up to that date (expense, bank line, salary, tax, invoice, payment) can be changed or deleted in the app. Do this after your returns are filed."
        : "Older entries can be changed again. If an entry in an already-filed month changes, the return and the books will no longer match.",
      confirmLabel: next ? "Lock books" : "Remove lock", cancelLabel: "Cancel",
    });
    if (!ok) return;
    update.mutate(next);
  }

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Icon name="lock" size={14} className={current ? "text-emerald" : "text-ink-3"} />
            Books lock (period close)
          </p>
          <p className="text-xs text-ink-2 mt-0.5">
            {lock.isLoading ? "…" : current
              ? <>Books are locked up to <b>{formatDate(current)}</b> — entries up to that date cannot be changed in the app.</>
              : <>No lock yet. After filing GSTR-3B / TDS returns, lock up to the last day of that month so the books and the return stay the same.</>}
          </p>
        </div>
        {rights.canLock ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Input type="date" value={draft} min={rights.minDate ?? undefined} max={today} onChange={(e) => setDraft(e.target.value)} className="w-[170px]" aria-label="Lock till" />
            <Button size="sm" disabled={!draft || draft === (current ?? "") || (movesBack && !rights.canUnlock) || update.isPending} onClick={() => save(draft)}>Lock books</Button>
            {current && rights.canUnlock && <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => save(null)}>Remove lock</Button>}
            {current && !rights.canUnlock && <span className="text-xs text-ink-3">Only the owner can remove the lock</span>}
          </div>
        ) : (
          <span className="text-xs text-ink-3">Only the owner or an accountant can change this</span>
        )}
      </div>
    </Card>
  );
}
