"use client";

import * as React from "react";
import { useQuoteByInvoiceId } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived, useInstalmentLink } from "@/lib/queries/payments";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { invoicePaymentRoute } from "@/lib/payments/instalment-payment";
import type { Invoice } from "@/lib/supabase/database.types";
import { isOpeningInvoice } from "@/lib/accounting/sale-documents";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";

/**
 * RecordSubscriptionPaymentContainer — Record payment from the invoice list (and the
 * invoice page) for a NON-project invoice. Opens the SAME RecordPaymentDialog the quote
 * page uses; this is a shortcut surface, not a new money path.
 *
 *  - Invoice with its own quote (quotes.invoice_id = this invoice): the quote-keyed sheet;
 *    record_payment flips the invoice to paid when the balance is covered.
 *  - R-1564: a subscription INSTALMENT (quote_id NULL by design; the link is
 *    subscription_billings.invoice_id): the sheet for THIS invoice's own amount, saved by
 *    record_instalment_payment, which records the money on the subscription's quote and
 *    applies it to this invoice in the same transaction. Before this the container waited
 *    for a quote that never comes and showed "Loading payment…" forever.
 *  - A failed lookup says so with Retry, and an invoice with neither link says why (§24).
 */
export function RecordSubscriptionPaymentContainer({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const quoteQ = useQuoteByInvoiceId(invoice.id);
  const linkQ = useInstalmentLink(invoice.quote_id ? null : invoice.id);
  const quote = quoteQ.data ?? null;
  const route = invoicePaymentRoute(
    invoice,
    { loading: quoteQ.isLoading, failed: !!quoteQ.isError, data: quote },
    { loading: !invoice.quote_id && linkQ.isLoading, failed: !!linkQ.isError, data: linkQ.data },
  );
  const { data: payments } = usePaymentsByQuote(route.kind === "quote" ? quote?.id : null);

  /* R-1739: an invoice imported from Zoho Books has no quote — its payment is recorded on the
     Several-invoices sheet (record_multi_invoice_payment), opened for its customer. */
  if (isOpeningInvoice(invoice)) {
    return invoice.customer_id ? (
      <MultiInvoicePaymentDialog open={open} onOpenChange={onOpenChange} customerId={invoice.customer_id} customerName={invoice.customer_name} />
    ) : null;
  }

  if (route.kind === "loading") {
    return <div className="text-3xs text-ink-3 mt-1 italic">Loading payment…</div>;
  }
  if (route.kind === "error" || route.kind === "none") {
    return (
      <div role="alert" className="mt-1 max-w-[16rem] text-left text-3xs text-ink-2">
        <div className="font-medium text-ink">{route.title}</div>
        <div>{route.detail}</div>
        {route.kind === "error" && (
          <button
            type="button"
            className="mt-1 underline text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
            onClick={() => { void quoteQ.refetch?.(); void linkQ.refetch?.(); }}
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  if (route.kind === "instalment") {
    return (
      <RecordPaymentDialog
        open={open}
        onOpenChange={onOpenChange}
        quoteId={route.quoteId}
        customerName={invoice.customer_name}
        expectedAmount={route.expected}
        alreadyReceived={route.alreadyReceived}
        invoiceId={invoice.id}
        instalmentInvoiceId={invoice.id}
        customerId={invoice.customer_id}
        askDomain={false}
      />
    );
  }
  if (!quote) return null;
  return (
    <RecordPaymentDialog
      open={open}
      onOpenChange={onOpenChange}
      quoteId={quote.id}
      customerName={invoice.customer_name ?? quote.customer_name}
      expectedAmount={quote.amount ?? invoice.amount}
      alreadyReceived={totalReceived(payments ?? [])}
      isProspect={!!quote.lead_id && !quote.customer_id}
      invoiceId={invoice.id}
      customerId={invoice.customer_id ?? quote.customer_id}
      askDomain={!quote.is_one_off}
      defaultDomain={quote.domain ?? undefined}
    />
  );
}
