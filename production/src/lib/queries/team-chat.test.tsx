// @vitest-environment jsdom
/**
 * R-2298 (G-TEAMCHAT TC-05) — team chat data hooks.
 *
 * Proves, against a fake Supabase client that answers like PostgREST (order, limit, keyset
 * filter) and R-2295's RPCs:
 *   1. one key factory under ["team_chat"]; a channel's messages, a thread and the unread badge
 *      have their own keys, so invalidating one never refetches another channel;
 *   2. cursor paging: 50 messages per page, newest page first, "Load older" asks for messages
 *      strictly older than the oldest one on screen; the list reads oldest → newest;
 *   3. an open conversation polls every 5 s ONLY while the tab is visible;
 *   4. the unread badge polls every 30 s, also only while visible;
 *   5. send shows the message at once (pending) and takes it back when the server refuses,
 *      with the server's plain message handed to toastError (§24);
 *   6. delete removes the returned files from storage; mark-read zeroes the badge at once.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager, type InfiniteData } from "@tanstack/react-query";

type Op = [string, unknown[]];
type Answer = { data: unknown; error: { message: string; code?: string } | null };

const h = vi.hoisted(() => ({
  calls: [] as { table: string; ops: Op[] }[],
  tables: {} as Record<string, (ops: Op[]) => Answer>,
  rpc: vi.fn(),
  remove: vi.fn(),
  bucket: vi.fn(),
}));

vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => {
  const builder = (table: string) => {
    const ops: Op[] = [];
    h.calls.push({ table, ops });
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "or", "order", "limit", "in", "lt", "not"]) {
      chain[m] = (...a: unknown[]) => { ops.push([m, a]); return chain; };
    }
    chain.then = (ok: (v: Answer) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => (h.tables[table] ?? (() => ({ data: [], error: null })))(ops))
        .then(ok, bad);
    return chain;
  };
  return {
    createClient: () => ({
      from: (t: string) => builder(t),
      rpc: h.rpc,
      storage: { from: (b: string) => { h.bucket(b); return { remove: h.remove }; } },
    }),
  };
});

import { toastError } from "@/lib/errors/toast-error";
import {
  teamChatKeys,
  chatCursorFilter,
  useChatMessages,
  useChatThread,
  useChatUnreadCounts,
  usePostChatMessage,
  useDeleteChatMessage,
  useMarkChatRead,
  chatUnreadTotals,
  uploadChatFile,
  dmOtherUserId,
} from "@/lib/queries/team-chat";
import { CHAT_PAGE_SIZE, CHAT_POLL_MS, CHAT_UNREAD_POLL_MS, ChatError, type ChatMessagesPage, type ChatUnread } from "@/lib/team-chat/types";

const CH = "11111111-1111-4111-8111-111111111111";
const CH2 = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

/** Message i (0 = oldest), one minute apart, ids sortable like uuids. */
function msg(i: number, channel = CH) {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  return {
    id, tenant_id: "t", channel_id: channel, author_id: ME, parent_id: null, body: `m${i}`, kind: "text",
    post_status: null, mentions: [], links: [], task_id: null, feedback_id: null, pinned_at: null, pinned_by: null,
    edited_at: null, deleted_at: null, deleted_by: null,
    created_at: new Date(Date.UTC(2026, 9, 31, 8, 0, 0) + i * 60_000).toISOString().replace("Z", "+00:00"),
  };
}

/** chat_messages answered like PostgREST: newest first, keyset `or` filter, limit. */
function serveMessages(all: ReturnType<typeof msg>[]) {
  h.tables.chat_messages = (ops) => {
    let rows = [...all].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
    const or = ops.find(([m]) => m === "or")?.[1][0] as string | undefined;
    if (or) {
      const at = /created_at\.lt\."([^"]+)"/.exec(or)![1];
      const id = /id\.lt\.([0-9a-f-]{36})/.exec(or)![1];
      rows = rows.filter((r) => r.created_at < at || (r.created_at === at && r.id < id));
    }
    const limit = ops.find(([m]) => m === "limit")?.[1][0] as number | undefined;
    return { data: limit ? rows.slice(0, limit) : rows, error: null };
  };
}

let qc: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const msgCalls = () => h.calls.filter((c) => c.table === "chat_messages");

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  h.tables.chat_attachments = () => ({ data: [], error: null });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  h.calls.length = 0;
  h.tables = {};
  h.rpc.mockReset();
  h.remove.mockReset();
  h.bucket.mockReset();
  vi.mocked(toastError).mockReset();
});

