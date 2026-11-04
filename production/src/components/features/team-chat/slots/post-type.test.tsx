// @vitest-environment jsdom
/**
 * R-2304 (G-TEAMCHAT TC-11) — Problem / Suggestion posts in Team chat, through the R-2299 slot
 * API: the composer switch sends draft.kind; each post shows ONE status chip; the poster gets
 * the right primary button per state (open problem → "Make a task"; task made → "Open task")
 * plus "Report as bug / idea" (decision 8: both shown, the poster chooses); "Make a task" sends
 * the chosen teammate + due date to chat_message_to_task; "Report" calls chat_message_report and
 * asks triage after.
 * R-2328: in a DM / private channel both ask first — "Only a link is saved — the text stays in
 * this chat." (the server saves no text there; team_chat_private_to_task.test.sql).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatChannel, ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

const mutate = vi.fn();
vi.mock("@/lib/queries/team-chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/team-chat")>()),
  usePostChatMessage: () => ({ mutate, isPending: false }),
}));
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: "task-1" as string | null, error: null as unknown }));
/* R-2327 (9): tasks.owner_id of a made task (who it is assigned to); other tables are not served. */
const taskRow = { owner_id: null as string | null };
const fromTable = vi.fn((table: string) => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => (table === "tasks" ? { data: { owner_id: taskRow.owner_id }, error: null } : { data: null, error: { message: "not served" } });
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.reject(new Error("not served")).then(ok, bad);
  return chain;
});
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc, from: fromTable }) }));
const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (m: string) => success(m), error: vi.fn() } }));
const toastError = vi.fn();
vi.mock("@/lib/errors/toast-error", () => ({ toastError: (e: unknown) => toastError(e) }));

import { Composer } from "../composer";
import { teamChatKeys } from "@/lib/queries/team-chat";
import {
  PRIVATE_LINK_ONLY, chatChannelIsPrivate, mayOpenChatTask, chatTaskHref, dueAtFromDate, postStatusChip, postTypeExtension, tomorrowIst,
} from "./post-type";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";
const ABHISHEK = "22222222-2222-4222-8222-222222222222";
const ext = postTypeExtension!;
const teammates: TeamMember[] = [
  { id: ME, full_name: "Pardeep", email: "p@example.test", role: "owner", initials: "P", color: null },
  { id: ABHISHEK, full_name: "Abhishek", email: "a@example.test", role: "manager", initials: "A", color: null },
];

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1", tenant_id: "t", channel_id: CH, author_id: ME, parent_id: null, body: "Client X DNS down",
  kind: "problem", post_status: "open", mentions: [], links: [], task_id: null, feedback_id: null,
  pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, deleted_by: null,
  created_at: "2026-10-31T10:00:00Z", attachments: [], ...over,
}) as ChatMessage;

const channel = (over: Partial<ChatChannel> = {}) =>
  ({ id: CH, kind: "channel", is_private: false, ...over }) as ChatChannel;

function renderOnMessage(message: ChatMessage, myUserId: string | null = ME, channels: ChatChannel[] = [channel()]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(teamChatKeys.channels(), channels);
  const slot = { message, channelId: CH, myUserId, teammates };
  const Chip = ext.MessageBadge!;
  const Below = ext.MessageBelow!;
  return render(
    <QueryClientProvider client={qc}>
      <Chip {...slot} />
      <Below {...slot} />
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true }) as Response);

beforeEach(() => {
  mutate.mockReset();
  rpc.mockClear();
  success.mockClear();
  toastError.mockClear();
  fetchMock.mockClear();
  fromTable.mockClear();
  taskRow.owner_id = null;
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2304 post type — composer switch", () => {
  it("is a real extension with a Toolbar, a MessageBadge and a MessageBelow", () => {
    expect(ext.id).toBe("post-type");
    expect(ext.Toolbar && ext.MessageBadge && ext.MessageBelow).toBeTruthy();
  });

  it("Message / Problem / Suggestion set draft.kind and the post is sent as that kind", () => {
    render(<Composer channelId={CH} channelLabel="#general" myUserId={ME} members={[]} teammates={teammates} extensions={[ext]} />);
    const group = screen.getByRole("group", { name: "Post type" });
    const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(group).toBeTruthy();
    expect(btn("Message").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn("Problem"));
    expect(btn("Problem").getAttribute("aria-pressed")).toBe("true");
    expect(btn("Message").getAttribute("aria-pressed")).toBe("false");
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "Client X DNS down" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(mutate.mock.calls[0][0]).toMatchObject({ body: "Client X DNS down", kind: "problem" });
  });
});

describe("R-2304 status chip", () => {
  it("one chip per post state; none on a plain message", () => {
    expect(postStatusChip({ kind: "text", post_status: null })).toBeNull();
    expect(postStatusChip({ kind: "problem", post_status: "open" })).toEqual({ label: "Problem · Open", kind: "warning" });
    expect(postStatusChip({ kind: "problem", post_status: "task" })).toEqual({ label: "Problem · Task made", kind: "success" });
    expect(postStatusChip({ kind: "suggestion", post_status: "reported" })).toEqual({ label: "Suggestion · Reported", kind: "info" });
    expect(postStatusChip({ kind: "suggestion", post_status: "resolved" })?.label).toBe("Suggestion · Resolved");
  });
});

