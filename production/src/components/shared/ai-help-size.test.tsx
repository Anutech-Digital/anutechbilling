// @vitest-environment jsdom
/**
 * R-223 — AI Help panel can be made bigger / smaller (desktop) and is a full-screen sheet on a phone.
 * R-360 — "Expand" = ~2x width at full height, labelled toggle (aria-pressed), keyboard-resizable
 * left edge, width clamped to 360px..min(900px, 90vw), and blocked storage never breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/invoices", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton, clampPanelSize, dragResize, isLargePanel, keyResize, panelMaxWidth, PANEL_NORMAL, PANEL_LARGE, PANEL_MIN, PANEL_KEY_STEP } from "./ai-help";

const VP = { w: 1440, h: 1000 };
const KEY = "reselleros.aiHelp.size";

beforeEach(() => {
  /* a plain in-memory localStorage (this jsdom setup has none) */
  const mem = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() },
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: VP.w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VP.h });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  /* close the shared panel state so the next test starts closed */
  const btn = screen.queryByRole("button", { name: /AI Help —/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

function openPanel() {
  render(<><AiHelpButton /><AiHelp /></>);
  fireEvent.click(screen.getByRole("button", { name: /AI Help —/ }));
  return screen.getByRole("dialog", { name: "AI Help" });
}
const width = (el: HTMLElement) => el.style.getPropertyValue("--ai-w");
const height = (el: HTMLElement) => el.style.getPropertyValue("--ai-h");
const saved = () => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as unknown;

describe("AI Help panel size (R-223, R-360)", () => {
  it("Expand doubles the width at full height, Collapse brings it back, and the choice is remembered", () => {
    const panel = openPanel();
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
    expect(height(panel)).toBe(`${PANEL_NORMAL.h}px`);

    const expand = screen.getByRole("button", { name: "Expand panel" });
    expect(expand.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(expand);
    expect(width(panel)).toBe(`${PANEL_NORMAL.w * 2}px`);
    expect(height(panel)).toBe(`${VP.h - 80}px`);
    expect(panel.getAttribute("data-size")).toBe("large");
    expect(saved()).toEqual(PANEL_LARGE);

    const collapse = screen.getByRole("button", { name: "Collapse panel to normal size" });
    expect(collapse.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(collapse);
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
    expect(saved()).toEqual(PANEL_NORMAL);
    expect(screen.getByRole("button", { name: "Expand panel" })).toBeTruthy();
  });

  it("opens at the size saved in this browser", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ w: 640, h: 700 }));
    const panel = openPanel();
    await act(async () => {});
    expect(width(panel)).toBe("640px");
    expect(height(panel)).toBe("700px");
  });

  it("a saved width past the limit is pulled back to min(900px, 90vw)", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ w: 5000, h: 700 }));
    const panel = openPanel();
    await act(async () => {});
    expect(width(panel)).toBe("900px");
  });

  it("ignores a broken saved value", async () => {
    window.localStorage.setItem(KEY, "{not json");
    const panel = openPanel();
    await act(async () => {});
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
  });

  it("still works when this browser blocks storage (private window)", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("blocked", "SecurityError"); },
    });
    const panel = openPanel();
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
    expect(width(panel)).toBe(`${PANEL_NORMAL.w * 2}px`);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(width(panel)).toBe(`${PANEL_NORMAL.w * 2 - PANEL_KEY_STEP}px`);
  });

  it("the left edge is a keyboard resize handle with its width announced", () => {
    const panel = openPanel();
    const handle = screen.getByRole("separator", { name: /Resize panel width/ });
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuenow")).toBe(String(PANEL_NORMAL.w));
    expect(handle.getAttribute("aria-valuemin")).toBe("360");
    expect(handle.getAttribute("aria-valuemax")).toBe("900");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width(panel)).toBe(`${PANEL_NORMAL.w + PANEL_KEY_STEP}px`);
    expect(saved()).toEqual({ w: PANEL_NORMAL.w + PANEL_KEY_STEP, h: PANEL_NORMAL.h });
    fireEvent.keyDown(handle, { key: "End" });
    expect(width(panel)).toBe("900px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width(panel)).toBe(`${PANEL_MIN.w}px`);
  });

  it("keeps the R-353 follow-up chips working in the expanded panel", async () => {
    /* the panel wraps fetch once per tab and keeps the original in __aiHelpFetch — mock both */
    const w = window as Window & { __aiHelpFetch?: typeof fetch };
    const realFetch = window.fetch;
    const realCached = w.__aiHelpFetch;
    const mock = vi.fn(async () => new Response(JSON.stringify({ reply: "ok", followUps: ["What next?"] }), { status: 200 })) as typeof fetch;
    window.fetch = mock;
    w.__aiHelpFetch = mock;
    try {
      openPanel();
      fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
      fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "hi" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
      expect(await screen.findByRole("button", { name: "Ask: What next?" })).toBeTruthy();
    } finally {
      fireEvent.click(screen.getByRole("button", { name: /AI Help —/ }));
      cleanup(); /* unmount first: the panel puts its cached fetch back on unmount */
      window.fetch = realFetch;
      w.__aiHelpFetch = realCached;
    }
  });

  it("is a full-screen sheet on a phone; sizes apply from md (desktop) up", () => {
    const panel = openPanel();
    const cls = panel.className.split(/\s+/);
    expect(cls).toContain("inset-0");
    expect(cls).not.toContain("md:w-[420px]");
    expect(cls).toContain("md:w-[var(--ai-w)]");
    expect(cls).toContain("md:h-[var(--ai-h)]");
    /* the size button and drag handles are desktop-only */
    expect(screen.getByRole("button", { name: "Expand panel" }).className).toContain("hidden md:inline");
    expect(panel.querySelector("[data-resize=left]")?.className).toContain("hidden md:block");
  });
});