describe("keys", () => {
  it("live under one prefix, one per channel / thread, and the badge has its own", () => {
    expect(teamChatKeys.all).toEqual(["team_chat"]);
    expect(teamChatKeys.channels().slice(0, 1)).toEqual(["team_chat"]);
    expect(teamChatKeys.messages(CH).slice(0, 1)).toEqual(["team_chat"]);
    expect(teamChatKeys.messages(CH)).not.toEqual(teamChatKeys.messages(CH2));
    expect(teamChatKeys.thread("p1")).not.toEqual(teamChatKeys.messages("p1"));
    expect(teamChatKeys.unread()).toEqual(["team_chat", "unread"]);
    expect(teamChatKeys.members(CH)).toContain(CH);
  });
});

describe("cursor paging — 50 per page, older on demand", () => {
  it("first page = newest 50; Load older asks strictly before the oldest shown; list reads oldest → newest", async () => {
    serveMessages(Array.from({ length: 60 }, (_, i) => msg(i)));
    const { result } = renderHook(() => useChatMessages(CH), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const first = msgCalls()[0].ops;
    expect(first).toContainEqual(["eq", ["channel_id", CH]]);
    expect(first).toContainEqual(["is", ["parent_id", null]]);
    expect(first).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(first).toContainEqual(["limit", [CHAT_PAGE_SIZE]]);
    expect(first.some(([m]) => m === "or")).toBe(false);
    expect(CHAT_PAGE_SIZE).toBe(50);

    expect(result.current.messages).toHaveLength(50);
    expect(result.current.messages[0].body).toBe("m10");
    expect(result.current.messages[49].body).toBe("m59");
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.messages).toHaveLength(60));
    const older = msgCalls().at(-1)!.ops.find(([m]) => m === "or")![1][0] as string;
    expect(older).toBe(`created_at.lt."${msg(10).created_at}",and(created_at.eq."${msg(10).created_at}",id.lt.${msg(10).id})`);
    expect(result.current.messages[0].body).toBe("m0");
    expect(result.current.messages[59].body).toBe("m59");
    expect(result.current.hasNextPage).toBe(false);
  });

  it("files are attached to their message", async () => {
    serveMessages([msg(0), msg(1)]);
    h.tables.chat_attachments = (ops) => {
      expect(ops).toContainEqual(["in", ["message_id", [msg(1).id, msg(0).id]]]);
      return { data: [{ id: "a1", message_id: msg(1).id, file_name: "bill.pdf" }], error: null };
    };
    const { result } = renderHook(() => useChatMessages(CH), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.messages[1].attachments.map((a) => a.file_name)).toEqual(["bill.pdf"]);
    expect(result.current.messages[0].attachments).toEqual([]);
  });

  it("a failed read is an error, never an empty conversation", async () => {
    h.tables.chat_messages = () => ({ data: null, error: { message: "permission denied", code: "42501" } });
    const { result } = renderHook(() => useChatMessages(CH), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.messages).toEqual([]);
  });

  it("a cursor that is not a timestamp + uuid cannot widen the filter", () => {
    expect(() => chatCursorFilter({ createdAt: "2026-10-31T08:00:00+00:00", id: "x),id.neq.(y" })).toThrow();
    expect(() => chatCursorFilter({ createdAt: 'now"),or(true', id: msg(1).id })).toThrow();
  });
});

describe("polling only while the tab is visible", () => {
  it("an open conversation refetches every 5 s, and not at all while hidden", async () => {
    vi.useFakeTimers();
    serveMessages([msg(0)]);
    renderHook(() => useChatMessages(CH), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(msgCalls()).toHaveLength(1);
    expect(CHAT_POLL_MS).toBe(5_000);

    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS); });
    expect(msgCalls()).toHaveLength(2);

    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS * 4); });
    expect(msgCalls()).toHaveLength(2);
  });

  it("a thread refetches every 5 s too, not while hidden", async () => {
    vi.useFakeTimers();
    h.tables.chat_messages = () => ({ data: [], error: null });
    renderHook(() => useChatThread("p1"), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(msgCalls()).toHaveLength(1);
    expect(msgCalls()[0].ops).toContainEqual(["eq", ["parent_id", "p1"]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS); });
    expect(msgCalls()).toHaveLength(2);
    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS * 3); });
    expect(msgCalls()).toHaveLength(2);
  });

  it("the unread badge refetches every 30 s, and not while hidden", async () => {
    vi.useFakeTimers();
    h.rpc.mockResolvedValue({ data: [{ channel_id: CH, unread: 2, mentions: 1 }], error: null });
    const { result } = renderHook(() => useChatUnreadCounts(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("chat_unread_counts");
    expect(result.current.data).toEqual([{ channel_id: CH, unread: 2, mentions: 1 }]);
    expect(CHAT_UNREAD_POLL_MS).toBe(30_000);

    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_UNREAD_POLL_MS - 1_000); });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(h.rpc).toHaveBeenCalledTimes(2);

    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_UNREAD_POLL_MS * 3); });
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("totals add up unread and mentions across channels", () => {
    expect(chatUnreadTotals([{ channel_id: CH, unread: 2, mentions: 1 }, { channel_id: CH2, unread: 3, mentions: 0 }]))
      .toEqual({ unread: 5, mentions: 1 });
    expect(chatUnreadTotals(undefined)).toEqual({ unread: 0, mentions: 0 });
  });
});

