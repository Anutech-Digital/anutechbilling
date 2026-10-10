/**
 * One invoice, on its own page — R-086 (6 Oct 2026).
 *
 * This was the body of the right-hand sheet that `/invoices?open=<id>` opened over the
 * list. A sheet has no address of its own, so a link sent on WhatsApp or email landed on
 * the list and waited for the row to load, Back closed nothing, and Refresh re-opened it
 * only while the `?open=` param survived (it was stripped 200 ms after opening). The same
 * content now renders at `/invoices/<id>` (see ./[id]/page.tsx); old `?open=` links are
 * redirected there by the list page, so nothing already sent stops working.
 *
 * Every figure still comes from the same calls as before — invoiceDisplayAmounts (shared
 * with the server PDF), supplierIdentity (no invented seller), isInterStateSupply — so the
 * page and the PDF cannot disagree. Only the frame changed.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SAAS_HSN } from "@/lib/gst/hsn";
import { useQuoteByInvoiceId } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { invoiceBucket } from "@/lib/invoices/overdue";
import { invoiceStatusBadge } from "./invoice-status";
import { canOpenQuotes } from "@/lib/quotes/access";
import { canWriteSales } from "@/lib/nav";
import { useProjectPaymentsByInvoice } from "@/lib/queries/projects";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useWhatsAppSender } from "@/lib/hooks/useWhatsAppSender";
import { useCreditNotesByInvoice } from "@/lib/queries/credit-notes";
import { useDebitNotesByInvoice } from "@/lib/queries/debit-notes";
import { isCreditNoteLate, creditNoteDeadline } from "@/lib/gst/credit-note-deadline";
import { TaxInvoiceDialog } from "@/components/features/quotes/tax-invoice-dialog";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { isInterStateSupply, placeOfSupplyLabel } from "@/lib/gst/place-of-supply";
import { supplierIdentity, supplierIdentityMessage } from "@/lib/invoices/supplier-identity";
import { invoiceDisplayAmounts } from "@/lib/invoices/display-amounts";
import { openInvoiceWhatsApp } from "./invoice-whatsapp";
import { invoiceLineItemsView } from "./invoice-line-items";
import { useTurnoverBracket } from "@/lib/compliance/turnover";
import { invoiceEinvoiceNotice } from "@/lib/compliance/einvoice";
import { EinvoiceBanner } from "@/components/features/invoices/einvoice-banner";
import { InvoiceLateCharges } from "@/components/features/late-charges/invoice-late-charges";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, formatDate, cleanDisplayName } from "@/lib/utils";
import type { Invoice, Payment } from "@/lib/supabase/database.types";

export function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const router = useRouter();
  const [pdfDialogOpen, setPdfDialogOpen] = React.useState(false);
  const [showItems, setShowItems] = React.useState(true);
  const [showSummary, setShowSummary] = React.useState(true);
  const [showPayments, setShowPayments] = React.useState(true);

  const { data: quote, isLoading: quoteLoading } = useQuoteByInvoiceId(invoice.id);
  const { data: payments } = usePaymentsByQuote(quote?.id);
  const { data: customer } = useCustomer(invoice.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  const waSender = useWhatsAppSender();
  /* R-237: billing cannot open /quotes — hide "View quote", give it Record payment here. */
  const canQuotes = canOpenQuotes(me?.role);
  const bucket = invoiceBucket(invoice);
  /* R-255: the accountant reads invoices — no Record payment, no WhatsApp reminder. */
  const canWrite = canWriteSales(me?.role);
  const moneyDue = canWrite && (bucket === "pending" || bucket === "overdue");
  const statusBadge = invoiceStatusBadge(invoice);
  const [payOpen, setPayOpen] = React.useState(false);
  /* R-337: over ₹5 Cr turnover, a B2B invoice with no gst_irn gets a reminder. A warning
     only — the app does not generate IRNs yet (R-044). Unknown turnover shows nothing. */
  const { data: turnover } = useTurnoverBracket();
  const einvoiceNotice = invoiceEinvoiceNotice(turnover?.bracket ?? null, {
    customerGstin: invoice.customer_gstin ?? customer?.gstin ?? null,
    gstIrn: invoice.gst_irn,
    status: invoice.status,
    invoiceDate: invoice.invoice_date,
  });

  /* ── WHO IS SELLING THIS — resolved or refused, never invented ──────────────
     This used to be `me || { tenantName: "Excel Technologies Pvt Ltd",
     tenantGstin: "27AABCE9876D1Z3", tenantStateCode: "27", … }` — a fallback that
     looked like a placeholder and behaved like a false declaration.

     The costly part was `stateCode: "27"`. It feeds isInterStateSupply() four lines
     below. ANUTECH is Delhi, **07**. So while `useCurrentUser` was still in flight —
     a deep link into an invoice on a slow connection — a Delhi customer's INTRA-state
     sale (CGST 9% + SGST 9%) was computed as **IGST 18%**. Same rupees, wrong tax
     heads, wrong government paid, and the fix is a credit note plus a fresh invoice
     rather than an edit. Invisible in testing; reproducible in front of a customer.

     The rule now lives in lib/invoices/supplier-identity.ts with its own regression
     test: there is no safe default for "who is selling this", so an unknown identity
     is reported and the document is withheld. */
  const identity = supplierIdentity(me);
  const supplier = identity.ok ? identity.supplier : null;

  /* R-248: `?pdf=1` (from Record payment's "Generate invoice" / "View invoice" toast
     button) opens the Tax Invoice dialog once, as soon as the supplier identity is known —
     never before, for the same reason the PDF button refuses without it. The param is
     then dropped so Refresh/Back do not keep reopening it. */
  const pdfIntentHandled = React.useRef(false);
  React.useEffect(() => {
    if (pdfIntentHandled.current || !supplier) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("pdf") !== "1") return;
    pdfIntentHandled.current = true;
    setPdfDialogOpen(true);
    url.searchParams.delete("pdf");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [supplier]);

  /* R-010. A project-milestone invoice has no quote — it is raised from a milestone — and
     a subscription instalment deliberately leaves quote_id null. Both write their own
     `invoices.line_items`, and this read of the quote alone is why the dialog and the PDF
     printed "No line items recorded on the parent quote." over a correct ₹5,00,000 + GST:
     right money, a document that did not say what was sold (CGST Rule 46(g)). */
  const lineItems = quote?.line_items ?? invoice.line_items ?? [];
  /* R-445: skeleton while the quote loads — never the "no items" fallback, which looked real. */
  const itemsView = invoiceLineItemsView(quoteLoading, quote?.line_items, invoice.line_items);
  /* R-066. This used to be `subtotal = quote?.subtotal ?? invoice.amount` and then 18%
     on top — but `invoice.amount` is the GST-INCLUSIVE gross, so a quote-less invoice
     was taxed on tax: ₹5,90,000 showed "Tax Total ₹1,06,200" instead of ₹90,000.
     Quote-less is the NORMAL case for project-milestone and subscription-instalment
     invoices, and `quote` is also undefined on every first render while the query is in
     flight, so the wrong figure flashed on quote-backed invoices too.

     One call, and it is the same one the server PDF builder makes — these four numbers
     go straight into TaxInvoiceDialog and both PDF buttons below, so the file a customer
     receives was wrong in the same way. */
  const { subtotal, discount, taxable, taxRate, tax } = invoiceDisplayAmounts(invoice, quote);
  const total     = quote?.amount ?? invoice.amount;

  /* `supplier` is null until the identity is complete, so this cannot silently pick a
     side. `undefined` makes isInterStateSupply say "I don't know" instead of guessing —
     and the PDF button below is disabled while that is the case. */
  const interState = isInterStateSupply(
    customer?.state_code,
    supplier?.stateCode,
    { customerGstin: customer?.gstin, sellerGstin: supplier?.gstin },
  );
  const receivedPayments = (payments ?? []).filter((p) => p.status === "received");

  return (
    <>
      <div className="max-w-3xl mx-auto w-full p-4 md:p-6 lg:p-8">
        <Link
          href={"/invoices" as never}
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
        >
          <Icon name="chevron_left" size={14} /> All invoices
        </Link>
        <EinvoiceBanner notice={einvoiceNotice} className="mb-3" />
        <div className="rounded-lg border border-hairline bg-paper overflow-hidden">
          {/* R-202. On a 375px phone the three buttons used to sit in one shrink-0 row beside
              the invoice number, making the sheet 446px wide: PDF off-screen, sideways scroll,
              and the R-187 preview opened from it cut off. Below sm the row and the button
              group wrap; from sm up (576px sheet) they stay on one line as before. */}
          <header data-invoice-header className="p-4 border-b border-hairline bg-paper-2 flex flex-row flex-wrap sm:flex-nowrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-base font-bold text-ink break-all">{invoice.id}</h1>
                {/* R-238: the list's word (Overdue 40d, Partial…), not the stored status. */}
                <Badge kind={statusBadge?.kind ?? "muted"} size="sm" dot>
                  {statusBadge?.label ?? invoice.status}
                </Badge>
              </div>
              <p className="text-xs font-medium text-ink-2 mt-0.5">
                {cleanDisplayName(invoice.customer_name)}
              </p>
            </div>
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:shrink-0" data-invoice-actions>
              {quote?.id && moneyDue && (
                /* R-237: record the payment HERE. Billing's only way used to be the quote
                   page, which middleware does not let billing open. */
                <Button size="sm" variant="primary" icon="rupee" onClick={() => setPayOpen(true)}>
                  Record payment
                </Button>
              )}
              {quote?.id && canQuotes && (
                /* "View quote" — same reasoning as tax-invoice-dialog.tsx. This opens the
                   quote hub, which is a read-only view, and an issued tax invoice is no
                   place to suggest editing the figures behind it (CGST §31; corrections are
                   credit/debit notes under §34). */
                <Button
                  size="sm"
                  variant="outline"
                  icon="file"
                  onClick={() => {
                    router.push(`/quotes/${quote.id}` as any);
                  }}
                >
                  View quote
                </Button>
              )}
              {canWrite && (
                <Button
                  size="sm"
                  variant="primary"
                  icon="whatsapp"
                  onClick={() => openInvoiceWhatsApp(invoice, customer?.contact_phone, waSender, (h) => router.push(h as never))}
                >
                  WhatsApp
                </Button>
              )}
              {/* §24 — a block never dead-ends. The button stays visible and clickable so
                  the operator learns WHY rather than wondering why nothing happens, and
                  the toast carries the route to the fix. */}
              <Button
                size="sm"
                variant="ghost"
                icon="file"
                onClick={() => {
                  if (!supplier) {
                    const msg = supplierIdentityMessage(identity)!;
                    toast.error("Can't issue this Tax Invoice yet", {
                      description: msg,
                      action: identity.ok || !identity.hasSession ? undefined : {
                        label: "Open Settings",
                        onClick: () => router.push("/settings"),
                      },
                    });
                    return;
                  }
                  setPdfDialogOpen(true);
                }}
              >
                PDF
              </Button>
            </div>
          </header>

          <div className="p-4 space-y-4 flex-1">
            {/* 🔽 Collapsible Panel 1: Invoice Overview & Tax Summary */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowSummary((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="receipt" size={14} className="text-ink-3" />
                  <span>Invoice Overview & GST Summary</span>
                </div>
                <Icon name={showSummary ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showSummary && (
                <div className="p-4 space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3 pb-3 border-b border-hairline/60">
                    <div>
                      <p className="text-3xs text-ink-3 uppercase tracking-wider font-semibold">Total Amount</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(total)}</p>
                    </div>
                    <div>
                      <p className="text-3xs text-ink-3 uppercase tracking-wider font-semibold">Net Payable</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(invoice.net_payable ?? total)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-ink-2">
                    <div><span className="text-ink-3">Invoice Date:</span> {formatDate(invoice.invoice_date)}</div>
                    <div><span className="text-ink-3">Due Date:</span> {invoice.due_date ? formatDate(invoice.due_date) : "—"}</div>
                    {/* R-043: the place of supply and tax head FROZEN on the invoice (Rule 46 name + code), not today's customer. */}
                    <div><span className="text-ink-3">Place of Supply:</span> {placeOfSupplyLabel({ posCode: invoice.pos_state_code, interState: invoice.inter_state ?? !!interState, isExport: invoice.pos_state_code === "96", country: invoice.customer_country })}</div>
                    <div><span className="text-ink-3">Tax Total:</span> {rupee(tax)} ({taxRate}%)</div>
                  </div>
                </div>
              )}
            </Card>

            {/* 🔽 Collapsible Panel 2: Line Items & HSN/SAC Breakdown */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowItems((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="file" size={14} className="text-ink-3" />
                  <span>Line Items{itemsView.state === "loading" ? "" : ` (${lineItems.length > 0 ? lineItems.length : "1"})`}</span>
                </div>
                <Icon name={showItems ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showItems && (
                <div className="p-3">
                  {itemsView.state === "loading" ? (
                    <div className="space-y-2 p-1" aria-busy="true" aria-label="Loading line items">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                  ) : lineItems.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-hairline text-ink-3 text-3xs uppercase">
                          <th className="text-left py-1">Description</th>
                          <th className="text-center py-1">HSN/SAC</th>
                          <th className="text-right py-1">Qty</th>
                          <th className="text-right py-1">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline/60">
                        {lineItems.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2 font-medium text-ink">{item.name}</td>
                            <td className="py-2 text-center text-ink-3 font-mono text-2xs">{(item as { hsn?: string | null }).hsn || SAAS_HSN}</td>
                            <td className="py-2 text-right tabular-nums">{item.qty}</td>
                            <td className="py-2 text-right font-medium tabular-nums">{rupee((item.rate ?? 0) * (item.qty ?? 1))}</td>
                          </tr>
                        ))}
                      </tbody>
                      {/* R-084 (1 Oct 2026): a coupon's discount was invisible here — line ₹600,
                          total ₹637 (540 + 97) with no −₹60 anywhere on screen, though the PDF
                          showed it. Same numbers as the PDF (invoiceDisplayAmounts). */}
                      {discount > 0 && (
                        <tfoot className="border-t border-hairline text-ink-2">
                          <tr>
                            <td colSpan={3} className="pt-2 text-right">Subtotal</td>
                            <td className="pt-2 text-right tabular-nums">{rupee(subtotal)}</td>
                          </tr>
                          <tr>
                            <td colSpan={3} className="py-1 text-right">Discount{quote?.discount_pct ? ` (${quote.discount_pct}%)` : ""}</td>
                            <td className="py-1 text-right tabular-nums text-emerald">−{rupee(discount)}</td>
                          </tr>
                          <tr className="font-semibold text-ink">
                            <td colSpan={3} className="text-right">Taxable value</td>
                            <td className="text-right tabular-nums">{rupee(taxable)}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  ) : (
                    <p className="text-xs text-ink-3 italic p-2">Standard Subscription License Supply (HSN {SAAS_HSN})</p>
                  )}
                </div>
              )}
            </Card>

            {/* 🔽 Collapsible Panel 3: Payments & Receipts Accordion */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowPayments((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="rupee" size={14} className="text-ink-3" />
                  <span>Payment Receipts & Advance Adjustments</span>
                </div>
                <Icon name={showPayments ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showPayments && (
                <div className="p-4">
                  <InvoicePaymentsAccordion
                    inv={invoice}
                    /* R-238: no receipt yet → the next step is right here. */
                    onRecordPayment={quote?.id && moneyDue ? () => setPayOpen(true) : undefined}
                  />
                </div>
              )}
            </Card>

            {/* R-530: late fee + interest — switch, accrued, bill (debit note) / waive. */}
            <InvoiceLateCharges invoiceId={invoice.id} />

            {/* 🔽 Collapsible Panel 4: Internal Notes */}
            <Card className="p-4">
              <p className="text-xs font-semibold text-ink mb-2">Internal Notes & History</p>
              <InvoiceNotesList invoiceId={invoice.id} invoiceDate={invoice.invoice_date} />
            </Card>
          </div>
        </div>
      </div>

      {/* `supplier &&` is load-bearing, not defensive. Without a complete identity this
          dialog would render a Tax Invoice headed by whatever was available — which is
          how the fabricated GSTIN used to reach the page. No identity, no document. */}
      {pdfDialogOpen && supplier && (
        <TaxInvoiceDialog
          open={pdfDialogOpen}
          onOpenChange={setPdfDialogOpen}
          invoice={invoice}
          lineItems={lineItems}
          subtotal={subtotal}
          discountPct={quote?.discount_pct ?? 0}
          discount={discount}
          taxable={taxable}
          taxRate={taxRate}
          tax={tax}
          total={total}
          receivedPayments={receivedPayments}
          interState={interState}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          customerPhone={customer?.contact_phone}
          customerState={customer?.state}
          customerCountry={customer?.country}
          currency={quote?.currency}
          exchangeRate={quote?.exchange_rate}
          tenantName={supplier.name}
          tenantGstin={supplier.gstin}
          tenantEmail={supplier.email}
          tenantPhone={supplier.phone}
          tenantAddress={supplier.address}
          tenantState={supplier.state}
        />
      )}
      {/* R-237: the same quote-keyed sheet the invoices list and the quote page use
          (record_payment flips this invoice to paid once the balance is covered). */}
      {payOpen && quote && (
        <RecordPaymentDialog
          open={payOpen}
          onOpenChange={setPayOpen}
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
      )}
    </>
  );
}

/** Credit / debit notes issued against this invoice — shown in the expand so a
 *  note (which quietly lowered/raised the balance) is auditable.
 *  R-344: a CREDIT note dated after its invoice's GST s.34(2) limit (30 Nov after the FY)
 *  carries a "Late" tag — display only, no tax figure changes (a debit note has no limit). */
export function InvoiceNotesList({ invoiceId, invoiceDate }: { invoiceId: string; invoiceDate?: string | null }) {
  const { data: creditNotes } = useCreditNotesByInvoice(invoiceId);
  const { data: debitNotes } = useDebitNotesByInvoice(invoiceId);
  const notes = [
    ...(creditNotes ?? []).map((n) => ({ ...n, kind: "credit" as const, date: n.credit_date, late: isCreditNoteLate(invoiceDate, n.credit_date) })),
    ...(debitNotes ?? []).map((n) => ({ ...n, kind: "debit" as const, date: n.debit_date, late: false })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  if (notes.length === 0) return null;

  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Credit &amp; debit notes ({notes.length})
      </div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`text-3xs font-semibold uppercase px-1.5 py-0.5 rounded ${n.kind === "credit" ? "bg-rose/10 text-rose" : "bg-indigo-soft text-indigo-ink"}`}>
                {n.kind === "credit" ? "Credit" : "Debit"} note
              </span>
              {n.late && invoiceDate && (
                <span
                  className="text-3xs font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-soft text-amber-ink"
                  title={`Issued after the GST s.34 limit for this invoice (${formatDate(creditNoteDeadline(invoiceDate))}). It may not reduce output GST — confirm with your CA.`}
                >
                  Late
                </span>
              )}
              <span className="font-mono text-2xs text-ink truncate">{n.id}</span>
              <span className="text-2xs text-ink-3 capitalize">· {n.reason_code.replace(/_/g, " ")}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className={`tabular-nums text-sm font-medium ${n.kind === "credit" ? "text-rose" : "text-indigo-ink"}`}>
                {n.kind === "credit" ? "−" : "+"} {rupee(n.amount)}
              </span>
              <span className="text-2xs text-ink-3">{formatDate(n.date)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InvoicePaymentsAccordion({
  inv,
  onRecordPayment,
}: {
  inv: Invoice;
  /** Shown as a button when there is no receipt yet (the invoice page passes it; the list does not). */
  onRecordPayment?: () => void;
}) {
  const { data: quote } = useQuoteByInvoiceId(inv.id);
  const { data: payments, isLoading } = usePaymentsByQuote(quote?.id);
  // Project invoices have no parent quote — their receipts live in project_payments.
  const { data: projPays, isLoading: projLoading } = useProjectPaymentsByInvoice(inv.id);
  const { data: customer } = useCustomer(inv.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  const [receiptPayment, setReceiptPayment] = React.useState<Payment | null>(null);

  const received = (payments ?? []).filter((p) => p.status === "received");
  const interState = isInterStateSupply(customer?.state_code, me?.tenantStateCode, { customerGstin: customer?.gstin, sellerGstin: me?.tenantGstin });

  if (isLoading || projLoading) return <div className="text-xs text-ink-3 italic">Loading receipts…</div>;

  // Project-sale invoice: render its project payments as the receipts.
  if (received.length === 0 && (projPays?.length ?? 0) > 0) {
    return (
      <div>
        <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Payment receipts ({projPays!.length})
        </div>
        <ul className="space-y-1.5">
          {projPays!.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                <span className="text-xs text-ink capitalize">{p.method ?? "Payment"}{p.reference ? ` · ${p.reference}` : ""}</span>
                {p.bank_txn_id && <span className="text-3xs text-emerald">· bank-reconciled</span>}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-2xs text-ink-3">{formatDate(p.received_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (received.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-3">No payment receipts recorded for this invoice yet.</span>
        {onRecordPayment && (
          <Button size="sm" variant="outline" icon="rupee" onClick={onRecordPayment}>
            Record payment
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Payment receipts ({received.length})
      </div>
      <ul className="space-y-1.5">
        {received.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setReceiptPayment(p)}
              className="w-full flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2 text-left transition-colors hover:border-amber-soft hover:bg-amber-soft/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              title="Open receipt voucher"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                <span className="font-mono text-xs text-ink truncate">{p.receipt_voucher_no ?? "Receipt"}</span>
                <span className="text-2xs text-ink-3 capitalize">· {p.method}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-2xs text-ink-3">{formatDate(p.received_at)}</span>
                <Icon name="chevron_right" size={12} className="text-ink-3" />
              </span>
            </button>
          </li>
        ))}
      </ul>

      {receiptPayment && me && (
        <ReceiptVoucherDialog
          open={!!receiptPayment}
          onOpenChange={(o) => { if (!o) setReceiptPayment(null); }}
          payment={receiptPayment}
          customerName={inv.customer_name}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          customerAddress={customer?.address}
          tenantName={me.tenantName}
          tenantGstin={me.tenantGstin}
          tenantEmail={me.tenantEmail}
          tenantPhone={me.tenantPhone}
          tenantAddress={me.tenantAddress}
          tenantState={me.tenantState}
          interState={interState}
          quoteId={quote?.id}
          gstRate={quote?.tax_rate ?? 18}
        />
      )}
    </div>
  );
}
