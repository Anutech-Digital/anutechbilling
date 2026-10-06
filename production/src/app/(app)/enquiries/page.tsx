/**
 * Enquiries — a Gmail-shaped sales inbox.
 *
 * ─── WHAT CHANGED, AND WHY IT WAS NOT COSMETIC ──────────────────────────────
 * This page used to offer folders called `untriaged`, `appended` and `skipped` —
 * the webhook's words for what IT did. "Appended" tells a salesperson nothing about
 * whether they owe someone a reply. The folders are now Inbox / Starred / Snoozed /
 * Converted Leads / Sent / Done / Spam, and the rules behind them live in
 * lib/inbound/folders.ts where they are tested.
 *
 * ─── TWO PANES, NOT THREE ───────────────────────────────────────────────────
 * The old layout gave folders a full pane of their own, which left the actual email
 * about a third of the screen. Folders are a rail; the list and the email get the
 * space, because reading the email is the job.
 *
 * ─── EVERY FILTER RULE IS IMPORTED, NONE IS WRITTEN HERE ────────────────────
 * parseSearch/matchesSearch and inFolder come from lib/inbound. A page that grew its
 * own copy of "what does is:unread mean" is how the folder list and the search box
 * end up disagreeing about the same mail.
 */
"use client";

import * as React from "react";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate, rupee } from "@/lib/utils";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useQuotes } from "@/lib/queries/quotes";
import { useLead } from "@/lib/queries/leads";
import { answeredState, answeredNote, quoteButtonLabel, answeredTone } from "@/lib/inbound/answered";
import { matchQuotesToEnquiry, weakestBasis, basisCaveat } from "@/lib/inbound/quote-match";
import { useInboundEmailPages, useConvertInboundToLead, useSetInboundState, useEmailSender } from "@/lib/queries/inbound-emails";
import { enquiryBadge, canConvertToLead } from "@/lib/inbound/status";
import { isBounce, bouncedAddress } from "@/lib/inbound/bounce";
import {
  MAIL_FOLDERS, inFolder, folderCounts, inboxUnread, snoozePresets, isSnoozed,
  type MailFolder,
} from "@/lib/inbound/folders";
import {
  parseSearch, matchesSearch, isEmptySearch, SUPPORTED_OPERATORS,
} from "@/lib/inbound/search";
import { groupIntoThreads, threadFor } from "@/lib/inbound/threads";
import { isSentReply, sentFromNote } from "@/lib/inbound/sent";
import { extractEntities, foundCount, type ExtractedEntities } from "@/lib/inbound/extract";
import { useItems } from "@/lib/queries/items";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { ReplyComposer } from "@/components/features/enquiries/reply-composer";
import { FolderChips, AddLeadButton, SetUpEmailButton } from "./mobile-folders";
import { dialable } from "@/lib/leads/call-queue";
import type { InboundEmailRow } from "@/lib/supabase/database.types";

/* ── Small presentational helpers ──────────────────────────────────────────── */

const FOLDER_IDS: readonly MailFolder[] = MAIL_FOLDERS.map((f) => f.id);

function senderLabel(e: InboundEmailRow): string {
  /* A reply WE sent has no from_email — it left from the tenant's connected account. The
     useful label there is who it went TO, not "Unknown sender", which is what a bare
     from_email fallback produced and which reads as data loss. */
  if (isSentReply(e)) return e.to_email ? `To ${e.to_email}` : "Reply you sent";
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

function initials(e: InboundEmailRow): string {
  const parts = senderLabel(e).split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : senderLabel(e).slice(0, 2)).toUpperCase();
}

/** "3m", "2h", "5 Aug" — a mail from this morning does not need a date. */
function shortWhen(iso: string, nowMs: number): string {
  const mins = Math.floor((nowMs - new Date(iso).getTime()) / 60_000);
  if (mins < 1)    return "now";
  if (mins < 60)   return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return formatDate(iso);
}

/** First readable line of the body, for the list row. */
function snippet(e: InboundEmailRow): string {
  const text = e.body_text?.trim()
    /* body_html is a fallback, tags stripped. Never rendered as HTML anywhere on
       this page — an inbound email is untrusted input and this list is not the
       place to find that out. */
    || (e.body_html ? e.body_html.replace(/<[^>]+>/g, " ") : "");
  return text.replace(/\s+/g, " ").slice(0, 140);
}

/**
 * One extracted field.
 *
 * A missing value says "not found" rather than showing a blank — a blank row reads
 * as a rendering bug, and the rep cannot tell it apart from a value that failed to
 * load. The `source` under it is the text it was read from, so the rep who signs the
 * quote can check it.
 */
