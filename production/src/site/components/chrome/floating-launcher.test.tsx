// @vitest-environment jsdom
//
// R-1498 (17 Oct 2026, Pawan on staging): the "Talk to our live AI sales agent" launcher and the
// "WhatsApp us" pill stacked bottom-right on every page and covered content. Now the site floats
// ONE launcher; pressing it opens a small menu with "Chat with our AI sales agent" (the existing
// chat) and "WhatsApp us" (the same wa.me link). R-230 stays: hidden on /checkout and /done.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { AgentChat } from "@/site/components/agent/AgentChat";
import { WHATSAPP_URL } from "@/site/lib/config";

const LAUNCHER = /^Talk to us/;

beforeEach(() => {
  pathname = "/";
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe("one floating launcher (R-1498)", () => {
  it("the marketing layout floats only the launcher — no separate WhatsApp pill", () => {
    const layout = readFileSync("src/app/(marketing)/layout.tsx", "utf8");
    expect(layout).not.toMatch(/WhatsAppButton/);
    expect(layout).toMatch(/<AgentChat \/>/);
    const chrome = readFileSync("src/site/components/chrome/Chrome.tsx", "utf8");
    expect(chrome).not.toMatch(/floating-wa/);
  });

  it("renders exactly one floating button, closed", () => {
    render(<AgentChat />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toMatch(LAUNCHER);
    expect(buttons[0].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
  });

  it("pressing it opens a menu with both actions; the WhatsApp item is the same wa.me link", () => {
    render(<AgentChat />);
    const launcher = screen.getByRole("button", { name: LAUNCHER });
    fireEvent.click(launcher);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    const chat = screen.getByRole("button", { name: "Chat with our AI sales agent" });
    const wa = screen.getByRole("link", { name: "WhatsApp us" });
    expect(wa.getAttribute("href")).toBe(WHATSAPP_URL);
    expect(document.activeElement).toBe(chat);
  });

  it("the chat item opens the existing AI chat and closes the menu", () => {
    render(<AgentChat />);
    fireEvent.click(screen.getByRole("button", { name: LAUNCHER }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with our AI sales agent" }));
    expect(screen.getByRole("dialog", { name: "AI sales agent chat" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
  });

  it("Escape closes the menu and puts focus back on the launcher", () => {
    render(<AgentChat />);
    const launcher = screen.getByRole("button", { name: LAUNCHER });
    fireEvent.click(launcher);
    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Chat with our AI sales agent" })).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("nothing floats on /checkout and /done (R-230)", () => {
    for (const p of ["/checkout", "/done"]) {
      pathname = p;
      const { container, unmount } = render(<AgentChat />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});
