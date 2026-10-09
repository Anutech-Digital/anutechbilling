/**
 * R-116 — write-off suggestions on Accounting > Aging.
 *
 * Invoices more than 180 days overdue with money still owed. "Suggest write-off" only
 * creates a DRAFT (suggest_invoice_write_off); the owner confirms or dismisses it
 * (decide_invoice_write_off, owner-only in the database). Neither step changes the invoice
 * or posts an accounting entry — the bad-debt entry stays the accountant's call.
 */
"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { WRITE_OFF_AFTER_DAYS, writeOffCandidates } from "@/lib/collections/overdue-suspension";

const KEY = ["collections", "write-off"] as const;

interface Row {
  invoiceId: string;
  customerName: string;
  amountDue: number;
  daysOverdue: number;
  draft: { id: string; status: string } | null;
}

function useWriteOffRows() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Row[]> => {
      const supabase = createClient();
      const today = istToday();
      const { data: invoices, error } = await supabase
        .from("invoices")
        .select("id, customer_name, amount, net_payable, paid_amount, status, due_date")
        .in("status", ["pending", "overdue"])
        .lt("due_date", addDaysISO(today, -WRITE_OFF_AFTER_DAYS))
        .order("due_date", { ascending: true })
        .limit(500);
      if (error) throw error;
      const cands = writeOffCandidates(invoices ?? [], today);
      if (cands.length === 0) return [];
      const { data: drafts, error: dErr } = await supabase
        .from("invoice_write_off_drafts")
        .select("id, invoice_id, status, created_at")
        .in("invoice_id", cands.map((c) => c.invoiceId))
        .order("created_at", { ascending: false });
      if (dErr) throw dErr;
      const latest = new Map<string, { id: string; status: string }>();
      for (const d of drafts ?? []) if (!latest.has(d.invoice_id)) latest.set(d.invoice_id, { id: d.id, status: d.status });
      const names = new Map((invoices ?? []).map((i) => [i.id, i.customer_name]));
      return cands.map((c) => ({
        ...c,
        customerName: names.get(c.invoiceId) ?? "—",
        draft: latest.get(c.invoiceId) ?? null,
      }));
    },
  });
}

export function WriteOffSuggestionsCard() {
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const q = useWriteOffRows();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });

  const suggest = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await createClient().rpc("suggest_invoice_write_off", { p_invoice_id: invoiceId });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Write-off draft created. The owner confirms it."); refresh(); },
    onError: (e: Error) => toastError(e, {
      fallback: "Draft not created.",
      description: "Nothing changed. Refresh the page and try again.",
    }),
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; decision: "confirmed" | "dismissed" }) => {
      const { error } = await createClient().rpc("decide_invoice_write_off", { p_draft_id: v.id, p_decision: v.decision });
      if (error) throw error;
    },
    onSuccess: (_d, v) => { toast.success(v.decision === "confirmed" ? "Write-off confirmed" : "Suggestion dismissed"); refresh(); },
    onError: (e: Error) => toastError(e, {
      fallback: "Not saved.",
      description: "Only the owner can confirm or dismiss. Refresh the page and try again.",
    }),
  });

  return (
    <Card className="p-4 md:p-5 mt-8">
      <div className="mb-3">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Collections</p>
        <h2 className="font-serif text-xl">Write-off suggestions</h2>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          Invoices more than {WRITE_OFF_AFTER_DAYS} days overdue. Suggesting makes a draft only; the owner confirms.
          A confirmed write-off is a record for your accountant — the invoice itself is not changed.
        </p>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : q.isError ? (
        <LoadError what="Write-off suggestions" onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-ink-3">No invoice is more than {WRITE_OFF_AFTER_DAYS} days overdue.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {(q.data ?? []).map((r) => (
            <li key={r.invoiceId} className="py-2 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="font-medium text-ink">{r.customerName}</div>
                <div className="text-xs text-ink-3">
                  <Link href={invoiceHref(r.invoiceId)} className="underline">Open invoice {r.invoiceId}</Link>
                  {" · "}{r.daysOverdue} days overdue
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{rupee(r.amountDue)}</span>
                {r.draft?.status === "confirmed" ? (
                  <Badge kind="muted">Write-off confirmed</Badge>
                ) : r.draft?.status === "draft" ? (
                  <>
                    <Badge kind="info">Draft</Badge>
                    {isOwner && (
                      <>
                        <Button size="sm" variant="primary" disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: r.draft!.id, decision: "confirmed" })}>
                          Confirm
                        </Button>
                        <Button size="sm" variant="ghost" disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: r.draft!.id, decision: "dismissed" })}>
                          Dismiss
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={suggest.isPending}
                    onClick={() => suggest.mutate(r.invoiceId)}>
                    Suggest write-off
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
