/**
 * R-2299 (G-TEAMCHAT TC-06) — the Team chat screen: conversations on the left, the open
 * conversation and its message box on the right.
 *
 * - The open conversation is in the URL (`?c=<channel id>`), so a link or reload opens it.
 * - Laptop/tablet: both panes; #general opens by itself when nothing is chosen.
 * - Phone (< 768 px, §20): the list first; a tap opens the conversation full screen with a
 *   "Back to conversations" button.
 * - Opening a conversation marks it read (useMarkChatRead), and so does every new message
 *   that arrives while it is open — the bold/count in the list clears at once.
 * - New messages arrive by polling (useChatMessages, every 5 s while the tab is visible).
 * Data comes only from the R-2298 hooks; their mutations toast their own errors.
 */
"use client";

import * as React from "react";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers, type TeamMember } from "@/lib/queries/team";
import {
  useChatChannelMembers,
  useChatChannels,
  useChatMessages,
  useChatUnreadCounts,
  useMarkChatRead,
  useOpenChatDm,
} from "@/lib/queries/team-chat";
import { IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { ChannelList } from "./channel-list";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { channelLabel } from "./chat-format";

export function TeamChatView() {
  const [selectedParam, setSelected] = useUrlState("c", "");
  const bp = useBreakpoint();
  const isPhone = bp.isMobile;
  const me = useCurrentUser().data ?? null;
  const myUserId = me?.userId ?? null;
  const team = useTeamMembers();
  const channelsQ = useChatChannels();
  const unreadQ = useChatUnreadCounts();
  const markRead = useMarkChatRead();
  const openDm = useOpenChatDm();

  const channels = React.useMemo(() => channelsQ.data ?? [], [channelsQ.data]);
  const people = React.useMemo(() => {
    const m = new Map<string, TeamMember>();
    for (const p of team.data ?? []) m.set(p.id, p);
    return m;
  }, [team.data]);

  /* Laptop: #general (else the first channel) opens when nothing is chosen. A phone shows the list. */
  React.useEffect(() => {
    if (selectedParam || isPhone || bp.width === 0 || channels.length === 0) return;
    const first = channels.find((c) => c.kind !== "dm" && c.slug === "general") ?? channels.find((c) => c.kind !== "dm") ?? channels[0];
    if (first) setSelected(first.id);
  }, [selectedParam, isPhone, bp.width, channels, setSelected]);

  const selected = channels.find((c) => c.id === selectedParam) ?? null;
  const selectedId = selected?.id ?? null;
  const label = selected ? channelLabel(selected, myUserId, people) : "";

  const messagesQ = useChatMessages(selectedId);
  const membersQ = useChatChannelMembers(selectedId);
  const newestId = messagesQ.messages.at(-1)?.id ?? null;

  /* Mark read on open, and again whenever a newer message shows while it is open. */
  const markMutate = markRead.mutate;
  React.useEffect(() => {
    if (!selectedId) return;
    if (newestId?.startsWith("pending-")) return;
    markMutate({ channelId: selectedId });
  }, [selectedId, newestId, markMutate]);

  const showList = !isPhone || !selected;
  const showConversation = !isPhone || !!selected;

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem-var(--bottom-nav-h,56px))] max-w-[1800px] min-w-0 md:h-[calc(100dvh-3.5rem)] md:p-4 lg:p-6">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-paper md:rounded-xl md:border md:border-hairline">
        {showList && (
          <aside className={isPhone ? "flex min-h-0 w-full flex-col" : "flex min-h-0 w-64 shrink-0 flex-col border-r border-hairline lg:w-72"}>
            <ChannelList
              channels={channels}
              unread={unreadQ.data ?? []}
              selectedId={selectedId}
              myUserId={myUserId}
              people={people}
              isLoading={channelsQ.isLoading}
              isError={channelsQ.isError}
              onRetry={() => void channelsQ.refetch?.()}
              onSelect={setSelected}
              onOpenDm={(userId) => openDm.mutate({ userId }, { onSuccess: (id) => setSelected(id) })}
              openingDm={openDm.isPending}
            />
          </aside>
        )}
        {showConversation && (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={selected ? `Conversation ${label}` : "Conversation"}>
            {selected ? (
              <>
                <header className="flex items-center gap-2 border-b border-hairline px-3 py-2 md:px-5 md:py-3">
                  {isPhone && <IconButton icon="chevron-left" aria-label="Back to conversations" onClick={() => setSelected("")} />}
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-ink">{label}</h2>
                    {selected.topic && <p className="truncate text-xs text-ink-3">{selected.topic}</p>}
                  </div>
                </header>
                <MessageList
                  channelId={selected.id}
                  channelLabel={label}
                  messages={messagesQ.messages}
                  people={people}
                  myUserId={myUserId}
                  isLoading={messagesQ.isLoading}
                  isError={messagesQ.isError}
                  onRetry={() => void messagesQ.refetch?.()}
                  hasOlder={!!messagesQ.hasNextPage}
                  loadingOlder={messagesQ.isFetchingNextPage}
                  onLoadOlder={() => void messagesQ.fetchNextPage()}
                />
                <Composer
                  key={selected.id}
                  channelId={selected.id}
                  channelLabel={label}
                  myUserId={myUserId}
                  members={membersQ.data ?? []}
                  teammates={team.data ?? []}
                />
              </>
            ) : (
              <EmptyState
                icon="message"
                title="Pick a conversation"
                body="Choose a channel or a teammate on the left, or press New message."
                className="m-auto"
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
