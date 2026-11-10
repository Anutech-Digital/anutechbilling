"use client";
/**
 * R-2410 — "Book as TDS" on a Small leftovers line: the SAME Record payment sheet the invoice
 * page's TDS banner opens (R-1520 / R-1636), in TDS mode — ₹0 in bank, "Customer deducted TDS"
 * ticked at the matched section + rate, method Other. Saved by record_desk_payment →
 * record_payment_with_tds (or record_instalment_payment for an instalment); the operator still
 * confirms in the sheet. This file only loads the invoice and picks the sheet, exactly as
 * invoices/invoice-detail.tsx does — no new money path.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { useQuoteByInvoiceId } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { takesQuotelessReceipt } from "@/lib/payments/quoteless-receipt";
import type { Invoice } from "@/lib/supabase/database.types";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { RecordSubscriptionPaymentContainer } from "@/app/(app)/invoices/record-invoice-payment";

export function BookTdsSheet({
  invoiceId, tds, onClose,
}: {
  invoiceId: string;
  tds: { section: string; ratePct: number };
  onClose: () => void;
}) {
  const invQ = useQuery({
    queryKey: ["invoices", "one", invoiceId],
    queryFn: async (): Promise<Invoice | null> => {
      const { data, error } = await createClient().from("invoices").select("*").eq("id", invoiceId).maybeSingle();
      if (error) throw error;
      return data as Invoice | null;
    },
  });
  const quoteQ = useQuoteByInvoiceId(invoiceId);
  const quote = quoteQ.data ?? null;
  const paymentsQ = usePaymentsByQuote(quote?.id);
  const onOpenChange = (o: boolean) => { if (!o) onClose(); };

  if (invQ.isLoading || quoteQ.isLoading || (quote && paymentsQ.isLoading)) {
    return <p className="mt-1 text-2xs italic text-ink-3">Opening Record payment…</p>;
  }
  const invoice = invQ.data ?? null;
  if (invQ.isError || quoteQ.isError || !invoice) {
    return (
      <p role="alert" className="mt-1 text-2xs text-ink-2">
        Could not open invoice {invoiceId}.{" "}
        <button type="button" className="underline text-ink" onClick={() => { void invQ.refetch(); void quoteQ.refetch(); }}>Retry</button>
        {" · "}
        <button type="button" className="underline text-ink" onClick={onClose}>Close</button>
      </p>
    );
  }
  if (takesQuotelessReceipt(invoice)) {
    /* An invoice imported from Zoho Books (R-1739 opening; R-2542 FY sale) is paid on the Several-invoices sheet, which needs
       money in the bank — a TDS-only receipt cannot be saved there. */
    return (
      <p role="alert" className="mt-1 text-2xs text-ink-2">
        {invoiceId} was imported from Zoho Books, so its TDS is recorded together with the bank amount in Record payment.
        If that is already done, use Write off for this balance.{" "}
        <button type="button" className="underline text-ink" onClick={onClose}>Close</button>
      </p>
    );
  }
  if (quote) {
    return (
      <RecordPaymentDialog
        open
        onOpenChange={onOpenChange}
        quoteId={quote.id}
        customerName={invoice.customer_name ?? quote.customer_name}
        expectedAmount={quote.amount ?? invoice.amount}
        alreadyReceived={totalReceived(paymentsQ.data ?? [])}
        isProspect={!!quote.lead_id && !quote.customer_id}
        invoiceId={invoice.id}
        customerId={invoice.customer_id ?? quote.customer_id}
        askDomain={!quote.is_one_off}
        defaultDomain={quote.domain ?? undefined}
        tdsOnly={tds}
      />
    );
  }
  /* A subscription instalment (no quote of its own) — the invoice page's container, TDS mode. */
  return <RecordSubscriptionPaymentContainer invoice={invoice} open onOpenChange={onOpenChange} tdsOnly={tds} />;
}
