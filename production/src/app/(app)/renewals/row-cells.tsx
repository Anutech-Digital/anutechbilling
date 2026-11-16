"use client";
/**
 * R-2759 (R-2739b, Pardeep 13 Nov screenshot + user audit 14 Nov): the Renewals TABLE row in
 * at most two lines per cell, so the table fits a 1280 laptop with the sidebar open (no
 * horizontal scroll, Action always on screen) and about ten renewals show per screen.
 *
 *   Customer         name (link) / phone · email
 *   Product & period plan · seats · vendor / domain · the next term's period /
 *                    R-2854: this renewal's quote "Quote Q-… · Sent 3 Oct · ₹3,823" or "No renewal quote yet" (row-quote.tsx)
 *   Due              date / "in 6d" · "today" · "6d ago" (grey — the chip says Overdue / Due in)
 *   Amount           the renewal amount (one line, never broken) / + GST
 *   Status           ONE stage chip (R-2758) / ONE line: its flag in words (stage-flag.tsx), else the chip's note
 *   Last bill        R-2854: the invoice number (never cut) · period / its state — or, when it is Paid, the last
 *                    payment "Paid ₹40,000 · 2 Oct" ("Paid" said once) / R-2839: "History". No quote here (one fact once).
 *   Action           ONE button + ⋯ (RenewalActions)
 *
 * R-2854 (Chrome human test on staging, 16 Nov): rows were 119–161px tall at a 1920 window — the column widths now
 * grow with the window (queue.ts queueColCss) and every cell is at most three short lines there.
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
import { seatsAfterPlan } from "./plan-seats";
import {
  daysBetweenIst, docMoney, invoiceStatusWords, invoiceTotalWords, periodWords, priorDueInvoiceGap, quoteExpiryNote, shownInvoices,
  type DocTone, type LastDocs, type LastInvoice,
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
  /* R-2854 (accessibility-review, measured): rose-600 on the page background is 4.46:1 at 12px — the rose-ink token passes and follows the theme */
  danger: "font-medium text-rose-ink",
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
        <p className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs leading-4 text-ink-3" title={parts.join(" · ")}>
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
        <p className="mt-0.5 text-2xs leading-4 text-ink-3">No contact on file</p>
      )}
    </div>
  );
}

/** R-2755: the subscription's own domain (subscriptions.domain), trimmed; none → null (the row shows nothing, no "—"). */
export function subscriptionDomain(sub: { domain?: string | null }): string | null {
  const d = sub.domain?.trim();
  return d ? d : null;
}

/** R-2854 / R-2857: "· 5 seats" — "1 seat" for one — and nothing when the plan name already carries a seat count
    ("Business Starter (1 seats)" printed "… (1 seats) · 1 seats"). ONE rule for the row, the card and the drawer: plan-seats.ts. */
export const seatsWords = seatsAfterPlan;

/** R-2854: the table's Amount cell — "₹63,855/mo" on ONE line (it printed "₹63,855/m" + "o" in the 88px column);
    only when a very large figure cannot fit does the "/yr" part move to the next line as a whole — never mid-word.
    The quote's total is not repeated here (it is on the row's quote line). */
export function AmountTableCell({ text, gst, title }: { text: string; gst: string; /** e.g. "+ GST · Quote ₹92,040 incl. GST" (R-2751's note stays on hover) */ title?: string }) {
  const at = text.lastIndexOf("/");
  const [money, per] = at > 0 ? [text.slice(0, at), text.slice(at)] : [text, ""];
  return (
    <div data-cell="amount" title={title}>
      <p className="flex flex-wrap justify-end font-medium tabular-nums text-ink" data-testid="renewal-row-amount">
        <span className="whitespace-nowrap">{money}</span>{per && <span className="whitespace-nowrap">{per}</span>}
      </p>
      <p className="whitespace-nowrap text-2xs leading-4 text-ink-3">{gst}</p>
    </div>
  );
}

