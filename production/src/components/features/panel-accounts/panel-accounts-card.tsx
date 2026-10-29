/**
 * R-2103 — "Customer panel logins" on Hosting & Domains.
 *
 * Every customer who has paid is queued for a customer panel (DMS) account
 * (panel_account_outbox, migration 20261029114000); the panel-accounts cron sends them. This
 * card is where staff see what is stuck:
 *   - "Needs email": the customer has no valid email, so no login can be made. Saving an email
 *     on the customer sends it on the next run by itself.
 *   - "Failed": DMS refused or was unreachable five times. "Try again" queues it once more.
 * And the one-time go-live step (Pardeep, 29 Oct, option a): "Give existing customers a login"
 * counts first (dry run), asks, then queues every active paying customer without a row.
 *
 * The database decides who may do what (panel_account_overview: owner/manager/support;
 * requeue + backfill: owner/manager); canAct only shapes the screen.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { formatDate } from "@/lib/utils";
import { editCustomerHref } from "@/components/features/customers/return-path";

const KEY = ["panel-accounts", "overview"] as const;

export interface PanelAccountOverview {
  counts: { pending: number; done: number; needs_email: number; failed: number };
  attention: { customer_id: string; customer_name: string; status: "needs_email" | "failed"; last_error: string | null; updated_at: string }[];
}

export interface BackfillCount {
  dry_run: boolean;
  with_email: number;
  without_email: number;
  queued: number;
}

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const call = supabase.rpc as unknown as Rpc;
  const { data, error } = await call.call(supabase, fn, args);
  if (error) throw error;
  return data as T;
}

/** Owner and manager may retry and run the backfill — same rule as the SQL. */
export function panelAccountRights(role: string | null | undefined): { canAct: boolean } {
  return { canAct: role === "owner" || role === "manager" };
}

/** The confirm text for the go-live backfill, from its dry-run count. */
export function backfillQuestion(c: BackfillCount): { title: string; body: string } {
  const total = c.with_email + c.without_email;
  return {
    title: `Give ${total} existing customer${total === 1 ? "" : "s"} a panel login?`,
    body:
      `${c.with_email} will get the "Your Customer Portal is ready" email with a one-time password` +
      (c.without_email > 0 ? `; ${c.without_email} have no email and will show under "Needs email"` : "") +
      ". Do this once, after the data transfer. Emails go only while the Customer panel accounts switch is on.",
  };
}

export function PanelAccountsCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const { canAct } = panelAccountRights(me?.role);

  const overview = useQuery({
    queryKey: KEY,
    queryFn: () => rpc<PanelAccountOverview>("panel_account_overview"),
    staleTime: 30_000,
  });

  const retry = useMutation({
    mutationFn: (customerId: string) => rpc<string | null>("requeue_panel_account", { p_customer_id: customerId }),
    onSuccess: (status) => {
      toast.success(status === "needs_email" ? "Still no email on this customer — add one first" : "Queued — sent on the next run");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toastError(e, { fallback: "Could not queue it again" }),
  });

  const backfill = useMutation({
    mutationFn: async () => {
      const count = await rpc<BackfillCount>("queue_panel_account_backfill", { p_dry_run: true });
      if (count.with_email + count.without_email === 0) {
        toast.success("Every paying customer already has a panel login or is queued");
        return null;
      }
      const ok = await confirm({ ...backfillQuestion(count), confirmLabel: "Queue them", cancelLabel: "Cancel" });
      if (!ok) return null;
      return rpc<BackfillCount>("queue_panel_account_backfill", { p_dry_run: false });
    },
    onSuccess: (done) => {
      if (done) toast.success(`${done.queued} customer${done.queued === 1 ? "" : "s"} queued for a panel login`);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toastError(e, { fallback: "Could not queue existing customers" }),
  });

  const c = overview.data?.counts;
  const rows = overview.data?.attention ?? [];

  return (
    <Card title="Customer panel logins" sub="Every customer who pays gets a login to the customer panel">
      {overview.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
      ) : overview.error ? (
        <p className="text-sm text-ink-3">Could not load panel logins. {overview.error instanceof Error ? overview.error.message : null}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge kind="success">{c?.done ?? 0} have a login</Badge>
            <Badge kind="info">{c?.pending ?? 0} waiting</Badge>
            {(c?.needs_email ?? 0) > 0 && <Badge kind="warning">{c?.needs_email} need email</Badge>}
            {(c?.failed ?? 0) > 0 && <Badge kind="danger">{c?.failed} failed</Badge>}
          </div>

          {rows.length > 0 && (
            <ul className="divide-y divide-hairline rounded-md border border-hairline">
              {rows.map((r) => (
                <li key={r.customer_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link href={`/customers/${r.customer_id}`} className="font-medium text-ink hover:underline">
                      {r.customer_name}
                    </Link>
                    <p className="text-xs text-ink-3">
                      {r.status === "needs_email"
                        ? "Needs email — add one to the customer or its primary contact; the login is sent on the next run."
                        : `Failed ${formatDate(r.updated_at)}${r.last_error ? ` — ${r.last_error}` : ""}`}
                    </p>
                  </div>
                  {r.status === "needs_email" ? (
                    <Link href={editCustomerHref(r.customer_id, "/hosting-domains") as never} className="text-xs font-medium text-amber-ink hover:underline">
                      Add email
                    </Link>
                  ) : canAct ? (
                    <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(r.customer_id)}>
                      Try again
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canAct && (
            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              <Button size="sm" variant="ghost" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
                {backfill.isPending ? "Counting…" : "Give existing customers a login"}
              </Button>
              <span className="text-xs text-ink-3">One-time, after the data transfer. Shows the count before anything is queued.</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
