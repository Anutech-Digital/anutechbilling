"use client";

/**
 * R-1620 — the invoice behind a Billing schedule chip, in a popup.
 *
 * Pardeep (19 Oct 2026, with a screenshot): the green "Invoiced · INV-… · paid" chip in the
 * subscription drawer said an invoice existed and gave no way to see it — the owner had to
 * leave the drawer, open Invoices and search for the number.
 *
 * ─── NO NEW MONEY MATHS ─────────────────────────────────────────────────────
 * Every figure comes from the helpers /invoices/<id> already uses, so the popup and the page
 * cannot disagree:
 *   - invoiceDisplayAmounts(invoice, quote) — subtotal / discount / taxable / tax (R-066);
 *     total is `quote.amount ?? invoice.amount`, exactly as InvoiceDetail;
 *   - splitTaxHeads — the one CGST/SGST/IGST split (R-046), on the inter_state FROZEN at
 *     issue, as TaxInvoiceDialog does; an invoice without it shows one "GST" line;
 *   - invoiceStatusBadge — the list's word ("Overdue 40d", "Partial") (R-238);
 *   - invoiceBalance — what is still owed, net of advances and receipts (R-062);
 *   - the same server PDF route the Tax Invoice dialog's "Download PDF" calls first.
 * The full document (supplier block, WhatsApp, payments, credit notes) stays on the invoice
 * page — "Open full invoice" goes there.
 *
 * Narrow selects: only the columns shown. RLS decides what is visible, so another tenant's
 * id reads as "not found", never as data.
 */
import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadErrorInline } from "@/components/shared/load-error";
import { toastError } from "@/lib/errors/toast-error";
import { PDF_FAILED_DESCRIPTION } from "@/lib/pdf/pdf-timeout";
import { rupee, formatDate, cleanDisplayName } from "@/lib/utils";
import { SAAS_HSN } from "@/lib/gst/hsn";
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { invoiceDisplayAmounts } from "@/lib/invoices/display-amounts";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { documentTitle } from "@/lib/invoices/document-kind";
import { invoiceStatusBadge } from "@/app/(app)/invoices/invoice-status";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { noteTotalsByInvoice, type NoteAmountRow, type NoteTotals } from "@/lib/invoices/note-totals";
import type { Invoice, Quote } from "@/lib/supabase/database.types";

const INVOICE_COLS =
  "id, invoice_date, due_date, customer_name, status, amount, net_payable, paid_amount, " +
  "taxable_value, tax_amount, tax_rate, inter_state, line_items, quote_id, adjusted_advances, document_kind";
const QUOTE_COLS = "subtotal, discount_pct, tax_rate, amount, line_items";

/** Exactly the columns in INVOICE_COLS / QUOTE_COLS, typed from the generated rows. */
export type PeekInvoice = Pick<Invoice,
  | "id" | "invoice_date" | "due_date" | "customer_name" | "status" | "amount" | "net_payable"
  | "paid_amount" | "taxable_value" | "tax_amount" | "tax_rate" | "inter_state" | "line_items"
  | "quote_id" | "adjusted_advances" | "document_kind">;
export type PeekQuote = Pick<Quote, "subtotal" | "discount_pct" | "tax_rate" | "amount" | "line_items">;

export function useInvoicePeek(invoiceId: string | null) {
  return useQuery({
    queryKey: ["invoices", "peek", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<{ invoice: PeekInvoice; quote: PeekQuote | null; notes?: NoteTotals } | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("invoices").select(INVOICE_COLS).eq("id", invoiceId!).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const invoice = data as unknown as PeekInvoice;
      let quote: PeekQuote | null = null;
      if (invoice.quote_id) {
        const { data: q, error: qErr } = await supabase.from("quotes").select(QUOTE_COLS).eq("id", invoice.quote_id).maybeSingle();
        if (qErr) throw new Error(qErr.message);
        quote = (q as unknown as PeekQuote | null) ?? null;
      }
      /* R-2095: the badge reads the notes too — a fully credited invoice says "Credited", not "Paid".
         A failed read leaves the notes unread (the badge then trusts the status, as before). */
      const [cn, dn] = await Promise.all([
        supabase.from("credit_notes").select("invoice_id, amount").eq("invoice_id", invoice.id),
        supabase.from("debit_notes").select("invoice_id, amount").eq("invoice_id", invoice.id),
      ]);
      const notes = !cn.error && !dn.error && Array.isArray(cn.data) && Array.isArray(dn.data)
        ? noteTotalsByInvoice(cn.data as NoteAmountRow[], dn.data as NoteAmountRow[]).get(invoice.id) ?? { credit: 0, debit: 0 }
        : undefined;
      return { invoice, quote, notes };
    },
  });
}

