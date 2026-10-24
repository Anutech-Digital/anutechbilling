/**
 * R-1739 — on /payments, beside "Subscription dues": the balances still owed on invoices
 * imported from Zoho Books. They have no subscription, so the subscription dues card (built
 * from subscriptions.outstanding_amount) cannot show them; this card lists each one with its
 * age (days since its due date, IST) and "Record payment" — the same Several-invoices sheet
 * as everywhere else, opened for that customer.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { OPENING_INVOICE_KIND } from "@/lib/accounting/sale-documents";
import { daysSince } from "@/lib/queries/payments";
import { todayIST } from "@/lib/subscriptions/payment-due";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cleanDisplayName, formatDate, rupee } from "@/lib/utils";

export interface OpeningDueRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  due_date: string | null;
  invoice_date: string;
  amount: number;
  net_payable: number | null;
  paid_amount: number;
}

export function useOpeningInvoiceDues() {
  return useQuery({
    queryKey: ["invoices", "opening-dues"],
    queryFn: async (): Promise<OpeningDueRow[]> => {
      const supabase = createClient();
      return fetchAllRows<OpeningDueRow>((from, to) =>
        supabase.from("invoices")
          .select("id, customer_id, customer_name, due_date, invoice_date, amount, net_payable, paid_amount")
          .eq("document_kind", OPENING_INVOICE_KIND)
          .in("status", ["pending", "overdue"]).is("written_off_at", null)
          .order("id", { ascending: true })
          .range(from, to) as never);
    },
  });
}

/** Pure: rows with money still due, oldest due date first, with their age in days. */
export function openingDues(rows: readonly OpeningDueRow[], today: string, customerId?: string | null) {
  return rows
    .filter((r) => !customerId || r.customer_id === customerId)
    .map((r) => ({ ...r, due: Math.max(0, (r.net_payable ?? r.amount) - (r.paid_amount ?? 0)), age: daysSince(r.due_date ?? r.invoice_date, today) }))
    .filter((r) => r.due > 0)
    .sort((a, b) => b.age - a.age || a.id.localeCompare(b.id));
}

export function OpeningInvoiceDuesCard({ customerId, canRecord }: { customerId?: string | null; canRecord: boolean }) {
  const { data } = useOpeningInvoiceDues();
  const [payFor, setPayFor] = React.useState<{ id: string; name: string } | null>(null);
  const rows = openingDues(data ?? [], todayIST(), customerId);
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.due, 0);
  return (
    <Card className="mt-4 p-4" data-testid="opening-invoice-dues">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="font-semibold text-ink">Imported from Zoho · {rupee(total)}</h2>
          <p className="text-xs text-ink-3">
            {rows.length} invoice{rows.length === 1 ? "" : "s"} from Zoho Books with a balance — not in subscription dues
          </p>
        </div>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-3xs uppercase tracking-wider text-ink-3 border-b border-hairline">
              <th scope="col" className="p-2 text-left font-semibold">Customer</th>
              <th scope="col" className="p-2 text-left font-semibold">Invoice</th>
              <th scope="col" className="p-2 text-left font-semibold">Due date</th>
              <th scope="col" className="p-2 text-right font-semibold">Balance</th>
              <th scope="col" className="p-2 text-left font-semibold">Age</th>
              <th scope="col" className="p-2 text-right font-semibold"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-hairline last:border-0">
                <td className="p-2 text-ink">{cleanDisplayName(r.customer_name)}</td>
                <td className="p-2">
                  <Link href={`/invoices/${encodeURIComponent(r.id)}` as never} className="font-mono text-xs text-ink hover:text-amber-ink hover:underline">{r.id}</Link>
                </td>
                <td className="p-2 text-ink-2 whitespace-nowrap">{formatDate(r.due_date ?? r.invoice_date)}</td>
                <td className="p-2 text-right tabular-nums font-medium text-ink whitespace-nowrap">{rupee(r.due)}</td>
                <td className="p-2">
                  <Badge kind={r.age > 30 ? "danger" : r.age > 0 ? "warning" : "muted"} size="sm" dot>{r.age}d</Badge>
                </td>
                <td className="p-2 text-right">
                  {canRecord && r.customer_id && (
                    <Button size="sm" variant="primary" icon="rupee" onClick={() => setPayFor({ id: r.customer_id!, name: r.customer_name })}>
                      Record payment
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {payFor && (
        <MultiInvoicePaymentDialog open={!!payFor} onOpenChange={(o) => { if (!o) setPayFor(null); }} customerId={payFor.id} customerName={payFor.name} />
      )}
    </Card>
  );
}