export function ProductCell({ plan, seats, vendor, term, termShort, frequency, domain = null, onOpen, together = null, quoteLine = null, period = null }: {
  /** R-2854: this renewal's quote line (RenewalQuoteLine) — the cell's last line, on every row. */
  quoteLine?: ReactNode;
  plan: string | null; seats: number | null; vendor: string | null; term: string | null; termShort: string | null; frequency: string | null;
  /** R-2755: the subscription's domain (subscriptionDomain) — line 2, before the period. */
  domain?: string | null;
  /** R-2740: the product name opens the row drawer (keyboard reachable — the row press is mouse only). */
  onOpen?: () => void;
  /** R-2808: billed together last cycle → line 2 reads "Bills with <other plan>" (a button that opens Bill together). */
  together?: { text: string; title?: string; onClick: () => void } | null;
  /**
   * R-2858: the period the row is ABOUT (due-anchor.ts duePeriodFacts) — the unpaid part the Due date refers to, else the
   * next term. Given, it replaces `term` / `termShort`; its tooltip says "Oct unpaid · Nov running (billed part Oct 2026)".
   */
  period?: { short: string; title: string } | null;
}) {
  const shownShort = period?.short ?? termShort;
  const vendorWord = vendor ? vendor[0].toUpperCase() + vendor.slice(1) : null;
  const line1 = [plan, seatsWords(plan, seats), vendorWord].filter(Boolean).join(" · ");
  /* line 2 = the domain (R-2755) + the period (short); the full period + how it is paid are its tooltip */
  const title2 = [period?.title ?? (term ? `Renews for ${term}` : null), frequency].filter(Boolean).join(" · ");
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
        <p className="mt-0.5 flex min-w-0 items-baseline gap-x-1 text-2xs leading-4" title={title2 || undefined}>
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
        <p className="mt-0.5 flex max-h-[1lh] flex-wrap gap-x-1 overflow-hidden text-2xs leading-4" title={title2 || undefined}>
          <span className="min-w-0 max-w-full truncate text-ink-2" title={domain} data-testid="renewal-row-domain">{domain}</span>
          {shownShort && <span className="shrink-0 whitespace-nowrap text-ink-3 tabular-nums">· {shownShort}</span>}
        </p>
      ) : shownShort && <p className="mt-0.5 truncate text-2xs leading-4 text-ink-3 tabular-nums" title={title2}>{shownShort}</p>}
      {quoteLine}
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
      {sub && <p className="mt-0.5 whitespace-nowrap text-2xs leading-4 text-ink-3" title={note?.title} data-testid={note ? "due-quote-expiry" : undefined}>{sub}</p>}
    </div>
  );
}

/** R-2854: the Last bill cell's payment — the same Last paid read as the cards (useRenewalLastPaid), with its loading / failed state. */
export interface RowPaid { paid: LastPaid | undefined; loading: boolean; failed: boolean }

/**
 * R-2854 — which of the two status lines the Last bill cell prints ("Paid" was said three times on one row):
 *  - the invoice is Paid and the payment line starts with "Paid" ("Paid ₹40,000 · 2 Oct", "Paid on invoice, no
 *    receipt") → the payment line alone;
 *  - the invoice says what is owed ("Unpaid · ₹…", "Overdue 12d · ₹…") and nothing was received → that state alone
 *    (no "No payment yet" under "Unpaid");
 *  - otherwise both (e.g. "Part paid · ₹700 due" + "Part paid on invoice, no receipt", "Unpaid" + "Earlier bill paid…").
 */
export function lastBillLines(state: { text: string } | null, paid: { kind: "paid" | "no-receipt" | "none"; text: string } | null): { state: boolean; paid: boolean } {
  if (!state) return { state: false, paid: !!paid };
  if (!paid) return { state: true, paid: false };
  if (paid.kind === "none") return { state: true, paid: false };
  return { state: !(state.text === "Paid" && paid.text.startsWith("Paid")), paid: true };
}

