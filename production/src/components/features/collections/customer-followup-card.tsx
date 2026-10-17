/**
 * R-1517 — "Payment follow-up" card on the customer page: what they owe, the promise and next
 * follow-up, the full history (newest first, broken promises red) and an "Add follow-up" button
 * that opens the same dialog as /collections. Shown only to roles that can open Payment
 * Follow-up (nav.ts) — the others cannot read payment_followups anyway (R-1515 RLS).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { canOpenRoute } from "@/lib/nav";
import { istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";
import { buildFollowupHistory } from "@/lib/collections/followup-rules";
import { useCustomerCollection } from "@/lib/queries/collections";
import { useCustomerFollowups, useCustomerOwner } from "@/lib/queries/payment-followups";
import { FollowupDialog } from "./followup-dialog";
import { FollowupHistory } from "./followup-history";

export function CustomerFollowupCard({ customerId, customerName }: { customerId: string; customerName: string }) {
  const { data: me } = useCurrentUser();
  const allowed = canOpenRoute(me?.role ?? null, "/collections");
  const row = useCustomerCollection(allowed ? customerId : null);
  const owner = useCustomerOwner(allowed ? customerId : null);
  const history = useCustomerFollowups(allowed ? customerId : null);
  const { data: names } = useUserNames();
  const [open, setOpen] = React.useState(false);

  const stillOwes = (row.data?.amountDue ?? 0) > 0;
  const entries = React.useMemo(() => buildFollowupHistory(history.data ?? [], istToday(), stillOwes), [history.data, stillOwes]);
  if (!allowed) return null;

  const r = row.data;
  return (
    <Card
      title="Payment follow-up"
      sub={r ? `${rupee(r.amountDue)} due` : row.isLoading ? undefined : "Nothing owed right now"}
      actions={<Button size="sm" variant="primary" icon="plus" onClick={() => setOpen(true)}>Add follow-up</Button>}
    >
      {r && (r.promisedOn || r.nextFollowUpOn) && (
        <div className="flex flex-wrap gap-1.5 mb-3 text-sm">
          {r.promisedOn && (
            <Badge kind={r.promiseBroken ? "danger" : "info"} dot>
              {r.promiseBroken ? "Promise broken" : "Promised"} · {formatDate(r.promisedOn)}
              {r.promisedAmount ? ` · ${rupee(r.promisedAmount)}` : ""}
            </Badge>
          )}
          {r.nextFollowUpOn && (
            <Badge kind={r.followUpDue ? "warning" : "muted"}>Next follow-up {formatDate(r.nextFollowUpOn)}</Badge>
          )}
        </div>
      )}
      <FollowupHistory
        entries={entries}
        names={names}
        isLoading={history.isLoading}
        isError={history.isError}
        onRetry={() => { void history.refetch(); }}
        limit={5}
      />
      <p className="mt-3 text-xs text-ink-3">
        Everyone who owes money, in one list:{" "}
        <Link href="/collections" className="text-ink underline underline-offset-2">Payment Follow-up</Link>
      </p>
      <FollowupDialog
        open={open}
        onOpenChange={setOpen}
        customerId={customerId}
        customerName={r?.customerName ?? customerName}
        ownerId={r?.ownerId ?? owner.data ?? null}
        items={r?.items ?? []}
        stillOwes={stillOwes}
        amountDue={r?.amountDue}
      />
    </Card>
  );
}
