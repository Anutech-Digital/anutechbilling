/**
 * R-2323 — the loans set up from an EMI line (emi_purchases.kind = 'loan'), listed on
 * Accounting › Business Loans: lender, amount, EMI, EMIs paid, outstanding principal. "Schedule"
 * opens the same EMI schedule dialog as Assets & EMIs (pay by hand, prepay / close, undo).
 * The rows come from the page (one read for its totals and this list).
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { EmiPurchase } from "@/lib/queries/emi";
import { EmiScheduleDialog } from "@/components/features/accounting/emi-loan-dialogs";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";

/** Interest paid so far on these EMI loans (for the page's "Interest paid" total). */
export function useEmiLoansInterest(ids: string[]): number {
  const q = useQuery({
    queryKey: ["emi-purchases", "interest", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const supabase = createClient();
      const rows = await fetchAllRows((from, to) => supabase
        .from("emi_payments").select("interest_part").in("purchase_id", ids)
        .order("id", { ascending: true }).range(from, to));
      return rows.reduce((s, r) => s + (r.interest_part ?? 0), 0);
    },
  });
  return ids.length > 0 ? (q.data ?? 0) : 0;
}

export function EmiLoansTaken({ loans }: { loans: EmiPurchase[] }) {
  const [scheduleFor, setScheduleFor] = React.useState<string | null>(null);
  const open = scheduleFor ? loans.find((l) => l.id === scheduleFor) : undefined;
  if (loans.length === 0) return null;

  const status = (l: EmiPurchase) => (
    <Badge kind={l.status === "closed" ? "success" : "warning"} dot>{l.status === "closed" ? "Cleared" : "Active"}</Badge>
  );
  const paid = (l: EmiPurchase) => `${l.emisPaid}${l.emi_count ? ` / ${l.emi_count}` : ""}`;

  return (
    <section className="mb-5" aria-labelledby="emi-loans-taken-h">
      <h2 id="emi-loans-taken-h" className="text-sm font-semibold text-ink-2 mb-2">Loans with an EMI schedule</h2>
      <Card className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
            <tr>
              <th className="text-left  px-4 py-3">Lender</th>
              <th className="text-left  px-4 py-3">First EMI</th>
              <th className="text-right px-4 py-3">Loan amount</th>
              <th className="text-right px-4 py-3">EMI</th>
              <th className="text-center px-4 py-3">EMIs paid</th>
              <th className="text-right px-4 py-3">Outstanding</th>
              <th className="text-left  px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {loans.map((l) => (
              <tr key={l.id} className="hover:bg-paper-2/40" data-testid="emi-loan-row">
                <td className="px-4 py-3 font-medium text-ink">{l.lender ?? l.name}</td>
                <td className="px-4 py-3 text-ink-2">{l.first_emi_on ? formatDate(l.first_emi_on) : "—"}</td>
                <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(l.financed)}</td>
                <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(l.emi_amount)}</td>
                <td className="px-4 py-3 text-center text-ink-2 tabular-nums">{paid(l)}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(l.outstanding)}</td>
                <td className="px-4 py-3">{status(l)}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setScheduleFor(l.id)}>Schedule</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="md:hidden space-y-2.5">
        {loans.map((l) => (
          <li key={l.id}>
            <Card className="p-4">
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="font-medium text-ink leading-tight">{l.lender ?? l.name}</div>
                <div className="font-serif text-xl text-ink leading-none">{rupee(l.outstanding)}</div>
              </div>
              <div className="text-xs text-ink-3 mb-2">
                {rupee(l.financed)} · EMI {rupee(l.emi_amount)} · {paid(l)} EMIs paid
              </div>
              <div className="flex items-center justify-between">
                {status(l)}
                <Button variant="ghost" size="sm" onClick={() => setScheduleFor(l.id)}>Schedule</Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {open && <EmiScheduleDialog purchase={open} onClose={() => setScheduleFor(null)} />}
    </section>
  );
}
