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
 *   Last bill        the newest invoice's state (never cut) / its number · period /
 *                    R-2840: the last payment "Paid ₹40,000 · 2 Oct" or "No payment yet" (a 3rd line) /
 *                    R-2839: "History" (its own last line — opens the drawer on History; "+N earlier" removed)
 *   Action           ONE button + ⋯ (RenewalActions)
 *
 * Every cell is min-w-0; ids, names and periods may truncate (the full text is the tooltip) —
 * money and status never do (owner rule: no ellipsis on money / status; they wrap instead).
 * The full document list (R-2748: last two invoices + the quote each came from) stays on the
 * card layout and in the row drawer (R-2740). Pure helpers tested in row-cells-r2759.test.ts.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { termEndInclusive } from "@/lib/billing/schedule";
import type { RenewalStage } from "@/lib/renewals/stage";
import type { SubscriptionOwed } from "@/lib/renewals/owed";
import { renewalTermStart } from "./stage-input";
import {
  daysBetweenIst, docMoney, invoiceStatusWords, invoiceTotalWords, periodWords, priorDueInvoiceGap, quoteExpiryNote, quoteStateLabel, rowQuoteNote, shownInvoices,
  type ChipQuote, type DocTone, type LastDocs, type LastInvoice, type LastQuote,
} from "./last-docs";
import type { RowContact } from "./queue-data";
import { lastPaidSummary, type LastPaid } from "./last-paid";
import type { PaidLineWithReceipt } from "./last-paid-data";
import { toIstDate } from "@/lib/dates/ist";

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
  const list = shownInvoices(docs);
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
        <Link href={`/customers/${customerId}` as never} className="line-clamp-2 break-words font-semibold text-ink hover:underline" title={nameTitle}>{name}</Link>
      ) : (
        <p className="line-clamp-2 break-words font-semibold text-ink" title={nameTitle}>{name}</p>
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

/** R-2755: the subscription's own domain (subscriptions.domain), trimmed; none → null (the row shows nothing, no "—"). */
export function subscriptionDomain(sub: { domain?: string | null }): string | null {
  const d = sub.domain?.trim();
  return d ? d : null;
}

export function ProductCell({ plan, seats, vendor, term, termShort, frequency, domain = null, onOpen, together = null }: {
  plan: string | null; seats: number | null; vendor: string | null; term: string | null; termShort: string | null; frequency: string | null;
  /** R-2755: the subscription's domain (subscriptionDomain) — line 2, before the period. */
  domain?: string | null;
  /** R-2740: the product name opens the row drawer (keyboard reachable — the row press is mouse only). */
  onOpen?: () => void;
  /** R-2808: billed together last cycle → line 2 reads "Bills with <other plan>" (a button that opens Bill together). */
  together?: { text: string; title?: string; onClick: () => void } | null;
}) {
  const vendorWord = vendor ? vendor[0].toUpperCase() + vendor.slice(1) : null;
  const line1 = [plan, seats != null ? `${seats} seats` : null, vendorWord].filter(Boolean).join(" · ");
  /* line 2 = the domain (R-2755) + the period (short); the full period + how it is paid are its tooltip */
  const title2 = [term ? `Renews for ${term}` : null, frequency].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0" data-cell="product">
      <p className="text-ink" title={line1}>
        {onOpen ? (
          <button type="button" onClick={onOpen} data-testid="renewal-open-drawer" aria-label={`${line1} — open details`}
            className="line-clamp-2 w-full min-w-0 break-words rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
            {line1}
          </button>
        ) : <span className="line-clamp-2 break-words">{line1}</span>}
      </p>
      {together ? (
        /* R-2808: billed together last cycle — "Bills with <other plan>" takes the period's place (the period
           stays in the tooltip and the Due column shows when it starts); the button opens Bill together. */
        <p className="mt-0.5 flex min-w-0 items-baseline gap-x-1 text-2xs" title={title2 || undefined}>
          {domain && <span className="min-w-0 max-w-[55%] shrink truncate text-ink-2" title={domain} data-testid="renewal-row-domain">{domain} ·</span>}
          <button type="button" onClick={together.onClick} data-testid="renewal-bills-with" title={together.title ?? `${together.text} — bill them on one proforma`}
            className="min-w-0 shrink truncate rounded-sm text-left font-medium text-amber-ink underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
            {together.text}
          </button>
        </p>
      ) : domain ? (
        /* R-2755: one line — the domain first (cut with its full text on hover when long); the period follows
           where it fits and otherwise wraps out of sight (max-h one line): it stays in the tooltip, and the
           Due column shows the date it starts. */
        <p className="mt-0.5 flex max-h-[1lh] flex-wrap gap-x-1 overflow-hidden text-2xs" title={title2 || undefined}>
          <span className="min-w-0 max-w-full truncate text-ink-2" title={domain} data-testid="renewal-row-domain">{domain}</span>
          {termShort && <span className="shrink-0 whitespace-nowrap text-ink-3 tabular-nums">· {termShort}</span>}
        </p>
      ) : termShort && <p className="mt-0.5 truncate text-2xs text-ink-3 tabular-nums" title={title2}>{termShort}</p>}
    </div>
  );
}