describe("send — optimistic with rollback", () => {
  async function openChannel() {
    serveMessages([msg(0), msg(1)]);
    const r = renderHook(() => ({ list: useChatMessages(CH), send: usePostChatMessage() }), { wrapper });
    await waitFor(() => expect(r.result.current.list.isSuccess).toBe(true));
    return r;
  }

  it("the message shows at once as pending, then is taken back when the server refuses", async () => {
    const { result } = await openChannel();
    let reject!: (v: Answer) => void;
    h.rpc.mockImplementation(() => new Promise<Answer>((res) => { reject = res; }));

    act(() => result.current.send.mutate({ channelId: CH, body: "hello team", authorId: ME }));
    await waitFor(() => expect(result.current.list.messages.at(-1)?.body).toBe("hello team"));
    expect(result.current.list.messages.at(-1)?.pending).toBe(true);
    expect(result.current.list.messages).toHaveLength(3);
    expect(h.rpc).toHaveBeenCalledWith("chat_post_message", {
      p_channel_id: CH, p_body: "hello team", p_kind: "text", p_parent_id: null,
      p_mentions: [], p_links: [], p_attachments: [],
    });

    await act(async () => { reject({ data: null, error: { message: "You are sending messages too fast — wait a minute.", code: "P0001" } }); });
    await waitFor(() => expect(result.current.send.isError).toBe(true));
    expect(result.current.list.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
    const err = vi.mocked(toastError).mock.calls[0][0] as ChatError;
    expect(err).toBeInstanceOf(ChatError);
    expect(err.message).toBe("You are sending messages too fast — wait a minute.");
    expect(err.kind).toBe("rate_limited");
  });

  it("on success the pending copy takes the real id, then the refetch shows it exactly once", async () => {
    const { result } = await openChannel();
    const before = msgCalls().length;
    const realId = "99999999-9999-4999-8999-999999999999";
    const saved = { ...msg(2), id: realId, body: "done" };
    let sawRealIdBeforeRefetch = false;
    h.rpc.mockImplementation(async () => {
      serveMessages([msg(0), msg(1), saved]);
      return { data: realId, error: null };
    });
    const unsub = qc.getQueryCache().subscribe(() => {
      const d = qc.getQueryData<InfiniteData<ChatMessagesPage>>(teamChatKeys.messages(CH));
      const row = d?.pages[0].rows.find((m) => m.id === realId);
      if (row && row.body === "done" && row.pending === false) sawRealIdBeforeRefetch = true;
    });
    await act(async () => { await result.current.send.mutateAsync({ channelId: CH, body: "done", authorId: ME,
      attachments: [{ path: `t/chat/${CH}/u_a.pdf`, name: "a.pdf", mime: "application/pdf", size: 10 }] }); });
    unsub();
    expect(h.rpc).toHaveBeenCalledWith("chat_post_message", expect.objectContaining({
      p_attachments: [{ path: `t/chat/${CH}/u_a.pdf`, name: "a.pdf", mime: "application/pdf", size: 10 }],
    }));
    expect(sawRealIdBeforeRefetch).toBe(true);
    await waitFor(() => expect(msgCalls().length).toBeGreaterThan(before));
    await waitFor(() => expect(result.current.list.messages.map((m) => m.id)).toEqual([msg(0).id, msg(1).id, realId]));
    expect(result.current.list.messages.some((m) => m.pending)).toBe(false);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });

  it("an empty message with no file is refused before calling the server", async () => {
    const { result } = await openChannel();
    await act(async () => { await result.current.send.mutateAsync({ channelId: CH, body: "   " }).catch(() => undefined); });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(result.current.list.messages).toHaveLength(2);
  });

  it("a thread reply goes into the thread, not the channel list", async () => {
    const { result } = await openChannel();
    qc.setQueryData(teamChatKeys.thread(msg(1).id), []);
    let done!: (v: Answer) => void;
    h.rpc.mockImplementation(() => new Promise<Answer>((res) => { done = res; }));
    act(() => result.current.send.mutate({ channelId: CH, body: "reply", parentId: msg(1).id }));
    await waitFor(() => expect(qc.getQueryData<unknown[]>(teamChatKeys.thread(msg(1).id))).toHaveLength(1));
    expect(result.current.list.messages).toHaveLength(2);
    await act(async () => { done({ data: null, error: { message: "Message not found", code: "P0002" } }); });
    await waitFor(() => expect(result.current.send.isError).toBe(true));
    expect(qc.getQueryData<unknown[]>(teamChatKeys.thread(msg(1).id))).toEqual([]);
  });
});

describe("upload + DM helpers", () => {
  it("uploadChatFile posts channelId + file and returns what chat_post_message takes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, path: `t/chat/${CH}/u_a.pdf`, fileName: "a.pdf", mime: "application/pdf", sizeBytes: 10 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await uploadChatFile(CH, new File(["%PDF-1"], "a.pdf", { type: "application/pdf" }));
      expect(out).toEqual({ path: `t/chat/${CH}/u_a.pdf`, name: "a.pdf", mime: "application/pdf", size: 10 });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/team-chat/upload");
      expect((init.body as FormData).get("channelId")).toBe(CH);
    } finally { vi.unstubAllGlobals(); }
  });

  it("uploadChatFile passes the route's plain refusal on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This file is over 10 MB — share a smaller file." }), { status: 413 })));
    try {
      await expect(uploadChatFile(CH, new File(["x"], "big.pdf"))).rejects.toThrow("This file is over 10 MB — share a smaller file.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("dmOtherUserId reads the other person from dm_key", () => {
    expect(dmOtherUserId({ kind: "dm", dm_key: `${CH}:${ME}` }, ME)).toBe(CH);
    expect(dmOtherUserId({ kind: "dm", dm_key: `${CH}:${ME}` }, CH)).toBe(ME);
    expect(dmOtherUserId({ kind: "channel", dm_key: null }, ME)).toBeNull();
  });
});

