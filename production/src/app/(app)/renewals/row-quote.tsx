/**
 * R-2854 (Pardeep 16 Nov 2026, screenshot): the Renewals table row's quote line — under Product & period,
 * on EVERY row: THIS renewal's quote, "Quote Q-A378-27-0845 · Sent 3 Oct · ₹3,823" (the number opens the
 * quote), or "No renewal quote yet". One fact once: the Last bill column no longer names a quote, and the
 * Amount column no longer repeats the quote's total.
 *
 * Which quote: the one the row's stage names (the chip's quote — a sent / draft / closed renewal quote, or
 * the part proforma the row is waiting on), else the subscription's own renewal quote (last-docs.ts
 * `renewalQuoteId`: the linked renewal quote in any state, else the newest proforma of the renewal term's
 * first part). Read from the SAME Last docs read as the rest of the row (`linkedQuotes`) — no query per row.
 * State words: last-docs quoteStateLabel (Draft / Sent / Viewed / Accepted / Part paid / Paid / Invoiced /
 * Expired / Rejected / Cancelled — the quotes list's words).
 *
 * R-2866 (Pardeep 16 Nov 2026): the number no longer leaves Renewals. A click (Enter on the focused number) opens the
 * quote pop-up (`onPeek` → quote-peek-dialog.tsx); Ctrl / middle click still opens the quote's page in a new tab (it
 * stays a real link). Hover or keyboard focus on the number shows the app tooltip with EVERY product line of the quote
 * and its period — "Google Workspace Business Starter · 473 seats · 1 Oct–31 Oct 2026", a Bill together quote one line
 * per subscription, at most 6 then "+N more" (`lines`, read once for the rows on screen — quote-peek-data.ts).
 */
import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { docMoney, quoteStateLabel, type LastDocs, type RowQuote } from "./last-docs";
import { hoverLines, type PeekLine } from "./quote-peek";

export type RowRenewalQuote = (RowQuote & { known: true }) | { id: string; known: false };