describe("panel size maths", () => {
  it("never goes below 360px or past min(900px, 90vw) / the screen bottom", () => {
    expect(PANEL_MIN.w).toBe(360);
    expect(clampPanelSize({ w: 100, h: 100 }, VP)).toEqual(PANEL_MIN);
    expect(clampPanelSize({ w: 5000, h: 5000 }, VP)).toEqual({ w: 900, h: VP.h - 80 });
    expect(clampPanelSize(PANEL_LARGE, { w: 780, h: 700 })).toEqual({ w: 702, h: 620 });
    expect(panelMaxWidth({ w: 1440 })).toBe(900);
    expect(panelMaxWidth({ w: 800 })).toBe(720);
    expect(panelMaxWidth({ w: 300 })).toBe(PANEL_MIN.w);
    expect(clampPanelSize({ w: Number.NaN, h: Number.POSITIVE_INFINITY }, VP)).toEqual(PANEL_NORMAL);
  });
  it("dragging the left edge left widens; the bottom edge down makes it taller; the corner does both", () => {
    expect(dragResize(PANEL_NORMAL, "left", -100, 50, VP)).toEqual({ w: 520, h: 600 });
    expect(dragResize(PANEL_NORMAL, "bottom", -100, 50, VP)).toEqual({ w: 420, h: 650 });
    expect(dragResize(PANEL_NORMAL, "corner", 30, -40, VP)).toEqual({ w: 390, h: 560 });
  });
  it("arrow keys step the width inside the clamp; other keys do nothing", () => {
    expect(keyResize(PANEL_NORMAL, "ArrowLeft", VP)).toEqual({ w: 460, h: 600 });
    expect(keyResize(PANEL_NORMAL, "ArrowRight", VP)).toEqual({ w: 380, h: 600 });
    expect(keyResize({ w: 370, h: 600 }, "ArrowRight", VP)).toEqual({ w: 360, h: 600 });
    expect(keyResize({ w: 890, h: 600 }, "ArrowLeft", VP)).toEqual({ w: 900, h: 600 });
    expect(keyResize(PANEL_NORMAL, "Enter", VP)).toBeNull();
  });
  it("treats only clearly larger sizes as large", () => {
    expect(isLargePanel(PANEL_NORMAL)).toBe(false);
    expect(isLargePanel(clampPanelSize(PANEL_LARGE, VP))).toBe(true);
  });
});