/** R-2760 (R-2728 owner ask "expires in N days"): a sent quote's validity, short for the Due column; full words are the tooltip. */
export function quoteExpiryShort(expiresDate: string | null | undefined, todayIst: string): { text: string; title: string } | null {
  /* R-2767: only 3 days or less left, or expired — else the Due cell keeps its "in 6d" line */
  const title = quoteExpiryNote(expiresDate, todayIst);
  if (!title || !expiresDate) return null;
  const d = daysBetweenIst(todayIst, expiresDate);
  return { text: d > 0 ? `exp. in ${d}d` : d === 0 ? "exp. today" : "expired", title };
}

/** `note`: replaces the "in 6d" line (a sent quote's validity — the chip already says the day count).
 *  `title`: due-anchor.ts dueCellFacts' two-date words — the hover on the date and day count (R-2834). */
export function DueCell({ date, days, note, title }: { date: string | null; days: number | null; note?: { text: string; title: string } | null; title?: string | null }) {
  const sub = note ? note.text : dueSubWords(days);
  return (
    <div className="min-w-0 tabular-nums" data-cell="due" title={title ?? undefined}>
      {/* "26 Nov 26" — the 88px column (measured: "26 Nov 2026" spilled at 1280); the full date is the tooltip */}
      <p className="whitespace-nowrap text-ink" title={title ? undefined : date ? formatDate(date) : undefined}>{date ? shortDate(date.slice(0, 10)) : "—"}</p>
      {sub && <p className="mt-0.5 whitespace-nowrap text-2xs text-ink-3" title={note?.title} data-testid={note ? "due-quote-expiry" : undefined}>{sub}</p>}
    </div>
  );
}

export function LastInvoiceCell({ docs, loading, failed, canInvoices, canQuotes, todayIst, prior = null, stage = null, paidLine = null }: {
  docs: LastDocs | undefined;
  loading: boolean;
  failed: boolean;
  canInvoices: boolean;
  canQuotes: boolean;
  todayIst: string;
  /** R-2747 / R-2818: what the previous term still owes (queue item `prior`, the one owed rule); null = none / not read. */
  prior?: SubscriptionOwed | null;
  /** R-2841: the row's stage (null = not read yet: no quote line) — a quote its chip names is not repeated here. */
  stage?: ChipQuote | null;
  /** R-2840: the last payment line (LastPaidRowLine) — after the invoice line(s), before R-2841's quote note. */
  paidLine?: ReactNode;
}) {
  if (loading) return <p className="text-2xs text-ink-3" role="status" aria-busy="true" title="Last bill is loading…" data-testid="last-invoice-loading">Loading…</p>;
  if (failed) return <><p className="text-2xs text-ink-3" title="Last invoice couldn't load — reload the page">Couldn&apos;t load</p>{paidLine}</>;
  const { invoice, earlier } = lastInvoiceOf(docs);
  /* R-2747 / R-2752 (R-2760: kept in the table): money owed on the subscription with no unpaid invoice
     linked — say why, also next to a Paid / Cancelled invoice (line 2) */
  const gap = priorDueInvoiceGap(docs, prior, todayIst);
  const gapSpan = gap ? <span title={gap} data-testid="renewal-prior-due-no-invoice"> · {gap}</span> : null;
  if (!invoice && gap && !docs?.quote) {
    return (
      <div className="min-w-0 text-2xs" data-cell="invoice" title={gap}>
        <p className="text-ink-2">No unpaid invoice</p>
        <p className="mt-0.5 truncate text-ink-3" data-testid="renewal-prior-due-no-invoice">{gap}</p>
        {paidLine}
      </div>
    );
  }
  if (!invoice) return <><QuoteInstead quote={docs?.quote ?? null} canQuotes={canQuotes} todayIst={todayIst} gapLine={gapSpan} />{paidLine}</>;
  const state = invoiceStatusWords(invoice, todayIst);
  const total = invoiceTotalWords(invoice);
  /* R-2839: "+N earlier" is gone — the row's History button (under this cell) opens every document; the earlier
     invoices stay in this cell's tooltip */
  const note = rowQuoteNote(docs, stage);
  const noteState = note ? quoteStateLabel(note, todayIst) : "";
  const title = [
    `Last invoice ${invoice.id}${invoice.date ? ` · dated ${formatDate(invoice.date)}` : ""} · ${total} · ${state.text}${invoice.period ? ` · for ${invoice.period}` : ""}`,
    ...earlier.map((e) => `Earlier invoice ${e.id} · ${invoiceTotalWords(e)} · ${invoiceStatusWords(e, todayIst).text}${e.period ? ` · for ${e.period}` : ""}`),
    ...(gap ? [gap] : []),
    ...(note ? [`Quote ${note.id} · ${formatDate(note.date)} · ${noteState}${note.period ? ` · for ${note.period}` : ""}`] : []),
  ].join("\n");
  return (
    <div className="min-w-0 text-2xs" data-cell="invoice" data-testid="renewal-last-invoice-cell" title={title}>
      <p className={cn("break-words tabular-nums", TONE[state.tone])} data-testid="renewal-last-invoice-status">{state.text}</p>
      <p className="mt-0.5 truncate text-ink-3 tabular-nums">
        {canInvoices
          ? <Link href={invoiceHref(invoice.id) as never} className="font-mono underline underline-offset-2 hover:text-ink">{invoice.id}</Link>
          : <span className="font-mono">{invoice.id}</span>}
        {gapSpan ?? (invoice.period ? ` · ${invoice.period}` : "")}
      </p>
      {paidLine}
      {/* R-2841: a newer quote the chip does not name (e.g. accepted add-seats, not invoiced) — muted, linked.
          The ~80px column at 1280 (measured) cannot hold "Quote Q-F588-27-0031 · Rejected" on one line: "Quote <no.>"
          may truncate like the invoice number above (full text is the cell's tooltip); the state is its own line, never cut. */}
      {note && (
        <div className="mt-0.5 text-ink-3 tabular-nums" data-testid="renewal-row-quote-note">
          <p className="truncate">
            Quote {canQuotes
              ? <Link href={`/quotes/${encodeURIComponent(note.id)}` as never} className="font-mono underline underline-offset-2 hover:text-ink">{note.id}</Link>
              : <span className="font-mono">{note.id}</span>}
          </p>
          <p className="break-words" data-testid="renewal-row-quote-note-state">{noteState}</p>
        </div>
      )}
    </div>
  );
}

