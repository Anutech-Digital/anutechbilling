/**
 * R-2299 (G-TEAMCHAT TC-06) — the messages of one conversation, oldest at the top.
 *
 * - An IST day divider ("Today", "Yesterday", "Tue, 20 Oct 2026") before each day.
 * - Name + avatar (initials in the person's colour) when the author changes or 5+ minutes
 *   pass; following lines of the same person stay compact.
 * - "(edited)" after an edited message; a deleted one shows only "This message was deleted."
 * - The body is plain text with safe links (linkify.ts) — never markdown or HTML.
 * - Scrolling to the top loads older messages; a new message scrolls into view only when the
 *   reader is already at the bottom (reading old messages is not interrupted).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";
import { cn } from "@/lib/utils";
import { CHAT_EXTENSIONS } from "./extensions";
import type { ChatExtension } from "./composer-slots";
import { chatAvatarColor, chatTime, groupChatDays, personInitials, personName } from "./chat-format";
import { linkifyChatText } from "./linkify";

export interface MessageListProps {
  channelId: string;
  channelLabel: string;
  messages: readonly ChatMessage[];
  people: ReadonlyMap<string, TeamMember>;
  myUserId: string | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  extensions?: readonly ChatExtension[];
}

const NEAR_TOP_PX = 80;
const NEAR_BOTTOM_PX = 120;

export function MessageList(props: MessageListProps) {
  const { channelId, channelLabel, messages, people, myUserId, isLoading, isError, onRetry, hasOlder, loadingOlder, onLoadOlder } = props;
  const extensions = props.extensions ?? CHAT_EXTENSIONS;
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const atBottom = React.useRef(true);
  const prevFirstId = React.useRef<string | null>(null);
  const prevHeight = React.useRef(0);
  const teammates = React.useMemo(() => [...people.values()], [people]);
  const days = React.useMemo(() => groupChatDays(messages), [messages]);

  /* A new conversation opens at its newest message. */
  React.useEffect(() => {
    atBottom.current = true;
    prevFirstId.current = null;
  }, [channelId]);

  /* Keep the view steady: older messages added on top keep the same message under the eye;
     a new message at the bottom scrolls into view only for a reader who was at the bottom. */
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id ?? null;
    if (prevFirstId.current && firstId !== prevFirstId.current && prevHeight.current > 0) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirstId.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < NEAR_TOP_PX && hasOlder && !loadingOlder) onLoadOlder();
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label={`Messages in ${channelLabel}`}
      aria-live="polite"
      className="flex-1 min-h-0 overflow-y-auto px-3 py-3 md:px-5"
    >
      {isLoading ? (
        <div className="space-y-4" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex-1 space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-3/4" /></div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon="alert"
          title="Messages could not load"
          body="Check your connection, then try again."
          action={<Button onClick={onRetry} icon="refresh">Try again</Button>}
          compact
        />
      ) : messages.length === 0 ? (
        <EmptyState
          icon="message"
          title={`No messages in ${channelLabel} yet`}
          body="Write the first message below — everyone in this conversation will see it."
          compact
        />
      ) : (
        <>
          {hasOlder && (
            <div className="flex justify-center pb-2">
              <Button variant="ghost" size="sm" loading={loadingOlder} onClick={onLoadOlder}>
                Load older messages
              </Button>
            </div>
          )}
          {days.map((day) => (
            <section key={day.day} aria-label={day.label}>
              <div role="separator" className="my-3 flex items-center gap-3 text-xs font-medium text-ink-3">
                <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
                <span>{day.label}</span>
                <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
              </div>
              <ul className="space-y-0.5">
                {day.messages.map(({ message, showAuthor }) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    showAuthor={showAuthor}
                    author={message.author_id ? people.get(message.author_id) : undefined}
                    channelId={channelId}
                    myUserId={myUserId}
                    teammates={teammates}
                    extensions={extensions}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  showAuthor: boolean;
  author: TeamMember | undefined;
  channelId: string;
  myUserId: string | null;
  teammates: readonly TeamMember[];
  extensions: readonly ChatExtension[];
}

function MessageItem({ message, showAuthor, author, channelId, myUserId, teammates, extensions }: MessageItemProps) {
  const deleted = !!message.deleted_at;
  const slot = { message, channelId, myUserId, teammates };

  if (message.kind === "system") {
    return (
      <li className="py-1 text-center text-xs italic text-ink-3">
        <MessageBody body={message.body} />
      </li>
    );
  }

  const name = message.author_id === myUserId && !author ? "You" : personName(author);
  return (
    <li className={cn("group flex gap-3 rounded-md px-1 py-0.5 hover:bg-paper-2/60", showAuthor && "mt-2", message.pending && "opacity-70")}>
      <div className="w-9 shrink-0">
        {showAuthor && (
          <Avatar initials={personInitials(author)} name={name} color={chatAvatarColor(message.author_id, author?.color)} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showAuthor && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-ink">{name}</span>
            <time dateTime={message.created_at} className="text-xs text-ink-3">{chatTime(message.created_at)}</time>
            {!deleted && extensions.map((ext) => ext.MessageBadge && <ext.MessageBadge key={`badge-${ext.id}`} {...slot} />)}
          </div>
        )}
        {deleted ? (
          <p className="text-sm italic text-ink-3">This message was deleted.</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-ink">
            <MessageBody body={message.body} />
            {message.edited_at && <span className="ml-1 text-xs text-ink-3">(edited)</span>}
            {message.pending && <span className="ml-2 text-xs text-ink-3">Sending…</span>}
          </p>
        )}
        {!deleted && extensions.map((ext) => ext.MessageBelow && <ext.MessageBelow key={`below-${ext.id}`} {...slot} />)}
      </div>
    </li>
  );
}

/** Plain text with safe links only (linkify.ts) — React escapes every text part. */
function MessageBody({ body }: { body: string }) {
  const parts = React.useMemo(() => linkifyChatText(body), [body]);
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : p.external ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className="text-amber underline underline-offset-2 break-all">
            {p.text}
          </a>
        ) : (
          <Link key={i} href={p.href as Route} className="text-amber underline underline-offset-2 break-all">
            {p.text}
          </Link>
        ),
      )}
    </>
  );
}
