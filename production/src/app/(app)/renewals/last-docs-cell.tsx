"use client";
/**
 * R-2728 — the Renewals row's "Quote <no.> · date · Sent" and "Invoice <no.> · date · Unpaid ₹…"
 * lines (links to the quote / invoice, gated like Last paid), and the date cell's due words +
 * "Expires in N days" for a "Renewal quote sent" row. Rules and words: ./last-docs.ts.
 * R-2737: the invoice line says its real state (Overdue Nd / Cancelled / USD …) and both lines the
 * period the document covers.
 * R-2747: the lines wrap (never cut), and a "Previous term ₹x still unpaid" row with no unpaid
 * invoice says why.
 * R-2748: the last TWO invoices, newest first, each "Invoice <no.> · ₹total · <state>" and
 * "for <period> · from Q-… · <quote state>".
 */
import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import {
  daysBetweenIst, invoiceStatusWords, invoiceTotalWords, priorDueInvoiceGap, quoteExpiryText, quoteStateLabel, renewalDueText,
  sourceQuoteState,
  type DocTone, type LastDocs, type LastInvoice, type SentRenewal,
} from "./last-docs";

function DocLink({ id, href }: { id: string; href: string | null }) {
  return href
    ? <Link href={href as never} className="font-mono underline underline-offset-2 hover:text-ink">{id}</Link>
    : <span className="font-mono">{id}</span>;
}

export function LastDocsLines({ docs, loading, failed, canQuotes, canInvoices, todayIst, priorDue = 0, className }: {
  docs: LastDocs | undefined;
  loading: boolean;
  failed: boolean;
  canQuotes: boolean;
  canInvoices: boolean;
  todayIst: string;
  /** R-2747: the row's "Previous term ₹x still unpaid" amount (prior-due.ts priorTermDue); 0 = none. */
  priorDue?: number;
  className?: string;
}) {
  if (loading) return null;
  if (failed) return <p className={cn("text-2xs text-ink-3", className)}>Last quote / invoice: couldn&apos;t load — reload the page</p>;
  const invoices = docs?.invoices?.length ? docs.invoices : docs?.invoice ? [docs.invoice] : [];
  /* R-2748: one fact one place — the newest quote sent is not repeated when it is an invoice's own quote */
  const quote = docs?.quote && !invoices.some((i) => i.sourceQuoteId === docs.quote?.id) ? docs.quote : null;
  const gap = priorDueInvoiceGap(docs, priorDue, todayIst);
  if (!quote && invoices.length === 0 && !gap) return null;
  const quoteState = quote ? quoteStateLabel(quote, todayIst) : "";
  /* R-2737: line 2 says the period the document covers (else the invoice's date). The block is
     bounded to the column (w-full min-w-0 — the Actions cell is a flex-col items-start, which gave it
     its max-content width and let the text run past the column).
     R-2747: every line WRAPS (break-words), never cut — at 1568px the table's Actions column cut
     "Overdue 10d · ₹33,232 due" to "Ove…". A long document number may break too (never runs past the column). */
  return (
    <div className={cn("w-full min-w-0 max-w-full space-y-0.5 text-2xs text-ink-2", className)} data-testid="renewal-last-docs">
      {quote && (
        <div
          data-doc-line="quote"
          title={`Last quote sent: ${quote.id} · ${formatDate(quote.date)} · ${quoteState}${quote.period ? ` · for ${quote.period}` : ""}`}
        >
          <p className="break-words">
            <span className="text-ink-3">Quote </span>
            <DocLink id={quote.id} href={canQuotes ? `/quotes/${encodeURIComponent(quote.id)}` : null} />
            {" · "}<span className="tabular-nums">{formatDate(quote.date)}</span>{" · "}{quoteState}
          </p>
          {quote.period && <p className="break-words tabular-nums text-ink-3" data-testid="renewal-last-quote-period">for {quote.period}</p>}
        </div>
      )}
      {invoices.map((inv, n) => (
        <InvoiceLine key={inv.id} invoice={inv} label={n === 0 ? "Last invoice" : "Invoice before it"} canInvoices={canInvoices} canQuotes={canQuotes} todayIst={todayIst} />
      ))}
      {gap && <p className="break-words text-ink-3" data-testid="renewal-prior-due-no-invoice">{gap}</p>}
    </div>
  );
}

