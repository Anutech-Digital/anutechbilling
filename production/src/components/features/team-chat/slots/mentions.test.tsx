// @vitest-environment jsdom
/**
 * R-2303 (G-TEAMCHAT TC-10) — @mentions with autocomplete, through the R-2299 slot API only.
 *
 * Owner's path: in #accounts the owner types "@Hit", picks Hitesh with the arrow keys + Enter
 * (Enter must NOT send while the list is open), finishes "check this" and sends — the message
 * goes out with Hitesh's user id in `mentions` (the server then writes his 'chat.mention'
 * bell item with href /team-chat?c=<channel>&m=<message>). Only THIS channel's members are
 * offered; deleting the "@Hitesh Kumar" token takes his id back out. In the conversation a
 * message that mentions me says so, and opening /team-chat?…&m=<id> scrolls to that message.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMember, ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

const mutate = vi.fn();
vi.mock("@/lib/queries/team-chat", () => ({ usePostChatMessage: () => ({ mutate, isPending: false }) }));

import { Composer } from "../composer";
import { mentionsExtension, findMentionQuery } from "./mentions";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";
const HITESH = "22222222-2222-4222-8222-222222222222";
const HIMA = "33333333-3333-4333-8333-333333333333";
const ACCT = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";

const person = (id: string, full_name: string): TeamMember => ({ id, full_name, email: null, role: "staff", initials: null, color: null });
const TEAMMATES: TeamMember[] = [
  person(ME, "Pardeep Sharma"),
  person(HITESH, "Hitesh Kumar"),
  person(HIMA, "Himani Rao"),
  person(ACCT, "E2E Accountant"),
  person(OUTSIDER, "Harish Outsider"), // a teammate, but NOT in this channel
];
const member = (user_id: string): ChatMember =>
  ({ channel_id: CH, user_id, tenant_id: "t", joined_at: "2026-10-31T00:00:00Z", last_read_at: null, member_role: "member", notify: "all" });
const MEMBERS = [ME, HITESH, HIMA, ACCT].map(member);

const ext = mentionsExtension!;
const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const options = () => screen.queryAllByRole("option").map((o) => o.getAttribute("aria-label"));
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const key = (k: string) => fireEvent.keyDown(box(), { key: k });

const renderComposer = () =>
  render(<Composer channelId={CH} channelLabel="#accounts" myUserId={ME} members={MEMBERS} teammates={TEAMMATES} extensions={[ext]} />);

beforeEach(() => { mutate.mockReset(); });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("R-2303 @mention autocomplete in the composer", () => {
  it("is a real extension (not the R-2299 null stub)", () => {
    expect(mentionsExtension).not.toBeNull();
    expect(ext.id).toBe("mentions");
    expect(ext.Popover).toBeTypeOf("function");
  });

  it("typing @ lists THIS channel's members only, and filters as you type", () => {
    renderComposer();
    expect(screen.queryByRole("listbox")).toBeNull();
    type("@");
    expect(screen.getByRole("listbox", { name: "Mention a teammate" })).toBeTruthy();
    expect(options()).toEqual(["E2E Accountant", "Himani Rao", "Hitesh Kumar", "Pardeep Sharma"]);
    expect(options()).not.toContain("Harish Outsider");
    type("@Hi");
    expect(options()).toEqual(["Himani Rao", "Hitesh Kumar"]);
    type("@kum"); // any word of the name
    expect(options()).toEqual(["Hitesh Kumar"]);
    type("@zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("an @ inside a word (an email) does not open the list", () => {
    renderComposer();
    type("mail ravi@hi");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrow keys + Enter pick a name; Enter does not send while the list is open", () => {
    renderComposer();
    type("@Hi");
    key("ArrowDown"); // Himani → Hitesh
    key("Enter");
    expect(mutate).not.toHaveBeenCalled();
    expect(box().value).toBe("@Hitesh Kumar ");
    expect(screen.queryByRole("listbox")).toBeNull();

    type("@Hitesh Kumar check this");
    key("Enter"); // list closed → Enter sends
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ channelId: CH, body: "@Hitesh Kumar check this", mentions: [HITESH] });
  });

  it("clicking a name inserts a readable token mid-sentence and adds the id", () => {
    renderComposer();
    type("please @e2e");
    fireEvent.mouseDown(screen.getByRole("option", { name: "E2E Accountant" }));
    expect(box().value).toBe("please @E2E Accountant ");
    type("please @E2E Accountant see the GST file");
    key("Enter");
    expect(mutate.mock.calls[0][0]).toMatchObject({ body: "please @E2E Accountant see the GST file", mentions: [ACCT] });
  });

  it("removing the token takes the user id back out of the mentions", () => {
    renderComposer();
    type("@Hit");
    key("Enter");
    type("@Hitesh Kumar and @Him");
    key("Enter");
    expect(box().value).toBe("@Hitesh Kumar and @Himani Rao ");
    type("and @Himani Rao "); // Hitesh's token deleted
    key("Enter");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].mentions).toEqual([HIMA]);
  });

  it("Escape closes the list (and the next Enter sends); Tab also picks", () => {
    renderComposer();
    type("@Hi");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("@Hite");
    key("Tab");
    expect(box().value).toBe("@Hitesh Kumar ");
    type("@Hi there");
    key("Enter");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].mentions).toEqual([]);
  });
});

describe("findMentionQuery", () => {
  it("finds the @word being typed at the caret", () => {
    expect(findMentionQuery("hi @Hit", 7)).toEqual({ at: 3, query: "Hit" });
    expect(findMentionQuery("@", 1)).toEqual({ at: 0, query: "" });
    expect(findMentionQuery("hi @Hitesh Ku", 13)).toEqual({ at: 3, query: "Hitesh Ku" });
    expect(findMentionQuery("a@b", 3)).toBeNull();
    expect(findMentionQuery("hi there", 8)).toBeNull();
    expect(findMentionQuery("@a\nb", 4)).toBeNull();
  });
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m-1", channel_id: CH, tenant_id: "t", author_id: HITESH, body: "@Pardeep Sharma check this", kind: "text",
  created_at: "2026-10-31T10:00:00Z", edited_at: null, deleted_at: null, deleted_by: null, feedback_id: null,
  links: [], mentions: [ME], parent_id: null, pinned_at: null, pinned_by: null, post_status: null, task_id: null,
  attachments: [], ...over,
} as ChatMessage);

describe("R-2303 mentions in the conversation", () => {
  const Below = ext.MessageBelow!;
  const renderBelow = (m: ChatMessage, myUserId: string | null = ME) =>
    render(<ul><li data-testid="row"><Below message={m} channelId={CH} myUserId={myUserId} teammates={TEAMMATES} /></li></ul>);

  it("a message that mentions me says so; one that does not shows nothing", () => {
    renderBelow(message());
    expect(screen.getByText("Mentioned you")).toBeTruthy();
    cleanup();
    renderBelow(message({ mentions: [HITESH] }));
    expect(screen.queryByText("Mentioned you")).toBeNull();
  });

  it("the bell link ?m=<id> scrolls to and highlights exactly that message, then leaves the URL", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", `/team-chat?c=${CH}&m=m-2`);
    renderBelow(message({ id: "m-1" }));
    expect(scroll).not.toHaveBeenCalled();
    cleanup();
    renderBelow(message({ id: "m-2", mentions: [] }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("row").getAttribute("data-chat-target")).toBe("true");
    expect(window.location.search).toBe(`?c=${CH}`);
  });
});
