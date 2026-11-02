/**
 * R-2299 (G-TEAMCHAT TC-06) — pure helpers for the Team chat page: channel names, people,
 * avatar colours, IST day dividers and message grouping. No React.
 */
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import { initials as makeInitials } from "@/lib/utils";
import { dmOtherUserId } from "@/lib/queries/team-chat";
import type { ChatChannel, ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

/** Avatar colours the <Avatar> component knows (users.color holds one of these when set). */
export const CHAT_AVATAR_COLORS = ["amber", "emerald", "indigo", "rose", "slate", "ink"] as const;
export type ChatAvatarColor = (typeof CHAT_AVATAR_COLORS)[number];

/** The person's own colour when it is one we know, else a stable colour from their id. */
export function chatAvatarColor(id: string | null | undefined, color?: string | null): ChatAvatarColor {
  if (color && (CHAT_AVATAR_COLORS as readonly string[]).includes(color)) return color as ChatAvatarColor;
  const seed = id ?? "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CHAT_AVATAR_COLORS[h % CHAT_AVATAR_COLORS.length];
}

/** Display name of a teammate: full name, else the email's first part. */
export function personName(m: Pick<TeamMember, "full_name" | "email"> | undefined | null): string {
  if (!m) return "Former teammate";
  return m.full_name?.trim() || m.email?.split("@")[0] || "Teammate";
}

/** Two-letter initials for a teammate. */
export function personInitials(m: Pick<TeamMember, "full_name" | "email" | "initials"> | undefined | null): string {
  if (m?.initials?.trim()) return m.initials.trim().slice(0, 2).toUpperCase();
  return makeInitials(personName(m)) || "?";
}

/** "#general" for a channel; the other person's name for a DM ("Notes to self" for your own). */
export function channelLabel(channel: ChatChannel, myUserId: string | null | undefined, people: ReadonlyMap<string, TeamMember>): string {
  if (channel.kind !== "dm") return `#${channel.name ?? "channel"}`;
  if (!myUserId) return "Direct message";
  const other = dmOtherUserId(channel, myUserId);
  if (!other) return "Direct message";
  return personName(people.get(other));
}

/** Channels first (#general on top, then A–Z), then DMs A–Z by name. */
export function sortConversations(
  channels: readonly ChatChannel[],
  myUserId: string | null | undefined,
  people: ReadonlyMap<string, TeamMember>,
): { channels: ChatChannel[]; dms: ChatChannel[] } {
  const label = (c: ChatChannel) => channelLabel(c, myUserId, people).toLowerCase();
  const chans = channels.filter((c) => c.kind !== "dm").sort((a, b) => {
    if (a.slug === "general") return -1;
    if (b.slug === "general") return 1;
    return label(a).localeCompare(label(b));
  });
  const dms = channels.filter((c) => c.kind === "dm").sort((a, b) => label(a).localeCompare(label(b)));
  return { channels: chans, dms };
}

const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });

/** "Today", "Yesterday" or "Thu, 29 Oct 2026" — by the IST calendar day. */
export function chatDayLabel(at: string, now: Date = new Date()): string {
  const day = toIstDate(at);
  const today = toIstDate(now);
  if (day === today) return "Today";
  if (day === addDaysISO(today, -1)) return "Yesterday";
  return DAY_FMT.format(new Date(at));
}

/** "3:42 pm" in IST. */
export function chatTime(at: string): string {
  return TIME_FMT.format(new Date(at));
}

/** Messages of one IST day. */
export interface ChatDay {
  day: string;
  label: string;
  messages: { message: ChatMessage; showAuthor: boolean }[];
}

/** A new name/avatar line when the author changes or 5+ minutes passed since their last message. */
const RUN_GAP_MS = 5 * 60_000;

/** Group oldest → newest messages by IST day; mark which ones start a new author run. */
export function groupChatDays(messages: readonly ChatMessage[], now: Date = new Date()): ChatDay[] {
  const days: ChatDay[] = [];
  let prev: ChatMessage | null = null;
  for (const m of messages) {
    const day = toIstDate(m.created_at);
    let bucket = days.at(-1);
    if (!bucket || bucket.day !== day) {
      bucket = { day, label: chatDayLabel(m.created_at, now), messages: [] };
      days.push(bucket);
      prev = null;
    }
    const showAuthor = !prev
      || prev.author_id !== m.author_id
      || m.kind === "system"
      || Date.parse(m.created_at) - Date.parse(prev.created_at) >= RUN_GAP_MS;
    bucket.messages.push({ message: m, showAuthor });
    prev = m;
  }
  return days;
}
