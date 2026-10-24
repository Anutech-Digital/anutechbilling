/**
 * MSME payables — s.43B(h) ka 45-din flag, Customer Aging ke neeche (payables ka aging).
 *
 * Micro/small vendor ka bill 45 din (likhit agreement na ho to 15) se zyada bakaya raha to
 * us FY me wo kharcha deduction me nahi milta. Isliye yahan sirf wahi bills jinke vendor par
 * Udyam number hai (msme_payables_aging, migration 20260928120000). Koi vendor Udyam wala hi
 * nahi to card ye kehta hai — "sab theek" nahi, kyunki shayad Udyam bhara hi nahi gaya.
 */
"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadErrorInline } from "@/components/shared/load-error";
import { rupee, formatDate } from "@/lib/utils";
import { useMsmePayables } from "@/lib/queries/day-book";
import { msmeSummary, MSME_LIMIT_DAYS, MSME_LIMIT_DAYS_NO_AGREEMENT } from "@/lib/accounting/msme";

export function MsmePayablesCard() {
  const q = useMsmePayables();
  const rows = q.data ?? [];
  const s = msmeSummary(rows);

  return (
    <Card className="p-4 md:p-5 mt-8">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payables · MSME</p>
          <h2 className="font-serif text-xl">MSME vendors — 45-day rule (s.43B(h))</h2>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            A micro / small vendor's bill not paid within {MSME_LIMIT_DAYS} days ({MSME_LIMIT_DAYS_NO_AGREEMENT} days without a written agreement)
            cannot be deducted from this year's profit — the tax goes up. Pay before 31 March.
          </p>
        </div>
        {rows.length > 0 && (
          <div className="text-right">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Past {MSME_LIMIT_DAYS} days</div>
            <div className={`font-serif text-2xl ${s.overDue > 0 ? "text-rose" : "text-ink"}`}>{rupee(s.overDue)}</div>
            <div className="text-xs text-ink-3">of {rupee(s.due)} due to MSME vendors</div>
          </div>
        )}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : q.error ? (
        <LoadErrorInline what="MSME payables" error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-3">
          No unpaid bills from Udyam-registered vendors. Vendors that are MSME but have no Udyam number
          entered do not show here —{" "}
          add the Udyam number and category under <Link href="/accounting/vendors" className="underline">Vendors</Link>.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr className="border-b border-hairline">
                <th className="text-left py-2 pr-3">Vendor</th>
                <th className="text-left py-2 pr-3">Bill</th>
                <th className="text-left py-2 pr-3">Bill date</th>
                <th className="text-left py-2 pr-3">Pay by</th>
                <th className="text-right py-2 pr-3">Days</th>
                <th className="text-right py-2">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((r) => (
                <tr key={`${r.source}-${r.doc_id}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-ink">{r.vendor_name}</div>
                    <div className="text-xs text-ink-3 font-mono">
                      {r.udyam}{r.msme_category ? ` · ${r.msme_category}` : " · category not set — treated as covered"}
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.bill_ref}</td>
                  <td className="py-2 pr-3">{formatDate(r.bill_date)}</td>
                  <td className="py-2 pr-3">{formatDate(r.deadline)}</td>
                  <td className="py-2 pr-3 text-right">
                    <Badge kind={r.over_limit ? "danger" : r.days_outstanding > MSME_LIMIT_DAYS_NO_AGREEMENT ? "warning" : "muted"}>
                      {r.days_outstanding}d{r.over_limit ? " · over" : ""}
                    </Badge>
                  </td>
                  <td className="py-2 text-right font-mono">{rupee(r.amount_due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
