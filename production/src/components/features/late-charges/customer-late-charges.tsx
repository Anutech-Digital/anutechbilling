/**
 * R-530 — late payment charges for a customer (statement tab) or a subscription (its drawer):
 * the Default/On/Off switch for that level and the charges accrued but not yet billed on each
 * of its invoices. The bill and waive actions stay on the invoice page (one invoice at a time)
 * and on Accounting > Aging (the monthly bulk run).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { rupee } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { useLateCharges } from "@/lib/late-charges/queries";
import { LateFeeSwitch } from "./late-fee-switch";

export function LateChargesPreview({ level, id }: { level: "customer" | "subscription"; id: string }) {
  const q = useLateCharges(level === "customer" ? { customerId: id } : { subscriptionId: id });
  const rows = (q.data ?? []).filter((r) => r.view.applies && r.view.toBill > 0);
  const total = rows.reduce((s, r) => s + r.view.toBill, 0);

  return (
    <div className="rounded-md border border-hairline p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-ink">Late payment charges</p>
        {rows.length > 0 && (
          <span className="text-xs text-rose-ink tabular-nums">{rupee(total)} + GST not yet billed</span>
        )}
      </div>
      <LateFeeSwitch level={level} id={id} />
      {q.isLoading ? (
        <Skeleton className="h-10 w-full mt-2" />
      ) : q.isError ? (
        <LoadError what="Late charges" onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-ink-3 mt-2">No late charges building up right now.</p>
      ) : (
        <ul className="mt-2 divide-y divide-hairline">
          {rows.map((r) => (
            <li key={r.invoiceId} className="py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <Link href={invoiceHref(r.invoiceId)} className="underline text-ink">{r.invoiceId}</Link>
              <span className="text-ink-2 tabular-nums">
                {r.view.feeToBill > 0 && `fee ${rupee(r.view.feeToBill)}`}
                {r.view.feeToBill > 0 && r.view.interestToBill > 0 && " + "}
                {r.view.interestToBill > 0 && `interest ${rupee(r.view.interestToBill)} (${r.view.daysLate}d)`}
                {!r.view.interestApplies && " · no interest (unregistered)"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
