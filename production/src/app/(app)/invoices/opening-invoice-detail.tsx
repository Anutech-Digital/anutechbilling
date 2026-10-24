/**
 * R-1739 — the page of an invoice imported from Zoho Books (document_kind 'opening_invoice').
 *
 * It is an open balance, not a document of ours: no PDF (Zoho issued it), no credit / debit
 * note (they are issued in Zoho Books, where its GST was filed), no IRN, no line items. What
 * it does have is money: what Zoho said was still due, what has been received here since,
 * and "Record payment" — the same Several-invoices sheet as Payments (one way to record a
 * payment), opened for this customer.
 */
"use client";

import { paymentMethodLabel } from "@/lib/payments/method-label";
import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { canWriteSales } from "@/lib/nav";
import { canRecordMoney } from "@/lib/auth/roles";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { invoiceBucket } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { cleanDisplayName, formatDate, rupee } from "@/lib/utils";
import type { Invoice } from "@/lib/supabase/database.types";
import { invoiceStatusBadge } from "./invoice-status";

interface OpeningPaymentRow {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  received_at: string;
  receipt_voucher_no: string | null;
  status: string;
}

function useOpeningInvoicePayments(invoiceId: string) {
  return useQuery({
    queryKey: ["payments", "by-opening-invoice", invoiceId],
    queryFn: async (): Promise<OpeningPaymentRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payments")
        .select("id, amount, method, reference, received_at, receipt_voucher_no, status")
        .eq("invoice_id", invoiceId)
        .order("received_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as OpeningPaymentRow[];
    },
  });
}

export function OpeningInvoiceDetail({ invoice }: { invoice: Invoice }) {
  const { data: me } = useCurrentUser();
  const { data: payments, isLoading } = useOpeningInvoicePayments(invoice.id);
  const [payOpen, setPayOpen] = React.useState(false);
  const bucket = invoiceBucket(invoice);
  const canPay = canWriteSales(me?.role) && canRecordMoney(me?.role)
    && (bucket === "pending" || bucket === "overdue") && !!invoice.customer_id;
  const badge = invoiceStatusBadge(invoice);
  const zohoPaid = invoice.amount - (invoice.opening_balance ?? 0);
  const received = (payments ?? []).filter((p) => p.status === "received");
  const paidHere = received.reduce((s, p) => s + p.amount, 0);
  const due = invoiceBalance(invoice);

  return (
    <div className="max-w-3xl mx-auto w-full p-4 md:p-6 lg:p-8">
      <Link
        href={"/invoices" as never}
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
      >
        <Icon name="chevron_left" size={14} /> All invoices
      </Link>
      <div className="rounded-lg border border-hairline bg-paper overflow-hidden">
        <header className="p-4 border-b border-hairline bg-paper-2 flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-base font-bold text-ink break-all">{invoice.id}</h1>
              <Badge kind={badge?.kind ?? "muted"} size="sm" dot>{badge?.label ?? invoice.status}</Badge>
              <Badge kind="info" size="sm">Imported from Zoho</Badge>
            </div>
            <p className="text-xs font-medium text-ink-2 mt-0.5">
              {invoice.customer_id ? (
                <Link href={`/customers/${invoice.customer_id}` as never} className="hover:text-amber-ink hover:underline">
                  {cleanDisplayName(invoice.customer_name)}
                </Link>
              ) : cleanDisplayName(invoice.customer_name)}
            </p>
          </div>
          {canPay && (
            <Button size="sm" variant="primary" icon="rupee" onClick={() => setPayOpen(true)}>
              Record payment
            </Button>
          )}
        </header>

        <div className="p-4 space-y-4">
          <Card className="p-4 text-xs space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Figure label="Zoho total" value={rupee(invoice.amount)} />
              <Figure label="Paid in Zoho" value={rupee(zohoPaid)} />
              <Figure label="Received here" value={rupee(paidHere)} />
              <Figure label="Balance due" value={rupee(due)} strong />
            </div>
            <div className="grid grid-cols-2 gap-2 text-ink-2 pt-3 border-t border-hairline/60">
              <div><span className="text-ink-3">Invoice date:</span> {formatDate(invoice.invoice_date)}</div>
              <div><span className="text-ink-3">Due date:</span> {invoice.due_date ? formatDate(invoice.due_date) : "—"}</div>
              <div><span className="text-ink-3">Customer GSTIN:</span> {invoice.customer_gstin || "—"}</div>
              <div><span className="text-ink-3">Place of supply:</span> {invoice.pos_state_code || "—"}</div>
            </div>
          </Card>

          <div className="rounded-md bg-paper-2 border border-hairline px-4 py-3 text-xs text-ink-2" data-testid="opening-invoice-note">
            <p className="font-semibold text-ink mb-0.5">Imported from Zoho Books</p>
            Its GST was filed and its revenue booked in Zoho Books, so it is not in GST returns, the P&amp;L,
            e-invoicing or your invoice numbers here. Its PDF, credit notes and debit notes stay in Zoho Books.
          </div>

          <Card className="p-4">
            <p className="text-xs font-semibold text-ink mb-2">Payments received here</p>
            {isLoading ? (
              <p className="text-xs text-ink-3 italic">Loading payments…</p>
            ) : (payments ?? []).length === 0 ? (
              <p className="text-xs text-ink-3">No payment recorded here yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {(payments ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                      <span className="font-mono text-xs text-ink truncate">{p.receipt_voucher_no ?? "Receipt"}</span>
                      <span className="text-2xs text-ink-3">· {paymentMethodLabel(p.method)}{p.reference ? ` · ${p.reference}` : ""}</span>
                      {p.status === "refunded" && <Badge kind="muted" size="sm">Refunded</Badge>}
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                      <span className="text-2xs text-ink-3">{formatDate(p.received_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {payOpen && invoice.customer_id && (
        <MultiInvoicePaymentDialog
          open={payOpen}
          onOpenChange={setPayOpen}
          customerId={invoice.customer_id}
          customerName={invoice.customer_name}
        />
      )}
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-3xs text-ink-3 uppercase tracking-wider font-semibold">{label}</p>
      <p className={strong ? "font-serif text-lg font-bold text-ink tabular-nums mt-0.5" : "text-sm text-ink tabular-nums mt-0.5"}>{value}</p>
    </div>
  );
}
