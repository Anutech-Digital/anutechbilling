/**
 * R-116 — "Auto-pause on overdue": the per-company switch + limit, and the list of
 * subscriptions the app paused for non-payment. Lives on Accounting > Aging, next to the
 * money it is about. Only the owner can change the setting (tenants RLS: owner-only update).
 *
 * The work itself is done by /api/cron/invoice-dunning (lib/collections/overdue-suspension*).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { formatDate } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { DEFAULT_SUSPEND_DAYS, NOTICE_GRACE_DAYS, suspendThreshold } from "@/lib/collections/overdue-suspension";

const KEY = ["collections", "overdue-pause"] as const;

interface PausedSub {
  id: string;
  customer_name: string;
  plan: string;
  domain: string | null;
  suspended_at: string | null;
  suspend_reason: string | null;
  suspended_invoice_id: string | null;
}

function useOverduePause(tenantId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const supabase = createClient();
      const [t, s] = await Promise.all([
        supabase.from("tenants").select("auto_suspend_on_overdue, overdue_suspend_days").eq("id", tenantId!).maybeSingle(),
        supabase.from("subscriptions")
          .select("id, customer_name, plan, domain, suspended_at, suspend_reason, suspended_invoice_id")
          .eq("status", "paused").eq("suspended_by", "automation")
          .order("suspended_at", { ascending: false }).limit(100),
      ]);
      if (t.error) throw t.error;
      if (s.error) throw s.error;
      return {
        enabled: t.data?.auto_suspend_on_overdue ?? false,
        days: suspendThreshold(t.data?.overdue_suspend_days),
        paused: (s.data ?? []) as PausedSub[],
      };
    },
  });
}

export function OverduePauseCard() {
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const q = useOverduePause(me?.tenantId);
  const qc = useQueryClient();
  const [daysText, setDaysText] = React.useState<string>("");

  React.useEffect(() => {
    if (q.data) setDaysText(String(q.data.days));
  }, [q.data]);

  const save = useMutation({
    mutationFn: async (patch: { auto_suspend_on_overdue?: boolean; overdue_suspend_days?: number }) => {
      const supabase = createClient();
      const { data, error } = await supabase.from("tenants").update(patch).eq("id", me!.tenantId).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("Only the owner can change this setting.");
    },
    onSuccess: () => {
      toast.success("Saved");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toastError(e, {
      fallback: "Setting not saved.",
      description: "Nothing changed. Check you are signed in as the owner and try again.",
    }),
  });

  const daysNum = Number(daysText);
  const daysValid = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365;
  const daysChanged = q.data ? daysValid && daysNum !== q.data.days : false;

  return (
    <Card className="p-4 md:p-5 mt-8">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Collections</p>
          <h2 className="font-serif text-xl">Auto-pause on overdue</h2>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Pause a subscription when its invoice is unpaid for too long. The customer gets a final notice
            {" "}{NOTICE_GRACE_DAYS} days before. Paying the invoice turns it back on. Only the status in this app
            changes — nothing at Google or Microsoft.
          </p>
        </div>
        {q.data && (
          <div className="flex items-center gap-2">
            <Switch
              id="overdue-pause-switch"
              aria-label="Auto-pause on overdue"
              checked={q.data.enabled}
              disabled={!isOwner || save.isPending}
              onCheckedChange={(v) => save.mutate({ auto_suspend_on_overdue: v })}
            />
            <label htmlFor="overdue-pause-switch" className="text-sm font-medium">
              {q.data.enabled ? "On" : "Off"}
            </label>
          </div>
        )}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : q.isError ? (
        <LoadError what="Auto-pause setting" onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label htmlFor="overdue-pause-days" className="block text-xs text-ink-3 mb-1">
                Pause after (days overdue)
              </label>
              <Input
                id="overdue-pause-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                className="w-28"
                value={daysText}
                disabled={!isOwner}
                onChange={(e) => setDaysText(e.target.value)}
              />
            </div>
            {isOwner && (
              <Button
                size="sm"
                variant="outline"
                disabled={!daysChanged || save.isPending}
                onClick={() => save.mutate({ overdue_suspend_days: daysNum })}
              >
                Save
              </Button>
            )}
            <p className="text-xs text-ink-3 pb-2">
              {daysValid ? `Notice on day ${Math.max(1, daysNum + 1 - NOTICE_GRACE_DAYS)}, pause on day ${daysNum + 1}.` : "Enter 1 to 365."}
              {" "}Default {DEFAULT_SUSPEND_DAYS}.
            </p>
          </div>
          {!isOwner && <p className="text-xs text-ink-3 mt-2">Only the owner can change this.</p>}

          <h3 className="text-sm font-semibold mt-5 mb-2">Paused for non-payment ({q.data.paused.length})</h3>
          {q.data.paused.length === 0 ? (
            <p className="text-sm text-ink-3">None.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {q.data.paused.map((s) => (
                <li key={s.id} className="py-2 flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{s.customer_name}</div>
                    <div className="text-xs text-ink-3">
                      {s.plan}{s.domain ? ` · ${s.domain}` : ""}
                      {s.suspended_at ? ` · paused ${formatDate(s.suspended_at)}` : ""}
                    </div>
                    {s.suspend_reason && <div className="text-xs text-ink-2 mt-0.5">{s.suspend_reason}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge kind="warning">Paused</Badge>
                    {s.suspended_invoice_id && (
                      <Link href={invoiceHref(s.suspended_invoice_id)} className="text-xs underline">
                        Open invoice {s.suspended_invoice_id}
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Card>
  );
}
