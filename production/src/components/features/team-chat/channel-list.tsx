/**
 * R-2299 (G-TEAMCHAT TC-06) — the left list: channels (#general first) and direct messages.
 * A conversation with unread messages is bold and shows its count until it is opened.
 * "New message" picks a teammate and opens (or finds) the DM with them.
 */
"use client";

import * as React from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dmOtherUserId } from "@/lib/queries/team-chat";
import type { ChatChannel, ChatUnread } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";
import { cn } from "@/lib/utils";
import { channelLabel, chatAvatarColor, personInitials, personName, sortConversations } from "./chat-format";

/** Roles that can be in team chat (chat_is_staff, R-2294): never an external partner or a personal login. */
const NOT_STAFF = new Set(["partner_agent", "personal"]);

export interface ChannelListProps {
  channels: readonly ChatChannel[];
  unread: readonly ChatUnread[];
  selectedId: string | null;
  myUserId: string | null;
  people: ReadonlyMap<string, TeamMember>;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSelect: (channelId: string) => void;
  onOpenDm: (userId: string) => void;
  openingDm: boolean;
}

export function ChannelList(props: ChannelListProps) {
  const { channels, unread, selectedId, myUserId, people, isLoading, isError, onRetry, onSelect, onOpenDm, openingDm } = props;
  const [picking, setPicking] = React.useState(false);
  const sorted = React.useMemo(() => sortConversations(channels, myUserId, people), [channels, myUserId, people]);
  const unreadBy = React.useMemo(() => new Map(unread.map((u) => [u.channel_id, u])), [unread]);
  const teammates = React.useMemo(
    () => [...people.values()].filter((p) => p.id !== myUserId && !NOT_STAFF.has(p.role)).sort((a, b) => personName(a).localeCompare(personName(b))),
    [people, myUserId],
  );

  const row = (c: ChatChannel) => {
    const label = channelLabel(c, myUserId, people);
    const u = unreadBy.get(c.id);
    const count = c.id === selectedId ? 0 : Number(u?.unread ?? 0);
    const mentions = c.id === selectedId ? 0 : Number(u?.mentions ?? 0);
    const other = c.kind === "dm" && myUserId ? dmOtherUserId(c, myUserId) : null;
    const person = other ? people.get(other) : undefined;
    const active = c.id === selectedId;
    return (
      <li key={c.id}>
        <button
          type="button"
          onClick={() => onSelect(c.id)}
          aria-current={active ? "page" : undefined}
          aria-label={`${label}${count > 0 ? `, ${count} unread` : ""}${mentions > 0 ? `, ${mentions} mention${mentions === 1 ? "" : "s"}` : ""}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm min-h-11 md:min-h-9",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40",
            active ? "bg-amber-soft text-ink" : "text-ink-2 hover:bg-paper-2",
            count > 0 && "font-semibold text-ink",
          )}
        >
          {c.kind === "dm" ? (
            <Avatar initials={personInitials(person)} name={label} color={chatAvatarColor(other, person?.color)} size="xs" />
          ) : (
            <Icon name={c.is_private ? "lock" : "message"} size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{c.kind === "dm" ? label : label.slice(1)}</span>
          {count > 0 && (
            <span className={cn("rounded-full px-1.5 text-2xs font-semibold leading-5", mentions > 0 ? "bg-rose text-white" : "bg-amber text-on-primary")} aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-3">
        <h1 className="font-serif text-xl text-ink">Team chat</h1>
        <Button size="sm" variant="primary" icon="plus" onClick={() => setPicking(true)}>New message</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2 p-1">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : isError ? (
          <div className="p-3 text-sm text-ink-2">
            <p>Conversations could not load.</p>
            <Button className="mt-2" size="sm" icon="refresh" onClick={onRetry}>Try again</Button>
          </div>
        ) : channels.length === 0 ? (
          <div className="p-3 text-sm text-ink-2">
            <p className="font-medium text-ink">No conversations yet</p>
            <p className="mt-1">Press New message to write to a teammate.</p>
          </div>
        ) : (
          <>
            <h2 className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">Channels</h2>
            <ul className="space-y-0.5">{sorted.channels.map(row)}</ul>
            <h2 className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-3">Direct messages</h2>
            {sorted.dms.length === 0 ? (
              <p className="px-2 text-xs text-ink-3">None yet — press New message.</p>
            ) : (
              <ul className="space-y-0.5">{sorted.dms.map(row)}</ul>
            )}
          </>
        )}
      </div>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="sm:!max-w-md">
          <DialogHeader>
            <DialogTitle>New message</DialogTitle>
            <DialogDescription>Pick a teammate. Only the two of you will see this conversation.</DialogDescription>
          </DialogHeader>
          {teammates.length === 0 ? (
            <p className="text-sm text-ink-2">No other teammates yet. Invite people from the Team page.</p>
          ) : (
            <ul className="max-h-80 space-y-0.5 overflow-y-auto">
              {teammates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={openingDm}
                    onClick={() => { onOpenDm(p.id); setPicking(false); }}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm min-h-11 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 disabled:opacity-60"
                  >
                    <Avatar initials={personInitials(p)} name={personName(p)} color={chatAvatarColor(p.id, p.color)} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-ink">{personName(p)}</span>
                    <span className="text-xs capitalize text-ink-3">{p.role.replace(/_/g, " ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </nav>
  );
}
