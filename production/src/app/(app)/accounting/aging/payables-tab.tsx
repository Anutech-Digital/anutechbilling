/**
 * R-1921: Aging → Payables — what we owe each vendor, by days past the bill's due date
 * (the bill date when it has none): not due yet, 1–30, 31–60, 61–90, 90+. Net of part payments,
 * TDS and advances already set off (the same "still due" as the Bills / Expenses pages), then
 * the advance still with the vendor and the net. Numbers come from payables_ageing().
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { rupee } from "@/lib/utils";
import { PAYABLE_BUCKETS, PAYABLE_BUCKET_LABEL, payablesTotals, type PayableBucket } from "@/lib/accounting/vendor-statement";
import { usePayablesAgeing } from "@/lib/queries/vendor-statement";

const tone = (k: PayableBucket, v: number) =>
  v <= 0 ? "text-ink-3" : k === "d90_plus" ? "text-rose" : k === "d31_60" || k === "d61_90" ? "text-amber-ink" : "text-ink-2";

const vendorHref = (name: string) => `/accounting/vendors?q=${encodeURIComponent(name)}`;

export function PayablesTab() {
  const q = usePayablesAgeing();
  if (q.isLoading) return <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (q.isError || !q.data) return <LoadError what="Payables aging" error={q.error} onRetry={() => void q.refetch()} />;
  const rows = q.data;
  const t = payablesTotals(rows);
  const overdue = t.d1_30 + t.d31_60 + t.d61_90 + t.d90_plus;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 md:gap-4 mb-6">
        <Kpi label="We owe vendors" value={rupee(t.total)} tone={t.total > 0 ? "text-rose" : "text-ink"} />
        {PAYABLE_BUCKETS.map((k) => <Kpi key={k} label={PAYABLE_BUCKET_LABEL[k]} value={rupee(t[k])} tone={tone(k, t[k])} />)}
      </div>
      {t.advance > 0 && (
        <p className="text-sm text-ink-2 mb-4">
          Advance with vendors, not yet set off: <b>{rupee(t.advance)}</b> · net payable <b>{rupee(t.net)}</b>
        </p>
      )}

      {rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="check_circle" title="No unpaid vendor bills" body="Every vendor bill is paid or set off against an advance." />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm min-w-[880px]">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-3 py-3">Vendor</th>
                {PAYABLE_BUCKETS.map((k) => <th key={k} className="text-right px-3 py-3 whitespace-nowrap">{PAYABLE_BUCKET_LABEL[k]}</th>)}
                <th className="text-right px-3 py-3">Total</th>
                <th className="text-right px-3 py-3">Advance</th>
                <th className="text-right px-3 py-3">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((r) => (
                <tr key={r.vendor_id ?? r.vendor_name} className="hover:bg-paper-2/40">
                  <td className="px-3 py-3">
                    <Link href={vendorHref(r.vendor_name) as Route} className="font-medium text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm">{r.vendor_name}</Link>
                    {r.bills > 0 && (
                      <div className="mt-0.5">
                        <Badge color={r.oldest_days > 90 ? "rose" : r.oldest_days > 30 ? "amber" : "slate"}>
                          {r.oldest_days > 0 ? `${r.oldest_days} days overdue` : "not due yet"}
                        </Badge>
                      </div>
                    )}
                  </td>
                  {PAYABLE_BUCKETS.map((k) => (
                    <td key={k} className={`px-3 py-3 text-right font-mono ${tone(k, r[k])}`}>{r[k] > 0 ? rupee(r[k]) : "—"}</td>
                  ))}
                  <td className="px-3 py-3 text-right font-mono font-semibold text-ink">{rupee(r.total)}</td>
                  <td className="px-3 py-3 text-right font-mono text-emerald">{r.advance > 0 ? rupee(r.advance) : "—"}</td>
                  <td className={`px-3 py-3 text-right font-mono font-semibold ${r.net > 0 ? "text-rose" : r.net < 0 ? "text-emerald" : "text-ink"}`}>
                    {r.net < 0 ? `${rupee(-r.net)} adv` : rupee(r.net)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-paper-2/30 border-t-2 border-ink">
              <tr>
                <td className="px-3 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total</td>
                {PAYABLE_BUCKETS.map((k) => <td key={k} className="px-3 py-3 text-right font-mono text-ink">{rupee(t[k])}</td>)}
                <td className="px-3 py-3 text-right font-mono font-semibold text-ink">{rupee(t.total)}</td>
                <td className="px-3 py-3 text-right font-mono text-emerald">{rupee(t.advance)}</td>
                <td className="px-3 py-3 text-right font-mono font-semibold text-ink">{t.net < 0 ? `${rupee(-t.net)} adv` : rupee(t.net)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
      {overdue > 0 && (
        <p className="text-xs text-ink-3 mt-3">
          {rupee(overdue)} is past its due date. Pay it from Banking (the payment line) or a payment run.
        </p>
      )}
    </>
  );
}

function Kpi({ label, value, tone: cls }: { label: string; value: string; tone: string }) {
  return (
    <Card className="min-w-0 p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-lg sm:text-xl ${cls} leading-tight tabular-nums break-words`}>{value}</div>
    </Card>
  );
}