function Detail({ label, e }: { label: string; e: { value: string | number | null; source: string | null } }) {
  return (
    <div>
      <dt className="text-3xs uppercase tracking-wider text-ink-3">{label}</dt>
      {e.value == null ? (
        <dd className="text-[12px] italic text-ink-3">not found</dd>
      ) : (
        <>
          <dd className="break-words text-[13px] font-medium text-ink">{e.value}</dd>
          {e.source && (
            <dd className="mt-0.5 break-words text-xs leading-snug text-ink-3">
              from “{e.source.length > 60 ? `${e.source.slice(0, 60)}…` : e.source}”
            </dd>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Prefill link into the quote builder, from what the extractor actually FOUND.
 *
 * A field it could not find is left OUT of the URL rather than sent empty. The
 * builder already reads company/plan/seats/contact/email/phone (quote-builder.tsx:97),
 * and an empty `seats=` would land in the form as a value someone has to notice and
 * clear — a guessed seat count becomes a price on a signed quote.
 */
function quoteHref(e: InboundEmailRow, ent: ExtractedEntities | null): string {
  const p = new URLSearchParams();

  /* THE LEAD ID, WHICH WAS MISSING AND BROKE THREE THINGS
     This never passed the lead id, so a quote raised from an enquiry saved with
     lead_id = null (quote-builder.tsx:824 sets it only in lead mode). Three
     consequences, all found on live data:

       - The enquiry could never know it had been answered. That check joins on
         lead_id, so the "already quoted" banner could not fire however well it was
         written. My own previous fix was unreachable.
       - The lead kept no quote history, so its stage never advanced to `quote`.
       - And it happened: Q-ADPL-2026-27-0010 and -0011, both for Rs 1,34,138, fifteen
         minutes apart, for one enquiry. The duplicate Pardeep predicted, already in
         the books.

     One missing parameter, three symptoms. */
  if (e.lead_id) p.set("leadId", e.lead_id);

  /* A PERSON IS NOT A COMPANY
     This was `ent?.name.value ?? e.from_name`, and `ent.name` is the SENDER’S name --
     so both quotes above went out addressed to "Pardeep Sharma" rather than to Excel
     Technologies. On a document that becomes a tax invoice, the bill-to party is not a
     courtesy field.

     With the lead id passed the builder loads the lead and uses its company. Where
     there is no lead, the field is left EMPTY rather than filled with a person: an
     operator fills a blank, but has to notice a wrong party.

     The extractor has no `company` field at all -- only `name`, which is a person
     (extract.ts:33). So with no lead there is genuinely nothing to put here, and the
     honest move is to set nothing. */
  if (ent?.product.value)   p.set("plan", ent.product.value.name);
  if (ent?.seats.value)     p.set("seats", String(ent.seats.value));
  if (ent?.name.value)      p.set("contact", ent.name.value);
  if (ent?.email.value ?? e.from_email) p.set("email", (ent?.email.value ?? e.from_email)!);
  if (ent?.phone.value)     p.set("phone", ent.phone.value);
  const qs = p.toString();
  return qs ? `/quotes/new?${qs}` : "/quotes/new";
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function EnquiriesPage() {
  /* Keyset pages (S37). Page 1 is the same newest-500 the flat hook returned; folder counts
     and search cover what is LOADED, and "Load older mail" is how anything past page 1 is
     reached — before this it could not be reached at all. */
  const {
    data: rows, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage,
  } = useInboundEmailPages();
  const olderMail = hasNextPage ? (
    <div className="px-3 py-2.5 text-center">
      <Button size="sm" variant="ghost" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
        Load older mail
      </Button>
      <p className="mt-1 text-xs text-ink-3">
        Counts and search cover the mail loaded so far — older mail may be in this folder too.
      </p>
    </div>
  ) : null;
  const setState = useSetInboundState();
  const convert  = useConvertInboundToLead();

  /* R-286: folder and search live in the URL — open a lead/quote from an enquiry,
     press Back, and the same folder and search are still there. */
  const [folder, setFolder]         = useUrlChoice<MailFolder>("folder", FOLDER_IDS, "inbox");
  const [query, setQuery]           = useUrlState("q");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = React.useState(false);
  const [helpOpen,   setHelpOpen]   = React.useState(false);

  /* ── "Now", pinned and refreshed on a timer ───────────────────────────────
     Snoozing is judged against the clock on every read (lib/inbound/folders.ts),
     so a page left open all afternoon has to notice its own snoozes expiring. A
     bare new Date() in render would also change every keystroke and defeat every
     useMemo below. One minute is finer than any snooze this offers. */
  const [nowISO, setNowISO] = React.useState(() => new Date().toISOString());
  React.useEffect(() => {
    const t = setInterval(() => setNowISO(new Date().toISOString()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowMs = React.useMemo(() => new Date(nowISO).getTime(), [nowISO]);

  const all      = React.useMemo(() => rows ?? [], [rows]);
  const parsed   = React.useMemo(() => parseSearch(query), [query]);
  const counts   = React.useMemo(() => folderCounts(all, nowISO), [all, nowISO]);
  const unread   = React.useMemo(() => inboxUnread(all, nowISO), [all, nowISO]);

  const visible = React.useMemo(() => {
    const inThisFolder = all.filter((r) => inFolder(r, folder, nowISO));
    return isEmptySearch(parsed) ? inThisFolder : inThisFolder.filter((r) => matchesSearch(r, parsed));
  }, [all, folder, nowISO, parsed]);

  /* One row per CONVERSATION. The grouping is a heuristic — inbound_emails has no
     In-Reply-To or References header — and the reading pane says so. */
  const threads = React.useMemo(() => groupIntoThreads(visible), [visible]);

  const selectedThread = React.useMemo(
    () => (selectedId ? threadFor(threads, selectedId) : null),
    [threads, selectedId],
  );
  const selected = selectedThread?.latest ?? null;

  /* Who the reply is signed by. Null while it loads, and reply-pills.ts then leaves the
     draft UNSIGNED rather than signing it with a placeholder — the same rule as
     lib/whatsapp.ts, where the wrong company name once went out on live reminders. */
  const { data: me } = useCurrentUser();
  const tenantName = me?.tenantName ?? null;

  /* The tenant's own catalogue, so the extractor matches real SKUs instead of
     guessing a plan name out of the prose. */
  const { data: items } = useItems();
  const catalogue = React.useMemo(
    () => (items ?? []).map((i) => ({ id: i.id, name: i.name })),
    [items],
  );

  /* ── Already quoted? ──────────────────────────────────────────────────────
     This used to ask useQuotesByLead(), and that was nearly useless: eleven of the
     thirteen quotes in ANUTECH's live books carry lead_id = null, INCLUDING the two
     ₹1,34,138 duplicates fifteen minutes apart that this banner exists to prevent. It
     could not see either, so the screen said "Send quote" and would have allowed a third.

     lead_id, customer name and company are all filed differently depending on where the
     builder was opened from, so the match reads all of them and REPORTS which one it used
     — see lib/inbound/quote-match.ts. */
  const { data: allQuotes } = useQuotes();
  /* WC-scale: the ONE lead this enquiry is filed against, read by id. It used to be looked
     up in useLeads() — every lead, cut at PostgREST's 1000 rows — so an enquiry on an older
     lead found no lead at all. */
  const { data: enquiryLeadRow } = useLead(selected?.lead_id ?? undefined);
  const enquiryLead = selected?.lead_id ? enquiryLeadRow ?? null : null;

  const matchedQuotes = React.useMemo(
    () => matchQuotesToEnquiry(
      {
        leadId: selected?.lead_id ?? null,
        names: [enquiryLead?.company, enquiryLead?.contact_name, selected?.from_name],
      },
      (allQuotes ?? []).map((q) => ({
        id: q.id,
        createdAt: q.created_at ?? q.created_date ?? "",
        amount: q.amount ?? 0,
        status: q.status,
        leadId: q.lead_id,
        customerId: q.customer_id,
        customerName: q.customer_name,
      })).filter((q) => q.createdAt),
    ),
    [selected?.lead_id, selected?.from_name, enquiryLead, allQuotes],
  );

  const answered = React.useMemo(
    () => answeredState(selected?.created_at ?? new Date(0).toISOString(), matchedQuotes),
    [selected?.created_at, matchedQuotes],
  );
  /* The WEAKEST basis, so a name-only match can never ride on a lead match's confidence. */
  const answeredCaveat = basisCaveat(weakestBasis(matchedQuotes));

  const entities: ExtractedEntities | null = React.useMemo(() => {
    if (!selectedThread) return null;
    /* Read across the WHOLE conversation, newest first — a seat count usually
       arrives in a later reply, not the opening "can you send a quote". */
    const newestFirst = [...selectedThread.messages].reverse();
    const merged = extractEntities({
      fromName:  newestFirst[0].from_name,
      fromEmail: newestFirst[0].from_email,
      subject:   newestFirst.map((m) => m.subject ?? "").join("\n"),
      body:      newestFirst.map((m) => m.body_text ?? "").join("\n\n"),
      catalogue,
    });
    return merged;
  }, [selectedThread, catalogue]);

  /* Opening a conversation marks its unread messages read — all of them, the way a
     mail client does. An effect on the selection rather than the click handler, so
     it also fires when the selection survives a list change. */
  React.useEffect(() => {
    if (!selectedThread) return;
    for (const m of selectedThread.messages) {
      if (m.read_at == null) setState.mutate({ id: m.id, read: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThread?.key]);

  /* A folder change drops the selection: keeping it would leave the reading pane
     showing an email that is no longer in the list beside it. */
  React.useEffect(() => { setSelectedId(null); setSnoozeOpen(false); }, [folder]);

  /* ── j / k through the conversation list ──────────────────────────────────
     In a two-pane inbox the selection IS the preview, so moving with j/k opens the
     conversation as it goes — the way a mail client behaves. A separate "cursor" that
     needed Enter to preview would mean two keys to read each email, which is slower than
     the mouse and would go unused.

     Disabled while the snooze menu is open, so j/k does not scroll the list out from
     under a menu the operator is aiming at. */
  const enquiryKeys = useListKeys({
    count: threads.length,
    enabled: !snoozeOpen,
    onOpen: (i) => { const t = threads[i]; if (t) setSelectedId(t.latest.id); },
  });
  React.useEffect(() => {
    const t = threads[enquiryKeys.index];
    if (t) setSelectedId(t.latest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enquiryKeys.index]);

  /* WhatsApp target. `dialable` is imported from lib/leads/call-queue rather than
     rewritten — it already handles the Indian trunk-prefix case that makes wa.me
     fail silently, and it has the test that found it. */
  const waNumber = React.useMemo(() => dialable(entities?.phone.value), [entities]);
  const waHref = waNumber && selected
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(
        `Hi${entities?.name.value ? ` ${entities.name.value}` : ""}, thanks for your enquiry${
          selected.subject ? ` about ${selected.subject}` : ""
        }. Happy to help — when is a good time to talk?`,
      )}`
    : null;

  /* A reply WE sent is not something to convert, quote or reply to — it is a record of
     work already done, so the sales toolbar and the composer are hidden on it. */
  const viewingSentReply = selected != null && isSentReply(selected);

  /* ── A BOUNCE IS NOT AN ENQUIRY, IT IS THE OPPOSITE ────────────────────────
     Four of the seventeen mails in this Inbox on 30 Aug 2026 were delivery failures,
     and the screen treated each as work owed to a customer: badge "ignored", and a
     "Send quote" button aimed at mailer-daemon@googlemail.com.

     The news is the reverse of that. A quote WE sent never arrived, so somebody is
     waiting for a document they will never receive — and the longer it sits looking
     like an enquiry, the longer nobody fixes the address. */
  const viewingBounce = selected != null && isBounce(selected);
  const bouncedTo     = React.useMemo(() => bouncedAddress(selected), [selected]);
  const { data: emailSender } = useEmailSender();

  const folderMeta = MAIL_FOLDERS.find((f) => f.id === folder)!;

  return (
    /* ── ONE SURFACE, NOT THREE FLOATING CARDS ──────────────────────────────────
       This page is a mail client, and it was sizing itself to its contents: with one
       message in the inbox the whole three-pane layout collapsed to 274px in a 722px
       window, and the three panes ended up 261 / 156 / 272 tall — three ragged boxes with
       a large blank area underneath. Reported as "the page looks scattered", which is
       exactly what it looked like.

       A fixed-height flex column fixes both: the header keeps its natural height, the mail
       row takes everything left, and each pane fills it. Every pane below scrolls
       INTERNALLY — /leads taught this the hard way, where a bounded page and a child that
       could not scroll silently hid 15 of 17 rows. */
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto flex flex-col h-[calc(100vh-3.5rem-4rem)] md:h-[calc(100vh-3.5rem)]">
      <header className="mb-4 shrink-0">
        <h1 className="font-serif text-2xl text-ink">Enquiries</h1>
        <p className="text-sm text-ink-3 mt-0.5">
          Every email that came in, and what you still owe an answer on.
        </p>
      </header>

      {/* ── Search, full width above everything ──────────────────────────── */}
      <div className="mb-4 shrink-0">
        <div className="relative">
          <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail — try from:sujay, is:unread, has:attachment"
            className="pl-9"
            aria-label="Search enquiries"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              aria-label="Clear search"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        {/* An operator we cannot honour is SAID OUT LOUD. Silently ignoring it
            would return every email and look like it filtered — see search.ts. */}
        {parsed.unknown.length > 0 && (
          <div className="mt-2 rounded-md border border-amber bg-amber-soft px-3 py-2">
            <p className="text-[12px] leading-snug text-amber-ink">
              <span className="font-semibold">
                {parsed.unknown.join(", ")} {parsed.unknown.length === 1 ? "is" : "are"} not something this search understands
              </span>{" "}
              — the results below ignore it, so they are wider than you asked for.
              Supported: {SUPPORTED_OPERATORS.join("  ")}
            </p>
          </div>
        )}
      </div>

      {/* flex-1 min-h-0: take the rest of the column, and let the children shrink so
          their own overflow-y-auto can work. Without min-h-0 a flex child keeps its
          content height and overflows the parent instead of scrolling — the near-miss
          that makes a scroll fix look applied when it is not. */}
      <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
        {/* ── Folder rail ───────────────────────────────────────────────── */}
        <nav className="hidden md:block w-[190px] shrink-0 overflow-y-auto" aria-label="Mail folders">
          <ul className="space-y-0.5">
            {MAIL_FOLDERS.map((f) => {
              const isActive = f.id === folder;
              const count = counts[f.id];
              const badge = f.id === "inbox" ? unread : 0;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setFolder(f.id)}
                    aria-current={isActive ? "page" : undefined}
                    /* Do number ko alag-alag naam mil jata hai — hover par aur screen
                       reader par. Bina iske "2  14" sirf do ginti hain jinme se ek
                       galat lagti hai; §8 waise bhi har control ka naam maangta hai. */
                    title={`${f.label} — ${count} conversation${count === 1 ? "" : "s"}${
                      badge > 0 ? `, ${badge} unread` : ""
                    }`}
                    aria-label={`${f.label}, ${count} conversation${count === 1 ? "" : "s"}${
                      badge > 0 ? `, ${badge} unread` : ""
                    }`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                      isActive ? "bg-paper-2 font-semibold text-ink" : "text-ink-2 hover:bg-paper-2/60",
                    )}
                  >
                    <span aria-hidden className="text-[15px] leading-none">{f.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{f.label}</span>
                    {/* ── DONO, YA TO NAHI — 30 Aug 2026 ────────────────────
                        Ye pehle `badge > 0 ? unread : count` tha, yaani ya-to-ya. Jaise hi
                        ek mail unread hua, kul ginti GAYAB ho gayi aur uski jagah laal
                        unread aa gaya. Screen par bacha: rail par "2", aur uske theek bagal
                        me list ka header "INBOX (14)".

                        Dono sahi the — 14 baat-cheet, unme se 2 anpadhi — par saath-saath
                        do bina-naam ke number ek doosre ko jhutlate hain. Aaj hi rail ki
                        "17 vs 12" wali gadbad theek ki gayi thi, aur wo ise dekh kar dobara
                        poochhi gayi: "kya ye theek hai?" Sawaal hi jawab hai.

                        Ab dono dikhte hain, aur kul ginti hamesha wahi rehti hai jo header
                        me hai — laal pill chahe ho ya na ho. */}
                    <span className="flex shrink-0 items-center gap-1.5">
                      {badge > 0 && (
                        <Badge kind="danger" size="sm">{badge}</Badge>
                      )}
                      {count > 0 && (
                        <span className="text-xs tabular-nums text-ink-3">{count}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Phone folders (R-209): the rail would eat the screen (CLAUDE.md §20), so a row
            of chips that scrolls inside itself. The old "Inbox ▾" <select> hid six of the
            seven folders from anyone who never opened it. */}
        <FolderChips folder={folder} counts={counts} unread={unread} onPick={setFolder} />

        {/* ── Pane 1: the list ──────────────────────────────────────────── */}
        <div className={cn(
          "min-w-0 flex-1",
          /* On a phone the two panes take turns — a 375px screen cannot hold both,
             and a squeezed reading pane is unreadable. */
          selected ? "hidden lg:block lg:max-w-[380px]" : "block lg:max-w-[380px]",
        )}>
          <Card className="p-0 overflow-hidden h-full flex flex-col">
            <div className="flex items-center justify-between border-b border-hairline px-3 py-2 shrink-0">
              <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                {folderMeta.icon} {folderMeta.label}
                {threads.length > 0 && <span className="ml-1.5 tabular-nums">({threads.length})</span>}
              </span>
              <Button variant="ghost" size="sm" onClick={() => refetch()} icon="refresh" aria-label="Refresh">
                Refresh
              </Button>
            </div>

            {isLoading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : error ? (
              <div className="p-4">
                <EmptyState
                  icon="alert"
                  title="Could not load your enquiries"
                  body={(error as Error).message}
                  action={<Button size="sm" onClick={() => refetch()}>Try again</Button>}
                />
              </div>
            ) : threads.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon="inbox"
                  title={isEmptySearch(parsed) ? `${folderMeta.label} is empty` : "Nothing matches that search"}
                  body={isEmptySearch(parsed)
                    ? folderMeta.hint
                    : `No mail in ${folderMeta.label} matches “${query}”. It may be in another folder.`}
                  action={isEmptySearch(parsed)
                    ? (folder !== "inbox"
                        ? <Button size="sm" variant="ghost" onClick={() => setFolder("inbox")}>Go to Inbox</Button>
                        : <AddLeadButton />)
                    : <Button size="sm" variant="ghost" onClick={() => setQuery("")}>Clear search</Button>}
                  secondary={isEmptySearch(parsed) && folder === "inbox"
                    ? <SetUpEmailButton />
                    : undefined}
                />
                {/* R-192 (6 Oct 2026, from Pardeep's cloud session — re-written here after review,
                    because that branch lives on the public old repo). An empty Inbox says how
                    mail gets here and where to set it up, instead of bare text. */}
                {isEmptySearch(parsed) && folder === "inbox" && (
                  <p data-testid="enquiries-empty-guidance" className="mx-auto mt-2 max-w-md text-center text-xs leading-relaxed text-ink-3">
                    Enquiries arrive here when a customer emails your sales address or fills in your
                    buy-page form. Use the folder list (Starred, Snoozed, Converted Leads, Sent,
                    Done) to sort them once they do.
                  </p>
                )}
                {olderMail}
              </div>
            ) : (
              /* Was max-h-[calc(100vh-260px)]: a magic number measured against a header
                 that grows — the unsupported-search-operator warning appears above this
                 list and pushed the bottom off screen. flex-1 min-h-0 needs no number. */
              <ul className="divide-y divide-hairline flex-1 min-h-0 overflow-y-auto">
                {threads.map((t) => {
                  const e = t.latest;
                  /* A conversation is unread if ANY message in it is — the badge has
                     to survive a new reply landing on a thread you already opened. */
                  const isUnread = t.messages.some((m) => m.read_at == null);
                  const isSel = t.key === selectedThread?.key;
                  return (
                    <li key={t.key}>
                      <div className={cn(
                        "flex items-start gap-2 px-3 py-2.5",
                        isSel && "bg-paper-2",
                        !isSel && "hover:bg-paper-2/50",
                      )}>
                        {/* Star is its own control, not part of opening the mail —
                            flagging something you have not read is a real move. */}
                        <button
                          type="button"
                          onClick={() => setState.mutate({ id: e.id, starred: !e.starred })}
                          aria-label={e.starred ? "Remove star" : "Star this enquiry"}
                          aria-pressed={e.starred}
                          className="mt-0.5 shrink-0 text-[14px] leading-none"
                        >
                          <span className={e.starred ? "" : "opacity-25"}>⭐</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedId(e.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={cn(
                              "truncate text-[13px]",
                              isUnread ? "font-semibold text-ink" : "text-ink-2",
                            )}>
                              {senderLabel(e)}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-ink-3">
                              {shortWhen(e.created_at, nowMs)}
                            </span>
                          </div>
                          <p className={cn(
                            "truncate text-[13px]",
                            isUnread ? "font-medium text-ink" : "text-ink-2",
                          )}>
                            {e.subject || "(no subject)"}
                            {!t.isSingle && (
                              <span className="ml-1.5 text-xs tabular-nums text-ink-3">
                                ({t.messages.length})
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-ink-3">{snippet(e) || "—"}</p>
                        </button>

                        <span className="mt-0.5 shrink-0 text-[13px] leading-none" aria-hidden>
                          {initials(e)}
                        </span>
                      </div>
                    </li>
                  );
                })}
                {olderMail && <li>{olderMail}</li>}
              </ul>
            )}
          </Card>
        </div>

        {/* ── Pane 2: the email ─────────────────────────────────────────── */}
        <div className={cn("min-w-0 flex-1", selected ? "block" : "hidden lg:block")}>
          {!selected ? (
            <Card className="h-full">
              {/* min-h dropped: the row now has a real height, so h-full is a height and
                  not zero. The 240px floor was propping up a pane that had nothing to
                  fill. */}
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-ink-3">Pick an enquiry to read it.</p>
              </div>
            </Card>
          ) : (
            /* h-full + its own scroll: a long email must scroll INSIDE the pane. Without
               this the bounded row clips it and the end of the mail is unreachable with no
               scrollbar anywhere — exactly what happened to 15 of 17 leads. */
            <Card className="p-0 overflow-hidden h-full flex flex-col">
              <div className="border-b border-hairline p-4 shrink-0">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-serif text-lg leading-snug text-ink">
                      {selected.subject || "(no subject)"}
                    </h2>
                    <p className="mt-0.5 text-[12px] text-ink-3">
                      {senderLabel(selected)}
                      {selected.from_email && selected.from_name && ` · ${selected.from_email}`}
                      {" · "}{formatDate(selected.created_at)}
                    </p>
                    {/* Where the copy actually is. Pardeep sent a reply and then hunted
                        for it in sales@anutech.in, where it was never going: the connected
                        account is a different address, and the reply itself went to the
                        customer. See lib/inbound/sent.ts. */}
                    {viewingSentReply && (
                      <p className="mt-1 text-xs leading-snug text-ink-3">
                        {sentFromNote(emailSender?.address)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="lg:hidden shrink-0 text-ink-3 hover:text-ink"
                    aria-label="Back to list"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* enquiryBadge, not inboundStatusMeta: a bounce and a no-reply security
                      alert both carry status `ignored`, and they are opposite news. See
                      lib/inbound/status.ts. */}
                  <Badge kind={enquiryBadge(selected).kind} dot>
                    {enquiryBadge(selected).label}
                  </Badge>
                  {/* `as Route` below: next.config sets experimental.typedRoutes and Next
                      generates those types at BUILD time, so tsc --noEmit passes against
                      types that do not exist yet and only `npm run build` rejects a
                      templated href (CLAUDE.md §25.2). */}
                  {selected.lead_id && (
                    <Link href={`/leads?lead=${selected.lead_id}` as Route} className="text-[12px] font-medium text-ink underline">
                      Open lead {selected.lead_id}
                    </Link>
                  )}
                  {isSnoozed(selected, nowISO) && selected.snoozed_until && (
                    <Badge kind="info">Snoozed until {formatDate(selected.snoozed_until)}</Badge>
                  )}
                  {selected.archived_at && <Badge kind="muted">Done</Badge>}
                </div>
              </div>

              {/* ── HAS THIS ALREADY BEEN ANSWERED? ───────────────────────────
                  Pardeep quoted this enquiry, came back later, and the screen looked
                  identical — so the next move was to quote it again. Two quotes for one
                  request, possibly at different prices, and the customer opens with
                  "which one is correct?".

                  Derived from the quotes table, NOT from the Mark done button. That button
                  already existed and depends on the operator remembering to press it in
                  the same breath as doing the work — which is exactly the memory that
                  failed. A state maintained by hand disagrees with reality on the day it
                  matters. */}
              {/* The COLOUR is decided by answeredTone(), not by "is it answered". A green
                  tick beside "you have already sent 2 quotes — check which one the customer
                  should keep" reads as reassurance for a sentence that is reporting a
                  mistake, and people scan the colour before they read the words. */}
              {/* ── DELIVERY FAILED — WHAT / WHY / WHAT NEXT (§24) ───────────
                  Placed ABOVE the "already answered" band on purpose. Both can appear at
                  once, and if they do the order matters: "you already sent a quote" is
                  reassuring right up until you learn the quote never arrived. */}
              {viewingBounce && (
                <div className="border-b border-rose/50 bg-rose-soft/40 px-4 py-2.5">
                  <p className="text-[12px] leading-relaxed text-ink">
                    <span className="font-semibold">Your email bounced.</span>{" "}
                    {bouncedTo ? (
                      <>It did not reach <span className="font-mono font-semibold">{bouncedTo}</span>.</>
                    ) : (
                      /* Same rule the extraction panel follows: say "not named" rather
                         than guess. A bounce body holds several addresses, and the wrong
                         one sends a rep to correct a record that is already right. */
                      <>The notice does not say which address failed — read the full text below.</>
                    )}{" "}
                    The customer never saw your quote and is still waiting.
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                    <span className="font-semibold text-ink">Next:</span> fix the email address on
                    the lead, then send the quote again from there. When this is handled,
                    press <span className="font-semibold">✅ Mark done</span>.
                  </p>
                </div>
              )}

              {!viewingSentReply && answeredNote(answered, rupee, answeredCaveat) && (
                <div className={cn(
                  "flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2",
                  answeredTone(answered) === "problem" ? "border-rose/50 bg-rose-soft/40"
                    : answeredTone(answered) === "warn" ? "border-amber/40 bg-amber-soft/30"
                    : "border-emerald/40 bg-emerald-soft/40",
                )}>
                  <Icon
                    name={answeredTone(answered) === "ok" ? "check_circle" : "alert"}
                    size={14}
                    className={
                      answeredTone(answered) === "problem" ? "text-rose"
                        : answeredTone(answered) === "warn" ? "text-amber-ink"
                        : "text-emerald"
                    }
                  />
                  <span className="text-[12px] leading-snug text-ink">
                    {answeredNote(answered, rupee, answeredCaveat)}
                  </span>
                  {answered.kind === "answered" && (
                    <Link
                      href={`/quotes/${answered.quote.id}` as Route}
                      className="text-[12px] font-semibold text-amber-ink hover:underline"
                    >
                      Open it
                    </Link>
                  )}
                </div>
              )}

              {/* ── The four moves, above the email ────────────────────────
                  Hidden on a reply WE sent. There is nothing to convert, quote or
                  archive about our own outgoing mail, and a "Send quote" button sitting
                  above a record of work already done is an invitation to do it twice. */}
              {!viewingSentReply && (
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-paper-2/40 px-4 py-2.5 shrink-0">
                {canConvertToLead(selected) ? (
                  <Button size="sm" loading={convert.isPending} onClick={() => convert.mutate(selected.id)}>
                    🎯 Convert to lead
                  </Button>
                ) : selected.lead_id ? (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/leads?lead=${selected.lead_id}` as Route}>🎯 Open the lead</Link>
                  </Button>
                ) : null}

                {/* Pre-fills the builder from what the extractor actually FOUND.
                    Fields it could not find are simply absent from the URL — a
                    guessed seat count here becomes a price on a signed quote.

                    The LABEL changes to "Send another quote" once one has gone out. It is
                    never disabled: revising a quote is normal — seats changed, price
                    renegotiated, the first expired — and blocking it would make the app
                    wrong on a legitimate path to prevent a mistake the banner already
                    prevents. See lib/inbound/answered.ts. */}
                {/* ── NOT ON A BOUNCE ──────────────────────────────────────
                    "Send quote" and "WhatsApp" here would be addressed to the mail
                    system that rejected the message, not to a customer. The live screen
                    offered exactly that: 📄 Send quote, above a notice from
                    mailer-daemon@googlemail.com.

                    They are removed rather than disabled. A disabled button says "this
                    is possible, just not now", and quoting a mail daemon is never the
                    next step — the band above says what the next step is. */}
                {!viewingBounce && (
                <Button size="sm" variant="ghost" asChild>
                  <Link href={quoteHref(selected, entities) as Route}>
                    📄 {quoteButtonLabel(answered)}
                  </Link>
                </Button>
                )}

                {/* No phone, no button that pretends. Opening wa.me with a blank
                    number lands the rep in an empty WhatsApp and looks like the app
                    lost the contact. */}
                {viewingBounce ? null : waNumber ? (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={waHref!} target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toast.error("No phone number in this enquiry.", {
                      description: "Nothing was found to message. Add a number on the lead, then WhatsApp from there.",
                    })}
                  >
                    💬 WhatsApp
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setState.mutate({ id: selected.id, archived: !selected.archived_at })}
                >
                  {selected.archived_at ? "↩ Move back to Inbox" : "✅ Mark done"}
                </Button>
              </div>

              )}

              {/* ── Secondary: flag and defer ────────────────────────────── */}
              {!viewingSentReply && (
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-1.5 shrink-0">
                <Button
                  size="sm"
                  variant={selected.starred ? "default" : "ghost"}
                  onClick={() => setState.mutate({ id: selected.id, starred: !selected.starred })}
                >
                  {selected.starred ? "★ Starred" : "☆ Star"}
                </Button>

                <div className="relative">
                  <Button size="sm" variant="ghost" onClick={() => setSnoozeOpen((v) => !v)}>
                    ⏰ Snooze
                  </Button>
                  {snoozeOpen && (
                    <div className="absolute z-20 mt-1 w-48 rounded-lg border border-hairline bg-paper p-1 shadow-lg">
                      {snoozePresets(new Date(nowISO)).map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setState.mutate({ id: selected.id, snoozeUntil: p.untilISO });
                            setSnoozeOpen(false);
                            toast.success(`Snoozed — back in your Inbox ${p.label.toLowerCase()}.`);
                          }}
                          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-paper-2"
                        >
                          {p.label}
                        </button>
                      ))}
                      {selected.snoozed_until && (
                        <button
                          type="button"
                          onClick={() => {
                            setState.mutate({ id: selected.id, snoozeUntil: null });
                            setSnoozeOpen(false);
                          }}
                          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-rose hover:bg-paper-2"
                        >
                          Wake it now
                        </button>
                      )}
                    </div>
                  )}
                </div>

              </div>
              )}

              {/* ── The conversation, and what we read out of it ─────────── */}
              {/* The mail body is the part that scrolls; the header and the two toolbars
                  above stay put. */}
              <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[1fr_260px] flex-1 min-h-0 overflow-y-auto">
                <div className="min-w-0">
                  {selectedThread && !selectedThread.isSingle && (
                    <p className="mb-3 rounded-md border border-hairline bg-paper-2/60 px-2.5 py-1.5 text-xs leading-snug text-ink-3">
                      {selectedThread.messages.length} messages, grouped by sender and subject.
                      {" "}Email replies carry no thread header we can read, so this is a
                      best guess — a colleague writing from a different address starts
                      its own conversation. Your own replies are not shown; they are
                      recorded in the email log without their text.
                    </p>
                  )}

                  <ul className="space-y-3">
                    {(selectedThread?.messages ?? []).map((m, i) => (
                      <li key={m.id} className={cn(
                        "rounded-lg border border-hairline p-3",
                        i === (selectedThread?.messages.length ?? 1) - 1 ? "bg-paper" : "bg-paper-2/40",
                      )}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <span className="truncate text-[12px] font-medium text-ink-2">
                            {senderLabel(m)}
                          </span>
                          <span className="shrink-0 text-xs text-ink-3">
                            {formatDate(m.created_at)}
                          </span>
                        </div>

                        {m.attachment_name && (
                          <div className="mb-2 inline-flex items-center gap-2 rounded-md border border-hairline bg-paper px-2.5 py-1">
                            <Icon name="paperclip" size={12} className="text-ink-3" />
                            <span className="text-xs text-ink-2">{m.attachment_name}</span>
                          </div>
                        )}

                        {/* TEXT, never HTML. An inbound email is untrusted input from
                            anyone who can find the address. */}
                        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-2">
                          {m.body_text?.trim()
                            || (m.body_html ? m.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "")
                            || "This email arrived with no readable body."}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* ── What we read out of the conversation ───────────────── */}
                {entities && (
                  <aside className="min-w-0">
                    <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
                      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                        Details found · {foundCount(entities)} of 5
                      </p>
                      <dl className="space-y-2">
                        <Detail label="Name"    e={entities.name} />
                        <Detail label="Email"   e={entities.email} />
                        <Detail label="Phone"   e={entities.phone} />
                        <Detail label="Seats"   e={entities.seats} />
                        <Detail label="Product" e={{
                          value:  entities.product.value?.name ?? null,
                          source: entities.product.source,
                        }} />
                      </dl>
                      {/* Not a model. Read from the text by rules that can be pointed
                          at — and left blank when nothing matched, because a guessed
                          seat count becomes a price and a guessed number becomes a
                          message to a stranger. */}
                      <p className="mt-2.5 border-t border-hairline pt-2 text-xs leading-snug text-ink-3">
                        Read from the email text. Anything blank was not found — nothing here is guessed.
                      </p>
                    </div>
                  </aside>
                )}
              </div>

              {/* ── And the answer, written where the question is ─────────────
                  Below the conversation, not inside its column: a reply box the
                  width of a phone is one people write four-word replies in, and
                  the whole point is that the seat count and the product stay
                  visible above while it is typed. */}
              {!viewingSentReply && (
              <div className="px-4 pb-4">
                <ReplyComposer
                  enquiryId={selected.id}
                  toEmail={selected.from_email}
                  originalSubject={selected.subject}
                  receivedAt={selected.created_at}
                  formatWhen={formatDate}
                  context={{
                    contactName: entities?.name.value ?? null,
                    product:     entities?.product.value?.name ?? null,
                    seats:       entities?.seats.value ?? null,
                    /* The phone-ask pill hides itself when a number is already on the
                       enquiry — asking for something on file reads as "they did not
                       read my email". */
                    hasPhone:    Boolean(entities?.phone.value),
                    sellerName:  tenantName,
                  }}
                />
              </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* Two facts a rep needs in this folder, and neither was here before: which
          mailbox holds the real copy, and that anything sent before today has only a
          delivery record. The previous version of this line said the text is never
          stored, which stopped being true the moment replies started being filed. */}
      {folder === "sent" && (
        <p className="mt-3 px-1 text-xs leading-snug text-ink-3">
          {sentFromNote(emailSender?.address)}{" "}
          Replies sent before 18 Aug 2026 are not listed above — only their delivery was
          recorded, not their text, so there is nothing here to reprint. Look in that
          account&apos;s Sent folder for those.
        </p>
      )}

      {/* Shown only once a key has actually been used — see the note on KeyHintBar. */}
      <KeyHintBar visible={enquiryKeys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
