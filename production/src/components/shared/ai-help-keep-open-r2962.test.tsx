// @vitest-environment jsdom
/**
 * R-2962 — opening a page from a Help AI answer keeps help with the person.
 *  - desktop: the "→ <page>" action opens the page and help stays OPEN with the same chat;
 *    focus stays on the pressed button inside help (the next step is read right there);
 *  - phone: the action minimises help (not closes); "Open help" shows the same chat;
 *    focus moves to the "Open help" bar, the only help control still on screen;
 *  - docked help on a desktop reserves room on the page (--ai-help-page, read by the app
 *    layout's <main>) so no form field sits under the panel; nothing on a phone, when
 *    minimised or closed, or when the panel is so wide the page would be squeezed out.
 * The AI answer is a stubbed /api/ai/help reply — nothing here calls a model.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: nav.push }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton, helpPagePad, PAGE_MIN_ROOM } from "./ai-help";

const REPLY = {
  reply: "1. Open Expenses. 2. Press New expense. 3. Fill the amount and save.",
  actions: [{ kind: "open", label: "Open Expenses", href: "/accounting/expenses" }],
  ai: true,
};

const setWidth = (w: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: w });

beforeEach(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() },
  });
  setWidth(1280);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Element.prototype.scrollIntoView = vi.fn();
  nav.push.mockReset();
  window.fetch = vi.fn(async () => new Response(JSON.stringify(REPLY), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
});
afterEach(() => {
  const bar = screen.queryByRole("button", { name: "Close help", hidden: true });
  if (bar) fireEvent.click(bar);
  const btn = screen.queryByRole("button", { name: /^Help —/, hidden: true });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

async function askHowToRecord() {
  render(<><AiHelpButton /><AiHelp /></>);
  fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
  await flush();
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "How do I record an expense?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await flush();
  return screen.getByRole("button", { name: /Open Expenses/ });
}

describe("R-2962: an answer's page link keeps help open", () => {
  it("desktop: opens the page, help stays open with the same chat, focus stays on the pressed button", async () => {
    const action = await askHowToRecord();
    action.focus();
    fireEvent.click(action);
    await flush();
    expect(nav.push).toHaveBeenCalledWith("/accounting/expenses");
    const panel = screen.getByRole("dialog", { name: "Help" });
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("How do I record an expense?");
    expect(panel.textContent).toContain("Press New expense");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Open Expenses/ }));
    expect(screen.getByRole("button", { name: /^Help —/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("phone: opens the page and minimises help (not closed); Open help shows the same chat", async () => {
    setWidth(390);
    const action = await askHowToRecord();
    fireEvent.click(action);
    await flush();
    expect(nav.push).toHaveBeenCalledWith("/accounting/expenses");
    /* folded, not closed: the panel (and its chat) is still in the page, just hidden */
    const panel = document.querySelector<HTMLElement>("section[role=dialog][aria-label=Help]")!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    const reopen = screen.getByRole("button", { name: "Open help" });
    expect(document.activeElement).toBe(reopen);
    fireEvent.click(reopen);
    const shown = screen.getByRole("dialog", { name: "Help" });
    expect(shown.textContent).toContain("How do I record an expense?");
    expect(shown.textContent).toContain("Press New expense");
  });
});

describe("R-2962: docked help makes room on the page", () => {
  it("helpPagePad = panel width only on a desktop with room left for the page", () => {
    expect(helpPagePad(420, 1280)).toBe(420);
    expect(helpPagePad(420, 1024)).toBe(420);
    expect(helpPagePad(420, 420 + PAGE_MIN_ROOM)).toBe(420);
    expect(helpPagePad(420, 420 + PAGE_MIN_ROOM - 1)).toBe(0);
    expect(helpPagePad(840, 1280)).toBe(0); /* expanded panel: the page would be squeezed out — help overlays */
    expect(helpPagePad(360, 700)).toBe(0); /* phone/tablet sheet */
  });

  it("publishes --ai-help-page while docked on a desktop; clears it when minimised, closed, or on a phone", async () => {
    const root = document.documentElement;
    render(<><AiHelpButton /><AiHelp /></>);
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("420px");
    fireEvent.click(screen.getByRole("button", { name: "Minimize help" }));
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Open help" }));
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("420px");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("");
    cleanup();

    setWidth(390);
    render(<><AiHelpButton /><AiHelp /></>);
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    expect(root.style.getPropertyValue("--ai-help-page")).toBe("");
  });

  it("the app layout's <main> reads --ai-help-page on desktop only (one mechanism with the dialogs' --ai-help-dock)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../app/(app)/layout.tsx"), "utf8");
    const main = src.match(/<main className="([^"]+)"/)?.[1] ?? "";
    expect(main.split(/\s+/)).toContain("md:pr-[var(--ai-help-page,0px)]");
    expect(main).not.toMatch(/(^|\s)pr-\[var\(--ai-help-page/);
  });
});