describe("R-2304 the right buttons per state", () => {
  it("open problem, my post → primary Make a task + Report as bug; no Open task", () => {
    renderOnMessage(msg());
    expect(screen.getByText("Problem · Open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make a task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report as bug" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /open task/i })).toBeNull();
  });

  it("task made → Task made chip + Open task link to that task; no Make a task", () => {
    renderOnMessage(msg({ post_status: "task", task_id: "t-9" }));
    expect(screen.getByText("Problem · Task made")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open task/i }).getAttribute("href")).toBe(chatTaskHref("t-9"));
    expect(screen.queryByRole("button", { name: "Make a task" })).toBeNull();
    expect(screen.getByRole("button", { name: "Report as bug" })).toBeTruthy();
  });

  it("reported suggestion → no Report button, Make a task still offered", () => {
    renderOnMessage(msg({ kind: "suggestion", post_status: "reported", feedback_id: "f-1" }));
    expect(screen.getByText("Suggestion · Reported")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /report as/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Make a task" })).toBeTruthy();
  });

  it("someone else's post: no Make / Report buttons, but Open task when there is one", () => {
    renderOnMessage(msg(), ABHISHEK);
    expect(screen.queryByRole("button", { name: "Make a task" })).toBeNull();
    expect(screen.queryByRole("button", { name: /report as/i })).toBeNull();
    cleanup();
    renderOnMessage(msg({ post_status: "task", task_id: "t-9" }), ABHISHEK);
    expect(screen.getByRole("link", { name: /open task/i })).toBeTruthy();
  });

  it("a plain message and a still-sending post show nothing", () => {
    const { container } = renderOnMessage(msg({ kind: "text", post_status: null }));
    expect(container.textContent).toBe("");
    cleanup();
    const r = renderOnMessage(msg({ pending: true }));
    expect(r.queryByRole("button")).toBeNull();
  });
});

