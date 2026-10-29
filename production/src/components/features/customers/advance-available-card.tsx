"use client";

/**
 * R-2023: "Advance available ₹X" on the customer page — the customer's open credit (an R-1863
 * bank advance or an earlier overpayment), one line per receipt voucher it came from, with its
 * date and a link to where it was received. It is used on the next bill through Record payment
 * → "Use advance" (the one way; nothing to do here).
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { OpenAdvanceLine } from "@/lib/queries/customer-advances";

export function AdvanceAvailableCard({ total, lines }: { total: number; lines: readonly OpenAdvanceLine[] }) {
  if (total <= 0) return null;
  return (
    <div className="mb-4 rounded-md border border-emerald/30 bg-emerald-soft/40 px-3 py-2.5 text-sm" data-testid="advance-available-card">
      <div className="flex items-center gap-2">
        <Icon name="rupee" size={15} className="text-emerald flex-shrink-0" />
        <span className="text-ink">
          <b>Advance available {rupee(total)}</b>
          <span className="text-ink-3"> — used on their next bill: open the quote or invoice → Record payment → tick “Use advance”.</span>
        </span>
      </div>
      {lines.length > 0 && (
        <ul className="mt-1.5 pl-6 space-y-0.5 text-xs text-ink-2">
          {lines.map((l) => (
            <li key={l.key} className="flex flex-wrap gap-x-2">
              {l.sourceQuoteId ? (
                <Link href={`/quotes/${l.sourceQuoteId}` as never} className="font-mono text-amber-ink hover:underline">
                  {l.receiptVoucherNo ?? l.sourceQuoteId}
                </Link>
              ) : (
                <span className="font-mono">{l.receiptVoucherNo ?? "Credit"}</span>
              )}
              {l.receivedAt && <span>{formatDate(l.receivedAt)}</span>}
              <span className="tabular-nums">{rupee(l.open)} open</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
