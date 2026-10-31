// @vitest-environment jsdom
/**
 * R-2300 (G-TEAMCHAT TC-07): the topbar chat icon. People must notice a new team message from
 * any page without mixing it up with AI Help — so the badge is the total of chat_unread_counts()
 * (useChatUnreadCounts → chatUnreadTotals, polled every 30 s by the hook), it is hidden at 0,
 * the icon is not AI Help's, and a click opens Team chat at the first unread conversation.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChatUnread } from "@/lib/team-chat/types";

const st = vi.hoisted(() => ({ rows: [] as ChatUnread[] | undefined }));
vi.mock("@/lib/queries/team-chat", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/team-chat")>();
  return { ...real, useChatUnreadCounts: () => ({ data: st.rows }) };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/dashboard" }));

import { TeamChatButton, TeamChatUnreadDot, teamChatHref, TEAM_CHAT_ICON } from "../team-chat-button";
import { AiHelpButton } from "@/components/shared/ai-help";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);
const row = (channel_id: string, unread: number, mentions = 0): ChatUnread => ({ channel_id, unread, mentions });

describe("TeamChatButton (R-2300)", () => {
  it("shows the total unread across every channel and DM", () => {
    st.rows = [row("c1", 2), row("dm1", 1)];
    wrap(<TeamChatButton />);
    const link = screen.getByRole("link", { name: "Team chat — 3 unread messages" });
    expect(link.querySelector("[data-chat-badge]")?.textContent).toBe("3");
  });

  it("hides the badge at 0 (and while loading)", () => {
    for (const rows of [[], [row("c1", 0)], undefined]) {
      st.rows = rows;
      const { container, unmount } = wrap(<TeamChatButton />);
      expect(container.querySelector("[data-chat-badge]")).toBeNull();
      expect(screen.getByRole("link", { name: "Team chat" })).toBeTruthy();
      unmount();
    }
  });

  it("caps a big count at 99+", () => {
    st.rows = [row("c1", 150)];
    const { container } = wrap(<TeamChatButton />);
    expect(container.querySelector("[data-chat-badge]")?.textContent).toBe("99+");
  });

  it("opens Team chat at the first unread conversation (a mention first), else the page", () => {
    expect(teamChatHref(undefined)).toBe("/team-chat");
    expect(teamChatHref([row("c1", 0)])).toBe("/team-chat");
    expect(teamChatHref([row("c1", 4), row("dm1", 1, 1)])).toBe("/team-chat?c=dm1");
    expect(teamChatHref([row("c1", 4), row("dm1", 1)])).toBe("/team-chat?c=c1");
    st.rows = [row("dm 1", 1)];
    wrap(<TeamChatButton />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/team-chat?c=dm%201");
  });

  it("phone: a dot on More while unread, none at 0", () => {
    st.rows = [row("c1", 1)];
    expect(wrap(<TeamChatUnreadDot />).container.querySelector("[data-chat-dot]")).not.toBeNull();
    cleanup();
    st.rows = [];
    expect(wrap(<TeamChatUnreadDot />).container.querySelector("[data-chat-dot]")).toBeNull();
  });

  it("uses a different icon from AI Help", () => {
    st.rows = [];
    const chat = wrap(<TeamChatButton />).container.querySelector("svg")?.getAttribute("class") ?? "";
    cleanup();
    const help = wrap(<AiHelpButton />).container.querySelector("svg")?.getAttribute("class") ?? "";
    expect(TEAM_CHAT_ICON).not.toBe("message");
    expect(chat).toMatch(/lucide-messages-square/);
    expect(help).not.toMatch(/lucide-messages-square/);
  });
});

describe("topbar wiring (R-2300)", () => {
  const topbar = readFileSync(join(process.cwd(), "src/components/layout/topbar.tsx"), "utf8");
  const help = readFileSync(join(process.cwd(), "src/components/shared/ai-help.tsx"), "utf8");

  it("shows the chat icon only to roles that may open /team-chat", () => {
    expect(topbar).toMatch(/const showTeamChat = !!me\?\.role && canOpenRoute\(me\.role, "\/team-chat"\);/);
    expect(topbar).toMatch(/\{showTeamChat && <TeamChatButton className="hidden sm:inline-flex" \/>\}/);
  });

  it("has a Team chat row in the phone More menu", () => {
    const menu = topbar.slice(topbar.indexOf('data-topbar="more"'));
    const body = menu.slice(0, menu.indexOf("</DropdownMenu>"));
    expect(body).toMatch(/\{showTeamChat && <TeamChatMenuItem \/>\}/);
    expect(menu.slice(0, menu.indexOf("<DropdownMenuContent"))).toMatch(/\{showTeamChat && <TeamChatUnreadDot \/>\}/);
  });

  it("the Help tooltip reads 'Help & AI' so it is not taken for chat", () => {
    expect(help).toMatch(/title=\{alert \? `Error caught: \$\{alert\}` : "Help & AI/);
  });
});
