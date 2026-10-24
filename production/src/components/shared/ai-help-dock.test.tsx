// @vitest-environment jsdom
/**
 * R-1467 (rest of R-1447, Abhishek) — on a phone the Help panel is a side panel that can sit on
 * the left or the right edge (a Left / Right toggle in its header), so the page stays visible
 * beside it. The choice is kept in this browser. A desktop keeps R-1447's drag + Dock unchanged.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/invoices", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton } from "./ai-help";

const SIDE_KEY = "reselleros.aiHelp.phoneSide";

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
}

let mem: Map<string, string>;
beforeEach(() => {
  mem = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() },
  });
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
const cls = (el: Element) => el.className.split(/\s+/);
const leftBtn = () => screen.getByRole("button", { name: "Help panel on the left side" });
const rightBtn = () => screen.getByRole("button", { name: "Help panel on the right side" });

describe("phone: Left / Right dock (R-1467)", () => {
  beforeEach(() => setViewport(390, 800));

  it("is a side panel on the right by default, not a full-screen sheet", () => {
    const panel = openPanel();
    expect(panel.getAttribute("data-side")).toBe("right");
    expect(cls(panel)).toContain("right-0");
    expect(cls(panel)).not.toContain("inset-0");
    expect(rightBtn().getAttribute("aria-pressed")).toBe("true");
    expect(leftBtn().getAttribute("aria-pressed")).toBe("false");
  });

  it("the toggle moves the panel to the left and back, and remembers the choice", () => {
    const panel = openPanel();
    fireEvent.click(leftBtn());
    expect(panel.getAttribute("data-side")).toBe("left");
    expect(cls(panel)).toContain("left-0");
    expect(cls(panel)).not.toContain("right-0");
    expect(leftBtn().getAttribute("aria-pressed")).toBe("true");
    expect(rightBtn().getAttribute("aria-pressed")).toBe("false");
    expect(mem.get(SIDE_KEY)).toBe("left");
    fireEvent.click(rightBtn());
    expect(panel.getAttribute("data-side")).toBe("right");
    expect(mem.get(SIDE_KEY)).toBe("right");
  });

  it("the toggle buttons are real buttons, reachable by keyboard", () => {
    openPanel();
    for (const b of [leftBtn(), rightBtn()]) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("tabindex")).not.toBe("-1");
      expect(b.className).toContain("focus-visible:ring-2");
    }
  });

  it("the saved side is used after a reload", () => {
    mem.set(SIDE_KEY, "left");
    const panel = openPanel();
    expect(panel.getAttribute("data-side")).toBe("left");
    expect(leftBtn().getAttribute("aria-pressed")).toBe("true");
  });

  it("a junk saved value falls back to the right", () => {
    mem.set(SIDE_KEY, "middle");
    expect(openPanel().getAttribute("data-side")).toBe("right");
  });

  it("storage that throws (private window) still works — the side just isn't kept", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } },
    });
    const panel = openPanel();
    expect(panel.getAttribute("data-side")).toBe("right");
    fireEvent.click(leftBtn());
    expect(panel.getAttribute("data-side")).toBe("left");
  });
});

describe("desktop: unchanged (R-1447 drag stays)", () => {
  it("no Left / Right toggle, the panel keeps its desktop classes and the Dock button", () => {
    setViewport(1440, 1000);
    mem.set(SIDE_KEY, "left");
    const panel = openPanel();
    expect(screen.queryByRole("button", { name: /^Help panel on the/ })).toBeNull();
    expect(panel.hasAttribute("data-side")).toBe(false);
    expect(cls(panel)).toContain("inset-0");
    expect(cls(panel)).toContain("md:right-0");
    expect(screen.getByRole("button", { name: /^Dock help panel/ })).toBeTruthy();
  });
});
