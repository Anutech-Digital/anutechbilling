// @vitest-environment jsdom
/** R-223 — AI Help panel can be made bigger / smaller (desktop) and is a full-screen sheet on a phone. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/invoices", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton, clampPanelSize, dragResize, isLargePanel, PANEL_NORMAL, PANEL_LARGE, PANEL_MIN } from "./ai-help";

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
  const btn = screen.queryByRole("button", { name: /AI Help/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

function openPanel() {
  render(<><AiHelpButton /><AiHelp /></>);
  fireEvent.click(screen.getByRole("button", { name: /AI Help/ }));
  return screen.getByRole("dialog", { name: "AI Help" });
}
const width = (el: HTMLElement) => el.style.getPropertyValue("--ai-w");
const height = (el: HTMLElement) => el.style.getPropertyValue("--ai-h");

describe("AI Help panel size (R-223)", () => {
  it("Bigger makes the panel larger, Smaller brings it back, and the size is remembered", () => {
    const panel = openPanel();
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
    expect(height(panel)).toBe(`${PANEL_NORMAL.h}px`);

    fireEvent.click(screen.getByRole("button", { name: "Bigger" }));
    expect(width(panel)).toBe(`${PANEL_LARGE.w}px`);
    expect(height(panel)).toBe(`${PANEL_LARGE.h}px`);
    expect(panel.getAttribute("data-size")).toBe("large");
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(PANEL_LARGE);

    fireEvent.click(screen.getByRole("button", { name: "Smaller" }));
    expect(width(panel)).toBe(`${PANEL_NORMAL.w}px`);
    expect(screen.getByRole("button", { name: "Bigger" })).toBeTruthy();
  });

  it("opens at the size saved in this browser", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ w: 640, h: 700 }));
    const panel = openPanel();
    await act(async () => {});
    expect(width(panel)).toBe("640px");
    expect(height(panel)).toBe("700px");
  });

  it("is a full-screen sheet on a phone; sizes apply from md (desktop) up", () => {
    const panel = openPanel();
    const cls = panel.className.split(/\s+/);
    expect(cls).toContain("inset-0");
    expect(cls).not.toContain("md:w-[420px]");
    expect(cls).toContain("md:w-[var(--ai-w)]");
    expect(cls).toContain("md:h-[var(--ai-h)]");
    /* the size button and drag handles are desktop-only */
    expect(screen.getByRole("button", { name: "Bigger" }).className).toContain("hidden md:inline");
    expect(panel.querySelector("[data-resize=left]")?.className).toContain("hidden md:block");
  });
});

describe("panel size maths", () => {
  it("never goes below the minimum or past the screen", () => {
    expect(clampPanelSize({ w: 100, h: 100 }, VP)).toEqual(PANEL_MIN);
    expect(clampPanelSize({ w: 5000, h: 5000 }, VP)).toEqual({ w: 1100, h: VP.h - 80 });
    expect(clampPanelSize(PANEL_LARGE, { w: 780, h: 700 })).toEqual({ w: 740, h: 620 });
  });
  it("dragging the left edge left widens; the bottom edge down makes it taller; the corner does both", () => {
    expect(dragResize(PANEL_NORMAL, "left", -100, 50, VP)).toEqual({ w: 520, h: 600 });
    expect(dragResize(PANEL_NORMAL, "bottom", -100, 50, VP)).toEqual({ w: 420, h: 650 });
    expect(dragResize(PANEL_NORMAL, "corner", 30, -40, VP)).toEqual({ w: 390, h: 560 });
  });
  it("treats only clearly larger sizes as large", () => {
    expect(isLargePanel(PANEL_NORMAL)).toBe(false);
    expect(isLargePanel(PANEL_LARGE)).toBe(true);
  });
});
