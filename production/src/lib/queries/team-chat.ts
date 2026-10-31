/**
 * R-2298 (G-TEAMCHAT TC-05, 31 Oct 2026) — team chat data hooks: one tested data layer for the
 * Team chat page (R-2299), the topbar badge and threads, so all three show the same thing.
 *
 * POLLING, not Realtime: live has no Realtime, and polling is this app's proven pattern
 * (notifications 60 s, inbox 20 s, WhatsApp 10–15 s). An open conversation looks every 5 s and
 * the unread badge every 30 s — ONLY while the tab is visible (refetchIntervalInBackground
 * false), so a forgotten background tab costs nothing.
 *
 * Reads go straight to the R-2294 tables under RLS (a non-member never sees a private channel or
 * someone else's DM). Every write is one of R-2295's SECURITY DEFINER RPCs; their errors are
 * plain English (28000 not a member, P0002 not found, 42501 not allowed, 22023 bad input,
 * 23505 duplicate, P0001 rate limit) and reach the toast through toastError (§24 tier 1).
 *
 * Paging is keyset (lib/queries/keyset.ts): 50 messages per page, newest page first, "Load
 * older" asks for messages strictly older than the oldest one shown. `messages` reads oldest →
 * newest, ready to render top to bottom.
 */
"use client";

import * as React from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { flattenPages } from "@/lib/queries/keyset";
import type { Json } from "@/lib/supabase/database.types";
import {
  CHAT_MAX_ATTACHMENTS,
  CHAT_PAGE_SIZE,
  CHAT_POLL_MS,
  CHAT_THREAD_LIMIT,
  CHAT_UNREAD_POLL_MS,
  ChatError,
  type ChatAttachment,
  type ChatAttachmentInput,
  type ChatChannel,
  type ChatCursor,
  type ChatDeleteResult,
  type ChatMember,
  type ChatMessage,
  type ChatMessageRow,
  type ChatMessagesPage,
  type ChatUnread,
  type ChatUploadResult,
  type PostChatMessageInput,
} from "@/lib/team-chat/types";

/** Private bucket of chat files (R-2297, chat-files.ts CHAT_FILE_BUCKET — that module is server-side). */
const CHAT_FILE_BUCKET = "documents";

// ── keys ────────────────────────────────────────────────────────────────────────────────

/** Every team chat key starts with ["team_chat"]; invalidating `all` refreshes everything. */
export const teamChatKeys = {
  all: ["team_chat"] as const,
  channels: () => ["team_chat", "channels"] as const,
  members: (channelId: string) => ["team_chat", "members", channelId] as const,
  messages: (channelId: string) => ["team_chat", "messages", channelId] as const,
  thread: (parentId: string) => ["team_chat", "thread", parentId] as const,
  unread: () => ["team_chat", "unread"] as const,
};

// ── helpers (pure) ──────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * PostgREST filter for "older than this message" in the (created_at desc, id desc) order.
 * The cursor is checked first so a bad value can never widen the filter.
 */
export function chatCursorFilter(c: ChatCursor): string {
  if (!PG_TS.test(c.createdAt) || Number.isNaN(new Date(c.createdAt).getTime()) || !UUID.test(c.id)) {
    throw new Error("Team chat: bad page cursor");
  }
  return `created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt.${c.id})`;
}

/** Turn a PostgREST / RPC error into a ChatError that keeps the server's plain message. */
export function toChatError(e: unknown): ChatError {
  if (e instanceof ChatError) return e;
  const o = (e ?? {}) as { message?: unknown; code?: unknown };
  const message = typeof o.message === "string" && o.message ? o.message : "Team chat could not finish that — try again.";
  return new ChatError(message, typeof o.code === "string" ? o.code : null);
}

/** The other person in a DM: dm_key is the two user ids sorted, "uidA:uidB". */
export function dmOtherUserId(channel: Pick<ChatChannel, "kind" | "dm_key">, myUserId: string): string | null {
  if (channel.kind !== "dm" || !channel.dm_key) return null;
  const [a, b] = channel.dm_key.split(":");
  if (a === myUserId) return b ?? null;
  if (b === myUserId) return a ?? null;
  return null;
}

/** Sum of the badge rows (topbar icon). */
export function chatUnreadTotals(rows: readonly ChatUnread[] | undefined): { unread: number; mentions: number } {
  let unread = 0;
  let mentions = 0;
  for (const r of rows ?? []) {
    unread += Number(r.unread) || 0;
    mentions += Number(r.mentions) || 0;
  }
  return { unread, mentions };
}

