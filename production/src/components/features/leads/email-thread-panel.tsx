"use client";

/**
 * The email exchange on one lead, read top to bottom like a mail client.
 *
 * Reported by Pardeep on 22 Aug 2026: *"ab jo lead ke email id se email receive hongi wo
 * kahan dikhengi"* — he could not tell where a reply from the lead's address would appear.
 * It was appearing, interleaved with calls, quotes and tasks in one timeline, which reads
 * as a log and not as a conversation.
 *
 * Nothing new is stored. `inbound_emails` already holds both directions —
 * `lib/inbound/sent.ts` explains why a reply lives in the same table as the mail it
 * answers. `lib/leads/email-thread.ts` does the assembly and owns the ordering rules.
 */

import * as React from "react";
import { cn, formatDate } from "@/lib/utils";
import { formatIstTime } from "@/lib/dates/ist";
import { Icon } from "@/components/ui/icon";
import type { ThreadMessage, ThreadSummary } from "@/lib/leads/email-thread";
import { stripQuoted } from "@/lib/inbound/strip-quoted";

/* R-275: India time, not the viewer device zone. */
const fmtTime = (at: string | null): string => formatIstTime(at);

export function EmailThreadPanel({
  thread,
  summary,
  leadEmail,
  loggedSendsWithoutText = 0,
}: {
  thread: readonly ThreadMessage[];
  summary: ThreadSummary;
  leadEmail: string | null | undefined;
  /**
   * Email sends recorded on the timeline that have no stored text — the old Gmail hand-off
   * only logged "Emailed x@y · subject" and kept nothing.
   *
   * Passed in because this panel would otherwise contradict the screen next to it: the
   * first real lead after the tab shipped had two such sends, so "Everything" said two
   * emails went out while this tab said nothing had been exchanged. Both were true and the
   * pair read as broken.
   */
  loggedSendsWithoutText?: number;
}) {
  /* Rendered under either state, because it explains a gap the operator can otherwise only
     see as a contradiction. */
  const olderSends = loggedSendsWithoutText > 0 && loggedSendsWithoutText > summary.outbound
    ? loggedSendsWithoutText - summary.outbound
    : 0;

  const olderSendsNote = olderSends > 0 ? (
    <p className="mt-2 text-xs leading-relaxed text-ink-3">
      The timeline also records {olderSends} earlier email{olderSends === 1 ? "" : "s"} to
      this lead with no saved text — {olderSends === 1 ? "it was" : "they were"} sent through
      Gmail before sending moved into the app, so only the fact of{" "}
      {olderSends === 1 ? "it" : "them"} was kept.
    </p>
  ) : null;

  if (thread.length === 0) {
    /* §24 — what, why, and what to do next. A blank panel here would read as "the feature
       is broken", which is exactly the confusion this tab was built to end. */
    return (
      <div className="rounded-md bg-paper-2 p-3 text-xs leading-relaxed text-ink-3">
        <b className="text-ink-2">No email either way yet.</b>
        {leadEmail ? (
          <> Mail sent to <span className="font-mono text-ink-2">{leadEmail}</span> and anything
          they send back will both appear here, oldest first.</>
        ) : (
          <> This lead has no email address on it, so there is nothing to send to or receive
          from. Add one with Edit.</>
        )}
        {olderSendsNote}
      </div>
    );
  }

  return (
    <div>
      {/* No "EMAIL CONVERSATION" heading any more. In the lead drawer this panel renders
          directly under a selected segmented control that already reads "Email (15)", and
          under a tab that already reads "Conversation (16)" — three labels for one list,
          stacked, with two nearly-matching numbers among them. The counts stay because
          they are the one thing those labels do NOT say: which way the traffic went.
          Right-aligned and alone, they read as a caption rather than a third title. */}
      <div className="mb-1.5 flex justify-end">
        <span className="font-mono text-xs text-ink-3">
          {summary.inbound} in · {summary.outbound} out
        </span>
      </div>

      {/* NEWEST FIRST, reversed here at render and NOT in buildEmailThread. Asked for on
          23 Aug 2026 — "email thread sabse baad wali sabse upar dikhao yahi to logical hai"
          — and it is, for two reasons, the second of which I had missed:

            1. With 15 messages in a narrow drawer the one that matters was 15 messages
               down. The CTA above says "Reply — they are waiting" about a message that was
               off-screen, which is a strange thing for a screen to do.
            2. The Activity tab is newest-first. Email being oldest-first meant one drawer
               sorted two lists in opposite directions, and nothing on screen said so.

          WHAT IT COSTS: a long back-and-forth now reads backwards, which is not how any
          mail client shows a thread. Acceptable here because this is a sales drawer, not a
          mail client — the common task is "what did they last say, and reply", and the
          rarer task of reading the whole exchange in order is still a scroll away. Every
          message carries its own direction arrow and timestamp, so no line depends on its
          neighbour to be understood.

          `[...thread]` because Array.prototype.reverse mutates, and `thread` is the array
          buildEmailThread returned — `summariseThread` takes `latest` from its LAST
          element, so reversing in place would silently make "latest" the oldest message
          and hand the reply pills the first enquiry to answer. Reversing a copy at render
          keeps ascending order as the one truth every caller already relies on. */}
      <ul className="space-y-2">
        {[...thread].reverse().map((m) => {
          const out = m.direction === "outbound";
          return (
            <li
              key={m.id}
              className={cn(
                "rounded-md border p-2.5",
                /* Ours indented and tinted, theirs flush left — the shape a mail thread is
                   read in, so direction is legible before any label is read. */
                out
                  ? "ml-5 border-amber/30 bg-amber-soft/30"
                  : "mr-5 border-hairline bg-paper-2",
              )}
            >
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-2">
                  <Icon name={out ? "send" : "mail"} size={11} className={out ? "text-amber-ink" : "text-ink-3"} />
                  {out ? "You" : (m.counterparty ?? "Them")}
                  {out && m.counterparty && (
                    <span className="font-normal text-ink-3">→ {m.counterparty}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs text-ink-3">
                  {formatDate(m.at ?? "")} {fmtTime(m.at)}
                </span>
              </div>

              {m.subject && (
                <div className="mb-1 truncate text-xs font-medium text-ink">{m.subject}</div>
              )}

              {m.body ? (
                /* whitespace-pre-wrap because a quoted reply's line breaks carry meaning —
                   collapsing them turns a readable message into a paragraph soup. */
                <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">
                  {/* QUOTED HISTORY TRIMMED. Browser-verified on 23 Aug 2026, and this is a
                      problem the newest-first reversal in the same change CREATED rather
                      than found: the top message was a reply whose first visible lines were
                      "> Hi test," and the four lines of ours it was answering. At the bottom
                      of the list that tail was harmless; at the top it is the reader's first
                      screenful, spent on text repeated three inches below.

                      Falls back to the raw body when nothing is left. stripQuoted fails
                      toward EMPTY by design — safe for the AI reply context it was written
                      for, where an over-long prompt is worse than a short one, and wrong
                      here, where an empty bubble would read as a lost message. So: use the
                      trim only when it left something. */}
                  {stripQuoted(m.body).text.trim() || m.body}
                </div>
              ) : (
                /* Says which case this is rather than showing an empty bubble. An outbound
                   line with no body is a send that went through Gmail, where the text was
                   never kept — the drawer says so elsewhere and this must not contradict it. */
                <div className="text-xs italic text-ink-3">
                  {m.htmlOnly
                    /* Not rendered on purpose. body_html is whatever a stranger emailed in,
                       and putting it on screen means running their markup in this session. */
                    ? "This message came as formatted HTML only. Open it in your mail client to read it — it is not shown here because it is not plain text."
                    : out
                      /* Reachable only for a row filed without its text. The current send
                         path always stores the body, so this covers older or partial rows
                         rather than the Gmail hand-off it originally described. */
                      ? "This message was sent, but its text was not stored."
                      : "This message arrived with no readable body."}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {summary.awaitingFirstInbound && (
        /* The state that confused the reporter, named. We have written; they have not. */
        <p className="mt-2 text-xs leading-relaxed text-ink-3">
          They have not written back yet — everything above went out from your side. Their
          reply will appear here, and the reply box below becomes usable once it does.
        </p>
      )}
      {olderSendsNote}
    </div>
  );
}
