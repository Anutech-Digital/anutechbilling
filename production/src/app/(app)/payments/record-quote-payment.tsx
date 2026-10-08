/**
 * Record a payment against a quote WITHOUT leaving the page (R-237, 6 Oct 2026).
 *
 * "Record payment" on Payments Received was a link to /quotes/<id>. Billing cannot open
 * quotes (nav.ts), so middleware threw them back to /invoices — the one role whose job
 * is recording payments could not record one from the payments screen. Everyone else
 * paid an extra hop. This loads the quote + its payments and opens the SAME
 * RecordPaymentDialog the quote page uses (record_payment RPC) right here — the same
 * shortcut invoices/page.tsx already gives subscription invoices.
 */
"use client";

import * as React from "react";
import { useQuote } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";

export function RecordQuotePaymentDialog({
  quoteId,
  open,
  onOpenChange,
}: {
  quoteId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: quote } = useQuote(open && quoteId ? quoteId : undefined);
  const { data: payments } = usePaymentsByQuote(open && quoteId ? quoteId : null);

  /* Quote is the money source of truth — no expected amount until it loads, so the
     dialog waits for it rather than opening on a guessed figure. */
  if (!open || !quote) return null;

  return (
    <RecordPaymentDialog
      open={open}
      onOpenChange={onOpenChange}
      quoteId={quote.id}
      customerName={quote.customer_name}
      expectedAmount={quote.amount ?? 0}
      alreadyReceived={totalReceived(payments ?? [])}
      isProspect={!!quote.lead_id && !quote.customer_id}
      invoiceId={quote.invoice_id}
      customerId={quote.customer_id}
      lineItems={Array.isArray(quote.line_items) ? quote.line_items : null}
      askDomain={!quote.is_one_off}
      defaultDomain={quote.domain ?? undefined}
    />
  );
}