/** One page of messages, oldest → newest, from the loaded pages (newest page first). */
export function chatMessagesFromPages(pages: readonly ChatMessagesPage[] | undefined): ChatMessage[] {
  return flattenPages(pages, (m) => m.id).reverse();
}

/** Attach each message's files (one extra read; no embed, so the data gateway needs nothing). */
async function withAttachments(rows: ChatMessageRow[]): Promise<ChatMessage[]> {
  if (rows.length === 0) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("chat_attachments")
    .select("*")
    .in("message_id", rows.map((r) => r.id));
  if (error) throw toChatError(error);
  const byMessage = new Map<string, ChatAttachment[]>();
  for (const a of (data ?? []) as ChatAttachment[]) {
    const list = byMessage.get(a.message_id) ?? [];
    list.push(a);
    byMessage.set(a.message_id, list);
  }
  return rows.map((r) => ({ ...r, attachments: byMessage.get(r.id) ?? [] }));
}

/** Read one page: the newest 50 top-level messages of a channel older than `cursor`. */
export async function fetchChatMessagesPage(channelId: string, cursor: ChatCursor | null): Promise<ChatMessagesPage> {
  const supabase = createClient();
  let q = supabase
    .from("chat_messages")
    .select("*")
    .eq("channel_id", channelId)
    .is("parent_id", null);
  if (cursor) q = q.or(chatCursorFilter(cursor));
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(CHAT_PAGE_SIZE);
  if (error) throw toChatError(error);
  const rows = await withAttachments((data ?? []) as ChatMessageRow[]);
  const oldest = rows.at(-1);
  return {
    rows,
    next: rows.length === CHAT_PAGE_SIZE && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
  };
}