/**
 * R-2840 (renewals history audit H5): the table's "Last bill" 3rd line — the last payment from the
 * SAME last-paid read as the card layout (useRenewalLastPaid, no new query). Words:
 *   a receipt   "Paid ₹40,000 · 2 Oct" (the year added when not this year; "for 2 subs" when one
 *               payment covers several); a USD invoice's payment
 *               in dollars (₹ ÷ that invoice's fx rate — only when the invoice is on the row, else ₹
 *               as the books hold it, never a guessed rate); tooltip: full date · mode · receipt no.
 *               · invoice · "covers N subscriptions"
 *   no receipt  R-2752: a settled invoice → "Paid on invoice, no receipt"; money received on an
 *               invoice not yet settled (not cancelled) → "Part paid on invoice, no receipt"; when that
 *               invoice is an OLDER one → "Earlier bill paid, no receipt" — never "No payment yet" next
 *               to a Paid / Part paid invoice, never "Paid" under the newest invoice's "Unpaid"
 *   nothing     "No payment yet"
 */
export function lastPaidRowFacts({ paid, docs, todayIst }: { paid: LastPaid | undefined; docs: LastDocs | undefined; todayIst: string }):
  { kind: "paid" | "no-receipt" | "none"; text: string; title: string } {
  const invoices = shownInvoices(docs);
  if (paid) {
    const last: PaidLineWithReceipt = paid.last;
    const s = lastPaidSummary(last);
    const doc = invoices.find((i) => (last.invoiceId ? i.id === last.invoiceId : !!last.quoteId && i.sourceQuoteId === last.quoteId)) ?? null;
    const own = doc ? docMoney(doc, last.amount) : s.amount;
    /* a foreign invoice with no fx rate reads "₹8,000 (USD)" — keep plain ₹ then */
    const money = own.includes("(") ? s.amount : own;
    const day = toIstDate(last.receivedAt);
    const short = day.slice(0, 4) === todayIst.slice(0, 4) ? shortDate(day).replace(/ \d{2}$/, "") : shortDate(day);
    const title = [
      `Last payment ${money}${money !== s.amount ? ` (${s.amount})` : ""}`, formatDate(day), s.method,
      ...(last.receiptNo ? [`receipt ${last.receiptNo}`] : []),
      ...(s.doc ? [`for ${s.doc}`] : []),
      ...(s.shared ? [s.shared] : []),
    ].join(" · ");
    /* one payment for several subscriptions: say so on the row, never pass the whole amount off as this one's */
    return { kind: "paid", text: `Paid ${money}${last.covers > 1 ? ` for ${last.covers} subs` : ""} · ${short}`, title };
  }
  /* R-2752 rule (last-docs paidInvoiceOf: the first settled invoice — tone ok) over the SAME shown invoices; else money
     received on a not-settled, not-cancelled invoice. Each status worked out once. */
  const words = invoices.map((i) => invoiceStatusWords(i, todayIst));
  const settledAt = words.findIndex((w) => w.tone === "ok");
  const settled = settledAt >= 0 ? { id: invoices[settledAt].id, words: words[settledAt].text } : null;
  const partAt = invoices.findIndex((i, n) => i.paidAmount > 0 && words[n].text !== "Cancelled");
  const at = settledAt >= 0 && (partAt < 0 || settledAt <= partAt) ? settledAt : partAt;
  if (at >= 0) {
    const inv = invoices[at];
    const isSettled = at === settledAt;
    /* an OLDER invoice: never "Paid" right under the newest one's "Unpaid" */
    const text = at > 0 ? "Earlier bill paid, no receipt" : isSettled ? "Paid on invoice, no receipt" : "Part paid on invoice, no receipt";
    const title = isSettled
      ? `Invoice ${inv.id} is ${settled?.words ?? "Paid"}, but no payment receipt is linked in the app (advance, credit or old books)`
      : `Invoice ${inv.id} shows ${docMoney(inv, inv.paidAmount)} received, but no payment receipt is linked in the app`;
    return { kind: "no-receipt", text, title };
  }
  return { kind: "none", text: "No payment yet", title: "No payment received against this subscription's quotes or invoices in the app" };
}