export function LastInvoiceCell({ docs, loading, failed, canInvoices, todayIst, prior = null, paid = null, historyButton = null }: {
  docs: LastDocs | undefined;
  loading: boolean;
  failed: boolean;
  canInvoices: boolean;
  todayIst: string;
  /** R-2747 / R-2818: what the previous term still owes (queue item `prior`, the one owed rule); null = none / not read. */
  prior?: SubscriptionOwed | null;
  /** R-2840: the last payment (the SAME Last paid read as the cards); null = the cell shows the invoice only. */
  paid?: RowPaid | null;
  /** R-2839 / R-2854: the row's History button — after the cell's last line, on that line where it fits (a wide window), else under it. */
  historyButton?: ReactNode;
}) {
  /* the last line + History share one wrapping row */
  const tail = (last: ReactNode) => <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">{last}{historyButton}</div>;
  if (loading) return tail(<p className="text-2xs leading-4 text-ink-3" role="status" aria-busy="true" title="Last bill is loading…" data-testid="last-invoice-loading">Loading…</p>);
  const paidRow = (hide = false) => (paid && !hide ? <LastPaidRowLine paid={paid.paid} docs={docs} loading={paid.loading} failed={paid.failed} todayIst={todayIst} /> : null);
  if (failed) {
    const line = <p className="text-2xs leading-4 text-ink-3" title="Last invoice couldn't load — reload the page">Couldn&apos;t load</p>;
    return paid ? <>{line}{tail(paidRow())}</> : tail(line);
  }
  const { invoice, earlier } = lastInvoiceOf(docs);
  /* R-2747 / R-2752 (R-2760: kept in the table): money owed on the subscription with no unpaid invoice
     linked — say why, also next to a Paid / Cancelled invoice (its own line) */
  const gap = priorDueInvoiceGap(docs, prior, todayIst);
  const gapLine = gap ? <p className="break-words text-ink-3" title={gap} data-testid="renewal-prior-due-no-invoice">{gap}</p> : null;
  if (!invoice) {
    /* R-2854: no quote here any more — this renewal's quote is the Product column's quote line (one fact once) */
    return (
      <div className="min-w-0 text-2xs leading-4" data-cell="invoice" title={gap ?? undefined}>
        <p className="text-ink-3">{gap ? "No unpaid invoice" : "No invoice yet"}</p>
        {gapLine}
        {tail(paidRow())}
      </div>
    );
  }
  const state = invoiceStatusWords(invoice, todayIst);
  const total = invoiceTotalWords(invoice);
  const settled = paid && !paid.loading && !paid.failed ? lastPaidRowFacts({ paid: paid.paid, docs, todayIst }) : null;
  const show = paid && !settled ? { state: true, paid: true } : lastBillLines(state, settled);
  /* R-2839: "+N earlier" is gone — the row's History button (under this cell) opens every document; the earlier
     invoices stay in this cell's tooltip */
  const title = [
    `Last invoice ${invoice.id}${invoice.date ? ` · dated ${formatDate(invoice.date)}` : ""} · ${total} · ${state.text}${invoice.period ? ` · for ${invoice.period}` : ""}`,
    ...earlier.map((e) => `Earlier invoice ${e.id} · ${invoiceTotalWords(e)} · ${invoiceStatusWords(e, todayIst).text}${e.period ? ` · for ${e.period}` : ""}`),
    ...(gap ? [gap] : []),
  ].join("\n");
  return (
    <div className="min-w-0 text-2xs leading-4" data-cell="invoice" data-testid="renewal-last-invoice-cell" title={title}>
      {/* the number is never cut (nowrap, shrink-0); the period follows where it fits and otherwise wraps out of
          sight (max-h one line) — it stays in the tooltip and in Product & period */}
      <p className="flex max-h-[1lh] min-w-0 flex-wrap gap-x-1 overflow-hidden text-ink-3 tabular-nums">
        {canInvoices
          ? <Link href={invoiceHref(invoice.id) as never} className="shrink-0 whitespace-nowrap font-mono underline underline-offset-2 hover:text-ink" data-testid="renewal-last-invoice-no">{invoice.id}</Link>
          : <span className="shrink-0 whitespace-nowrap font-mono" data-testid="renewal-last-invoice-no">{invoice.id}</span>}
        {invoice.period && <span className="whitespace-nowrap">· {invoice.period}</span>}
      </p>
      {(() => {
        const stateLine = show.state ? <p className={cn("min-w-0 break-words tabular-nums", TONE[state.tone])} data-testid="renewal-last-invoice-status">{state.text}</p> : null;
        const paidLine = paidRow(!show.paid);
        return paidLine ? <>{stateLine}{gapLine}{tail(paidLine)}</> : gapLine ? <>{stateLine}{tail(gapLine)}</> : tail(stateLine);
      })()}
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
  if (loading) return <p className="text-2xs leading-4 text-ink-3" data-testid="renewal-row-last-paid">…</p>;
  if (failed) {
    return <p className="break-words text-2xs leading-4 text-ink-3" data-testid="renewal-row-last-paid" title="Last payment couldn't load — reload the page">Last payment couldn&apos;t load</p>;
  }
  const f = lastPaidRowFacts({ paid, docs, todayIst });
  return (
    <p className={cn("min-w-0 break-words text-2xs leading-4 tabular-nums", f.kind === "paid" ? "text-ink-2" : "text-ink-3")} data-testid="renewal-row-last-paid" title={f.title}>{f.text}</p>
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
      className={cn("rounded-sm text-2xs font-medium leading-4 text-amber-ink underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber", className)}>
      History
    </button>
  );
}