describe("delete and mark read", () => {
  it("delete removes the files the server returns, from the documents bucket", async () => {
    h.rpc.mockResolvedValue({ data: { deleted: true, file_paths: [`t/chat/${CH}/u_a.pdf`] }, error: null });
    h.remove.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useDeleteChatMessage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ messageId: msg(1).id, channelId: CH }); });
    expect(h.rpc).toHaveBeenCalledWith("chat_delete_message", { p_message_id: msg(1).id });
    expect(h.bucket).toHaveBeenCalledWith("documents");
    expect(h.remove).toHaveBeenCalledWith([`t/chat/${CH}/u_a.pdf`]);
  });

  it("a delete the server refuses toasts its message and removes no file", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "Only the author or the owner can delete this message", code: "42501" } });
    const { result } = renderHook(() => useDeleteChatMessage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ messageId: msg(1).id, channelId: CH }).catch(() => undefined); });
    expect(h.remove).not.toHaveBeenCalled();
    expect((vi.mocked(toastError).mock.calls[0][0] as ChatError).kind).toBe("not_allowed");
  });

  it("mark read zeroes that channel's badge at once and puts it back if the server fails", async () => {
    const before: ChatUnread[] = [{ channel_id: CH, unread: 4, mentions: 1 }, { channel_id: CH2, unread: 1, mentions: 0 }];
    qc.setQueryData(teamChatKeys.unread(), before);
    let done!: (v: Answer) => void;
    h.rpc.mockImplementation(() => new Promise<Answer>((res) => { done = res; }));
    const { result } = renderHook(() => useMarkChatRead(), { wrapper });
    act(() => result.current.mutate({ channelId: CH }));
    await waitFor(() => expect(qc.getQueryData<ChatUnread[]>(teamChatKeys.unread())?.[0]).toEqual({ channel_id: CH, unread: 0, mentions: 0 }));
    expect(h.rpc).toHaveBeenCalledWith("chat_mark_read", { p_channel_id: CH });
    await act(async () => { done({ data: null, error: { message: "Sign in as a team member to use team chat", code: "28000" } }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData(teamChatKeys.unread())).toEqual(before);
  });
});
