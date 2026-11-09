/**
 * R-2621 (G-FY2526 D2 + D7) — GST returns filed up to: the last month whose GST returns the company has
 * filed (Excel: September 2026). One per company, set by the OWNER on Accounting → Overview, next to
 * Books start. The database decides through set_gst_filed_through() (migration 20261109071722): owner
 * only, never a month that has not ended, stored as the month's last day, one activity-log row per
 * change. Reconcile from Zoho reads it (with the books lock and GSTR-1 marked filed — gst_month_filed):
 * a bank line of a filed month never becomes a new sale. Anyone else sees it.
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
import { istToday } from "@/lib/dates/ist";
import { latestFilableMonth, monthEndOf, monthName, monthOf } from "@/lib/accounting/gst-filed";

const KEY = ["gst-filed-through"] as const;

/** The stored month end (null = not set). A database without the column reads as not set. */
export function useGstFiledThrough() {
  const tenantId = useCurrentUser().data?.tenantId ?? null;
  return useQuery({
    queryKey: [...KEY, tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient().from("tenants").select("gst_filed_through").eq("id", tenantId!).limit(1).maybeSingle();
      if (error) {
        if (error.code === "42703" || /column .*gst_filed_through.* does not exist/i.test(error.message ?? "")) return null;
        throw error;
      }
      const v = (data as { gst_filed_through?: string | null } | null)?.gst_filed_through ?? null;
      return v ? v.slice(0, 10) : null;
    },
    staleTime: 60_000,
  });
}

type SetRpc = (fn: "set_gst_filed_through", args: { p_month: string | null }) => PromiseLike<{ error: { message: string } | null }>;

export function useSetGstFiledThrough() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (monthEnd: string | null) => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as SetRpc;
      const { error } = await rpc.call(supabase, "set_gst_filed_through", { p_month: monthEnd });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); },
    onError: (e) => toastError(e, { fallback: "Could not save the GST filed month" }),
  });
}

export function GstFiledThroughCard() {
  const q = useGstFiledThrough();
  const save = useSetGstFiledThrough();
  const confirm = useConfirm();
  const isOwner = useCurrentUser().data?.role === "owner";
  const current = q.data ?? null;
  const [draft, setDraft] = React.useState("");
  React.useEffect(() => { if (q.data !== undefined) setDraft(monthOf(q.data)); }, [q.data]);
  const maxMonth = latestFilableMonth(istToday());
  const draftEnd = monthEndOf(draft);

  async function submit(next: string | null) {
    const ok = await confirm({
      title: next ? `GST returns filed up to ${monthName(next)}?` : "Clear the GST filed month?",
      body: next
        ? `Reconcile from Zoho will not book a new sale on a bank line dated up to ${monthName(next)} — it pays the Zoho invoice imported into the app instead.`
        : "Months are then filed only when the books are locked or GSTR-1 is marked filed.",
      confirmLabel: next ? "Save" : "Clear", cancelLabel: "Cancel",
    });
    if (ok) save.mutate(next);
  }

  return (
    <Card className="mb-4 p-4" data-testid="gst-filed-through-card">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Icon name="receipt" size={14} className={current ? "text-emerald" : "text-ink-3"} />
            GST returns filed up to
          </p>
          <p className="text-xs text-ink-2 mt-0.5" data-testid="gst-filed-through-text">
            {q.isError ? <span className="text-rose">Could not load the GST filed month. Reload the page.</span>
              : q.data === undefined ? "…"
              : current ? <>GST returns are filed up to <b>{monthName(current)}</b>. A bank line of those months is never booked as a new sale.</>
              : <>Not set. Pick the last month whose GST returns you have filed.</>}
          </p>
        </div>
        {isOwner ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Input type="month" value={draft} max={maxMonth} onChange={(e) => setDraft(e.target.value)} className="w-[170px]" aria-label="GST returns filed up to (month)" />
            <Button size="sm" disabled={q.data === undefined || !draftEnd || draftEnd === current || draft > maxMonth || save.isPending} onClick={() => submit(draftEnd)}>Save</Button>
            {current && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => submit(null)}>Clear</Button>}
          </div>
        ) : (
          <span className="text-xs text-ink-3">Only the owner can change this</span>
        )}
      </div>
    </Card>
  );
}
