/**
 * The quote page's Payment history card — moved out of page.tsx (R-2055: the page was 2,400+
 * lines). R-2055: on a sale quote billed in parts with the first part paid, the line under
 * "Total received" says "Committed for the rest of the year ₹28,674 (3 parts)" — the later parts
 * are payment requests raised on their dates (R-2044), not "Remaining" on this quote.
 */
"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { FeeNetLine } from "@/app/(app)/payments/gateway-fee";
import type { usePaymentsByQuote } from "@/lib/queries/payments";
import { committedLine, type PaidToDate } from "@/lib/quotes/paid-to-date";

type Payment = NonNullable<ReturnType<typeof usePaymentsByQuote>["data"]>[number];

export function PaymentHistoryCard({
  paymentHistory, total, totalReceivedSoFar, canOpenReceipt, onOpenReceipt, committed,
}: {
  paymentHistory: Payment[];
  total: number;
  totalReceivedSoFar: number;
  canOpenReceipt: boolean;
  onOpenReceipt: (p: Payment) => void;
  /** R-2055: paid to date on a quote billed in parts — null otherwise. */
  committed: PaidToDate | null;
}) {
  return (
    <Card title="Payment history" sub={`${paymentHistory.length} payment${paymentHistory.length === 1 ? "" : "s"} · ${rupee(totalReceivedSoFar)} of ${rupee(total)} received`}>
      {/* Phone (S32): six columns pushed the page to 640px wide, so the whole
          quote zoomed out. Under md each payment is one row. */}
      <ul className="md:hidden -mx-1 divide-y divide-hairline">
        {paymentHistory.map((p, idx) => (
          <li key={p.id} className="px-1 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-medium tabular-nums">{rupee(p.amount)}</span>{" "}
                <span className="text-ink-3">· {paymentMethodLabel(p.method)}</span>
              </div>
              {p.status === "received" ? (
                <Badge kind="success" dot>received</Badge>
              ) : (
                <Badge kind="danger" dot>refunded</Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 mt-0.5">
              <div className="text-xs text-ink-3 min-w-0 truncate">
                #{idx + 1} · {formatDate(p.received_at)}
                {p.reference ? <> · <span className="font-mono">{p.reference}</span></> : null}
                <FeeNetLine payment={p} />
              </div>
              {p.status === "received" && canOpenReceipt && (
                <Button size="sm" variant="ghost" icon="file" onClick={() => onOpenReceipt(p)}>
                  Receipt
                </Button>
              )}
            </div>
          </li>
        ))}
        <li className="px-1 pt-2.5 flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Total received</span>
          <span className="text-right">
            <span className="font-serif text-lg tabular-nums text-emerald">{rupee(totalReceivedSoFar)}</span>
            <span className="block text-xs text-ink-3">
              {totalReceivedSoFar >= total ? (
                <span className="text-emerald">✓ Fully paid</span>
              ) : (
                committed ? <>{committedLine(committed)}</> : (
                  <>Remaining <b className="text-amber-ink">{rupee(total - totalReceivedSoFar)}</b></>
                )
              )}
            </span>
          </span>
        </li>
      </ul>
      <div className="hidden md:block overflow-x-auto">
      <table className="w-full">
        <thead className="bg-paper-2 border-b border-hairline">
          <tr>
            <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Date</th>
            <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
            <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Method</th>
            <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Reference</th>
            <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
            <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {paymentHistory.map((p, idx) => (
            <tr key={p.id} className="border-b border-hairline last:border-0">
              <td className="p-3 text-xs text-ink-2">
                <div>{formatDate(p.received_at)}</div>
                <div className="text-3xs text-ink-3">#{idx + 1}</div>
              </td>
              <td className="p-3 text-right tabular-nums text-sm font-medium">
                {rupee(p.amount)}
                <FeeNetLine payment={p} className="font-normal" />
              </td>
              <td className="p-3 text-sm">{paymentMethodLabel(p.method)}</td>
              <td className="p-3 font-mono text-xs text-ink-2 truncate max-w-[180px]">{p.reference ?? "—"}</td>
              <td className="p-3">
                {p.status === "received" ? (
                  <Badge kind="success" dot>received</Badge>
                ) : (
                  <Badge kind="danger" dot>refunded</Badge>
                )}
                {p.receipt_voucher_no && (
                  <div className="text-3xs text-ink-3 font-mono mt-0.5">{p.receipt_voucher_no}</div>
                )}
              </td>
              <td className="p-3 text-right">
                {p.status === "received" && canOpenReceipt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="file"
                    onClick={() => onOpenReceipt(p)}
                    title="GST-compliant receipt voucher"
                  >
                    View
                  </Button>
                ) : (
                  <span className="text-2xs text-ink-3">—</span>
                )}
              </td>
            </tr>
          ))}
          {/* Total row */}
          <tr className="bg-paper-2">
            <td className="p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Total received</td>
            <td className="p-3 text-right font-serif text-lg tabular-nums text-emerald">{rupee(totalReceivedSoFar)}</td>
            <td colSpan={4} className="p-3 text-xs text-ink-3">
              {totalReceivedSoFar >= total ? (
                <span className="text-emerald">✓ Fully paid</span>
              ) : (
                committed ? <>{committedLine(committed)}</> : (
                  <>Remaining <b className="text-amber-ink">{rupee(total - totalReceivedSoFar)}</b></>
                )
              )}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </Card>
  );
}
