// @vitest-environment jsdom
/**
 * R-2329 (G-TEAMCHAT) — an app notice (kind 'system') never offers Edit / Delete or any slot.
 * The R-2305 audit forged "Owner approved: pay vendor 5 lakh today" by editing a system row; the
 * server now refuses it (supabase/tests/team_chat_system_rows.test.sql) and the screen must never
 * offer it either. Ordinary messages keep R-2295's rules: Edit = author within 15 minutes;
 * Delete = author or owner.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";
import type { ChatExtension, MessageSlotProps } from "./composer-slots";
import { MessageList, canDeleteChatMessage, canEditChatMessage } from "./message-list";

afterEach(cleanup);

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALES = "33333333-3333-4333-8333-333333333333";
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-01T10:00:00Z");

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1", tenant_id: "t", channel_id: CH, author_id: SALES, parent_id: null, body: "hello team",
  kind: "text", post_status: null, mentions: [], links: [], task_id: null, feedback_id: null,
  pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, deleted_by: null,
  created_at: "2026-11-01T09:55:00Z", attachments: [], ...over,
}) as ChatMessage;

/** A slot that offers Edit / Delete the way a future actions slot would — through the helpers. */
function ActionsBelow({ message, myUserId }: MessageSlotProps) {
  return (
    <div>
      {canEditChatMessage(message, myUserId, NOW) && <button type="button">Edit</button>}
      {canDeleteChatMessage(message, myUserId, true) && <button type="button">Delete</button>}
    </div>
  );
}
function ActionsBadge() {
  return <button type="button">More actions</button>;
}
const actionsExt: ChatExtension = { id: "actions-probe", MessageBadge: ActionsBadge, MessageBelow: ActionsBelow };

const people = new Map<string, TeamMember>([
  [SALES, { id: SALES, full_name: "Sales", email: "s@example.test", role: "sales", initials: "S", color: null }],
  [OWNER, { id: OWNER, full_name: "Owner", email: "o@example.test", role: "owner", initials: "O", color: null }],
]);

function renderList(messages: ChatMessage[], myUserId: string) {
  return render(
    <MessageList
      channelId={CH} channelLabel="#general" messages={messages} people={people} myUserId={myUserId}
      isLoading={false} isError={false} onRetry={() => {}} hasOlder={false} loadingOlder={false}
      onLoadOlder={() => {}} extensions={[actionsExt]}
    />,
  );
}

describe("R-2329 app notices are locked on the screen", () => {
  it("a system row written with the viewer as author shows no Edit, Delete or any slot", () => {
    // How R-2304 writes it today: author_id = the member whose click made the task.
    const notice = msg({ id: "s1", kind: "system", body: "Made a task for Sales, due 02 Nov 2026" });
    for (const viewer of [SALES, OWNER]) {
      const { container, unmount } = renderList([notice], viewer);
      const li = container.querySelector('li[data-kind="system"]');
      expect(li).not.toBeNull();
      expect(li!.textContent).toBe("Made a task for Sales, due 02 Nov 2026");
      expect(within(li as HTMLElement).queryByRole("button")).toBeNull();
      expect(screen.queryByRole("button", { name: /edit|delete|more actions/i })).toBeNull();
      unmount();
    }
  });

  it("an ordinary message next to it still gets the slots (author sees Edit + Delete)", () => {
    const notice = msg({ id: "s1", kind: "system", body: "Reported as a bug", author_id: null });
    renderList([msg(), notice], SALES);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "More actions" })).toHaveLength(1);
  });

  it("canEdit / canDelete: never on a system row, whoever wrote it and whoever asks", () => {
    for (const author of [SALES, OWNER, null]) {
      const notice = msg({ kind: "system", author_id: author });
      for (const viewer of [SALES, OWNER]) {
        expect(canEditChatMessage(notice, viewer, NOW)).toBe(false);
        expect(canDeleteChatMessage(notice, viewer, true)).toBe(false);
        expect(canDeleteChatMessage(notice, viewer, false)).toBe(false);
      }
    }
  });

  it("canEdit keeps R-2295's rule: author only, within 15 minutes, not deleted / sending", () => {
    expect(canEditChatMessage(msg(), SALES, NOW)).toBe(true);
    expect(canEditChatMessage(msg(), OWNER, NOW)).toBe(false);
    expect(canEditChatMessage(msg(), null, NOW)).toBe(false);
    expect(canEditChatMessage(msg({ created_at: "2026-11-01T09:45:00Z" }), SALES, NOW)).toBe(true);
    expect(canEditChatMessage(msg({ created_at: "2026-11-01T09:44:59Z" }), SALES, NOW)).toBe(false);
    expect(canEditChatMessage(msg({ deleted_at: "2026-11-01T09:58:00Z" }), SALES, NOW)).toBe(false);
    expect(canEditChatMessage(msg({ pending: true }), SALES, NOW)).toBe(false);
    expect(canEditChatMessage(msg({ kind: "problem", post_status: "open" }), SALES, NOW)).toBe(true);
  });

  it("canDelete keeps R-2295's rule: the author or the owner", () => {
    expect(canDeleteChatMessage(msg(), SALES, false)).toBe(true);
    expect(canDeleteChatMessage(msg(), OWNER, true)).toBe(true);
    expect(canDeleteChatMessage(msg(), OWNER, false)).toBe(false);
    expect(canDeleteChatMessage(msg(), null, true)).toBe(false);
    expect(canDeleteChatMessage(msg({ deleted_at: "2026-11-01T09:58:00Z" }), SALES, false)).toBe(false);
  });
});
