"use client";
/**
 * R-2759 (R-2739b, Pardeep 13 Nov screenshot + user audit 14 Nov): the Renewals TABLE row in
 * at most two lines per cell, so the table fits a 1280 laptop with the sidebar open (no
 * horizontal scroll, Action always on screen) and about ten renewals show per screen.
 *
 *   Customer         name (link) / phone · email
 *   Product & period plan · seats · vendor / the next term's period · how it is paid
 *   Due              date / "in 6d" · "today" · "6d ago" (grey — the chip says Overdue / Due in)
 *   Amount           the renewal amount / + GST | incl. GST
 *   Status           ONE stage chip (R-2758) + flag icons; its note is the tooltip
 *   Last invoice     the newest invoice's state (never cut) / its number · period (+N earlier)
 *   Action           ONE button + ⋯ (RenewalActions)
 *
 * Every cell is min-w-0; ids, names and periods may truncate (the full text is the tooltip) —
 * money and status never do (owner rule: no ellipsis on money / status; they wrap instead).
 * The full document list (R-2748: last two invoices + the quote each came from) stays on the
 * card layout and in the row drawer (R-2740). Pure helpers tested in row-cells-r2759.test.ts.
 */
import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { termEndInclusive } from "@/lib/billing/schedule";
import type { RenewalStage } from "@/lib/renewals/stage";
import { renewalTermStart } from "./stage-input";
import {
  invoiceStatusWords, invoiceTotalWords, periodWords, quoteStateLabel,
  type DocTone, type LastDocs, type LastInvoice, type LastQuote,
} from "./last-docs";
import type { RowContact } from "./queue-data";

// ─── Pure helpers ───────────────────────────────────────────────────────────

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "1 Dec 26" — the table's short date (the full one is the tooltip). */
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

type TermSub = { renewal_date: string | null; term_months?: number | null; start_date?: string | null };

/** The term the renewal is for: start + inclusive end (the billing engine's termEndInclusive); null = no renewal date. */
export function nextTerm(sub: TermSub): { start: string; end: string; months: number } | null {
  const start = renewalTermStart(sub);
  if (!start) return null;
  const months = sub.term_months && sub.term_months > 0 ? sub.term_months : 12;
  return { start, end: termEndInclusive(start, months), months };
}

/** In words ("1 Dec 2026 – 30 Nov 2027"); null = no renewal date. */
export function nextTermWords(sub: TermSub): string | null {
  const t = nextTerm(sub);
  return t ? periodWords(t.start, t.end, t.months) : null;
}

/** The table's short form ("1 Dec 26 – 30 Nov 27"). */
export function nextTermShort(sub: TermSub): string | null {
  const t = nextTerm(sub);
  return t ? `${shortDate(t.start)} – ${shortDate(t.end)}` : null;
}

/**
 * The table's two status lines (code-review R-2759): the chip without the period (Product & period
 * already says it) and, under it, the day count / amount — so the chip never wraps past two lines and
 * "Overdue 3d" is on screen, not only in a tooltip.
 */
export function compactStage(stage: Pick<RenewalStage, "key" | "label" | "note">): { chip: string; line2: string | null } {
  const at = stage.label.indexOf(" · ");
  if ((stage.key === "invoiced" || stage.key === "ending") && at > 0) return { chip: stage.label.slice(0, at), line2: stage.label.slice(at + 3) };
  /* "Renewal quote sent" wrapped to two lines in the 152px column (measured) — "Quote sent"; the full words are the tooltip */
  if (stage.key === "sent" || stage.key === "draft" || stage.key === "quote-closed") {
    const head = (at > 0 ? stage.label.slice(0, at) : stage.label).replace(/^Renewal quote /, "Quote ").replace(/^Draft part quote/, "Draft quote");
    return { chip: head, line2: stage.note };
  }
  return { chip: stage.label, line2: stage.key === "invoiced" ? null : stage.note };
}

/** Under the date: "in 6d" / "today" / "6d ago"; null = no date. */
export function dueSubWords(days: number | null): string | null {
  if (days == null) return null;
  if (days === 0) return "today";
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}

/** The Last invoice cell: the newest invoice and the earlier ones (R-2748 reads up to two). */
export function lastInvoiceOf(docs: LastDocs | undefined): { invoice: LastInvoice | null; earlier: LastInvoice[] } {
  const list = docs ? (docs.invoices.length ? docs.invoices : docs.invoice ? [docs.invoice] : []) : [];
  return { invoice: list[0] ?? null, earlier: list.slice(1) };
}

// ─── Cells ──────────────────────────────────────────────────────────────────

const TONE: Record<DocTone, string> = {
  ok: "text-ink-2",
  warn: "font-medium text-ink",
  danger: "font-medium text-rose-600",
  muted: "text-ink-3",
};

/** `more`: facts the table row no longer shows (owner, next follow-up) — the name's tooltip until the drawer (R-2740). */
export function CustomerCell({ name, customerId, contact, more }: { name: string; customerId: string | null; contact: RowContact | undefined; more?: string | null }) {
  const nameTitle = more ? `${name} — ${more}` : name;
  const parts = [contact?.phone, contact?.email].filter(Boolean) as string[];
  return (
    <div className="min-w-0" data-cell="customer">
      {customerId ? (
        <Link href={`/customers/${customerId}` as never} className="block truncate font-semibold text-ink hover:underline" title={nameTitle}>{name}</Link>
      ) : (
        <p className="truncate font-semibold text-ink" title={nameTitle}>{name}</p>
      )}
      {parts.length ? (
        <p className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-ink-3" title={parts.join(" · ")}>
          {contact?.phone && (
            <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="inline-flex min-w-0 items-center gap-1 hover:text-ink">
              <Icon name="phone" size={11} className="shrink-0" /><span className="truncate">{contact.phone}</span>
            </a>
          )}
          {contact?.email && !contact.phone && (
            <a href={`mailto:${contact.email}`} className="inline-flex min-w-0 items-center gap-1 hover:text-ink">
              <Icon name="mail" size={11} className="shrink-0" /><span className="truncate">{contact.email}</span>
            </a>
          )}
        </p>
      ) : (
        <p className="mt-0.5 text-2xs text-ink-3">No contact on file</p>
      )}
    </div>
  );
}

