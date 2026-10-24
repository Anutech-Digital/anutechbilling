// @vitest-environment jsdom
/**
 * R-1447 — AI Help panel can be moved on a desktop (Abhishek, staging: the panel covers the UI
 * underneath while reporting). Drag by the header, kept inside the window, remembered in this
 * browser, and a keyboard-reachable "Dock" control puts it back. A phone keeps today's sheet.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/invoices", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton, clampPanelPos, dragPanelPos, keyMovePanel, PANEL_NORMAL, PANEL_KEY_STEP } from "./ai-help";

const VP = { w: 1440, h: 1000 };
const POS_KEY = "reselleros.aiHelp.pos";
const SIZE = PANEL_NORMAL;

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
}

/* jsdom has no PointerEvent: without it fireEvent.pointer* drops clientX / button. */
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEventShim });
}

beforeEach(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() },
  });
  setViewport(VP.w, VP.h);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  const btn = screen.queryByRole("button", { name: /^Help —/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

function openPanel() {
  render(<><AiHelpButton /><AiHelp /></>);
  fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
  return screen.getByRole("dialog", { name: "Help" });
}
const savedPos = () => JSON.parse(window.localStorage.getItem(POS_KEY) ?? "null") as unknown;

describe("panel position helpers (R-1447)", () => {
  it("keeps the panel fully inside the window", () => {
    expect(clampPanelPos({ x: -50, y: -20 }, SIZE, VP)).toEqual({ x: 0, y: 0 });
    expect(clampPanelPos({ x: 5000, y: 5000 }, SIZE, VP)).toEqual({ x: VP.w - SIZE.w, y: VP.h - SIZE.h });
    expect(clampPanelPos({ x: 100.4, y: 200.6 }, SIZE, VP)).toEqual({ x: 100, y: 201 });
  });
  it("a panel bigger than the window sticks to the top-left corner (never negative)", () => {
    expect(clampPanelPos({ x: 300, y: 300 }, { w: 900, h: 900 }, { w: 800, h: 600 })).toEqual({ x: 0, y: 0 });
  });
  it("a broken number falls back to the top-left, not NaN", () => {
    expect(clampPanelPos({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, SIZE, VP)).toEqual({ x: 0, y: 0 });
  });
  it("dragging moves by the pointer distance, clamped", () => {
    expect(dragPanelPos({ x: 500, y: 100 }, -200, 50, SIZE, VP)).toEqual({ x: 300, y: 150 });
    expect(dragPanelPos({ x: 500, y: 100 }, 5000, -5000, SIZE, VP)).toEqual({ x: VP.w - SIZE.w, y: 0 });
  });
  it("arrow keys move one step; other keys do nothing", () => {
    const p = { x: 400, y: 300 };
    expect(keyMovePanel(p, "ArrowLeft", SIZE, VP)).toEqual({ x: 400 - PANEL_KEY_STEP, y: 300 });
    expect(keyMovePanel(p, "ArrowRight", SIZE, VP)).toEqual({ x: 400 + PANEL_KEY_STEP, y: 300 });
    expect(keyMovePanel(p, "ArrowUp", SIZE, VP)).toEqual({ x: 400, y: 300 - PANEL_KEY_STEP });
    expect(keyMovePanel(p, "ArrowDown", SIZE, VP)).toEqual({ x: 400, y: 300 + PANEL_KEY_STEP });
    expect(keyMovePanel(p, "Enter", SIZE, VP)).toBeNull();
  });
});

describe("AI Help panel moves on a desktop (R-1447)", () => {
  it("opens docked right, with a move handle and a Dock control in the header", () => {
    const panel = openPanel();
    expect(panel.getAttribute("data-moved")).toBe("false");
    const handle = screen.getByRole("button", { name: /^Move help panel/ });
    expect(handle.getAttribute("data-drag")).toBe("handle");
    expect(handle.tabIndex).toBe(0);
    const dock = screen.getByRole("button", { name: /^Dock help panel/ });
    expect((dock as HTMLButtonElement).disabled).toBe(true);
  });

  it("dragging the header moves the panel, remembers it, and Dock puts it back", () => {
    const panel = openPanel();
    const header = panel.querySelector("header")!;
    /* docked = x at the right edge (1440 - 420), y below the top bar (64) */
    fireEvent.pointerDown(header, { clientX: 1100, clientY: 80, pointerId: 1, button: 0 });
    fireEvent.pointerMove(header, { clientX: 700, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(header, { clientX: 700, clientY: 180, pointerId: 1 });
    expect(panel.getAttribute("data-moved")).toBe("true");
    expect(panel.style.getPropertyValue("--ai-x")).toBe(`${VP.w - SIZE.w - 400}px`);
    expect(panel.style.getPropertyValue("--ai-y")).toBe(`${64 + 100}px`);
    expect(savedPos()).toEqual({ x: VP.w - SIZE.w - 400, y: 164 });

    const dock = screen.getByRole("button", { name: /^Dock help panel/ });
    expect((dock as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dock);
    expect(panel.getAttribute("data-moved")).toBe("false");
    expect(window.localStorage.getItem(POS_KEY)).toBeNull();
  });

  it("a press on a header button does not start a drag", () => {
    const panel = openPanel();
    const minimize = screen.getByRole("button", { name: "Minimize help" });
    fireEvent.pointerDown(minimize, { clientX: 1300, clientY: 80, pointerId: 1, button: 0 });
    fireEvent.pointerMove(minimize, { clientX: 600, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(minimize, { pointerId: 1 });
    expect(panel.getAttribute("data-moved")).toBe("false");
  });

  it("the move handle works from the keyboard", () => {
    const panel = openPanel();
    const handle = screen.getByRole("button", { name: /^Move help panel/ });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panel.getAttribute("data-moved")).toBe("true");
    expect(panel.style.getPropertyValue("--ai-x")).toBe(`${VP.w - SIZE.w - PANEL_KEY_STEP}px`);
  });

  it("opens where it was left, pulled back inside a smaller window", async () => {
    window.localStorage.setItem(POS_KEY, JSON.stringify({ x: 2000, y: 900 }));
    const panel = openPanel();
    await act(async () => {});
    expect(panel.getAttribute("data-moved")).toBe("true");
    expect(panel.style.getPropertyValue("--ai-x")).toBe(`${VP.w - SIZE.w}px`);
    expect(panel.style.getPropertyValue("--ai-y")).toBe(`${VP.h - SIZE.h}px`);
  });

  it("blocked storage never breaks moving", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); }, clear: () => {} },
    });
    const panel = openPanel();
    const handle = screen.getByRole("button", { name: /^Move help panel/ });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(panel.getAttribute("data-moved")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Dock help panel/ }));
    expect(panel.getAttribute("data-moved")).toBe("false");
  });

  it("on a phone the header does not drag (the sheet stays full screen)", () => {
    setViewport(390, 800);
    const panel = openPanel();
    const header = panel.querySelector("header")!;
    fireEvent.pointerDown(header, { clientX: 200, clientY: 30, pointerId: 1, button: 0 });
    fireEvent.pointerMove(header, { clientX: 100, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(panel.getAttribute("data-moved")).toBe("false");
  });
});
