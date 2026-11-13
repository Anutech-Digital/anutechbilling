"use client";
/**
 * R-2728 — the Renewals row's "Quote <no.> · date · Sent" and "Invoice <no.> · date · Unpaid ₹…"
 * lines (links to the quote / invoice, gated like Last paid), and the date cell's due words +
 * "Expires in N days" for a "Renewal quote sent" row. Rules and words: ./last-docs.ts.
 * R-2737: the invoice line says its real state (Overdue Nd / Cancelled / USD …) and both lines the
 * period the document covers.
 */
import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import {
  daysBetweenIst, invoiceStatusWords, quoteExpiryText, quoteStateLabel, renewalDueText,
  type DocTone, type LastDocs, type SentRenewal,
} from "./last-docs";

function DocLink({ id, href }: { id: string; href: string | null }) {
  return href
    ? <Link href={href as never} className="font-mono underline underline-offset-2 hover:text-ink">{id}</Link>
    : <span className="font-mono">{id}</span>;
}

export function LastDocsLines({ docs, loading, failed, canQuotes, canInvoices, todayIst, className }: {
  docs: LastDocs | undefined;
  loading: boolean;
  failed: boolean;
  canQuotes: boolean;
  canInvoices: boolean;
  todayIst: string;
  className?: string;
}) {
  if (loading) return null;
  if (failed) return <p className={cn("text-2xs text-ink-3", className)}>Last quote / invoice: couldn&apos;t load — reload the page</p>;
  const quote = docs?.quote ?? null;
  const invoice = docs?.invoice ?? null;
  if (!quote && !invoice) return null;
  const quoteState = quote ? quoteStateLabel(quote, todayIst) : "";
  const invState = invoice ? invoiceStatusWords(invoice, todayIst) : null;
  /* R-2737: line 2 says the period the document covers (else the invoice's date). Every line is cut
     with an ellipsis inside the column (w-full min-w-0 — the Actions cell is a flex-col items-start,
     which gave this block its max-content width and let the text run past the column); the full
     words are in the title. */
  return (
    <div className={cn("w-full min-w-0 max-w-full space-y-0.5 text-2xs text-ink-2", className)} data-testid="renewal-last-docs">
      {quote && (
        <div
          data-doc-line="quote"
          title={`Last quote sent: ${quote.id} · ${formatDate(quote.date)} · ${quoteState}${quote.period ? ` · for ${quote.period}` : ""}`}
        >
          <p className="truncate">
            <span className="text-ink-3">Quote </span>
            <DocLink id={quote.id} href={canQuotes ? `/quotes/${encodeURIComponent(quote.id)}` : null} />
            {" · "}<span className="tabular-nums">{formatDate(quote.date)}</span>{" · "}{quoteState}
          </p>
          {quote.period && <p className="truncate tabular-nums text-ink-3" data-testid="renewal-last-quote-period">for {quote.period}</p>}
        </div>
      )}
      {invoice && invState && (
        <div
          data-doc-line="invoice"
          title={`Last invoice: ${invoice.id}${invoice.date ? ` · dated ${formatDate(invoice.date)}` : ""} · ${invState.text}${invoice.period ? ` · for ${invoice.period}` : ""}`}
        >
          <p className={cn("truncate", invState.tone === "muted" && "text-ink-3")}>
            <span className="text-ink-3">Invoice </span>
            <DocLink id={invoice.id} href={canInvoices ? invoiceHref(invoice.id) : null} />
            {" · "}<span className={TONE[invState.tone]} data-testid="renewal-last-invoice-status">{invState.text}</span>
          </p>
          {(invoice.period || invoice.date) && (
            <p className="truncate tabular-nums text-ink-3" data-testid="renewal-last-invoice-period">
              {invoice.period ? `for ${invoice.period}` : `dated ${formatDate(invoice.date)}`}
            </p>
          )}
        </div>
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
