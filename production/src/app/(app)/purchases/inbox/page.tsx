/**
 * Purchase Inbox — Amazon (& co.) order emails auto-captured, awaiting review.
 *
 * Each row was parsed from a forwarded order email (webhook + Gemini). NOTHING
 * is in the books yet: the owner reviews and clicks "Add to expenses" (→ a draft
 * expense they can tweak) or "Ignore". Human-in-loop keeps money correct.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate } from "@/lib/utils";
import {
  useInboundPurchases, useImportPurchase, useIgnorePurchase, type InboundPurchase,
} from "@/lib/queries/inbound-purchases";

export default function PurchaseInboxPage() {
  const router = useRouter();
  const { data: pending, isLoading, error, refetch } = useInboundPurchases("pending");
  const importMut = useImportPurchase();
  const ignoreMut = useIgnorePurchase();
  const [busyId, setBusyId] = React.useState<number | null>(null);

  const doImport = async (row: InboundPurchase) => {
    setBusyId(row.id);
    try { await importMut.mutateAsync(row); } finally { setBusyId(null); }
  };
  const doIgnore = async (id: number) => {
    setBusyId(id);
    try { await ignoreMut.mutateAsync(id); } finally { setBusyId(null); }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Purchase Inbox</h1>
          <p className="text-sm text-ink-3 mt-1">
            Order emails auto-captured from Amazon &amp; co. Review, then add to expenses — nothing hits your books until you do.
          </p>
        </div>
        <Button icon="refresh" variant="ghost" onClick={() => refetch()}>Refresh</Button>
      </div>

      {error && (
        <EmptyState icon="alert" title="Could not load" body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
      )}

      {isLoading && (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Card key={i}><Skeleton className="h-20 w-full" /></Card>)}</div>
      )}

      {!isLoading && !error && (pending?.length ?? 0) === 0 && (
        <EmptyState
          icon="cart"
          title="Inbox is empty"
          body="Forward your Amazon order emails here (one-time Gmail filter setup) and each purchase will land here for a quick review."
          action={<Button icon="book" onClick={() => router.push("/settings?tab=integrations" as never)}>Set up email forwarding</Button>}
        />
      )}

      {!isLoading && !error && pending && pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((row) => {
            const gross = Number(row.total) || 0;
            const gst   = Number(row.gst) || 0;
            const busy  = busyId === row.id;
            return (
              <Card key={row.id} className="p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge kind={row.source === "amazon" ? "warning" : "muted"} dot>
                        {row.source === "amazon" ? "Amazon" : "Online"}
                      </Badge>
                      {row.order_id && <span className="font-mono text-[11px] text-ink-3">#{row.order_id}</span>}
                      {row.order_date && <span className="text-[11px] text-ink-3">· {formatDate(row.order_date)}</span>}
                    </div>
                    <p className="text-sm font-medium text-ink truncate">{row.subject || "Order email"}</p>
                    {(row.items?.length ?? 0) > 0 && (
                      <p className="text-xs text-ink-3 mt-1 line-clamp-2">
                        {row.items.map((i) => `${i.qty}× ${i.name}`).join(" · ")}
                      </p>
                    )}
                    {gross === 0 && (
                      <p className="text-[11px] text-rose mt-1 inline-flex items-center gap-1">
                        <Icon name="alert" size={11} /> Amount not read — you can fix it in Expenses after adding.
                      </p>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    <div className="font-serif text-xl tabular-nums">{gross > 0 ? rupee(gross) : "—"}</div>
                    <div className="text-[11px] text-ink-3">{gst > 0 ? `incl. GST ${rupee(gst)}` : "no GST read"}</div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-hairline">
                  <Button size="sm" variant="ghost" icon="x" disabled={busy} onClick={() => doIgnore(row.id)}>Ignore</Button>
                  <Button size="sm" variant="primary" icon="check" loading={busy} onClick={() => doImport(row)}>
                    Add to expenses
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