/** One invoice: "Invoice <no.> · ₹total · <state>" (state coloured by TONE) + "for <period>" (else its
 *  date) "· from Q-… · <state>". Fed by a list in LastDocsLines (R-2748: the last two). */
function InvoiceLine({ invoice, label, canInvoices, canQuotes, todayIst }: {
  invoice: LastInvoice;
  label: string;
  canInvoices: boolean;
  canQuotes: boolean;
  todayIst: string;
}) {
  const state = invoiceStatusWords(invoice, todayIst);
  const total = invoiceTotalWords(invoice);
  const src = invoice.sourceQuote ?? null;
  const srcState = src ? sourceQuoteState(src, todayIst) : "";
  return (
    <div
      data-doc-line="invoice"
      data-invoice-id={invoice.id}
      title={`${label}: ${invoice.id}${invoice.date ? ` · dated ${formatDate(invoice.date)}` : ""} · ${total} · ${state.text}${invoice.period ? ` · for ${invoice.period}` : ""}${src ? ` · from ${src.id} (${srcState})` : ""}`}
    >
      <p className={cn("break-words", state.tone === "muted" && "text-ink-3")}>
        <span className="text-ink-3">Invoice </span>
        <DocLink id={invoice.id} href={canInvoices ? invoiceHref(invoice.id) : null} />
        {" · "}<span className="tabular-nums" data-testid="renewal-invoice-total">{total}</span>
        {" · "}<span className={TONE[state.tone]} data-testid="renewal-last-invoice-status">{state.text}</span>
      </p>
      {(invoice.period || invoice.date || src) && (
        <p className="break-words tabular-nums text-ink-3">
          {(invoice.period || invoice.date) && (
            <span data-testid="renewal-last-invoice-period">{invoice.period ? `for ${invoice.period}` : `dated ${formatDate(invoice.date)}`}</span>
          )}
          {src && (
            <span data-testid="renewal-invoice-quote">
              {(invoice.period || invoice.date) ? " · " : ""}from <DocLink id={src.id} href={canQuotes ? `/quotes/${encodeURIComponent(src.id)}` : null} />{" · "}{srcState}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/** R-2737: the invoice state's colour — overdue red, cancelled / credited grey. */
const TONE: Record<DocTone, string> = {
  ok: "text-ink-2",
  warn: "font-medium text-ink",
  danger: "font-medium text-rose-600",
  muted: "text-ink-3",
};

/** Under the renewal date of a "Renewal quote sent" row: its due words (the chip no longer says them) + the quote's validity. */
export function SentDueLines({ sent, daysUntil, todayIst, className }: {
  sent: SentRenewal;
  daysUntil: number;
  todayIst: string;
  className?: string;
}) {
  /* A part proforma is due on ITS date — Bill next part already moved renewal_date a term on. */
  const days = sent.kind === "part" && sent.dueDate ? daysBetweenIst(todayIst, sent.dueDate) : daysUntil;
  const expiry = quoteExpiryText(sent.expiresDate, todayIst);
  const expired = expiry.startsWith("Expired");
  return (
    <div className={cn("text-2xs tabular-nums", className)} data-testid="renewal-sent-due">
      <p className={days < 0 ? "font-medium text-rose-600" : "text-ink-3"}>{sent.kind === "part" ? `Part bill ${renewalDueText(days).toLowerCase()}` : renewalDueText(days)}</p>
      <p className={expired ? "font-medium text-rose-600" : "text-ink-2"}>{expiry}</p>
    </div>
  );
}
