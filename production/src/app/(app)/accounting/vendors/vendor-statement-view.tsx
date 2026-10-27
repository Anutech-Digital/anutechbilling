/**
 * R-1921: the vendor popup's Statement tab — every bill, TDS, payment, advance and set-off,
 * dated, with the running balance. The rows and their amounts come from vendor_statement()
 * (they add up to the balance shown above the tabs, and to the Balance Sheet).
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { rupee, formatDate } from "@/lib/utils";
import { closingWords } from "@/lib/accounting/vendor-statement";
import { useVendorStatement } from "@/lib/queries/vendor-statement";

/** Signed balance: "₹20,000" we owe, "₹4,000 adv" the vendor holds our money. */
function balanceText(b: number): string {
  return b < 0 ? `${rupee(-b)} adv` : rupee(b);
}

export function VendorStatementView({ vendorId }: { vendorId: string }) {
  const q = useVendorStatement(vendorId);
  if (q.isLoading) return <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (q.isError || !q.data) return <LoadError what="Statement" error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  if (s.lines.length === 0) return <p className="text-sm text-ink-3 px-1 py-4 text-center">No bills, payments or advances for this vendor yet.</p>;

  return (
    <div>
      <table className="w-full text-sm" aria-label="Vendor statement">
        <thead className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
          <tr className="border-b border-hairline">
            <th className="text-left font-semibold py-1.5 pr-2 w-[72px]">Date</th>
            <th className="text-left font-semibold py-1.5 pr-2">Particulars</th>
            <th className="text-right font-semibold py-1.5 pr-2 w-[88px]">Billed</th>
            <th className="text-right font-semibold py-1.5 pr-2 w-[88px]">Paid</th>
            <th className="text-right font-semibold py-1.5 w-[96px]">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {s.lines.map((l) => (
            <tr key={l.key} className={l.kind === "adjustment" ? "bg-amber-soft/40" : undefined}>
              <td className="py-2 pr-2 text-xs text-ink-3 whitespace-nowrap align-top">{formatDate(l.date)}</td>
              <td className="py-2 pr-2 text-ink align-top">
                {l.href ? <Link href={l.href as Route} className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm">{l.particulars}</Link> : l.particulars}
                {l.setOff > 0 && <span className="block text-xs text-ink-3">{rupee(l.setOff)} of the advance used — no money moved</span>}
              </td>
              <td className="py-2 pr-2 text-right font-mono align-top">{l.billed > 0 ? rupee(l.billed) : ""}</td>
              <td className="py-2 pr-2 text-right font-mono align-top">{l.paid > 0 ? rupee(l.paid) : ""}</td>
              <td className={`py-2 text-right font-mono align-top whitespace-nowrap ${l.balance > 0 ? "text-rose" : l.balance < 0 ? "text-emerald" : "text-ink-3"}`}>{balanceText(l.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-ink">
            <td colSpan={2} className="py-2 pr-2 text-xs font-semibold text-ink">Closing balance · {closingWords(s.closing)}</td>
            <td className="py-2 pr-2 text-right font-mono text-ink-3">{rupee(s.billed)}</td>
            <td className="py-2 pr-2 text-right font-mono text-ink-3">{rupee(s.paid)}</td>
            <td className={`py-2 text-right font-mono font-semibold whitespace-nowrap ${s.closing > 0 ? "text-rose" : s.closing < 0 ? "text-emerald" : "text-ink"}`}>{balanceText(s.closing)}</td>
          </tr>
        </tfoot>
      </table>
      {s.adjustments > 0 && (
        <p className="mt-2 text-xs text-amber-ink">
          The highlighted row is money the bills show as paid with no matching payment entry. Check that bill&apos;s payments.
        </p>
      )}
    </div>
  );
}