/** POST /api/team-chat/upload (R-2297): store one file, get what chat_post_message needs. */
export async function uploadChatFile(channelId: string, file: File): Promise<ChatAttachmentInput> {
  const form = new FormData();
  form.append("channelId", channelId);
  form.append("file", file);
  const res = await fetch("/api/team-chat/upload", { method: "POST", body: form });
  const json = (await res.json().catch(() => null)) as (Partial<ChatUploadResult> & { error?: string }) | null;
  if (!res.ok || !json?.ok || !json.path) {
    throw new ChatError(json?.error || "Could not upload the file — try again.", String(res.status));
  }
  return { path: json.path, name: json.fileName ?? file.name, mime: json.mime ?? file.type, size: json.sizeBytes ?? file.size };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────

/** Channels and DMs the caller can read (RLS), not archived. Refreshes with the badge (30 s). */
export function useChatChannels() {
  return useQuery({
    queryKey: teamChatKeys.channels(),
    queryFn: async (): Promise<ChatChannel[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("chat_channels")
        .select("*")
        .is("archived_at", null)
        .order("created_at", { ascending: true });
      if (error) throw toChatError(error);
      return (data ?? []) as ChatChannel[];
    },
    refetchInterval: CHAT_UNREAD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Members of one channel (with their read marks). */
export function useChatChannelMembers(channelId: string | null | undefined) {
  return useQuery({
    queryKey: teamChatKeys.members(channelId ?? ""),
    enabled: !!channelId,
    queryFn: async (): Promise<ChatMember[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("chat_members").select("*").eq("channel_id", channelId!);
      if (error) throw toChatError(error);
      return (data ?? []) as ChatMember[];
    },
  });
}

/**
 * A channel's top-level messages, 50 per page, polled every 5 s while visible.
 * `messages` = oldest → newest; `fetchNextPage()` loads OLDER messages; `hasNextPage` says
 * whether there are any.
 */
export function useChatMessages(channelId: string | null | undefined) {
  const q = useInfiniteQuery({
    queryKey: teamChatKeys.messages(channelId ?? ""),
    enabled: !!channelId,
    initialPageParam: null as ChatCursor | null,
    queryFn: ({ pageParam }) => fetchChatMessagesPage(channelId!, pageParam),
    getNextPageParam: (last) => last.next,
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const messages = React.useMemo(() => chatMessagesFromPages(q.data?.pages), [q.data]);
  return { ...q, messages };
}

/** Replies to one message, oldest first (up to 200), polled every 5 s while visible. */
export function useChatThread(parentId: string | null | undefined) {
  return useQuery({
    queryKey: teamChatKeys.thread(parentId ?? ""),
    enabled: !!parentId,
    queryFn: async (): Promise<ChatMessage[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("parent_id", parentId!)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(CHAT_THREAD_LIMIT);
      if (error) throw toChatError(error);
      return withAttachments((data ?? []) as ChatMessageRow[]);
    },
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** chat_unread_counts() — one row per channel with something unread; polled every 30 s while visible. */
export function useChatUnreadCounts() {
  return useQuery({
    queryKey: teamChatKeys.unread(),
    queryFn: async (): Promise<ChatUnread[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_unread_counts");
      if (error) throw toChatError(error);
      return (data ?? []) as ChatUnread[];
    },
    refetchInterval: CHAT_UNREAD_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

// ── writes ──────────────────────────────────────────────────────────────────────────────

type MessagesCache = InfiniteData<ChatMessagesPage, ChatCursor | null>;
type SendContext = { key: QueryKey; prev: unknown; tempId: string };

let tempSeq = 0;

function optimisticMessage(input: PostChatMessageInput, tempId: string): ChatMessage {
  return {
    id: tempId,
    tenant_id: "",
    channel_id: input.channelId,
    author_id: input.authorId ?? null,
    parent_id: input.parentId ?? null,
    body: input.body.trim(),
    kind: input.kind ?? "text",
    post_status: null,
    mentions: input.mentions ?? [],
    links: (input.links ?? []) as unknown as Json,
    task_id: null,
    feedback_id: null,
    pinned_at: null,
    pinned_by: null,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    created_at: new Date().toISOString(),
    attachments: [],
    pending: true,
  };
}

/** Swap one message (by id) in either cache shape. */
function mapCache(old: unknown, isThread: boolean, fn: (m: ChatMessage) => ChatMessage): unknown {
  if (!old) return old;
  if (isThread) return (old as ChatMessage[]).map(fn);
  const inf = old as MessagesCache;
  return { ...inf, pages: inf.pages.map((p) => ({ ...p, rows: p.rows.map(fn) })) };
}

/**
 * Send a message (or a thread reply when `parentId` is set). The message shows at once with
 * `pending: true`; if the server refuses, it is taken back and the server's message is toasted.
 * Resolves to the new message id.
 */
export function usePostChatMessage() {
  const qc = useQueryClient();
  return useMutation<string, ChatError, PostChatMessageInput, SendContext | undefined>({
    onMutate: async (input) => {
      const files = input.attachments ?? [];
      if (!input.body.trim() && files.length === 0) throw new ChatError("Type a message or attach a file.", "22023");
      if (files.length > CHAT_MAX_ATTACHMENTS) {
        throw new ChatError(`Attach at most ${CHAT_MAX_ATTACHMENTS} files to one message.`, "22023");
      }
      const isThread = !!input.parentId;
      const key = isThread ? teamChatKeys.thread(input.parentId!) : teamChatKeys.messages(input.channelId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      const tempId = `pending-${Date.now()}-${++tempSeq}`;
      const draft = optimisticMessage(input, tempId);
      if (prev) {
        if (isThread) {
          qc.setQueryData<ChatMessage[]>(key, [...(prev as ChatMessage[]), draft]);
        } else {
          const inf = prev as MessagesCache;
          qc.setQueryData<MessagesCache>(key, {
            ...inf,
            pages: inf.pages.map((p, i) => (i === 0 ? { ...p, rows: [draft, ...p.rows] } : p)),
          });
        }
      }
      return { key, prev, tempId };
    },
    mutationFn: async (input) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_post_message", {
        p_channel_id: input.channelId,
        p_body: input.body.trim(),
        p_kind: input.kind ?? "text",
        p_parent_id: input.parentId ?? null,
        p_mentions: input.mentions ?? [],
        p_links: (input.links ?? []) as unknown as Json,
        p_attachments: (input.attachments ?? []) as unknown as Json,
      } as never);
      if (error) throw toChatError(error);
      return data as string;
    },
    onSuccess: (id, input, ctx) => {
      if (!ctx) return;
      qc.setQueryData(ctx.key, (old: unknown) =>
        mapCache(old, !!input.parentId, (m) => (m.id === ctx.tempId ? { ...m, id, pending: false } : m)));
    },
    onError: (err, _input, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.prev);
      toastError(err);
    },
    onSettled: (_id, _err, input) => {
      void qc.invalidateQueries({ queryKey: teamChatKeys.messages(input.channelId) });
      if (input.parentId) void qc.invalidateQueries({ queryKey: teamChatKeys.thread(input.parentId) });
    },
  });
}

/** Edit own message text (chat_edit_message). */
export function useEditChatMessage() {
  const qc = useQueryClient();
  return useMutation<void, ChatError, { messageId: string; channelId: string; body: string; parentId?: string | null }>({
    mutationFn: async ({ messageId, body }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("chat_edit_message", { p_message_id: messageId, p_body: body.trim() });
      if (error) throw toChatError(error);
    },
    onSuccess: (_v, input) => {
      void qc.invalidateQueries({ queryKey: teamChatKeys.messages(input.channelId) });
      if (input.parentId) void qc.invalidateQueries({ queryKey: teamChatKeys.thread(input.parentId) });
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Delete a message (author or owner). The row stays as a "deleted" placeholder; the server
 * returns the removed files' paths and this hook removes them from storage under the caller's
 * own session (the R-2297 storage rule lets the uploader or the owner delete). A file that
 * cannot be removed is only logged — the message is already gone for everyone.
 */
export function useDeleteChatMessage() {
  const qc = useQueryClient();
  return useMutation<ChatDeleteResult, ChatError, { messageId: string; channelId: string; parentId?: string | null }>({
    mutationFn: async ({ messageId }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_delete_message", { p_message_id: messageId });
      if (error) throw toChatError(error);
      const raw = (data ?? {}) as { deleted?: unknown; file_paths?: unknown };
      const result: ChatDeleteResult = {
        deleted: raw.deleted === true,
        file_paths: Array.isArray(raw.file_paths) ? raw.file_paths.filter((p): p is string => typeof p === "string") : [],
      };
      if (result.file_paths.length > 0) {
        const { error: rmErr } = await supabase.storage.from(CHAT_FILE_BUCKET).remove(result.file_paths);
        if (rmErr) console.warn("[team-chat] message deleted, but its files could not be removed", rmErr);
      }
      return result;
    },
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: teamChatKeys.messages(input.channelId) });
      if (input.parentId) void qc.invalidateQueries({ queryKey: teamChatKeys.thread(input.parentId) });
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Mark a channel read (chat_mark_read). Its badge row goes to 0 at once and comes back if the
 * server refuses. No toast: a read mark is not something the person asked for, and the next
 * open tries again.
 */
export function useMarkChatRead() {
  const qc = useQueryClient();
  return useMutation<string, ChatError, { channelId: string; at?: string }, { prev: ChatUnread[] | undefined }>({
    onMutate: async ({ channelId }) => {
      await qc.cancelQueries({ queryKey: teamChatKeys.unread() });
      const prev = qc.getQueryData<ChatUnread[]>(teamChatKeys.unread());
      if (prev) {
        qc.setQueryData<ChatUnread[]>(teamChatKeys.unread(),
          prev.map((r) => (r.channel_id === channelId ? { ...r, unread: 0, mentions: 0 } : r)));
      }
      return { prev };
    },
    mutationFn: async ({ channelId, at }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_mark_read", at ? { p_channel_id: channelId, p_at: at } : { p_channel_id: channelId });
      if (error) throw toChatError(error);
      return data as string;
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(teamChatKeys.unread(), ctx.prev);
    },
    onSuccess: (_at, input) => {
      void qc.invalidateQueries({ queryKey: teamChatKeys.unread() });
      void qc.invalidateQueries({ queryKey: teamChatKeys.members(input.channelId) });
    },
  });
}

/** Open (or find) the DM with a teammate; resolves to its channel id. */
export function useOpenChatDm() {
  const qc = useQueryClient();
  return useMutation<string, ChatError, { userId: string }>({
    mutationFn: async ({ userId }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_open_dm", { p_user_id: userId });
      if (error) throw toChatError(error);
      return data as string;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: teamChatKeys.channels() }),
    onError: (err) => toastError(err),
  });
}

/** Create a channel (owner / manager); resolves to its id. */
export function useCreateChatChannel() {
  const qc = useQueryClient();
  return useMutation<string, ChatError, { name: string; isPrivate?: boolean; topic?: string | null; memberIds?: string[] }>({
    mutationFn: async ({ name, isPrivate, topic, memberIds }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_create_channel", {
        p_name: name.trim(),
        p_is_private: isPrivate ?? false,
        p_topic: topic ?? null,
        p_member_ids: memberIds ?? [],
      } as never);
      if (error) throw toChatError(error);
      return data as string;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: teamChatKeys.channels() }),
    onError: (err) => toastError(err),
  });
}

/** Upload one file for the composer; resolves to the attachment chat_post_message takes. */
export function useUploadChatFile() {
  return useMutation<ChatAttachmentInput, ChatError, { channelId: string; file: File }>({
    mutationFn: ({ channelId, file }) => uploadChatFile(channelId, file).catch((e) => { throw toChatError(e); }),
    onError: (err) => toastError(err),
  });
}