/** null = no quote for this renewal. `known: false` = the stage names a quote the read did not return: its number only. */
export function rowRenewalQuote(docs: LastDocs | undefined, stage: { quoteId: string | null } | null | undefined): RowRenewalQuote | null {
  const list = docs?.linkedQuotes ?? [];
  const find = (id: string | null | undefined) => (id ? list.find((q) => q.id === id) ?? null : null);
  if (stage?.quoteId) {
    const named = find(stage.quoteId);
    return named ? { ...named, known: true } : { id: stage.quoteId, known: false };
  }
  const q = find(docs?.renewalQuoteId);
  return q ? { ...q, known: true } : null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sent" · "3 Oct" (the year added when it is not this year) · the quote's total in its own currency (null = not read). */
export function rowQuoteWords(q: RowQuote, todayIst: string): { state: string; when: string; money: string | null } {
  const day = `${Number(q.date.slice(8, 10))} ${MON[Number(q.date.slice(5, 7)) - 1]}`;
  return {
    state: quoteStateLabel(q, todayIst),
    when: q.date.slice(0, 4) === todayIst.slice(0, 4) ? day : `${day} ${q.date.slice(2, 4)}`,
    money: q.amount == null ? null : docMoney(q, q.amount),
  };
}

export const NO_RENEWAL_QUOTE = "No renewal quote yet";

/** The line stays ONE line (measured, R-2854): on a 1280 laptop's ~200px Product column it reads "Q-… · Sent 3 Oct"; the
    word "Quote" joins from a 1440 window and the quote's total from 1680, where the column has room for them. Both are
    always in the tooltip and the link's name. The class names below spell the same numbers (Tailwind needs them literal). */
export const QUOTE_LINE_WORD_FROM_PX = 1440;
export const QUOTE_LINE_MONEY_FROM_PX = 1680;

/**
 * The line itself. The number never breaks or truncates (nowrap); "· Sent 3 Oct" and "· ₹3,823" are whole
 * pieces that move to the next line if the column is too narrow — never cut mid-word.
 * `loading`: the documents (or the stage) are not read yet — hold the line, never a false "No renewal quote yet".
 */
/** R-2866: the hover card's body — the quote's facts (the line's title), then its product lines with their periods. */
export function QuoteHoverCard({ title, lines, peek, failed = false }: { title: string; lines: readonly PeekLine[] | undefined; peek: boolean; failed?: boolean }) {
  const { shown, more } = hoverLines(lines ?? []);
  return (
    <div data-testid="renewal-row-quote-hover" title="">
      <p className="font-medium">{title}</p>
      {lines === undefined ? <p className="opacity-80">{failed ? "Products couldn't load — reload the page" : "Loading products…"}</p>
        : shown.length === 0 ? <p className="opacity-80">No product lines on this quote</p>
        : (
          <ul className="mt-1 space-y-0.5">
            {shown.map((t, n) => <li key={n} className="break-words tabular-nums" data-testid="renewal-row-quote-hover-line">{t}</li>)}
          </ul>
        )}
      {more > 0 && <p className="mt-0.5 opacity-80" data-testid="renewal-row-quote-hover-more">+{more} more</p>}
      {peek && <p className="mt-1 opacity-80">Click to open the quote here</p>}
    </div>
  );
}

export function RenewalQuoteLine({ docs, stage, loading, failed, canQuotes, todayIst, lines, linesFailed, onPeek }: {
  /** R-2866: the lines read failed — the hover says so (never "Loading products…" for ever). */
  linesFailed?: boolean;
  /** R-2866: a quote's product lines (quote-peek-data.ts — one read for the rows on screen); undefined = not read yet. */
  lines?: (quoteId: string) => readonly PeekLine[] | undefined;
  /** R-2866: open the quote pop-up over Renewals. Absent → the number is a plain link to the quote's page. */
  onPeek?: (quoteId: string) => void;
  docs: LastDocs | undefined;
  stage: { quoteId: string | null } | null | undefined;
  loading: boolean;
  failed: boolean;
  canQuotes: boolean;
  todayIst: string;
}) {
  if (loading) return <p className="text-2xs leading-4 text-ink-3" data-testid="renewal-row-quote" aria-hidden>…</p>;
  if (failed) return <p className="text-2xs leading-4 text-ink-3" data-testid="renewal-row-quote" title="The renewal quote couldn't load — reload the page">Quote couldn&apos;t load</p>;
  const q = rowRenewalQuote(docs, stage);
  if (!q) return <p className="text-2xs leading-4 text-ink-3" data-testid="renewal-row-quote" data-quote="none">{NO_RENEWAL_QUOTE}</p>;
  const w = q.known ? rowQuoteWords(q, todayIst) : null;
  const title = w ? `Quote ${q.id} · ${w.state} · dated ${w.when}${w.money ? ` · ${w.money} incl. GST` : ""}` : `Quote ${q.id}`;
  /* a plain click opens the pop-up; Ctrl / Cmd / Shift / middle click keep the link's own behaviour (new tab) */
  const peek = onPeek ? (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onPeek(q.id);
  } : undefined;
  /* the app tooltip on the number (hover AND keyboard focus); title="" there stops the line's native title showing as a second bubble */
  const withCard = (link: ReactNode) => (
    <TooltipProvider delayDuration={150}><Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm whitespace-normal px-3 py-2 text-left leading-snug">
        <QuoteHoverCard title={title} lines={lines?.(q.id)} peek={!!peek} failed={linesFailed} />
      </TooltipContent>
    </Tooltip></TooltipProvider>
  );
  return (
    /* a div, not a p: the tooltip (a div with a list) is drawn inside it */
    <div className="flex min-w-0 flex-wrap gap-x-1 text-2xs leading-4 text-ink-2 tabular-nums" data-testid="renewal-row-quote" data-quote={q.id} title={title}>
      <span className="whitespace-nowrap">
        <span className="hidden min-[1440px]:inline">Quote{" "}</span>
        {canQuotes
          ? withCard(<Link href={`/quotes/${encodeURIComponent(q.id)}` as never} aria-label={`Quote ${q.id}`} aria-haspopup={peek ? "dialog" : undefined} onClick={peek} title="" data-testid="renewal-row-quote-number" className="rounded-sm font-mono underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">{q.id}</Link>)
          : <span className="font-mono">{q.id}</span>}
      </span>
      {/* "Sent 3 Oct" (the owner's words); any other state is not an event on that date — "Paid · 3 Oct" = paid, quote dated 3 Oct */}
      {w && <span className="whitespace-nowrap" data-testid="renewal-row-quote-state">· {w.state}{w.state === "Sent" ? " " : " · "}{w.when}</span>}
      {w?.money && <span className="hidden whitespace-nowrap min-[1680px]:inline" data-testid="renewal-row-quote-money">· {w.money}</span>}
    </div>
  );
}