export function ProductCell({ plan, seats, vendor, term, termShort, frequency, onOpen }: {
  plan: string | null; seats: number | null; vendor: string | null; term: string | null; termShort: string | null; frequency: string | null;
  /** R-2740: the product name opens the row drawer (keyboard reachable — the row press is mouse only). */
  onOpen?: () => void;
}) {
  const vendorWord = vendor ? vendor[0].toUpperCase() + vendor.slice(1) : null;
  const line1 = [plan, seats != null ? `${seats} seats` : null, vendorWord].filter(Boolean).join(" · ");
  /* line 2 = the period (short); the full period + how it is paid are its tooltip */
  const title2 = [term ? `Renews for ${term}` : null, frequency].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0" data-cell="product">
      <p className="truncate text-ink" title={line1}>
        {onOpen ? (
          <button type="button" onClick={onOpen} data-testid="renewal-open-drawer" aria-label={`${line1} — open details`}
            className="inline-block max-w-full truncate rounded-sm text-left align-top underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
            {line1}
          </button>
        ) : line1}
      </p>
      {termShort && <p className="mt-0.5 truncate text-2xs text-ink-3 tabular-nums" title={title2}>{termShort}</p>}
    </div>
  );
}

export function DueCell({ date, days }: { date: string | null; days: number | null }) {
  const sub = dueSubWords(days);
  return (
    <div className="min-w-0 tabular-nums" data-cell="due">
      {/* "26 Nov 26" — the 88px column (measured: "26 Nov 2026" spilled at 1280); the full date is the tooltip */}
      <p className="whitespace-nowrap text-ink" title={date ? formatDate(date) : undefined}>{date ? shortDate(date.slice(0, 10)) : "—"}</p>
      {sub && <p className="mt-0.5 whitespace-nowrap text-2xs text-ink-3">{sub}</p>}
    </div>
  );
}

export function LastInvoiceCell({ docs, loading, failed, canInvoices, canQuotes, todayIst }: {
  docs: LastDocs | undefined;
  loading: boolean;
  failed: boolean;
  canInvoices: boolean;
  canQuotes: boolean;
  todayIst: string;
}) {
  if (loading) return <p className="text-2xs text-ink-3">…</p>;
  if (failed) return <p className="text-2xs text-ink-3" title="Last invoice couldn't load — reload the page">Couldn&apos;t load</p>;
  const { invoice, earlier } = lastInvoiceOf(docs);
  if (!invoice) return <QuoteInstead quote={docs?.quote ?? null} canQuotes={canQuotes} todayIst={todayIst} />;
  const state = invoiceStatusWords(invoice, todayIst);
  const total = invoiceTotalWords(invoice);
  const more = earlier.length ? ` · +${earlier.length} earlier` : "";
  const title = [
    `Last invoice ${invoice.id}${invoice.date ? ` · dated ${formatDate(invoice.date)}` : ""} · ${total} · ${state.text}${invoice.period ? ` · for ${invoice.period}` : ""}`,
    ...earlier.map((e) => `Earlier invoice ${e.id} · ${invoiceTotalWords(e)} · ${invoiceStatusWords(e, todayIst).text}${e.period ? ` · for ${e.period}` : ""}`),
  ].join("\n");
  return (
    <div className="min-w-0 text-2xs" data-cell="invoice" data-testid="renewal-last-invoice-cell" title={title}>
      <p className={cn("break-words tabular-nums", TONE[state.tone])} data-testid="renewal-last-invoice-status">{state.text}</p>
      <p className="mt-0.5 truncate text-ink-3 tabular-nums">
        {canInvoices
          ? <Link href={invoiceHref(invoice.id) as never} className="font-mono underline underline-offset-2 hover:text-ink">{invoice.id}</Link>
          : <span className="font-mono">{invoice.id}</span>}
        {invoice.period ? ` · ${invoice.period}` : ""}{more}
      </p>
    </div>
  );
}

function QuoteInstead({ quote, canQuotes, todayIst }: { quote: LastQuote | null; canQuotes: boolean; todayIst: string }) {
  if (!quote) return <p className="text-2xs text-ink-3" data-cell="invoice">No invoice yet</p>;
  const state = quoteStateLabel(quote, todayIst);
  return (
    <div className="min-w-0 text-2xs" data-cell="invoice" title={`No invoice yet · last quote ${quote.id} · ${formatDate(quote.date)} · ${state}${quote.period ? ` · for ${quote.period}` : ""}`}>
      <p className="break-words text-ink-2">No invoice · quote {state}</p>
      <p className="mt-0.5 truncate text-ink-3 tabular-nums">
        {canQuotes
          ? <Link href={`/quotes/${encodeURIComponent(quote.id)}` as never} className="font-mono underline underline-offset-2 hover:text-ink">{quote.id}</Link>
          : <span className="font-mono">{quote.id}</span>}
        {quote.period ? ` · ${quote.period}` : ""}
      </p>
    </div>
  );
}
