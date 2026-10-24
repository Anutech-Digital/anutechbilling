/**
 * R-1433: the subscription(s) this invoice belongs to, on /invoices/[id] — plan, status, term,
 * renewal date and "Open subscription" (the drawer on /subscriptions). Pardeep, 12 Oct: an
 * invoice raised from a subscription quote gave no way to reach the subscription.
 *
 * Nothing renders when the invoice has no subscription, or for a role that cannot open
 * /subscriptions (the accountant): a link it cannot follow is worse than no card.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import { fetchInvoiceSubscriptions, linkedSubscriptionView } from "@/lib/invoices/linked-subscriptions";

const STATUS_KIND: Record<string, "success" | "warning" | "danger" | "muted"> = {
  Active: "success", Trial: "warning", Suspended: "warning", Expired: "danger", Cancelled: "muted",
};

export function InvoiceSubscriptionCard({ invoiceId, quoteIds }: { invoiceId: string; quoteIds: ReadonlyArray<string | null | undefined> }) {
  const role = useCurrentUser().data?.role;
  const allowed = !!role && canOpenRoute(role, "/subscriptions");
  const ids = [...new Set(quoteIds.filter((q): q is string => !!q))].sort();
  /* Under ["invoices"] like the page's own read, so an invoice mutation refreshes it too. */
  const { data } = useQuery({
    queryKey: ["invoices", "subscriptions", invoiceId, ids.join(",")],
    enabled: allowed && invoiceId.length > 0,
    queryFn: () => fetchInvoiceSubscriptions(createClient(), { invoiceId, quoteIds: ids }),
  });

  if (!allowed || !data || data.length === 0) return null;
  const views = data.map(linkedSubscriptionView);

  return (
    <Card className="overflow-hidden" data-testid="invoice-subscription-card">
      <div className="px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center gap-2 font-semibold text-xs text-ink">
        <Icon name="refresh" size={14} className="text-ink-3" />
        <span>{views.length === 1 ? "Subscription" : `Subscriptions (${views.length})`}</span>
      </div>
      <ul className="divide-y divide-hairline/60">
        {views.map((v) => (
          <li key={v.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{v.plan}</span>
                {v.status && <Badge kind={STATUS_KIND[v.status] ?? "muted"} size="sm">{v.status}</Badge>}
              </div>
              <p className="text-ink-3 break-all">{v.subtitle}</p>
              <p className="text-ink-2">
                <span className="text-ink-3">Term:</span> {v.term ?? "—"}
                <span className="mx-1.5 text-ink-3">·</span>
                <span className="text-ink-3">Renews:</span> {v.renewalDate ? formatDate(v.renewalDate) : "—"}
              </p>
            </div>
            <Button asChild size="sm" variant="outline" icon="arrow_right">
              <Link href={v.href as never}>Open subscription</Link>
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
