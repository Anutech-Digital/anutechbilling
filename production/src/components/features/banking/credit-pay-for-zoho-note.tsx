"use client";

/**
 * R-2518 — under the Reconcile sheet's sale form: a bank receipt that paid SEVERAL Zoho invoices is
 * booked as one app invoice per Zoho invoice. Says which, for how much, and what stays due.
 */
import { rupee } from "@/lib/utils";
import type { ZohoSheetSales } from "@/lib/banking/zoho-sales-split";

export function ZohoSalesNote({ zoho, problem }: { zoho: ZohoSheetSales; problem: string | null }) {
  const { sales, plan } = zoho;
  return (
    <div aria-label="One app invoice per Zoho invoice" className="rounded-md border border-hairline bg-paper p-2.5 space-y-1">
      <p className="text-xs font-medium text-ink">One app invoice per Zoho invoice</p>
      <ul className="text-xs text-ink-2 space-y-0.5">
        {sales.map((s, k) => (
          <li key={s.group.externalNumber} className="break-words tabular-nums">
            Zoho {s.group.externalNumber}: {s.group.lines.length} line{s.group.lines.length === 1 ? "" : "s"}, {rupee(s.total)}
            {plan.amounts[k] < s.total ? ` — ${rupee(plan.amounts[k])} paid now, ${rupee(s.total - plan.amounts[k])} stays due` : ""}
          </li>
        ))}
      </ul>
      {plan.rest === "advance" && <p className="text-xs text-ink-3">The extra money is kept as the customer&apos;s advance.</p>}
      {problem && <p role="alert" className="text-xs text-amber-ink break-words">{problem}</p>}
    </div>
  );
}
