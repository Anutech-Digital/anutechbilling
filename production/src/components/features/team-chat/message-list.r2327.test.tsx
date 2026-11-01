// @vitest-environment jsdom
/**
 * R-2327 (1) — localhost check of R-2304: a Problem / Suggestion post showed NO status chip,
 * only its buttons. The chip was drawn only on the author line, so a post sent within 5 minutes
 * of the same person's previous message (a compact line, no name/time) lost it. Every problem /
 * suggestion post now shows its chip in every state (open / task made / reported / resolved),
 * on a full line AND on a compact one; a plain message still shows none.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatChannel, ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

vi.mock("@/lib/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit", "maybeSingle"]) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return { createClient: () => ({ from: () => chain, rpc: vi.fn() }) };
});

import { teamChatKeys } from "@/lib/queries/team-chat";
import { MessageList } from "./message-list";
import { postTypeExtension } from "./slots/post-type";

afterEach(cleanup);

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";

const msg = (id: string, minute: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, tenant_id: "t", channel_id: CH, author_id: ME, parent_id: null, body: `post ${id}`,
  kind: "text", post_status: null, mentions: [], links: [], task_id: null, feedback_id: null,
  pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, deleted_by: null,
  created_at: `2026-11-01T09:${String(minute).padStart(2, "0")}:00Z`, attachments: [], ...over,
}) as ChatMessage;

const people = new Map<string, TeamMember>([
  [ME, { id: ME, full_name: "Owner", email: "o@example.test", role: "owner", initials: "O", color: null }],
]);

function renderList(messages: ChatMessage[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(teamChatKeys.channels(), [{ id: CH, kind: "channel", is_private: false } as ChatChannel]);
  return render(
    <QueryClientProvider client={qc}>
      <MessageList
        channelId={CH} channelLabel="#general" messages={messages} people={people} myUserId={ME}
        isLoading={false} isError={false} onRetry={() => {}} hasOlder={false} loadingOlder={false}
        onLoadOlder={() => {}} extensions={[postTypeExtension!]}
      />
    </QueryClientProvider>,
  );
}

const row = (body: string) => screen.getByText(body).closest("li") as HTMLElement;

describe("R-2327 (1) status chip on every problem / suggestion post", () => {
  it("a plain message, then problem + suggestion posts one minute apart (compact lines): each post has its chip", () => {
    renderList([
      msg("m0", 0),
      msg("m1", 1, { kind: "problem", post_status: "open" }),
      msg("m2", 2, { kind: "problem", post_status: "task", task_id: "t-1" }),
      msg("m3", 3, { kind: "suggestion", post_status: "reported", feedback_id: "f-1" }),
      msg("m4", 4, { kind: "suggestion", post_status: "resolved" }),
    ]);
    expect(within(row("post m1")).getByText("Problem · Open")).toBeTruthy();
    expect(within(row("post m2")).getByText("Problem · Task made")).toBeTruthy();
    expect(within(row("post m3")).getByText("Suggestion · Reported")).toBeTruthy();
    expect(within(row("post m4")).getByText("Suggestion · Resolved")).toBeTruthy();
    expect(within(row("post m0")).queryByText(/Problem|Suggestion/)).toBeNull();
    // Only the first line carries the author name — the others are the compact lines.
    expect(screen.getAllByText("Owner")).toHaveLength(1);
  });

  it("a problem post on its own (full author line) shows its chip once", () => {
    renderList([msg("m1", 1, { kind: "problem", post_status: "open" })]);
    expect(within(row("post m1")).getAllByText("Problem · Open")).toHaveLength(1);
  });

  it("a deleted problem post shows no chip", () => {
    renderList([msg("m0", 0), msg("m1", 1, { kind: "problem", post_status: "open", deleted_at: "2026-11-01T09:02:00Z" })]);
    expect(screen.queryByText("Problem · Open")).toBeNull();
  });
});
