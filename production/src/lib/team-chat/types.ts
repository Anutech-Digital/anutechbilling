/**
 * R-2298 (G-TEAMCHAT TC-05, 31 Oct 2026) — team chat shapes shared by the data hooks
 * (src/lib/queries/team-chat.ts) and the screens (R-2299 page, topbar badge, threads).
 *
 * Rows come from the generated DB types (R-2294 tables); the server contract is R-2295's RPCs
 * (20261031122037_r2295_team_chat_rpcs.sql) and R-2297's upload route. Pure — no React.
 */
import type { Tables } from "@/lib/supabase/database.types";

export type ChatChannel = Tables<"chat_channels">;
export type ChatMember = Tables<"chat_members">;
export type ChatMessageRow = Tables<"chat_messages">;
export type ChatAttachment = Tables<"chat_attachments">;

/** What a message may say it is (chat_messages.kind). 'system' is written by the server only. */
export type ChatMessageKind = "text" | "problem" | "suggestion" | "system";

/** A linked app record — ids only, never an amount or a name (chat_links_ok, R-2294). */
export interface ChatLink {
  type: string;
  id: string;
}

/** One uploaded file as chat_post_message takes it (path from POST /api/team-chat/upload). */
export interface ChatAttachmentInput {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** A message as the screen shows it: the row, its files, and whether it is still being sent. */
export interface ChatMessage extends ChatMessageRow {
  attachments: ChatAttachment[];
  /** true only for the optimistic copy shown while chat_post_message is running. */
  pending?: boolean;
}

/** Keyset cursor for "older than this message": created_at EXACTLY as Postgres returned it + id. */
export interface ChatCursor {
  createdAt: string;
  id: string;
}

/** One page of a channel's messages, NEWEST first as fetched; `next` loads older ones. */
export interface ChatMessagesPage {
  rows: ChatMessage[];
  next: ChatCursor | null;
}

/** chat_unread_counts() row. */
export interface ChatUnread {
  channel_id: string;
  unread: number;
  mentions: number;
}

/** chat_delete_message() answer. */
export interface ChatDeleteResult {
  deleted: boolean;
  file_paths: string[];
}

export interface PostChatMessageInput {
  channelId: string;
  body: string;
  kind?: Exclude<ChatMessageKind, "system">;
  /** Reply in a thread: the top-level message id. */
  parentId?: string | null;
  mentions?: string[];
  links?: ChatLink[];
  attachments?: ChatAttachmentInput[];
  /** The signed-in user's id — only used to draw the optimistic copy as "mine". */
  authorId?: string | null;
}

/** POST /api/team-chat/upload answer (R-2297). */
export interface ChatUploadResult {
  ok: true;
  path: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

/** 50 messages per page (TC-05). */
export const CHAT_PAGE_SIZE = 50;
/** An open conversation looks for new messages every 5 s — only while the tab is visible. */
export const CHAT_POLL_MS = 5_000;
/** The unread badge refreshes every 30 s — only while the tab is visible. */
export const CHAT_UNREAD_POLL_MS = 30_000;
/** chat_post_message takes at most 5 files per message. */
export const CHAT_MAX_ATTACHMENTS = 5;
/** Thread replies read in one go (a thread is short; no paging for the MVP). */
export const CHAT_THREAD_LIMIT = 200;

/** R-2295 error codes → what they mean. The messages themselves are plain English (toast-safe). */
export const CHAT_ERROR_CODES = {
  "28000": "not_member",
  P0002: "not_found",
  "42501": "not_allowed",
  "22023": "bad_input",
  "23505": "duplicate",
  P0001: "rate_limited",
} as const;

export type ChatErrorKind = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES] | "unknown";

/** An error from a team chat call, with the server's plain message and what kind it is. */
export class ChatError extends Error {
  readonly code: string | null;
  readonly kind: ChatErrorKind;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.kind = (code && (CHAT_ERROR_CODES as Record<string, ChatErrorKind>)[code]) || "unknown";
  }
}