/** Same order as TaxInvoiceDialog's Download PDF: the server's copy (the one the customer is emailed). */
async function downloadServerPdf(invoiceId: string): Promise<void> {
  const r = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf-link`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!r.ok || !j.url) throw new Error(j.error || `HTTP ${r.status}`);
  const a = document.createElement("a");
  a.href = j.url;
  a.download = `${invoiceId}.pdf`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function InvoicePeekDialog({ invoiceId, open, onOpenChange }: {
  invoiceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useInvoicePeek(open ? invoiceId : null);
  const [downloading, setDownloading] = React.useState(false);
  const fullHref = invoiceHref(invoiceId);

  async function onDownload() {
    setDownloading(true);
    try {
      await downloadServerPdf(invoiceId);
    } catch (err) {
      toastError(err, {
        fallback: "The invoice PDF did not download.",
        description: `Open the full invoice and use Download PDF there. ${PDF_FAILED_DESCRIPTION}`,
        action: { label: "Open full invoice", onClick: () => { window.location.href = fullHref; } },
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogTitle className="font-mono break-all">{invoiceId}</DialogTitle>
        <DialogDescription className="sr-only">Invoice summary from the billing schedule</DialogDescription>
        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading invoice">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : error ? (
          <LoadErrorInline what={`Invoice ${invoiceId}`} error={error} onRetry={() => void refetch()} />
        ) : !data ? (
          <div role="alert" className="text-sm text-ink-2">
            <p><b className="text-ink">Invoice {invoiceId} was not found.</b></p>
            <p className="mt-1 text-xs">It may have been deleted, or it belongs to another company. Search for it in the invoice list.</p>
            <Button asChild className="mt-2" size="sm" icon="file">
              <Link href={`/invoices?q=${encodeURIComponent(invoiceId)}` as never}>Search invoices</Link>
            </Button>
          </div>
        ) : (
          <PeekBody invoice={data.invoice} quote={data.quote} notes={data.notes} />
        )}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {data && (
            <Button size="sm" icon="download" loading={downloading} onClick={() => void onDownload()}>
              Download PDF
            </Button>
          )}
          <Button asChild size="sm" variant="primary" icon="external">
            <Link href={fullHref as never}>Open full invoice</Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PeekBody({ invoice, quote, notes }: { invoice: PeekInvoice; quote: PeekQuote | null; notes?: NoteTotals }) {
  const badge = invoiceStatusBadge(invoice, undefined, notes);
  const { subtotal, discount, taxable, taxRate, tax } = invoiceDisplayAmounts(invoice, quote);
  const total = quote?.amount ?? invoice.amount;
  const heads = invoice.inter_state == null ? null : splitTaxHeads(tax, invoice.inter_state);
  const lines = quote?.line_items ?? invoice.line_items ?? [];
  const balance = invoiceBalance(invoice);
  const received = invoice.paid_amount ?? 0;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-wider text-ink-3">{documentTitle(invoice)}</span>
        <Badge kind={badge?.kind ?? "muted"} size="sm" dot>{badge?.label ?? invoice.status}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-3">Customer</dt><dd className="text-ink font-medium">{cleanDisplayName(invoice.customer_name)}</dd>
        <dt className="text-ink-3">Invoice date</dt><dd className="text-ink">{invoice.invoice_date ? formatDate(invoice.invoice_date) : "—"}</dd>
        <dt className="text-ink-3">Due date</dt><dd className="text-ink">{invoice.due_date ? formatDate(invoice.due_date) : "—"}</dd>
      </dl>

      {lines.length > 0 ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-hairline text-3xs uppercase text-ink-3">
              <th className="py-1 text-left">Description</th>
              <th className="py-1 text-center">HSN/SAC</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline/60">
            {lines.map((item, idx) => (
              <tr key={idx}>
                <td className="py-1.5 font-medium text-ink">{item.name}</td>
                <td className="py-1.5 text-center font-mono text-2xs text-ink-3">{(item as { hsn?: string | null }).hsn || SAAS_HSN}</td>
                <td className="py-1.5 text-right tabular-nums">{item.qty}</td>
                <td className="py-1.5 text-right tabular-nums">{rupee((item.rate ?? 0) * (item.qty ?? 1))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-ink-3">No line items recorded on this invoice — the full invoice page shows the document.</p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-hairline pt-2 text-xs tabular-nums">
        {discount > 0 && (<>
          <dt className="text-ink-3">Subtotal</dt><dd className="text-right">{rupee(subtotal)}</dd>
          <dt className="text-ink-3">Discount</dt><dd className="text-right">−{rupee(discount)}</dd>
        </>)}
        <dt className="text-ink-3">Taxable value</dt><dd className="text-right">{rupee(taxable)}</dd>
        {heads == null ? (<>
          <dt className="text-ink-3">GST ({taxRate}%)</dt><dd className="text-right">{rupee(tax)}</dd>
        </>) : invoice.inter_state ? (<>
          <dt className="text-ink-3">IGST ({taxRate}%)</dt><dd className="text-right">{rupee(heads.igst)}</dd>
        </>) : (<>
          <dt className="text-ink-3">CGST ({taxRate / 2}%)</dt><dd className="text-right">{rupee(heads.cgst)}</dd>
          <dt className="text-ink-3">SGST ({taxRate / 2}%)</dt><dd className="text-right">{rupee(heads.sgst)}</dd>
        </>)}
        <dt className="font-semibold text-ink">Total</dt><dd className="text-right font-semibold text-ink">{rupee(total)}</dd>
        {received > 0 && (<>
          <dt className="text-ink-3">Received</dt><dd className="text-right text-emerald">{rupee(received)}</dd>
        </>)}
        <dt className="text-ink-3">Balance due</dt><dd className="text-right">{rupee(balance)}</dd>
      </dl>
    </div>
  );
}
