// @vitest-environment jsdom
/**
 * R-2299 (G-TEAMCHAT TC-06) — the Team chat page, as the owner uses it.
 *
 * Owner example: Pardeep opens Team chat; #general is open, #sales has 3 unread and shows
 * bold until he opens it. He types "Is ka payment aaya?" and presses Enter — it is sent;
 * Shift+Enter only starts a new line. If the server refuses (he was removed from the
 * channel), ONE plain-English toast says why and his text is back in the box. On a phone the
 * channel list comes first, a tap opens the conversation, "Back" returns to the list.
 *
 * Reads are faked (channels, messages, unread counts, members); sending runs the REAL
 * usePostChatMessage against a fake Supabase rpc, so the toast is the hook's own (§24) and
 * the page adds none.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ME = "11111111-1111-4111-8111-111111111111";
const HITESH = "22222222-2222-4222-8222-222222222222";
const GENERAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALES = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  toastError: vi.fn(),
  markRead: vi.fn(),
  openDm: vi.fn(),
  fetchOlder: vi.fn(),
  mobile: false,
  channels: [] as unknown[],
  unread: [] as unknown[],
  messages: {} as Record<string, unknown[]>,
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: h.toastError, success: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/hooks/useBreakpoint", () => ({
  useBreakpoint: () => ({ isMobile: h.mobile, isTablet: false, isDesktop: !h.mobile, width: h.mobile ? 375 : 1280 }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { userId: ME, fullName: "Pardeep Sharma", initials: "PS", color: "amber", role: "owner" } }),
}));
vi.mock("@/lib/queries/team", () => ({
  useTeamMembers: () => ({
    data: [
      { id: ME, full_name: "Pardeep Sharma", email: "p@x.in", role: "owner", initials: "PS", color: "amber" },
      { id: HITESH, full_name: "Hitesh Kumar", email: "h@x.in", role: "accountant", initials: "HK", color: "indigo" },
    ],
  }),
  memberLabel: (m: { full_name: string | null } | undefined) => m?.full_name ?? "Teammate",
}));
vi.mock("@/lib/queries/team-chat", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/team-chat")>();
  return {
    ...real,
    useChatChannels: () => ({ data: h.channels, isLoading: false, isError: false }),
    useChatUnreadCounts: () => ({ data: h.unread }),
    useChatChannelMembers: () => ({ data: [] }),
    useChatMessages: (id: string | null) => ({
      messages: id ? h.messages[id] ?? [] : [],
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: h.fetchOlder,
    }),
    useMarkChatRead: () => ({ mutate: h.markRead }),
    useOpenChatDm: () => ({ mutate: h.openDm, isPending: false }),
  };
});

import { TeamChatView } from "./team-chat-view";

const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, tenant_id: "t1", kind: "channel", name, slug: name, topic: null, is_private: false, dm_key: null,
  archived_at: null, created_by: ME, created_at: "2026-10-01T05:00:00Z", ...extra,
});
const msg = (id: string, body: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, tenant_id: "t1", channel_id: GENERAL, author_id: HITESH, parent_id: null, body, kind: "text",
  post_status: null, mentions: [], links: [], task_id: null, feedback_id: null, pinned_at: null, pinned_by: null,
  edited_at: null, deleted_at: null, deleted_by: null, created_at: at, attachments: [], ...extra,
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamChatView />
    </QueryClientProvider>,
  );
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/team-chat");
  h.mobile = false;
  h.rpc.mockReset();
  h.toastError.mockReset();
  h.markRead.mockReset();
  h.openDm.mockReset();
  h.channels = [
    channel(GENERAL, "general"),
    channel(SALES, "sales"),
    { ...channel(DM, ""), kind: "dm", name: null, slug: null, is_private: true, dm_key: `${ME}:${HITESH}` },
  ];
  h.unread = [{ channel_id: SALES, unread: 3, mentions: 0 }];
  h.messages = {};
});
afterEach(cleanup);

describe("R-2299 Team chat page", () => {
  it("empty state: #general opens by itself and says how to start", async () => {
    renderView();
    expect(await screen.findByText("No messages in #general yet")).toBeTruthy();
    expect(screen.getByText(/Write the first message below/)).toBeTruthy();
    expect(h.markRead).toHaveBeenCalledWith({ channelId: GENERAL });
  });

  it("no channels at all: a clear empty list, not a blank page", () => {
    h.channels = [];
    renderView();
    expect(screen.getByText("No conversations yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New message" })).toBeTruthy();
  });

  it("an unread channel is bold with its count until it is opened, then marked read", async () => {
    renderView();
    const list = screen.getByRole("navigation", { name: "Conversations" });
    const sales = within(list).getByRole("button", { name: /#sales.*3 unread/ });
    expect(sales.className).toMatch(/font-semibold/);
    const general = within(list).getByRole("button", { name: /#general/ });
    expect(general.className).not.toMatch(/font-semibold/);
    fireEvent.click(sales);
    await waitFor(() => expect(h.markRead).toHaveBeenCalledWith({ channelId: SALES }));
    expect(new URLSearchParams(window.location.search).get("c")).toBe(SALES);
  });

  it("a DM shows the teammate's name, not an id", () => {
    renderView();
    const list = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(list).getByRole("button", { name: /Hitesh Kumar/ })).toBeTruthy();
  });

  it("Enter sends the message and clears the box", async () => {
    h.rpc.mockResolvedValue({ data: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", error: null });
    renderView();
    fireEvent.change(box(), { target: { value: "Is ka payment aaya?" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc.mock.calls[0][0]).toBe("chat_post_message");
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_channel_id: GENERAL, p_body: "Is ka payment aaya?", p_kind: "text" });
    expect(box().value).toBe("");
  });

  it("Shift+Enter does not send (it is a new line)", () => {
    renderView();
    fireEvent.change(box(), { target: { value: "Line one" } });
    const ev = fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(ev).toBe(true); // not prevented → the browser adds the new line
    expect(h.rpc).not.toHaveBeenCalled();
    expect(box().value).toBe("Line one");
  });

  it("an empty box never sends", () => {
    renderView();
    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused send: ONE plain-English toast, and the text is back in the box", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "You are not a member of this channel", code: "42501" } });
    renderView();
    fireEvent.change(box(), { target: { value: "Hello team" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError.mock.calls[0][0]).toBe("You are not a member of this channel");
    await waitFor(() => expect(box().value).toBe("Hello team"));
  });

  it("messages: day dividers, author initials, 'edited' and 'deleted' placeholders, safe links", async () => {
    h.messages[GENERAL] = [
      msg("m1", "Bank statement upload kiya", "2026-10-20T05:00:00Z"),
      msg("m2", "Check /invoices/abc please", "2026-10-21T05:00:00Z", { edited_at: "2026-10-21T05:10:00Z" }),
      msg("m3", "secret old text", "2026-10-21T06:00:00Z", { deleted_at: "2026-10-21T06:05:00Z", body: "" }),
      msg("m4", "<script>alert(1)</script> https://anutech.in", "2026-10-21T07:00:00Z", { author_id: ME }),
    ];
    renderView();
    const log = await screen.findByRole("log", { name: /#general/ });
    expect(within(log).getAllByRole("separator").map((s) => s.textContent)).toEqual([
      expect.stringContaining("20 Oct"),
      expect.stringContaining("21 Oct"),
    ]);
    expect(within(log).getAllByText("HK").length).toBeGreaterThan(0);
    expect(within(log).getByText("(edited)")).toBeTruthy();
    expect(within(log).getByText("This message was deleted.")).toBeTruthy();
    expect(within(log).queryByText(/secret old text/)).toBeNull();
    expect(within(log).getByRole("link", { name: "/invoices/abc" }).getAttribute("href")).toBe("/invoices/abc");
    const ext = within(log).getByRole("link", { name: "https://anutech.in" });
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toContain("noopener");
    expect(log.querySelector("script")).toBeNull();
    expect(within(log).getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
  });

  it("New message: pick a teammate → opens the DM", async () => {
    h.openDm.mockImplementation((_v: unknown, opts: { onSuccess?: (id: string) => void }) => opts?.onSuccess?.(DM));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hitesh Kumar/, hidden: false }));
    expect(h.openDm.mock.calls[0][0]).toEqual({ userId: HITESH });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("c")).toBe(DM));
  });

  it("phone: the list first, a tap opens the conversation, Back returns to the list", async () => {
    h.mobile = true;
    renderView();
    expect(screen.getByRole("navigation", { name: "Conversations" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /#general/ }));
    expect(await screen.findByRole("textbox", { name: /message/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Conversations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(screen.getByRole("navigation", { name: "Conversations" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
  });
});
