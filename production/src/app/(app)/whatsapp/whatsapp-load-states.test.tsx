// @vitest-environment jsdom
/**
 * R-1534 — a WhatsApp chat that failed to load must not say "No messages yet — say hi".
 * Before: ThreadPane read only isLoading, so a failed fetch looked like an empty chat and
 * the rep sent the customer a second "hi". The conversation list also printed the raw
 * error text with no way to retry. Pinned: error → plain words + Try again (and no reply
 * box that pretends the chat is empty); "say hi" only when the load SUCCEEDED with zero.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const state = vi.hoisted(() => ({
  convos: {} as Record<string, unknown>,
  thread: {} as Record<string, unknown>,
}));

vi.mock("@/lib/queries/whatsapp", () => ({
  useWhatsAppConversations: () => state.convos,
  useWhatsAppThread: (phone: string | null) => (phone ? state.thread : { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useSendWhatsApp: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import WhatsAppInboxPage from "./page";

const convo = {
  contact_phone: "+919800000001",
  unread_count: 0,
  last_message: { created_at: new Date().toISOString(), direction: "inbound", text_body: "Hello", type: "text" },
};
const okConvos = { data: [convo], isLoading: false, isError: false, error: null, hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false, refetch: vi.fn() };
const RAW = 'relation "whatsapp_messages" does not exist';

beforeEach(() => {
  state.convos = okConvos;
  state.thread = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function openChat() {
  render(<WhatsAppInboxPage />);
  fireEvent.click(screen.getByText("+919800000001"));
}

describe("WhatsApp chat — loading / error / empty (R-1534)", () => {
  it("a failed chat load shows plain words + Try again, never 'say hi'", () => {
    const refetch = vi.fn();
    state.thread = { data: undefined, isLoading: false, isError: true, error: { message: RAW, code: "42P01" }, refetch };
    openChat();
    expect(screen.queryByText(/say hi/i)).toBeNull();
    expect(screen.queryByText(RAW)).toBeNull();
    expect(screen.getByText(/didn.t load/i)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalled();
  });

  it("'say hi' only when the chat loaded and really has no messages", () => {
    state.thread = { data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() };
    openChat();
    expect(screen.getByText(/say hi/i)).toBeTruthy();
  });

  it("while loading: no 'say hi'", () => {
    openChat();
    expect(screen.queryByText(/say hi/i)).toBeNull();
  });

  it("a failed conversation list shows plain words + Try again, not the raw error", () => {
    const refetch = vi.fn();
    state.convos = { ...okConvos, data: undefined, isError: true, error: { message: RAW }, refetch };
    render(<WhatsAppInboxPage />);
    expect(screen.queryByText(new RegExp(RAW))).toBeNull();
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalled();
  });
});
