"use client";

/**
 * R-2300 (G-TEAMCHAT TC-07): the topbar Team chat icon with its unread count.
 *
 * The count is chat_unread_counts() summed (chatUnreadTotals) — useChatUnreadCounts polls it every
 * 30 s while the tab is visible, and opening a conversation marks it read, so the badge drops on
 * the next poll. Two bubbles ("chat"), never AI Help's single bubble ("message"): the two must not
 * be taken for each other. The topbar renders this only for roles that may open /team-chat, so
 * the partner agent and the personal login never call the RPC.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatUnreadTotals, useChatUnreadCounts } from "@/lib/queries/team-chat";
import type { ChatUnread } from "@/lib/team-chat/types";

export const TEAM_CHAT_ICON = "chat";

/** Team chat, opened at the first unread conversation — one with a mention first. */
export function teamChatHref(rows: readonly ChatUnread[] | undefined): string {
  const unread = (rows ?? []).filter((r) => Number(r.unread) > 0);
  const first = unread.find((r) => Number(r.mentions) > 0) ?? unread[0];
  return first ? `/team-chat?c=${encodeURIComponent(first.channel_id)}` : "/team-chat";
}

/** "99+" past 99 so the badge never outgrows the icon. */
export function chatBadgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export function TeamChatButton({ className }: { className?: string }) {
  const { data } = useChatUnreadCounts();
  const { unread } = chatUnreadTotals(data);
  const label = unread > 0 ? `Team chat — ${unread} unread message${unread === 1 ? "" : "s"}` : "Team chat";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" className={className}>
          <Link href={teamChatHref(data) as Route} aria-label={label} data-topbar="team-chat" className="relative">
            <Icon name={TEAM_CHAT_ICON} size={16} />
            {unread > 0 && (
              <span
                data-chat-badge
                className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose text-white text-3xs font-bold grid place-items-center ring-2 ring-paper pointer-events-none tabular-nums"
                aria-hidden="true"
              >
                {chatBadgeText(unread)}
              </span>
            )}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Team chat</TooltipContent>
    </Tooltip>
  );
}

/** Phone "More" menu row (the topbar icon is hidden below sm). Same query, so the same count. */
export function TeamChatMenuItem() {
  const router = useRouter();
  const { data } = useChatUnreadCounts();
  const { unread } = chatUnreadTotals(data);
  return (
    <DropdownMenuItem onSelect={() => router.push(teamChatHref(data) as Route)} data-topbar="team-chat-menu">
      <Icon name={TEAM_CHAT_ICON} size={14} /> Team chat
      {unread > 0 && (
        <span data-chat-badge className="ml-auto min-w-[16px] h-4 px-1 rounded-full bg-rose text-white text-3xs font-bold grid place-items-center tabular-nums">
          {chatBadgeText(unread)}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/** Phone: a dot on the More button while a team message is unread, so it is noticed there too. */
export function TeamChatUnreadDot() {
  const { data } = useChatUnreadCounts();
  if (chatUnreadTotals(data).unread === 0) return null;
  return (
    <span
      data-chat-dot
      className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-rose ring-2 ring-paper pointer-events-none"
      aria-hidden="true"
    />
  );
}