describe("R-2304 actions call the RPCs", () => {
  it("Make a task: pick Abhishek + a date → chat_message_to_task with owner and 10:00 IST due", async () => {
    renderOnMessage(msg());
    fireEvent.click(screen.getByRole("button", { name: "Make a task" }));
    const due = screen.getByLabelText(/due/i) as HTMLInputElement;
    expect(due.value).toBe(tomorrowIst());
    fireEvent.change(screen.getByLabelText(/assign to/i), { target: { value: ABHISHEK } });
    fireEvent.change(due, { target: { value: "2026-11-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith("chat_message_to_task", {
      p_message_id: "m1", p_owner_id: ABHISHEK, p_due_at: "2026-11-05T10:00:00+05:30",
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Task made for Abhishek"));
  });

  it("Make a task for myself sends no owner (the server uses the caller)", async () => {
    renderOnMessage(msg());
    fireEvent.click(screen.getByRole("button", { name: "Make a task" }));
    fireEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_owner_id");
  });

  it("a refused task shows the server's message", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "That teammate was not found", code: "P0002" } });
    renderOnMessage(msg());
    fireEvent.click(screen.getByRole("button", { name: "Make a task" }));
    fireEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect((toastError.mock.calls[0][0] as Error).message).toBe("That teammate was not found");
    expect(success).not.toHaveBeenCalled();
  });

  it("Report as bug → chat_message_report, then triage for that report", async () => {
    rpc.mockResolvedValueOnce({ data: "fb-1", error: null });
    renderOnMessage(msg());
    fireEvent.click(screen.getByRole("button", { name: "Report as bug" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Reported as a bug"));
    expect(rpc).toHaveBeenCalledWith("chat_message_report", { p_message_id: "m1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/feedback/triage", expect.objectContaining({
      method: "POST", body: JSON.stringify({ feedbackId: "fb-1" }),
    }));
  });

  it("a suggestion is reported as an idea; a failed triage call still counts as reported", async () => {
    rpc.mockResolvedValueOnce({ data: "fb-2", error: null });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    renderOnMessage(msg({ kind: "suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: "Report as idea" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Sent as an idea"));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("R-2328 DM / private channel: only a link is saved", () => {
  const dm = [channel({ kind: "dm", is_private: true })];
  const priv = [channel({ is_private: true })];

  it("chatChannelIsPrivate: DM and private yes, public no, unknown counts as private", () => {
    expect(chatChannelIsPrivate(dm, CH)).toBe(true);
    expect(chatChannelIsPrivate(priv, CH)).toBe(true);
    expect(chatChannelIsPrivate([channel()], CH)).toBe(false);
    expect(chatChannelIsPrivate(undefined, CH)).toBe(true);
    expect(chatChannelIsPrivate([channel()], "other")).toBe(true);
  });

  it("someone else's DM post (the owner looking): no Make a task / Report", () => {
    renderOnMessage(msg({ author_id: ABHISHEK }), ME, dm);
    expect(screen.queryByRole("button", { name: "Make a task" })).toBeNull();
    expect(screen.queryByRole("button", { name: /report as/i })).toBeNull();
  });

  it("my DM post → Make a task says only a link is saved, then calls the RPC", async () => {
    renderOnMessage(msg(), ME, dm);
    fireEvent.click(screen.getByRole("button", { name: "Make a task" }));
    expect(screen.getByText(PRIVATE_LINK_ONLY)).toBeTruthy();
    expect(screen.queryByText(/gets this post/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("chat_message_to_task", expect.objectContaining({ p_message_id: "m1" })));
  });

  it("my private-channel post → Report asks first; Cancel sends nothing, Report sends it", async () => {
    rpc.mockResolvedValueOnce({ data: "fb-3", error: null });
    renderOnMessage(msg(), ME, priv);
    fireEvent.click(screen.getByRole("button", { name: "Report as bug" }));
    expect(screen.getByText(PRIVATE_LINK_ONLY)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Report as bug" }));
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Reported as a bug"));
    expect(rpc).toHaveBeenCalledWith("chat_message_report", { p_message_id: "m1" });
  });

  it("public channel: Make a task keeps today's text, Report needs no confirm", () => {
    renderOnMessage(msg());
    fireEvent.click(screen.getByRole("button", { name: "Make a task" }));
    expect(screen.queryByText(PRIVATE_LINK_ONLY)).toBeNull();
    expect(screen.getByText(/gets this post/i)).toBeTruthy();
  });
});

describe("R-2327 (9) DM / private post with a task: Open task only for the poster and the assignee", () => {
  const dm = [channel({ kind: "dm", is_private: true })];
  const priv = [channel({ is_private: true })];
  const made = (over: Partial<ChatMessage> = {}) => msg({ author_id: ABHISHEK, post_status: "task", task_id: "t-9", ...over });

  it("mayOpenChatTask: public = everyone; private = poster or assignee only; unknown assignee = no", () => {
    expect(mayOpenChatTask({ isPrivate: false, myUserId: ME, authorId: ABHISHEK, taskOwnerId: null })).toBe(true);
    expect(mayOpenChatTask({ isPrivate: true, myUserId: ABHISHEK, authorId: ABHISHEK, taskOwnerId: null })).toBe(true);
    expect(mayOpenChatTask({ isPrivate: true, myUserId: ME, authorId: ABHISHEK, taskOwnerId: ME })).toBe(true);
    expect(mayOpenChatTask({ isPrivate: true, myUserId: ME, authorId: ABHISHEK, taskOwnerId: ABHISHEK })).toBe(false);
    expect(mayOpenChatTask({ isPrivate: true, myUserId: ME, authorId: ABHISHEK, taskOwnerId: null })).toBe(false);
    expect(mayOpenChatTask({ isPrivate: true, myUserId: null, authorId: ABHISHEK, taskOwnerId: null })).toBe(false);
  });

  it("the other owner looking at someone else's DM post whose task is assigned to the poster: no Open task, no button at all", async () => {
    taskRow.owner_id = ABHISHEK;
    const { container } = renderOnMessage(made(), ME, dm);
    await waitFor(() => expect(fromTable).toHaveBeenCalledWith("tasks"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("link", { name: /open task/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("Problem · Task made");
  });

  it("the teammate the private-channel task is assigned to sees Open task", async () => {
    taskRow.owner_id = ME;
    renderOnMessage(made(), ME, priv);
    expect(await screen.findByRole("link", { name: /open task/i })).toBeTruthy();
  });

  it("the poster of a DM post sees Open task without any extra read", () => {
    renderOnMessage(made({ author_id: ME }), ME, dm);
    expect(screen.getByRole("link", { name: /open task/i }).getAttribute("href")).toBe(chatTaskHref("t-9"));
    expect(fromTable).not.toHaveBeenCalledWith("tasks");
  });

  it("a public channel keeps Open task for everyone, with no extra read", () => {
    renderOnMessage(made(), ME);
    expect(screen.getByRole("link", { name: /open task/i })).toBeTruthy();
    expect(fromTable).not.toHaveBeenCalledWith("tasks");
  });
});

describe("R-2304 helpers", () => {
  it("due date → 10:00 India time; tomorrow in India time", () => {
    expect(dueAtFromDate("2026-11-05")).toBe("2026-11-05T10:00:00+05:30");
    // 31 Oct 20:00 UTC = 1 Nov 01:30 IST → tomorrow in India is 2 Nov
    expect(tomorrowIst(new Date("2026-10-31T20:00:00Z"))).toBe("2026-11-02");
    expect(tomorrowIst(new Date("2026-10-31T10:00:00Z"))).toBe("2026-11-01");
  });
});