export function LastPaidRowLine({ paid, docs, loading, failed, todayIst }: {
  paid: LastPaid | undefined;
  docs: LastDocs | undefined;
  /** Last paid — or, with no receipt, Last docs — still loading: hold the line, never a false "No payment yet". */
  loading: boolean;
  failed: boolean;
  todayIst: string;
}) {
  if (loading) return <p className="mt-0.5 text-2xs text-ink-3" data-testid="renewal-row-last-paid">…</p>;
  if (failed) {
    return <p className="mt-0.5 break-words text-2xs text-ink-3" data-testid="renewal-row-last-paid" title="Last payment couldn't load — reload the page">Last payment couldn&apos;t load</p>;
  }
  const f = lastPaidRowFacts({ paid, docs, todayIst });
  return (
    <p className={cn("mt-0.5 break-words text-2xs tabular-nums", f.kind === "paid" ? "text-ink-2" : "text-ink-3")} data-testid="renewal-row-last-paid" title={f.title}>{f.text}</p>
  );
}

/**
 * R-2839 (history audit H4): the row's "History" text button — the same drawer as the product name, opened
 * on its History section (?view=history). Table: under the Last bill cell; cards: under the last-docs lines.
 * A native button, so Enter / Space work; the accessible name starts with the visible word.
 */
export function HistoryButton({ onOpen, name, className }: { onOpen: () => void; name: string; className?: string }) {
  return (
    <button type="button" onClick={onOpen} data-testid="renewal-open-history" aria-label={`History — ${name}`}
      className={cn("mt-0.5 rounded-sm text-2xs font-medium text-amber-ink underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber", className)}>
      History
    </button>
  );
}

function QuoteInstead({ quote, canQuotes, todayIst, gapLine }: { quote: LastQuote | null; canQuotes: boolean; todayIst: string; gapLine?: ReactNode }) {
  if (!quote) return <p className="text-2xs text-ink-3" data-cell="invoice">No invoice yet</p>;
  const state = quoteStateLabel(quote, todayIst);
  return (
    <div className="min-w-0 text-2xs" data-cell="invoice" title={`No invoice yet · last quote ${quote.id} · ${formatDate(quote.date)} · ${state}${quote.period ? ` · for ${quote.period}` : ""}`}>
      <p className="break-words text-ink-2">No invoice · quote {state}</p>
      <p className="mt-0.5 truncate text-ink-3 tabular-nums">
        {canQuotes
          ? <Link href={`/quotes/${encodeURIComponent(quote.id)}` as never} className="font-mono underline underline-offset-2 hover:text-ink">{quote.id}</Link>
          : <span className="font-mono">{quote.id}</span>}
        {gapLine ?? (quote.period ? ` · ${quote.period}` : "")}
      </p>
    </div>
  );
}
