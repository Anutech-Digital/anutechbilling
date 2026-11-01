// @vitest-environment jsdom
/**
 * R-2327 (8) — a task made from a Team chat post (R-2304 / R-2328) carries the line
 * "From team chat: /team-chat?c=<channel>&m=<message>" in its notes. On /tasks it was plain
 * text. It now shows as ONE clickable "Open in team chat" link (row and edit sheet). Only that
 * exact same-origin relative /team-chat address becomes a link — any other URL, a look-alike
 * path, or a different host stays plain text.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { TaskNotes, TaskChatLink, taskNoteParts } from "./task-notes";
import { TaskRow } from "./task-row";
import type { TaskWithLink } from "@/lib/queries/tasks";

afterEach(cleanup);

const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HREF = `/team-chat?c=${C}&m=${M}`;

describe("taskNoteParts", () => {
  it("the R-2304 notes: text, then the chat line as a link", () => {
    expect(taskNoteParts(`Client X DNS down\n\nFrom team chat: ${HREF}`)).toEqual({ text: "Client X DNS down", chatHref: HREF });
  });

  it("R-2328 private notes are only the line", () => {
    expect(taskNoteParts(`From team chat: ${HREF}`)).toEqual({ text: "", chatHref: HREF });
  });

  it("plain notes stay as they are", () => {
    expect(taskNoteParts("Call after 5")).toEqual({ text: "Call after 5", chatHref: null });
  });

  it("only the exact relative /team-chat address becomes a link", () => {
    const bad = [
      `From team chat: https://evil.example.com${HREF}`,
      `From team chat: //evil.example.com${HREF}`,
      `From team chat: /team-chat?c=${C}&m=${M}&next=https://evil.example.com`,
      `From team chat: /team-chat-evil?c=${C}&m=${M}`,
      `From team chat: /quotes/Q-1`,
      `From team chat: javascript:alert(1)`,
      `From team chat: /team-chat?c=not-a-uuid&m=${M}`,
    ];
    for (const notes of bad) expect(taskNoteParts(notes).chatHref, notes).toBeNull();
  });
});

describe("TaskNotes / TaskChatLink", () => {
  it("shows the text and an 'Open in team chat' link to that message", () => {
    render(<TaskNotes notes={`Client X DNS down\n\nFrom team chat: ${HREF}`} />);
    expect(screen.getByText("Client X DNS down")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open in team chat" });
    expect(link.getAttribute("href")).toBe(HREF);
    expect(link.getAttribute("target")).toBeNull();
    expect(screen.queryByText(/From team chat:/)).toBeNull();
  });

  it("another URL in the notes is never a link", () => {
    render(<TaskNotes notes="See https://evil.example.com/team-chat?c=1 now" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/evil\.example\.com/)).toBeTruthy();
  });

  it("TaskChatLink draws nothing for notes without the line", () => {
    const { container } = render(<TaskChatLink notes="Call after 5" />);
    expect(container.textContent).toBe("");
  });
});

describe("the /tasks row", () => {
  it("a task made from Team chat shows 'Open in team chat' on its row", () => {
    const task = {
      id: "t1", title: "Problem: Client X DNS down", kind: "custom", status: "pending", due_at: "2026-11-02T04:30:00Z",
      completed_at: null, completed_by: null, snooze_count: 0, notes: `Client X DNS down\n\nFrom team chat: ${HREF}`,
      owner_id: null, lead_id: null, quote_id: null, customer_id: null, subscription_id: null,
      leads: null, customers: null, quotes: null,
    } as unknown as TaskWithLink;
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ul><TaskRow task={task} onEdit={() => {}} /></ul>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("link", { name: "Open in team chat" }).getAttribute("href")).toBe(HREF);
  });
});
